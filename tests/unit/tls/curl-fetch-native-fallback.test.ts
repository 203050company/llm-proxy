import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { curlFetchPost } from "@src/tls/curl-fetch.js";
import type { TlsTransport } from "@src/tls/transport.js";

vi.mock("@src/fingerprint/manager.js", () => ({
  buildAnonymousHeaders: () => ({
    "Accept-Encoding": "gzip",
    "User-Agent": "test-agent",
  }),
}));

function makeTransport(): TlsTransport {
  return {
    isImpersonate: () => false,
    post: vi.fn(),
    get: vi.fn(),
    simplePost: vi.fn(async () => ({
      status: 500,
      body: '{"error":"Native addon not found"}',
    })),
  } as unknown as TlsTransport;
}

describe("curlFetchPost native addon fallback", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: "at_test", token_type: "Bearer" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("falls back to Node fetch only when explicitly enabled and native addon is missing", async () => {
    const resp = await curlFetchPost(
      "https://auth.example.test/token",
      "application/x-www-form-urlencoded",
      "grant_type=authorization_code",
      { transport: makeTransport(), fallbackToFetchOnNativeAddonMissing: true },
    );

    expect(resp).toEqual({
      status: 200,
      ok: true,
      body: '{"access_token":"at_test","token_type":"Bearer"}',
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://auth.example.test/token",
      expect.objectContaining({
        method: "POST",
        body: "grant_type=authorization_code",
      }),
    );
  });

  it("does not fall back unless the option is enabled", async () => {
    const resp = await curlFetchPost(
      "https://auth.example.test/token",
      "application/x-www-form-urlencoded",
      "grant_type=authorization_code",
      { transport: makeTransport() },
    );

    expect(resp.status).toBe(500);
    expect(resp.body).toBe('{"error":"Native addon not found"}');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
