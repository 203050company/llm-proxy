import { Hono } from "hono";
import { getLatestSessionRouting } from "../../services/session-routing-state.js";

export function createSessionRoutingRoutes(): Hono {
  const app = new Hono();

  app.get("/admin/session-routing/latest", (c) => {
    const record = getLatestSessionRouting({
      sessionId: c.req.query("session_id"),
      provider: c.req.query("provider"),
    });

    if (!record) {
      c.status(404);
      return c.json({ error: "No session routing record found" });
    }

    return c.json({ record });
  });

  return app;
}
