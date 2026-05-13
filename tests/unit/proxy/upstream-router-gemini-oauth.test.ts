import { describe, expect, it, vi } from "vitest";
import { UpstreamRouter } from "@src/proxy/upstream-router.js";
import type { ApiKeyEntry, ApiKeyPool } from "@src/auth/api-key-pool.js";

const geminiOAuthAdapter = {
  tag: "gemini-oauth",
  createResponse: vi.fn(),
  parseStream: vi.fn(),
};

const apiKeyAdapter = {
  tag: "gemini",
  createResponse: vi.fn(),
  parseStream: vi.fn(),
};

function fakeApiKeyPool(): ApiKeyPool {
  const entry: ApiKeyEntry = {
    id: "key-1",
    provider: "gemini",
    label: null,
    apiKey: "secret",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-3.1-pro",
    status: "active",
    usage: { input_tokens: 0, output_tokens: 0, request_count: 0 },
    addedAt: new Date().toISOString(),
    lastUsedAt: null,
  };

  return {
    getByModel: (model: string) => model === "gemini-3.1-pro" ? [entry] : [],
    markUsed: vi.fn(),
  } as unknown as ApiKeyPool;
}

function attachGeminiOAuth(router: UpstreamRouter): void {
  router.setGeminiOAuth({
    hasActiveModel: (model: string) => model === "gemini-3.1-pro",
  }, () => ({
    accountId: "gemini-1",
    adapter: geminiOAuthAdapter,
  }));
}

describe("UpstreamRouter Gemini OAuth", () => {
  it("keeps runtime API keys first when Gemini priority is api_key", () => {
    const router = new UpstreamRouter(new Map(), {}, "codex", { geminiPriority: "api_key" });
    router.setApiKeyPool(fakeApiKeyPool(), () => apiKeyAdapter);
    attachGeminiOAuth(router);

    const match = router.resolveMatch("gemini-3.1-pro");

    expect(match.kind).toBe("api-key");
  });

  it("routes Gemini models to OAuth first when Gemini priority is oauth", () => {
    const router = new UpstreamRouter(new Map(), {}, "codex", { geminiPriority: "oauth" });
    router.setApiKeyPool(fakeApiKeyPool(), () => apiKeyAdapter);
    attachGeminiOAuth(router);

    const match = router.resolveMatch("gemini-3.1-pro");

    expect(match.kind).toBe("gemini-oauth");
    expect(match.kind === "gemini-oauth" ? match.accountId : null).toBe("gemini-1");
  });
});
