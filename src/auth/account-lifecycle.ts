/**
 * AccountLifecycle — owns acquire locks and rotation strategy.
 *
 * Handles: acquire, release, lock management, rotation strategy.
 * Uses AccountRegistry for entry access (no circular dep — one-way reference).
 */

import { getConfig } from "../config.js";
import { getModelPlanTypes, isPlanFetched } from "../models/model-store.js";
import { hasReachedCachedQuota } from "./quota-skip.js";
import { getRotationStrategy } from "./rotation-strategy.js";
import type { RotationStrategy, RotationState, RotationStrategyName } from "./rotation-strategy.js";
import type { AccountRegistry } from "./account-registry.js";
import type { AccountEntry, AcquiredAccount } from "./types.js";

const ACQUIRE_LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface AvailabilityExplanation {
  total: number;
  eligible: number;
  active: number;
  expired: number;
  refreshing: number;
  disabled: number;
  banned: number;
  rateLimitedStatus: number;
  quotaExhaustedStatus: number;
  quotaExhausted: number;
  concurrencyFull: number;
  modelPlanMismatch: number;
  excludedByRetry: number;
  preferredPlans: string[];
}

export class AccountLifecycle {
  /** Per-account active slot timestamps. Each entry = one in-flight request. */
  private acquireLocks: Map<string, number[]> = new Map();
  private strategy: RotationStrategy;
  private rotationState: RotationState = { roundRobinIndex: 0 };
  private registry: AccountRegistry;

  constructor(registry: AccountRegistry, strategyName: RotationStrategyName) {
    this.registry = registry;
    this.strategy = getRotationStrategy(strategyName);
  }

  private slotCount(entryId: string): number {
    return this.acquireLocks.get(entryId)?.length ?? 0;
  }

  private pushSlot(entryId: string): void {
    const slots = this.acquireLocks.get(entryId);
    if (slots) {
      slots.push(Date.now());
    } else {
      this.acquireLocks.set(entryId, [Date.now()]);
    }
  }

  private popSlot(entryId: string): void {
    const slots = this.acquireLocks.get(entryId);
    if (!slots) return;
    slots.shift();
    if (slots.length === 0) this.acquireLocks.delete(entryId);
  }

  acquire(options?: { model?: string; excludeIds?: string[]; preferredEntryId?: string }): AcquiredAccount | null {
    const nowMs = Date.now();
    const now = new Date(nowMs);

    const entries = this.registry.getAllEntries();
    for (const entry of entries) {
      this.registry.refreshStatus(entry, now);
    }

    // Auto-release stale slots (slots are chronological — if oldest is fresh, all are)
    for (const [id, slots] of this.acquireLocks) {
      if (nowMs - slots[0] <= ACQUIRE_LOCK_TTL_MS) continue;
      const fresh = slots.filter((ts) => nowMs - ts <= ACQUIRE_LOCK_TTL_MS);
      const staleCount = slots.length - fresh.length;
      console.warn(
        `[AccountPool] Auto-releasing ${staleCount} stale slot(s) for ${id}`,
      );
      if (fresh.length === 0) {
        this.acquireLocks.delete(id);
      } else {
        this.acquireLocks.set(id, fresh);
      }
    }

    const config = getConfig();
    const maxConcurrent = config.auth.max_concurrent_per_account ?? 3;
    const skipExhausted = config.quota?.skip_exhausted === true;
    const excludeSet = options?.excludeIds?.length ? new Set(options.excludeIds) : null;

    const available = entries.filter(
      (a) =>
        a.status === "active" &&
        this.slotCount(a.id) < maxConcurrent &&
        (!excludeSet || !excludeSet.has(a.id)) &&
        (!skipExhausted || !hasReachedCachedQuota(a)),
    );

    if (available.length === 0) return null;

    let candidates = available;
    if (options?.model) {
      const preferredPlans = getModelPlanTypes(options.model);
      if (preferredPlans.length > 0) {
        const planSet = new Set(preferredPlans);
        const matched = available.filter((a) => {
          if (!a.planType) return false;
          if (planSet.has(a.planType)) return true;
          return !isPlanFetched(a.planType);
        });
        if (matched.length > 0) {
          candidates = matched;
        } else {
          return null;
        }
      }
    }

    // Tier-based filtering: when configured, restrict to the highest available tier
    const tierPriority = config.auth.tier_priority;
    if (tierPriority && tierPriority.length > 0) {
      const tierOrder = new Map(tierPriority.map((t, i) => [t, i]));
      let bestIdx = Infinity;
      for (const c of candidates) {
        const idx = c.planType != null ? (tierOrder.get(c.planType) ?? Infinity) : Infinity;
        if (idx < bestIdx) bestIdx = idx;
      }
      if (bestIdx < Infinity) {
        const bestTier = tierPriority[bestIdx];
        const tierFiltered = candidates.filter((c) => c.planType === bestTier);
        if (tierFiltered.length > 0) candidates = tierFiltered;
      }
    }

    // Session affinity: prefer the account that owns the conversation
    let selected: AccountEntry;
    if (options?.preferredEntryId) {
      const preferred = candidates.find((a) => a.id === options.preferredEntryId);
      selected = preferred ?? this.strategy.select(candidates, this.rotationState);
    } else {
      selected = this.strategy.select(candidates, this.rotationState);
    }
    const prevSlots = this.acquireLocks.get(selected.id);
    const prevSlotMs = prevSlots?.[prevSlots.length - 1] ?? null;
    this.pushSlot(selected.id);
    return {
      entryId: selected.id,
      token: selected.token,
      accountId: selected.accountId,
      prevSlotMs,
    };
  }

  explainAvailability(options?: { model?: string; excludeIds?: string[] }): AvailabilityExplanation {
    const now = new Date();
    const entries = this.registry.getAllEntries();
    for (const entry of entries) {
      this.registry.refreshStatus(entry, now);
    }

    const config = getConfig();
    const maxConcurrent = config.auth.max_concurrent_per_account ?? 3;
    const skipExhausted = config.quota?.skip_exhausted === true;
    const excludeSet = options?.excludeIds?.length ? new Set(options.excludeIds) : null;
    const preferredPlans = options?.model ? getModelPlanTypes(options.model) : [];
    const planSet = preferredPlans.length > 0 ? new Set(preferredPlans) : null;

    const explanation: AvailabilityExplanation = {
      total: entries.length,
      eligible: 0,
      active: 0,
      expired: 0,
      refreshing: 0,
      disabled: 0,
      banned: 0,
      rateLimitedStatus: 0,
      quotaExhaustedStatus: 0,
      quotaExhausted: 0,
      concurrencyFull: 0,
      modelPlanMismatch: 0,
      excludedByRetry: 0,
      preferredPlans,
    };

    for (const entry of entries) {
      switch (entry.status) {
        case "active":
          explanation.active++;
          break;
        case "expired":
          explanation.expired++;
          break;
        case "refreshing":
          explanation.refreshing++;
          break;
        case "disabled":
          explanation.disabled++;
          break;
        case "banned":
          explanation.banned++;
          break;
        case "rate_limited":
          explanation.rateLimitedStatus++;
          break;
        case "quota_exhausted":
          explanation.quotaExhaustedStatus++;
          break;
      }

      if (excludeSet?.has(entry.id)) {
        explanation.excludedByRetry++;
        continue;
      }
      if (entry.status !== "active") continue;
      if (this.slotCount(entry.id) >= maxConcurrent) {
        explanation.concurrencyFull++;
        continue;
      }
      if (skipExhausted && hasReachedCachedQuota(entry)) {
        explanation.quotaExhausted++;
        continue;
      }
      if (planSet) {
        if (!entry.planType) {
          explanation.modelPlanMismatch++;
          continue;
        }
        if (!planSet.has(entry.planType) && isPlanFetched(entry.planType)) {
          explanation.modelPlanMismatch++;
          continue;
        }
      }
      explanation.eligible++;
    }

    return explanation;
  }

  release(
    entryId: string,
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cached_tokens?: number;
      image_input_tokens?: number;
      image_output_tokens?: number;
      image_request_attempted?: boolean;
      image_request_succeeded?: boolean;
    },
  ): void {
    this.popSlot(entryId);
    this.registry.recordUsage(entryId, usage);
  }

  releaseWithoutCounting(entryId: string): void {
    this.popSlot(entryId);
  }

  /** Clear all slots for an entry (called by facade on status mutations). */
  clearLock(entryId: string): void {
    this.acquireLocks.delete(entryId);
  }

  clearAllLocks(): void {
    this.acquireLocks.clear();
  }

  setRotationStrategy(name: RotationStrategyName): void {
    this.strategy = getRotationStrategy(name);
    this.rotationState.roundRobinIndex = 0;
  }

  getDistinctPlanAccounts(): Array<{
    planType: string;
    entryId: string;
    token: string;
    accountId: string | null;
  }> {
    const now = new Date();
    const config = getConfig();
    const maxConcurrent = config.auth.max_concurrent_per_account ?? 3;
    const skipExhausted = config.quota?.skip_exhausted === true;
    const entries = this.registry.getAllEntries();
    for (const entry of entries) {
      this.registry.refreshStatus(entry, now);
    }

    const available = entries.filter(
      (a: AccountEntry) =>
        a.status === "active" &&
        this.slotCount(a.id) < maxConcurrent &&
        a.planType &&
        (!skipExhausted || !hasReachedCachedQuota(a)),
    );

    const byPlan = new Map<string, AccountEntry[]>();
    for (const a of available) {
      const plan = a.planType!;
      let group = byPlan.get(plan);
      if (!group) {
        group = [];
        byPlan.set(plan, group);
      }
      group.push(a);
    }

    const result: Array<{ planType: string; entryId: string; token: string; accountId: string | null }> = [];
    for (const [plan, group] of byPlan) {
      const selected = this.strategy.select(group, this.rotationState);
      this.pushSlot(selected.id);
      result.push({
        planType: plan,
        entryId: selected.id,
        token: selected.token,
        accountId: selected.accountId,
      });
    }

    return result;
  }
}
