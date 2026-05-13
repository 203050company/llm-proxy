import { getConfig } from "../config.js";
import type { GeminiAccountPool } from "./gemini-account-pool.js";
import type { GeminiAccountEntry } from "./gemini-types.js";
import { refreshGeminiAccessToken, type GeminiTokenResponse } from "./gemini-oauth.js";

interface GeminiTokenManagerDeps {
  refreshAccessToken?: (refreshToken: string) => Promise<GeminiTokenResponse>;
}

export function isGeminiTokenExpiringSoon(
  expiresAt: string | null,
  marginSeconds: number,
  now = Date.now(),
): boolean {
  if (!expiresAt) return true;
  const expiryMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiryMs)) return true;
  return expiryMs <= now + marginSeconds * 1000;
}

export function expiresAtFromGeminiToken(
  token: Pick<GeminiTokenResponse, "expires_in">,
  now = Date.now(),
): string | null {
  if (typeof token.expires_in !== "number") return null;
  return new Date(now + token.expires_in * 1000).toISOString();
}

export class GeminiTokenManager {
  private readonly refreshAccessToken: (refreshToken: string) => Promise<GeminiTokenResponse>;
  private readonly inFlight = new Map<string, Promise<GeminiAccountEntry>>();

  constructor(
    private readonly pool: GeminiAccountPool,
    deps: GeminiTokenManagerDeps = {},
  ) {
    this.refreshAccessToken = deps.refreshAccessToken ?? refreshGeminiAccessToken;
  }

  async ensureFreshAccount(accountId: string): Promise<GeminiAccountEntry> {
    const existing = this.inFlight.get(accountId);
    if (existing) return existing;

    const promise = this.ensureFreshAccountOnce(accountId);
    this.inFlight.set(accountId, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(accountId);
    }
  }

  private async ensureFreshAccountOnce(accountId: string): Promise<GeminiAccountEntry> {
    const account = this.pool.getEntry(accountId);
    if (!account) {
      throw new Error(`Gemini account not found: ${accountId}`);
    }

    const config = getConfig();
    if (!isGeminiTokenExpiringSoon(account.expiresAt, config.gemini.refresh_margin_seconds)) {
      return account;
    }

    if (!config.gemini.refresh_enabled) {
      return account;
    }

    if (!account.refreshToken) {
      this.pool.setStatus(account.id, "expired", "missing_refresh_token");
      throw new Error(`Gemini account has no refresh token: ${account.email}`);
    }

    try {
      const token = await this.refreshAccessToken(account.refreshToken);
      const expiresAt = expiresAtFromGeminiToken(token) ?? account.expiresAt;
      const updated = this.pool.updateToken(account.id, {
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? account.refreshToken,
        idToken: token.id_token ?? account.idToken,
        expiresAt,
        scope: token.scope ?? account.scope,
        tokenType: token.token_type ?? account.tokenType,
      });

      if (!updated) {
        throw new Error(`Gemini account disappeared during refresh: ${account.id}`);
      }

      const refreshed = this.pool.getEntry(account.id);
      if (!refreshed) {
        throw new Error(`Gemini account not found after refresh: ${account.id}`);
      }
      return refreshed;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.pool.setStatus(account.id, "expired", message);
      throw err;
    }
  }
}
