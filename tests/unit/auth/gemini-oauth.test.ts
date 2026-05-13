import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockConfig = vi.hoisted(() => ({
  gemini: {
    oauth_client_id: "client-test.apps.googleusercontent.com",
    oauth_client_secret: null as string | null,
    oauth_auth_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    oauth_token_endpoint: "https://oauth2.googleapis.com/token",
    oauth_userinfo_endpoint: "https://www.googleapis.com/oauth2/v2/userinfo",
    oauth_callback_host: "127.0.0.1",
    oauth_callback_path: "/oauth2callback",
    credentials_path: "~/.gemini/oauth_creds.json",
    project_id: "project-test",
  },
}));

vi.mock("@src/config.js", () => ({
  getConfig: () => mockConfig,
}));

describe("gemini oauth", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockConfig.gemini.oauth_client_id = "client-test.apps.googleusercontent.com";
    mockConfig.gemini.oauth_client_secret = null;
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const textUrl = String(url);
      if (textUrl.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({
          access_token: "access-test",
          refresh_token: "refresh-test",
          id_token: "id-test",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid https://www.googleapis.com/auth/cloud-platform",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (textUrl.includes("oauth2/v2/userinfo")) {
        return new Response(JSON.stringify({ email: "user@example.com" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.resetModules();
  });

  it("builds a Google OAuth URL with Gemini CLI scopes", async () => {
    const { createGeminiOAuthSession } = await import("@src/auth/gemini-oauth.js");
    const session = createGeminiOAuthSession("localhost:8080");
    const url = new URL(session.authUrl);

    expect(url.hostname).toBe("accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("client-test.apps.googleusercontent.com");
    expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/cloud-platform");
    expect(url.searchParams.get("access_type")).toBe("offline");
  });

  it("exchanges an auth code and fetches user info", async () => {
    const { createGeminiOAuthSession, exchangeGeminiCode } = await import("@src/auth/gemini-oauth.js");
    const session = createGeminiOAuthSession("localhost:8080");
    const tokens = await exchangeGeminiCode("code-test", session.codeVerifier, session.redirectUri);

    expect(tokens.access_token).toBe("access-test");
    expect(tokens.refresh_token).toBe("refresh-test");
  });

  it("sends the configured Gemini OAuth client secret", async () => {
    mockConfig.gemini.oauth_client_id = "client-test.apps.googleusercontent.com";
    mockConfig.gemini.oauth_client_secret = "secret-test";
    const { createGeminiOAuthSession, exchangeGeminiCode } = await import("@src/auth/gemini-oauth.js");

    const session = createGeminiOAuthSession("localhost:8080");
    await exchangeGeminiCode("code-test", session.codeVerifier, session.redirectUri);

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    expect(String(init?.body)).toContain("client_secret=secret-test");
  });
});
