import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { GeminiAccountPool } from "@src/auth/gemini-account-pool.js";
import type { GeminiAccountEntry } from "@src/auth/gemini-types.js";
import { GeminiCliAuthService } from "@src/services/gemini-cli-auth.js";

function makeEntry(overrides: Partial<GeminiAccountEntry> = {}): GeminiAccountEntry {
  return {
    id: "free",
    email: "free@example.com",
    label: null,
    status: "active",
    accessToken: "free-access",
    refreshToken: "free-refresh",
    idToken: null,
    scope: "openid",
    tokenType: "Bearer",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    projectId: "project-1",
    userTier: "free-tier",
    userTierName: "Free",
    paidTier: null,
    googleAiSubscription: { tier: "Free", source: "code-assist-free-tier" },
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

describe("GeminiCliAuthService", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("applies the default CLI account by preferring paid Gemini accounts", () => {
    tempDir = mkdtempSync(resolve(tmpdir(), "gemini-cli-auth-"));
    const pool = new GeminiAccountPool({
      load: () => [
        makeEntry(),
        makeEntry({
          id: "paid",
          email: "paid@example.com",
          accessToken: "paid-access",
          refreshToken: "paid-refresh",
          userTier: "pro-tier",
          userTierName: "Pro",
          paidTier: { id: "g1-pro-tier" },
          googleAiSubscription: { tier: "Pro", source: "code-assist-paid-tier" },
        }),
      ],
      save: () => {},
    });
    const service = new GeminiCliAuthService(pool, resolve(tempDir, "oauth_creds.json"));

    const result = service.applyDefaultAccount();

    expect(result.accountId).toBe("paid");
    expect(result.email).toBe("paid@example.com");
    expect(service.getStatus().matchedEntryId).toBe("paid");
  });
});
