import { describe, expect, it } from "vitest";
import type { UpstreamAdapter } from "@src/proxy/upstream-adapter.js";
import { UpstreamRouter } from "@src/proxy/upstream-router.js";

function createAdapter(tag: string): UpstreamAdapter {
  return {
    tag,
    createResponse: async () => new Response(),
    parseStream: async function* () {},
  };
}

describe("UpstreamRouter opencode-go routing", () => {
  it("routes Claude aliases and opencode-go prefixes to the opencode-go adapter", () => {
    const opencode = createAdapter("opencode-go");
    const anthropic = createAdapter("anthropic");
    const router = new UpstreamRouter(new Map([
      ["opencode-go", opencode],
      ["anthropic", anthropic],
    ]), {}, "codex");

    expect(router.resolveMatch("opencode-kimi-k2.7")).toMatchObject({ kind: "adapter", adapter: opencode });
    expect(router.resolveMatch("claude-opencode-kimi-k2.7")).toMatchObject({ kind: "adapter", adapter: opencode });
    expect(router.resolveMatch("claude-opencode-kimi-k2.6")).toMatchObject({ kind: "adapter", adapter: opencode });
    expect(router.resolveMatch("opencode-go:deepseek-v4-pro")).toMatchObject({ kind: "adapter", adapter: opencode });
    expect(router.resolveMatch("opencode-go/minimax-m2.7")).toMatchObject({ kind: "adapter", adapter: opencode });
  });
});
