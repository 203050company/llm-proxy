import { describe, expect, it, vi } from "vitest";
import type { UpstreamAdapter } from "@src/proxy/upstream-adapter.js";
import { UpstreamRouter } from "@src/proxy/upstream-router.js";

function createAdapter(tag: string): UpstreamAdapter {
  return {
    tag,
    createResponse: async () => new Response(),
    parseStream: async function* () {},
  };
}

vi.mock("@src/models/model-store.js", () => ({
  getModelAliases: vi.fn(() => ({})),
  getModelInfo: vi.fn(() => undefined),
  parseModelName: vi.fn((input: string) => {
    // Simulate the buggy fallback: any unknown model resolves to the default Codex model.
    return { modelId: "gpt-5.4", serviceTier: null, reasoningEffort: null };
  }),
}));

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

  it("does NOT fall back to Codex when model-store resolves an OpenCode model to a default Codex model", () => {
    const opencode = createAdapter("opencode-go");
    const codex = createAdapter("codex");
    const router = new UpstreamRouter(new Map([
      ["opencode-go", opencode],
      ["codex", codex],
    ]), {}, "codex");

    // The bug: parseModelNameSafe would return "gpt-5.4" for "opencode-kimi-k2.7",
    // then isKnownCodexModel("gpt-5.4") returned true, routing to Codex.
    // After the fix, isOpencodeGoModel is checked BEFORE parseModelNameSafe,
    // so the original model name is preserved and routed to opencode-go.
    expect(router.resolveMatch("opencode-kimi-k2.7")).toMatchObject({ kind: "adapter", adapter: opencode });
    expect(router.resolveMatch("opencode-deepseek-v4-pro")).toMatchObject({ kind: "adapter", adapter: opencode });
    expect(router.resolveMatch("opencode-qwen3.6-plus")).toMatchObject({ kind: "adapter", adapter: opencode });

    // Codex models should still route to codex
    expect(router.resolveMatch("gpt-5.4")).toMatchObject({ kind: "codex" });
  });
});
