import { Hono, type Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { z } from "zod";
import type { AccountPool } from "../../auth/account-pool.js";
import { validateSession } from "../../auth/dashboard-session.js";
import { getConfig, getLocalConfigPath, reloadAllConfigs, ROTATION_STRATEGIES } from "../../config.js";
import { logStore } from "../../logs/store.js";
import type { ProxyPool } from "../../proxy/proxy-pool.js";
import { batchWarmupSessions } from "../../services/account-session-warmup.js";
import { parseSessionCookie } from "../../utils/parse-cookie.js";
import { mutateYaml } from "../../utils/yaml-mutate.js";
import { isLocalhostRequest } from "../../utils/is-localhost.js";

const WarmupSessionsSchema = z.object({
  ids: z.array(z.string()).min(1).optional(),
  concurrency: z.number().int().min(1).max(20).optional(),
  stagger_ms: z.number().int().min(0).max(60_000).optional(),
}).optional();

function hasAdminWriteAuth(c: Context): boolean {
  const currentKey = getConfig().server.proxy_api_key;
  if (!currentKey) return true;

  const authHeader = c.req.header("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (token === currentKey) return true;

  const sessionId = parseSessionCookie(c.req.header("Cookie") ?? c.req.header("cookie"));
  return Boolean(sessionId && validateSession(sessionId));
}

export function createSettingsRoutes(accountPool?: AccountPool, proxyPool?: ProxyPool): Hono {
  const app = new Hono();

  // --- Rotation settings ---

  app.get("/admin/rotation-settings", (c) => {
    const config = getConfig();
    return c.json({
      rotation_strategy: config.auth.rotation_strategy,
    });
  });

  app.post("/admin/rotation-settings", async (c) => {
    if (!hasAdminWriteAuth(c)) {
      c.status(401);
      return c.json({ error: "Invalid current API key" });
    }

    const body = await c.req.json() as { rotation_strategy?: string };
    const valid: readonly string[] = ROTATION_STRATEGIES;
    if (!body.rotation_strategy || !valid.includes(body.rotation_strategy)) {
      c.status(400);
      return c.json({ error: `rotation_strategy must be one of: ${ROTATION_STRATEGIES.join(", ")}` });
    }

    mutateYaml(getLocalConfigPath(), (data) => {
      if (!data.auth) data.auth = {};
      (data.auth as Record<string, unknown>).rotation_strategy = body.rotation_strategy;
    });
    reloadAllConfigs();

    const updated = getConfig();
    return c.json({
      success: true,
      rotation_strategy: updated.auth.rotation_strategy,
    });
  });

  // --- General settings ---

  app.get("/admin/settings", (c) => {
    const config = getConfig();
    return c.json({ proxy_api_key: config.server.proxy_api_key });
  });

  app.post("/admin/settings", async (c) => {
    const config = getConfig();
    const currentKey = config.server.proxy_api_key;

    if (!hasAdminWriteAuth(c)) {
      c.status(401);
      return c.json({ error: "Invalid current API key" });
    }

    const body = await c.req.json() as { proxy_api_key?: string | null };
    const newKey = body.proxy_api_key === undefined ? currentKey : (body.proxy_api_key || null);

    // Prevent remote sessions from clearing the key (would disable login gate)
    if (currentKey && !newKey) {
      const remoteAddr = getConnInfo(c).remote.address ?? "";
      if (!isLocalhostRequest(remoteAddr)) {
        c.status(403);
        return c.json({ error: "Cannot clear API key from remote session — this would disable the login gate" });
      }
    }

    mutateYaml(getLocalConfigPath(), (data) => {
      if (!data.server) data.server = {};
      (data.server as Record<string, unknown>).proxy_api_key = newKey;
    });
    reloadAllConfigs();

    return c.json({ success: true, proxy_api_key: newKey });
  });

  app.post("/admin/accounts/warmup-sessions", async (c) => {
    if (!hasAdminWriteAuth(c)) {
      c.status(401);
      return c.json({ error: "Invalid current API key" });
    }
    if (!accountPool) {
      c.status(503);
      return c.json({ error: "Account pool unavailable" });
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
    const parsed = WarmupSessionsSchema.safeParse(body);
    if (!parsed.success) {
      c.status(400);
      return c.json({ error: "Invalid request", details: parsed.error.issues });
    }

    const options = parsed.data ?? {};
    const results = await batchWarmupSessions(
      accountPool,
      {
        ids: options.ids,
        concurrency: options.concurrency,
        staggerMs: options.stagger_ms,
      },
      proxyPool,
    );
    const summary = {
      total: results.length,
      warmed: results.filter((result) => result.result === "warmed").length,
      failed: results.filter((result) => result.result === "failed").length,
      skipped: results.filter((result) => result.result === "skipped").length,
    };
    return c.json({ summary, results });
  });

  return app;
}
