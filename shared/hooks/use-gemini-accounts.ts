import { useCallback, useEffect, useState } from "preact/hooks";

export interface GeminiQuotaBucket {
  modelId: string;
  remainingAmount: string | null;
  remainingFraction: number | null;
  resetTime: string | null;
  tokenType: string | null;
}

export interface GeminiQuotaCredit {
  creditType: string;
  creditAmount: string;
}

export interface GeminiQuotaSnapshot {
  remainingCredits?: GeminiQuotaCredit[];
  consumedCredits?: GeminiQuotaCredit[];
  modelBuckets?: GeminiQuotaBucket[];
  raw?: unknown;
}

export interface GeminiAccount {
  id: string;
  email: string;
  label?: string | null;
  status: string;
  projectId?: string | null;
  userTier?: string | null;
  userTierName?: string | null;
  paidTier?: unknown | null;
  googleAiSubscription?: {
    tier: "Free" | "Plus" | "Pro" | "Ultra";
    source: "code-assist-free-tier" | "code-assist-paid-tier";
    raw?: unknown;
  } | null;
  quotaFetchedAt?: string | null;
  quota?: GeminiQuotaSnapshot | null;
  expiresAt?: string | null;
  hasRefreshToken?: boolean;
  lastRefreshSuccessAt?: string | null;
  lastRefreshFailureAt?: string | null;
  lastRefreshFailureCode?: string | null;
  models?: string[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    request_count?: number;
    models?: Record<string, { input_tokens: number; output_tokens: number; request_count: number }>;
  };
}

export function useGeminiAccounts() {
  const [list, setList] = useState<GeminiAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [addVisible, setAddVisible] = useState(false);
  const [addInfo, setAddInfo] = useState("");
  const [addError, setAddError] = useState("");

  const loadAccounts = useCallback(async () => {
    setRefreshing(true);
    try {
      const resp = await fetch("/auth/gemini/accounts");
      const data = await resp.json();
      setList(data.accounts ?? []);
    } catch {
      setList([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  const startAdd = useCallback(async () => {
    setAddInfo("");
    setAddError("");
    try {
      const resp = await fetch("/auth/gemini/login-start", { method: "POST" });
      const data = await resp.json();
      if (!resp.ok || !data.authUrl) throw new Error(data.error || "failedStartLogin");
      window.open(data.authUrl, "gemini_oauth_add", "width=600,height=700,scrollbars=yes");
      setAddVisible(true);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "failedStartLogin");
    }
  }, []);

  const cancelAdd = useCallback(() => {
    setAddVisible(false);
    setAddInfo("");
    setAddError("");
  }, []);

  const submitRelay = useCallback(async (callbackUrl: string) => {
    setAddInfo("");
    setAddError("");
    if (!callbackUrl.trim()) {
      setAddError("pleasePassCallback");
      return;
    }
    try {
      const resp = await fetch("/auth/gemini/code-relay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callbackUrl }),
      });
      const data = await resp.json();
      if (resp.ok && data.success) {
        setAddVisible(false);
        setAddInfo("accountAdded");
        await loadAccounts();
      } else {
        setAddError(data.error || "failedExchangeCode");
      }
    } catch (err) {
      setAddError("networkError" + (err instanceof Error ? err.message : String(err)));
    }
  }, [loadAccounts]);

  const importCli = useCallback(async () => {
    const resp = await fetch("/auth/gemini/import-cli", { method: "POST" });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Gemini CLI import failed");
    setAddInfo("accountAdded");
    await loadAccounts();
  }, [loadAccounts]);

  const deleteAccount = useCallback(async (id: string): Promise<string | null> => {
    const resp = await fetch(`/auth/gemini/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      return data.error || "failedDeleteAccount";
    }
    await loadAccounts();
    return null;
  }, [loadAccounts]);

  const refreshAccount = useCallback(async (id: string): Promise<string | null> => {
    const resp = await fetch(`/auth/gemini/accounts/${encodeURIComponent(id)}/refresh`, { method: "POST" });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      return data.error || "failedRefresh";
    }
    await loadAccounts();
    return null;
  }, [loadAccounts]);

  const healthCheck = useCallback(async (id?: string): Promise<void> => {
    await fetch("/auth/gemini/accounts/health-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(id ? { accountId: id } : {}),
    });
    await loadAccounts();
  }, [loadAccounts]);

  return {
    list,
    loading,
    refreshing,
    addVisible,
    addInfo,
    addError,
    refresh: loadAccounts,
    startAdd,
    cancelAdd,
    submitRelay,
    importCli,
    deleteAccount,
    refreshAccount,
    healthCheck,
  };
}
