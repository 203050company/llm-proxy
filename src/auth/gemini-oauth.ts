import { createHash, randomBytes } from "crypto";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import { getConfig } from "../config.js";

export interface GeminiOAuthSession {
  state: string;
  authUrl: string;
  codeVerifier: string;
  redirectUri: string;
  returnHost: string;
  createdAt: number;
  exchanging?: boolean;
}

export interface GeminiTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
}

interface RawGeminiCliCredentials extends Partial<GeminiTokenResponse> {
  tokens?: Partial<GeminiTokenResponse> | null;
  expiry_date?: number;
  expires_at?: number;
}

const GEMINI_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

const SESSION_TTL_MS = 5 * 60 * 1000;
const pendingSessions = new Map<string, GeminiOAuthSession>();
const completedSessions = new Map<string, number>();

setInterval(() => {
  const now = Date.now();
  for (const [state, session] of pendingSessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      pendingSessions.delete(state);
    }
  }
  for (const [state, completedAt] of completedSessions) {
    if (now - completedAt > SESSION_TTL_MS) {
      completedSessions.delete(state);
    }
  }
}, 60_000).unref();

export function createGeminiOAuthSession(returnHost: string): GeminiOAuthSession {
  const config = getConfig();
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const state = randomBytes(16).toString("hex");
  const redirectUri = buildRedirectUri(returnHost);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: requireGeminiOAuthClientId(),
    redirect_uri: redirectUri,
    scope: GEMINI_SCOPES.join(" "),
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });

  const session: GeminiOAuthSession = {
    state,
    authUrl: `${config.gemini.oauth_auth_endpoint}?${params.toString()}`,
    codeVerifier,
    redirectUri,
    returnHost,
    createdAt: Date.now(),
  };
  pendingSessions.set(state, session);
  return session;
}

export function tryAcquireGeminiSession(state: string): GeminiOAuthSession | null {
  const session = pendingSessions.get(state);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    pendingSessions.delete(state);
    return null;
  }
  if (session.exchanging) return null;
  session.exchanging = true;
  return session;
}

export function releaseGeminiSession(state: string): void {
  const session = pendingSessions.get(state);
  if (session) session.exchanging = false;
}

export function deleteGeminiSession(state: string): void {
  pendingSessions.delete(state);
}

export function markGeminiSessionCompleted(state: string): void {
  completedSessions.set(state, Date.now());
}

export function isGeminiSessionCompleted(state: string): boolean {
  return completedSessions.has(state);
}

export function isGeminiSessionExchanging(state: string): boolean {
  return pendingSessions.get(state)?.exchanging === true;
}

export async function exchangeGeminiCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<GeminiTokenResponse> {
  const config = getConfig();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    client_id: requireGeminiOAuthClientId(),
  });
  const clientSecret = resolveGeminiOAuthClientSecret();
  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }

  return postTokenRequest(config.gemini.oauth_token_endpoint, body);
}

export async function refreshGeminiAccessToken(refreshToken: string): Promise<GeminiTokenResponse> {
  const config = getConfig();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: requireGeminiOAuthClientId(),
  });
  const clientSecret = resolveGeminiOAuthClientSecret();
  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }

  return postTokenRequest(config.gemini.oauth_token_endpoint, body);
}

export async function fetchGeminiUserInfo(accessToken: string): Promise<{ email: string }> {
  const config = getConfig();
  const response = await fetch(config.gemini.oauth_userinfo_endpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => `HTTP ${response.status}`);
    throw new Error(`Gemini userinfo failed (${response.status}): ${text}`);
  }

  const data = await response.json() as { email?: unknown };
  if (typeof data.email !== "string" || data.email.length === 0) {
    throw new Error("Gemini userinfo did not include an email");
  }
  return { email: data.email };
}

export async function importGeminiCliCredentials(filePath?: string): Promise<GeminiTokenResponse> {
  const config = getConfig();
  const path = expandHome(filePath ?? config.gemini.credentials_path);
  if (!existsSync(path)) {
    throw new Error(`Gemini CLI credentials file not found: ${path}`);
  }

  const raw = readFileSync(path, "utf-8");
  const data = JSON.parse(raw) as RawGeminiCliCredentials;
  const tokens = data.tokens && typeof data.tokens === "object" ? data.tokens : data;
  if (!tokens.access_token) {
    throw new Error(`Gemini CLI credentials do not contain access_token: ${path}`);
  }

  const expiresIn = computeExpiresIn(data);
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    id_token: tokens.id_token,
    token_type: tokens.token_type ?? "Bearer",
    scope: tokens.scope,
    ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
  };
}

async function postTokenRequest(endpoint: string, body: URLSearchParams): Promise<GeminiTokenResponse> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => `HTTP ${response.status}`);
    throw new Error(`Gemini token request failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<GeminiTokenResponse>;
}

function buildRedirectUri(returnHost: string): string {
  const config = getConfig();
  const port = parsePort(returnHost) ?? config.server?.port ?? 8080;
  return `http://${config.gemini.oauth_callback_host}:${port}${config.gemini.oauth_callback_path}`;
}

function resolveGeminiOAuthClientSecret(): string | null {
  const config = getConfig();
  const configured = config.gemini.oauth_client_secret?.trim();
  if (configured) return configured;
  return null;
}

function requireGeminiOAuthClientId(): string {
  const clientId = getConfig().gemini.oauth_client_id.trim();
  if (!clientId) {
    throw new Error(
      "Gemini OAuth client id is not configured. Set gemini.oauth_client_id in data/local.yaml or GEMINI_OAUTH_CLIENT_ID.",
    );
  }
  return clientId;
}

function parsePort(host: string): number | null {
  const match = host.match(/:(\d+)$/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

function computeExpiresIn(data: RawGeminiCliCredentials): number | undefined {
  const millis = typeof data.expiry_date === "number"
    ? data.expiry_date
    : typeof data.expires_at === "number"
      ? data.expires_at * 1000
      : undefined;
  if (millis === undefined) return undefined;
  return Math.max(0, Math.floor((millis - Date.now()) / 1000));
}
