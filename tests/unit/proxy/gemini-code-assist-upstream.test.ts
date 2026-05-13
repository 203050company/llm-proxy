import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiCodeAssistUpstream } from "@src/proxy/gemini-code-assist-upstream.js";
import { collectCodexToAnthropicResponse } from "@src/translation/codex-to-anthropic.js";
import type { GeminiAccountEntry } from "@src/auth/gemini-types.js";

function account(): GeminiAccountEntry {
  return {
    id: "g1",
    email: "user@example.com",
    label: null,
    status: "active",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    idToken: null,
    scope: "openid",
    tokenType: "Bearer",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    projectId: "project-1",
    userTier: "STANDARD",
    userTierName: "Standard",
    paidTier: null,
    googleAiSubscription: null,
    quota: null,
    quotaFetchedAt: null,
    lastUsedAt: null,
    lastRefreshSuccessAt: null,
    lastRefreshFailureAt: null,
    lastRefreshFailureCode: null,
    usage: { input_tokens: 0, output_tokens: 0, request_count: 0, models: {} },
    models: ["gemini-3.1-pro"],
  };
}

describe("GeminiCodeAssistUpstream", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts to Code Assist streamGenerateContent with bearer auth", async () => {
    const fetchMock = vi.fn(async () => new Response(
      'data: {"response":{"candidates":[],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":2}}}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    global.fetch = fetchMock as unknown as typeof fetch;

    const upstream = new GeminiCodeAssistUpstream({
      account: account(),
      endpoint: "https://cloudcode-pa.googleapis.com",
      apiVersion: "v1internal",
      onUsage: vi.fn(),
    });

    await upstream.createResponse({
      model: "gemini-3.1-pro",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: true,
      store: false,
    }, new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer access-token" }),
      }),
    );
  });

  it("uses ensureFreshAccount before sending the Code Assist request", async () => {
    const fetchMock = vi.fn(async () => new Response(
      'data: {"response":{"candidates":[]}}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    global.fetch = fetchMock as unknown as typeof fetch;

    const ensureFreshAccount = vi.fn(async () => ({
      ...account(),
      accessToken: "refreshed-access",
      tokenType: "Bearer",
    }));

    const upstream = new GeminiCodeAssistUpstream({
      account: account(),
      endpoint: "https://cloudcode-pa.googleapis.com",
      apiVersion: "v1internal",
      ensureFreshAccount,
    });

    await upstream.createResponse({
      model: "gemini-3.1-pro",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: true,
      store: false,
    }, new AbortController().signal);

    expect(ensureFreshAccount).toHaveBeenCalledWith("g1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer refreshed-access" }),
      }),
    );
  });

  it("falls back to another Gemini account when Code Assist returns 429", async () => {
    const secondAccount = {
      ...account(),
      id: "g2",
      email: "second@example.com",
      accessToken: "second-access",
      projectId: "project-2",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: { message: "You have exhausted your capacity on this model." } }),
        { status: 429, headers: { "content-type": "application/json" } },
      ))
      .mockResolvedValueOnce(new Response(
        'data: {"response":{"candidates":[]}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ));
    global.fetch = fetchMock as unknown as typeof fetch;

    const ensureFreshAccount = vi.fn(async (accountId: string) =>
      accountId === "g2" ? secondAccount : account(),
    );
    const pickFallbackAccount = vi.fn(() => secondAccount);

    const upstream = new GeminiCodeAssistUpstream({
      account: account(),
      endpoint: "https://cloudcode-pa.googleapis.com",
      apiVersion: "v1internal",
      ensureFreshAccount,
      pickFallbackAccount,
    });

    const response = await upstream.createResponse({
      model: "gemini-3.1-pro",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: true,
      store: false,
    }, new AbortController().signal);

    expect(response.status).toBe(200);
    expect(pickFallbackAccount).toHaveBeenCalledWith("gemini-3.1-pro", expect.any(Set));
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer access-token" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer second-access" }),
      }),
    );
  });

  it("emits attempt, failure, and rate-limit events for Gemini 429s before trying another account", async () => {
    const secondAccount = {
      ...account(),
      id: "g2",
      email: "second@example.com",
      accessToken: "second-access",
      projectId: "project-2",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: { message: "You have exhausted your capacity on this model." } }),
        { status: 429, headers: { "content-type": "application/json", "retry-after": "50" } },
      ))
      .mockResolvedValueOnce(new Response(
        'data: {"response":{"candidates":[]}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ));
    global.fetch = fetchMock as unknown as typeof fetch;

    const onAttempt = vi.fn();
    const onRequestFailure = vi.fn();
    const onRateLimit = vi.fn();
    const upstream = new GeminiCodeAssistUpstream({
      account: account(),
      endpoint: "https://cloudcode-pa.googleapis.com",
      apiVersion: "v1internal",
      ensureFreshAccount: vi.fn(async (accountId: string) =>
        accountId === "g2" ? secondAccount : account(),
      ),
      pickFallbackAccount: vi.fn(() => secondAccount),
      onAttempt,
      onRequestFailure,
      onRateLimit,
      rateLimitBackoffMs: 60_000,
    });

    await upstream.createResponse({
      model: "gemini-3.1-pro",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: true,
      store: false,
    }, new AbortController().signal);

    expect(onAttempt).toHaveBeenNthCalledWith(1, expect.objectContaining({
      accountId: "g1",
      model: "gemini-3.1-pro",
      status: 429,
      outcome: "http_error",
    }));
    expect(onAttempt).toHaveBeenNthCalledWith(2, expect.objectContaining({
      accountId: "g2",
      model: "gemini-3.1-pro",
      status: 200,
      outcome: "success",
    }));
    expect(onRequestFailure).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "g1",
      model: "gemini-3.1-pro",
      status: 429,
    }));
    expect(onRateLimit).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "g1",
      model: "gemini-3.1-pro",
      status: 429,
      retryAfterMs: 50_000,
    }));
  });

  it("skips the account that returned an empty response on the next direct retry", async () => {
    const secondAccount = {
      ...account(),
      id: "g2",
      email: "second@example.com",
      accessToken: "second-access",
      projectId: "project-2",
    };
    const fetchMock = vi.fn(async () => new Response(
      'data: {"response":{"candidates":[]}}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    global.fetch = fetchMock as unknown as typeof fetch;

    const ensureFreshAccount = vi.fn(async (accountId: string) =>
      accountId === "g2" ? secondAccount : account(),
    );
    const pickFallbackAccount = vi.fn(() => secondAccount);

    const upstream = new GeminiCodeAssistUpstream({
      account: account(),
      endpoint: "https://cloudcode-pa.googleapis.com",
      apiVersion: "v1internal",
      ensureFreshAccount,
      pickFallbackAccount,
    });

    await upstream.createResponse({
      model: "gemini-3.1-pro",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: true,
      store: false,
    }, new AbortController().signal);
    upstream.recordEmptyResponse();

    await upstream.createResponse({
      model: "gemini-3.1-pro",
      input: [{ role: "user", content: [{ type: "input_text", text: "retry" }] }],
      stream: true,
      store: false,
    }, new AbortController().signal);

    expect(pickFallbackAccount).toHaveBeenCalledWith("gemini-3.1-pro", expect.any(Set));
    const attemptedIds = pickFallbackAccount.mock.calls[0]?.[1] as ReadonlySet<string>;
    expect(attemptedIds.has("g1")).toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer second-access" }),
      }),
    );
  });

  it("uses the account picker for the requested model after runtime model fallback", async () => {
    const secondAccount = {
      ...account(),
      id: "g2",
      email: "second@example.com",
      accessToken: "second-access",
      projectId: "project-2",
      models: ["gemini-3-pro"],
    };
    const fetchMock = vi.fn(async () => new Response(
      'data: {"response":{"candidates":[]}}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    global.fetch = fetchMock as unknown as typeof fetch;

    const ensureFreshAccount = vi.fn(async (accountId: string) =>
      accountId === "g2" ? secondAccount : account(),
    );
    const pickFallbackAccount = vi.fn((model: string) =>
      model === "gemini-3-pro" ? secondAccount : undefined,
    );

    const upstream = new GeminiCodeAssistUpstream({
      account: account(),
      endpoint: "https://cloudcode-pa.googleapis.com",
      apiVersion: "v1internal",
      ensureFreshAccount,
      pickFallbackAccount,
    });

    await upstream.createResponse({
      model: "gemini-3-pro",
      input: [{ role: "user", content: [{ type: "input_text", text: "fallback model" }] }],
      stream: true,
      store: false,
    }, new AbortController().signal);

    expect(pickFallbackAccount).toHaveBeenCalledWith("gemini-3-pro", expect.any(Set));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer second-access" }),
      }),
    );
  });

  it("parses text parts from Code Assist SSE responses", async () => {
    const upstream = new GeminiCodeAssistUpstream({
      account: account(),
      endpoint: "https://cloudcode-pa.googleapis.com",
      apiVersion: "v1internal",
    });
    const response = new Response(
      'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"thoughtSignature":"redacted","text":"hello"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

    const events = [];
    for await (const event of upstream.parseStream(response)) {
      events.push(event);
    }

    expect(events).toContainEqual({
      event: "response.output_text.delta",
      data: { delta: "hello" },
    });
    expect(events.at(-1)).toMatchObject({
      event: "response.completed",
      data: {
        response: {
          status: "completed",
          usage: { input_tokens: 3, output_tokens: 2 },
        },
      },
    });
  });

  it("parses JSON-lines strings embedded in Code Assist SSE data", async () => {
    const upstream = new GeminiCodeAssistUpstream({
      account: account(),
      endpoint: "https://cloudcode-pa.googleapis.com",
      apiVersion: "v1internal",
    });
    const first = JSON.stringify({
      response: {
        candidates: [{ content: { role: "model", parts: [{ text: "Hello" }] } }],
        usageMetadata: { trafficType: "ON_DEMAND" },
      },
    });
    const second = JSON.stringify({
      response: {
        candidates: [{ content: { role: "model", parts: [{ text: "!" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 },
      },
    });
    const response = new Response(
      `data: ${JSON.stringify(`${first}\r\n${second}`)}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

    const events = [];
    for await (const event of upstream.parseStream(response)) {
      events.push(event);
    }

    expect(events).toContainEqual({
      event: "response.output_text.delta",
      data: { delta: "Hello" },
    });
    expect(events).toContainEqual({
      event: "response.output_text.delta",
      data: { delta: "!" },
    });
    expect(events.at(-1)).toMatchObject({
      event: "response.completed",
      data: {
        response: {
          usage: { input_tokens: 7, output_tokens: 2 },
        },
      },
    });
  });

  it("collects Code Assist SSE text as an Anthropic response", async () => {
    const upstream = new GeminiCodeAssistUpstream({
      account: account(),
      endpoint: "https://cloudcode-pa.googleapis.com",
      apiVersion: "v1internal",
    });
    const response = new Response(
      'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"thoughtSignature":"redacted","text":"hello"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

    const result = await collectCodexToAnthropicResponse(upstream, response, "gemini-3.1-pro");

    expect(result.response.content).toEqual([{ type: "text", text: "hello" }]);
    expect(result.usage).toMatchObject({ input_tokens: 3, output_tokens: 2 });
  });
});
