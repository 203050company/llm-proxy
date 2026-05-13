import { describe, expect, it, vi } from "vitest";

const mockConfig = {
  server: { proxy_api_key: null },
  gemini: {
    oauth_enabled: true,
    credentials_path: "~/.gemini/oauth_creds.json",
    code_assist_endpoint: "https://cloudcode-pa.googleapis.com",
    code_assist_api_version: "v1internal",
    project_id: null as string | null,
    refresh_enabled: true,
    refresh_margin_seconds: 300,
    refresh_concurrency: 2,
    api_key_priority: "api_key",
    routing: { opus: "gemini-3.1-pro", sonnet: "gemini-3-pro", haiku: "gemini-3.1-flash-lite" },
  },
};

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
  getLocalConfigPath: vi.fn(() => "/tmp/local.yaml"),
  reloadAllConfigs: vi.fn(),
  ROTATION_STRATEGIES: ["least_used", "round_robin", "sticky"],
}));

vi.mock("@src/utils/yaml-mutate.js", () => ({ mutateYaml: vi.fn() }));
vi.mock("@hono/node-server/conninfo", () => ({ getConnInfo: vi.fn(() => ({ remote: { address: "127.0.0.1" } })) }));
vi.mock("@src/auth/dashboard-session.js", () => ({ validateSession: vi.fn(() => false) }));

import { createSettingsRoutes } from "@src/routes/admin/settings.js";

describe("Gemini settings routes", () => {
  it("GET /admin/gemini-settings returns Gemini routing config", async () => {
    const app = createSettingsRoutes();
    const res = await app.request("/admin/gemini-settings");
    const body = await res.json() as { routing: { opus: string } };

    expect(res.status).toBe(200);
    expect(body.routing.opus).toBe("gemini-3.1-pro");
  });
});
