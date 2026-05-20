/**
 * Account session warmup service.
 * Establishes Codex usage sessions and syncs cached quota data.
 */

import type { AccountPool } from "../auth/account-pool.js";
import type { AccountEntry } from "../auth/types.js";
import { toQuota } from "../auth/quota-utils.js";
import { CodexApi } from "../proxy/codex-api.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import { rateLimitToQuota } from "../proxy/rate-limit-headers.js";

export interface AccountSessionWarmupResult {
  id: string;
  email: string | null;
  previousStatus: string;
  result: "warmed" | "failed" | "skipped";
  durationMs?: number;
  error?: string;
}

export interface BatchWarmupSessionsOptions {
  staggerMs?: number;
  concurrency?: number;
  ids?: string[];
}

interface EligibleWarmupItem {
  entry: AccountEntry;
  candidateIndex: number;
  scheduledStartAt: number;
}

export async function batchWarmupSessions(
  pool: AccountPool,
  options?: BatchWarmupSessionsOptions,
  proxyPool?: ProxyPool | null,
): Promise<AccountSessionWarmupResult[]> {
  const staggerMs = Math.max(0, options?.staggerMs ?? 3000);
  const concurrency = Math.max(1, options?.concurrency ?? 2);
  const batchStartedAt = Date.now();
  const allEntries = pool.getAllEntries();
  const idSet = options?.ids ? new Set(options.ids) : null;
  const candidates = idSet
    ? allEntries.filter((entry) => idSet.has(entry.id))
    : allEntries;

  const results = new Array<AccountSessionWarmupResult>(candidates.length);
  const eligible: EligibleWarmupItem[] = [];

  for (const [candidateIndex, entry] of candidates.entries()) {
    const skipReason = getSkipReason(entry);
    if (skipReason) {
      results[candidateIndex] = {
        id: entry.id,
        email: entry.email,
        previousStatus: entry.status,
        result: "skipped",
        error: skipReason,
      };
      continue;
    }

    eligible.push({
      entry,
      candidateIndex,
      scheduledStartAt: batchStartedAt + eligible.length * staggerMs,
    });
  }

  let nextIndex = 0;
  const workerCount = Math.min(concurrency, eligible.length);

  async function worker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= eligible.length) return;

      const item = eligible[currentIndex];
      results[item.candidateIndex] = await warmupEligibleEntry(pool, item, proxyPool);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function getSkipReason(entry: AccountEntry): string | null {
  if (!entry.token) return "no token";
  if (entry.status === "disabled") return "account is disabled";
  if (entry.status === "banned") return "account is banned";
  return null;
}

async function warmupEligibleEntry(
  pool: AccountPool,
  item: EligibleWarmupItem,
  proxyPool?: ProxyPool | null,
): Promise<AccountSessionWarmupResult> {
  const { entry, scheduledStartAt } = item;
  const waitMs = scheduledStartAt - Date.now();
  if (waitMs > 0) await delay(waitMs);

  const proxyUrl = proxyPool?.resolveProxyUrl(entry.id, true);
  const api = new CodexApi(entry.token, entry.accountId, null, entry.id, proxyUrl);
  const previousStatus = entry.status;
  const startedAt = Date.now();

  try {
    const rateLimit = await api.warmupSession();
    let quota;

    if (!rateLimit) {
      // Fallback: Attempt to fetch usage/quota directly via api.warmup()
      const usageResponse = await api.warmup();
      if (!usageResponse) {
        return {
          id: entry.id,
          email: entry.email,
          previousStatus,
          result: "failed",
          durationMs: Date.now() - startedAt,
          error: "session warmup returned no rate-limit data and fallback failed",
        };
      }
      quota = toQuota(usageResponse);
    } else {
      quota = rateLimitToQuota(rateLimit, (entry as any).planType ?? null);
    }

    pool.updateCachedQuota(entry.id, quota);
    pool.syncRateLimitWindow(
      entry.id,
      quota.rate_limit.reset_at,
      quota.rate_limit.limit_window_seconds,
    );

    const isLimitReached =
      quota.rate_limit?.limit_reached === true ||
      quota.secondary_rate_limit?.limit_reached === true ||
      quota.code_review_rate_limit?.limit_reached === true;

    if (isLimitReached) {
      return {
        id: entry.id,
        email: entry.email,
        previousStatus,
        result: "failed",
        durationMs: Date.now() - startedAt,
        error: "rate limit reached (사용량초과)",
      };
    }

    return {
      id: entry.id,
      email: entry.email,
      previousStatus,
      result: "warmed",
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      id: entry.id,
      email: entry.email,
      previousStatus,
      result: "failed",
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
