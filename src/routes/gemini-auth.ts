import { randomBytes } from "crypto";
import { Hono } from "hono";
import { getConfig } from "../config.js";
import type { GeminiAccountPool } from "../auth/gemini-account-pool.js";
import type { GeminiAccountEntry } from "../auth/gemini-types.js";
import {
  GeminiTokenManager,
  expiresAtFromGeminiToken,
  isGeminiTokenExpiringSoon,
} from "../auth/gemini-token-manager.js";
import {
  createGeminiOAuthSession,
  deleteGeminiSession,
  exchangeGeminiCode,
  fetchGeminiUserInfo,
  importGeminiCliCredentials,
  isGeminiSessionCompleted,
  isGeminiSessionExchanging,
  markGeminiSessionCompleted,
  refreshGeminiAccessToken,
  releaseGeminiSession,
  tryAcquireGeminiSession,
  type GeminiTokenResponse,
} from "../auth/gemini-oauth.js";
import {
  fetchGeminiCodeAssistTier,
} from "../auth/gemini-code-assist-profile.js";
import { GeminiCliAuthService, GeminiCliAuthError } from "../services/gemini-cli-auth.js";
import {
  refreshGeminiAccountTier,
  type GeminiTierFetcherLike,
  type GeminiTokenManagerLike,
} from "../services/gemini-code-assist-quota.js";

const DEFAULT_GEMINI_MODELS = ["gemini-3.1-pro", "gemini-3-pro", "gemini-3.1-flash-lite"];

export function createGeminiAuthRoutes(
  pool: GeminiAccountPool,
  tokenManager: GeminiTokenManagerLike = new GeminiTokenManager(pool),
  tierFetcher: GeminiTierFetcherLike = fetchGeminiCodeAssistTier,
): Hono {
  const app = new Hono();
  const callbackPath = getConfig().gemini.oauth_callback_path;
  const cliAuth = new GeminiCliAuthService(pool);

  app.post("/auth/gemini/login-start", (c) => {
    const config = getConfig();
    if (config.gemini.oauth_enabled === false) {
      return c.json({ error: "Gemini OAuth is disabled" }, 403);
    }
    const originalHost = c.req.header("host") || `localhost:${config.server.port}`;
    const session = createGeminiOAuthSession(originalHost);
    return c.json({ authUrl: session.authUrl, state: session.state });
  });

  app.post("/auth/gemini/code-relay", async (c) => {
    const body = await c.req.json<{ callbackUrl?: string }>();
    const callbackUrl = body.callbackUrl?.trim();
    if (!callbackUrl) return c.json({ error: "callbackUrl is required" }, 400);

    let url: URL;
    try {
      url = new URL(callbackUrl);
    } catch {
      return c.json({ error: "Invalid URL" }, 400);
    }

    return handleCallbackParams(pool, {
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
      error: url.searchParams.get("error"),
      errorDescription: url.searchParams.get("error_description"),
    }, tierFetcher);
  });

  app.get("/auth/gemini/callback", async (c) => {
    const result = await handleCallbackParams(pool, {
      code: c.req.query("code") ?? null,
      state: c.req.query("state") ?? null,
      error: c.req.query("error") ?? null,
      errorDescription: c.req.query("error_description") ?? null,
    }, tierFetcher);
    if (result.status >= 400) return c.html(callbackHtml(false), result.status === 500 ? 500 : 400);
    return c.html(callbackHtml(true));
  });

  if (callbackPath !== "/auth/gemini/callback") {
    app.get(callbackPath, async (c) => {
      const result = await handleCallbackParams(pool, {
        code: c.req.query("code") ?? null,
        state: c.req.query("state") ?? null,
        error: c.req.query("error") ?? null,
        errorDescription: c.req.query("error_description") ?? null,
      }, tierFetcher);
      if (result.status >= 400) return c.html(callbackHtml(false), result.status === 500 ? 500 : 400);
      return c.html(callbackHtml(true));
    });
  }

  app.post("/auth/gemini/import-cli", async (c) => {
    try {
      const body = await c.req.json<{ path?: string }>().catch((): { path?: string } => ({}));
      const tokens = await refreshImportedTokensIfNeeded(await importGeminiCliCredentials(body.path));
      const user = await fetchGeminiUserInfo(tokens.access_token);
      const entry = pool.addOrUpdate(createEntryFromTokens(user.email, tokens));
      await refreshGeminiTier(pool, entry, tierFetcher);
      return c.json({ success: true, account: maskOne(pool, entry.id) });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  app.get("/auth/gemini/accounts", (c) => {
    return c.json({ accounts: pool.getMaskedAccounts() });
  });

  app.get("/auth/gemini/cli-auth", (c) => {
    return c.json(cliAuth.getStatus());
  });

  app.post("/auth/gemini/cli-auth/apply", async (c) => {
    const body = await c.req.json<{ accountId?: string }>().catch((): { accountId?: string } => ({}));
    if (!body.accountId) return c.json({ error: "accountId is required" }, 400);

    try {
      const result = cliAuth.applyFromEntry(body.accountId);
      return c.json({ success: true, ...result, status: cliAuth.getStatus() });
    } catch (err) {
      if (err instanceof GeminiCliAuthError) {
        const status = err.code === "not_found" ? 404 : 400;
        return c.json({ error: err.message, code: err.code }, status);
      }
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  app.post("/auth/gemini/cli-auth/apply-default", (c) => {
    const previousStatus = cliAuth.getStatus();
    try {
      const result = cliAuth.applyDefaultAccount();
      return c.json({
        success: true,
        ...result,
        previousStatus,
        status: cliAuth.getStatus(),
      });
    } catch (err) {
      if (err instanceof GeminiCliAuthError) {
        const status = err.code === "not_found" ? 404 : 400;
        return c.json({ error: err.message, code: err.code, previousStatus }, status);
      }
      return c.json({ error: errorMessage(err), previousStatus }, 500);
    }
  });

  app.delete("/auth/gemini/accounts/:id", (c) => {
    const removed = pool.remove(c.req.param("id"));
    if (!removed) return c.json({ error: "Gemini account not found" }, 404);
    return c.json({ success: true });
  });

  app.post("/auth/gemini/accounts/:id/refresh", async (c) => {
    const id = c.req.param("id");
    const entry = pool.getEntry(id);
    if (!entry) return c.json({ error: "Gemini account not found" }, 404);
    if (!entry.refreshToken) return c.json({ error: "Gemini account has no refresh token" }, 400);

    try {
      const tokens = await refreshGeminiAccessToken(entry.refreshToken);
      pool.updateToken(id, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? entry.refreshToken,
        idToken: tokens.id_token ?? entry.idToken,
        expiresAt: expiresAtFromGeminiToken(tokens),
        scope: tokens.scope ?? entry.scope,
        tokenType: tokens.token_type,
      });
      const refreshed = pool.getEntry(id);
      if (refreshed) {
        await refreshGeminiTier(pool, refreshed, tierFetcher);
      }
      return c.json({ success: true, account: maskOne(pool, id) });
    } catch (err) {
      pool.setStatus(id, "error", errorMessage(err));
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  app.post("/auth/gemini/accounts/health-check", async (c) => {
    const body = await c.req.json<{ accountId?: string }>().catch((): { accountId?: string } => ({}));
    const accounts = body.accountId
      ? pool.getAll().filter((entry) => entry.id === body.accountId)
      : pool.getAll();
    const results = [];
    for (const entry of accounts) {
      try {
        const fresh = await tokenManager.ensureFreshAccount(entry.id);
        const user = await fetchGeminiUserInfo(fresh.accessToken);
        await refreshGeminiTier(pool, fresh, tierFetcher);
        pool.setStatus(entry.id, "active", null);
        results.push({ id: entry.id, ok: true, email: user.email });
      } catch (err) {
        pool.setStatus(entry.id, "error", errorMessage(err));
        results.push({ id: entry.id, ok: false, error: errorMessage(err) });
      }
    }
    return c.json({ results });
  });

  return app;
}

async function handleCallbackParams(
  pool: GeminiAccountPool,
  params: {
    code: string | null;
    state: string | null;
    error: string | null;
    errorDescription: string | null;
  },
  tierFetcher: GeminiTierFetcherLike,
): Promise<Response> {
  if (params.error) {
    return Response.json({ error: `OAuth error: ${params.errorDescription || params.error}` }, { status: 400 });
  }
  if (!params.code || !params.state) {
    return Response.json({ error: "URL must contain code and state parameters" }, { status: 400 });
  }

  const session = tryAcquireGeminiSession(params.state);
  if (!session) {
    if (isGeminiSessionCompleted(params.state) || isGeminiSessionExchanging(params.state)) {
      return Response.json({ success: true, alreadyCompleted: true });
    }
    return Response.json({ error: "Invalid or expired Gemini OAuth session. Please try again." }, { status: 400 });
  }

  try {
    const tokens = await exchangeGeminiCode(params.code, session.codeVerifier, session.redirectUri);
    const user = await fetchGeminiUserInfo(tokens.access_token);
    const entry = pool.addOrUpdate(createEntryFromTokens(user.email, tokens));
    await refreshGeminiTier(pool, entry, tierFetcher);
    deleteGeminiSession(params.state);
    markGeminiSessionCompleted(params.state);
    return Response.json({ success: true, account: maskOne(pool, entry.id) });
  } catch (err) {
    releaseGeminiSession(params.state);
    return Response.json({ error: `Token exchange failed: ${errorMessage(err)}` }, { status: 500 });
  }
}

async function refreshGeminiTier(
  pool: GeminiAccountPool,
  entry: GeminiAccountEntry,
  tierFetcher: GeminiTierFetcherLike,
): Promise<void> {
  try {
    await refreshGeminiAccountTier(pool, entry, tierFetcher);
  } catch (err) {
    console.warn("[GeminiAuth] Failed to fetch Code Assist tier:", errorMessage(err));
  }
}

function createEntryFromTokens(email: string, tokens: GeminiTokenResponse): GeminiAccountEntry {
  const config = getConfig();
  return {
    id: randomBytes(8).toString("hex"),
    email,
    label: null,
    status: "active",
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    idToken: tokens.id_token ?? null,
    scope: tokens.scope ?? null,
    tokenType: tokens.token_type || "Bearer",
    expiresAt: expiresAtFromGeminiToken(tokens),
    projectId: config.gemini.project_id,
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
    models: DEFAULT_GEMINI_MODELS,
  };
}

async function refreshImportedTokensIfNeeded(tokens: GeminiTokenResponse): Promise<GeminiTokenResponse> {
  const config = getConfig();
  if (config.gemini.refresh_enabled === false || !tokens.refresh_token) {
    return tokens;
  }

  const expiresAt = expiresAtFromGeminiToken(tokens);
  if (!isGeminiTokenExpiringSoon(expiresAt, config.gemini.refresh_margin_seconds)) {
    return tokens;
  }

  const refreshed = await refreshGeminiAccessToken(tokens.refresh_token);
  return {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token ?? tokens.refresh_token,
    id_token: refreshed.id_token ?? tokens.id_token,
    token_type: refreshed.token_type || tokens.token_type || "Bearer",
    expires_in: refreshed.expires_in,
    scope: refreshed.scope ?? tokens.scope,
  };
}

function maskOne(pool: GeminiAccountPool, id: string) {
  return pool.getMaskedAccounts().find((entry) => entry.id === id) ?? null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function callbackHtml(success: boolean): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Gemini Login</title></head><body>${success ? "Login successful" : "Login failed"}</body></html>`;
}
