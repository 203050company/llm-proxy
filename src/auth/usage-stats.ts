/**
 * Usage Stats — time-series snapshot recording and aggregation.
 *
 * Records periodic snapshots of cumulative token usage across all accounts.
 * Snapshots are persisted to data/usage-history.json. Retention is
 * configurable and defaults to unlimited.
 * Aggregation (delta computation, bucketing) happens on read.
 *
 * A "baseline" accumulates usage from accounts that have been removed or
 * replaced, so historical totals survive account pool resets.
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
} from "fs";
import { resolve, dirname } from "path";
import { getConfig } from "../config.js";
import { getDataDir } from "../paths.js";
import type { AccountPool } from "./account-pool.js";
import type { ApiKeyPool } from "./api-key-pool.js";
import type { GeminiAccountPool } from "./gemini-account-pool.js";

// ── Types ──────────────────────────────────────────────────────────

interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
  request_count: number;
}

interface SourceUsage extends ModelUsage {
  provider: string;
}

export interface UsageSnapshot {
  timestamp: string; // ISO 8601
  totals: {
    input_tokens: number;
    output_tokens: number;
    /** Cached prompt tokens (subset of input_tokens). */
    cached_tokens?: number;
    /** image_generation tool tokens (gpt-image-2). Tracked separately from host-model tokens. */
    image_input_tokens?: number;
    image_output_tokens?: number;
    /** image_generation request counts. */
    image_request_count?: number;
    image_request_failed_count?: number;
    request_count: number;
    active_accounts: number;
  };
  models?: Record<string, ModelUsage>;
}

export interface UsageBaseline {
  input_tokens: number;
  output_tokens: number;
  request_count: number;
  cached_tokens?: number;
  image_input_tokens?: number;
  image_output_tokens?: number;
  image_request_count?: number;
  image_request_failed_count?: number;
  models?: Record<string, ModelUsage>;
  sources?: Record<string, SourceUsage>;
}

interface UsageHistoryFile {
  version: 1;
  snapshots: UsageSnapshot[];
  baseline?: UsageBaseline;
  externalUsage?: UsageBaseline;
}

export interface UsageDataPoint {
  timestamp: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  image_input_tokens: number;
  image_output_tokens: number;
  image_request_count: number;
  image_request_failed_count: number;
  request_count: number;
}

export interface UsageSummary {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cached_tokens: number;
  total_image_input_tokens: number;
  total_image_output_tokens: number;
  total_image_request_count: number;
  total_image_request_failed_count: number;
  total_request_count: number;
  total_accounts: number;
  active_accounts: number;
}

// ── Constants ──────────────────────────────────────────────────────

const HISTORY_FILE = "usage-history.json";
const DAY_MS = 24 * 60 * 60 * 1000;

export type UsageHistoryRange = number | "all";

// ── Persistence interface (injectable for testing) ─────────────────

export interface UsageStatsPersistence {
  load(): UsageHistoryFile;
  save(data: UsageHistoryFile): void;
}

export function createFsUsageStatsPersistence(): UsageStatsPersistence {
  function getFilePath(): string {
    return resolve(getDataDir(), HISTORY_FILE);
  }

  return {
    load(): UsageHistoryFile {
      try {
        const filePath = getFilePath();
        if (!existsSync(filePath)) return { version: 1, snapshots: [] };
        const raw = readFileSync(filePath, "utf-8");
        const data = JSON.parse(raw) as UsageHistoryFile;
        if (!Array.isArray(data.snapshots)) return { version: 1, snapshots: [] };
        return data;
      } catch {
        return { version: 1, snapshots: [] };
      }
    },

    save(data: UsageHistoryFile): void {
      try {
        const filePath = getFilePath();
        const dir = dirname(filePath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const tmpFile = filePath + ".tmp";
        writeFileSync(tmpFile, JSON.stringify(data), "utf-8");
        renameSync(tmpFile, filePath);
      } catch (err) {
        console.error("[UsageStats] Failed to persist:", err instanceof Error ? err.message : err);
      }
    },
  };
}

// ── Store ──────────────────────────────────────────────────────────

export class UsageStatsStore {
  private persistence: UsageStatsPersistence;
  private snapshots: UsageSnapshot[];
  private baseline: UsageBaseline;
  private externalUsage: UsageBaseline;
  private _pendingRecovery?: UsageBaseline;

  constructor(persistence?: UsageStatsPersistence) {
    this.persistence = persistence ?? createFsUsageStatsPersistence();
    const loaded = this.persistence.load();
    this.snapshots = loaded.snapshots;
    this.baseline = loaded.baseline ?? {
      input_tokens: 0, output_tokens: 0, request_count: 0,
      cached_tokens: 0, image_input_tokens: 0, image_output_tokens: 0,
      image_request_count: 0, image_request_failed_count: 0,
    };
    this.externalUsage = loaded.externalUsage ?? {
      input_tokens: 0,
      output_tokens: 0,
      request_count: 0,
      models: {},
      sources: {},
    };
    if (this.baseline.cached_tokens == null) this.baseline.cached_tokens = 0;
    if (this.baseline.image_input_tokens == null) this.baseline.image_input_tokens = 0;
    if (this.baseline.image_output_tokens == null) this.baseline.image_output_tokens = 0;
    if (this.baseline.image_request_count == null) this.baseline.image_request_count = 0;
    if (this.baseline.image_request_failed_count == null) this.baseline.image_request_failed_count = 0;
    if (!this.externalUsage.models) this.externalUsage.models = {};
    if (!this.externalUsage.sources) this.externalUsage.sources = {};

    // Recover baseline from last snapshot if it was never persisted.
    // This handles the case where usage-history.json has correct snapshot
    // totals but no baseline (pre-PR#221 data or lost on restart).
    if (!loaded.baseline && this.snapshots.length > 0) {
      const last = this.snapshots[this.snapshots.length - 1].totals;
      this._pendingRecovery = {
        input_tokens: last.input_tokens,
        output_tokens: last.output_tokens,
        request_count: last.request_count,
        cached_tokens: last.cached_tokens ?? 0,
        image_input_tokens: last.image_input_tokens ?? 0,
        image_output_tokens: last.image_output_tokens ?? 0,
        image_request_count: last.image_request_count ?? 0,
        image_request_failed_count: last.image_request_failed_count ?? 0,
      };
    }
  }

  /**
   * Recover baseline from last snapshot totals minus current live pool.
   * Must be called once after pool is available (not in constructor,
   * since pool may not be ready yet).
   */
  recoverBaseline(
    pool: AccountPool,
    apiKeyPool?: ApiKeyPool,
    geminiPool?: GeminiAccountPool,
  ): void {
    if (!this._pendingRecovery) return;
    const live = this.poolTotals(pool, apiKeyPool, geminiPool);
    this.baseline = {
      input_tokens: Math.max(0, this._pendingRecovery.input_tokens - live.input_tokens),
      output_tokens: Math.max(0, this._pendingRecovery.output_tokens - live.output_tokens),
      request_count: Math.max(0, this._pendingRecovery.request_count - live.request_count),
      cached_tokens: Math.max(0, (this._pendingRecovery.cached_tokens ?? 0) - live.cached_tokens),
      image_input_tokens: Math.max(0, (this._pendingRecovery.image_input_tokens ?? 0) - live.image_input_tokens),
      image_output_tokens: Math.max(0, (this._pendingRecovery.image_output_tokens ?? 0) - live.image_output_tokens),
      image_request_count: Math.max(0, (this._pendingRecovery.image_request_count ?? 0) - live.image_request_count),
      image_request_failed_count: Math.max(0, (this._pendingRecovery.image_request_failed_count ?? 0) - live.image_request_failed_count),
    };
    this._pendingRecovery = undefined;
    this.persist();
    console.log(`[UsageStats] Recovered baseline: ${this.baseline.input_tokens} in / ${this.baseline.output_tokens} out / ${this.baseline.request_count} req / ${this.baseline.cached_tokens ?? 0} cached / ${this.baseline.image_input_tokens ?? 0} image_in / ${this.baseline.image_output_tokens ?? 0} image_out / ${this.baseline.image_request_count ?? 0} img-req / ${this.baseline.image_request_failed_count ?? 0} img-failed`);
  }

  recordExternalUsage(
    model: string,
    usage: { input_tokens?: number; output_tokens?: number },
    provider = "external",
    sourceId = provider,
  ): void {
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    this.externalUsage.input_tokens += inputTokens;
    this.externalUsage.output_tokens += outputTokens;
    this.externalUsage.request_count += 1;

    this.externalUsage.models ??= {};
    addModelUsage(this.externalUsage.models, model, inputTokens, outputTokens);

    this.externalUsage.sources ??= {};
    const current = this.externalUsage.sources[sourceId] ?? {
      provider,
      input_tokens: 0,
      output_tokens: 0,
      request_count: 0,
    };
    current.provider = provider;
    current.input_tokens += inputTokens;
    current.output_tokens += outputTokens;
    current.request_count += 1;
    this.externalUsage.sources[sourceId] = current;
    this.persist();
  }

  getExternalUsageSummary(): UsageBaseline {
    return cloneUsageBaseline(this.externalUsage);
  }

  /** Sum current live usage from all accounts in the pool. */
  private poolTotals(
    pool: AccountPool,
    apiKeyPool?: ApiKeyPool,
    geminiPool?: GeminiAccountPool,
  ): { input_tokens: number; output_tokens: number; cached_tokens: number; image_input_tokens: number; image_output_tokens: number; image_request_count: number; image_request_failed_count: number; request_count: number; active_accounts: number; total_accounts: number; models: Record<string, ModelUsage> } {
    const entries = pool.getAllEntries();
    let input_tokens = 0;
    let output_tokens = 0;
    let cached_tokens = 0;
    let image_input_tokens = 0;
    let image_output_tokens = 0;
    let image_request_count = 0;
    let image_request_failed_count = 0;
    let request_count = 0;
    let active_accounts = 0;
    let total_accounts = entries.length;
    const models: Record<string, ModelUsage> = {};

    for (const entry of entries) {
      input_tokens += entry.usage.input_tokens;
      output_tokens += entry.usage.output_tokens;
      cached_tokens += entry.usage.cached_tokens ?? 0;
      image_input_tokens += entry.usage.image_input_tokens ?? 0;
      image_output_tokens += entry.usage.image_output_tokens ?? 0;
      image_request_count += entry.usage.image_request_count ?? 0;
      image_request_failed_count += entry.usage.image_request_failed_count ?? 0;
      request_count += entry.usage.request_count;
      if (entry.status === "active") active_accounts++;
      addModelUsage(models, "codex", entry.usage.input_tokens, entry.usage.output_tokens, entry.usage.request_count);
    }

    for (const entry of apiKeyPool?.getAll() ?? []) {
      input_tokens += entry.usage.input_tokens;
      output_tokens += entry.usage.output_tokens;
      request_count += entry.usage.request_count;
      total_accounts++;
      if (entry.status === "active") active_accounts++;
      addModelUsage(models, entry.model, entry.usage.input_tokens, entry.usage.output_tokens, entry.usage.request_count);
    }

    for (const entry of geminiPool?.getAll() ?? []) {
      input_tokens += entry.usage.input_tokens;
      output_tokens += entry.usage.output_tokens;
      request_count += entry.usage.request_count;
      total_accounts++;
      if (entry.status === "active") active_accounts++;
      for (const [model, usage] of Object.entries(entry.usage.models)) {
        addModelUsage(models, model, usage.input_tokens, usage.output_tokens, usage.request_count);
      }
    }

    input_tokens += this.externalUsage.input_tokens;
    output_tokens += this.externalUsage.output_tokens;
    request_count += this.externalUsage.request_count;
    for (const [model, usage] of Object.entries(this.externalUsage.models ?? {})) {
      addModelUsage(models, model, usage.input_tokens, usage.output_tokens, usage.request_count);
    }

    return { input_tokens, output_tokens, cached_tokens, image_input_tokens, image_output_tokens, image_request_count, image_request_failed_count, request_count, active_accounts, total_accounts, models };
  }

  /** Take a snapshot of current cumulative usage across all accounts. */
  recordSnapshot(
    pool: AccountPool,
    apiKeyPool?: ApiKeyPool,
    geminiPool?: GeminiAccountPool,
  ): void {
    const live = this.poolTotals(pool, apiKeyPool, geminiPool);
    const now = new Date().toISOString();

    // Detect pool reset: if live totals dropped below previous snapshot,
    // the difference was lost usage from removed accounts — absorb into baseline.
    const lastSnapshot = this.snapshots.length > 0 ? this.snapshots[this.snapshots.length - 1] : null;
    if (lastSnapshot) {
      const baselineCached = this.baseline.cached_tokens ?? 0;
      const baselineImgIn = this.baseline.image_input_tokens ?? 0;
      const baselineImgOut = this.baseline.image_output_tokens ?? 0;
      const baselineImgReq = this.baseline.image_request_count ?? 0;
      const baselineImgReqFailed = this.baseline.image_request_failed_count ?? 0;
      const lastCached = lastSnapshot.totals.cached_tokens ?? 0;
      const lastImgIn = lastSnapshot.totals.image_input_tokens ?? 0;
      const lastImgOut = lastSnapshot.totals.image_output_tokens ?? 0;
      const lastImgReq = lastSnapshot.totals.image_request_count ?? 0;
      const lastImgReqFailed = lastSnapshot.totals.image_request_failed_count ?? 0;
      const prevLive = {
        input_tokens: lastSnapshot.totals.input_tokens - this.baseline.input_tokens,
        output_tokens: lastSnapshot.totals.output_tokens - this.baseline.output_tokens,
        request_count: lastSnapshot.totals.request_count - this.baseline.request_count,
        cached_tokens: lastCached - baselineCached,
        image_input_tokens: lastImgIn - baselineImgIn,
        image_output_tokens: lastImgOut - baselineImgOut,
        image_request_count: lastImgReq - baselineImgReq,
        image_request_failed_count: lastImgReqFailed - baselineImgReqFailed,
      };
      if (live.input_tokens < prevLive.input_tokens ||
          live.output_tokens < prevLive.output_tokens ||
          live.request_count < prevLive.request_count ||
          live.cached_tokens < prevLive.cached_tokens ||
          live.image_input_tokens < prevLive.image_input_tokens ||
          live.image_output_tokens < prevLive.image_output_tokens ||
          live.image_request_count < prevLive.image_request_count ||
          live.image_request_failed_count < prevLive.image_request_failed_count) {
        this.baseline = {
          input_tokens: this.baseline.input_tokens + Math.max(0, prevLive.input_tokens - live.input_tokens),
          output_tokens: this.baseline.output_tokens + Math.max(0, prevLive.output_tokens - live.output_tokens),
          request_count: this.baseline.request_count + Math.max(0, prevLive.request_count - live.request_count),
          cached_tokens: baselineCached + Math.max(0, prevLive.cached_tokens - live.cached_tokens),
          image_input_tokens: baselineImgIn + Math.max(0, prevLive.image_input_tokens - live.image_input_tokens),
          image_output_tokens: baselineImgOut + Math.max(0, prevLive.image_output_tokens - live.image_output_tokens),
          image_request_count: baselineImgReq + Math.max(0, prevLive.image_request_count - live.image_request_count),
          image_request_failed_count: baselineImgReqFailed + Math.max(0, prevLive.image_request_failed_count - live.image_request_failed_count),
        };
      }
    }

    // Snapshot totals = baseline + live (monotonically increasing)
    this.snapshots.push({
      timestamp: now,
      totals: {
        input_tokens: this.baseline.input_tokens + live.input_tokens,
        output_tokens: this.baseline.output_tokens + live.output_tokens,
        cached_tokens: (this.baseline.cached_tokens ?? 0) + live.cached_tokens,
        image_input_tokens: (this.baseline.image_input_tokens ?? 0) + live.image_input_tokens,
        image_output_tokens: (this.baseline.image_output_tokens ?? 0) + live.image_output_tokens,
        image_request_count: (this.baseline.image_request_count ?? 0) + live.image_request_count,
        image_request_failed_count: (this.baseline.image_request_failed_count ?? 0) + live.image_request_failed_count,
        request_count: this.baseline.request_count + live.request_count,
        active_accounts: live.active_accounts,
      },
      models: live.models,
    });

    const retentionDays = getConfig().usage_stats.history_retention_days;
    if (retentionDays !== null) {
      const cutoff = Date.now() - retentionDays * DAY_MS;
      this.snapshots = this.snapshots.filter(
        (s) => new Date(s.timestamp).getTime() >= cutoff,
      );
    }

    this.persist();
  }

  /** Get current cumulative summary (baseline + live pool data). */
  getSummary(
    pool: AccountPool,
    apiKeyPool?: ApiKeyPool,
    geminiPool?: GeminiAccountPool,
  ): UsageSummary {
    const live = this.poolTotals(pool, apiKeyPool, geminiPool);

    return {
      total_input_tokens: this.baseline.input_tokens + live.input_tokens,
      total_output_tokens: this.baseline.output_tokens + live.output_tokens,
      total_cached_tokens: (this.baseline.cached_tokens ?? 0) + live.cached_tokens,
      total_image_input_tokens: (this.baseline.image_input_tokens ?? 0) + live.image_input_tokens,
      total_image_output_tokens: (this.baseline.image_output_tokens ?? 0) + live.image_output_tokens,
      total_image_request_count: (this.baseline.image_request_count ?? 0) + live.image_request_count,
      total_image_request_failed_count: (this.baseline.image_request_failed_count ?? 0) + live.image_request_failed_count,
      total_request_count: this.baseline.request_count + live.request_count,
      total_accounts: live.total_accounts,
      active_accounts: live.active_accounts,
    };
  }

  /**
   * Get usage history as delta data points, aggregated by granularity.
   * @param range - how many hours of history to return, or "all" retained history
   * @param granularity - "raw" | "five_min" | "hourly" | "daily"
   */
  getHistory(
    range: UsageHistoryRange,
    granularity: "raw" | "five_min" | "hourly" | "daily",
  ): UsageDataPoint[] {
    const cutoff = range === "all" ? null : Date.now() - range * 60 * 60 * 1000;
    const filtered = cutoff === null
      ? this.snapshots
      : this.snapshots.filter((s) => new Date(s.timestamp).getTime() >= cutoff);

    if (filtered.length < 2) return [];

    // Compute deltas between consecutive snapshots
    const deltas: UsageDataPoint[] = [];
    for (let i = 1; i < filtered.length; i++) {
      const prev = filtered[i - 1].totals;
      const curr = filtered[i].totals;
      deltas.push({
        timestamp: filtered[i].timestamp,
        input_tokens: Math.max(0, curr.input_tokens - prev.input_tokens),
        output_tokens: Math.max(0, curr.output_tokens - prev.output_tokens),
        cached_tokens: Math.max(0, (curr.cached_tokens ?? 0) - (prev.cached_tokens ?? 0)),
        image_input_tokens: Math.max(0, (curr.image_input_tokens ?? 0) - (prev.image_input_tokens ?? 0)),
        image_output_tokens: Math.max(0, (curr.image_output_tokens ?? 0) - (prev.image_output_tokens ?? 0)),
        image_request_count: Math.max(0, (curr.image_request_count ?? 0) - (prev.image_request_count ?? 0)),
        image_request_failed_count: Math.max(0, (curr.image_request_failed_count ?? 0) - (prev.image_request_failed_count ?? 0)),
        request_count: Math.max(0, curr.request_count - prev.request_count),
      });
    }

    if (granularity === "raw") return deltas;

    // Bucket into time intervals
    const bucketMs =
      granularity === "five_min" ? 300_000 :
      granularity === "hourly" ? 3600_000 :
      86400_000;
    return bucketize(deltas, bucketMs);
  }

  /** Get raw snapshot count (for testing). */
  get snapshotCount(): number {
    return this.snapshots.length;
  }

  /** Get current baseline (for testing). */
  get currentBaseline(): UsageBaseline {
    return { ...this.baseline };
  }

  private persist(): void {
    this.persistence.save({
      version: 1,
      snapshots: this.snapshots,
      baseline: this.baseline,
      externalUsage: this.externalUsage,
    });
  }
}

function addModelUsage(
  map: Record<string, ModelUsage>,
  model: string,
  inputTokens: number,
  outputTokens: number,
  requestCount = 1,
): void {
  const current = map[model] ?? { input_tokens: 0, output_tokens: 0, request_count: 0 };
  current.input_tokens += inputTokens;
  current.output_tokens += outputTokens;
  current.request_count += requestCount;
  map[model] = current;
}

function cloneUsageBaseline(usage: UsageBaseline): UsageBaseline {
  return {
    ...usage,
    models: usage.models ? structuredClone(usage.models) : {},
    sources: usage.sources ? structuredClone(usage.sources) : {},
  };
}

function bucketize(deltas: UsageDataPoint[], bucketMs: number): UsageDataPoint[] {
  if (deltas.length === 0) return [];

  const buckets = new Map<number, UsageDataPoint>();

  for (const d of deltas) {
    const t = new Date(d.timestamp).getTime();
    const bucketKey = Math.floor(t / bucketMs) * bucketMs;

    const existing = buckets.get(bucketKey);
    if (existing) {
      existing.input_tokens += d.input_tokens;
      existing.output_tokens += d.output_tokens;
      existing.cached_tokens += d.cached_tokens;
      existing.image_input_tokens += d.image_input_tokens;
      existing.image_output_tokens += d.image_output_tokens;
      existing.image_request_count += d.image_request_count;
      existing.image_request_failed_count += d.image_request_failed_count;
      existing.request_count += d.request_count;
    } else {
      buckets.set(bucketKey, {
        timestamp: new Date(bucketKey).toISOString(),
        input_tokens: d.input_tokens,
        output_tokens: d.output_tokens,
        cached_tokens: d.cached_tokens,
        image_input_tokens: d.image_input_tokens,
        image_output_tokens: d.image_output_tokens,
        image_request_count: d.image_request_count,
        image_request_failed_count: d.image_request_failed_count,
        request_count: d.request_count,
      });
    }
  }

  return [...buckets.values()].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
}
