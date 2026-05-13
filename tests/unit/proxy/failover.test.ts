import { describe, it, expect, vi } from "vitest";
import { UpstreamRouter } from "@src/proxy/upstream-router.js";
import type { UpstreamAdapter } from "@src/proxy/upstream-adapter.js";
import type { ApiKeyPool, ApiKeyEntry } from "@src/auth/api-key-pool.js";

function makeAdapter(tag: string): UpstreamAdapter {
  return {
    tag,
    createResponse: vi.fn(),
    parseStream: vi.fn(),
  };
}

describe("UpstreamRouter Failover", () => {
  const geminiAdapter = makeAdapter("gemini");
  const adapters = new Map([["gemini", geminiAdapter]]);
  
  const router = new UpstreamRouter(adapters, {}, "codex");

  it("falls back from gemini-3.1-pro to gemini-3-pro if no keys exist for pro", () => {
    const mockPool = {
      getByModel: vi.fn((model: string) => {
        if (model === "gemini-3-pro") {
          return [{ id: "key1", provider: "gemini", model: "gemini-3-pro", apiKey: "abc", status: "active" } as ApiKeyEntry];
        }
        return [];
      }),
      markUsed: vi.fn(),
    } as unknown as ApiKeyPool;

    router.setApiKeyPool(mockPool, (entry) => makeAdapter(entry.provider));

    const match = router.resolveMatch("gemini-3.1-pro");
    expect(match.kind).toBe("api-key");
    if (match.kind === "api-key") {
      expect(match.entry.model).toBe("gemini-3-pro");
    }
  });

  it("falls back from opus to sonnet then haiku", () => {
    const mockPool = {
      getByModel: vi.fn((model: string) => {
        if (model === "haiku") {
          return [{ id: "key-haiku", provider: "gemini", model: "haiku", apiKey: "h", status: "active" } as ApiKeyEntry];
        }
        return [];
      }),
      markUsed: vi.fn(),
    } as unknown as ApiKeyPool;

    router.setApiKeyPool(mockPool, (entry) => makeAdapter(entry.provider));

    const match = router.resolveMatch("opus");
    expect(match.kind).toBe("api-key");
    if (match.kind === "api-key") {
      expect(match.entry.model).toBe("haiku");
    }
  });

  it("returns not-found if the entire chain is exhausted", () => {
    const mockPool = {
      getByModel: vi.fn(() => []),
      markUsed: vi.fn(),
    } as unknown as ApiKeyPool;

    router.setApiKeyPool(mockPool, (entry) => makeAdapter(entry.provider));

    const match = router.resolveMatch("opus");
    expect(match.kind).toBe("not-found");
  });
});
