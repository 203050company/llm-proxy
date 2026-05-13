import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createMockConfig } from "@helpers/config.js";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";
import { createValidJwt } from "@helpers/jwt.js";

const mockConfig = createMockConfig({
  server: { proxy_api_key: null, trust_proxy: false },
  session: { ttl_minutes: 60, cleanup_interval_minutes: 5 },
});

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
  reloadAllConfigs: vi.fn(),
  getLocalConfigPath: vi.fn(() => "/tmp/test/local.yaml"),
  ROTATION_STRATEGIES: ["least_used", "round_robin", "sticky"],
}));

vi.mock("@src/models/model-store.js", () => ({
  getModelPlanTypes: vi.fn(() => []),
  isPlanFetched: vi.fn(() => true),
}));

vi.mock("@src/utils/jitter.js", () => ({
  jitter: vi.fn((val: number) => val),
  jitterInt: vi.fn((val: number) => val),
}));

vi.mock("@src/auth/oauth-pkce.js", () => ({
  startOAuthFlow: vi.fn(),
  refreshAccessToken: vi.fn(),
}));

const mockGetConnInfo = vi.fn(() => ({ remote: { address: "192.168.1.100" } }));
vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: (...args: unknown[]) => mockGetConnInfo(...args),
}));

vi.mock("@src/auth/dashboard-session.js", async () => {
  const validSessions = new Set<string>();
  return {
    validateSession: vi.fn((id: string) => validSessions.has(id)),
    _addTestSession: (id: string) => validSessions.add(id),
    _clearTestSessions: () => validSessions.clear(),
  };
});

import { dashboardAuth } from "@src/middleware/dashboard-auth.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { createAccountRoutes } from "@src/routes/accounts.js";
import { AccountLogStore } from "@src/services/account-log-store.js";

const sessionMod = await import("@src/auth/dashboard-session.js") as {
  _addTestSession: (id: string) => void;
  _clearTestSessions: () => void;
};

const mockScheduler = {
  scheduleOne: vi.fn(),
  clearOne: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  getSnapshot: vi.fn(() => ({
    nextRefreshAt: null,
    refreshState: "idle",
    refreshInFlight: false,
    refreshBlockedReason: null,
  })),
};

function createPool(): AccountPool {
  return new AccountPool({
    persistence: createMemoryPersistence(),
    rotationStrategy: "least_used",
    initialToken: null,
    rateLimitBackoffSeconds: 60,
  });
}

function createApp(pool: AccountPool, store?: AccountLogStore): Hono {
  const app = new Hono();
  app.use("*", dashboardAuth);
  app.route("/", createAccountRoutes(pool, mockScheduler as never, undefined, undefined, store));
  return app;
}

describe("GET /auth/accounts/:id/logs", () => {
  let pool: AccountPool;
  let store: AccountLogStore;
  let accountId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.server.proxy_api_key = null;
    mockConfig.server.trust_proxy = false;
    mockGetConnInfo.mockReturnValue({ remote: { address: "192.168.1.100" } });
    sessionMod._clearTestSessions();

    pool = createPool();
    store = new AccountLogStore();
    accountId = pool.addAccount(createValidJwt({ accountId: "acct-logs", email: "logs@test.com" }));
  });

  it("returns logs and nextSince for an existing account", async () => {
    store.append(accountId, {
      category: "proxy",
      level: "info",
      eventType: "proxy.request_started",
      requestId: "req-1",
    });
    const second = store.append(accountId, {
      category: "auth",
      level: "warn",
      eventType: "auth.refresh.retry_scheduled",
    });

    const res = await createApp(pool, store).request(`/auth/accounts/${accountId}/logs`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.accountId).toBe(accountId);
    expect(body.logs).toHaveLength(2);
    expect(body.logs.map((log: { eventType: string }) => log.eventType)).toEqual([
      "proxy.request_started",
      "auth.refresh.retry_scheduled",
    ]);
    expect(body.nextSince).toBe(second.seq);
  });

  it("supports limit, since, level, and category query filters", async () => {
    const first = store.append(accountId, {
      category: "proxy",
      level: "info",
      eventType: "proxy.request_started",
    });
    store.append(accountId, {
      category: "auth",
      level: "warn",
      eventType: "auth.refresh.retry_scheduled",
    });
    store.append(accountId, {
      category: "proxy",
      level: "error",
      eventType: "proxy.request_error",
    });

    const res = await createApp(pool, store).request(
      `/auth/accounts/${accountId}/logs?since=${first.seq}&level=error&category=proxy&limit=1`,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.logs.map((log: { eventType: string }) => log.eventType)).toEqual([
      "proxy.request_error",
    ]);
  });

  it("returns empty logs when no AccountLogStore is injected", async () => {
    const res = await createApp(pool).request(`/auth/accounts/${accountId}/logs?since=7`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ accountId, logs: [], nextSince: 7 });
  });

  it("returns 404 for missing accounts", async () => {
    const res = await createApp(pool, store).request("/auth/accounts/missing/logs");

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Account not found");
  });

  it.each([
    ["limit=0"],
    ["limit=201"],
    ["since=-1"],
    ["level=debug"],
    ["category=quota"],
  ])("returns 400 for invalid query %s", async (query) => {
    const res = await createApp(pool, store).request(`/auth/accounts/${accountId}/logs?${query}`);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid request");
  });

  it("requires dashboard session for remote requests when proxy_api_key is configured", async () => {
    mockConfig.server.proxy_api_key = "secret-key";
    mockGetConnInfo.mockReturnValue({ remote: { address: "203.0.113.9" } });

    const res = await createApp(pool, store).request(`/auth/accounts/${accountId}/logs`);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Dashboard login required");
  });

  it("allows remote log requests with a valid dashboard session", async () => {
    mockConfig.server.proxy_api_key = "secret-key";
    mockGetConnInfo.mockReturnValue({ remote: { address: "203.0.113.9" } });
    sessionMod._addTestSession("valid-session");
    store.append(accountId, {
      category: "proxy",
      level: "info",
      eventType: "proxy.request_started",
    });

    const res = await createApp(pool, store).request(`/auth/accounts/${accountId}/logs`, {
      headers: { Cookie: "_codex_session=valid-session" },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.logs).toHaveLength(1);
  });
});
