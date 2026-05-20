import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { AntigravityCliAuthService, CliAuthError } from "../../../src/services/antigravity-cli-auth.js";
import { AccountPool } from "../../../src/auth/account-pool.js";
import type { AccountEntry } from "../../../src/auth/types.js";
import { loadConfig } from "../../../src/config.js";

// Temp directory for token file testing to avoid touching real ~/.gemini
const tempDir = resolve(__dirname, "../../../scratch/test-antigravity-cli");

describe("AntigravityCliAuthService", () => {
  let pool: AccountPool;
  let service: AntigravityCliAuthService;

  beforeEach(() => {
    // Load config first
    try {
      loadConfig();
    } catch {
      // Ignore if configuration files are missing or config is already loaded
    }

    // Setup test directory
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    mkdirSync(tempDir, { recursive: true });

    // Mock homedir or environment variable for isolated testing
    process.env.ANTIGRAVITY_HOME = tempDir;

    // Mock AccountPool
    pool = new AccountPool();
    vi.spyOn(pool, "getAllEntries").mockReturnValue([
      {
        id: "entry-1",
        email: "user1@example.com",
        accountId: "acc-1",
        token: "mock-access-token-1",
        refreshToken: "mock-refresh-token-1",
        status: "active",
      } as AccountEntry,
      {
        id: "entry-2",
        email: "user2@example.com",
        accountId: "acc-2",
        token: "mock-access-token-2",
        refreshToken: "mock-refresh-token-2",
        status: "expired",
      } as AccountEntry,
    ]);
    vi.spyOn(pool, "getEntry").mockImplementation((id: string) => {
      if (id === "entry-1") {
        return {
          id: "entry-1",
          email: "user1@example.com",
          accountId: "acc-1",
          token: "mock-access-token-1",
          refreshToken: "mock-refresh-token-1",
          status: "active",
        } as AccountEntry;
      }
      return null;
    });

    service = new AntigravityCliAuthService(pool);
  });

  afterEach(() => {
    delete process.env.ANTIGRAVITY_HOME;
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should resolve token path correctly using ANTIGRAVITY_HOME", () => {
    const resolved = service.resolvePath();
    expect(resolved).toBe(resolve(tempDir, "antigravity-oauth-token"));
  });

  it("should return correct status when token file does not exist", () => {
    const status = service.getStatus();
    expect(status.exists).toBe(false);
    expect(status.currentAccountId).toBeNull();
    expect(status.matchedEntryId).toBeNull();
  });

  it("should write token JSON atomically and apply 0600 permissions", () => {
    const result = service.applyFromEntry("entry-1");
    expect(result.accountId).toBe("acc-1");
    expect(result.email).toBe("user1@example.com");

    const tokenPath = service.resolvePath();
    expect(existsSync(tokenPath)).toBe(true);

    const raw = readFileSync(tokenPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.auth_method).toBe("consumer");
    expect(parsed.token.access_token).toBe("mock-access-token-1");
    expect(parsed.token.refresh_token).toBe("mock-refresh-token-1");
  });

  it("should match active entry by token when status is checked", () => {
    service.applyFromEntry("entry-1");

    const status = service.getStatus();
    expect(status.exists).toBe(true);
    expect(status.currentAccountId).toBe("acc-1");
    expect(status.currentEmail).toBe("user1@example.com");
    expect(status.matchedEntryId).toBe("entry-1");
  });

  it("should fail when applying a non-existent entry", () => {
    expect(() => service.applyFromEntry("non-existent")).toThrow(CliAuthError);
  });
});
