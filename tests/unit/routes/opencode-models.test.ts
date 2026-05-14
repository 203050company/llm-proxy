import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockConfig = {
  server: { proxy_api_key: null as string | null },
};

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

vi.mock("@src/paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-opencode-models"),
  getConfigDir: vi.fn(() => "/tmp/test-opencode-models-config"),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(() => "models: []\naliases: {}"),
    writeFileSync: vi.fn(),
    writeFile: vi.fn(
      (_p: string, _d: string, _e: string, cb: (err: Error | null) => void) => cb(null),
    ),
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    renameSync: vi.fn(),
  };
});

vi.mock("js-yaml", () => ({
  default: {
    load: vi.fn(() => ({ models: [], aliases: {} })),
    dump: vi.fn(() => "models: []"),
  },
}));

vi.mock("@src/models/model-fetcher.js", () => ({
  triggerImmediateRefresh: vi.fn(),
}));

import { loadStaticModels } from "@src/models/model-store.js";
import { createModelRoutes } from "@src/routes/models.js";

describe("opencode-go model aliases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    loadStaticModels();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes Claude-discoverable aliases from /v1/models", async () => {
    const app = createModelRoutes();

    const res = await app.request("/v1/models");
    const body = await res.json() as { data: Array<Record<string, unknown>> };
    const ids = body.data.map((model) => model.id);

    expect(ids).toContain("opencode-kimi-k2.7");
    expect(ids).toContain("opencode-kimi-k2.6");
    expect(ids).toContain("opencode-deepseek-v4-pro");
    expect(ids).toContain("opencode-minimax-m2.7");
    expect(body.data.find((model) => model.id === "opencode-kimi-k2.7")).toMatchObject({
      type: "model",
      display_name: "opencode-go kimi-k2.7",
    });
  });

  it("returns opencode-go aliases from /v1/models/:modelId", async () => {
    const app = createModelRoutes();

    const res = await app.request("/v1/models/opencode-kimi-k2.7");
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      id: "opencode-kimi-k2.7",
      object: "model",
      type: "model",
      display_name: "opencode-go kimi-k2.7",
      owned_by: "opencode-go",
    });
  });
});
