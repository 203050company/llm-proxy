import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { AccountLogCategory, AccountLogEvent, AccountLogLevel, AccountLogsResponse } from "../types";

export interface FetchAccountLogsOptions {
  limit?: number;
  since?: number;
  level?: AccountLogLevel;
  category?: AccountLogCategory | "all";
}

export async function fetchAccountLogs(accountId: string, options: FetchAccountLogsOptions = {}): Promise<AccountLogsResponse> {
  const params = new URLSearchParams();
  params.set("limit", String(options.limit ?? 100));
  params.set("since", String(options.since ?? 0));
  if (options.level) params.set("level", options.level);
  if (options.category && options.category !== "all") params.set("category", options.category);

  const resp = await fetch(`/auth/accounts/${encodeURIComponent(accountId)}/logs?${params.toString()}`);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "logsLoadFailed");
  }
  return data as AccountLogsResponse;
}

export interface UseAccountLogsOptions extends FetchAccountLogsOptions {
  enabled?: boolean;
  pollIntervalMs?: number;
}

export function useAccountLogs(accountId: string, options: UseAccountLogsOptions = {}) {
  const { enabled = true, limit = 100, category = "all", level, pollIntervalMs = 5_000 } = options;
  const [logs, setLogs] = useState<AccountLogEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextSince, setNextSince] = useState(0);
  const nextSinceRef = useRef(0);

  const applyResponse = useCallback((response: AccountLogsResponse, reset: boolean) => {
    nextSinceRef.current = response.nextSince;
    setNextSince(response.nextSince);
    setLogs((prev) => reset ? response.logs : [...prev, ...response.logs].slice(-limit));
  }, [limit]);

  const load = useCallback(async (reset = false) => {
    if (!enabled) return;
    if (reset) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const response = await fetchAccountLogs(accountId, {
        limit,
        since: reset ? 0 : nextSinceRef.current,
        level,
        category,
      });
      applyResponse(response, reset);
    } catch (err) {
      setError(err instanceof Error ? err.message : "logsLoadFailed");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [accountId, applyResponse, category, enabled, level, limit]);

  useEffect(() => {
    nextSinceRef.current = 0;
    setNextSince(0);
    setLogs([]);
    if (enabled) void load(true);
  }, [accountId, category, enabled, level, limit, load]);

  useEffect(() => {
    if (!enabled || pollIntervalMs <= 0) return;
    const timer = setInterval(() => void load(false), pollIntervalMs);
    return () => clearInterval(timer);
  }, [enabled, load, pollIntervalMs]);

  return {
    logs,
    loading,
    refreshing,
    error,
    nextSince,
    refresh: () => load(true),
  };
}
