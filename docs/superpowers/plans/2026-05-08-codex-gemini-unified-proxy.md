# LLM-Proxy Gemini CLI OAuth Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Gemini CLI-compatible Google OAuth and Code Assist support into `codex-proxy`, expose it in the dashboard as `LLM-Proxy`, and keep Codex, Gemini OAuth, and runtime API-key providers independently manageable.

**Architecture:** Codex remains on the existing `AccountPool` and Codex upstream path. Gemini OAuth gets a new account pool, OAuth service, Code Assist upstream adapter, and dashboard sections. Shared surfaces such as usage stats and proxy assignment use provider-namespaced account IDs so Codex and Gemini cannot collide.

**Tech Stack:** TypeScript, Hono, Preact, Vitest, existing YAML config loader, existing TLS transport abstraction, Google OAuth HTTP endpoints, Gemini Code Assist HTTP/SSE endpoints.

---

## Scope Check

This is a large multi-subsystem feature. Execute it in the task order below. Each task produces a testable checkpoint and a commit. Do not batch the whole plan into one implementation pass.

The plan intentionally fixes the Codex OAuth native transport failure first because the user reported account-add failures and the dashboard must not regress while Gemini is added.

## File Structure

Create:

- `src/auth/gemini-types.ts`: Gemini account, token, quota, and masked DTO types.
- `src/auth/gemini-account-pool.ts`: Gemini OAuth account persistence, masking, status mutation, usage mutation.
- `src/auth/gemini-oauth.ts`: Gemini CLI-compatible OAuth PKCE, CLI credential import, token refresh, user info fetch.
- `src/routes/gemini-auth.ts`: Gemini account/login/import/refresh routes.
- `src/proxy/gemini-code-assist-upstream.ts`: OAuth-backed Code Assist upstream adapter.
- `src/translation/codex-request-to-code-assist.ts`: Codex request to Code Assist request conversion.
- `src/translation/code-assist-to-codex.ts`: Code Assist response/SSE conversion helpers.
- `shared/hooks/use-gemini-accounts.ts`: dashboard hook for Gemini accounts.
- `web/src/components/ProviderAccountSections.tsx`: section wrapper for Codex and Gemini account lists.
- `web/src/components/GeminiAccountList.tsx`: Gemini account management UI.
- `web/src/components/GeminiSettings.tsx`: Gemini OAuth, Code Assist, refresh, routing, and connection test settings.
- Tests under `tests/unit/auth`, `tests/unit/routes`, `tests/unit/proxy`, `tests/unit/translation`, and `tests/unit/web`.

Modify:

- `src/tls/curl-fetch.ts`: add OAuth-safe Node fetch fallback for the native-addon-missing dummy response.
- `src/auth/oauth-pkce.ts`: use the fallback option for Codex OAuth token exchange and refresh.
- `src/config-schema.ts`: add Gemini OAuth/Code Assist/routing settings.
- `src/index.ts`: instantiate Gemini pool, Gemini routes, Gemini upstream routing, usage recovery.
- `src/proxy/upstream-router.ts`: add Gemini OAuth route match.
- `src/routes/chat.ts`, `src/routes/messages.ts`, `src/routes/gemini.ts`, `src/routes/responses.ts`: route direct Gemini OAuth matches through the shared direct handler.
- `src/routes/proxies.ts`: return and assign namespaced Codex/Gemini account IDs.
- `src/routes/admin/usage-stats.ts` and `src/auth/usage-stats.ts`: include provider/model/source metadata and Gemini accounts.
- `src/routes/admin/settings.ts`: expose Gemini settings.
- `src/routes/web.ts`: pass Gemini pool/settings to admin web routes as needed.
- `web/src/App.tsx`: use provider chooser and render provider sections.
- `web/src/components/Header.tsx`: title becomes `LLM-Proxy`.
- `web/src/components/AddAccount.tsx`: provider chooser and provider-specific callback relay.
- `web/src/components/AccountList.tsx`: keep Codex-specific list behavior.
- `web/src/components/ApiKeyManager.tsx`: section API keys by provider and explain persisted Gemini API key rows.
- `web/src/pages/AccountManagement.tsx`, `web/src/pages/ProxySettings.tsx`, `web/src/pages/UsageStats.tsx`: provider-sectioned data.
- `web/src/components/SettingsTab.tsx`: include `GeminiSettings`.
- `shared/i18n/translations.ts`: add Gemini/UI labels.

---

### Task 1: Fix Codex OAuth Native Addon Failure

**Files:**
- Modify: `src/tls/curl-fetch.ts`
- Modify: `src/auth/oauth-pkce.ts`
- Test: `tests/unit/tls/curl-fetch-native-fallback.test.ts`
- Test: `tests/unit/auth/oauth-pkce-native-fallback.test.ts`

- [ ] **Step 1: Write failing curl-fetch fallback test**

Create `tests/unit/tls/curl-fetch-native-fallback.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { curlFetchPost } from "@src/tls/curl-fetch.js";
import type { TlsTransport } from "@src/tls/transport.js";

function makeTransport(): TlsTransport {
  return {
    isImpersonate: () => false,
    post: vi.fn(),
    get: vi.fn(),
    simplePost: vi.fn(async () => ({
      status: 500,
      body: '{"error":"Native addon not found"}',
    })),
  } as unknown as TlsTransport;
}

describe("curlFetchPost native addon fallback", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn(async () => new Response(
      JSON.stringify({ access_token: "at_test", token_type: "Bearer" }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("falls back to Node fetch only when explicitly enabled and native addon is missing", async () => {
    const resp = await curlFetchPost(
      "https://auth.example.test/token",
      "application/x-www-form-urlencoded",
      "grant_type=authorization_code",
      { transport: makeTransport(), fallbackToFetchOnNativeAddonMissing: true },
    );

    expect(resp).toEqual({
      status: 200,
      ok: true,
      body: '{"access_token":"at_test","token_type":"Bearer"}',
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://auth.example.test/token",
      expect.objectContaining({
        method: "POST",
        body: "grant_type=authorization_code",
      }),
    );
  });

  it("does not fall back unless the option is enabled", async () => {
    const resp = await curlFetchPost(
      "https://auth.example.test/token",
      "application/x-www-form-urlencoded",
      "grant_type=authorization_code",
      { transport: makeTransport() },
    );

    expect(resp.status).toBe(500);
    expect(resp.body).toBe('{"error":"Native addon not found"}');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run fallback test and verify it fails**

Run:

```bash
npm test -- tests/unit/tls/curl-fetch-native-fallback.test.ts
```

Expected: FAIL with a TypeScript error or assertion failure because `fallbackToFetchOnNativeAddonMissing` does not exist and no fallback is implemented.

- [ ] **Step 3: Implement fallback option in `src/tls/curl-fetch.ts`**

Add the option and helper functions:

```ts
export interface CurlFetchOptions {
  /** Proxy override: undefined = global default, null = direct, string = specific. */
  proxyUrl?: string | null;
  /** Injected transport (skip singleton). */
  transport?: TlsTransport;
  /** OAuth-safe fallback for local dev/Linux when native/index.js is a dummy shim. */
  fallbackToFetchOnNativeAddonMissing?: boolean;
}

function isNativeAddonMissing(result: { status: number; body: string }): boolean {
  if (result.status !== 500) return false;
  try {
    const parsed = JSON.parse(result.body) as { error?: unknown };
    return parsed.error === "Native addon not found";
  } catch {
    return result.body.includes("Native addon not found");
  }
}

async function fetchPost(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<CurlFetchResponse> {
  const response = await fetch(url, { method: "POST", headers, body });
  const text = await response.text();
  return { status: response.status, body: text, ok: response.ok };
}
```

Then change `curlFetchPost` so it falls back only for that exact dummy response:

```ts
  const result = await transport.simplePost(url, headers, body, 30, options?.proxyUrl);
  if (options?.fallbackToFetchOnNativeAddonMissing && isNativeAddonMissing(result)) {
    return fetchPost(url, headers, body);
  }
  return {
    status: result.status,
    body: result.body,
    ok: result.status >= 200 && result.status < 300,
  };
```

- [ ] **Step 4: Update Codex OAuth to enable fallback**

In `src/auth/oauth-pkce.ts`, update both token exchange and refresh calls:

```ts
curlFetchPost(
  config.auth.oauth_token_endpoint,
  "application/x-www-form-urlencoded",
  body.toString(),
  { proxyUrl, fallbackToFetchOnNativeAddonMissing: true },
)
```

and:

```ts
curlFetchPost(
  config.auth.oauth_token_endpoint,
  "application/x-www-form-urlencoded",
  body.toString(),
  { proxyUrl, fallbackToFetchOnNativeAddonMissing: true },
)
```

- [ ] **Step 5: Write OAuth regression test**

Create `tests/unit/auth/oauth-pkce-native-fallback.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@src/config.js", () => ({
  getConfig: () => ({
    auth: {
      oauth_client_id: "app_test",
      oauth_token_endpoint: "https://auth.example.test/token",
    },
    tls: { proxy_url: null, force_http11: false },
  }),
}));

vi.mock("@src/tls/direct-fallback.js", () => ({
  withDirectFallback: async (fn: (proxyUrl: string | null | undefined) => Promise<unknown>) => fn(null),
  isCloudflareChallengeResponse: () => false,
  isProxyNetworkError: () => false,
  isSafeToRetryRefresh: () => false,
}));

const curlFetchPost = vi.fn(async () => ({
  ok: true,
  status: 200,
  body: JSON.stringify({ access_token: "at_test", refresh_token: "rt_test", token_type: "Bearer" }),
}));

vi.mock("@src/tls/curl-fetch.js", () => ({ curlFetchPost }));
vi.mock("@src/tls/proxy.js", () => ({ getProxyUrl: () => null }));

describe("Codex OAuth native fallback option", () => {
  beforeEach(() => curlFetchPost.mockClear());

  it("passes fallbackToFetchOnNativeAddonMissing during code exchange", async () => {
    const { exchangeCode } = await import("@src/auth/oauth-pkce.js");
    await exchangeCode("code_test", "verifier_test", "http://localhost:1455/auth/callback");

    expect(curlFetchPost).toHaveBeenCalledWith(
      "https://auth.example.test/token",
      "application/x-www-form-urlencoded",
      expect.stringContaining("grant_type=authorization_code"),
      expect.objectContaining({ proxyUrl: null, fallbackToFetchOnNativeAddonMissing: true }),
    );
  });
});
```

- [ ] **Step 6: Run tests and commit**

Run:

```bash
npm test -- tests/unit/tls/curl-fetch-native-fallback.test.ts tests/unit/auth/oauth-pkce-native-fallback.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/tls/curl-fetch.ts src/auth/oauth-pkce.ts tests/unit/tls/curl-fetch-native-fallback.test.ts tests/unit/auth/oauth-pkce-native-fallback.test.ts
git commit -m "fix: fall back from dummy native transport for OAuth"
```

---

### Task 2: Add Gemini Account Types and Persistence

**Files:**
- Create: `src/auth/gemini-types.ts`
- Create: `src/auth/gemini-account-pool.ts`
- Test: `tests/unit/auth/gemini-account-pool.test.ts`

- [ ] **Step 1: Write failing Gemini account pool tests**

Create `tests/unit/auth/gemini-account-pool.test.ts`:

```ts
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
      save: (entries) => { saved = structuredClone(entries); },
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
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
npm test -- tests/unit/auth/gemini-account-pool.test.ts
```

Expected: FAIL because Gemini account files do not exist.

- [ ] **Step 3: Create `src/auth/gemini-types.ts`**

```ts
export type GeminiAccountStatus =
  | "active"
  | "expired"
  | "refreshing"
  | "rate_limited"
  | "quota_exhausted"
  | "disabled"
  | "error";

export interface GeminiModelUsage {
  input_tokens: number;
  output_tokens: number;
  request_count: number;
}

export interface GeminiUsageTotals extends GeminiModelUsage {
  models: Record<string, GeminiModelUsage>;
}

export interface GeminiQuotaCredit {
  creditType: string;
  creditAmount: string;
}

export interface GeminiQuotaSnapshot {
  remainingCredits?: GeminiQuotaCredit[];
  consumedCredits?: GeminiQuotaCredit[];
  raw?: unknown;
}

export interface GeminiAccountEntry {
  id: string;
  email: string;
  label: string | null;
  status: GeminiAccountStatus;
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  scope: string | null;
  tokenType: string;
  expiresAt: string | null;
  projectId: string | null;
  userTier: string | null;
  userTierName: string | null;
  paidTier: unknown | null;
  quota: GeminiQuotaSnapshot | null;
  quotaFetchedAt: string | null;
  lastUsedAt: string | null;
  lastRefreshSuccessAt: string | null;
  lastRefreshFailureAt: string | null;
  lastRefreshFailureCode: string | null;
  usage: GeminiUsageTotals;
  models: string[];
}

export type GeminiAccountSafe = Omit<
  GeminiAccountEntry,
  "accessToken" | "refreshToken" | "idToken"
> & {
  hasRefreshToken: boolean;
  accessTokenMasked: string;
};

export interface GeminiAccountPersistence {
  load(): GeminiAccountEntry[];
  save(entries: GeminiAccountEntry[]): void;
}
```

- [ ] **Step 4: Create `src/auth/gemini-account-pool.ts`**

Implement these public methods:

```ts
export class GeminiAccountPool {
  constructor(persistence?: GeminiAccountPersistence);
  getAll(): GeminiAccountEntry[];
  getEntry(id: string): GeminiAccountEntry | undefined;
  getMaskedAccounts(): GeminiAccountSafe[];
  getActiveAccounts(): GeminiAccountEntry[];
  addOrUpdate(entry: GeminiAccountEntry): GeminiAccountEntry;
  remove(id: string): boolean;
  setStatus(id: string, status: GeminiAccountStatus, failureCode?: string | null): boolean;
  setLabel(id: string, label: string | null): boolean;
  updateToken(id: string, token: Partial<Pick<GeminiAccountEntry, "accessToken" | "refreshToken" | "idToken" | "expiresAt" | "scope" | "tokenType">>): boolean;
  updateSetup(id: string, setup: Partial<Pick<GeminiAccountEntry, "projectId" | "userTier" | "userTierName" | "paidTier" | "models">>): boolean;
  updateQuota(id: string, quota: GeminiQuotaSnapshot): boolean;
  recordUsage(id: string, model: string, usage: { input_tokens?: number; output_tokens?: number }): void;
  persistNow(): void;
}
```

Use `data/gemini-accounts.json` for filesystem persistence. Match the existing atomic temp-file pattern from `src/auth/api-key-pool.ts`.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm test -- tests/unit/auth/gemini-account-pool.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/auth/gemini-types.ts src/auth/gemini-account-pool.ts tests/unit/auth/gemini-account-pool.test.ts
git commit -m "feat: add Gemini account persistence"
```

---

### Task 3: Add Gemini OAuth and CLI Credential Import

**Files:**
- Create: `src/auth/gemini-oauth.ts`
- Create: `src/routes/gemini-auth.ts`
- Modify: `src/index.ts`
- Modify: `src/config-schema.ts`
- Test: `tests/unit/auth/gemini-oauth.test.ts`
- Test: `tests/unit/routes/gemini-auth.test.ts`

- [ ] **Step 1: Extend config schema for Gemini**

In `src/config-schema.ts`, add a top-level `gemini` object:

```ts
  gemini: z.object({
    oauth_enabled: z.boolean().default(true),
    oauth_client_id: z.string().default(""),
    oauth_client_secret: z.string().nullable().default(null),
    oauth_auth_endpoint: z.string().default("https://accounts.google.com/o/oauth2/v2/auth"),
    oauth_token_endpoint: z.string().default("https://oauth2.googleapis.com/token"),
    oauth_userinfo_endpoint: z.string().default("https://www.googleapis.com/oauth2/v2/userinfo"),
    oauth_callback_host: z.string().default("127.0.0.1"),
    oauth_callback_path: z.string().default("/oauth2callback"),
    credentials_path: z.string().default("~/.gemini/oauth_creds.json"),
    code_assist_endpoint: z.string().default("https://cloudcode-pa.googleapis.com"),
    code_assist_api_version: z.string().default("v1internal"),
    project_id: z.string().nullable().default(null),
    refresh_enabled: z.boolean().default(true),
    refresh_margin_seconds: z.number().min(0).default(300),
    refresh_concurrency: z.number().int().min(1).default(2),
    api_key_priority: z.enum(["api_key", "oauth"]).default("api_key"),
    routing: z.object({
      opus: z.string().default("gemini-3.1-pro"),
      sonnet: z.string().default("gemini-3-pro"),
      haiku: z.string().default("gemini-3.1-flash-lite"),
      failover: z.record(z.array(z.string())).default({
        "gemini-3.1-pro": ["gemini-3-pro", "gemini-3.1-flash-lite"],
        "gemini-3-pro": ["gemini-3.1-flash-lite"],
      }),
    }).default({}),
  }).default({}),
```

- [ ] **Step 2: Write OAuth unit tests**

Create `tests/unit/auth/gemini-oauth.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@src/config.js", () => ({
  getConfig: () => ({
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
    },
  }),
}));

describe("gemini oauth", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const textUrl = String(url);
      if (textUrl.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({
          access_token: "access-test",
          refresh_token: "refresh-test",
          id_token: "id-test",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid https://www.googleapis.com/auth/cloud-platform",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (textUrl.includes("oauth2/v2/userinfo")) {
        return new Response(JSON.stringify({ email: "user@example.com" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.resetModules();
  });

  it("builds a Google OAuth URL with Gemini CLI scopes", async () => {
    const { createGeminiOAuthSession } = await import("@src/auth/gemini-oauth.js");
    const session = createGeminiOAuthSession("localhost:8080");
    const url = new URL(session.authUrl);

    expect(url.hostname).toBe("accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("client-test.apps.googleusercontent.com");
    expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/cloud-platform");
    expect(url.searchParams.get("access_type")).toBe("offline");
  });

  it("exchanges an auth code and fetches user info", async () => {
    const { createGeminiOAuthSession, exchangeGeminiCode } = await import("@src/auth/gemini-oauth.js");
    const session = createGeminiOAuthSession("localhost:8080");
    const tokens = await exchangeGeminiCode("code-test", session.codeVerifier, session.redirectUri);

    expect(tokens.access_token).toBe("access-test");
    expect(tokens.refresh_token).toBe("refresh-test");
  });
});
```

- [ ] **Step 3: Create `src/auth/gemini-oauth.ts`**

Implement:

```ts
export interface GeminiOAuthSession {
  state: string;
  authUrl: string;
  codeVerifier: string;
  redirectUri: string;
  returnHost: string;
  createdAt: number;
}

export interface GeminiTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
}

export function createGeminiOAuthSession(returnHost: string): GeminiOAuthSession;
export function tryAcquireGeminiSession(state: string): GeminiOAuthSession | null;
export function releaseGeminiSession(state: string): void;
export function deleteGeminiSession(state: string): void;
export async function exchangeGeminiCode(code: string, codeVerifier: string, redirectUri: string): Promise<GeminiTokenResponse>;
export async function refreshGeminiAccessToken(refreshToken: string): Promise<GeminiTokenResponse>;
export async function fetchGeminiUserInfo(accessToken: string): Promise<{ email: string }>;
export async function importGeminiCliCredentials(filePath?: string): Promise<GeminiTokenResponse>;
```

Use PKCE S256 via `crypto.createHash("sha256")` and `randomBytes`.

Build the auth URL with:

```ts
const scopes = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "openid",
];
```

Token exchange request body:

```ts
const body = new URLSearchParams({
  grant_type: "authorization_code",
  code,
  redirect_uri: redirectUri,
  code_verifier: codeVerifier,
  client_id: config.gemini.oauth_client_id,
});
if (config.gemini.oauth_client_secret) {
  body.set("client_secret", config.gemini.oauth_client_secret);
}
```

- [ ] **Step 4: Write route tests**

Create `tests/unit/routes/gemini-auth.test.ts` with an in-memory `GeminiAccountPool`. Test:

```ts
it("POST /auth/gemini/login-start returns authUrl and state", async () => {
  const res = await app.request("/auth/gemini/login-start", { method: "POST" });
  const body = await res.json() as { authUrl: string; state: string };
  expect(res.status).toBe(200);
  expect(body.authUrl).toContain("accounts.google.com");
  expect(body.state).toMatch(/^[a-f0-9]+$/);
});

it("GET /auth/gemini/accounts masks tokens", async () => {
  pool.addOrUpdate(makeGeminiEntry({ accessToken: "secret-access", refreshToken: "secret-refresh" }));
  const res = await app.request("/auth/gemini/accounts");
  const body = await res.json() as { accounts: Array<Record<string, unknown>> };
  expect(body.accounts[0].accessToken).toBeUndefined();
  expect(body.accounts[0].refreshToken).toBeUndefined();
  expect(body.accounts[0].hasRefreshToken).toBe(true);
});
```

- [ ] **Step 5: Create `src/routes/gemini-auth.ts`**

Route factory signature:

```ts
export function createGeminiAuthRoutes(pool: GeminiAccountPool): Hono;
```

Implement these routes:

- `POST /auth/gemini/login-start`
- `POST /auth/gemini/code-relay`
- `GET /auth/gemini/callback`
- `POST /auth/gemini/import-cli`
- `GET /auth/gemini/accounts`
- `DELETE /auth/gemini/accounts/:id`
- `POST /auth/gemini/accounts/:id/refresh`
- `POST /auth/gemini/accounts/health-check`

For route-created accounts, create `GeminiAccountEntry` with `email`, tokens, expiry, `projectId` from config if available, and default models:

```ts
models: ["gemini-3.1-pro", "gemini-3-pro", "gemini-3.1-flash-lite"]
```

- [ ] **Step 6: Mount routes and commit**

In `src/index.ts`:

```ts
const geminiAccountPool = new GeminiAccountPool();
const geminiAuthRoutes = createGeminiAuthRoutes(geminiAccountPool);
app.route("/", geminiAuthRoutes);
```

Run:

```bash
npm test -- tests/unit/auth/gemini-oauth.test.ts tests/unit/routes/gemini-auth.test.ts
npm run build
```

Expected: PASS.

Commit:

```bash
git add src/config-schema.ts src/auth/gemini-oauth.ts src/routes/gemini-auth.ts src/index.ts tests/unit/auth/gemini-oauth.test.ts tests/unit/routes/gemini-auth.test.ts
git commit -m "feat: add Gemini CLI OAuth account routes"
```

---

### Task 4: Add Gemini Code Assist Translation and Upstream Adapter

**Files:**
- Create: `src/translation/codex-request-to-code-assist.ts`
- Create: `src/translation/code-assist-to-codex.ts`
- Create: `src/proxy/gemini-code-assist-upstream.ts`
- Test: `tests/unit/translation/code-assist-translation.test.ts`
- Test: `tests/unit/proxy/gemini-code-assist-upstream.test.ts`

- [ ] **Step 1: Write translation tests**

Create `tests/unit/translation/code-assist-translation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { translateCodexToCodeAssistRequest, extractCodeAssistUsage } from "@src/translation/codex-request-to-code-assist.js";
import type { CodexResponsesRequest } from "@src/proxy/codex-types.js";

describe("Code Assist translation", () => {
  it("wraps a Codex request in Code Assist generateContent shape", () => {
    const req: CodexResponsesRequest = {
      model: "gemini-3.1-pro",
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
      stream: true,
    };

    const out = translateCodexToCodeAssistRequest(req, {
      projectId: "project-1",
      sessionId: "session-1",
      userPromptId: "prompt-1",
    });

    expect(out.model).toBe("gemini-3.1-pro");
    expect(out.project).toBe("project-1");
    expect(out.user_prompt_id).toBe("prompt-1");
    expect(out.request.session_id).toBe("session-1");
    expect(out.request.contents[0].role).toBe("user");
  });

  it("extracts usage metadata from Code Assist responses", () => {
    expect(extractCodeAssistUsage({
      response: {
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5 },
      },
    })).toEqual({ input_tokens: 3, output_tokens: 5 });
  });
});
```

- [ ] **Step 2: Implement Code Assist request translator**

Create `src/translation/codex-request-to-code-assist.ts`:

```ts
import type { CodexResponsesRequest } from "../proxy/codex-types.js";
import { translateCodexToGeminiRequest } from "./codex-request-to-gemini.js";

export interface CodeAssistContext {
  projectId: string | null;
  sessionId: string;
  userPromptId: string;
}

export interface CodeAssistGenerateContentRequest {
  model: string;
  project: string | null;
  user_prompt_id: string;
  request: Record<string, unknown>;
  enabled_credit_types?: string[];
}

export function translateCodexToCodeAssistRequest(
  req: CodexResponsesRequest,
  context: CodeAssistContext,
): CodeAssistGenerateContentRequest {
  const geminiRequest = translateCodexToGeminiRequest(req) as Record<string, unknown>;
  return {
    model: req.model,
    project: context.projectId,
    user_prompt_id: context.userPromptId,
    request: {
      ...geminiRequest,
      session_id: context.sessionId,
    },
  };
}

export function extractCodeAssistUsage(payload: unknown): { input_tokens: number; output_tokens: number } {
  const record = typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : {};
  const response = typeof record.response === "object" && record.response !== null ? record.response as Record<string, unknown> : {};
  const usage = typeof response.usageMetadata === "object" && response.usageMetadata !== null
    ? response.usageMetadata as Record<string, unknown>
    : {};
  return {
    input_tokens: typeof usage.promptTokenCount === "number" ? usage.promptTokenCount : 0,
    output_tokens: typeof usage.candidatesTokenCount === "number" ? usage.candidatesTokenCount : 0,
  };
}
```

- [ ] **Step 3: Implement Code Assist response helper**

Create `src/translation/code-assist-to-codex.ts` with:

```ts
export function unwrapCodeAssistResponse(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const record = payload as Record<string, unknown>;
  return record.response ?? payload;
}
```

The upstream adapter will feed this unwrapped Gemini-like response into the same event-shaping logic currently used by `GeminiUpstream`.

- [ ] **Step 4: Write upstream adapter tests**

Create `tests/unit/proxy/gemini-code-assist-upstream.test.ts`:

```ts
import { describe, expect, it, vi, afterEach } from "vitest";
import { GeminiCodeAssistUpstream } from "@src/proxy/gemini-code-assist-upstream.js";
import type { GeminiAccountEntry } from "@src/auth/gemini-types.js";

function account(): GeminiAccountEntry {
  return {
    id: "g1",
    email: "user@example.com",
    label: null,
    status: "active",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    idToken: null,
    scope: "openid",
    tokenType: "Bearer",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    projectId: "project-1",
    userTier: "STANDARD",
    userTierName: "Standard",
    paidTier: null,
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

describe("GeminiCodeAssistUpstream", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts to Code Assist streamGenerateContent with bearer auth", async () => {
    const fetchMock = vi.fn(async () => new Response(
      'data: {"response":{"candidates":[],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":2}}}\\n\\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    global.fetch = fetchMock as unknown as typeof fetch;

    const upstream = new GeminiCodeAssistUpstream({
      account: account(),
      endpoint: "https://cloudcode-pa.googleapis.com",
      apiVersion: "v1internal",
      onUsage: vi.fn(),
    });

    await upstream.createResponse({
      model: "gemini-3.1-pro",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: true,
    }, new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer access-token" }),
      }),
    );
  });
});
```

- [ ] **Step 5: Implement `GeminiCodeAssistUpstream`**

Create constructor:

```ts
export interface GeminiCodeAssistOptions {
  account: GeminiAccountEntry;
  endpoint: string;
  apiVersion: string;
  onUsage?: (accountId: string, model: string, usage: { input_tokens: number; output_tokens: number }) => void;
}
```

Implement `UpstreamAdapter`:

```ts
export class GeminiCodeAssistUpstream implements UpstreamAdapter {
  readonly tag = "gemini-oauth" as const;

  constructor(private readonly options: GeminiCodeAssistOptions) {}

  async createResponse(req: CodexResponsesRequest, signal: AbortSignal): Promise<Response> {
    const url = `${this.options.endpoint.replace(/\/+$/, "")}/${this.options.apiVersion}:streamGenerateContent?alt=sse`;
    const body = translateCodexToCodeAssistRequest(req, {
      projectId: this.options.account.projectId,
      sessionId: `llm-proxy-${this.options.account.id}`,
      userPromptId: randomUUID(),
    });
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `${this.options.account.tokenType || "Bearer"} ${this.options.account.accessToken}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => `HTTP ${response.status}`);
      throw new CodexApiError(response.status, text);
    }
    return response;
  }
}
```

Implement `parseStream` by parsing `data:` SSE lines, unwrapping `payload.response`, emitting `response.created`, text deltas, function calls if present, and `response.completed` with usage. Use the parsing pattern from `src/proxy/gemini-upstream.ts`.

- [ ] **Step 6: Run tests and commit**

Run:

```bash
npm test -- tests/unit/translation/code-assist-translation.test.ts tests/unit/proxy/gemini-code-assist-upstream.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/translation/codex-request-to-code-assist.ts src/translation/code-assist-to-codex.ts src/proxy/gemini-code-assist-upstream.ts tests/unit/translation/code-assist-translation.test.ts tests/unit/proxy/gemini-code-assist-upstream.test.ts
git commit -m "feat: add Gemini Code Assist upstream"
```

---

### Task 5: Route Gemini OAuth Accounts Through the Proxy

**Files:**
- Modify: `src/proxy/upstream-router.ts`
- Modify: `src/index.ts`
- Modify: `src/routes/shared/proxy-handler.ts`
- Modify: `src/routes/chat.ts`
- Modify: `src/routes/messages.ts`
- Modify: `src/routes/gemini.ts`
- Modify: `src/routes/responses.ts`
- Test: `tests/unit/proxy/upstream-router-gemini-oauth.test.ts`
- Test: `tests/unit/routes/gemini-oauth-routing.test.ts`

- [ ] **Step 1: Write router test**

Create `tests/unit/proxy/upstream-router-gemini-oauth.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { UpstreamRouter } from "@src/proxy/upstream-router.js";

describe("UpstreamRouter Gemini OAuth", () => {
  it("routes Gemini models to Gemini OAuth when no runtime API key has priority", () => {
    const router = new UpstreamRouter(new Map(), {}, "codex");
    router.setGeminiOAuth({
      hasActiveModel: (model: string) => model === "gemini-3.1-pro",
    }, () => ({
      tag: "gemini-oauth",
      createResponse: vi.fn(),
      parseStream: vi.fn(),
    }));

    const match = router.resolveMatch("gemini-3.1-pro");
    expect(match.kind).toBe("gemini-oauth");
  });
});
```

- [ ] **Step 2: Extend `UpstreamRouteMatch`**

In `src/proxy/upstream-router.ts`:

```ts
export type UpstreamRouteMatch =
  | { kind: "api-key"; adapter: UpstreamAdapter; entry: ApiKeyEntry }
  | { kind: "gemini-oauth"; adapter: UpstreamAdapter; accountId: string }
  | { kind: "adapter"; adapter: UpstreamAdapter }
  | { kind: "codex"; adapter?: UpstreamAdapter }
  | { kind: "not-found" };
```

Add a lightweight pool interface:

```ts
interface GeminiOAuthPoolLike {
  hasActiveModel(model: string): boolean;
  pickAccountForModel?(model: string): { id: string } | undefined;
}
```

Add:

```ts
setGeminiOAuth(pool: GeminiOAuthPoolLike, factory: (model: string) => { adapter: UpstreamAdapter; accountId: string } | null): void;
```

Place Gemini OAuth resolution after exact API-key matching and explicit provider routing priority rules defined by config.

- [ ] **Step 3: Wire router in `src/index.ts`**

After creating `geminiAccountPool`, configure:

```ts
upstreamRouter.setGeminiOAuth(geminiAccountPool, (model) => {
  const account = geminiAccountPool.pickAccountForModel(model);
  if (!account) return null;
  return {
    accountId: account.id,
    adapter: new GeminiCodeAssistUpstream({
      account,
      endpoint: cfg.gemini.code_assist_endpoint,
      apiVersion: cfg.gemini.code_assist_api_version,
      onUsage: (accountId, usedModel, usage) => {
        geminiAccountPool.recordUsage(accountId, usedModel, usage);
        usageStats.recordExternalUsage(usedModel, usage, "gemini-oauth", accountId);
      },
    }),
  };
});
```

If `UsageStatsStore.recordExternalUsage` does not yet accept provider/source parameters, add that in Task 6 and temporarily record with the existing signature in this task.

- [ ] **Step 4: Treat Gemini OAuth as direct route in API routes**

In `chat.ts`, `messages.ts`, `gemini.ts`, and `responses.ts`, update:

```ts
const allowUnauthenticated =
  routeMatch?.kind === "api-key" ||
  routeMatch?.kind === "adapter" ||
  routeMatch?.kind === "gemini-oauth";
```

and:

```ts
if (routeMatch?.kind === "api-key" || routeMatch?.kind === "adapter" || routeMatch?.kind === "gemini-oauth") {
  const apiKeyEntryId = routeMatch.kind === "api-key" ? routeMatch.entry.id : undefined;
  return handleDirectRequest(c, routeMatch.adapter, directReq, fmt, apiKeyPool, apiKeyEntryId, usageStats);
}
```

- [ ] **Step 5: Run routing tests and commit**

Run:

```bash
npm test -- tests/unit/proxy/upstream-router-gemini-oauth.test.ts tests/unit/routes/gemini-oauth-routing.test.ts
npm run build
```

Expected: PASS.

Commit:

```bash
git add src/proxy/upstream-router.ts src/index.ts src/routes/shared/proxy-handler.ts src/routes/chat.ts src/routes/messages.ts src/routes/gemini.ts src/routes/responses.ts tests/unit/proxy/upstream-router-gemini-oauth.test.ts tests/unit/routes/gemini-oauth-routing.test.ts
git commit -m "feat: route Gemini OAuth accounts"
```

---

### Task 6: Extend Usage Stats and Proxy Assignment for Provider Namespaces

**Files:**
- Modify: `src/auth/usage-stats.ts`
- Modify: `src/routes/admin/usage-stats.ts`
- Modify: `src/routes/proxies.ts`
- Modify: `shared/hooks/use-usage-stats.ts`
- Modify: `shared/hooks/use-proxy-assignments.ts`
- Test: `tests/unit/auth/usage-stats-gemini.test.ts`
- Test: `tests/unit/routes/proxy-assignments-provider-ids.test.ts`

- [ ] **Step 1: Write usage aggregation test**

Create `tests/unit/auth/usage-stats-gemini.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { UsageStatsStore } from "@src/auth/usage-stats.js";

describe("UsageStatsStore provider/model aggregation", () => {
  it("records external provider usage with model and source metadata", () => {
    const store = new UsageStatsStore({
      load: () => ({ version: 1, snapshots: [] }),
      save: () => {},
    });

    store.recordExternalUsage("gemini-3.1-pro", { input_tokens: 4, output_tokens: 6 }, "gemini-oauth", "gemini:g1");
    const summary = store.getExternalUsageSummary();

    expect(summary.models["gemini-3.1-pro"]).toEqual({
      input_tokens: 4,
      output_tokens: 6,
      request_count: 1,
    });
    expect(summary.sources["gemini:g1"].request_count).toBe(1);
  });
});
```

- [ ] **Step 2: Update usage types and methods**

In `src/auth/usage-stats.ts`, add source-aware baseline:

```ts
interface SourceUsage {
  provider: string;
  input_tokens: number;
  output_tokens: number;
  request_count: number;
}

interface UsageBaseline {
  input_tokens: number;
  output_tokens: number;
  request_count: number;
  models?: Record<string, ModelUsage>;
  sources?: Record<string, SourceUsage>;
}
```

Change signature:

```ts
recordExternalUsage(
  model: string,
  usage: { input_tokens?: number; output_tokens?: number },
  provider = "external",
  sourceId = provider,
): void
```

Add:

```ts
getExternalUsageSummary(): UsageBaseline {
  return cloneUsageBaseline(this.externalUsage);
}
```

- [ ] **Step 3: Include Gemini pool in snapshots**

Extend `recordSnapshot` and `getSummary` to accept an optional `GeminiAccountPool`. Add Gemini active/total counts into total upstream count and add per-model Gemini usage to `modelMap`.

Use this call shape:

```ts
recordSnapshot(pool: AccountPool, apiKeyPool?: ApiKeyPool, geminiPool?: GeminiAccountPool): void
getSummary(pool: AccountPool, apiKeyPool?: ApiKeyPool, geminiPool?: GeminiAccountPool): UsageSummary
```

- [ ] **Step 4: Write proxy namespace test**

Create `tests/unit/routes/proxy-assignments-provider-ids.test.ts`:

```ts
it("returns namespaced Codex and Gemini accounts for proxy assignment", async () => {
  const res = await app.request("/api/proxies/assignments");
  const body = await res.json() as { accounts: Array<{ id: string; provider: string }> };
  expect(body.accounts.map((a) => a.id)).toContain("codex:acc-1");
  expect(body.accounts.map((a) => a.id)).toContain("gemini:gem-1");
});
```

- [ ] **Step 5: Update proxy assignment route**

Change `createProxyRoutes` signature:

```ts
export function createProxyRoutes(
  proxyPool: ProxyPool,
  accountPool: AccountPool,
  geminiPool?: GeminiAccountPool,
): Hono
```

When listing accounts:

```ts
const codexAccounts = accountPool.getAllEntries().map((a) => ({
  ...toProxyAccountDto(a),
  id: `codex:${a.id}`,
  provider: "codex",
}));
const geminiAccounts = (geminiPool?.getMaskedAccounts() ?? []).map((a) => ({
  id: `gemini:${a.id}`,
  provider: "gemini",
  email: a.email,
  status: a.status,
  proxyId: proxyPool.getAssignment(`gemini:${a.id}`),
  proxyName: proxyPool.getAssignmentDisplayName(`gemini:${a.id}`),
}));
```

Accept raw legacy Codex IDs by normalizing:

```ts
function normalizeAssignmentAccountId(accountId: string): string {
  return accountId.includes(":") ? accountId : `codex:${accountId}`;
}
```

- [ ] **Step 6: Wire index and run tests**

Update `src/index.ts` calls:

```ts
usageStats.recoverBaseline(accountPool, apiKeyPool, geminiAccountPool);
const proxyRoutes = createProxyRoutes(proxyPool, accountPool, geminiAccountPool);
const webRoutes = createWebRoutes(accountPool, usageStats, proxyPool, apiKeyPool, geminiAccountPool);
startQuotaRefresh(accountPool, usageStats, apiKeyPool, geminiAccountPool);
```

If helper signatures do not yet accept Gemini pool, update them in the same task.

Run:

```bash
npm test -- tests/unit/auth/usage-stats-gemini.test.ts tests/unit/routes/proxy-assignments-provider-ids.test.ts
npm run build
```

Expected: PASS.

Commit:

```bash
git add src/auth/usage-stats.ts src/routes/admin/usage-stats.ts src/routes/proxies.ts shared/hooks/use-usage-stats.ts shared/hooks/use-proxy-assignments.ts src/index.ts tests/unit/auth/usage-stats-gemini.test.ts tests/unit/routes/proxy-assignments-provider-ids.test.ts
git commit -m "feat: aggregate Gemini usage and proxy assignments"
```

---

### Task 7: Add Dashboard Gemini Account Flow and Sectioned Account UI

**Files:**
- Modify: `web/src/components/Header.tsx`
- Modify: `web/src/components/AddAccount.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/pages/AccountManagement.tsx`
- Create: `shared/hooks/use-gemini-accounts.ts`
- Create: `web/src/components/GeminiAccountList.tsx`
- Create: `web/src/components/ProviderAccountSections.tsx`
- Modify: `shared/i18n/translations.ts`
- Test: `tests/unit/web/add-account-provider-chooser.test.tsx`

- [ ] **Step 1: Write UI provider chooser test**

Create `tests/unit/web/add-account-provider-chooser.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/preact";
import { AddAccount } from "@web/components/AddAccount";

describe("AddAccount provider chooser", () => {
  it("shows Codex and Gemini choices before starting OAuth", () => {
    const startCodex = vi.fn();
    const startGemini = vi.fn();
    render(
      <AddAccount
        visible={true}
        onCancel={vi.fn()}
        onStartCodex={startCodex}
        onStartGemini={startGemini}
        onSubmitRelay={vi.fn()}
        onAddByRefreshToken={vi.fn()}
        provider={null}
        addInfo=""
        addError=""
      />,
    );

    fireEvent.click(screen.getByText("Codex"));
    expect(startCodex).toHaveBeenCalled();
    fireEvent.click(screen.getByText("Gemini"));
    expect(startGemini).toHaveBeenCalled();
  });
});
```

If the repo does not have Preact Testing Library configured, place this as a component-level Vitest test using the existing test utilities.

- [ ] **Step 2: Add Gemini accounts hook**

Create `shared/hooks/use-gemini-accounts.ts` with:

```ts
export function useGeminiAccounts() {
  const [list, setList] = useState<GeminiAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [addVisible, setAddVisible] = useState(false);
  const [addInfo, setAddInfo] = useState("");
  const [addError, setAddError] = useState("");

  const loadAccounts = useCallback(async () => {
    setRefreshing(true);
    try {
      const resp = await fetch("/auth/gemini/accounts");
      const data = await resp.json();
      setList(data.accounts ?? []);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const startAdd = useCallback(async () => {
    const resp = await fetch("/auth/gemini/login-start", { method: "POST" });
    const data = await resp.json();
    if (!resp.ok || !data.authUrl) throw new Error(data.error || "failedStartLogin");
    window.open(data.authUrl, "gemini_oauth_add", "width=600,height=700,scrollbars=yes");
    setAddVisible(true);
  }, []);

  return { list, loading, refreshing, addVisible, addInfo, addError, refresh: loadAccounts, startAdd };
}
```

Add full delete, refresh, health-check, import-cli methods following `shared/hooks/use-accounts.ts`.

- [ ] **Step 3: Change Header title**

In `web/src/components/Header.tsx`:

```tsx
<h1 class="text-[0.9rem] font-bold tracking-tight">LLM-Proxy</h1>
```

- [ ] **Step 4: Update AddAccount props and UI**

Change `AddAccountProps`:

```ts
type AddProvider = "codex" | "gemini" | null;

interface AddAccountProps {
  visible: boolean;
  provider: AddProvider;
  onChooseProvider: (provider: Exclude<AddProvider, null>) => void;
  onStartCodex: () => Promise<void>;
  onStartGemini: () => Promise<void>;
  onCancel: () => void;
  onSubmitRelay: (provider: Exclude<AddProvider, null>, callbackUrl: string) => Promise<void>;
  onAddByRefreshToken: (refreshToken: string) => Promise<string | null>;
  addInfo: string;
  addError: string;
}
```

Render provider buttons before callback relay:

```tsx
{!provider && (
  <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
    <button onClick={() => onChooseProvider("codex")} class="...">Codex</button>
    <button onClick={() => onChooseProvider("gemini")} class="...">Gemini</button>
  </div>
)}
```

Codex shows existing callback and refresh-token fields. Gemini shows callback relay and `Import from Gemini CLI` action.

- [ ] **Step 5: Create Gemini account list**

Create `web/src/components/GeminiAccountList.tsx` with a compact table:

Columns:

- select checkbox
- email/label
- status
- project/tier
- quota
- token expiry/refresh status
- actions

Actions:

- refresh token
- health check
- import from Gemini CLI
- disable/enable
- delete

- [ ] **Step 6: Section overview and account management**

Create `web/src/components/ProviderAccountSections.tsx`:

```tsx
export function ProviderAccountSections(props: {
  codex: ComponentChildren;
  gemini: ComponentChildren;
}) {
  return (
    <div class="flex flex-col gap-6">
      <section>
        <h2 class="text-[0.95rem] font-bold tracking-tight mb-3">Codex Accounts</h2>
        {props.codex}
      </section>
      <section>
        <h2 class="text-[0.95rem] font-bold tracking-tight mb-3">Gemini Accounts</h2>
        {props.gemini}
      </section>
    </div>
  );
}
```

Use it in `App.tsx` overview and `AccountManagement.tsx`.

- [ ] **Step 7: Run web build and commit**

Run:

```bash
npm run build:web
npm test -- tests/unit/web/add-account-provider-chooser.test.tsx
```

Expected: PASS.

Commit:

```bash
git add web/src/components/Header.tsx web/src/components/AddAccount.tsx web/src/App.tsx web/src/pages/AccountManagement.tsx shared/hooks/use-gemini-accounts.ts web/src/components/GeminiAccountList.tsx web/src/components/ProviderAccountSections.tsx shared/i18n/translations.ts tests/unit/web/add-account-provider-chooser.test.tsx
git commit -m "feat: add Gemini account dashboard sections"
```

---

### Task 8: Section API Keys, Proxy Assignment, Usage Stats, and Settings

**Files:**
- Modify: `web/src/components/ApiKeyManager.tsx`
- Modify: `web/src/pages/ProxySettings.tsx`
- Modify: `web/src/pages/UsageStats.tsx`
- Modify: `shared/hooks/use-status.ts`
- Modify: `web/src/components/SettingsTab.tsx`
- Create: `web/src/components/GeminiSettings.tsx`
- Create: `shared/hooks/use-gemini-settings.ts`
- Modify: `src/routes/admin/settings.ts`
- Test: `tests/unit/routes/gemini-settings.test.ts`

- [ ] **Step 1: Add Gemini settings routes**

In `src/routes/admin/settings.ts`, add:

```ts
app.get("/admin/gemini-settings", (c) => {
  const config = getConfig();
  return c.json({
    oauth_enabled: config.gemini.oauth_enabled,
    credentials_path: config.gemini.credentials_path,
    code_assist_endpoint: config.gemini.code_assist_endpoint,
    code_assist_api_version: config.gemini.code_assist_api_version,
    project_id: config.gemini.project_id,
    refresh_enabled: config.gemini.refresh_enabled,
    refresh_margin_seconds: config.gemini.refresh_margin_seconds,
    refresh_concurrency: config.gemini.refresh_concurrency,
    api_key_priority: config.gemini.api_key_priority,
    routing: config.gemini.routing,
  });
});
```

Add `POST /admin/gemini-settings` with validation for booleans, positive integers, URLs, and routing object.

- [ ] **Step 2: Write Gemini settings route test**

Create `tests/unit/routes/gemini-settings.test.ts`:

```ts
it("GET /admin/gemini-settings returns Gemini routing config", async () => {
  const res = await app.request("/admin/gemini-settings");
  const body = await res.json() as { routing: { opus: string } };
  expect(res.status).toBe(200);
  expect(body.routing.opus).toBe("gemini-3.1-pro");
});
```

- [ ] **Step 3: Create settings hook and component**

Create `shared/hooks/use-gemini-settings.ts` with `GET /admin/gemini-settings` and `POST /admin/gemini-settings`.

Create `web/src/components/GeminiSettings.tsx` sections:

- Gemini OAuth
- Gemini Code Assist
- Gemini Token Refresh
- Gemini Routing
- Gemini Connection Test

Use existing collapsible settings card styling from `GeneralSettings.tsx`.

- [ ] **Step 4: Add Gemini settings to settings tab**

In `web/src/components/SettingsTab.tsx`:

```tsx
<GeminiSettings />
```

Place it after `RotationSettings` and before `SettingsPanel`.

- [ ] **Step 5: Section API keys by provider**

In `ApiKeyManager.tsx`, group keys:

```ts
const grouped = {
  gemini: keys.filter((k) => k.provider === "gemini"),
  openai: keys.filter((k) => k.provider === "openai"),
  anthropic: keys.filter((k) => k.provider === "anthropic"),
  openrouter: keys.filter((k) => k.provider === "openrouter"),
  custom: keys.filter((k) => k.provider === "custom"),
};
```

Render `Gemini API Keys` separately and add text:

```tsx
<p class="text-xs text-slate-500 dark:text-text-dim">
  Gemini API keys are separate from Gemini OAuth accounts imported through Gemini CLI login.
</p>
```

- [ ] **Step 6: Section proxy assignment**

In `ProxySettings.tsx`, split `data.accounts` into:

```ts
const codexAccounts = data.accounts.filter((a) => a.provider === "codex");
const geminiAccounts = data.accounts.filter((a) => a.provider === "gemini");
```

Render two `AccountTable` sections. Ensure selections use namespaced IDs returned by the API.

- [ ] **Step 7: Usage stats model list**

In `UsageStats.tsx`, change model source to combine:

- `useStatus(0).models`
- models returned from `/admin/usage-stats/models`
- active API key models

Add backend route:

```ts
app.get("/admin/usage-stats/models", (c) => {
  return c.json({ models: statsStore.getKnownModels(apiKeyPool, geminiPool) });
});
```

If `getKnownModels` does not exist, add it to `UsageStatsStore`.

- [ ] **Step 8: Run tests/build and commit**

Run:

```bash
npm test -- tests/unit/routes/gemini-settings.test.ts
npm run build
```

Expected: PASS.

Commit:

```bash
git add web/src/components/ApiKeyManager.tsx web/src/pages/ProxySettings.tsx web/src/pages/UsageStats.tsx shared/hooks/use-status.ts web/src/components/SettingsTab.tsx web/src/components/GeminiSettings.tsx shared/hooks/use-gemini-settings.ts src/routes/admin/settings.ts tests/unit/routes/gemini-settings.test.ts
git commit -m "feat: expose Gemini settings and dashboard sections"
```

---

### Task 9: Final Verification and Documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-05-08-codex-gemini-unified-proxy-design.md`
- Modify: `docs/superpowers/plans/2026-05-08-codex-gemini-unified-proxy.md`
- Optional Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: Run targeted tests**

Run:

```bash
npm test -- \
  tests/unit/tls/curl-fetch-native-fallback.test.ts \
  tests/unit/auth/oauth-pkce-native-fallback.test.ts \
  tests/unit/auth/gemini-account-pool.test.ts \
  tests/unit/auth/gemini-oauth.test.ts \
  tests/unit/routes/gemini-auth.test.ts \
  tests/unit/translation/code-assist-translation.test.ts \
  tests/unit/proxy/gemini-code-assist-upstream.test.ts \
  tests/unit/proxy/upstream-router-gemini-oauth.test.ts \
  tests/unit/auth/usage-stats-gemini.test.ts \
  tests/unit/routes/proxy-assignments-provider-ids.test.ts \
  tests/unit/routes/gemini-settings.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run existing regression tests**

Run:

```bash
npm test -- \
  tests/unit/auth/usage-stats.test.ts \
  tests/unit/routes/shared/error-forwarding.test.ts \
  tests/e2e/gemini.test.ts \
  tests/e2e/messages.test.ts \
  tests/e2e/chat.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 4: Manual verification checklist**

Verify:

- Header displays `LLM-Proxy`.
- `Add Account` opens provider chooser.
- Codex choice opens the existing Codex OAuth flow.
- Codex callback no longer fails with `Native addon not found`.
- Gemini choice opens Google OAuth.
- `Import from Gemini CLI` imports `~/.gemini/oauth_creds.json` without exposing token values.
- Overview shows `Codex Accounts` above `Gemini Accounts`.
- Account management shows provider-specific actions.
- API key tab shows the existing Gemini API key as a Gemini API key, not a Gemini OAuth account.
- Proxy assignment shows Codex and Gemini sections.
- Usage stats `All Models` includes Codex plus Gemini usage.
- Selecting `gemini-3.1-pro` shows Gemini model usage.
- Gemini settings show OAuth, Code Assist, refresh, routing, quota, and connection test controls.

- [ ] **Step 5: Update spec if implementation intentionally differs**

If the implementation chose a different route name, setting name, or UI wording, update the spec with the exact shipped behavior. Do not leave stale route names in the spec.

- [ ] **Step 6: Commit verification/docs**

Run:

```bash
git status --short
git diff --check
```

Expected: `git diff --check` prints no output.

Commit:

```bash
git add docs/superpowers/specs/2026-05-08-codex-gemini-unified-proxy-design.md docs/superpowers/plans/2026-05-08-codex-gemini-unified-proxy.md docs/CHANGELOG.md
git commit -m "docs: finalize Gemini OAuth integration notes"
```

Skip `docs/CHANGELOG.md` from `git add` if it was not changed.

---

## Self-Review

- Spec coverage: The plan covers Codex auth repair, Gemini account persistence, Gemini OAuth/import, Code Assist upstream, routing, usage stats, proxy assignment, dashboard account sections, API key sections, usage model filtering, and Gemini settings.
- Placeholder scan: The plan avoids unresolved marker text and unspecified test commands. Route names and file paths are explicit.
- Type consistency: Gemini account status, usage, masked account DTOs, and provider namespace strings are consistent across backend, hooks, and UI tasks.
- Scope: The plan is large but broken into nine commits. Each commit is independently testable.
