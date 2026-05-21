/**
 * Account session warmup tests.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const constructorCalls: Array<{
  token: string;
  accountId: string | null;
  cookieJar: null;
  entryId: string;
  proxyUrl: string | null | undefined;
}> = [];

const warmupQueue: Array<unknown> = [];
const warmupFallbackQueue: Array<unknown> = [];
const warmupStartTimes: number[] = [];

vi.mock("@src/proxy/codex-api.js", () => ({
  CodexApi: class MockCodexApi {
    constructor(
      token: string,
      accountId: string | null,
      cookieJar: null,
      entryId: string,
      proxyUrl: string | null | undefined,
    ) {
      constructorCalls.push({ token, accountId, cookieJar, entryId, proxyUrl });
    }

    async warmup(): Promise<unknown> {
      const next = warmupFallbackQueue.shift();
      if (next instanceof Error) throw next;
      return next ?? null;
    }

    async warmupSession(model?: string): Promise<unknown> {
      warmupStartTimes.push(Date.now());
      const next = warmupQueue.shift();
      if (next instanceof Error) throw next;
      return next ?? null;
    }
  },
}));

function makeParsedRateLimit(overrides?: {
  usedPercent?: number;
  resetAt?: number;
  limitWindowSeconds?: number;
}) {
  return {
    primary: {
      used_percent: overrides?.usedPercent ?? 24,
      window_minutes: overrides?.limitWindowSeconds ? overrides.limitWindowSeconds / 60 : 60,
      reset_at: overrides?.resetAt ?? 1712345678,
    },
    secondary: null,
  };
}

function makeCodexUsageResponse(overrides?: {
  usedPercent?: number;
  resetAt?: number;
  limitWindowSeconds?: number;
}) {
  return {
    plan_type: "team",
    rate_limit: {
      used_percent: overrides?.usedPercent ?? 24,
      limit_window_seconds: overrides?.limitWindowSeconds ?? 7200,
      reset_at: overrides?.resetAt ?? 1711111111,
      resets_at: overrides?.resetAt ?? 1711111111,
    },
  };
}

function makeEntry(overrides?: Partial<{
  id: string;
  token: string;
  accountId: string | null;
  email: string | null;
  status: string;
  planType: string | null;
}>) {
  return {
    id: overrides?.id ?? "acc-1",
    token: overrides?.token ?? "token-1",
    accountId: overrides?.accountId ?? "account-1",
    email: overrides?.email ?? "test@example.com",
    status: overrides?.status ?? "active",
    planType: overrides?.planType ?? "team",
  };
}

function makePool(entries: ReturnType<typeof makeEntry>[]) {
  return {
    getAllEntries: () => entries,
    updateCachedQuota: vi.fn(),
    syncRateLimitWindow: vi.fn(),
  };
}

function makeProxyPool(proxyUrl: string | null | undefined = "http://proxy.local:8080") {
  return {
    resolveProxyUrl: vi.fn(() => proxyUrl),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("batchWarmupSessions", () => {
  beforeEach(() => {
    constructorCalls.length = 0;
    warmupQueue.length = 0;
    warmupFallbackQueue.length = 0;
    warmupStartTimes.length = 0;
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("returns warmed results and syncs quota data", async () => {
    warmupQueue.push(makeParsedRateLimit({ resetAt: 1711111111, limitWindowSeconds: 7200 }));
    const pool = makePool([makeEntry()]);
    const proxyPool = makeProxyPool("http://proxy.local:9000");

    const { batchWarmupSessions } = await import("@src/services/account-session-warmup.js");
    const results = await batchWarmupSessions(pool as never, { staggerMs: 0 }, proxyPool as never);

    expect(results).toEqual([
      expect.objectContaining({
        id: "acc-1",
        email: "test@example.com",
        result: "warmed",
        previousStatus: "active",
        durationMs: expect.any(Number),
      }),
    ]);
    expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(constructorCalls).toEqual([
      {
        token: "token-1",
        accountId: "account-1",
        cookieJar: null,
        entryId: "acc-1",
        proxyUrl: "http://proxy.local:9000",
      },
    ]);
    expect(proxyPool.resolveProxyUrl).toHaveBeenCalledWith("acc-1", true);
    expect(pool.updateCachedQuota).toHaveBeenCalledWith("acc-1", {
      plan_type: "team",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        used_percent: 24,
        reset_at: 1711111111,
        limit_window_seconds: 7200,
      },
      secondary_rate_limit: null,
      code_review_rate_limit: null,
    });
    expect(pool.syncRateLimitWindow).toHaveBeenCalledWith("acc-1", 1711111111, 7200);
  });

  it("skips entries without tokens and entries that are disabled or banned", async () => {
    const pool = makePool([
      makeEntry({ id: "missing-token", token: "" }),
      makeEntry({ id: "disabled", status: "disabled" }),
      makeEntry({ id: "banned", status: "banned" }),
    ]);

    const { batchWarmupSessions } = await import("@src/services/account-session-warmup.js");
    const results = await batchWarmupSessions(pool as never, { staggerMs: 0 });

    expect(results).toEqual([
      {
        id: "missing-token",
        email: "test@example.com",
        result: "skipped",
        previousStatus: "active",
        error: "no token",
      },
      {
        id: "disabled",
        email: "test@example.com",
        result: "skipped",
        previousStatus: "disabled",
        error: "account is disabled",
      },
      {
        id: "banned",
        email: "test@example.com",
        result: "skipped",
        previousStatus: "banned",
        error: "account is banned",
      },
    ]);
    expect(constructorCalls).toHaveLength(0);
    expect(pool.updateCachedQuota).not.toHaveBeenCalled();
    expect(pool.syncRateLimitWindow).not.toHaveBeenCalled();
  });

  it("filters warmup targets by ids", async () => {
    warmupQueue.push(makeParsedRateLimit());
    const pool = makePool([
      makeEntry({ id: "acc-1" }),
      makeEntry({ id: "acc-2", token: "token-2", accountId: "account-2" }),
      makeEntry({ id: "acc-3", token: "token-3", accountId: "account-3" }),
    ]);

    const { batchWarmupSessions } = await import("@src/services/account-session-warmup.js");
    const results = await batchWarmupSessions(pool as never, {
      ids: ["acc-2"],
      staggerMs: 0,
    });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("acc-2");
    expect(results[0].result).toBe("warmed");
    expect(results[0].previousStatus).toBe("active");
    expect(results[0].durationMs).toEqual(expect.any(Number));
    expect(constructorCalls).toEqual([
      {
        token: "token-2",
        accountId: "account-2",
        cookieJar: null,
        entryId: "acc-2",
        proxyUrl: undefined,
      },
    ]);
  });

  it("schedules eligible warmups against the batch start time when concurrency is greater than one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const first = createDeferred<ReturnType<typeof makeParsedRateLimit>>();
    const second = createDeferred<ReturnType<typeof makeParsedRateLimit>>();
    const third = createDeferred<ReturnType<typeof makeParsedRateLimit>>();
    warmupQueue.push(first.promise, second.promise, third.promise);

    const pool = makePool([
      makeEntry({ id: "acc-1", token: "token-1", accountId: "account-1" }),
      makeEntry({ id: "acc-2", token: "token-2", accountId: "account-2" }),
      makeEntry({ id: "acc-3", token: "token-3", accountId: "account-3" }),
    ]);

    const { batchWarmupSessions } = await import("@src/services/account-session-warmup.js");
    const warmupPromise = batchWarmupSessions(pool as never, {
      concurrency: 2,
      staggerMs: 100,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(warmupStartTimes).toEqual([0]);

    await vi.advanceTimersByTimeAsync(99);
    expect(warmupStartTimes).toEqual([0]);

    await vi.advanceTimersByTimeAsync(1);
    expect(warmupStartTimes).toEqual([0, 100]);

    first.resolve(makeParsedRateLimit({ resetAt: 1711111111 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(warmupStartTimes).toEqual([0, 100]);

    await vi.advanceTimersByTimeAsync(99);
    expect(warmupStartTimes).toEqual([0, 100]);

    await vi.advanceTimersByTimeAsync(1);
    expect(warmupStartTimes).toEqual([0, 100, 200]);

    second.resolve(makeParsedRateLimit({ resetAt: 1711111112 }));
    third.resolve(makeParsedRateLimit({ resetAt: 1711111113 }));
    await vi.runAllTimersAsync();

    const results = await warmupPromise;
    expect(results.map((result) => result.result)).toEqual(["warmed", "warmed", "warmed"]);
  });

  it("returns failed when warmup returns no quota and fallback fails", async () => {
    warmupQueue.push(null);
    warmupFallbackQueue.push(null);
    const pool = makePool([makeEntry()]);

    const { batchWarmupSessions } = await import("@src/services/account-session-warmup.js");
    const results = await batchWarmupSessions(pool as never, { staggerMs: 0 });

    expect(results).toEqual([
      expect.objectContaining({
        id: "acc-1",
        email: "test@example.com",
        result: "failed",
        previousStatus: "active",
        durationMs: expect.any(Number),
        error: "session warmup returned no rate-limit data and fallback failed",
      }),
    ]);
    expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(pool.updateCachedQuota).not.toHaveBeenCalled();
    expect(pool.syncRateLimitWindow).not.toHaveBeenCalled();
  });

  it("falls back to warmup API when warmupSession returns no quota", async () => {
    warmupQueue.push(null);
    warmupFallbackQueue.push(makeCodexUsageResponse({ resetAt: 1711111111, limitWindowSeconds: 7200 }));
    const pool = makePool([makeEntry()]);

    const { batchWarmupSessions } = await import("@src/services/account-session-warmup.js");
    const results = await batchWarmupSessions(pool as never, { staggerMs: 0 });

    expect(results).toEqual([
      expect.objectContaining({
        id: "acc-1",
        email: "test@example.com",
        result: "failed",
        previousStatus: "active",
        durationMs: expect.any(Number),
        error: "session warmup failed (fallback to query-only)",
      }),
    ]);
    expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(pool.updateCachedQuota).toHaveBeenCalledWith("acc-1", {
      plan_type: "team",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        used_percent: 24,
        reset_at: 1711111111,
        limit_window_seconds: 7200,
      },
      secondary_rate_limit: null,
      code_review_rate_limit: null,
    });
    expect(pool.syncRateLimitWindow).toHaveBeenCalledWith("acc-1", 1711111111, 7200);
  });

  it("returns failed when warmup throws", async () => {
    warmupQueue.push(new Error("upstream exploded"));
    const pool = makePool([makeEntry()]);

    const { batchWarmupSessions } = await import("@src/services/account-session-warmup.js");
    const results = await batchWarmupSessions(pool as never, { staggerMs: 0 });

    expect(results).toEqual([
      expect.objectContaining({
        id: "acc-1",
        email: "test@example.com",
        result: "failed",
        previousStatus: "active",
        durationMs: expect.any(Number),
        error: "upstream exploded",
      }),
    ]);
    expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(pool.updateCachedQuota).not.toHaveBeenCalled();
    expect(pool.syncRateLimitWindow).not.toHaveBeenCalled();
  });

  it("returns failed when warmupSession quota has limit_reached set to true", async () => {
    warmupQueue.push(makeParsedRateLimit({ usedPercent: 100 }));
    const pool = makePool([makeEntry()]);

    const { batchWarmupSessions } = await import("@src/services/account-session-warmup.js");
    const results = await batchWarmupSessions(pool as never, { staggerMs: 0 });

    expect(results).toEqual([
      expect.objectContaining({
        id: "acc-1",
        email: "test@example.com",
        result: "failed",
        previousStatus: "active",
        durationMs: expect.any(Number),
        error: "rate limit reached (사용량초과)",
      }),
    ]);
    expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(pool.updateCachedQuota).toHaveBeenCalled();
    expect(pool.syncRateLimitWindow).toHaveBeenCalled();
  });

  it("returns failed when fallback warmup quota has limit_reached set to true", async () => {
    warmupQueue.push(null);
    const usageResponse = makeCodexUsageResponse();
    usageResponse.rate_limit.used_percent = 100;
    warmupFallbackQueue.push(usageResponse);
    const pool = makePool([makeEntry()]);

    const { batchWarmupSessions } = await import("@src/services/account-session-warmup.js");
    const results = await batchWarmupSessions(pool as never, { staggerMs: 0 });

    expect(results).toEqual([
      expect.objectContaining({
        id: "acc-1",
        email: "test@example.com",
        result: "failed",
        previousStatus: "active",
        durationMs: expect.any(Number),
        error: "rate limit reached (사용량초과)",
      }),
    ]);
    expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(pool.updateCachedQuota).toHaveBeenCalled();
    expect(pool.syncRateLimitWindow).toHaveBeenCalled();
  });
});
