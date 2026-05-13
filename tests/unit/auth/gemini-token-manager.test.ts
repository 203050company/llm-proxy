import { beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiAccountPool } from "@src/auth/gemini-account-pool.js";
import type { GeminiAccountEntry } from "@src/auth/gemini-types.js";
import { GeminiTokenManager, isGeminiTokenExpiringSoon } from "@src/auth/gemini-token-manager.js";

vi.mock("@src/config.js", () => ({
  getConfig: () => ({
    gemini: {
      refresh_enabled: true,
      refresh_margin_seconds: 300,
    },
  }),
}));

function makeEntry(overrides: Partial<GeminiAccountEntry> = {}): GeminiAccountEntry {
  return {
    id: "g1",
    email: "gemini@example.com",
    label: null,
    status: "active",
    accessToken: "old-access",
    refreshToken: "refresh-token",
    idToken: null,
    scope: "openid",
    tokenType: "Bearer",
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    projectId: "project-1",
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
    ...overrides,
  };
}

describe("GeminiTokenManager", () => {
  let saved: GeminiAccountEntry[];
  let pool: GeminiAccountPool;

  beforeEach(() => {
    saved = [];
    pool = new GeminiAccountPool({
      load: () => saved,
      save: (entries) => {
        saved = structuredClone(entries);
      },
    });
  });

  it("detects tokens that expire within the configured margin", () => {
    expect(isGeminiTokenExpiringSoon(new Date(Date.now() + 30_000).toISOString(), 300)).toBe(true);
    expect(isGeminiTokenExpiringSoon(new Date(Date.now() + 3600_000).toISOString(), 300)).toBe(false);
    expect(isGeminiTokenExpiringSoon(null, 300)).toBe(true);
  });

  it("returns a fresh active account without refreshing", async () => {
    const entry = pool.addOrUpdate(makeEntry({
      accessToken: "fresh-access",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }));
    const refresh = vi.fn();
    const manager = new GeminiTokenManager(pool, { refreshAccessToken: refresh });

    const account = await manager.ensureFreshAccount(entry.id);

    expect(account.accessToken).toBe("fresh-access");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes an expiring account and preserves the old refresh token when Google omits one", async () => {
    const entry = pool.addOrUpdate(makeEntry());
    const refresh = vi.fn(async () => ({
      access_token: "new-access",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid email",
    }));
    const manager = new GeminiTokenManager(pool, { refreshAccessToken: refresh });

    const account = await manager.ensureFreshAccount(entry.id);

    expect(refresh).toHaveBeenCalledWith("refresh-token");
    expect(account.accessToken).toBe("new-access");
    expect(account.refreshToken).toBe("refresh-token");
    expect(account.scope).toBe("openid email");
    expect(account.status).toBe("active");
    expect(account.lastRefreshSuccessAt).toBeTruthy();
    expect(saved[0].accessToken).toBe("new-access");
  });

  it("marks the account expired when refresh fails", async () => {
    const entry = pool.addOrUpdate(makeEntry());
    const refresh = vi.fn(async () => {
      throw new Error("invalid_grant");
    });
    const manager = new GeminiTokenManager(pool, { refreshAccessToken: refresh });

    await expect(manager.ensureFreshAccount(entry.id)).rejects.toThrow("invalid_grant");

    const account = pool.getEntry(entry.id);
    expect(account?.status).toBe("expired");
    expect(account?.lastRefreshFailureCode).toBe("invalid_grant");
    expect(account?.lastRefreshFailureAt).toBeTruthy();
  });
});
