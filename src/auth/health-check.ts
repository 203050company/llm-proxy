/**
 * Account health check — probes accounts by attempting token refresh.
 *
 * Uses OAuth refresh_token endpoint (auth.openai.com) only, never
 * hits the Codex API (chatgpt.com), so it won't trigger risk detection.
 *
 * Features:
 * - Single-account and batch modes
 * - Configurable stagger delay between accounts (anti-fingerprinting)
 * - Concurrent limit via semaphore
 * - Auto-marks accounts as expired on permanent refresh failure
 */

import { refreshAccessToken } from "./oauth-pkce.js";
import { jitterInt } from "../utils/jitter.js";
import { summarizeError } from "../utils/sanitize-log.js";
import { decodeJwtPayload } from "./jwt-utils.js";
import type { AccountPool } from "./account-pool.js";
import type { RefreshScheduler } from "./refresh-scheduler.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import type { AccountLogInput, AccountLogStore } from "../services/account-log-store.js";

export interface HealthCheckResult {
  id: string;
  email: string | null;
  previousStatus: string;
  result: "alive" | "dead" | "skipped";
  /** Error message when result is "dead". */
  error?: string;
  /** Duration in ms for this probe. */
  durationMs?: number;
}

export interface BatchHealthCheckOptions {
  /** Stagger delay between accounts in ms (default 3000). */
  staggerMs?: number;
  /** Max concurrent probes (default 2). */
  concurrency?: number;
  /** Only check accounts with these IDs (default: all with RT). */
  ids?: string[];
  accountLogStore?: AccountLogStore;
}

function logAuth(
  store: AccountLogStore | undefined,
  accountId: string,
  level: "info" | "warn" | "error",
  eventType: `auth.${string}`,
  details: Partial<AccountLogInput> = {},
): void {
  store?.append(accountId, {
    ...details,
    category: "auth",
    level,
    eventType,
  });
}

function getExpiresAt(token: string): string | null {
  const payload = decodeJwtPayload(token);
  return typeof payload?.exp === "number" ? new Date(payload.exp * 1000).toISOString() : null;
}

const PERMANENT_REFRESH_FAILURE_CODES = new Set([
  "invalid_grant",
  "invalid_token",
  "access_denied",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
  "account has been deactivated",
]);

/**
 * Probe a single account by refreshing its token.
 * Returns the health check result without mutating account state.
 */
export async function probeAccount(
  pool: AccountPool,
  scheduler: RefreshScheduler,
  entryId: string,
  proxyPool?: ProxyPool | null,
  accountLogStore?: AccountLogStore,
): Promise<HealthCheckResult> {
  const entry = pool.getEntry(entryId);
  if (!entry) {
    return { id: entryId, email: null, previousStatus: "unknown", result: "skipped", error: "not found" };
  }

  if (!entry.refreshToken) {
    logAuth(accountLogStore, entryId, "warn", "auth.refresh.unavailable_no_refresh_token", {
      trigger: "manual_dashboard",
      message: "No refresh token available",
    });
    pool.recordRefreshFailure(entryId, "manual_dashboard", "missing_refresh_token", "No refresh token available");
    return { id: entryId, email: entry.email, previousStatus: entry.status, result: "skipped", error: "no refresh token" };
  }

  if (entry.status === "disabled") {
    logAuth(accountLogStore, entryId, "info", "auth.refresh.skipped_disabled", { trigger: "manual_dashboard" });
    return { id: entryId, email: entry.email, previousStatus: entry.status, result: "skipped", error: "manually disabled" };
  }

  // Skip if scheduler is already refreshing this account — avoid racing for the same one-time RT
  if (scheduler.isRefreshing?.(entryId)) {
    logAuth(accountLogStore, entryId, "info", "auth.refresh.skipped_in_progress", { trigger: "manual_dashboard" });
    return { id: entryId, email: entry.email, previousStatus: entry.status, result: "skipped", error: "refresh already in progress" };
  }

  const previousStatus = entry.status;
  const start = Date.now();
  pool.recordRefreshAttempt(entryId, "manual_dashboard");
  logAuth(accountLogStore, entryId, "info", "auth.refresh.started", {
    trigger: "manual_dashboard",
    expiresAt: getExpiresAt(entry.token),
  });

  try {
    const accountProxyUrl = proxyPool?.resolveProxyUrl(entryId, true);
    const tokens = await refreshAccessToken(entry.refreshToken, accountProxyUrl);
    pool.updateToken(entryId, tokens.access_token, tokens.refresh_token ?? undefined, tokens.id_token);
    pool.recordRefreshSuccess(entryId, "manual_dashboard");
    scheduler.scheduleOne(entryId, tokens.access_token);
    logAuth(accountLogStore, entryId, "info", "auth.refresh.succeeded", {
      trigger: "manual_dashboard",
      durationMs: Date.now() - start,
    });

    return {
      id: entryId,
      email: entry.email,
      previousStatus,
      result: "alive",
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const summary = summarizeError(err);
    const isPermanent = summary.failureCode ? PERMANENT_REFRESH_FAILURE_CODES.has(summary.failureCode) : false;

    pool.recordRefreshFailure(entryId, "manual_dashboard", summary.failureCode ?? null, summary.message);
    logAuth(accountLogStore, entryId, isPermanent ? "error" : "warn", isPermanent ? "auth.refresh.failed_permanent" : "auth.refresh.failed_transient", {
      trigger: "manual_dashboard",
      durationMs: Date.now() - start,
      errorClass: summary.errorClass,
      failureCode: summary.failureCode,
      message: summary.message,
    });

    if (isPermanent) {
      pool.markStatus(entryId, "expired");
    }

    return {
      id: entryId,
      email: entry.email,
      previousStatus,
      result: "dead",
      error: summary.message,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Batch health check with stagger delay and concurrency control.
 * Yields results as they complete (for SSE streaming if needed).
 */
export async function batchHealthCheck(
  pool: AccountPool,
  scheduler: RefreshScheduler,
  options?: BatchHealthCheckOptions,
  proxyPool?: ProxyPool | null,
): Promise<HealthCheckResult[]> {
  const staggerMs = options?.staggerMs ?? 3000;
  const concurrency = options?.concurrency ?? 2;

  // Collect eligible accounts
  const allEntries = pool.getAllEntries();
  const candidates = options?.ids
    ? allEntries.filter((e) => options.ids!.includes(e.id))
    : allEntries;

  // Filter: need RT, not disabled
  const eligible = candidates.filter((e) => e.refreshToken && e.status !== "disabled");
  const skipped = candidates.filter((e) => !e.refreshToken || e.status === "disabled");

  const results: HealthCheckResult[] = skipped.map((e) => {
    const error = !e.refreshToken ? "no refresh token" : "manually disabled";
    logAuth(options?.accountLogStore, e.id, !e.refreshToken ? "warn" : "info", !e.refreshToken ? "auth.refresh.unavailable_no_refresh_token" : "auth.refresh.skipped_disabled", {
      trigger: "manual_dashboard",
      message: !e.refreshToken ? "No refresh token available" : undefined,
    });
    if (!e.refreshToken) {
      pool.recordRefreshFailure(e.id, "manual_dashboard", "missing_refresh_token", "No refresh token available");
    }
    return {
      id: e.id,
      email: e.email,
      previousStatus: e.status,
      result: "skipped" as const,
      error,
    };
  });

  // Process with concurrency limit + stagger
  let running = 0;
  const queue: Array<() => void> = [];
  let accountIndex = 0;

  const acquireSlot = (): Promise<void> => {
    if (running < concurrency) {
      running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => queue.push(resolve));
  };

  const releaseSlot = (): void => {
    running--;
    const next = queue.shift();
    if (next) {
      running++;
      next();
    }
  };

  const tasks = eligible.map((entry) => {
    const myIndex = accountIndex++;
    return (async () => {
      // Stagger: wait before starting (skip first account)
      if (myIndex > 0) {
        const delay = jitterInt(staggerMs * Math.min(myIndex, concurrency), 0.3);
        await new Promise((r) => setTimeout(r, delay));
      }
      await acquireSlot();
      try {
        const result = await probeAccount(pool, scheduler, entry.id, proxyPool, options?.accountLogStore);
        results.push(result);
      } finally {
        releaseSlot();
      }
    })();
  });

  await Promise.all(tasks);
  return results;
}
