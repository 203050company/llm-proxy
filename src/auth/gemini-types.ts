export type GeminiAccountStatus =
  | "active"
  | "expired"
  | "refreshing"
  | "rate_limited"
  | "quota_exhausted"
  | "disabled"
  | "error";

export interface GeminiModelUsage {
  input_tokens: number;
  output_tokens: number;
  request_count: number;
}

export interface GeminiUsageTotals extends GeminiModelUsage {
  models: Record<string, GeminiModelUsage>;
}

export interface GeminiQuotaCredit {
  creditType: string;
  creditAmount: string;
}

export interface GeminiQuotaBucket {
  modelId: string;
  remainingAmount: string | null;
  remainingFraction: number | null;
  resetTime: string | null;
  tokenType: string | null;
}

export interface GeminiQuotaSnapshot {
  remainingCredits?: GeminiQuotaCredit[];
  consumedCredits?: GeminiQuotaCredit[];
  modelBuckets?: GeminiQuotaBucket[];
  raw?: unknown;
}

export interface GeminiModelRateLimitState {
  until: string;
  reason: string | null;
  lastStatus: number | null;
}

export type GeminiGoogleAiSubscriptionTier = "Free" | "Plus" | "Pro" | "Ultra";

export type GeminiGoogleAiSubscriptionSource =
  | "code-assist-free-tier"
  | "code-assist-paid-tier";

export interface GeminiGoogleAiSubscription {
  tier: GeminiGoogleAiSubscriptionTier;
  source: GeminiGoogleAiSubscriptionSource;
  raw?: unknown;
}

export interface GeminiAccountEntry {
  id: string;
  email: string;
  label: string | null;
  status: GeminiAccountStatus;
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  scope: string | null;
  tokenType: string;
  expiresAt: string | null;
  projectId: string | null;
  userTier: string | null;
  userTierName: string | null;
  paidTier: unknown | null;
  googleAiSubscription: GeminiGoogleAiSubscription | null;
  quota: GeminiQuotaSnapshot | null;
  quotaFetchedAt: string | null;
  lastUsedAt: string | null;
  lastRefreshSuccessAt: string | null;
  lastRefreshFailureAt: string | null;
  lastRefreshFailureCode: string | null;
  usage: GeminiUsageTotals;
  models: string[];
  modelRateLimits?: Record<string, GeminiModelRateLimitState>;
}

export type GeminiAccountSafe = Omit<
  GeminiAccountEntry,
  "accessToken" | "refreshToken" | "idToken"
> & {
  hasRefreshToken: boolean;
  accessTokenMasked: string;
};

export interface GeminiAccountPersistence {
  load(): GeminiAccountEntry[];
  save(entries: GeminiAccountEntry[]): void;
}
