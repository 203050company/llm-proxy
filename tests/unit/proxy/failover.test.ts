import { describe, expect, it, vi } from "vitest";
import { UpstreamRouter } from "@src/proxy/upstream-router.js";
import type { UpstreamAdapter } from "@src/proxy/upstream-adapter.js";
import type { ApiKeyEntry, ApiKeyPool } from "@src/auth/api-key-pool.js";

function makeAdapter(tag: string): UpstreamAdapter {
  return {
    tag,
    createResponse: vi.fn(),
    parseStream: vi.fn(),
  };
}

describe("UpstreamRouter Failover", () => {
  const router = new UpstreamRouter(new Map(), {}, "codex");

  it("falls back from opus to sonnet then haiku", () => {
    const mockPool = {
      getByModel: vi.fn((model: string) => {
        if (model === "haiku") {
          return [{ id: "key-haiku", provider: "openai", model: "haiku", apiKey: "h", status: "active" } as ApiKeyEntry];
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
