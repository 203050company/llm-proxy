import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  OPENCODE_GO_ALIASES,
  getOpencodeGoModelAliases,
  OpencodeGoUpstream,
  resolveOpencodeGoAuth,
  resolveOpencodeGoModel,
  shouldUseOpencodeMessagesEndpoint,
} from "@src/proxy/opencode-go-upstream.js";

async function collectOpencodeEvents(response: Response) {
  const upstream = new OpencodeGoUpstream("secret", "https://example.test/v1");
  const events = [];
  for await (const event of upstream.parseStream(response)) events.push(event);
  return events;
}

describe("opencode-go upstream", () => {
  const originalEnv = { ...process.env };
  let home: string;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    delete process.env.OPENCODE_GO_API_KEY;
    delete process.env.OPENCODE_GO_BASE_URL;
    home = mkdtempSync(join(tmpdir(), "opencode-go-home-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("prefers OPENCODE_GO_API_KEY over auth.json and redacts the key", () => {
    mkdirSync(join(home, ".local/share/opencode"), { recursive: true });
    writeFileSync(
      join(home, ".local/share/opencode/auth.json"),
      JSON.stringify({ "opencode-go": { key: "json-secret" } }),
    );
    process.env.OPENCODE_GO_API_KEY = "env-secret";

    const auth = resolveOpencodeGoAuth();

    expect(auth.apiKey).toBe("env-secret");
    expect(auth.source).toBe("OPENCODE_GO_API_KEY");
    expect(auth.redacted).toBe("env...cret");
  });

  it("falls back to ~/.local/share/opencode/auth.json opencode-go.key", () => {
    mkdirSync(join(home, ".local/share/opencode"), { recursive: true });
    writeFileSync(
      join(home, ".local/share/opencode/auth.json"),
      JSON.stringify({ "opencode-go": { key: "json-secret" } }),
    );

    const auth = resolveOpencodeGoAuth();

    expect(auth.apiKey).toBe("json-secret");
    expect(auth.source).toContain("auth.json");
  });

  it("maps Claude-discoverable aliases to raw opencode-go model ids", () => {
    expect(resolveOpencodeGoModel("opencode-kimi-k2.7")).toBe("kimi-k2.7");
    expect(resolveOpencodeGoModel("claude-opencode-kimi-k2.7")).toBe("kimi-k2.7");
    expect(resolveOpencodeGoModel("claude-opencode-kimi-k2.6")).toBe("kimi-k2.6");
    expect(resolveOpencodeGoModel("opencode-go:deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(resolveOpencodeGoModel("opencode-go/minimax-m2.7")).toBe("minimax-m2.7");
  });

  it("covers all static raw models with plain and Claude-compatible aliases", () => {
    for (const model of OPENCODE_GO_ALIASES) {
      expect(model.alias).toMatch(/^opencode-/);
      expect(resolveOpencodeGoModel(model.alias)).toBe(model.id);
      for (const alias of model.aliases ?? []) {
        expect(alias).toMatch(/^claude-opencode-/);
        expect(resolveOpencodeGoModel(alias)).toBe(model.id);
      }
    }
  });

  it("keeps static plain aliases after dynamic model refresh", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: "minimax-m2.7" },
        { id: "qwen3.6-plus" },
        { id: "hy3-preview" },
      ],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    getOpencodeGoModelAliases();

    await vi.waitFor(() => {
      expect(getOpencodeGoModelAliases().map((model) => model.alias)).toContain("claude-opencode-hy3-preview");
    });

    const refreshed = getOpencodeGoModelAliases();
    expect(refreshed.find((model) => model.id === "minimax-m2.7")?.alias).toBe("opencode-minimax-m2.7");
    expect(refreshed.find((model) => model.id === "qwen3.6-plus")?.alias).toBe("opencode-qwen3.6-plus");
  });

  it("routes dynamically discovered aliases to raw opencode-go model ids", async () => {
    vi.resetModules();
    const upstream = await import("@src/proxy/opencode-go-upstream.js");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "hy3-routing-preview" }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    upstream.getOpencodeGoModelAliases();

    await vi.waitFor(() => {
      expect(upstream.getOpencodeGoModelAliases().map((model) => model.alias)).toContain("claude-opencode-hy3-routing-preview");
    });

    expect(upstream.resolveOpencodeGoModel("claude-opencode-hy3-routing-preview")).toBe("hy3-routing-preview");
  });

  it("backs off after a failed dynamic model refresh", async () => {
    vi.resetModules();
    const upstream = await import("@src/proxy/opencode-go-upstream.js");
    const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    upstream.getOpencodeGoModelAliases();

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    upstream.getOpencodeGoModelAliases();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes OpenAI-style opencode-go SSE chunks into Codex events", async () => {
    const chunks = [
      { id: "chatcmpl_1", choices: [{ delta: { content: "hi " } }] },
      { choices: [{ delta: { content: "there" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "Read", arguments: "{\"pa" } }] } }] },
      {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "th\":\"a\"}" } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      },
    ];
    const response = new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""));

    const events = await collectOpencodeEvents(response);

    expect(events.find((event) => event.event === "response.created")?.data).toEqual({ response: { id: "chatcmpl_1" } });
    expect(events.filter((event) => event.event === "response.output_text.delta").map((event) => event.data)).toEqual([
      { delta: "hi " },
      { delta: "there" },
    ]);
    expect(events.find((event) => event.event === "response.output_item.added")?.data).toMatchObject({
      output_index: 0,
      item: { type: "function_call", call_id: "call_1", name: "Read" },
    });
    expect(events.filter((event) => event.event === "response.function_call_arguments.delta").map((event) => event.data)).toEqual([
      { call_id: "call_1", delta: "{\"pa", output_index: 0 },
      { call_id: "call_1", delta: "th\":\"a\"}", output_index: 0 },
    ]);
    expect(events.find((event) => event.event === "response.function_call_arguments.done")?.data).toEqual({
      call_id: "call_1",
      name: "Read",
      arguments: "{\"path\":\"a\"}",
      output_index: 0,
    });
    expect(events.find((event) => event.event === "response.completed")?.data).toMatchObject({
      response: { status: "completed", usage: { input_tokens: 3, output_tokens: 4 } },
    });
  });

  it("normalizes Anthropic-style opencode-go SSE events into Codex events", async () => {
    const events = [
      ["message_start", { message: { id: "msg_1", usage: { input_tokens: 5 } } }],
      ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "hello" } }],
      ["content_block_start", { index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "Read" } }],
      ["content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":" } }],
      ["content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: "\"a\"}" } }],
      ["content_block_stop", { index: 1 }],
      ["message_delta", { usage: { output_tokens: 7 } }],
      ["message_stop", {}],
    ];
    const response = new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""));

    const parsed = await collectOpencodeEvents(response);

    expect(parsed.find((event) => event.event === "response.created")?.data).toEqual({ response: { id: "msg_1" } });
    expect(parsed.find((event) => event.event === "response.output_text.delta")?.data).toEqual({ delta: "hello" });
    expect(parsed.find((event) => event.event === "response.output_item.added")?.data).toMatchObject({
      output_index: 1,
      item: { type: "function_call", call_id: "toolu_1", name: "Read" },
    });
    expect(parsed.filter((event) => event.event === "response.function_call_arguments.delta").map((event) => event.data)).toEqual([
      { call_id: "toolu_1", delta: "{\"path\":", output_index: 1 },
      { call_id: "toolu_1", delta: "\"a\"}", output_index: 1 },
    ]);
    expect(parsed.find((event) => event.event === "response.function_call_arguments.done")?.data).toEqual({
      call_id: "toolu_1",
      name: "Read",
      arguments: "{\"path\":\"a\"}",
      output_index: 1,
    });
    expect(parsed.find((event) => event.event === "response.completed")?.data).toEqual({
      response: {
        id: "msg_1",
        status: "completed",
        usage: {
          input_tokens: 5,
          output_tokens: 7,
          input_tokens_details: {},
          output_tokens_details: {},
        },
      },
    });
  });

  it("routes MiniMax models to /messages and other models to /chat/completions", () => {
    expect(shouldUseOpencodeMessagesEndpoint("minimax-m2.7")).toBe(true);
    expect(shouldUseOpencodeMessagesEndpoint("minimax-m2.5")).toBe(true);
    expect(shouldUseOpencodeMessagesEndpoint("kimi-k2.6")).toBe(false);
    expect(shouldUseOpencodeMessagesEndpoint("deepseek-v4-pro")).toBe(false);
  });

  it("posts MiniMax requests to /messages and OpenAI-compatible models to /chat/completions", async () => {
    process.env.OPENCODE_GO_API_KEY = "secret";
    const fetchMock = vi.fn(async () => new Response("data: [DONE]\n\n", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const upstream = new OpencodeGoUpstream();
    await upstream.createResponse({
      model: "claude-opencode-minimax-m2.7",
      input: [{ role: "user", content: "hello" }],
      stream: true,
      store: false,
      max_output_tokens: 10,
    }, new AbortController().signal);
    await upstream.createResponse({
      model: "claude-opencode-kimi-k2.6",
      input: [{ role: "user", content: "hello" }],
      stream: true,
      store: false,
      max_output_tokens: 10,
    }, new AbortController().signal);

    expect(fetchMock.mock.calls[0][0]).toBe("https://opencode.ai/zen/go/v1/messages");
    expect(fetchMock.mock.calls[1][0]).toBe("https://opencode.ai/zen/go/v1/chat/completions");
  });

  it("omits forced tool_choice for opencode-go models that reject required tool selection", async () => {
    process.env.OPENCODE_GO_API_KEY = "secret";
    const fetchMock = vi.fn(async () => new Response("data: [DONE]\n\n", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const upstream = new OpencodeGoUpstream();
    await upstream.createResponse({
      model: "claude-opencode-kimi-k2.6",
      input: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", name: "Bash", parameters: { type: "object", properties: {} } }],
      tool_choice: { type: "function", name: "Bash" },
      stream: false,
      store: false,
      max_output_tokens: 10,
    }, new AbortController().signal);

    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as Record<string, unknown>;
    expect(body.tools).toBeDefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it("backfills reasoning_content for Kimi tool call history", async () => {
    process.env.OPENCODE_GO_API_KEY = "secret";
    const fetchMock = vi.fn(async () => new Response("data: [DONE]\n\n", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const upstream = new OpencodeGoUpstream();
    await upstream.createResponse({
      model: "claude-opencode-kimi-k2.6",
      input: [
        { role: "user", content: "Use Bash to echo OK" },
        { type: "function_call", call_id: "toolu_1", name: "Bash", arguments: "{\"command\":\"echo OK\"}" },
        { type: "function_call_output", call_id: "toolu_1", output: "OK" },
      ],
      tools: [{ type: "function", name: "Bash", parameters: { type: "object", properties: {} } }],
      stream: false,
      store: false,
      max_output_tokens: 10,
    }, new AbortController().signal);

    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as { messages: Array<Record<string, unknown>> };
    const assistantMessage = body.messages.find((message) => Array.isArray(message.tool_calls));
    expect(assistantMessage).toMatchObject({ role: "assistant", reasoning_content: " " });
  });
});
