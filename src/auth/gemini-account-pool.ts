import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { randomBytes } from "crypto";
import { dirname, resolve } from "path";
import { getDataDir } from "../paths.js";
import type {
  GeminiAccountEntry,
  GeminiAccountPersistence,
  GeminiAccountSafe,
  GeminiAccountStatus,
  GeminiModelRateLimitState,
  GeminiModelUsage,
  GeminiQuotaSnapshot,
} from "./gemini-types.js";

interface GeminiAccountsFile {
  accounts: GeminiAccountEntry[];
}

function getGeminiAccountsFile(): string {
  return resolve(getDataDir(), "gemini-accounts.json");
}

function emptyUsage(): GeminiAccountEntry["usage"] {
  return { input_tokens: 0, output_tokens: 0, request_count: 0, models: {} };
}

function normalizeUsage(usage: GeminiAccountEntry["usage"] | undefined): GeminiAccountEntry["usage"] {
  return {
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    request_count: usage?.request_count ?? 0,
    models: usage?.models ?? {},
  };
}

function normalizeEntry(entry: GeminiAccountEntry): GeminiAccountEntry {
  return {
    ...entry,
    label: entry.label ?? null,
    refreshToken: entry.refreshToken ?? null,
    idToken: entry.idToken ?? null,
    scope: entry.scope ?? null,
    tokenType: entry.tokenType || "Bearer",
    expiresAt: entry.expiresAt ?? null,
    projectId: entry.projectId ?? null,
    userTier: entry.userTier ?? null,
    userTierName: entry.userTierName ?? null,
    paidTier: entry.paidTier ?? null,
    googleAiSubscription: entry.googleAiSubscription ?? null,
    quota: entry.quota ?? null,
    quotaFetchedAt: entry.quotaFetchedAt ?? null,
    lastUsedAt: entry.lastUsedAt ?? null,
    lastRefreshSuccessAt: entry.lastRefreshSuccessAt ?? null,
    lastRefreshFailureAt: entry.lastRefreshFailureAt ?? null,
    lastRefreshFailureCode: entry.lastRefreshFailureCode ?? null,
    usage: normalizeUsage(entry.usage),
    models: Array.isArray(entry.models) ? entry.models : [],
    modelRateLimits: normalizeModelRateLimits(entry.modelRateLimits),
  };
}

function normalizeModelRateLimits(
  limits: GeminiAccountEntry["modelRateLimits"] | undefined,
): Record<string, GeminiModelRateLimitState> {
  if (!limits || typeof limits !== "object") return {};
  const normalized: Record<string, GeminiModelRateLimitState> = {};
  for (const [model, limit] of Object.entries(limits)) {
    if (!limit || typeof limit !== "object") continue;
    const until = typeof limit.until === "string" ? limit.until : null;
    if (!until) continue;
    normalized[normalizeModelId(model)] = {
      until,
      reason: typeof limit.reason === "string" ? limit.reason : null,
      lastStatus: typeof limit.lastStatus === "number" ? limit.lastStatus : null,
    };
  }
  return normalized;
}

export function createFsGeminiAccountPersistence(): GeminiAccountPersistence {
  return {
    load(): GeminiAccountEntry[] {
      try {
        const file = getGeminiAccountsFile();
        if (!existsSync(file)) return [];
        const raw = readFileSync(file, "utf-8");
        const data = JSON.parse(raw) as GeminiAccountsFile;
        return Array.isArray(data.accounts) ? data.accounts.map(normalizeEntry) : [];
      } catch {
        return [];
      }
    },
    save(entries: GeminiAccountEntry[]): void {
      try {
        const file = getGeminiAccountsFile();
        const dir = dirname(file);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const tmp = file + ".tmp";
        writeFileSync(tmp, JSON.stringify({ accounts: entries }, null, 2), "utf-8");
        renameSync(tmp, file);
      } catch (err) {
        console.error("[GeminiAccountPool] Failed to persist:", err instanceof Error ? err.message : err);
      }
    },
  };
}

export class GeminiAccountPool {
  private entries: GeminiAccountEntry[];
  private readonly persistence: GeminiAccountPersistence;

  constructor(persistence?: GeminiAccountPersistence) {
    this.persistence = persistence ?? createFsGeminiAccountPersistence();
    this.entries = this.persistence.load().map(normalizeEntry);
  }

  getAll(): GeminiAccountEntry[] {
    return [...this.entries];
  }

  getEntry(id: string): GeminiAccountEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  getMaskedAccounts(): GeminiAccountSafe[] {
    return this.entries.map((entry) => {
      const {
        accessToken,
        refreshToken,
        idToken,
        ...safe
      } = entry;
      void idToken;
      return {
        ...safe,
        hasRefreshToken: Boolean(refreshToken),
        accessTokenMasked: maskToken(accessToken),
      };
    });
  }

  getActiveAccounts(): GeminiAccountEntry[] {
    return this.entries.filter((entry) => entry.status === "active");
  }

  hasActiveModel(model: string): boolean {
    this.clearExpiredModelRateLimits();
    return this.getActiveAccounts().some((entry) => entrySupportsModel(entry, model));
  }

  pickAccountForModel(
    model: string,
    excludedAccountIds: Iterable<string> = [],
  ): GeminiAccountEntry | undefined {
    this.clearExpiredModelRateLimits();
    const excluded = new Set(excludedAccountIds);
    const candidates = this.getActiveAccounts()
      .filter((entry) => !excluded.has(entry.id))
      .filter((entry) => entrySupportsModel(entry, model));
    if (candidates.length === 0) return undefined;
    return pickLeastRecentlyUsed(candidates);
  }

  markModelRateLimited(
    id: string,
    model: string,
    limit: GeminiModelRateLimitState,
  ): boolean {
    const entry = this.getEntry(id);
    if (!entry) return false;
    entry.modelRateLimits ??= {};
    entry.modelRateLimits[normalizeModelId(model)] = {
      until: limit.until,
      reason: limit.reason ?? null,
      lastStatus: limit.lastStatus ?? null,
    };
    this.persist();
    return true;
  }

  clearModelRateLimit(id: string, model: string): boolean {
    const entry = this.getEntry(id);
    if (!entry?.modelRateLimits) return false;
    const key = normalizeModelId(model);
    if (!(key in entry.modelRateLimits)) return false;
    delete entry.modelRateLimits[key];
    this.persist();
    return true;
  }

  addOrUpdate(entry: GeminiAccountEntry): GeminiAccountEntry {
    const normalized = normalizeEntry(entry);
    const existing = this.entries.find((item) => sameEmail(item.email, normalized.email));

    if (!existing) {
      const next = {
        ...normalized,
        id: normalized.id || randomBytes(8).toString("hex"),
        usage: normalizeUsage(normalized.usage ?? emptyUsage()),
      };
      this.entries.push(next);
      this.persist();
      return next;
    }

    Object.assign(existing, {
      ...normalized,
      id: existing.id,
      refreshToken: normalized.refreshToken ?? existing.refreshToken,
      usage: normalizeUsage(normalized.usage ?? existing.usage),
    });
    this.persist();
    return existing;
  }

  remove(id: string): boolean {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index === -1) return false;
    this.entries.splice(index, 1);
    this.persist();
    return true;
  }

  setStatus(id: string, status: GeminiAccountStatus, failureCode?: string | null): boolean {
    const entry = this.getEntry(id);
    if (!entry) return false;
    entry.status = status;
    if (failureCode !== undefined) {
      entry.lastRefreshFailureCode = failureCode;
      entry.lastRefreshFailureAt = failureCode ? new Date().toISOString() : null;
    }
    this.persist();
    return true;
  }

  setLabel(id: string, label: string | null): boolean {
    const entry = this.getEntry(id);
    if (!entry) return false;
    entry.label = label;
    this.persist();
    return true;
  }

  updateToken(
    id: string,
    token: Partial<Pick<GeminiAccountEntry, "accessToken" | "refreshToken" | "idToken" | "expiresAt" | "scope" | "tokenType">>,
  ): boolean {
    const entry = this.getEntry(id);
    if (!entry) return false;
    if (token.accessToken !== undefined) entry.accessToken = token.accessToken;
    if (token.refreshToken !== undefined) entry.refreshToken = token.refreshToken;
    if (token.idToken !== undefined) entry.idToken = token.idToken;
    if (token.expiresAt !== undefined) entry.expiresAt = token.expiresAt;
    if (token.scope !== undefined) entry.scope = token.scope;
    if (token.tokenType !== undefined) entry.tokenType = token.tokenType;
    entry.status = "active";
    entry.lastRefreshSuccessAt = new Date().toISOString();
    entry.lastRefreshFailureAt = null;
    entry.lastRefreshFailureCode = null;
    this.persist();
    return true;
  }

  updateSetup(
    id: string,
    setup: Partial<Pick<GeminiAccountEntry, "projectId" | "userTier" | "userTierName" | "paidTier" | "googleAiSubscription" | "models">>,
  ): boolean {
    const entry = this.getEntry(id);
    if (!entry) return false;
    if (setup.projectId !== undefined) entry.projectId = setup.projectId;
    if (setup.userTier !== undefined) entry.userTier = setup.userTier;
    if (setup.userTierName !== undefined) entry.userTierName = setup.userTierName;
    if (setup.paidTier !== undefined) entry.paidTier = setup.paidTier;
    if (setup.googleAiSubscription !== undefined) entry.googleAiSubscription = setup.googleAiSubscription;
    if (setup.models !== undefined) entry.models = setup.models;
    this.persist();
    return true;
  }

  updateQuota(id: string, quota: GeminiQuotaSnapshot): boolean {
    const entry = this.getEntry(id);
    if (!entry) return false;
    entry.quota = quota;
    entry.quotaFetchedAt = new Date().toISOString();
    this.persist();
    return true;
  }

  recordUsage(
    id: string,
    model: string,
    usage: { input_tokens?: number; output_tokens?: number },
  ): void {
    const entry = this.getEntry(id);
    if (!entry) return;

    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    entry.usage.input_tokens += inputTokens;
    entry.usage.output_tokens += outputTokens;
    entry.usage.request_count += 1;
    entry.usage.models[model] = addModelUsage(entry.usage.models[model], inputTokens, outputTokens);
    entry.lastUsedAt = new Date().toISOString();
    this.persist();
  }

  persistNow(): void {
    this.persist();
  }

  private clearExpiredModelRateLimits(now: Date = new Date()): void {
    let changed = false;
    for (const entry of this.entries) {
      const limits = entry.modelRateLimits;
      if (!limits) continue;
      for (const [model, limit] of Object.entries(limits)) {
        if (!isModelRateLimitActive(limit, now)) {
          delete limits[model];
          changed = true;
        }
      }
      if (Object.keys(limits).length === 0) entry.modelRateLimits = {};
    }
    if (changed) this.persist();
  }

  private persist(): void {
    this.persistence.save(this.entries);
  }
}

function addModelUsage(
  current: GeminiModelUsage | undefined,
  inputTokens: number,
  outputTokens: number,
): GeminiModelUsage {
  return {
    input_tokens: (current?.input_tokens ?? 0) + inputTokens,
    output_tokens: (current?.output_tokens ?? 0) + outputTokens,
    request_count: (current?.request_count ?? 0) + 1,
  };
}

function sameEmail(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

const CODE_ASSIST_MODEL_ALIASES: Record<string, string> = {
  "gemini-3.1-pro": "gemini-3.1-pro-preview",
  "gemini-3-pro": "gemini-3-pro-preview",
  "gemini-3.1-flash-lite": "gemini-3.1-flash-lite-preview",
};

function entrySupportsModel(entry: GeminiAccountEntry, model: string): boolean {
  const modelIds = modelLookupCandidates(model);
  if (!modelIds.some((modelId) => entry.models.includes(modelId))) return false;
  if (modelIds.some((modelId) => isEntryModelRateLimited(entry, modelId))) return false;

  const buckets = entry.quota?.modelBuckets;
  if (!buckets?.length) return true;

  const quotaModelIds = modelIds.map((modelId) => CODE_ASSIST_MODEL_ALIASES[modelId] ?? modelId);
  const bucket = buckets.find((item) => quotaModelIds.includes(item.modelId));
  if (!bucket || bucket.remainingFraction == null) return true;
  return bucket.remainingFraction > 0;
}

function modelLookupCandidates(model: string): string[] {
  const clean = normalizeModelId(model);
  const reverseAlias = Object.entries(CODE_ASSIST_MODEL_ALIASES)
    .find(([, codeAssistId]) => codeAssistId === clean)?.[0];
  return [...new Set([clean, reverseAlias].filter((item): item is string => Boolean(item)))];
}

function normalizeModelId(model: string): string {
  return model.replace(/\[1m\]$/i, "").trim();
}

function isEntryModelRateLimited(entry: GeminiAccountEntry, model: string, now = new Date()): boolean {
  const limit = entry.modelRateLimits?.[normalizeModelId(model)];
  return limit ? isModelRateLimitActive(limit, now) : false;
}

function isModelRateLimitActive(limit: GeminiModelRateLimitState, now: Date): boolean {
  const untilMs = Date.parse(limit.until);
  if (!Number.isFinite(untilMs)) return false;
  return untilMs > now.getTime();
}

function pickLeastRecentlyUsed(entries: GeminiAccountEntry[]): GeminiAccountEntry {
  let best = entries[0];
  for (let i = 1; i < entries.length; i++) {
    const entry = entries[i];
    if (!best.lastUsedAt) continue;
    if (!entry.lastUsedAt) return entry;
    if (entry.lastUsedAt < best.lastUsedAt) best = entry;
  }
  return best;
}

function maskToken(token: string): string {
  if (token.length <= 8) return "****";
  return token.slice(0, 4) + "****" + token.slice(-4);
}
