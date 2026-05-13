import { describe, expect, it } from "vitest";
import { createProxyRoutes } from "@src/routes/proxies.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { GeminiAccountPool } from "@src/auth/gemini-account-pool.js";
import type { GeminiAccountEntry } from "@src/auth/gemini-types.js";
import type { ProxyPool } from "@src/proxy/proxy-pool.js";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
import { createValidJwt } from "@helpers/jwt.js";
import type { AccountEntry } from "@src/auth/types.js";

function codexEntry(): AccountEntry {
  return {
    id: "acc-1",
    token: createValidJwt({ email: "codex@example.com", accountId: "acct-codex" }),
    refreshToken: "rt-codex",
    idToken: null,
    email: "codex@example.com",
    accountId: "acct-codex",
    userId: null,
    label: null,
    planType: "plus",
    proxyApiKey: "px",
    status: "active",
    usage: { request_count: 0, input_tokens: 0, output_tokens: 0, empty_response_count: 0 },
    addedAt: new Date().toISOString(),
    cachedQuota: null,
    quotaFetchedAt: null,
  };
}

function geminiEntry(): GeminiAccountEntry {
  return {
    id: "gem-1",
    email: "gemini@example.com",
    label: null,
    status: "active",
    accessToken: "access",
    refreshToken: "refresh",
    idToken: null,
    scope: "openid",
    tokenType: "Bearer",
    expiresAt: null,
    projectId: null,
    userTier: null,
    userTierName: null,
    paidTier: null,
    googleAiSubscription: null,
    quota: null,
    quotaFetchedAt: null,
    lastUsedAt: null,
    lastRefreshSuccessAt: null,
    lastRefreshFailureAt: null,
    lastRefreshFailureCode: null,
    usage: { input_tokens: 0, output_tokens: 0, request_count: 0, models: {} },
    models: ["gemini-3.1-pro"],
  };
}

describe("proxy assignments provider IDs", () => {
  it("returns namespaced Codex and Gemini accounts for proxy assignment", async () => {
    const accountPool = new AccountPool({
      persistence: createMemoryPersistence([codexEntry()]),
      rotationStrategy: "least_used",
      initialToken: null,
      rateLimitBackoffSeconds: 60,
    });
    const geminiPool = new GeminiAccountPool({
      load: () => [geminiEntry()],
      save: () => {},
    });
    const proxyPool = {
      getAssignment: () => "global",
      getAssignmentDisplayName: () => "Global Default",
      getAllMasked: () => [],
    } as unknown as ProxyPool;

    const app = createProxyRoutes(proxyPool, accountPool, geminiPool);
    const res = await app.request("/api/proxies/assignments");
    const body = await res.json() as { accounts: Array<{ id: string; provider: string }> };

    expect(body.accounts.map((a) => a.id)).toContain("codex:acc-1");
    expect(body.accounts.map((a) => a.id)).toContain("gemini:gem-1");
    expect(body.accounts.map((a) => a.provider)).toContain("codex");
    expect(body.accounts.map((a) => a.provider)).toContain("gemini");
  });
});
