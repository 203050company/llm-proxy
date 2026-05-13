/**
 * GeminiCliAuthService — read and apply Gemini CLI oauth_creds.json from proxy accounts.
 *
 * The Gemini CLI reads OAuth credentials from `~/.gemini/oauth_creds.json`
 * by default. This service lets the dashboard swap the CLI's active session
 * to any proxy-registered Gemini OAuth account.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync, statSync, unlinkSync, readdirSync } from "fs";
import { basename, dirname, isAbsolute, resolve } from "path";
import { homedir } from "os";
import { getConfig } from "../config.js";
import type { GeminiAccountPool } from "../auth/gemini-account-pool.js";
import type { GeminiAccountEntry } from "../auth/gemini-types.js";

export interface GeminiCliAuthStatus {
  /** Absolute path that would be read/written. */
  path: string;
  /** True if the file exists and is readable. */
  exists: boolean;
  /** Email stored by this proxy when it applied the CLI session. */
  currentEmail: string | null;
  /** Proxy entry id whose refresh token matches the CLI session. */
  matchedEntryId: string | null;
  /** Last write time ISO, null if file missing. */
  lastModified: string | null;
}

export interface GeminiCliApplyResult {
  path: string;
  email: string | null;
  backupPath: string | null;
}

export interface GeminiCliApplyDefaultResult extends GeminiCliApplyResult {
  accountId: string;
}

interface RawGeminiCliCredentials {
  email?: unknown;
  tokens?: {
    access_token?: unknown;
    refresh_token?: unknown;
    id_token?: unknown;
    token_type?: unknown;
    scope?: unknown;
  } | null;
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  token_type?: unknown;
  scope?: unknown;
  expiry_date?: unknown;
  expires_at?: unknown;
}

const MAX_BACKUPS = 5;

export class GeminiCliAuthService {
  constructor(
    private pool: GeminiAccountPool,
    private readonly credentialsPath?: string,
  ) {}

  resolvePath(): string {
    const configured = this.credentialsPath ?? getConfig().gemini.credentials_path;
    return resolve(expandHome(configured));
  }

  getStatus(): GeminiCliAuthStatus {
    const path = this.resolvePath();
    if (!existsSync(path)) {
      return { path, exists: false, currentEmail: null, matchedEntryId: null, lastModified: null };
    }

    let refreshToken: string | null = null;
    let email: string | null = null;
    let lastModified: string | null = null;
    try {
      lastModified = statSync(path).mtime.toISOString();
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw) as RawGeminiCliCredentials;
      const tokens = parsed.tokens && typeof parsed.tokens === "object" ? parsed.tokens : parsed;
      refreshToken = typeof tokens.refresh_token === "string" ? tokens.refresh_token : null;
      email = typeof parsed.email === "string" ? parsed.email : null;
    } catch {
      return { path, exists: true, currentEmail: null, matchedEntryId: null, lastModified };
    }

    let matchedEntryId: string | null = null;
    if (refreshToken) {
      for (const entry of this.pool.getAll()) {
        if (entry.refreshToken === refreshToken) {
          matchedEntryId = entry.id;
          email = entry.email;
          break;
        }
      }
    }

    // Fallback: match by email if token match fails (e.g. after refresh)
    if (!matchedEntryId && email) {
      for (const entry of this.pool.getAll()) {
        if (entry.email === email) {
          matchedEntryId = entry.id;
          break;
        }
      }
    }

    return { path, exists: true, currentEmail: email, matchedEntryId, lastModified };
  }

  applyFromEntry(entryId: string): GeminiCliApplyResult {
    const entry = this.pool.getEntry(entryId);
    if (!entry) throw new GeminiCliAuthError("Gemini account not found", "not_found");
    if (!entry.refreshToken) {
      throw new GeminiCliAuthError("Gemini account has no refresh token — cannot apply to CLI", "no_refresh_token");
    }

    const path = this.resolvePath();
    if (!isAbsolute(path) || basename(path) !== "oauth_creds.json") {
      throw new GeminiCliAuthError(`Refusing to write to invalid path: ${path}`, "bad_path");
    }

    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    const backupPath = rotateBackup(path);
    const payload = buildOAuthCredsJson(entry);
    const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf-8");
    try {
      chmodSync(tmpPath, 0o600);
    } catch {
      // chmod may fail on some filesystems (Windows, some Docker mounts) — non-fatal.
    }
    renameSync(tmpPath, path);

    // Sync google_accounts.json if possible
    try {
      const googleAccountsPath = resolve(dir, "google_accounts.json");
      if (existsSync(googleAccountsPath)) {
        const raw = readFileSync(googleAccountsPath, "utf-8");
        const data = JSON.parse(raw) as { active: string; old: string[] };
        if (data.active !== entry.email) {
          if (!data.old.includes(data.active)) data.old.push(data.active);
          data.active = entry.email;
          writeFileSync(googleAccountsPath, JSON.stringify(data, null, 2), "utf-8");
        }
      }
    } catch { /* ignore */ }

    // Clear legacy credentials to force refresh from oauth_creds.json
    try {
      const legacyPath = resolve(dir, "gemini-credentials.json");
      if (existsSync(legacyPath)) {
        unlinkSync(legacyPath);
      }
      const statePath = resolve(dir, "state.json");
      if (existsSync(statePath)) {
        unlinkSync(statePath);
      }
    } catch { /* ignore */ }

    return { path, email: entry.email, backupPath };
  }

  applyDefaultAccount(): GeminiCliApplyDefaultResult {
    const entry = this.pickDefaultEntry();
    if (!entry) {
      throw new GeminiCliAuthError(
        "No active Gemini account with a refresh token is available for CLI auth",
        "no_default_account",
      );
    }
    const result = this.applyFromEntry(entry.id);
    return { accountId: entry.id, ...result };
  }

  private pickDefaultEntry(): GeminiAccountEntry | null {
    const candidates = this.pool.getAll()
      .filter((entry) => entry.status === "active")
      .filter((entry) => Boolean(entry.refreshToken));
    if (candidates.length === 0) return null;

    return [...candidates].sort(compareDefaultCliAccount)[0] ?? null;
  }
}

export class GeminiCliAuthError extends Error {
  constructor(
    message: string,
    public readonly code: "not_found" | "no_refresh_token" | "bad_path" | "no_default_account",
  ) {
    super(message);
    this.name = "GeminiCliAuthError";
  }
}

function compareDefaultCliAccount(left: GeminiAccountEntry, right: GeminiAccountEntry): number {
  return accountRank(left) - accountRank(right) ||
    modelRank(left) - modelRank(right) ||
    left.email.localeCompare(right.email) ||
    left.id.localeCompare(right.id);
}

function accountRank(entry: GeminiAccountEntry): number {
  const subscription = entry.googleAiSubscription;
  if (subscription?.source === "code-assist-paid-tier") {
    if (subscription.tier === "Ultra") return 0;
    if (subscription.tier === "Pro") return 1;
    if (subscription.tier === "Plus") return 2;
    return 3;
  }
  if (entry.paidTier != null) return 3;
  return 10;
}

function modelRank(entry: GeminiAccountEntry): number {
  return entry.models.includes("gemini-3.1-pro") ? 0 : 1;
}

function buildOAuthCredsJson(entry: GeminiAccountEntry): Record<string, unknown> {
  return {
    access_token: entry.accessToken,
    refresh_token: entry.refreshToken,
    id_token: entry.idToken ?? undefined,
    scope: entry.scope ?? undefined,
    token_type: entry.tokenType || "Bearer",
    expiry_date: entry.expiresAt ? new Date(entry.expiresAt).getTime() : undefined,
    tokens: {
      access_token: entry.accessToken,
      refresh_token: entry.refreshToken,
      id_token: entry.idToken ?? undefined,
      scope: entry.scope ?? undefined,
      token_type: entry.tokenType || "Bearer",
    },
    email: entry.email,
    last_refresh: new Date().toISOString(),
  };
}

function rotateBackup(authPath: string): string | null {
  if (!existsSync(authPath)) return null;
  const dir = dirname(authPath);
  const base = basename(authPath);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = resolve(dir, `${base}.bak.${ts}`);
  try {
    const current = readFileSync(authPath);
    writeFileSync(backupPath, current);
  } catch {
    return null;
  }

  try {
    const prefix = `${base}.bak.`;
    const entries = readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => ({ name, path: resolve(dir, name), mtime: statSync(resolve(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const old of entries.slice(MAX_BACKUPS)) {
      try { unlinkSync(old.path); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  return backupPath;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}
