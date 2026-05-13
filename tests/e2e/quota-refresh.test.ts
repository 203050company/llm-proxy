/**
 * E2E tests for quota auto-refresh and warnings.
 *
 * Tests:
 * - GET /auth/accounts returns cached quota from background refresh
 * - GET /auth/accounts?quota=fresh forces live upstream fetch
 * - GET /auth/quota/warnings returns active warnings
 * - Accounts with exhausted quota are skipped by acquire()
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import "@helpers/e2e-setup.js";
import { createValidJwt } from "@helpers/jwt.js";

import { Hono } from "hono";
import { requestId } from "@src/middleware/request-id.js";
import { errorHandler } from "@src/middleware/error-handler.js";
import { createAccountRoutes } from "@src/routes/accounts.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { RefreshScheduler } from "@src/auth/refresh-scheduler.js";
import type { CodexQuota } from "@src/auth/types.js";
import { updateWarnings, clearWarnings, getActiveWarnings } from "@src/auth/quota-warnings.js";
import { CodexApi } from "@src/proxy/codex-api.js";
import type { CodexUsageResponse } from "@src/proxy/codex-types.js";

let app: Hono;
let pool: AccountPool;
let scheduler: RefreshScheduler;

function makeQuota(usedPercent: number, limitReached = false): CodexQuota {
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: limitReached,
      used_percent: usedPercent,
      reset_at: Math.floor(Date.now() / 1000) + 3600,
      limit_window_seconds: 3600,
    },
    secondary_rate_limit: null,
    code_review_rate_limit: null,
  };
}

function makeUsage(usedPercent: number, weeklyPercent = 80): CodexUsageResponse {
  const now = Math.floor(Date.now() / 1000);
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: usedPercent >= 100,
      primary_window: {
        used_percent: usedPercent,
        reset_after_seconds: 3600,
        reset_at: now + 3600,
        limit_window_seconds: 3600,
      },
      secondary_window: {
        used_percent: weeklyPercent,
        reset_after_seconds: 7 * 86400,
        reset_at: now + 7 * 86400,
        limit_window_seconds: 7 * 86400,
      },
    },
    code_review_rate_limit: null,
    credits: null,
    promo: null,
  };
}

function makeUsageForPlan(planType: string, usedPercent: number, weeklyPercent = 80): CodexUsageResponse {
  return { ...makeUsage(usedPercent, weeklyPercent), plan_type: planType };
}

function makeFlatUsageForPlan(planType: string, usedPercent: number): CodexUsageResponse {
  return {
    rate_limit: {
      plan_type: planType,
      allowed: true,
      limit_reached: usedPercent >= 100,
      used_percent: usedPercent,
      resets_at: Math.floor(Date.now() / 1000) + 3600,
      limit_window_seconds: 5 * 3600,
    },
    code_review_rate_limit: null,
    credits: null,
    promo: null,
  } as CodexUsageResponse;
}

beforeAll(() => {
  pool = new AccountPool();
  scheduler = new RefreshScheduler(pool);

  app = new Hono();
  app.use("*", requestId);
  app.use("*", errorHandler);
  app.route("/", createAccountRoutes(pool, scheduler));
});

afterAll(() => {
  scheduler.destroy();
  pool.destroy();
  // Clean up warnings
  for (const w of getActiveWarnings()) {
    clearWarnings(w.accountId);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("E2E: quota auto-refresh", () => {
  it("GET /auth/accounts returns cached quota without upstream call", async () => {
    const id = pool.addAccount(createValidJwt({
      accountId: "acct-quota-1",
      email: "quota1@test.com",
      planType: "plus",
    }));

    // Simulate background refresh by updating cached quota
    pool.updateCachedQuota(id, makeQuota(65));

    const res = await app.request("/auth/accounts?quota=true");
    expect(res.status).toBe(200);

    const body = await res.json() as { accounts: Array<{ id: string; quota?: CodexQuota; quotaFetchedAt?: string }> };
    const acct = body.accounts.find((a) => a.id === id);
    expect(acct).toBeDefined();
    expect(acct!.quota).toBeDefined();
    expect(acct!.quota!.rate_limit.used_percent).toBe(65);
    expect(acct!.quotaFetchedAt).toBeTruthy();

    // Cleanup
    pool.removeAccount(id);
  });

  it("GET /auth/accounts without quota param also returns cached quota", async () => {
    const id = pool.addAccount(createValidJwt({
      accountId: "acct-quota-2",
      email: "quota2@test.com",
      planType: "plus",
    }));

    pool.updateCachedQuota(id, makeQuota(42));

    const res = await app.request("/auth/accounts");
    expect(res.status).toBe(200);

    const body = await res.json() as { accounts: Array<{ id: string; quota?: CodexQuota }> };
    const acct = body.accounts.find((a) => a.id === id);
    expect(acct?.quota?.rate_limit.used_percent).toBe(42);

    pool.removeAccount(id);
  });

  it("GET /auth/accounts?quota=fresh fetches live quota and updates cache", async () => {
    const id = pool.addAccount(createValidJwt({
      accountId: "acct-quota-fresh-1",
      email: "fresh1@test.com",
      planType: "plus",
    }));

    vi.spyOn(CodexApi.prototype, "getUsage").mockResolvedValue(makeUsage(58, 78));

    const res = await app.request("/auth/accounts?quota=fresh");
    expect(res.status).toBe(200);

    const body = await res.json() as { accounts: Array<{ id: string; quota?: CodexQuota; quotaFetchedAt?: string }> };
    const acct = body.accounts.find((a) => a.id === id);
    expect(acct?.quota?.rate_limit.used_percent).toBe(58);
    expect(acct?.quota?.secondary_rate_limit?.used_percent).toBe(78);
    expect(acct?.quotaFetchedAt).toBeTruthy();
    expect(pool.getEntry(id)?.cachedQuota?.rate_limit.used_percent).toBe(58);

    pool.removeAccount(id);
  });

  it("GET /auth/accounts?quota=fresh updates account planType from live quota", async () => {
    const id = pool.addAccount(createValidJwt({
      accountId: "acct-quota-plan-fresh-1",
      email: "plan-fresh@test.com",
      planType: "free",
    }));

    try {
      vi.spyOn(CodexApi.prototype, "getUsage").mockResolvedValue(makeUsageForPlan("plus", 58, 78));

      const res = await app.request("/auth/accounts?quota=fresh");
      expect(res.status).toBe(200);

      const body = await res.json() as { accounts: Array<{ id: string; planType?: string | null; quota?: CodexQuota }> };
      const acct = body.accounts.find((a) => a.id === id);
      expect(acct?.planType).toBe("plus");
      expect(acct?.quota?.plan_type).toBe("plus");
      expect(pool.getEntry(id)?.planType).toBe("plus");
    } finally {
      pool.removeAccount(id);
    }
  });

  it("GET /auth/accounts/:id/quota updates cached quota for the account", async () => {
    const id = pool.addAccount(createValidJwt({
      accountId: "acct-quota-live-1",
      email: "live1@test.com",
      planType: "plus",
    }));

    vi.spyOn(CodexApi.prototype, "getUsage").mockResolvedValue(makeUsage(44, 66));

    const res = await app.request(`/auth/accounts/${id}/quota`);
    expect(res.status).toBe(200);

    const body = await res.json() as { quota: CodexQuota };
    expect(body.quota.rate_limit.used_percent).toBe(44);
    expect(body.quota.secondary_rate_limit?.used_percent).toBe(66);
    expect(pool.getEntry(id)?.cachedQuota?.secondary_rate_limit?.used_percent).toBe(66);

    pool.removeAccount(id);
  });

  it("GET /auth/accounts/:id/quota updates account planType from live quota", async () => {
    const id = pool.addAccount(createValidJwt({
      accountId: "acct-quota-plan-live-1",
      email: "plan-live@test.com",
      planType: "free",
    }));

    try {
      vi.spyOn(CodexApi.prototype, "getUsage").mockResolvedValue(makeUsageForPlan("plus", 44, 66));

      const res = await app.request(`/auth/accounts/${id}/quota`);
      expect(res.status).toBe(200);

      const body = await res.json() as { quota: CodexQuota };
      expect(body.quota.plan_type).toBe("plus");
      expect(pool.getEntry(id)?.planType).toBe("plus");
    } finally {
      pool.removeAccount(id);
    }
  });

  it("GET /auth/accounts/:id/quota handles flat usage responses with nested plan type", async () => {
    const id = pool.addAccount(createValidJwt({
      accountId: "acct-quota-plan-live-flat-1",
      email: "plan-live-flat@test.com",
      planType: "free",
    }));

    try {
      vi.spyOn(CodexApi.prototype, "getUsage").mockResolvedValue(makeFlatUsageForPlan("plus", 31));

      const res = await app.request(`/auth/accounts/${id}/quota`);
      expect(res.status).toBe(200);

      const body = await res.json() as { quota: CodexQuota };
      expect(body.quota.plan_type).toBe("plus");
      expect(body.quota.rate_limit.used_percent).toBe(31);
      expect(body.quota.rate_limit.limit_window_seconds).toBe(5 * 3600);
      expect(pool.getEntry(id)?.planType).toBe("plus");
    } finally {
      pool.removeAccount(id);
    }
  });

  it("GET /auth/accounts?quota=fresh refreshes rate_limited accounts too", async () => {
    const id = pool.addAccount(createValidJwt({
      accountId: "acct-quota-fresh-limited-1",
      email: "fresh-limited@test.com",
      planType: "plus",
    }));
    pool.markRateLimited(id, { retryAfterSec: 7200 });

    vi.spyOn(CodexApi.prototype, "getUsage").mockResolvedValue(makeUsage(7, 100));

    const res = await app.request("/auth/accounts?quota=fresh");
    expect(res.status).toBe(200);

    const body = await res.json() as { accounts: Array<{ id: string; quota?: CodexQuota; quotaFetchedAt?: string }> };
    const acct = body.accounts.find((a) => a.id === id);
    expect(acct?.quota?.rate_limit.used_percent).toBe(7);
    expect(acct?.quota?.secondary_rate_limit?.used_percent).toBe(100);
    expect(acct?.quotaFetchedAt).toBeTruthy();

    pool.removeAccount(id);
  });

  it("GET /auth/accounts/:id/quota allows rate_limited accounts", async () => {
    const id = pool.addAccount(createValidJwt({
      accountId: "acct-quota-live-limited-1",
      email: "live-limited@test.com",
      planType: "plus",
    }));
    pool.markRateLimited(id, { retryAfterSec: 7200 });

    vi.spyOn(CodexApi.prototype, "getUsage").mockResolvedValue(makeUsage(9, 100));

    const res = await app.request(`/auth/accounts/${id}/quota`);
    expect(res.status).toBe(200);

    const body = await res.json() as { quota: CodexQuota };
    expect(body.quota.rate_limit.used_percent).toBe(9);
    expect(body.quota.secondary_rate_limit?.used_percent).toBe(100);
    expect(pool.getEntry(id)?.cachedQuota?.secondary_rate_limit?.used_percent).toBe(100);

    pool.removeAccount(id);
  });

  it("GET /auth/quota/warnings returns empty when no warnings", async () => {
    const res = await app.request("/auth/quota/warnings");
    expect(res.status).toBe(200);

    const body = await res.json() as { warnings: unknown[] };
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  it("GET /auth/quota/warnings returns active warnings", async () => {
    updateWarnings("test-acct-1", [
      {
        accountId: "test-acct-1",
        email: "test@test.com",
        window: "primary",
        level: "critical",
        usedPercent: 95,
        resetAt: null,
      },
    ]);

    const res = await app.request("/auth/quota/warnings");
    expect(res.status).toBe(200);

    const body = await res.json() as { warnings: Array<{ accountId: string; level: string }> };
    expect(body.warnings.length).toBeGreaterThanOrEqual(1);
    const w = body.warnings.find((w) => w.accountId === "test-acct-1");
    expect(w).toBeDefined();
    expect(w!.level).toBe("critical");

    clearWarnings("test-acct-1");
  });

  it("applyRateLimit429 causes acquire to skip that account", async () => {
    const id1 = pool.addAccount(createValidJwt({
      accountId: "acct-exhaust-1",
      email: "exhaust1@test.com",
      planType: "plus",
    }));
    const id2 = pool.addAccount(createValidJwt({
      accountId: "acct-exhaust-2",
      email: "exhaust2@test.com",
      planType: "plus",
    }));

    // Exhaust first account via cachedQuota path
    pool.applyRateLimit429(id1, { resetsAtSec: Math.floor(Date.now() / 1000) + 7200 });

    const acquired = pool.acquire();
    expect(acquired).not.toBeNull();
    expect(acquired!.entryId).toBe(id2);
    pool.release(acquired!.entryId);

    // Cleanup
    pool.removeAccount(id1);
    pool.removeAccount(id2);
  });
});
