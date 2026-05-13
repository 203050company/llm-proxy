import type { GeminiAccount, GeminiQuotaBucket, GeminiQuotaSnapshot } from "../../../shared/hooks/use-gemini-accounts";

export interface GeminiModelUsageRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  totalTokens: number;
  tokenSharePercent: number;
  quotaUsedPercent: number | null;
  quotaRemainingPercent: number | null;
  quotaResetTime: string | null;
  quotaRemainingAmount: string | null;
  quotaTokenType: string | null;
  graphPercent: number;
  hasQuota: boolean;
}

type GeminiModelUsageAccount = Pick<GeminiAccount, "models" | "usage" | "quota">;

export function buildGeminiModelUsageRows(account: GeminiModelUsageAccount): GeminiModelUsageRow[] {
  const usageByModel = account.usage?.models ?? {};
  const quotaBuckets = readQuotaBuckets(account.quota);
  const quotaByModel = new Map(quotaBuckets.map((bucket) => [bucket.modelId, bucket]));
  const aggregateInputTokens = readCount(account.usage?.input_tokens);
  const aggregateOutputTokens = readCount(account.usage?.output_tokens);
  const aggregateRequestCount = readCount(account.usage?.request_count);
  
  // Use account.models as the baseline if available
  const modelIds = new Set<string>([
    ...(account.models || []),
    ...Object.keys(usageByModel),
    ...quotaBuckets.map((bucket) => bucket.modelId),
  ]);
  
  const totalTokensAcrossModels = Object.values(usageByModel)
    .reduce((sum, usage) => sum + readCount(usage.input_tokens) + readCount(usage.output_tokens), 0);

  if (modelIds.size === 0 && (aggregateInputTokens > 0 || aggregateOutputTokens > 0 || aggregateRequestCount > 0)) {
    return [{
      model: "All Gemini models",
      inputTokens: aggregateInputTokens,
      outputTokens: aggregateOutputTokens,
      requestCount: aggregateRequestCount,
      totalTokens: aggregateInputTokens + aggregateOutputTokens,
      tokenSharePercent: 100,
      quotaUsedPercent: null,
      quotaRemainingPercent: null,
      quotaResetTime: null,
      quotaRemainingAmount: null,
      quotaTokenType: null,
      graphPercent: 100,
      hasQuota: false,
    }];
  }

  return [...modelIds]
    .map((model): GeminiModelUsageRow => {
      const usage = usageByModel[model];
      const inputTokens = readCount(usage?.input_tokens);
      const outputTokens = readCount(usage?.output_tokens);
      const requestCount = readCount(usage?.request_count);
      const totalTokens = inputTokens + outputTokens;
      const tokenSharePercent = totalTokensAcrossModels > 0
        ? percent(totalTokens / totalTokensAcrossModels)
        : 0;
      const quota = quotaByModel.get(model);
      const quotaRemainingPercent = quota?.remainingFraction == null
        ? null
        : percent(clamp01(quota.remainingFraction));
      const quotaUsedPercent = quotaRemainingPercent == null ? null : 100 - quotaRemainingPercent;

      return {
        model,
        inputTokens,
        outputTokens,
        requestCount,
        totalTokens,
        tokenSharePercent,
        quotaUsedPercent,
        quotaRemainingPercent,
        quotaResetTime: quota?.resetTime ?? null,
        quotaRemainingAmount: quota?.remainingAmount ?? null,
        quotaTokenType: quota?.tokenType ?? null,
        graphPercent: quotaUsedPercent ?? tokenSharePercent,
        hasQuota: quotaUsedPercent != null,
      };
    })
    .sort((a, b) => {
      const modelOrder = compareGeminiModelOrder(a.model, b.model);
      if (modelOrder !== 0) return modelOrder;
      if (a.hasQuota !== b.hasQuota) return a.hasQuota ? -1 : 1;
      if (a.graphPercent !== b.graphPercent) return b.graphPercent - a.graphPercent;
      return a.model.localeCompare(b.model);
    });
}

export function getVisibleGeminiModelUsageRows(
  rows: GeminiModelUsageRow[],
  limit: number,
): { visible: GeminiModelUsageRow[]; hiddenCount: number } {
  const safeLimit = Math.max(0, Math.floor(limit));
  return {
    visible: rows.slice(0, safeLimit),
    hiddenCount: Math.max(0, rows.length - safeLimit),
  };
}

function readQuotaBuckets(quota: GeminiQuotaSnapshot | null | undefined): GeminiQuotaBucket[] {
  if (Array.isArray(quota?.modelBuckets)) return quota.modelBuckets.filter(isUsableQuotaBucket);
  const raw = quota?.raw;
  if (!isRecord(raw) || !Array.isArray(raw.buckets)) return [];
  return raw.buckets
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
    .filter((bucket): bucket is GeminiQuotaBucket => bucket !== null)
    .filter(isUsableQuotaBucket);
}

function isUsableQuotaBucket(bucket: GeminiQuotaBucket): boolean {
  if (bucket.remainingFraction === 0 && bucket.resetTime?.startsWith("1970-01-01T00:00:00")) {
    return false;
  }
  return true;
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function percent(value: number): number {
  return Math.round(value * 100);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function compareGeminiModelOrder(a: string, b: string): number {
  const parsedA = parseGeminiModelOrder(a);
  const parsedB = parseGeminiModelOrder(b);
  if (!parsedA && !parsedB) return 0;
  if (!parsedA) return 1;
  if (!parsedB) return -1;

  const maxParts = Math.max(parsedA.version.length, parsedB.version.length);
  for (let i = 0; i < maxParts; i++) {
    const partA = parsedA.version[i] ?? 0;
    const partB = parsedB.version[i] ?? 0;
    if (partA !== partB) return partB - partA;
  }
  if (parsedA.tierRank !== parsedB.tierRank) {
    return parsedB.tierRank - parsedA.tierRank;
  }
  return 0;
}

function parseGeminiModelOrder(model: string): { version: number[]; tierRank: number } | null {
  const normalized = model.toLowerCase().trim();
  const match = normalized.match(/^gemini-(\d+(?:\.\d+)*)(?:-(.*))?$/);
  if (!match) return null;

  const version = match[1].split(".").map((part) => Number.parseInt(part, 10));
  if (version.some((part) => !Number.isFinite(part))) return null;

  return {
    version,
    tierRank: geminiTierRank(match[2] ?? ""),
  };
}

function geminiTierRank(suffix: string): number {
  if (suffix.startsWith("pro")) return 30;
  if (suffix.startsWith("flash-lite")) return 10;
  if (suffix.startsWith("flash")) return 20;
  return 0;
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
