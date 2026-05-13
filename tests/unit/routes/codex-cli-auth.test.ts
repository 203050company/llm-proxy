/**
 * Admin routes for Codex CLI auth.json management.
 * GET  /admin/codex-cli-auth       — read current CLI session state
 * POST /admin/codex-cli-auth/apply — replace ~/.codex/auth.json with proxy-held tokens
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

const mockConfig = {
  server: { port: 8080, proxy_api_key: null as string | null },
  tls: { proxy_url: null as string | null, force_http11: false },
  model: { default: "gpt-5.3-codex", default_reasoning_effort: null as string | null, inject_desktop_context: false, suppress_desktop_directives: true },
  quota: { refresh_interval_minutes: 5, warning_thresholds: { primary: [80, 90], secondary: [80, 90] }, skip_exhausted: true },
  auth: { rotation_strategy: "least_used", refresh_enabled: true, refresh_margin_seconds: 300, refresh_concurrency: 2, max_concurrent_per_account: 3 as number | null, request_interval_ms: 50 as number | null, rate_limit_backoff_seconds: 300, jwt_token: null as string | null },
  update: { auto_update: true, auto_download: false },
};
const validSessions = new Set<string>();

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
  reloadAllConfigs: vi.fn(),
  getLocalConfigPath: vi.fn(() => "/tmp/test/local.yaml"),
  ROTATION_STRATEGIES: ["least_used", "round_robin", "sticky"],
}));

vi.mock("@src/paths.js", () => ({
  getConfigDir: vi.fn(() => "/tmp/test-config"),
  getPublicDir: vi.fn(() => "/tmp/test-public"),
  getDesktopPublicDir: vi.fn(() => "/tmp/test-desktop"),
  getDataDir: vi.fn(() => "/tmp/test-data"),
  getBinDir: vi.fn(() => "/tmp/test-bin"),
  isEmbedded: vi.fn(() => false),
}));

vi.mock("@src/utils/yaml-mutate.js", () => ({ mutateYaml: vi.fn() }));
vi.mock("@src/tls/transport.js", () => ({ getTransport: vi.fn(), getTransportInfo: vi.fn(() => ({})) }));
vi.mock("@src/fingerprint/manager.js", () => ({ buildHeaders: vi.fn(() => ({})) }));
vi.mock("@src/update-checker.js", () => ({ getUpdateState: vi.fn(() => ({})), checkForUpdate: vi.fn(), isUpdateInProgress: vi.fn(() => false) }));
vi.mock("@src/self-update.js", () => ({ getProxyInfo: vi.fn(() => ({})), canSelfUpdate: vi.fn(() => false), checkProxySelfUpdate: vi.fn(), applyProxySelfUpdate: vi.fn(), isProxyUpdateInProgress: vi.fn(() => false), getCachedProxyUpdateResult: vi.fn(() => null), getDeployMode: vi.fn(() => "git") }));
vi.mock("@hono/node-server/serve-static", () => ({ serveStatic: vi.fn(() => vi.fn()) }));
vi.mock("@hono/node-server/conninfo", () => ({ getConnInfo: vi.fn(() => ({ remote: { address: "127.0.0.1" } })) }));
vi.mock("@src/auth/dashboard-session.js", () => ({ validateSession: vi.fn((id: string) => validSessions.has(id)) }));

import { createWebRoutes } from "@src/routes/web.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
import { createValidJwt } from "@helpers/jwt.js";
import type { AccountEntry } from "@src/auth/types.js";

function makeEntry(overrides: Partial<AccountEntry> = {}): AccountEntry {
  const base: AccountEntry = {
    id: "entry-1",
    token: createValidJwt({ email: "a@test.com", accountId: "acct-A" }),
    refreshToken: "rt_a",
    email: "a@test.com",
    accountId: "acct-A",
    userId: null,
    label: null,
    planType: "plus",
    proxyApiKey: "px",
    status: "active",
    usage: { request_count: 0, input_tokens: 0, output_tokens: 0, empty_response_count: 0 },
    addedAt: new Date().toISOString(),
    cachedQuota: null,
    quotaFetchedAt: null,
  };
  return { ...base, ...overrides };
}

let tmpHome: string;

function makeAppWith(entries: AccountEntry[]) {
  const pool = new AccountPool({
    persistence: createMemoryPersistence(entries),
    rotationStrategy: "least_used",
    initialToken: null,
    rateLimitBackoffSeconds: 300,
  });
  return createWebRoutes(pool as Parameters<typeof createWebRoutes>[0], {} as Parameters<typeof createWebRoutes>[1]);
}

beforeEach(() => {
  tmpHome = mkdtempSync(resolve(tmpdir(), "cli-auth-route-"));
  process.env.CODEX_HOME = tmpHome;
  mockConfig.server.proxy_api_key = null;
  validSessions.clear();
});

afterEach(() => {
  delete process.env.CODEX_HOME;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("GET /admin/codex-cli-auth", () => {
  it("returns exists=false when file absent", async () => {
    const app = makeAppWith([]);
    const res = await app.request("/admin/codex-cli-auth");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.exists).toBe(false);
    expect(data.path).toBe(resolve(tmpHome, "auth.json"));
  });
});

describe("POST /admin/codex-cli-auth/apply", () => {
  it("applies entry tokens and returns updated status", async () => {
    const entry = makeEntry();
    const app = makeAppWith([entry]);
    const res = await app.request("/admin/codex-cli-auth/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: entry.id }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.status.exists).toBe(true);
    expect(data.status.currentAccountId).toBe("acct-A");
    expect(data.status.matchedEntryId).toBe(entry.id);

    const written = JSON.parse(readFileSync(resolve(tmpHome, "auth.json"), "utf-8"));
    expect(written.tokens.refresh_token).toBe("rt_a");
  });

  it("rejects missing accountId", async () => {
    const app = makeAppWith([makeEntry()]);
    const res = await app.request("/admin/codex-cli-auth/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown entry id", async () => {
    const app = makeAppWith([makeEntry()]);
    const res = await app.request("/admin/codex-cli-auth/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "does-not-exist" }),
    });
    expect(res.status).toBe(404);
  });

  it("requires admin auth when proxy_api_key is set", async () => {
    mockConfig.server.proxy_api_key = "secret-123";
    const app = makeAppWith([makeEntry()]);
    const res = await app.request("/admin/codex-cli-auth/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "entry-1" }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts bearer token matching proxy_api_key", async () => {
    mockConfig.server.proxy_api_key = "secret-123";
    const entry = makeEntry();
    const app = makeAppWith([entry]);
    const res = await app.request("/admin/codex-cli-auth/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret-123" },
      body: JSON.stringify({ accountId: entry.id }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(resolve(tmpHome, "auth.json"))).toBe(true);
  });

  it("rotates backups on repeated apply", async () => {
    const entry = makeEntry();
    const app = makeAppWith([entry]);
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 5));
      await app.request("/admin/codex-cli-auth/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: entry.id }),
      });
    }
    const backups = readdirSync(tmpHome).filter((n) => n.startsWith("auth.json.bak."));
    expect(backups.length).toBe(2); // first apply has no prior file to back up
  });
});
