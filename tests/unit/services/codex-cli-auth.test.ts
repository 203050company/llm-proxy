/**
 * CodexCliAuthService tests — write auth.json for the Codex CLI.
 * Uses a real temp directory under CODEX_HOME override.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
import { createValidJwt } from "@helpers/jwt.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { CodexCliAuthService, CliAuthError } from "@src/services/codex-cli-auth.js";
import type { AccountEntry } from "@src/auth/types.js";

function makePoolWith(entries: AccountEntry[]): AccountPool {
  return new AccountPool({
    persistence: createMemoryPersistence(entries),
    rotationStrategy: "least_used",
    initialToken: null,
    rateLimitBackoffSeconds: 300,
  });
}

function makeEntry(overrides: Partial<AccountEntry> = {}): AccountEntry {
  const base: AccountEntry = {
    id: "entry-abc",
    token: createValidJwt({ email: "u@example.com", accountId: "acct-1" }),
    refreshToken: "rt_test_xyz",
    email: "u@example.com",
    accountId: "acct-1",
    userId: null,
    label: null,
    planType: "plus",
    proxyApiKey: "proxy-key",
    status: "active",
    usage: {
      request_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      empty_response_count: 0,
    },
    addedAt: new Date().toISOString(),
    cachedQuota: null,
    quotaFetchedAt: null,
  };
  return { ...base, ...overrides };
}

let tmpHome: string;
let prevCodexHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(resolve(tmpdir(), "codex-cli-auth-test-"));
  prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tmpHome;
});

afterEach(() => {
  if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = prevCodexHome;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("CodexCliAuthService.resolvePath", () => {
  it("uses CODEX_HOME when set", () => {
    const pool = makePoolWith([]);
    const svc = new CodexCliAuthService(pool);
    expect(svc.resolvePath()).toBe(resolve(tmpHome, "auth.json"));
  });
});

describe("CodexCliAuthService.getStatus", () => {
  it("reports exists=false when file absent", () => {
    const pool = makePoolWith([]);
    const svc = new CodexCliAuthService(pool);
    const status = svc.getStatus();
    expect(status.exists).toBe(false);
    expect(status.currentAccountId).toBeNull();
    expect(status.matchedEntryId).toBeNull();
  });

  it("extracts email + account_id and matches proxy entry", () => {
    const token = createValidJwt({ email: "x@test.com", accountId: "acct-99" });
    const entry = makeEntry({ id: "entry-99", accountId: "acct-99", token, email: "x@test.com" });
    const pool = makePoolWith([entry]);
    const svc = new CodexCliAuthService(pool);
    writeFileSync(resolve(tmpHome, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { id_token: token, access_token: token, refresh_token: "rt", account_id: "acct-99" },
    }));
    const status = svc.getStatus();
    expect(status.exists).toBe(true);
    expect(status.currentAccountId).toBe("acct-99");
    expect(status.currentEmail).toBe("x@test.com");
    expect(status.matchedEntryId).toBe("entry-99");
    expect(status.lastModified).toMatch(/T/);
  });

  it("handles corrupt JSON without throwing", () => {
    writeFileSync(resolve(tmpHome, "auth.json"), "not json");
    const svc = new CodexCliAuthService(makePoolWith([]));
    const status = svc.getStatus();
    expect(status.exists).toBe(true);
    expect(status.currentAccountId).toBeNull();
  });
});

describe("CodexCliAuthService.applyFromEntry", () => {
  it("writes auth.json with nested tokens + creates backup on overwrite", () => {
    const token = createValidJwt({ accountId: "acct-1" });
    const idToken = "real-id-token";
    const entry = makeEntry({ id: "e1", token, idToken, accountId: "acct-1", refreshToken: "rt_a" });
    const pool = makePoolWith([entry]);
    const svc = new CodexCliAuthService(pool);

    // First apply: no backup.
    const first = svc.applyFromEntry("e1");
    expect(first.backupPath).toBeNull();
    expect(existsSync(first.path)).toBe(true);
    const body = JSON.parse(readFileSync(first.path, "utf-8"));
    expect(body.auth_mode).toBe("chatgpt");
    expect(body.tokens.access_token).toBe(token);
    expect(body.tokens.id_token).toBe(idToken);
    expect(body.tokens.refresh_token).toBe("rt_a");
    expect(body.tokens.account_id).toBe("acct-1");

    // Second apply: backup is written.
    const second = svc.applyFromEntry("e1");
    expect(second.backupPath).toBeTruthy();
    expect(existsSync(second.backupPath!)).toBe(true);
  });

  it("sets file permissions to 0600 on POSIX", () => {
    if (process.platform === "win32") return;
    const entry = makeEntry();
    const svc = new CodexCliAuthService(makePoolWith([entry]));
    const res = svc.applyFromEntry(entry.id);
    const mode = statSync(res.path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("throws not_found for unknown entry", () => {
    const svc = new CodexCliAuthService(makePoolWith([]));
    expect(() => svc.applyFromEntry("missing")).toThrowError(CliAuthError);
  });

  it("throws no_refresh_token when refreshToken missing", () => {
    const entry = makeEntry({ refreshToken: null });
    const svc = new CodexCliAuthService(makePoolWith([entry]));
    expect(() => svc.applyFromEntry(entry.id)).toThrowError(/refresh token/i);
  });

  it("throws no_account_id when accountId missing", () => {
    const entry = makeEntry({ accountId: null });
    const svc = new CodexCliAuthService(makePoolWith([entry]));
    expect(() => svc.applyFromEntry(entry.id)).toThrowError(/accountId/i);
  });

  it("prunes backups beyond MAX_BACKUPS (5)", async () => {
    const entry = makeEntry();
    const svc = new CodexCliAuthService(makePoolWith([entry]));
    // Seed initial file, then apply several times to trigger rotation.
    svc.applyFromEntry(entry.id);
    for (let i = 0; i < 7; i++) {
      await new Promise((r) => setTimeout(r, 5));
      svc.applyFromEntry(entry.id);
    }
    const backups = readdirSync(tmpHome).filter((n) => n.startsWith("auth.json.bak."));
    expect(backups.length).toBeLessThanOrEqual(5);
  });
});
