import { getConfig } from "../config.js";
import type {
  GeminiGoogleAiSubscription,
  GeminiGoogleAiSubscriptionTier,
  GeminiQuotaSnapshot,
} from "./gemini-types.js";

export interface GeminiCodeAssistTierInfo {
  userTier: string;
  userTierName: string | null;
  paidTier: unknown | null;
  googleAiSubscription: GeminiGoogleAiSubscription | null;
  projectId: string | null;
  quota: GeminiQuotaSnapshot | null;
}

interface FetchTierOptions {
  endpoint?: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
}

interface TierShape {
  id?: string;
  name?: string;
  isDefault?: boolean;
  raw?: unknown;
}

export async function fetchGeminiCodeAssistTier(
  accessToken: string,
  options: FetchTierOptions = {},
): Promise<GeminiCodeAssistTierInfo | null> {
  let endpoint = options.endpoint;
  let apiVersion = options.apiVersion;
  if (!endpoint || !apiVersion) {
    const config = getConfig();
    endpoint ??= config.gemini.code_assist_endpoint;
    apiVersion ??= config.gemini.code_assist_api_version;
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = endpoint.replace(/\/+$/, "");
  const response = await fetchImpl(`${baseUrl}/${apiVersion}:loadCodeAssist`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      metadata: {
        ideType: "IDE_UNSPECIFIED",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => `HTTP ${response.status}`);
    throw new Error(`Gemini Code Assist tier request failed (${response.status}): ${text}`);
  }

  const info = extractGeminiCodeAssistTierInfo(await response.json());
  if (!info?.projectId) return info;

  const quota = await fetchGeminiCodeAssistQuota(
    fetchImpl,
    `${baseUrl}/${apiVersion}:retrieveUserQuota`,
    accessToken,
    info.projectId,
  );
  if (quota) info.quota = quota;
  return info;
}

export function extractGeminiCodeAssistTierInfo(response: unknown): GeminiCodeAssistTierInfo | null {
  if (!isRecord(response)) return null;

  const paidTier = readTier(response.paidTier);
  const currentTier = readTier(response.currentTier);
  const defaultAllowedTier = readDefaultAllowedTier(response.allowedTiers);
  const selected = currentTier ?? defaultAllowedTier ?? paidTier;
  if (!selected) return null;

  const userTier = selected.id ?? selected.name;
  if (!userTier) return null;

  return {
    userTier,
    userTierName: selected.name ?? selected.id ?? null,
    paidTier: paidTier ? response.paidTier : null,
    googleAiSubscription: inferGoogleAiSubscription(response.paidTier, currentTier?.raw ?? null),
    projectId: readString(response.cloudaicompanionProject),
    quota: null,
  };
}

export function extractGeminiCodeAssistQuota(response: unknown): GeminiQuotaSnapshot | null {
  if (!isRecord(response)) return null;

  const buckets = Array.isArray(response.buckets)
    ? response.buckets
      .map((bucket) => {
        if (!isRecord(bucket)) return null;
        const modelId = readString(bucket.modelId);
        if (!modelId) return null;
        return {
          modelId,
          remainingAmount: readString(bucket.remainingAmount),
          remainingFraction: readNumber(bucket.remainingFraction),
          resetTime: readString(bucket.resetTime),
          tokenType: readString(bucket.tokenType),
        };
      })
      .filter((bucket): bucket is NonNullable<typeof bucket> => bucket !== null)
    : [];

  if (buckets.length === 0) return { raw: response };
  return { modelBuckets: buckets, raw: response };
}

async function fetchGeminiCodeAssistQuota(
  fetchImpl: typeof fetch,
  url: string,
  accessToken: string,
  projectId: string,
): Promise<GeminiQuotaSnapshot | null> {
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ project: projectId }),
    });
    if (!response.ok) return null;
    return extractGeminiCodeAssistQuota(await response.json());
  } catch {
    return null;
  }
}

function readDefaultAllowedTier(value: unknown): TierShape | null {
  if (!Array.isArray(value)) return null;
  for (const candidate of value) {
    const tier = readTier(candidate);
    if (tier?.isDefault === true) return tier;
  }
  return null;
}

function readTier(value: unknown): TierShape | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" && value.id.length > 0 ? value.id : undefined;
  const name = typeof value.name === "string" && value.name.length > 0 ? value.name : undefined;
  const isDefault = typeof value.isDefault === "boolean" ? value.isDefault : undefined;
  if (!id && !name) return null;
  return { id, name, isDefault, raw: value };
}

function inferGoogleAiSubscription(
  paidTierRaw: unknown,
  codeAssistTierRaw: unknown,
): GeminiGoogleAiSubscription | null {
  const paidTier = inferPaidGoogleAiTier(paidTierRaw);
  if (paidTier) {
    return {
      tier: paidTier,
      source: "code-assist-paid-tier",
      raw: paidTierRaw,
    };
  }

  const codeAssistTier = readTier(codeAssistTierRaw);
  if (
    paidTierRaw == null
    && ["free-tier", "standard-tier"].includes(normalizeTierId(codeAssistTier?.id) ?? "")
  ) {
    return {
      tier: "Free",
      source: "code-assist-free-tier",
      raw: codeAssistTierRaw,
    };
  }

  return null;
}

function inferPaidGoogleAiTier(value: unknown): Exclude<GeminiGoogleAiSubscriptionTier, "Free"> | null {
  if (!isRecord(value)) return null;

  const haystack = [
    value.id,
    value.name,
    value.displayName,
    value.title,
    value.licenseName,
    value.subscriptionName,
    value.planName,
  ]
    .filter((item): item is string => typeof item === "string")
    .join(" ")
    .toLowerCase();

  if (!haystack) return null;
  if (/\bultra\b|g1-ultra/.test(haystack)) return "Ultra";
  if (/\bpro\b|g1-pro/.test(haystack)) return "Pro";
  if (/\bplus\b|g1-plus/.test(haystack)) return "Plus";
  return null;
}

function normalizeTierId(id: string | null | undefined): string | null {
  const trimmed = id?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
