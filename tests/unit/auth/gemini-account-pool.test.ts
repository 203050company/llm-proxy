import { describe, expect, it } from "vitest";
import { GeminiAccountPool } from "@src/auth/gemini-account-pool.js";
import type { GeminiAccountEntry } from "@src/auth/gemini-types.js";

function makeEntry(overrides: Partial<GeminiAccountEntry> = {}): GeminiAccountEntry {
  return {
    id: "gemini-1",
    email: "user@example.com",
    label: null,
    status: "active",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    idToken: "id-secret",
    scope: "openid https://www.googleapis.com/auth/cloud-platform",
    tokenType: "Bearer",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    projectId: "project-1",
    userTier: "STANDARD",
    userTierName: "Standard",
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

describe("GeminiAccountPool", () => {
  it("adds, updates, masks, and persists Gemini accounts by email", () => {
    let saved: GeminiAccountEntry[] = [];
    const pool = new GeminiAccountPool({
      load: () => saved,
      save: (entries) => {
        saved = structuredClone(entries);
      },
    });

    const added = pool.addOrUpdate(makeEntry());
    const updated = pool.addOrUpdate(makeEntry({
      id: "ignored-new-id",
      label: "Work",
      accessToken: "access-new",
      refreshToken: "refresh-new",
    }));

    expect(updated.id).toBe(added.id);
    expect(pool.getAll()).toHaveLength(1);
    expect(saved).toHaveLength(1);
    expect(saved[0].accessToken).toBe("access-new");

    const masked = pool.getMaskedAccounts()[0];
    expect(masked.email).toBe("user@example.com");
    expect(masked.accessToken).toBeUndefined();
    expect(masked.refreshToken).toBeUndefined();
    expect(masked.hasRefreshToken).toBe(true);
  });

  it("persists and masks the normalized Google AI subscription field", () => {
    let saved: GeminiAccountEntry[] = [];
    const pool = new GeminiAccountPool({
      load: () => saved,
      save: (entries) => {
        saved = structuredClone(entries);
      },
    });

    pool.addOrUpdate(makeEntry({
      googleAiSubscription: { tier: "Ultra", source: "code-assist-paid-tier" },
      userTier: "standard-tier",
      userTierName: "Gemini Code Assist",
      paidTier: { id: "g1-ultra-tier", name: "Gemini Code Assist in Google One AI Ultra" },
    }));

    expect(saved[0].googleAiSubscription).toEqual({
      tier: "Ultra",
      source: "code-assist-paid-tier",
    });
    expect(pool.getMaskedAccounts()[0].googleAiSubscription).toEqual({
      tier: "Ultra",
      source: "code-assist-paid-tier",
    });
  });

  it("records usage per model", () => {
    const pool = new GeminiAccountPool({
      load: () => [makeEntry()],
      save: () => {},
    });

    pool.recordUsage("gemini-1", "gemini-3.1-pro", { input_tokens: 11, output_tokens: 7 });
    const entry = pool.getEntry("gemini-1")!;

    expect(entry.usage.input_tokens).toBe(11);
    expect(entry.usage.output_tokens).toBe(7);
    expect(entry.usage.request_count).toBe(1);
    expect(entry.usage.models["gemini-3.1-pro"]).toEqual({
      input_tokens: 11,
      output_tokens: 7,
      request_count: 1,
    });
  });

  it("does not select free-tier Pro buckets that Code Assist reports as unavailable", () => {
    const paid = makeEntry({
      id: "paid",
      email: "paid@example.com",
      lastUsedAt: "2026-05-11T00:00:00.000Z",
      models: ["gemini-3.1-pro", "gemini-3.1-flash-lite"],
      quota: {
        modelBuckets: [
          { modelId: "gemini-3.1-pro-preview", remainingFraction: 0.5, resetTime: "2026-05-12T00:00:00Z", remainingAmount: null, tokenType: "REQUESTS" },
          { modelId: "gemini-3.1-flash-lite-preview", remainingFraction: 0.5, resetTime: "2026-05-12T00:00:00Z", remainingAmount: null, tokenType: "REQUESTS" },
        ],
      },
    });
    const free = makeEntry({
      id: "free",
      email: "free@example.com",
      models: ["gemini-3.1-pro", "gemini-3.1-flash-lite"],
      quota: {
        modelBuckets: [
          { modelId: "gemini-3.1-pro-preview", remainingFraction: 0, resetTime: "1970-01-01T00:00:00Z", remainingAmount: null, tokenType: "REQUESTS" },
          { modelId: "gemini-3.1-flash-lite-preview", remainingFraction: 1, resetTime: "2026-05-12T00:00:00Z", remainingAmount: null, tokenType: "REQUESTS" },
        ],
      },
    });
    const pool = new GeminiAccountPool({
      load: () => [paid, free],
      save: () => {},
    });

    expect(pool.hasActiveModel("gemini-3.1-pro")).toBe(true);
    expect(pool.pickAccountForModel("gemini-3.1-pro")?.id).toBe("paid");
    expect(pool.pickAccountForModel("gemini-3.1-flash-lite")?.id).toBe("free");
  });

  it("keeps the earliest never-used Gemini account before used accounts", () => {
    const first = makeEntry({ id: "first", email: "first@example.com", lastUsedAt: null });
    const second = makeEntry({ id: "second", email: "second@example.com", lastUsedAt: "2026-05-11T00:00:00.000Z" });
    const pool = new GeminiAccountPool({
      load: () => [first, second],
      save: () => {},
    });

    expect(pool.pickAccountForModel("gemini-3.1-pro")?.id).toBe("first");
  });

  it("skips only the rate-limited account/model pair while the limit is active", () => {
    const until = new Date(Date.now() + 60_000).toISOString();
    const first = makeEntry({
      id: "first",
      email: "first@example.com",
      models: ["gemini-3.1-pro", "gemini-3-pro"],
      modelRateLimits: {
        "gemini-3.1-pro": { until, reason: "capacity", lastStatus: 429 },
      },
    });
    const second = makeEntry({
      id: "second",
      email: "second@example.com",
      models: ["gemini-3.1-pro", "gemini-3-pro"],
    });
    const pool = new GeminiAccountPool({
      load: () => [first, second],
      save: () => {},
    });

    expect(pool.pickAccountForModel("gemini-3.1-pro")?.id).toBe("second");
    expect(pool.pickAccountForModel("gemini-3-pro")?.id).toBe("first");
  });

  it("automatically clears expired model rate limits before picking an account", () => {
    let saved: GeminiAccountEntry[] = [];
    const expired = new Date(Date.now() - 1_000).toISOString();
    const pool = new GeminiAccountPool({
      load: () => [
        makeEntry({
          id: "first",
          email: "first@example.com",
          modelRateLimits: {
            "gemini-3.1-pro": { until: expired, reason: "capacity", lastStatus: 429 },
          },
        }),
      ],
      save: (entries) => { saved = structuredClone(entries); },
    });

    expect(pool.pickAccountForModel("gemini-3.1-pro")?.id).toBe("first");
    expect(pool.getEntry("first")?.modelRateLimits).toEqual({});
    expect(saved.at(-1)?.modelRateLimits).toEqual({});
  });
});
