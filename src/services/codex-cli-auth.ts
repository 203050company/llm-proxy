/**
 * CodexCliAuthService — read and apply Codex CLI auth.json from proxy accounts.
 *
 * The local Codex CLI reads credentials from `$CODEX_HOME/auth.json`
 * (default `~/.codex/auth.json`). This service lets the dashboard swap the
 * CLI's active session to any proxy-registered account.
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
  /** account_id from tokens (OpenAI side). Null if missing or unreadable. */
  currentAccountId: string | null;
  /** Email extracted from JWT claims. Null if absent. */
  currentEmail: string | null;
  /** Proxy entry id whose accountId matches. Null if no match. */
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

export class CodexCliAuthService {
  constructor(private pool: AccountPool) {}

  resolvePath(): string {
    const home = process.env.CODEX_HOME;
    const base = home && home.length > 0 ? home : resolve(homedir(), ".codex");
    return resolve(base, "auth.json");
  }

  getStatus(): CliAuthStatus {
    const path = this.resolvePath();
    if (!existsSync(path)) {
      return { path, exists: false, currentAccountId: null, currentEmail: null, matchedEntryId: null, lastModified: null };
    }

    let accountId: string | null = null;
    let email: string | null = null;
    let lastModified: string | null = null;
    try {
      lastModified = statSync(path).mtime.toISOString();
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const tokens = (parsed.tokens && typeof parsed.tokens === "object" ? parsed.tokens : parsed) as Record<string, unknown>;
      accountId = typeof tokens.account_id === "string" ? tokens.account_id : null;
      const accessToken = typeof tokens.access_token === "string" ? tokens.access_token : null;
      if (accessToken) email = extractEmailFromJwt(accessToken);
    } catch {
      // Corrupt file — treat as unreadable but existing.
      return { path, exists: true, currentAccountId: null, currentEmail: null, matchedEntryId: null, lastModified };
    }

    let matchedEntryId: string | null = null;
    if (accountId) {
      for (const entry of this.pool.getAllEntries()) {
        if (entry.accountId === accountId) {
          matchedEntryId = entry.id;
          break;
        }
      }
    }

    return { path, exists: true, currentAccountId: accountId, currentEmail: email, matchedEntryId, lastModified };
  }

  applyFromEntry(entryId: string): ApplyResult {
    const entry = this.pool.getEntry(entryId);
    if (!entry) throw new CliAuthError("Account not found", "not_found");
    if (!entry.refreshToken) throw new CliAuthError("Account has no refresh token — cannot apply to CLI", "no_refresh_token");
    if (!entry.accountId) throw new CliAuthError("Account has no accountId — cannot apply to CLI", "no_account_id");

    const path = this.resolvePath();
    // Safety: reject path traversal / non-auth filename (resolvePath already
    // returns an absolute path, but CODEX_HOME is user-controlled).
    if (!isAbsolute(path) || basename(path) !== "auth.json") {
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
      // chmod may fail on some filesystems (Windows, some Docker mounts) — non-fatal.
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
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: entry.idToken ?? entry.token,
      access_token: entry.token,
      refresh_token: entry.refreshToken,
      account_id: entry.accountId,
    },
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
