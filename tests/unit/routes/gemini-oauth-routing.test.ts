import { describe, expect, it, vi } from "vitest";
import { createChatRoutes } from "@src/routes/chat.js";
import { AccountPool } from "@src/auth/account-pool.js";
import { UpstreamRouter } from "@src/proxy/upstream-router.js";
import type { CodexSSEEvent } from "@src/proxy/codex-types.js";
import type { UpstreamAdapter } from "@src/proxy/upstream-adapter.js";
import { createMemoryPersistence } from "@helpers/account-pool-factory.js";

vi.mock("@src/config.js", () => ({
  getConfig: () => ({
    server: { proxy_api_key: null },
    model: { default: "gpt-5.5" },
    auth: { request_interval_ms: null },
  }),
}));

function emptyAccountPool(): AccountPool {
  return new AccountPool({
    persistence: createMemoryPersistence([]),
    rotationStrategy: "least_used",
    initialToken: null,
    rateLimitBackoffSeconds: 60,
  });
}

describe("Gemini OAuth route handling", () => {
  it("allows Gemini OAuth upstreams without requiring Codex accounts", async () => {
    const adapter: UpstreamAdapter = {
      tag: "gemini-oauth",
      createResponse: vi.fn(async () => new Response("data: {}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })),
      async *parseStream(): AsyncGenerator<CodexSSEEvent> {
        yield { event: "response.created", data: { response: { id: "r1" } } };
        yield {
          event: "response.completed",
          data: {
            response: {
              id: "r1",
              status: "completed",
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          },
        };
      },
    };
    const router = new UpstreamRouter(new Map(), {}, "codex");
    router.setGeminiOAuth({
      hasActiveModel: (model) => model === "gemini-3.1-pro",
    }, () => ({ accountId: "gemini-1", adapter }));

    const app = createChatRoutes(emptyAccountPool(), undefined, undefined, router);
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-3.1-pro",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(adapter.createResponse).toHaveBeenCalled();
  });
});
