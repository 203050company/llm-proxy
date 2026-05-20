import { Hono, type Context } from "hono";
import type { AccountPool } from "../../auth/account-pool.js";
import { validateSession } from "../../auth/dashboard-session.js";
import { getConfig } from "../../config.js";
import { CliAuthError, AntigravityCliAuthService } from "../../services/antigravity-cli-auth.js";
import { parseSessionCookie } from "../../utils/parse-cookie.js";

function hasAdminWriteAuth(c: Context): boolean {
  const currentKey = getConfig().server.proxy_api_key;
  if (!currentKey) return true;

  const authHeader = c.req.header("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (token === currentKey) return true;

  const sessionId = parseSessionCookie(c.req.header("Cookie") ?? c.req.header("cookie"));
  return Boolean(sessionId && validateSession(sessionId));
}

export function createAntigravityCliAuthRoutes(accountPool: AccountPool): Hono {
  const app = new Hono();
  const service = new AntigravityCliAuthService(accountPool);

  app.get("/admin/antigravity-cli/status", (c) => c.json(service.getStatus()));

  app.post("/admin/antigravity-cli/apply", async (c) => {
    if (!hasAdminWriteAuth(c)) {
      c.status(401);
      return c.json({ error: "Invalid current API key" });
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(400);
      return c.json({ error: "Malformed JSON request body" });
    }

    const accountId = typeof (body as { accountId?: unknown })?.accountId === "string"
      ? (body as { accountId: string }).accountId
      : "";
    if (!accountId) {
      c.status(400);
      return c.json({ error: "accountId is required" });
    }

    try {
      const result = service.applyFromEntry(accountId);
      return c.json({ success: true, status: service.getStatus(), result });
    } catch (err) {
      if (err instanceof CliAuthError) {
        c.status(err.code === "not_found" ? 404 : 400);
        return c.json({ error: err.message, code: err.code });
      }
      throw err;
    }
  });

  return app;
}
