import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  OPENCODE_GO_ALIASES,
  getOpencodeGoModelAliases,
  OpencodeGoUpstream,
  resolveOpencodeGoAuth,
  resolveOpencodeGoModel,
  shouldUseOpencodeMessagesEndpoint,
} from "@src/proxy/opencode-go-upstream.js";

describe("opencode-go upstream", () => {
  const originalEnv = { ...process.env };
  let home: string;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    delete process.env.OPENCODE_GO_API_KEY;
    delete process.env.OPENCODE_GO_BASE_URL;
    home = mkdtempSync(join(tmpdir(), "opencode-go-home-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("prefers OPENCODE_GO_API_KEY over auth.json and redacts the key", () => {
    mkdirSync(join(home, ".local/share/opencode"), { recursive: true });
    writeFileSync(
      join(home, ".local/share/opencode/auth.json"),
      JSON.stringify({ "opencode-go": { key: "json-secret" } }),
    );
    process.env.OPENCODE_GO_API_KEY = "env-secret";

    const auth = resolveOpencodeGoAuth();

    expect(auth.apiKey).toBe("env-secret");
    expect(auth.source).toBe("OPENCODE_GO_API_KEY");
    expect(auth.redacted).toBe("env...cret");
  });

  it("falls back to ~/.local/share/opencode/auth.json opencode-go.key", () => {
    mkdirSync(join(home, ".local/share/opencode"), { recursive: true });
    writeFileSync(
      join(home, ".local/share/opencode/auth.json"),
      JSON.stringify({ "opencode-go": { key: "json-secret" } }),
    );

    const auth = resolveOpencodeGoAuth();

    expect(auth.apiKey).toBe("json-secret");
    expect(auth.source).toContain("auth.json");
  });

  it("maps Claude-discoverable aliases to raw opencode-go model ids", () => {
    expect(resolveOpencodeGoModel("opencode-kimi-k2.7")).toBe("kimi-k2.7");
    expect(resolveOpencodeGoModel("claude-opencode-kimi-k2.7")).toBe("kimi-k2.7");
    expect(resolveOpencodeGoModel("claude-opencode-kimi-k2.6")).toBe("kimi-k2.6");
    expect(resolveOpencodeGoModel("opencode-go:deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(resolveOpencodeGoModel("opencode-go/minimax-m2.7")).toBe("minimax-m2.7");
  });

  it("covers all static raw models with plain and Claude-compatible aliases", () => {
    for (const model of OPENCODE_GO_ALIASES) {
      expect(model.alias).toMatch(/^opencode-/);
      expect(resolveOpencodeGoModel(model.alias)).toBe(model.id);
      for (const alias of model.aliases ?? []) {
        expect(alias).toMatch(/^claude-opencode-/);
        expect(resolveOpencodeGoModel(alias)).toBe(model.id);
      }
    }
  });

  it("keeps static plain aliases after dynamic model refresh", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: "minimax-m2.7" },
        { id: "qwen3.6-plus" },
        { id: "hy3-preview" },
      ],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    getOpencodeGoModelAliases();

    await vi.waitFor(() => {
      expect(getOpencodeGoModelAliases().map((model) => model.alias)).toContain("claude-opencode-hy3-preview");
    });

    const refreshed = getOpencodeGoModelAliases();
    expect(refreshed.find((model) => model.id === "minimax-m2.7")?.alias).toBe("opencode-minimax-m2.7");
    expect(refreshed.find((model) => model.id === "qwen3.6-plus")?.alias).toBe("opencode-qwen3.6-plus");
  });

  it("routes dynamically discovered aliases to raw opencode-go model ids", async () => {
    vi.resetModules();
    const upstream = await import("@src/proxy/opencode-go-upstream.js");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "hy3-routing-preview" }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    upstream.getOpencodeGoModelAliases();

    await vi.waitFor(() => {
      expect(upstream.getOpencodeGoModelAliases().map((model) => model.alias)).toContain("claude-opencode-hy3-routing-preview");
    });

    expect(upstream.resolveOpencodeGoModel("claude-opencode-hy3-routing-preview")).toBe("hy3-routing-preview");
  });

  it("backs off after a failed dynamic model refresh", async () => {
    vi.resetModules();
    const upstream = await import("@src/proxy/opencode-go-upstream.js");
    const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    upstream.getOpencodeGoModelAliases();

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    upstream.getOpencodeGoModelAliases();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("routes MiniMax models to /messages and other models to /chat/completions", () => {
    expect(shouldUseOpencodeMessagesEndpoint("minimax-m2.7")).toBe(true);
    expect(shouldUseOpencodeMessagesEndpoint("minimax-m2.5")).toBe(true);
    expect(shouldUseOpencodeMessagesEndpoint("kimi-k2.6")).toBe(false);
    expect(shouldUseOpencodeMessagesEndpoint("deepseek-v4-pro")).toBe(false);
  });

  it("posts MiniMax requests to /messages and OpenAI-compatible models to /chat/completions", async () => {
    process.env.OPENCODE_GO_API_KEY = "secret";
    const fetchMock = vi.fn(async () => new Response("data: [DONE]\n\n", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const upstream = new OpencodeGoUpstream();
    await upstream.createResponse({
      model: "claude-opencode-minimax-m2.7",
      input: [{ role: "user", content: "hello" }],
      stream: true,
      store: false,
      max_output_tokens: 10,
    }, new AbortController().signal);
    await upstream.createResponse({
      model: "claude-opencode-kimi-k2.6",
      input: [{ role: "user", content: "hello" }],
      stream: true,
      store: false,
      max_output_tokens: 10,
    }, new AbortController().signal);

    expect(fetchMock.mock.calls[0][0]).toBe("https://opencode.ai/zen/go/v1/messages");
    expect(fetchMock.mock.calls[1][0]).toBe("https://opencode.ai/zen/go/v1/chat/completions");
  });
});
