import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createValidJwt } from "@helpers/jwt.js";
import type { AccountPool } from "@src/auth/account-pool.js";
import type { RefreshScheduler } from "@src/auth/refresh-scheduler.js";

const oauthMocks = vi.hoisted(() => ({
  startOAuthFlow: vi.fn(() => ({ authUrl: "http://auth.test", state: "state-1" })),
  consumeSession: vi.fn(),
  peekSession: vi.fn(() => null),
  deleteSession: vi.fn(),
  exchangeCode: vi.fn(),
  requestDeviceCode: vi.fn(),
  pollDeviceToken: vi.fn(),
  importCliAuth: vi.fn(),
  markSessionCompleted: vi.fn(),
  isSessionCompleted: vi.fn(() => false),
  tryAcquireSession: vi.fn(),
  releaseSession: vi.fn(),
}));

vi.mock("@src/auth/oauth-pkce.js", () => oauthMocks);

import { createAuthRoutes } from "@src/routes/auth.js";

function makeApp(): {
  app: Hono;
  pool: { addAccount: ReturnType<typeof vi.fn> };
  scheduler: { scheduleOne: ReturnType<typeof vi.fn> };
} {
  const pool = {
    addAccount: vi.fn(() => "acc-1"),
  };
  const scheduler = {
    scheduleOne: vi.fn(),
  };
  const app = new Hono();
  app.route("/", createAuthRoutes(pool as unknown as AccountPool, scheduler as unknown as RefreshScheduler));
  return { app, pool, scheduler };
}

describe("auth routes id_token propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    oauthMocks.peekSession.mockReturnValue(null);
    oauthMocks.isSessionCompleted.mockReturnValue(false);
    oauthMocks.startOAuthFlow.mockReturnValue({ authUrl: "http://auth.test", state: "state-1" });
  });

  it("passes Codex CLI id token into the account pool", async () => {
    const { app, pool } = makeApp();
    const accessToken = createValidJwt({ accountId: "cli-id-token" });
    oauthMocks.importCliAuth.mockReturnValue({
      access_token: accessToken,
      refresh_token: "rt-cli",
      id_token: "real-id-token",
    });

    const res = await app.request("/auth/import-cli", { method: "POST" });

    expect(res.status).toBe(200);
    expect(pool.addAccount).toHaveBeenCalledWith(accessToken, "rt-cli", "real-id-token");
  });

  it("passes code relay id token into the account pool", async () => {
    const { app, pool } = makeApp();
    const accessToken = createValidJwt({ accountId: "relay-id-token" });
    oauthMocks.tryAcquireSession.mockReturnValue({
      codeVerifier: "verifier",
      redirectUri: "http://localhost:1455/auth/callback",
      returnHost: "localhost:3000",
    });
    oauthMocks.exchangeCode.mockResolvedValue({
      access_token: accessToken,
      refresh_token: "rt-relay",
      id_token: "relay-id-token",
    });

    const res = await app.request("/auth/code-relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callbackUrl: "http://localhost:1455/auth/callback?code=abc&state=state-1" }),
    });

    expect(res.status).toBe(200);
    expect(pool.addAccount).toHaveBeenCalledWith(accessToken, "rt-relay", "relay-id-token");
  });

  it("passes callback id token into the account pool", async () => {
    const { app, pool } = makeApp();
    const accessToken = createValidJwt({ accountId: "callback-id-token" });
    oauthMocks.tryAcquireSession.mockReturnValue({
      codeVerifier: "verifier",
      redirectUri: "http://localhost:1455/auth/callback",
      returnHost: "localhost:3000",
    });
    oauthMocks.exchangeCode.mockResolvedValue({
      access_token: accessToken,
      refresh_token: "rt-callback",
      id_token: "callback-id-token",
    });

    const res = await app.request("/auth/callback?code=abc&state=state-1", {
      headers: { host: "localhost:3000" },
    });

    expect(res.status).toBe(302);
    expect(pool.addAccount).toHaveBeenCalledWith(accessToken, "rt-callback", "callback-id-token");
  });

  it("passes device flow id token into the account pool", async () => {
    const { app, pool } = makeApp();
    const accessToken = createValidJwt({ accountId: "device-id-token" });
    oauthMocks.pollDeviceToken.mockResolvedValue({
      access_token: accessToken,
      refresh_token: "rt-device",
      id_token: "device-id-token",
    });

    const res = await app.request("/auth/device-poll/device-code-1");

    expect(res.status).toBe(200);
    expect(pool.addAccount).toHaveBeenCalledWith(accessToken, "rt-device", "device-id-token");
  });
});
