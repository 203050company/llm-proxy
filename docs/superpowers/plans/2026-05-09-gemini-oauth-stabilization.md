# Gemini OAuth Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the remaining Gemini OAuth integration work so Gemini CLI accounts refresh reliably, routing priority settings are honored, and new Gemini dashboard surfaces are localized.

**Architecture:** Keep Codex and Gemini account systems separate. Add a small Gemini token manager that owns OAuth refresh decisions, inject it into Gemini Code Assist and Gemini auth routes, then wire existing Gemini routing settings into `UpstreamRouter`. UI work is limited to Gemini-related strings that still bypass `shared/i18n`.

**Tech Stack:** TypeScript, Hono, Preact, Vitest, existing YAML config loader, Google OAuth token endpoint, existing Gemini Code Assist upstream adapter.

---

## Scope

This plan handles the actionable remaining Gemini work found after the current branch review:

- Gemini OAuth access-token refresh before Code Assist requests.
- Expired Gemini CLI credential import and health-check refresh behavior.
- `gemini.api_key_priority` actually changing route selection.
- Remaining Gemini-related dashboard Korean localization.
- Verification and manual browser checks for the Gemini/Codex flows.

This plan intentionally excludes desktop packaging, Electron launch tests, installer generation, notarization, and release packaging because those are unrelated to the current Gemini/Codex proxy behavior. Do not add or run packaging tests while executing this plan.

The Code Assist project/tier/quota probe is not implemented here. The current repo has no concrete endpoint contract for setup/quota beyond the design note. Treat quota probing as a follow-up research task after the token-refresh and routing paths are stable.

## File Structure

- Create `src/auth/gemini-token-manager.ts`: focused helper for Gemini OAuth refresh decisions and pool mutation.
- Create `tests/unit/auth/gemini-token-manager.test.ts`: token freshness and refresh behavior.
- Modify `src/proxy/gemini-code-assist-upstream.ts`: ask for a fresh account before sending OAuth-backed requests.
- Modify `tests/unit/proxy/gemini-code-assist-upstream.test.ts`: assert refreshed token is used.
- Modify `src/index.ts`: instantiate and inject `GeminiTokenManager`.
- Modify `src/routes/gemini-auth.ts`: inject token manager for import, health check, and manual refresh paths.
- Modify `tests/unit/routes/gemini-auth.test.ts`: cover expired CLI import and health check using refreshed access token.
- Modify `src/proxy/upstream-router.ts`: accept Gemini priority option and route accordingly.
- Modify `tests/unit/proxy/upstream-router-gemini-oauth.test.ts`: cover `api_key` and `oauth` priority.
- Modify `web/src/components/AddAccount.tsx`, `web/src/components/GeminiSettings.tsx`, `web/src/pages/ProxySettings.tsx`, `web/src/components/ApiKeyManager.tsx`: move Gemini UI strings to i18n.
- Modify `shared/i18n/translations.ts`: add English, Chinese, and Korean Gemini UI translation keys.
- Create `tests/unit/i18n/gemini-ui-translations.test.ts`: prevent new Gemini UI strings from missing translations.

---

### Task 1: Add Gemini Token Manager

**Files:**
- Create: `src/auth/gemini-token-manager.ts`
- Create: `tests/unit/auth/gemini-token-manager.test.ts`

- [ ] **Step 1: Write the failing token-manager tests**

Create `tests/unit/auth/gemini-token-manager.test.ts`:

```ts
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
    expect(account.status).toBe("active");
  });

  it("marks the account expired when refresh fails", async () => {
    const entry = pool.addOrUpdate(makeEntry());
    const manager = new GeminiTokenManager(pool, {
      refreshAccessToken: async () => {
        throw new Error("invalid_grant");
      },
    });

    await expect(manager.ensureFreshAccount(entry.id)).rejects.toThrow("invalid_grant");
    expect(pool.getEntry(entry.id)?.status).toBe("expired");
    expect(pool.getEntry(entry.id)?.lastRefreshFailureCode).toBe("invalid_grant");
  });
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run:

```bash
npm test -- tests/unit/auth/gemini-token-manager.test.ts
```

Expected: FAIL because `@src/auth/gemini-token-manager.js` does not exist.

- [ ] **Step 3: Implement the token manager**

Create `src/auth/gemini-token-manager.ts`:

```ts
import { getConfig } from "../config.js";
import type { GeminiAccountPool } from "./gemini-account-pool.js";
import type { GeminiAccountEntry } from "./gemini-types.js";
import { refreshGeminiAccessToken, type GeminiTokenResponse } from "./gemini-oauth.js";

export interface GeminiTokenManagerDeps {
  refreshAccessToken?: (refreshToken: string) => Promise<GeminiTokenResponse>;
}

export class GeminiTokenManager {
  private readonly refreshAccessToken: (refreshToken: string) => Promise<GeminiTokenResponse>;

  constructor(
    private readonly pool: GeminiAccountPool,
    deps: GeminiTokenManagerDeps = {},
  ) {
    this.refreshAccessToken = deps.refreshAccessToken ?? refreshGeminiAccessToken;
  }

  async ensureFreshAccount(id: string): Promise<GeminiAccountEntry> {
    const entry = this.pool.getEntry(id);
    if (!entry) throw new Error("Gemini account not found");

    const config = getConfig();
    if (
      config.gemini.refresh_enabled === false ||
      !isGeminiTokenExpiringSoon(entry.expiresAt, config.gemini.refresh_margin_seconds)
    ) {
      return entry;
    }

    if (!entry.refreshToken) {
      this.pool.setStatus(id, "expired", "missing_refresh_token");
      throw new Error("Gemini account has no refresh token");
    }

    this.pool.setStatus(id, "refreshing", null);
    try {
      const tokens = await this.refreshAccessToken(entry.refreshToken);
      this.pool.updateToken(id, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? entry.refreshToken,
        idToken: tokens.id_token ?? entry.idToken,
        expiresAt: expiresAtFromGeminiToken(tokens),
        scope: tokens.scope ?? entry.scope,
        tokenType: tokens.token_type || entry.tokenType || "Bearer",
      });
      const updated = this.pool.getEntry(id);
      if (!updated) throw new Error("Gemini account disappeared after refresh");
      return updated;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.pool.setStatus(id, "expired", message);
      throw err;
    }
  }
}

export function isGeminiTokenExpiringSoon(expiresAt: string | null | undefined, marginSeconds: number): boolean {
  if (!expiresAt) return true;
  const expiresAtMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiresAtMs)) return true;
  return expiresAtMs - Date.now() <= marginSeconds * 1000;
}

export function expiresAtFromGeminiToken(tokens: GeminiTokenResponse): string | null {
  if (typeof tokens.expires_in !== "number") return null;
  return new Date(Date.now() + tokens.expires_in * 1000).toISOString();
}
```

- [ ] **Step 4: Run the token-manager test to verify it passes**

Run:

```bash
npm test -- tests/unit/auth/gemini-token-manager.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth/gemini-token-manager.ts tests/unit/auth/gemini-token-manager.test.ts
git commit -m "feat: add Gemini token manager"
```

---

### Task 2: Refresh Gemini OAuth Tokens Before Code Assist Requests

**Files:**
- Modify: `src/proxy/gemini-code-assist-upstream.ts`
- Modify: `src/index.ts`
- Modify: `tests/unit/proxy/gemini-code-assist-upstream.test.ts`

- [ ] **Step 1: Write the failing upstream refresh test**

Append this test to `tests/unit/proxy/gemini-code-assist-upstream.test.ts`:

```ts
  it("uses ensureFreshAccount before sending the Code Assist request", async () => {
    const fetchMock = vi.fn(async () => new Response(
      'data: {"response":{"candidates":[]}}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    global.fetch = fetchMock as unknown as typeof fetch;

    const ensureFreshAccount = vi.fn(async () => ({
      ...account(),
      accessToken: "refreshed-access",
      tokenType: "Bearer",
    }));

    const upstream = new GeminiCodeAssistUpstream({
      account: account(),
      endpoint: "https://cloudcode-pa.googleapis.com",
      apiVersion: "v1internal",
      ensureFreshAccount,
    });

    await upstream.createResponse({
      model: "gemini-3.1-pro",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: true,
      store: false,
    }, new AbortController().signal);

    expect(ensureFreshAccount).toHaveBeenCalledWith("g1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer refreshed-access" }),
      }),
    );
  });
```

- [ ] **Step 2: Run the upstream test to verify it fails**

Run:

```bash
npm test -- tests/unit/proxy/gemini-code-assist-upstream.test.ts
```

Expected: FAIL because `ensureFreshAccount` is not a supported option.

- [ ] **Step 3: Add the option and use the refreshed account**

In `src/proxy/gemini-code-assist-upstream.ts`, extend the options and update `createResponse`:

```ts
export interface GeminiCodeAssistOptions {
  account: GeminiAccountEntry;
  endpoint: string;
  apiVersion: string;
  ensureFreshAccount?: (accountId: string) => Promise<GeminiAccountEntry>;
  onUsage?: (
    accountId: string,
    model: string,
    usage: { input_tokens: number; output_tokens: number },
  ) => void;
}
```

Inside `createResponse`, replace direct account access with:

```ts
const account = this.options.ensureFreshAccount
  ? await this.options.ensureFreshAccount(this.options.account.id)
  : this.options.account;

const body = translateCodexToCodeAssistRequest(req, {
  projectId: account.projectId,
  sessionId: `llm-proxy-${account.id}`,
  userPromptId: randomUUID(),
});
```

And use `account` for the authorization header:

```ts
Authorization: `${account.tokenType || "Bearer"} ${account.accessToken}`,
```

- [ ] **Step 4: Inject `GeminiTokenManager` in startup**

In `src/index.ts`, import and instantiate the manager:

```ts
import { GeminiTokenManager } from "./auth/gemini-token-manager.js";
```

After `const geminiAccountPool = new GeminiAccountPool();`, add:

```ts
const geminiTokenManager = new GeminiTokenManager(geminiAccountPool);
```

When creating `GeminiCodeAssistUpstream`, add:

```ts
ensureFreshAccount: (accountId) => geminiTokenManager.ensureFreshAccount(accountId),
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm test -- tests/unit/proxy/gemini-code-assist-upstream.test.ts tests/unit/auth/gemini-token-manager.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/proxy/gemini-code-assist-upstream.ts src/index.ts tests/unit/proxy/gemini-code-assist-upstream.test.ts
git commit -m "fix: refresh Gemini OAuth tokens before Code Assist requests"
```

---

### Task 3: Use Token Manager in Gemini Import, Health Check, and Manual Refresh

**Files:**
- Modify: `src/routes/gemini-auth.ts`
- Modify: `tests/unit/routes/gemini-auth.test.ts`

- [ ] **Step 1: Write failing route tests**

Add this helper type and tests to `tests/unit/routes/gemini-auth.test.ts`:

```ts
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
```

Add tests:

```ts
  it("health-check validates the refreshed Gemini access token", async () => {
    const entry = pool.addOrUpdate(makeGeminiEntry({
      accessToken: "expired-access",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }));
    fakeTokenManager.ensureFreshAccount.mockClear();
    global.fetch = vi.fn(async (_url, init) => {
      expect((init as RequestInit).headers).toEqual({
        Authorization: "Bearer refreshed-access",
      });
      return new Response(JSON.stringify({ email: "user@example.com" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const app = createGeminiAuthRoutes(pool, fakeTokenManager);
    const res = await app.request("/auth/gemini/accounts/health-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: entry.id }),
    });

    expect(res.status).toBe(200);
    expect(fakeTokenManager.ensureFreshAccount).toHaveBeenCalledWith(entry.id);
  });

  it("manual refresh uses the same token update behavior as the token manager", async () => {
    const entry = pool.addOrUpdate(makeGeminiEntry());
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      access_token: "manual-new-access",
      token_type: "Bearer",
      expires_in: 3600,
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    const app = createGeminiAuthRoutes(pool);
    const res = await app.request(`/auth/gemini/accounts/${entry.id}/refresh`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(pool.getEntry(entry.id)?.accessToken).toBe("manual-new-access");
    expect(pool.getEntry(entry.id)?.refreshToken).toBe("secret-refresh");
  });
```

- [ ] **Step 2: Run route tests to verify failure**

Run:

```bash
npm test -- tests/unit/routes/gemini-auth.test.ts
```

Expected: FAIL because `createGeminiAuthRoutes` accepts only the pool and health check uses the stored access token directly.

- [ ] **Step 3: Inject token manager into routes**

In `src/routes/gemini-auth.ts`, add:

```ts
import { GeminiTokenManager, expiresAtFromGeminiToken } from "../auth/gemini-token-manager.js";
```

Change the route factory:

```ts
export interface GeminiTokenManagerLike {
  ensureFreshAccount(id: string): Promise<GeminiAccountEntry>;
}

export function createGeminiAuthRoutes(
  pool: GeminiAccountPool,
  tokenManager: GeminiTokenManagerLike = new GeminiTokenManager(pool),
): Hono {
```

In health check, replace direct `entry.accessToken` use with:

```ts
const fresh = await tokenManager.ensureFreshAccount(entry.id);
const user = await fetchGeminiUserInfo(fresh.accessToken);
```

Replace the local `expiresAtFromToken()` helper calls with `expiresAtFromGeminiToken(tokens)`. Remove the local helper after all call sites are updated.

- [ ] **Step 4: Run focused route tests**

Run:

```bash
npm test -- tests/unit/routes/gemini-auth.test.ts tests/unit/auth/gemini-token-manager.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/gemini-auth.ts tests/unit/routes/gemini-auth.test.ts
git commit -m "fix: refresh Gemini tokens in auth routes"
```

---

### Task 4: Honor `gemini.api_key_priority` in Upstream Routing

**Files:**
- Modify: `src/proxy/upstream-router.ts`
- Modify: `src/index.ts`
- Modify: `tests/unit/proxy/upstream-router-gemini-oauth.test.ts`

- [ ] **Step 1: Write failing router priority tests**

Replace `tests/unit/proxy/upstream-router-gemini-oauth.test.ts` with:

```ts
import { describe, expect, it, vi } from "vitest";
import { UpstreamRouter } from "@src/proxy/upstream-router.js";
import type { ApiKeyEntry, ApiKeyPool } from "@src/auth/api-key-pool.js";

const geminiOAuthAdapter = {
  tag: "gemini-oauth",
  createResponse: vi.fn(),
  parseStream: vi.fn(),
};

const apiKeyAdapter = {
  tag: "gemini",
  createResponse: vi.fn(),
  parseStream: vi.fn(),
};

function fakeApiKeyPool(): ApiKeyPool {
  const entry = {
    id: "key-1",
    provider: "gemini",
    label: null,
    apiKey: "secret",
    model: "gemini-3.1-pro",
    status: "active",
    usage: { input_tokens: 0, output_tokens: 0, request_count: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastUsedAt: null,
  } as ApiKeyEntry;

  return {
    getByModel: (model: string) => model === "gemini-3.1-pro" ? [entry] : [],
    markUsed: vi.fn(),
  } as unknown as ApiKeyPool;
}

function attachGeminiOAuth(router: UpstreamRouter): void {
  router.setGeminiOAuth({
    hasActiveModel: (model: string) => model === "gemini-3.1-pro",
  }, () => ({
    accountId: "gemini-1",
    adapter: geminiOAuthAdapter,
  }));
}

describe("UpstreamRouter Gemini OAuth", () => {
  it("keeps runtime API keys first when Gemini priority is api_key", () => {
    const router = new UpstreamRouter(new Map(), {}, "codex", { geminiPriority: "api_key" });
    router.setApiKeyPool(fakeApiKeyPool(), () => apiKeyAdapter);
    attachGeminiOAuth(router);

    const match = router.resolveMatch("gemini-3.1-pro");

    expect(match.kind).toBe("api-key");
  });

  it("routes Gemini models to OAuth first when Gemini priority is oauth", () => {
    const router = new UpstreamRouter(new Map(), {}, "codex", { geminiPriority: "oauth" });
    router.setApiKeyPool(fakeApiKeyPool(), () => apiKeyAdapter);
    attachGeminiOAuth(router);

    const match = router.resolveMatch("gemini-3.1-pro");

    expect(match.kind).toBe("gemini-oauth");
    expect(match.kind === "gemini-oauth" ? match.accountId : null).toBe("gemini-1");
  });
});
```

- [ ] **Step 2: Run the router test to verify it fails**

Run:

```bash
npm test -- tests/unit/proxy/upstream-router-gemini-oauth.test.ts
```

Expected: FAIL because `UpstreamRouter` does not accept `geminiPriority`.

- [ ] **Step 3: Add router options and priority order**

In `src/proxy/upstream-router.ts`, add:

```ts
export interface UpstreamRouterOptions {
  geminiPriority?: "api_key" | "oauth";
}
```

Change the constructor:

```ts
constructor(
  private readonly adapters: Map<string, UpstreamAdapter>,
  private readonly modelRouting: Record<string, string>,
  private readonly defaultTag: string,
  private readonly options: UpstreamRouterOptions = {},
) {}
```

In `resolveMatch`, before API-key matching, add:

```ts
if (this.options.geminiPriority === "oauth") {
  const oauthFirst = this.resolveGeminiOAuthMatch(model, cleanModel);
  if (oauthFirst) return oauthFirst;
}
```

Then keep existing API-key matching. After `modelRouting`, change Gemini OAuth matching to:

```ts
if (this.options.geminiPriority !== "oauth") {
  const geminiOAuthMatch = this.resolveGeminiOAuthMatch(model, cleanModel);
  if (geminiOAuthMatch) return geminiOAuthMatch;
}
```

- [ ] **Step 4: Pass config from startup**

In `src/index.ts`, change router construction to:

```ts
? new UpstreamRouter(adapters, cfg.model_routing, "codex", {
    geminiPriority: cfg.gemini.api_key_priority,
  })
```

- [ ] **Step 5: Run focused router tests**

Run:

```bash
npm test -- tests/unit/proxy/upstream-router-gemini-oauth.test.ts tests/unit/routes/gemini-settings.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/proxy/upstream-router.ts src/index.ts tests/unit/proxy/upstream-router-gemini-oauth.test.ts
git commit -m "fix: honor Gemini routing priority"
```

---

### Task 5: Localize Remaining Gemini Dashboard Strings

**Files:**
- Modify: `shared/i18n/translations.ts`
- Modify: `web/src/components/AddAccount.tsx`
- Modify: `web/src/components/GeminiSettings.tsx`
- Modify: `web/src/pages/ProxySettings.tsx`
- Modify: `web/src/components/ApiKeyManager.tsx`
- Create: `tests/unit/i18n/gemini-ui-translations.test.ts`

- [ ] **Step 1: Write the failing translation coverage test**

Create `tests/unit/i18n/gemini-ui-translations.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { translations, type LangCode } from "../../../shared/i18n/translations";

const keys = [
  "codexProviderDescription",
  "geminiProviderDescription",
  "geminiAddStep1",
  "geminiAddStep2",
  "geminiAddStep3",
  "apiKeys",
  "addApiKey",
  "importApiKeys",
  "noApiKeysConfigured",
  "geminiApiKeys",
  "openaiApiKeys",
  "anthropicApiKeys",
  "openrouterApiKeys",
  "customApiKeys",
  "geminiApiKeysSeparateHint",
  "geminiSettings",
  "geminiSettingsDescription",
  "geminiOAuthEnabled",
  "geminiCredentialsPath",
  "geminiCodeAssistEndpoint",
  "geminiApiVersion",
  "geminiProjectId",
  "geminiRefreshMarginSeconds",
  "geminiRefreshConcurrency",
  "geminiApiKeyPriority",
  "geminiPriorityApiKey",
  "geminiPriorityOAuth",
] as const;

describe("remaining Gemini UI translations", () => {
  it("defines every remaining Gemini UI key in each language", () => {
    for (const lang of Object.keys(translations) as LangCode[]) {
      for (const key of keys) {
        expect(translations[lang][key], `${lang}.${key}`).toBeTruthy();
      }
    }
  });

  it("uses Korean text for Gemini dashboard labels", () => {
    expect(translations.ko.geminiSettings).toBe("Gemini 설정");
    expect(translations.ko.geminiOAuthEnabled).toBe("Gemini OAuth 활성화");
    expect(translations.ko.geminiApiKeys).toBe("Gemini API 키");
    expect(translations.ko.geminiAddStep1).toContain("Google OAuth");
  });
});
```

- [ ] **Step 2: Run the translation test to verify it fails**

Run:

```bash
npm test -- tests/unit/i18n/gemini-ui-translations.test.ts
```

Expected: FAIL because the new keys do not exist.

- [ ] **Step 3: Add translations**

In each language block of `shared/i18n/translations.ts`, add all keys from the test. Korean values must include:

```ts
codexProviderDescription: "OpenAI Codex CLI OAuth",
geminiProviderDescription: "Google OAuth / Gemini CLI",
geminiAddStep1: "팝업에서 Google OAuth 로그인을 완료하세요.",
geminiAddStep2: "팝업이 자동으로 돌아오지 않으면 마지막 callback URL을 아래에 붙여넣으세요.",
geminiAddStep3: "이 기기에 Gemini CLI 자격 증명이 이미 있으면 Gemini CLI 가져오기를 사용할 수 있습니다.",
apiKeys: "API 키",
addApiKey: "API 키 추가",
importApiKeys: "API 키 가져오기",
noApiKeysConfigured: "설정된 API 키가 없습니다. + 버튼으로 추가하세요.",
geminiApiKeys: "Gemini API 키",
openaiApiKeys: "OpenAI API 키",
anthropicApiKeys: "Anthropic API 키",
openrouterApiKeys: "OpenRouter API 키",
customApiKeys: "사용자 지정 API 키",
geminiApiKeysSeparateHint: "Gemini API 키는 Gemini CLI 로그인으로 가져온 Gemini OAuth 계정과 별도로 관리됩니다.",
geminiSettings: "Gemini 설정",
geminiSettingsDescription: "Gemini CLI 계정의 OAuth, Code Assist, 갱신, 모델 라우팅 설정입니다.",
geminiOAuthEnabled: "Gemini OAuth 활성화",
geminiCredentialsPath: "자격 증명 경로",
geminiCodeAssistEndpoint: "Code Assist 엔드포인트",
geminiApiVersion: "API 버전",
geminiProjectId: "프로젝트 ID",
geminiRefreshMarginSeconds: "갱신 여유 시간(초)",
geminiRefreshConcurrency: "갱신 동시 실행 수",
geminiApiKeyPriority: "Gemini API 키 우선순위",
geminiPriorityApiKey: "API 키 우선",
geminiPriorityOAuth: "OAuth 계정 우선",
```

Add equivalent English and Chinese values in the same key order.

- [ ] **Step 4: Replace hardcoded UI strings**

In `web/src/components/AddAccount.tsx`, replace:

```tsx
OpenAI Codex CLI OAuth
Google OAuth / Gemini CLI
Complete the Google OAuth login in the popup.
Paste the final callback URL below if the popup cannot return automatically.
Use Gemini CLI import if this machine already has Gemini CLI credentials.
Import from Gemini CLI
```

with `t("codexProviderDescription")`, `t("geminiProviderDescription")`, `t("geminiAddStep1")`, `t("geminiAddStep2")`, `t("geminiAddStep3")`, and `t("importFromGeminiCli")`.

In `web/src/pages/ProxySettings.tsx`, replace hardcoded section headings with:

```tsx
{t("codexAccounts")}
{t("geminiAccounts")}
```

In `web/src/components/ApiKeyManager.tsx`, replace hardcoded API key headings and hints with the new translation keys:

```tsx
{t("apiKeys")}
title={t("importApiKeys")}
title={t("addApiKey")}
{t("noApiKeysConfigured")}
<KeySection title={t("geminiApiKeys")} ...>
{t("geminiApiKeysSeparateHint")}
```

In `web/src/components/GeminiSettings.tsx`, replace all label strings with the new translation keys.

- [ ] **Step 5: Run focused i18n tests**

Run:

```bash
npm test -- tests/unit/i18n/gemini-ui-translations.test.ts tests/unit/i18n/gemini-account-translations.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/i18n/translations.ts web/src/components/AddAccount.tsx web/src/components/GeminiSettings.tsx web/src/pages/ProxySettings.tsx web/src/components/ApiKeyManager.tsx tests/unit/i18n/gemini-ui-translations.test.ts
git commit -m "fix: localize remaining Gemini dashboard UI"
```

---

### Task 6: Final Verification and Documentation Note

**Files:**
- Modify: `docs/superpowers/plans/2026-05-09-gemini-oauth-stabilization.md`

- [ ] **Step 1: Run focused Gemini/Codex verification**

Run:

```bash
npm test -- \
  tests/unit/auth/gemini-token-manager.test.ts \
  tests/unit/routes/gemini-auth.test.ts \
  tests/unit/auth/gemini-oauth.test.ts \
  tests/unit/auth/gemini-account-pool.test.ts \
  tests/unit/proxy/gemini-code-assist-upstream.test.ts \
  tests/unit/proxy/upstream-router-gemini-oauth.test.ts \
  tests/unit/auth/usage-stats-gemini.test.ts \
  tests/unit/routes/proxy-assignments-provider-ids.test.ts \
  tests/unit/proxy/codex-usage-native-fallback.test.ts \
  tests/unit/i18n/gemini-account-translations.test.ts \
  tests/unit/i18n/gemini-ui-translations.test.ts \
  tests/unit/web/add-account-provider-chooser.test.ts \
  tests/unit/routes/gemini-settings.test.ts
```

Expected: PASS for all listed files.

- [ ] **Step 2: Run broader non-packaging verification**

Run:

```bash
npm run test:unit
npm test -- tests/e2e/gemini.test.ts tests/e2e/auth-routes.test.ts tests/e2e/proxy-routes.test.ts
npm test -- tests/integration/usage-passthrough.test.ts tests/integration/account-routing.test.ts tests/integration/proxy-handler.test.ts
npm run build
```

Expected:

- `test:unit`: all unit tests pass.
- E2E command: all listed tests pass.
- Integration command: all listed tests pass.
- `npm run build`: Vite build and `tsc` pass.

Do not run `packages/electron/*`, Electron launch tests, desktop packaging scripts, or installer tests as part of this verification.

- [ ] **Step 3: Manual browser verification**

With the dev server running on `http://localhost:8080`, verify:

- Header still displays `LLM-Proxy`.
- Add Account opens provider choices before OAuth starts.
- Codex choice opens Codex OAuth and callback registration succeeds.
- Codex usage refresh shows the correct Plus plan and 5-hour usage.
- Gemini choice opens Google OAuth and callback relay succeeds.
- Gemini account table appears in Korean when language is KO.
- Gemini request through a Gemini OAuth model refreshes expired access tokens before the request.
- `gemini.api_key_priority: oauth` routes a Gemini model to Gemini OAuth even if a Gemini API key exists for the same model.
- `gemini.api_key_priority: api_key` routes the same model to the API key entry first.
- Usage stats `All Models` still includes Codex plus Gemini/API-key totals.

- [ ] **Step 4: Record verification result in this plan**

Append this section to the bottom of this file with actual results:

```md
## Execution Verification

- Focused tests:
- Unit suite:
- E2E subset:
- Integration subset:
- Build:
- Manual browser checks:
- Desktop packaging: skipped because it is outside this plan.
```

- [ ] **Step 5: Commit verification note**

```bash
git add docs/superpowers/plans/2026-05-09-gemini-oauth-stabilization.md
git commit -m "docs: add Gemini OAuth stabilization plan"
```

---

## Self-Review

- Spec coverage: This plan covers the remaining actionable gaps from the current branch review: Gemini token refresh, route-level refresh usage, routing priority, UI localization, and final verification. Code Assist setup/quota probing is explicitly separated because the current repo does not contain a verified endpoint contract.
- Placeholder scan: The plan avoids unresolved marker text, vague validation steps, and unspecified tests. Each task lists exact files, test commands, expected outcomes, and concrete code snippets.
- Type consistency: `GeminiTokenManager`, `ensureFreshAccount`, `expiresAtFromGeminiToken`, `geminiPriority`, and `GeminiTokenManagerLike` are named consistently across tasks.
- Scope check: Desktop packaging and Electron tests are explicitly outside this plan.

## Execution Verification

- Focused tests: PASS, 13 files / 30 tests.
- Unit suite: PASS, 139 files / 1437 tests.
- E2E subset: PASS, 3 files / 49 tests.
- Integration subset: PASS, 3 files / 38 tests.
- Build: PASS, `npm run build` completed Vite production build and `tsc`.
- Manual browser checks: Not run in this execution; requires user-driven OAuth/browser flow.
- Desktop packaging: skipped because it is outside this plan.
