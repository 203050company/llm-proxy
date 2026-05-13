import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: {
    server: { proxy_api_key: "secret-key" as string | null },
    session: { ttl_minutes: 60 },
  },
  batchWarmupSessions: vi.fn(),
}));

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mocks.config),
  getLocalConfigPath: vi.fn(() => "/tmp/test/local.yaml"),
  reloadAllConfigs: vi.fn(),
  ROTATION_STRATEGIES: ["least_used", "round_robin", "sticky"],
}));

vi.mock("@src/utils/yaml-mutate.js", () => ({
  mutateYaml: vi.fn(),
}));

vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: vi.fn(() => ({ remote: { address: "127.0.0.1" } })),
}));

vi.mock("@src/services/account-session-warmup.js", () => ({
  batchWarmupSessions: mocks.batchWarmupSessions,
}));

import { createSettingsRoutes } from "@src/routes/admin/settings.js";
import { batchWarmupSessions } from "@src/services/account-session-warmup.js";
import { createSession, _resetForTest } from "@src/auth/dashboard-session.js";

const pool = { getAllEntries: vi.fn() };
const proxyPool = { resolveProxyUrl: vi.fn() };

function createApp() {
  const app = new Hono();
  app.route("/", createSettingsRoutes(pool as never, proxyPool as never));
  return app;
}

describe("POST /admin/accounts/warmup-sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTest();
    mocks.config.server.proxy_api_key = "secret-key";
    mocks.batchWarmupSessions.mockResolvedValue([
      {
        id: "acc-1",
        email: "a@example.com",
        previousStatus: "active",
        result: "warmed",
        durationMs: 12,
      },
      {
        id: "acc-2",
        email: "b@example.com",
        previousStatus: "disabled",
        result: "skipped",
        error: "account is disabled",
      },
      {
        id: "acc-3",
        email: "c@example.com",
        previousStatus: "active",
        result: "failed",
        durationMs: 8,
        error: "warmup returned no quota",
      },
    ]);
  });

  it("rejects requests without admin write auth when proxy_api_key is configured", async () => {
    const res = await createApp().request("/admin/accounts/warmup-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(401);
    expect(batchWarmupSessions).not.toHaveBeenCalled();
  });

  it("accepts dashboard sessions as admin write auth", async () => {
    const session = createSession();
    const res = await createApp().request("/admin/accounts/warmup-sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `_codex_session=${session.id}`,
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(batchWarmupSessions).toHaveBeenCalledOnce();
  });

  it("rejects invalid warmup options", async () => {
    const res = await createApp().request("/admin/accounts/warmup-sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret-key",
      },
      body: JSON.stringify({ ids: [], concurrency: 0, stagger_ms: -1 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid request");
    expect(batchWarmupSessions).not.toHaveBeenCalled();
  });

  it("runs warmup and returns summary counts", async () => {
    const res = await createApp().request("/admin/accounts/warmup-sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret-key",
      },
      body: JSON.stringify({
        ids: ["acc-1", "acc-3"],
        concurrency: 2,
        stagger_ms: 3000,
      }),
    });

    expect(res.status).toBe(200);
    expect(batchWarmupSessions).toHaveBeenCalledWith(
      pool,
      { ids: ["acc-1", "acc-3"], concurrency: 2, staggerMs: 3000 },
      proxyPool,
    );
    const body = await res.json();
    expect(body).toEqual({
      summary: { total: 3, warmed: 1, failed: 1, skipped: 1 },
      results: await mocks.batchWarmupSessions.mock.results[0].value,
    });
  });

  it("returns 503 when the account pool is unavailable", async () => {
    const app = new Hono();
    app.route("/", createSettingsRoutes());

    const res = await app.request("/admin/accounts/warmup-sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer secret-key",
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(503);
    expect(batchWarmupSessions).not.toHaveBeenCalled();
  });
});
