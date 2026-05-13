import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GeminiAccountPool } from "@src/auth/gemini-account-pool.js";
import type { GeminiAccountEntry } from "@src/auth/gemini-types.js";
import { createGeminiAuthRoutes } from "@src/routes/gemini-auth.js";

vi.mock("@src/config.js", () => ({
  getConfig: () => ({
    server: { port: 8080 },
    gemini: {
      oauth_client_id: "client-test.apps.googleusercontent.com",
      oauth_client_secret: null,
      oauth_auth_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      oauth_token_endpoint: "https://oauth2.googleapis.com/token",
      oauth_userinfo_endpoint: "https://www.googleapis.com/oauth2/v2/userinfo",
      oauth_callback_host: "127.0.0.1",
      oauth_callback_path: "/oauth2callback",
      credentials_path: "~/.gemini/oauth_creds.json",
      project_id: "project-test",
      refresh_enabled: true,
      refresh_margin_seconds: 300,
    },
  }),
}));

function makeGeminiEntry(overrides: Partial<GeminiAccountEntry> = {}): GeminiAccountEntry {
  return {
    id: "gemini-1",
    email: "user@example.com",
    label: null,
    status: "active",
    accessToken: "secret-access",
    refreshToken: "secret-refresh",
    idToken: null,
    scope: "openid",
    tokenType: "Bearer",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    projectId: "project-test",
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

describe("Gemini auth routes", () => {
  let pool: GeminiAccountPool;
  let saved: GeminiAccountEntry[];
  let tempDir: string | null;
  const originalFetch = global.fetch;

  const fakeTokenManager = {
    ensureFreshAccount: vi.fn(async (id: string) => {
      const entry = pool.getEntry(id);
      if (!entry) throw new Error("missing account");
      pool.updateToken(id, {
        accessToken: "refreshed-access",
        refreshToken: entry.refreshToken,
        tokenType: "Bearer",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      return pool.getEntry(id)!;
    }),
  };
  const fakeTierFetcher = vi.fn(async () => ({
    userTier: "standard-tier",
    userTierName: "Standard",
    paidTier: { id: "standard-tier", name: "Standard" },
    googleAiSubscription: null,
    projectId: null,
    quota: null,
  }));

  beforeEach(() => {
    saved = [];
    tempDir = null;
    fakeTokenManager.ensureFreshAccount.mockClear();
    fakeTierFetcher.mockClear();
    pool = new GeminiAccountPool({
      load: () => saved,
      save: (entries) => {
        saved = structuredClone(entries);
      },
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("POST /auth/gemini/login-start returns authUrl and state", async () => {
    const app = createGeminiAuthRoutes(pool, undefined, fakeTierFetcher);
    const res = await app.request("/auth/gemini/login-start", { method: "POST" });
    const body = await res.json() as { authUrl: string; state: string };

    expect(res.status).toBe(200);
    expect(body.authUrl).toContain("accounts.google.com");
    expect(body.state).toMatch(/^[a-f0-9]+$/);
  });

  it("GET /auth/gemini/accounts masks tokens", async () => {
    pool.addOrUpdate(makeGeminiEntry({
      accessToken: "secret-access",
      refreshToken: "secret-refresh",
      googleAiSubscription: { tier: "Pro", source: "code-assist-paid-tier" },
    }));
    const app = createGeminiAuthRoutes(pool, undefined, fakeTierFetcher);
    const res = await app.request("/auth/gemini/accounts");
    const body = await res.json() as { accounts: Array<Record<string, unknown>> };

    expect(body.accounts[0].accessToken).toBeUndefined();
    expect(body.accounts[0].refreshToken).toBeUndefined();
    expect(body.accounts[0].hasRefreshToken).toBe(true);
    expect(body.accounts[0].googleAiSubscription).toEqual({
      tier: "Pro",
      source: "code-assist-paid-tier",
    });
  });

  it("POST /auth/gemini/code-relay succeeds when callback already completed", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "access-token",
        refresh_token: "refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/cloud-platform",
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        email: "gemini@example.com",
      }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    const app = createGeminiAuthRoutes(pool, undefined, fakeTierFetcher);
    const startRes = await app.request("/auth/gemini/login-start", { method: "POST" });
    const start = await startRes.json() as { state: string };
    const callbackUrl = `http://127.0.0.1:8080/oauth2callback?code=oauth-code&state=${start.state}`;

    const callbackRes = await app.request(`/oauth2callback?code=oauth-code&state=${start.state}`);
    expect(callbackRes.status).toBe(200);

    const relayRes = await app.request("/auth/gemini/code-relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callbackUrl }),
    });
    const relay = await relayRes.json() as { success?: boolean; alreadyCompleted?: boolean; error?: string };

    expect(relayRes.status).toBe(200);
    expect(relay.success).toBe(true);
    expect(relay.alreadyCompleted).toBe(true);
    expect(relay.error).toBeUndefined();
    expect(pool.getMaskedAccounts()).toHaveLength(1);
    expect(fakeTierFetcher).toHaveBeenCalledWith("access-token");
    expect(pool.getAll()[0].userTier).toBe("standard-tier");
    expect(pool.getAll()[0].userTierName).toBe("Standard");
  });

  it("stores Google AI subscription separately from Code Assist tier during health-check", async () => {
    fakeTierFetcher.mockResolvedValueOnce({
      projectId: "loaded-project",
      userTier: "standard-tier",
      userTierName: "Gemini Code Assist",
      paidTier: { id: "g1-ultra-tier", name: "Gemini Code Assist in Google One AI Ultra" },
      googleAiSubscription: {
        tier: "Ultra",
        source: "code-assist-paid-tier",
        raw: { id: "g1-ultra-tier", name: "Gemini Code Assist in Google One AI Ultra" },
      },
      quota: {
        modelBuckets: [
          { modelId: "gemini-3.1-pro", remainingFraction: 0.35, resetTime: "2026-05-11T12:00:00Z", remainingAmount: null, tokenType: null },
        ],
        raw: { buckets: [{ modelId: "gemini-3.1-pro", remainingFraction: 0.35 }] },
      },
    });
    const entry = pool.addOrUpdate(makeGeminiEntry({
      accessToken: "expired-access",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }));
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ email: "user@example.com" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

    const app = createGeminiAuthRoutes(pool, fakeTokenManager, fakeTierFetcher);
    const res = await app.request("/auth/gemini/accounts/health-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: entry.id }),
    });

    expect(res.status).toBe(200);
    const updated = pool.getEntry(entry.id);
    expect(updated?.userTier).toBe("standard-tier");
    expect(updated?.userTierName).toBe("Gemini Code Assist");
    expect(updated?.projectId).toBe("loaded-project");
    expect(updated?.googleAiSubscription).toEqual({
      tier: "Ultra",
      source: "code-assist-paid-tier",
      raw: { id: "g1-ultra-tier", name: "Gemini Code Assist in Google One AI Ultra" },
    });
    expect(updated?.quota?.modelBuckets?.[0]).toEqual({
      modelId: "gemini-3.1-pro",
      remainingFraction: 0.35,
      resetTime: "2026-05-11T12:00:00Z",
      remainingAmount: null,
      tokenType: null,
    });
  });

  it("health-check validates the refreshed Gemini access token", async () => {
    const entry = pool.addOrUpdate(makeGeminiEntry({
      accessToken: "expired-access",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }));
    global.fetch = vi.fn(async (_url, init) => {
      expect((init as RequestInit).headers).toEqual({
        Authorization: "Bearer refreshed-access",
      });
      return new Response(JSON.stringify({ email: "user@example.com" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const app = createGeminiAuthRoutes(pool, fakeTokenManager, fakeTierFetcher);
    const res = await app.request("/auth/gemini/accounts/health-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: entry.id }),
    });

    expect(res.status).toBe(200);
    expect(fakeTokenManager.ensureFreshAccount).toHaveBeenCalledWith(entry.id);
    expect(fakeTierFetcher).toHaveBeenCalledWith("refreshed-access");
    expect(pool.getEntry(entry.id)?.userTierName).toBe("Standard");
  });

  it("manual refresh uses the same token update behavior as the token manager", async () => {
    const entry = pool.addOrUpdate(makeGeminiEntry());
    fakeTierFetcher.mockResolvedValueOnce({
      userTier: "standard-tier",
      userTierName: "Gemini Code Assist",
      paidTier: { id: "g1-pro-tier", name: "Gemini Code Assist in Google One AI Pro" },
      googleAiSubscription: {
        tier: "Pro",
        source: "code-assist-paid-tier",
        raw: { id: "g1-pro-tier", name: "Gemini Code Assist in Google One AI Pro" },
      },
      projectId: null,
      quota: null,
    });
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      access_token: "manual-new-access",
      token_type: "Bearer",
      expires_in: 3600,
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    const app = createGeminiAuthRoutes(pool, undefined, fakeTierFetcher);
    const res = await app.request(`/auth/gemini/accounts/${entry.id}/refresh`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(pool.getEntry(entry.id)?.accessToken).toBe("manual-new-access");
    expect(pool.getEntry(entry.id)?.refreshToken).toBe("secret-refresh");
    expect(fakeTierFetcher).toHaveBeenCalledWith("manual-new-access");
    expect(pool.getEntry(entry.id)?.googleAiSubscription?.tier).toBe("Pro");
  });

  it("imports expired Gemini CLI credentials by refreshing before userinfo", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gemini-cli-creds-"));
    const credentialsPath = join(tempDir, "oauth_creds.json");
    writeFileSync(credentialsPath, JSON.stringify({
      tokens: {
        access_token: "expired-cli-access",
        refresh_token: "secret-refresh",
        token_type: "Bearer",
        scope: "openid",
      },
      expiry_date: Date.now() - 1000,
    }), "utf-8");

    const fetchMock = vi.fn(async (url, init) => {
      if (fetchMock.mock.calls.length === 1) {
        expect(String(url)).toBe("https://oauth2.googleapis.com/token");
        expect(String((init as RequestInit).body)).toContain("refresh_token=secret-refresh");
        return new Response(JSON.stringify({
          access_token: "imported-new-access",
          token_type: "Bearer",
          expires_in: 3600,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      expect(String(url)).toBe("https://www.googleapis.com/oauth2/v2/userinfo");
      expect((init as RequestInit).headers).toEqual({
        Authorization: "Bearer imported-new-access",
      });
      return new Response(JSON.stringify({ email: "cli@example.com" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const app = createGeminiAuthRoutes(pool, undefined, fakeTierFetcher);
    const res = await app.request("/auth/gemini/import-cli", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: credentialsPath }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pool.getAll()[0].email).toBe("cli@example.com");
    expect(pool.getAll()[0].accessToken).toBe("imported-new-access");
    expect(pool.getAll()[0].refreshToken).toBe("secret-refresh");
    expect(pool.getAll()[0].userTierName).toBe("Standard");
    expect(fakeTierFetcher).toHaveBeenCalledWith("imported-new-access");
  });
});
