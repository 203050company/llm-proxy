import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "@src/proxy/codex-usage.js";
import type { TlsTransport } from "@src/tls/transport.js";

vi.mock("@src/config.js", () => ({
  getConfig: () => ({
    api: { base_url: "https://chatgpt.example.test/backend-api" },
    tls: { force_http11: false },
  }),
}));

function makeTransport(): TlsTransport {
  return {
    isImpersonate: () => false,
    post: vi.fn(),
    simplePost: vi.fn(),
    get: vi.fn(async () => ({
      status: 500,
      body: '{"error":"Native addon not found"}',
    })),
  } as unknown as TlsTransport;
}

describe("codex usage native fallback", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          rate_limit: {
            plan_type: "plus",
            used_percent: 12,
            resets_at: 1778234074,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("falls back to Node fetch when usage GET reports a missing native addon", async () => {
    const usage = await fetchUsage(
      { Authorization: "Bearer access-test" },
      null,
      undefined,
      makeTransport(),
    );

    expect(usage.rate_limit.plan_type).toBe("plus");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://chatgpt.example.test/backend-api/codex/usage",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer access-test",
          Accept: "application/json",
        }),
      }),
    );
  });

  it("preserves ChatGPT-Account-Id for usage requests", async () => {
    const transport = makeTransport();

    await fetchUsage(
      {
        Authorization: "Bearer access-test",
        "ChatGPT-Account-Id": "acct-test",
      },
      null,
      undefined,
      transport,
    );

    expect(transport.get).toHaveBeenCalledWith(
      "https://chatgpt.example.test/backend-api/codex/usage",
      expect.objectContaining({
        "ChatGPT-Account-Id": "acct-test",
      }),
      15,
      null,
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "https://chatgpt.example.test/backend-api/codex/usage",
      expect.objectContaining({
        headers: expect.objectContaining({
          "ChatGPT-Account-Id": "acct-test",
        }),
      }),
    );
  });

  it("retries Node fetch fallback after a transient Cloudflare 403", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response("<html>forbidden</html>", { status: 403 }))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          plan_type: "plus",
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: {
              used_percent: 45,
              reset_at: 1778234074,
              limit_window_seconds: 18000,
            },
            secondary_window: null,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const usage = await fetchUsage(
      { Authorization: "Bearer access-test" },
      null,
      undefined,
      makeTransport(),
    );

    expect(usage.plan_type).toBe("plus");
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
