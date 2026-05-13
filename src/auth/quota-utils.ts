/**
 * Shared quota conversion utility.
 * Converts CodexUsageResponse (raw backend) -> CodexQuota (normalized).
 */

import type { CodexQuota } from "./types.js";
import type { CodexUsageRateLimit, CodexUsageResponse } from "../proxy/codex-api.js";

type AnyRecord = Record<string, unknown>;

interface NormalizedWindow {
  used_percent: number | null;
  reset_at: number | null;
  limit_window_seconds: number | null;
}

function asRecord(value: unknown): AnyRecord | null {
  return value && typeof value === "object" ? value as AnyRecord : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readPlanType(usage: CodexUsageResponse): string {
  const usageRecord = usage as unknown as AnyRecord;
  const rateLimit = asRecord(usageRecord.rate_limit);
  return readString(usageRecord.plan_type)
    ?? readString(rateLimit?.plan_type)
    ?? "unknown";
}

function readWindow(source: unknown): NormalizedWindow | null {
  const win = asRecord(source);
  if (!win) return null;

  const usedPercent = readNumber(win.used_percent);
  const resetAt = readNumber(win.reset_at) ?? readNumber(win.resets_at);
  const limitWindowSeconds = readNumber(win.limit_window_seconds);
  const windowMinutes = readNumber(win.window_minutes);

  if (
    usedPercent == null &&
    resetAt == null &&
    limitWindowSeconds == null &&
    windowMinutes == null
  ) {
    return null;
  }

  return {
    used_percent: usedPercent,
    reset_at: resetAt,
    limit_window_seconds: limitWindowSeconds ?? (windowMinutes != null ? windowMinutes * 60 : null),
  };
}

function readNamedWindow(rateLimit: AnyRecord | null, ...keys: string[]): NormalizedWindow | null {
  if (!rateLimit) return null;
  for (const key of keys) {
    const window = readWindow(rateLimit[key]);
    if (window) return window;
  }
  return null;
}

function readRateLimitWindow(rateLimit: unknown, ...keys: string[]): NormalizedWindow {
  const record = asRecord(rateLimit);
  return readNamedWindow(record, ...keys)
    ?? readWindow(record)
    ?? { used_percent: null, reset_at: null, limit_window_seconds: null };
}

function isLimitReached(source: unknown, window: NormalizedWindow | null, fallback: boolean): boolean {
  const explicit = readBoolean(asRecord(source)?.limit_reached);
  if (explicit != null) return explicit;
  if (window?.used_percent != null) return window.used_percent >= 100;
  return fallback;
}

function isReviewLimitId(value: string | null | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  return normalized === "review" ||
    normalized === "code_review" ||
    normalized === "codex_review" ||
    normalized === "codex_code_review" ||
    normalized.includes("code_review") ||
    normalized.includes("codex_review");
}

function quotaFromRateLimit(rateLimit: CodexUsageRateLimit | null | undefined) {
  if (!rateLimit) return null;
  const primary = readRateLimitWindow(rateLimit, "primary_window", "primary");
  const limitReached = isLimitReached(rateLimit, primary, false);
  return {
    allowed: readBoolean((rateLimit as unknown as AnyRecord).allowed) ?? !limitReached,
    limit_reached: limitReached,
    used_percent: primary.used_percent,
    reset_at: primary.reset_at,
    limit_window_seconds: primary.limit_window_seconds,
  };
}

function secondaryQuotaFromRateLimit(rateLimit: CodexUsageRateLimit | null | undefined) {
  const record = asRecord(rateLimit);
  const secondary = readNamedWindow(record, "secondary_window", "secondary");
  if (!secondary) return null;
  return {
    limit_reached: isLimitReached(
      record?.secondary_window ?? record?.secondary,
      secondary,
      Boolean(record?.limit_reached),
    ),
    used_percent: secondary.used_percent,
    reset_at: secondary.reset_at,
    limit_window_seconds: secondary.limit_window_seconds,
  };
}

export function toQuota(usage: CodexUsageResponse): CodexQuota {
  const rateLimit = usage.rate_limit as unknown as AnyRecord;
  const primary = readRateLimitWindow(rateLimit, "primary_window", "primary");
  const secondary = readNamedWindow(rateLimit, "secondary_window", "secondary");
  const primaryLimitReached = isLimitReached(rateLimit, primary, false);
  const allowed = readBoolean(rateLimit.allowed) ?? !primaryLimitReached;
  const additional = usage.additional_rate_limits ?? [];
  const rateLimitsByLimitId: NonNullable<CodexQuota["rate_limits_by_limit_id"]> = {};
  for (const item of additional) {
    const limitId = item.metered_feature?.trim();
    if (!limitId) continue;
    const q = quotaFromRateLimit(item.rate_limit);
    if (!q) continue;
    rateLimitsByLimitId[limitId] = {
      limit_id: limitId,
      limit_name: item.limit_name || null,
      ...q,
      secondary_rate_limit: secondaryQuotaFromRateLimit(item.rate_limit),
    };
  }
  const additionalReview = additional.find((item) =>
    isReviewLimitId(item.metered_feature) || isReviewLimitId(item.limit_name)
  );
  const codeReviewRateLimit =
    quotaFromRateLimit(usage.code_review_rate_limit) ??
    quotaFromRateLimit(additionalReview?.rate_limit);

  const quota: CodexQuota = {
    plan_type: readPlanType(usage),
    rate_limit: {
      allowed,
      limit_reached: primaryLimitReached,
      used_percent: primary.used_percent,
      reset_at: primary.reset_at,
      limit_window_seconds: primary.limit_window_seconds,
    },
    secondary_rate_limit: secondary
      ? {
          limit_reached: isLimitReached(
            rateLimit.secondary_window ?? rateLimit.secondary,
            secondary,
            primaryLimitReached,
          ),
          used_percent: secondary.used_percent,
          reset_at: secondary.reset_at,
          limit_window_seconds: secondary.limit_window_seconds,
        }
      : null,
    code_review_rate_limit: codeReviewRateLimit,
  };
  if (Object.keys(rateLimitsByLimitId).length > 0) {
    quota.rate_limits_by_limit_id = rateLimitsByLimitId;
  }
  return quota;
}
