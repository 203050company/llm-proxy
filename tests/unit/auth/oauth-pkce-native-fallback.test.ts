import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@src/config.js", () => ({
  getConfig: () => ({
    auth: {
      oauth_client_id: "app_test",
      oauth_token_endpoint: "https://auth.example.test/token",
    },
    tls: { proxy_url: null, force_http11: false },
  }),
}));

vi.mock("@src/tls/direct-fallback.js", () => ({
  withDirectFallback: async (fn: (proxyUrl: string | null | undefined) => Promise<unknown>) => fn(null),
  isCloudflareChallengeResponse: () => false,
  isProxyNetworkError: () => false,
  isSafeToRetryRefresh: () => false,
}));

const curlFetchPost = vi.fn(async () => ({
  ok: true,
  status: 200,
  body: JSON.stringify({ access_token: "at_test", refresh_token: "rt_test", token_type: "Bearer" }),
}));

vi.mock("@src/tls/curl-fetch.js", () => ({ curlFetchPost }));
vi.mock("@src/tls/proxy.js", () => ({ getProxyUrl: () => null }));

describe("Codex OAuth native fallback option", () => {
  beforeEach(() => curlFetchPost.mockClear());

  it("passes fallbackToFetchOnNativeAddonMissing during code exchange", async () => {
    const { exchangeCode } = await import("@src/auth/oauth-pkce.js");
    await exchangeCode("code_test", "verifier_test", "http://localhost:1455/auth/callback");

    expect(curlFetchPost).toHaveBeenCalledWith(
      "https://auth.example.test/token",
      "application/x-www-form-urlencoded",
      expect.stringContaining("grant_type=authorization_code"),
      expect.objectContaining({ proxyUrl: null, fallbackToFetchOnNativeAddonMissing: true }),
    );
  });
});
