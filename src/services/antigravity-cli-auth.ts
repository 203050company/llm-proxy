/**
 * AntigravityCliAuthService — read and apply Antigravity CLI oauth token from proxy accounts.
 *
 * The local Antigravity CLI reads credentials from `$ANTIGRAVITY_HOME/antigravity-oauth-token`
 * (default `~/.gemini/antigravity-cli/antigravity-oauth-token`). This service lets the dashboard
 * swap the CLI's active session to any proxy-registered account.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync, statSync, unlinkSync, readdirSync } from "fs";
import { resolve, dirname, basename, isAbsolute } from "path";
import { homedir } from "os";
import type { AccountPool } from "../auth/account-pool.js";
import type { AccountEntry } from "../auth/types.js";

export interface CliAuthStatus {
  /** Absolute path that would be read/written. */
  path: string;
  /** True if the file exists and is readable. */
  exists: boolean;
  /** account_id/userId from proxy account. Null if missing or unreadable. */
  currentAccountId: string | null;
  /** Email extracted from proxy account or JWT. Null if absent. */
  currentEmail: string | null;
  /** Proxy entry id whose token or refreshToken matches. Null if no match. */
  matchedEntryId: string | null;
  /** Last write time ISO, null if file missing. */
  lastModified: string | null;
}

export interface ApplyResult {
  path: string;
  email: string | null;
  accountId: string | null;
  backupPath: string | null;
}

const MAX_BACKUPS = 5;

export class AntigravityCliAuthService {
  constructor(private pool: AccountPool) {}

  resolvePath(): string {
    const home = process.env.ANTIGRAVITY_HOME;
    const base = home && home.length > 0 
      ? home 
      : resolve(homedir(), ".gemini", "antigravity-cli");
    return resolve(base, "antigravity-oauth-token");
  }

  getStatus(): CliAuthStatus {
    const path = this.resolvePath();
    if (!existsSync(path)) {
      return { path, exists: false, currentAccountId: null, currentEmail: null, matchedEntryId: null, lastModified: null };
    }

    let accessToken: string | null = null;
    let refreshToken: string | null = null;
    let lastModified: string | null = null;

    try {
      lastModified = statSync(path).mtime.toISOString();
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const tokenObj = (parsed.token && typeof parsed.token === "object" ? parsed.token : {}) as Record<string, unknown>;
      accessToken = typeof tokenObj.access_token === "string" ? tokenObj.access_token : null;
      refreshToken = typeof tokenObj.refresh_token === "string" ? tokenObj.refresh_token : null;
    } catch {
      // Corrupt file — treat as unreadable but existing.
      return { path, exists: true, currentAccountId: null, currentEmail: null, matchedEntryId: null, lastModified };
    }

    let matchedEntryId: string | null = null;
    let currentEmail: string | null = null;
    let currentAccountId: string | null = null;

    if (accessToken || refreshToken) {
      for (const entry of this.pool.getAllEntries()) {
        const tokenMatches = accessToken && entry.token === accessToken;
        const refreshMatches = refreshToken && entry.refreshToken === refreshToken;
        if (tokenMatches || refreshMatches) {
          matchedEntryId = entry.id;
          currentEmail = entry.email;
          currentAccountId = entry.accountId;
          break;
        }
      }
    }

    // If we didn't match any entry but have access token, try to extract email from JWT as fallback
    if (!currentEmail && accessToken) {
      currentEmail = extractEmailFromJwt(accessToken);
    }

    return { 
      path, 
      exists: true, 
      currentAccountId, 
      currentEmail, 
      matchedEntryId, 
      lastModified 
    };
  }

  applyFromEntry(entryId: string): ApplyResult {
    const entry = this.pool.getEntry(entryId);
    if (!entry) throw new CliAuthError("Account not found", "not_found");
    if (!entry.refreshToken) throw new CliAuthError("Account has no refresh token — cannot apply to CLI", "no_refresh_token");
    if (!entry.accountId) throw new CliAuthError("Account has no accountId — cannot apply to CLI", "no_account_id");

    const path = this.resolvePath();
    // Safety: reject path traversal / non-token filename
    if (!isAbsolute(path) || basename(path) !== "antigravity-oauth-token") {
      throw new CliAuthError(`Refusing to write to invalid path: ${path}`, "bad_path");
    }

    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });

    const backupPath = rotateBackup(path);

    const payload = buildAuthJson(entry);
    // Atomic write: write to tmp in same dir, fsync-free rename.
    const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf-8");
    try {
      chmodSync(tmpPath, 0o600);
    } catch {
      // chmod may fail on some filesystems — non-fatal.
    }
    renameSync(tmpPath, path);

    return { path, email: entry.email, accountId: entry.accountId, backupPath };
  }
}

export class CliAuthError extends Error {
  constructor(message: string, public readonly code: "not_found" | "no_refresh_token" | "no_account_id" | "bad_path") {
    super(message);
    this.name = "CliAuthError";
  }
}

function buildAuthJson(entry: AccountEntry): Record<string, unknown> {
  // Extract expiry from token JWT if possible, otherwise default to 1 hour from now
  let expiry = new Date(Date.now() + 3600 * 1000).toISOString();
  if (entry.token) {
    const parts = entry.token.split(".");
    if (parts.length >= 2) {
      try {
        const payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
        const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
        const decoded = JSON.parse(Buffer.from(padded, "base64").toString("utf-8")) as Record<string, unknown>;
        if (typeof decoded.exp === "number") {
          expiry = new Date(decoded.exp * 1000).toISOString();
        }
      } catch {
        // ignore
      }
    }
  }

  return {
    auth_method: "consumer",
    token: {
      access_token: entry.token,
      expiry: expiry,
      refresh_token: entry.refreshToken ?? "",
      token_type: "Bearer"
    }
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
  // Prune older backups beyond MAX_BACKUPS.
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

function extractEmailFromJwt(token: string): string | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const decoded = JSON.parse(Buffer.from(padded, "base64").toString("utf-8")) as Record<string, unknown>;
    // Try standard email claims
    if (typeof decoded.email === "string") return decoded.email;
    
    // Check specific profiles
    const profile = decoded["https://api.openai.com/profile"];
    if (profile && typeof profile === "object") {
      const email = (profile as Record<string, unknown>).email;
      if (typeof email === "string") return email;
    }
  } catch {
    // ignore — malformed token
  }
  return null;
}
