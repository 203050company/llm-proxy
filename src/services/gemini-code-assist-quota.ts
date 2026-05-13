import type { GeminiAccountPool } from "../auth/gemini-account-pool.js";
import type { GeminiAccountEntry } from "../auth/gemini-types.js";
import {
  fetchGeminiCodeAssistTier,
  type GeminiCodeAssistTierInfo,
} from "../auth/gemini-code-assist-profile.js";

export interface GeminiTokenManagerLike {
  ensureFreshAccount(id: string): Promise<GeminiAccountEntry>;
}

export type GeminiTierFetcherLike = (accessToken: string) => Promise<GeminiCodeAssistTierInfo | null>;

export async function refreshGeminiAccountTier(
  pool: GeminiAccountPool,
  entry: GeminiAccountEntry,
  tierFetcher: GeminiTierFetcherLike = fetchGeminiCodeAssistTier,
): Promise<void> {
  const tier = await tierFetcher(entry.accessToken);
  if (!tier) return;
  pool.updateSetup(entry.id, {
    ...(tier.projectId ? { projectId: tier.projectId } : {}),
    userTier: tier.userTier,
    userTierName: tier.userTierName,
    paidTier: tier.paidTier,
    googleAiSubscription: tier.googleAiSubscription,
  });
  if (tier.quota) {
    pool.updateQuota(entry.id, tier.quota);
  }
}

export class GeminiQuotaRefreshService {
  private readonly lastRefreshStartedAt = new Map<string, number>();

  constructor(
    private readonly pool: GeminiAccountPool,
    private readonly tokenManager: GeminiTokenManagerLike,
    private readonly tierFetcher: GeminiTierFetcherLike = fetchGeminiCodeAssistTier,
    private readonly debounceMs = 30_000,
  ) {}

  async refreshAfterFailure(accountId: string): Promise<boolean> {
    const now = Date.now();
    const previous = this.lastRefreshStartedAt.get(accountId) ?? 0;
    if (now - previous < this.debounceMs) return false;
    this.lastRefreshStartedAt.set(accountId, now);

    try {
      const fresh = await this.tokenManager.ensureFreshAccount(accountId);
      await refreshGeminiAccountTier(this.pool, fresh, this.tierFetcher);
      return true;
    } catch (err) {
      console.warn("[GeminiQuota] Failed to refresh quota after request failure:", errorMessage(err));
      return false;
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
