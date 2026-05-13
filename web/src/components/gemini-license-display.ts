import type { GeminiAccount } from "../../../shared/hooks/use-gemini-accounts";

export type GeminiLicenseKind = "paid" | "free_individual" | "unknown";

export interface GeminiLicenseDisplay {
  licenseKind: GeminiLicenseKind;
  licenseName: string | null;
  codeAssistTierName: string | null;
}

const PAID_TIER_NAME_FIELDS = [
  "name",
  "displayName",
  "title",
  "licenseName",
  "subscriptionName",
  "planName",
];

export function buildGeminiLicenseDisplay(
  account: Pick<GeminiAccount, "googleAiSubscription" | "paidTier" | "userTier" | "userTierName">,
): GeminiLicenseDisplay {
  const codeAssistTierName = null;
  const normalizedLicenseName = account.googleAiSubscription?.tier ?? null;
  if (normalizedLicenseName) {
    return {
      licenseKind: normalizedLicenseName === "Free" ? "free_individual" : "paid",
      licenseName: normalizedLicenseName,
      codeAssistTierName,
    };
  }

  const paidLicenseName = readPaidLicenseName(account.paidTier)
    ?? inferPaidTierName(account.userTier, account.userTierName);
  if (paidLicenseName) {
    return {
      licenseKind: "paid",
      licenseName: paidLicenseName,
      codeAssistTierName,
    };
  }

  if (account.paidTier == null && isFreeCodeAssistTier(account.userTier)) {
    return {
      licenseKind: "free_individual",
      licenseName: "Free",
      codeAssistTierName,
    };
  }

  return {
    licenseKind: "unknown",
    licenseName: null,
    codeAssistTierName,
  };
}

function isFreeCodeAssistTier(id: string | null | undefined): boolean {
  const normalized = normalizeTierId(id);
  return normalized === "free-tier" || normalized === "standard-tier";
}

function readPaidLicenseName(value: unknown): string | null {
  if (!isRecord(value)) return null;

  for (const field of ["id", ...PAID_TIER_NAME_FIELDS]) {
    const candidate = value[field];
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const formatted = formatKnownPaidTierId(candidate);
    if (formatted) return formatted;
  }
  return null;
}

function formatKnownPaidTierId(id: string): string | null {
  return inferPaidTierName(id);
}

function inferPaidTierName(...values: Array<string | null | undefined>): "Plus" | "Pro" | "Ultra" | null {
  const normalized = values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
  if (!normalized) return null;
  if (/\bultra\b|g1-ultra/.test(normalized)) return "Ultra";
  if (/\bpro\b|g1-pro/.test(normalized)) return "Pro";
  if (/\bplus\b|g1-plus/.test(normalized)) return "Plus";
  return null;
}

function normalizeTierId(id: string | null | undefined): string | null {
  const trimmed = id?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
