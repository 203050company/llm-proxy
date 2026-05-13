/**
 * Tests for RefreshScheduler — JWT auto-refresh scheduling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const refreshLockMocks = vi.hoisted(() => ({
  tryAcquireRefreshLock: vi.fn(() => true),
  releaseRefreshLock: vi.fn(),
}));

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    auth: {
      refresh_enabled: true,
      refresh_margin_seconds: 300,
      refresh_concurrency: 2,
    },
  })),
}));

vi.mock("@src/auth/jwt-utils.js", () => ({
  decodeJwtPayload: vi.fn(() => ({
    exp: Math.floor(Date.now() / 1000) + 3600,
  })),
}));

vi.mock("@src/auth/oauth-pkce.js", () => ({
  refreshAccessToken: vi.fn(),
}));

vi.mock("@src/auth/refresh-lock.js", () => ({
  tryAcquireRefreshLock: refreshLockMocks.tryAcquireRefreshLock,
  releaseRefreshLock: refreshLockMocks.releaseRefreshLock,
}));

vi.mock("@src/utils/jitter.js", () => ({
  jitter: vi.fn((val: number) => val),
  jitterInt: vi.fn((val: number) => val),
}));

import { RefreshScheduler } from "@src/auth/refresh-scheduler.js";
import { refreshAccessToken } from "@src/auth/oauth-pkce.js";
import type { AccountPool } from "@src/auth/account-pool.js";
import { AccountLogStore } from "@src/services/account-log-store.js";

function createMockPool(entries: Array<{
  id: string;
  token: string;
  refreshToken: string | null;
  status: string;
}>): AccountPool {
  const makeEntry = (entry: typeof entries[number]) => ({
    ...entry,
    email: null,
    accountId: null,
    planType: null,
    proxyApiKey: "key",
    usage: {
      request_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      empty_response_count: 0,
      last_used: null,
      rate_limit_until: null,
    },
    addedAt: new Date().toISOString(),
  });

  return {
    getAllEntries: vi.fn(() => entries.map(makeEntry)),
    getEntry: vi.fn((id: string) => {
      const entry = entries.find((e) => e.id === id);
      return entry ? makeEntry(entry) : undefined;
    }),
    updateToken: vi.fn(),
    markStatus: vi.fn(),
    recordRefreshAttempt: vi.fn(),
    recordRefreshSuccess: vi.fn(),
    recordRefreshFailure: vi.fn(),
    readEntryRTFromDisk: vi.fn(() => null),
  } as unknown as AccountPool;
}

describe("RefreshScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    refreshLockMocks.tryAcquireRefreshLock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not schedule until start() is called, then records scheduled auth log", () => {
    const pool = createMockPool([
      { id: "acc1", token: "token1", refreshToken: "refresh1", status: "active" },
    ]);
    const store = new AccountLogStore();
    const scheduler = new RefreshScheduler(pool, { accountLogStore: store });

    expect(scheduler.getSnapshot("acc1").refreshState).toBe("idle");

    scheduler.start();

    expect(scheduler.getSnapshot("acc1").refreshState).toBe("scheduled");
    expect(store.list("acc1").logs.map((log) => log.eventType)).toContain("auth.refresh.scheduled");
    scheduler.destroy();
  });

  it("attempts immediate refresh for 'refreshing' state (crash recovery)", () => {
    const pool = createMockPool([
      { id: "acc1", token: "token1", refreshToken: "refresh1", status: "refreshing" },
    ]);

    vi.mocked(refreshAccessToken).mockResolvedValue({
      access_token: "new-token",
      refresh_token: "new-refresh",
    });

    const store = new AccountLogStore();
    const scheduler = new RefreshScheduler(pool, { accountLogStore: store });
    scheduler.start();
    expect(store.list("acc1").logs.map((log) => log.eventType)).toContain("auth.refresh.crash_recovery_started");
    scheduler.destroy();
  });

  it("retries startup recovery when an existing refresh lock blocks a refreshing account", async () => {
    const pool = createMockPool([
      { id: "acc1", token: "token1", refreshToken: "refresh1", status: "refreshing" },
    ]);
    refreshLockMocks.tryAcquireRefreshLock.mockReturnValueOnce(false).mockReturnValue(true);
    vi.mocked(refreshAccessToken).mockResolvedValue({
      access_token: "new-token",
      refresh_token: "new-refresh",
    });

    const store = new AccountLogStore();
    const scheduler = new RefreshScheduler(pool, { accountLogStore: store });
    scheduler.start();
    await vi.runAllTicks();

    expect(scheduler.getSnapshot("acc1")).toMatchObject({
      refreshState: "recovery_scheduled",
      refreshBlockedReason: "refresh_locked_elsewhere",
    });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(refreshAccessToken).toHaveBeenCalledWith("refresh1", undefined);
    expect(pool.markStatus).toHaveBeenCalledWith("acc1", "refreshing");
    expect(store.list("acc1").logs.map((log) => log.eventType)).toContain("auth.refresh.locked_retry_scheduled");
    scheduler.destroy();
  });

  it("skips expired accounts without refresh token (no schedule, no error)", () => {
    const pool = createMockPool([
      { id: "acc1", token: "token1", refreshToken: null, status: "expired" },
    ]);
    const store = new AccountLogStore();
    const scheduler = new RefreshScheduler(pool, { accountLogStore: store });
    scheduler.start();
    expect(scheduler.getSnapshot("acc1")).toMatchObject({
      refreshState: "blocked",
      refreshBlockedReason: "missing_refresh_token",
    });
    expect(store.list("acc1").logs.map((log) => log.eventType)).toContain("auth.refresh.missing_refresh_token");
    scheduler.destroy();
  });

  it("schedules recovery for expired accounts with refresh token", () => {
    const pool = createMockPool([
      { id: "acc1", token: "token1", refreshToken: "refresh1", status: "expired" },
    ]);
    const store = new AccountLogStore();
    const scheduler = new RefreshScheduler(pool, { accountLogStore: store });
    scheduler.start();
    expect(scheduler.getSnapshot("acc1").refreshState).toBe("recovery_scheduled");
    expect(store.list("acc1").logs.map((log) => log.eventType)).toContain("auth.refresh.expired_recovery_scheduled");
    scheduler.destroy();
  });

  it("marks expired immediately when OpenAI invalidates the refresh-token chain", async () => {
    const pool = createMockPool([
      { id: "acc1", token: "token1", refreshToken: "refresh1", status: "active" },
    ]);
    vi.mocked(refreshAccessToken).mockRejectedValue(
      new Error(
        'Token refresh failed (401): {"error":{"message":"Your refresh token has been invalidated. Please try signing in again.","code":"refresh_token_invalidated"}}',
      ),
    );
    const store = new AccountLogStore();
    const scheduler = new RefreshScheduler(pool, { accountLogStore: store });

    scheduler.triggerRefreshNow("acc1", "reactive_401");
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(refreshAccessToken).toHaveBeenCalledTimes(2);
    expect(pool.markStatus).toHaveBeenCalledWith("acc1", "expired");
    expect(store.list("acc1").logs.map((log) => log.eventType)).toContain("auth.refresh.failed_permanent");
    expect(scheduler.getSnapshot("acc1").refreshState).not.toBe("recovery_scheduled");
    scheduler.destroy();
  });

  it("stores id token returned by scheduled refresh", async () => {
    const pool = createMockPool([
      { id: "acc1", token: "token1", refreshToken: "refresh1", status: "active" },
    ]);
    vi.mocked(refreshAccessToken).mockResolvedValue({
      access_token: "new-token",
      refresh_token: "new-refresh",
      id_token: "real-id-token",
    });
    const scheduler = new RefreshScheduler(pool);

    scheduler.triggerRefreshNow("acc1", "reactive_401");
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);

    expect(pool.updateToken).toHaveBeenCalledWith("acc1", "new-token", "new-refresh", "real-id-token");
    scheduler.destroy();
  });

  it("destroy cancels all timers", () => {
    const pool = createMockPool([
      { id: "acc1", token: "token1", refreshToken: "refresh1", status: "active" },
      { id: "acc2", token: "token2", refreshToken: "refresh2", status: "active" },
    ]);
    const scheduler = new RefreshScheduler(pool);
    scheduler.start();
    scheduler.destroy();
    // No timers should fire after destroy
  });
});
