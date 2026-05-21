/**
 * Tests for CodexApi SSE parsing.
 * Migrated from src/proxy/__tests__/ with @src/ path aliases.
 */

// Mock transport for createResponse and getModels tests
vi.mock("@src/tls/transport.js", () => ({
  getTransport: vi.fn(() => ({
    post: vi.fn(),
    get: vi.fn(),
    isImpersonate: vi.fn(() => false),
    simplePost: vi.fn(),
  })),
}));

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    api: { base_url: "https://chatgpt.com/backend-api" },
    client: { app_version: "1.0.0" },
  })),
}));

vi.mock("@src/fingerprint/manager.js", () => ({
  buildHeaders: vi.fn(() => ({})),
  buildHeadersWithContentType: vi.fn(() => ({ "Content-Type": "application/json" })),
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexApi, CodexApiError, type CodexSSEEvent } from "@src/proxy/codex-api.js";
import { mockResponse } from "@helpers/sse.js";
import { getTransport } from "@src/tls/transport.js";
import type { TlsTransport, TlsTransportResponse } from "@src/tls/transport.js";

/** Collect all events from parseStream into an array. */
async function collectEvents(api: CodexApi, response: Response): Promise<CodexSSEEvent[]> {
  const events: CodexSSEEvent[] = [];
  for await (const evt of api.parseStream(response)) {
    events.push(evt);
  }
  return events;
}

function createApi(): CodexApi {
  return new CodexApi("test-token", null);
}

describe("CodexApi.parseStream", () => {
  it("parses a complete SSE event in a single chunk", async () => {
    const api = createApi();
    const response = mockResponse(
      'event: response.output_text.delta\ndata: {"delta":"Hello"}\n\n',
    );

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("response.output_text.delta");
    expect(events[0].data).toEqual({ delta: "Hello" });
  });

  it("handles multiple events in a single chunk", async () => {
    const api = createApi();
    const response = mockResponse(
      'event: response.created\ndata: {"response":{"id":"resp_1"}}\n\n' +
      'event: response.output_text.delta\ndata: {"delta":"Hi"}\n\n' +
      'event: response.completed\ndata: {"response":{"id":"resp_1","usage":{"input_tokens":10,"output_tokens":5}}}\n\n',
    );

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(3);
    expect(events[0].event).toBe("response.created");
    expect(events[1].event).toBe("response.output_text.delta");
    expect(events[2].event).toBe("response.completed");
  });

  it("reassembles events split across chunk boundaries", async () => {
    const api = createApi();
    const response = mockResponse(
      'event: response.output_text.delta\ndata: {"del',
      'ta":"world"}\n\n',
    );

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ delta: "world" });
  });

  it("handles chunk split at \\n\\n boundary", async () => {
    const api = createApi();
    const response = mockResponse(
      'event: response.output_text.delta\ndata: {"delta":"a"}\n',
      '\nevent: response.output_text.delta\ndata: {"delta":"b"}\n\n',
    );

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(2);
    expect(events[0].data).toEqual({ delta: "a" });
    expect(events[1].data).toEqual({ delta: "b" });
  });

  it("handles many small single-character chunks", async () => {
    const api = createApi();
    const full = 'event: response.output_text.delta\ndata: {"delta":"x"}\n\n';
    const chunks = full.split("");
    const response = mockResponse(...chunks);

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ delta: "x" });
  });

  it("skips [DONE] marker without crashing", async () => {
    const api = createApi();
    const response = mockResponse(
      'event: response.output_text.delta\ndata: {"delta":"hi"}\n\n' +
      "data: [DONE]\n\n",
    );

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ delta: "hi" });
  });

  it("returns raw string when data is not valid JSON", async () => {
    const api = createApi();
    const response = mockResponse(
      'event: response.output_text.delta\ndata: not-json-at-all\n\n',
    );

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("not-json-at-all");
  });

  it("handles malformed JSON (unclosed brace) gracefully", async () => {
    const api = createApi();
    const response = mockResponse(
      'event: response.output_text.delta\ndata: {"delta":"unclosed\n\n',
    );

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(1);
    expect(typeof events[0].data).toBe("string");
  });

  it("skips empty blocks between events", async () => {
    const api = createApi();
    const response = mockResponse(
      'event: response.output_text.delta\ndata: {"delta":"a"}\n\n' +
      "\n\n" +
      'event: response.output_text.delta\ndata: {"delta":"b"}\n\n',
    );

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(2);
  });

  it("processes remaining buffer after stream ends", async () => {
    const api = createApi();
    const response = mockResponse(
      'event: response.output_text.delta\ndata: {"delta":"last"}',
    );

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ delta: "last" });
  });

  it("handles multi-line data fields", async () => {
    const api = createApi();
    const response = mockResponse(
      'event: response.output_text.delta\ndata: {"delta":\n' +
      'data: "multi-line"}\n\n',
    );

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ delta: "multi-line" });
  });

  it("returns null body error", async () => {
    const api = createApi();
    const response = new Response(null);

    await expect(async () => {
      await collectEvents(api, response);
    }).rejects.toThrow("Response body is null");
  });

  it("throws on buffer overflow (>64MB)", async () => {
    // Buffer cap was raised to 64 MB to accommodate 4K image_generation_call
    // events (base64-encoded 8 MP PNG can be 10-15 MB per single event).
    const api = createApi();
    const hugeData = "x".repeat(65 * 1024 * 1024);
    const response = mockResponse(hugeData);

    await expect(async () => {
      await collectEvents(api, response);
    }).rejects.toThrow("SSE buffer exceeded");
  });
});

// ── parseStream — non-SSE response detection ──────────────────────

describe("CodexApi.parseStream — non-SSE responses", () => {
  it("yields error event for non-SSE JSON response with detail field", async () => {
    const api = createApi();
    const response = mockResponse('{"detail":"Invalid model"}');

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("error");
    const data = events[0].data as { error: { code: string; message: string } };
    expect(data.error.code).toBe("non_sse_response");
    expect(data.error.message).toBe("Invalid model");
  });

  it("yields error event for non-SSE JSON response with error.message field", async () => {
    const api = createApi();
    const response = mockResponse('{"error":{"message":"Something went wrong"}}');

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("error");
    const data = events[0].data as { error: { code: string; message: string } };
    expect(data.error.message).toBe("Something went wrong");
  });

  it("yields error event for non-SSE plain text response", async () => {
    const api = createApi();
    const response = mockResponse("Upstream error: service unavailable");

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("error");
    const data = events[0].data as { error: { code: string; message: string } };
    expect(data.error.code).toBe("non_sse_response");
    expect(data.error.message).toBe("Upstream error: service unavailable");
  });

  it("yields nothing for empty response body", async () => {
    const api = createApi();
    const response = mockResponse("");

    const events = await collectEvents(api, response);
    expect(events).toHaveLength(0);
  });
});

// ── createResponse error handling ─────────────────────────────────

describe("CodexApi.createResponse", () => {
  function makeMockTransport(overrides: Partial<TlsTransport> = {}): TlsTransport {
    return {
      post: vi.fn(),
      get: vi.fn(),
      simplePost: vi.fn(),
      isImpersonate: vi.fn(() => false),
      ...overrides,
    } as unknown as TlsTransport;
  }

  function makeSseStream(
    events: string[],
    options: {
      close?: boolean;
      onCancel?: () => void;
    } = {},
  ): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const event of events) {
          controller.enqueue(encoder.encode(event));
        }
        if (options.close !== false) {
          controller.close();
        }
      },
      cancel() {
        options.onCancel?.();
      },
    });
  }

  it("throws CodexApiError on non-2xx status", async () => {
    const errorBody = '{"detail":"Unauthorized"}';
    const mockTransport = makeMockTransport({
      post: vi.fn().mockImplementation(() =>
        Promise.resolve({
          status: 401,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(errorBody));
              controller.close();
            },
          }),
          headers: new Headers(),
          setCookieHeaders: [],
        } satisfies TlsTransportResponse),
      ),
    });
    vi.mocked(getTransport).mockReturnValue(mockTransport);

    const api = new CodexApi("test-token", null);
    const request = {
      model: "gpt-5.4",
      instructions: "test",
      input: [{ role: "user" as const, content: "Hi" }],
      stream: true as const,
      store: false as const,
    };

    await expect(api.createResponse(request)).rejects.toThrow(CodexApiError);
    try {
      await api.createResponse(request);
    } catch (e) {
      const err = e as CodexApiError;
      expect(err.status).toBe(401);
      expect(err.body).toBe(errorBody);
    }
  });

  it("truncates error body exceeding 1MB", async () => {
    const largeBody = "x".repeat(2 * 1024 * 1024); // 2MB
    const mockTransport = makeMockTransport({
      post: vi.fn().mockImplementation(() =>
        Promise.resolve({
          status: 500,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              // Send in chunks to simulate streaming
              const encoder = new TextEncoder();
              const chunkSize = 256 * 1024;
              for (let i = 0; i < largeBody.length; i += chunkSize) {
                controller.enqueue(encoder.encode(largeBody.slice(i, i + chunkSize)));
              }
              controller.close();
            },
          }),
          headers: new Headers(),
          setCookieHeaders: [],
        } satisfies TlsTransportResponse),
      ),
    });
    vi.mocked(getTransport).mockReturnValue(mockTransport);

    const api = new CodexApi("test-token", null);
    const request = {
      model: "gpt-5.4",
      instructions: "test",
      input: [{ role: "user" as const, content: "Hi" }],
      stream: true as const,
      store: false as const,
    };

    try {
      await api.createResponse(request);
    } catch (e) {
      const err = e as CodexApiError;
      expect(err.status).toBe(500);
      // Body should be capped at 1MB
      expect(err.body.length).toBeLessThanOrEqual(1024 * 1024);
    }
  });

  it("normalizes inline image data URLs before sending the upstream request", async () => {
    const postedBodies: string[] = [];
    const mockTransport = makeMockTransport({
      post: vi.fn().mockImplementation((_url, _headers, body) => {
        postedBodies.push(body);
        return Promise.resolve({
          status: 200,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          }),
          headers: new Headers(),
          setCookieHeaders: [],
        } satisfies TlsTransportResponse);
      }),
    });
    vi.mocked(getTransport).mockReturnValue(mockTransport);

    const api = new CodexApi("test-token", null);
    const request = {
      model: "gpt-5.4",
      instructions: "describe image",
      input: [{
        role: "user" as const,
        content: [
          { type: "input_text" as const, text: "Describe this image." },
          {
            type: "input_image" as const,
            image_url:
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Vr9cAAAAASUVORK5CYII=",
          },
        ],
      }],
      stream: true as const,
      store: false as const,
    };

    await api.createResponse(request);

    expect(postedBodies).toHaveLength(1);
    const payload = JSON.parse(postedBodies[0]) as { input: Array<{ content: Array<{ image_url?: string }> }> };
    expect(payload.input[0].content[1].image_url).toMatch(/^data:image\/png;base64,/);
    expect(payload.input[0].content[1].image_url).not.toBe(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Vr9cAAAAASUVORK5CYII=",
    );
  });

  it("opens a real Codex response session and returns parsed rate-limit data", async () => {
    const postedBodies: string[] = [];
    const mockTransport = makeMockTransport({
      post: vi.fn().mockImplementation((_url, _headers, body) => {
        postedBodies.push(body);
        return Promise.resolve({
          status: 200,
          body: makeSseStream([
            "event: codex.rate_limits\n",
            "data: {\"type\":\"codex.rate_limits\",\"rate_limits\":{\"primary\":{\"used_percent\":1,\"window_minutes\":300,\"reset_at\":1778209500},\"secondary\":{\"used_percent\":22,\"window_minutes\":10080,\"reset_at\":1778628000}}}\n\n",
            "event: response.completed\n",
            "data: {\"type\":\"response.completed\"}\n\n",
          ]),
          headers: new Headers(),
          setCookieHeaders: [],
        } satisfies TlsTransportResponse);
      }),
    });
    vi.mocked(getTransport).mockReturnValue(mockTransport);

    const api = new CodexApi("test-token", "account-1");
    const rateLimit = await api.warmupSession("gpt-5.4-mini", false);

    expect(mockTransport.post).toHaveBeenCalledTimes(1);
    expect(mockTransport.post).toHaveBeenCalledWith(
      expect.stringContaining("/codex/responses"),
      expect.objectContaining({
        Accept: "text/event-stream",
        "OpenAI-Beta": expect.stringContaining("responses_websockets="),
        "x-openai-internal-codex-residency": "us",
      }),
      expect.any(String),
      expect.any(AbortSignal),
      undefined,
      undefined,
    );
    const parsedBody = JSON.parse(postedBodies[0]) as {
      model: string;
      instructions?: unknown;
      input?: unknown;
      stream: boolean;
      store: boolean;
    };
    expect(parsedBody).toMatchObject({
      model: "gpt-5.4-mini",
      stream: true,
      store: false,
    });
    expect(parsedBody.input).toEqual(expect.any(Array));
    expect(parsedBody.input.length).toBeGreaterThan(0);
    expect(typeof parsedBody.instructions).toBe("string");
    expect(rateLimit).toEqual({
      primary: {
        used_percent: 1,
        window_minutes: 300,
        reset_at: 1778209500,
      },
      secondary: {
        used_percent: 22,
        window_minutes: 10080,
        reset_at: 1778628000,
      },
    });
  });

  it("stops after a terminal event even if the stream never closes", async () => {
    const postedBodies: string[] = [];
    const encoder = new TextEncoder();
    const timeoutResult = Symbol("timeout");
    let streamCancelled = false;
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
    const mockTransport = makeMockTransport({
      post: vi.fn().mockImplementation((_url, _headers, body) => {
        postedBodies.push(body);
        return Promise.resolve({
          status: 200,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controllerRef = controller;
              controller.enqueue(encoder.encode("event: codex.rate_limits\n"));
              controller.enqueue(
                encoder.encode(
                  "data: {\"type\":\"codex.rate_limits\",\"rate_limits\":{\"primary\":{\"used_percent\":1,\"window_minutes\":300,\"reset_at\":1778209500},\"secondary\":{\"used_percent\":22,\"window_minutes\":10080,\"reset_at\":1778628000}}}\n\n",
                ),
              );
              controller.enqueue(encoder.encode("event: response.completed\n"));
              controller.enqueue(
                encoder.encode("data: {\"type\":\"response.completed\"}\n\n"),
              );
            },
            cancel() {
              streamCancelled = true;
            },
          }),
          headers: new Headers(),
          setCookieHeaders: [],
        } satisfies TlsTransportResponse);
      }),
    });
    vi.mocked(getTransport).mockReturnValue(mockTransport);

    const api = new CodexApi("test-token", "account-1");
    const warmupPromise = api.warmupSession("gpt-5.4-mini", false);
    const rateLimit = await Promise.race([
      warmupPromise,
      new Promise<typeof timeoutResult>((resolve) => {
        setTimeout(() => resolve(timeoutResult), 50);
      }),
    ]);
    if (rateLimit === timeoutResult) {
      controllerRef?.close();
      await warmupPromise.catch(() => undefined);
    }

    expect(mockTransport.post).toHaveBeenCalledTimes(1);
    expect(mockTransport.post.mock.calls[0][3]).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(postedBodies[0])).toMatchObject({
      model: "gpt-5.4-mini",
      stream: true,
      store: false,
    });
    expect(rateLimit).toEqual({
      primary: {
        used_percent: 1,
        window_minutes: 300,
        reset_at: 1778209500,
      },
      secondary: {
        used_percent: 22,
        window_minutes: 10080,
        reset_at: 1778628000,
      },
    });
    expect(streamCancelled).toBe(true);
  });

  it("throws CodexApiError when session warmup receives a non-2xx response", async () => {
    const errorBody = '{"detail":"The usage limit has been reached"}';
    const mockTransport = makeMockTransport({
      post: vi.fn().mockImplementation(() =>
        Promise.resolve({
          status: 429,
          body: makeSseStream([errorBody]),
          headers: new Headers(),
          setCookieHeaders: [],
        } satisfies TlsTransportResponse),
      ),
    });
    vi.mocked(getTransport).mockReturnValue(mockTransport);

    const api = new CodexApi("test-token", "account-1");

    await expect(api.warmupSession("gpt-5.4-mini", false)).rejects.toMatchObject({
      status: 429,
      body: errorBody,
    });
  });

});

// ── getModels ─────────────────────────────────────────────────────

describe("CodexApi.getModels", () => {
  function makeMockTransport(overrides: Partial<TlsTransport> = {}): TlsTransport {
    return {
      post: vi.fn(),
      get: vi.fn(),
      simplePost: vi.fn(),
      isImpersonate: vi.fn(() => false),
      ...overrides,
    } as unknown as TlsTransport;
  }

  it("returns null when all endpoints fail", async () => {
    const mockTransport = makeMockTransport({
      get: vi.fn().mockRejectedValue(new Error("connection refused")),
    });
    vi.mocked(getTransport).mockReturnValue(mockTransport);

    const api = new CodexApi("test-token", null);
    const result = await api.getModels();

    expect(result).toBeNull();
    // Should have probed all 3 endpoints
    expect(mockTransport.get).toHaveBeenCalledTimes(3);
  });

  it("flattens nested categories structure", async () => {
    const mockTransport = makeMockTransport({
      get: vi.fn().mockResolvedValue({
        body: JSON.stringify({
          categories: [
            {
              models: [
                { slug: "gpt-5.4", display_name: "GPT-5.4" },
                { slug: "gpt-5.3-codex", display_name: "Codex" },
              ],
            },
            {
              models: [
                { slug: "gpt-5.2", display_name: "GPT-5.2" },
              ],
            },
          ],
        }),
      }),
    });
    vi.mocked(getTransport).mockReturnValue(mockTransport);

    const api = new CodexApi("test-token", null);
    const result = await api.getModels();

    expect(result).not.toBeNull();
    expect(result).toHaveLength(3);
    expect(result![0]).toMatchObject({ slug: "gpt-5.4" });
    expect(result![1]).toMatchObject({ slug: "gpt-5.3-codex" });
    expect(result![2]).toMatchObject({ slug: "gpt-5.2" });
  });
});
