import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { createSessionRoutingRoutes } from "@src/routes/admin/session-routing.js";
import {
  clearSessionRoutingRecords,
  recordSessionRouting,
} from "@src/services/session-routing-state.js";

function createApp(): Hono {
  const app = new Hono();
  app.route("/", createSessionRoutingRoutes());
  return app;
}

describe("session routing admin route", () => {
  beforeEach(() => {
    clearSessionRoutingRecords();
  });

  it("returns the latest OpenAI routing record on demand", async () => {
    recordSessionRouting({
      sessionId: "session-1",
      provider: "openai",
      requestedModel: "gpt-4o",
      actualModel: "gpt-4o-mini",
      accountId: "openai-key-1",
      accountEmail: "user@example.com",
      status: 200,
    });

    const res = await createApp().request("/admin/session-routing/latest?provider=openai");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.record).toMatchObject({
      sessionId: "session-1",
      provider: "openai",
      requestedModel: "gpt-4o",
      actualModel: "gpt-4o-mini",
      accountId: "openai-key-1",
      accountEmail: "user@example.com",
      status: 200,
    });
    expect(typeof body.record.updatedAt).toBe("string");
  });

  it("prefers an exact session record when session_id is provided", async () => {
    recordSessionRouting({
      sessionId: "session-1",
      provider: "openai",
      requestedModel: "gpt-4o",
      actualModel: "gpt-4o",
      accountId: "openai-key-1",
      accountEmail: "one@example.com",
      status: 200,
    });
    recordSessionRouting({
      sessionId: "session-2",
      provider: "openai",
      requestedModel: "gpt-4o",
      actualModel: "gpt-4o-mini",
      accountId: "openai-key-2",
      accountEmail: "two@example.com",
      status: 200,
    });

    const res = await createApp().request(
      "/admin/session-routing/latest?provider=openai&session_id=session-1",
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.record.accountEmail).toBe("one@example.com");
    expect(body.record.actualModel).toBe("gpt-4o");
  });

  it("returns 404 when no matching record has been captured", async () => {
    const res = await createApp().request("/admin/session-routing/latest?provider=openai");
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe("No session routing record found");
  });
});
