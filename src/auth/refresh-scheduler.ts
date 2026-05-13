/**
 * RefreshScheduler — per-account JWT auto-refresh.
 * Schedules a refresh at `exp - margin` for each account.
 * Uses OAuth refresh_token instead of Codex CLI.
 *
 * Features:
 * - Exponential backoff (5 attempts: 5s → 15s → 45s → 135s → 300s)
 * - Permanent failure detection (invalid_grant / invalid_token)
 * - Recovery scheduling (10 min) for temporary failures
 * - Crash recovery: "refreshing" → immediate retry, "expired" + refreshToken → delayed retry
 */

import { getConfig } from "../config.js";
import type { AccountLogInput, AccountLogStore } from "../services/account-log-store.js";
import { jitter, jitterInt } from "../utils/jitter.js";
import { summarizeError } from "../utils/sanitize-log.js";
import type { AccountPool } from "./account-pool.js";
import { decodeJwtPayload } from "./jwt-utils.js";
import { refreshAccessToken } from "./oauth-pkce.js";
import { tryAcquireRefreshLock, releaseRefreshLock } from "./refresh-lock.js";
import type { RefreshTrigger } from "./types.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";

/** Errors that indicate the refresh token itself is invalid (permanent failure). */
const PERMANENT_REFRESH_FAILURE_CODES = new Set([
  "invalid_grant",
  "invalid_token",
  "access_denied",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
  "account has been deactivated",
]);

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 5_000;
const RECOVERY_DELAY_MS = 10 * 60 * 1000; // 10 minutes
const LOCKED_RECOVERY_DELAY_MS = 30_000;
/** Require this many consecutive permanent errors before marking expired. */
const PERMANENT_THRESHOLD = 2;

export interface RefreshScheduleSnapshot {
  nextRefreshAt: string | null;
  refreshState: "idle" | "scheduled" | "queued" | "refreshing" | "retry_scheduled" | "recovery_scheduled" | "blocked";
  refreshInFlight: boolean;
  refreshBlockedReason: string | null;
}

export class RefreshScheduler {
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private snapshots: Map<string, RefreshScheduleSnapshot> = new Map();
  private pool: AccountPool;
  private proxyPool: ProxyPool | null = null;
  private accountLogStore: AccountLogStore | null = null;
  private started = false;

  private _running = 0;
  private _queue: Array<() => void> = [];
  private _inFlight: Set<string> = new Set();

  isRefreshing(entryId: string): boolean {
    return this._inFlight.has(entryId);
  }

  constructor(pool: AccountPool, options?: { accountLogStore?: AccountLogStore }) {
    this.pool = pool;
    this.accountLogStore = options?.accountLogStore ?? null;
  }

  setProxyPool(proxyPool: ProxyPool): void {
    this.proxyPool = proxyPool;
  }

  setAccountLogStore(accountLogStore: AccountLogStore): void {
    this.accountLogStore = accountLogStore;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduleAll();
  }

  getSnapshot(entryId: string): RefreshScheduleSnapshot {
    const snapshot = this.snapshots.get(entryId);
    return snapshot ?? {
      nextRefreshAt: null,
      refreshState: this._inFlight.has(entryId) ? "refreshing" : "idle",
      refreshInFlight: this._inFlight.has(entryId),
      refreshBlockedReason: null,
    };
  }

  scheduleAll(): void {
    const config = getConfig();
    if (!config.auth.refresh_enabled) {
      console.log("[RefreshScheduler] Auto-refresh disabled (refresh_enabled = false)");
      for (const entry of this.pool.getAllEntries()) {
        this.setSnapshot(entry.id, "blocked", null, "refresh_disabled");
      }
      return;
    }

    let expiredIndex = 0;
    for (const entry of this.pool.getAllEntries()) {
      if (!entry.refreshToken) {
        this.setSnapshot(entry.id, "blocked", null, "missing_refresh_token");
        this.logAuth(entry.id, "warn", "auth.refresh.missing_refresh_token", {
          message: "Account has no refresh token; re-login is required for automatic refresh",
          expiresAt: this.getExpiresAt(entry.token),
        });
        continue;
      }
      if (entry.status === "disabled" || entry.status === "banned") {
        const reason = entry.status === "disabled" ? "disabled" : "banned";
        this.setSnapshot(entry.id, "blocked", null, reason);
        this.logAuth(entry.id, "info", `auth.refresh.skipped_${reason}`, { message: `Refresh skipped because account is ${reason}` });
        continue;
      }

      if (entry.status === "refreshing") {
        console.log(`[RefreshScheduler] Account ${entry.id}: recovering from 'refreshing' state`);
        this.logAuth(entry.id, "warn", "auth.refresh.crash_recovery_started", { trigger: "startup_recovery" });
        void this.doRefresh(entry.id, "startup_recovery");
      } else if (entry.status === "expired") {
        const delay = 30_000 + expiredIndex * 2_000;
        expiredIndex++;
        console.log(`[RefreshScheduler] Account ${entry.id}: expired, recovery attempt in ${Math.round(delay / 1000)}s`);
        this.scheduleTimer(entry.id, delay, "recovery_scheduled", "expired", () => {
          this.timers.delete(entry.id);
          void this.doRefresh(entry.id, "startup_recovery");
        });
        this.logAuth(entry.id, "warn", "auth.refresh.expired_recovery_scheduled", {
          trigger: "startup_recovery",
          nextRefreshAt: this.nextAtFromDelay(delay),
        });
      } else {
        this.scheduleOne(entry.id, entry.token);
      }
    }
  }

  triggerRefreshNow(entryId: string, trigger: RefreshTrigger = "reactive_401"): void {
    const entry = this.pool.getEntry(entryId);
    if (!entry?.refreshToken) {
      this.setSnapshot(entryId, "blocked", null, "missing_refresh_token");
      this.logAuth(entryId, "warn", "auth.refresh.unavailable_no_refresh_token", { trigger, message: "No refresh token available" });
      return;
    }
    if (entry.status === "disabled" || entry.status === "banned") {
      const reason = entry.status === "disabled" ? "disabled" : "banned";
      this.setSnapshot(entryId, "blocked", null, reason);
      this.logAuth(entryId, "info", `auth.refresh.skipped_${reason}`, { trigger });
      return;
    }
    if (this._inFlight.has(entryId)) return;
    this.clearOne(entryId);
    this.logAuth(entryId, "info", "auth.refresh.triggered", { trigger });
    void this.doRefresh(entryId, trigger);
  }

  scheduleOne(entryId: string, token: string): void {
    this.clearOne(entryId);

    const entry = this.pool.getEntry(entryId);
    if (entry?.status === "disabled" || entry?.status === "banned") {
      const reason = entry.status === "disabled" ? "disabled" : "banned";
      this.setSnapshot(entryId, "blocked", null, reason);
      this.logAuth(entryId, "info", `auth.refresh.skipped_${reason}`, { message: `Refresh skipped because account is ${reason}` });
      return;
    }

    const payload = decodeJwtPayload(token);
    if (!payload || typeof payload.exp !== "number") {
      this.setSnapshot(entryId, "blocked", null, "missing_token_expiry");
      return;
    }

    const config = getConfig();
    const refreshAt = payload.exp - jitter(config.auth.refresh_margin_seconds, 0.15);
    const delayMs = (refreshAt - Math.floor(Date.now() / 1000)) * 1000;

    if (delayMs <= 0) {
      void this.doRefresh(entryId, "scheduled");
      return;
    }

    this.scheduleTimer(entryId, delayMs, "scheduled", null, () => {
      this.timers.delete(entryId);
      void this.doRefresh(entryId, "scheduled");
    });

    const nextRefreshAt = this.nextAtFromDelay(delayMs);
    this.logAuth(entryId, "info", "auth.refresh.scheduled", {
      trigger: "scheduled",
      nextRefreshAt,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    });

    const expiresIn = Math.round(delayMs / 1000);
    console.log(`[RefreshScheduler] Account ${entryId}: refresh scheduled in ${expiresIn}s`);
  }

  clearOne(entryId: string): void {
    const timer = this.timers.get(entryId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(entryId);
      this.logAuth(entryId, "info", "auth.refresh.schedule_cleared");
    }
    this.snapshots.delete(entryId);
  }

  destroy(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.snapshots.clear();
    for (const resolve of this._queue) resolve();
    this._queue.length = 0;
    this._running = 0;
    this._inFlight.clear();
  }

  private async acquireSlot(entryId: string): Promise<void> {
    const limit = getConfig().auth.refresh_concurrency;
    if (this._running < limit) {
      this._running++;
      return;
    }
    this.setSnapshot(entryId, "queued", null, null);
    await new Promise<void>((resolve) => this._queue.push(resolve));
    this._running++;
  }

  private releaseSlot(): void {
    this._running--;
    const next = this._queue.shift();
    if (next) next();
  }

  private async doRefresh(entryId: string, trigger: RefreshTrigger): Promise<void> {
    if (this._inFlight.has(entryId)) return;
    this._inFlight.add(entryId);
    await this.acquireSlot(entryId);
    try {
      await this._doRefreshInner(entryId, trigger);
    } catch (err) {
      const entry = this.pool.getEntry(entryId);
      if (entry?.status === "refreshing") {
        const summary = summarizeError(err);
        console.error(`[RefreshScheduler] Unexpected error for ${entryId}: ${summary.message}`);
        this.pool.recordRefreshFailure(entryId, trigger, summary.failureCode ?? null, summary.message);
        this.logAuth(entryId, "error", "auth.refresh.failed_transient", {
          trigger,
          errorClass: summary.errorClass,
          failureCode: summary.failureCode,
          message: summary.message,
        });
        this.pool.markStatus(entryId, "active");
        this.scheduleRecovery(entryId);
      }
    } finally {
      this._inFlight.delete(entryId);
      this.releaseSlot();
      const snapshot = this.snapshots.get(entryId);
      if (snapshot?.refreshState === "refreshing") {
        this.setSnapshot(entryId, "idle", null, null);
      }
    }
  }

  private async _doRefreshInner(entryId: string, trigger: RefreshTrigger): Promise<void> {
    if (!tryAcquireRefreshLock(entryId)) {
      console.log(`[RefreshScheduler] Account ${entryId}: another process is refreshing, skipping`);
      this.scheduleLockedRecovery(entryId, trigger);
      return;
    }
    try {
      await this._doRefreshLocked(entryId, trigger);
    } finally {
      releaseRefreshLock(entryId);
    }
  }

  private async _doRefreshLocked(entryId: string, trigger: RefreshTrigger): Promise<void> {
    const entry = this.pool.getEntry(entryId);
    if (!entry) return;

    if (entry.status === "disabled" || entry.status === "banned") {
      const reason = entry.status === "disabled" ? "disabled" : "banned";
      this.setSnapshot(entryId, "blocked", null, reason);
      this.logAuth(entryId, "info", `auth.refresh.skipped_${reason}`, { trigger });
      return;
    }

    if (!entry.refreshToken) {
      console.warn(`[RefreshScheduler] Account ${entryId} has no refresh_token, cannot auto-refresh. Re-login required at /`);
      this.setSnapshot(entryId, "blocked", null, "missing_refresh_token");
      this.pool.recordRefreshFailure(entryId, trigger, "missing_refresh_token", "No refresh token available");
      this.logAuth(entryId, "warn", "auth.refresh.unavailable_no_refresh_token", { trigger, message: "No refresh token available" });
      this.pool.markStatus(entryId, "expired");
      return;
    }

    if (this.pool.readEntryRTFromDisk) {
      const diskRT = this.pool.readEntryRTFromDisk(entryId);
      if (diskRT && diskRT !== entry.refreshToken) {
        console.log(`[RefreshScheduler] Account ${entryId}: disk RT differs from memory, syncing`);
        this.pool.updateToken(entryId, entry.token, diskRT);
        this.pool.markStatus(entryId, "active");
        this.logAuth(entryId, "info", "auth.refresh.token_synced_from_disk", { trigger });
        this.scheduleOne(entryId, entry.token);
        return;
      }
    }

    console.log(`[RefreshScheduler] Refreshing account ${entryId} (${entry.email ?? "?"})`);
    this.pool.recordRefreshAttempt(entryId, trigger);
    this.logAuth(entryId, "info", "auth.refresh.started", { trigger, expiresAt: this.getExpiresAt(entry.token) });
    this.setSnapshot(entryId, "refreshing", null, null);
    this.pool.markStatus(entryId, "refreshing");

    const accountProxyUrl = this.proxyPool?.resolveProxyUrl(entryId, true);
    let permanentHits = 0;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const start = Date.now();
      try {
        const isOneTimeRT = entry.refreshToken.startsWith("oaistb_rt_");
        const tokens = await refreshAccessToken(entry.refreshToken, accountProxyUrl);

        if (!tokens.refresh_token) {
          console.warn(`[RefreshScheduler] Account ${entryId}: server returned no new RT, keeping existing`);
        }
        this.pool.updateToken(entryId, tokens.access_token, tokens.refresh_token ?? undefined, tokens.id_token);
        this.pool.recordRefreshSuccess(entryId, trigger);
        const rtType = isOneTimeRT ? " (oaistb_rt_ → rotated)" : "";
        console.log(`[RefreshScheduler] Account ${entryId} refreshed successfully${rtType}`);
        this.logAuth(entryId, "info", "auth.refresh.succeeded", {
          trigger,
          attempt,
          durationMs: Date.now() - start,
          expiresAt: this.getExpiresAt(tokens.access_token),
        });
        this.scheduleOne(entryId, tokens.access_token);
        return;
      } catch (err) {
        const summary = summarizeError(err);
        const isPermanent = summary.failureCode ? PERMANENT_REFRESH_FAILURE_CODES.has(summary.failureCode) : false;
        if (isPermanent) {
          permanentHits++;
          if (permanentHits >= PERMANENT_THRESHOLD) {
            console.error(`[RefreshScheduler] Permanent failure (${permanentHits}x) for ${entryId}: ${summary.message}`);
            this.pool.recordRefreshFailure(entryId, trigger, summary.failureCode ?? "permanent_refresh_failure", summary.message);
            this.logAuth(entryId, "error", "auth.refresh.failed_permanent", {
              trigger,
              attempt,
              durationMs: Date.now() - start,
              errorClass: summary.errorClass,
              failureCode: summary.failureCode ?? "permanent_refresh_failure",
              message: summary.message,
            });
            this.pool.markStatus(entryId, "expired");
            return;
          }
          console.warn(`[RefreshScheduler] Permanent error (${permanentHits}/${PERMANENT_THRESHOLD}) for ${entryId}: ${summary.message}, retrying...`);
        }

        if (attempt < MAX_ATTEMPTS) {
          const backoff = Math.min(BASE_DELAY_MS * Math.pow(3, attempt - 1), 300_000);
          const retryDelay = jitterInt(backoff, 0.3);
          this.pool.recordRefreshFailure(entryId, trigger, summary.failureCode ?? null, summary.message);
          this.logAuth(entryId, isPermanent ? "warn" : "warn", "auth.refresh.failed_transient", {
            trigger,
            attempt,
            durationMs: Date.now() - start,
            errorClass: summary.errorClass,
            failureCode: summary.failureCode,
            message: summary.message,
            backoffMs: retryDelay,
          });
          this.setSnapshot(entryId, "retry_scheduled", this.nextAtFromDelay(retryDelay), null);
          console.warn(`[RefreshScheduler] Attempt ${attempt}/${MAX_ATTEMPTS} failed for ${entryId}: ${summary.message}, retrying in ${Math.round(retryDelay / 1000)}s...`);
          await new Promise((r) => setTimeout(r, retryDelay));
          this.logAuth(entryId, "info", "auth.refresh.retry_scheduled", {
            trigger: "retry",
            attempt: attempt + 1,
            backoffMs: retryDelay,
          });
        } else {
          console.error(`[RefreshScheduler] All ${MAX_ATTEMPTS} attempts failed for ${entryId}: ${summary.message}`);
          this.pool.recordRefreshFailure(entryId, trigger, summary.failureCode ?? null, summary.message);
          this.logAuth(entryId, "error", "auth.refresh.failed_transient", {
            trigger,
            attempt,
            durationMs: Date.now() - start,
            errorClass: summary.errorClass,
            failureCode: summary.failureCode,
            message: summary.message,
          });
          this.pool.markStatus(entryId, "active");
          this.scheduleRecovery(entryId);
        }
      }
    }
  }

  private scheduleRecovery(entryId: string): void {
    const delay = jitterInt(RECOVERY_DELAY_MS, 0.2);
    console.log(`[RefreshScheduler] Recovery attempt for ${entryId} in ${Math.round(delay / 60000)}m`);
    this.scheduleTimer(entryId, delay, "recovery_scheduled", null, () => {
      this.timers.delete(entryId);
      void this.doRefresh(entryId, "recovery");
    });
    this.logAuth(entryId, "warn", "auth.refresh.recovery_scheduled", {
      trigger: "recovery",
      nextRefreshAt: this.nextAtFromDelay(delay),
      backoffMs: delay,
    });
  }

  private scheduleLockedRecovery(entryId: string, trigger: RefreshTrigger): void {
    this.scheduleTimer(entryId, LOCKED_RECOVERY_DELAY_MS, "recovery_scheduled", "refresh_locked_elsewhere", () => {
      this.timers.delete(entryId);
      void this.doRefresh(entryId, trigger);
    });
    this.logAuth(entryId, "warn", "auth.refresh.locked_retry_scheduled", {
      trigger,
      nextRefreshAt: this.nextAtFromDelay(LOCKED_RECOVERY_DELAY_MS),
      backoffMs: LOCKED_RECOVERY_DELAY_MS,
    });
  }

  private scheduleTimer(
    entryId: string,
    delayMs: number,
    state: RefreshScheduleSnapshot["refreshState"],
    blockedReason: string | null,
    callback: () => void,
  ): void {
    const timer = setTimeout(callback, delayMs);
    if (timer.unref) timer.unref();
    this.timers.set(entryId, timer);
    this.setSnapshot(entryId, state, this.nextAtFromDelay(delayMs), blockedReason);
  }

  private setSnapshot(
    entryId: string,
    refreshState: RefreshScheduleSnapshot["refreshState"],
    nextRefreshAt: string | null,
    refreshBlockedReason: string | null,
  ): void {
    this.snapshots.set(entryId, {
      nextRefreshAt,
      refreshState,
      refreshInFlight: this._inFlight.has(entryId) || refreshState === "refreshing",
      refreshBlockedReason,
    });
  }

  private nextAtFromDelay(delayMs: number): string {
    return new Date(Date.now() + Math.max(0, delayMs)).toISOString();
  }

  private getExpiresAt(token: string): string | null {
    const payload = decodeJwtPayload(token);
    return payload && typeof payload.exp === "number" ? new Date(payload.exp * 1000).toISOString() : null;
  }

  private logAuth(
    accountId: string,
    level: "info" | "warn" | "error",
    eventType: `auth.${string}`,
    details: Partial<AccountLogInput> = {},
  ): void {
    this.accountLogStore?.append(accountId, {
      ...details,
      category: "auth",
      level,
      eventType,
    });
  }
}
