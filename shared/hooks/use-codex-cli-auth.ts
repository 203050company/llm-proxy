import { useState, useEffect, useCallback } from "preact/hooks";
import { extractErrorMessage } from "../utils/extract-error";

export interface CodexCliAuthStatus {
  path: string;
  exists: boolean;
  currentAccountId: string | null;
  currentEmail: string | null;
  matchedEntryId: string | null;
  lastModified: string | null;
}

export function useCodexCliAuth(apiKey: string | null) {
  const [status, setStatus] = useState<CodexCliAuthStatus | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const resp = await fetch("/admin/codex-cli-auth");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data: CodexCliAuthStatus = await resp.json();
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const apply = useCallback(async (accountId: string) => {
    setApplying(true);
    setError(null);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const resp = await fetch("/admin/codex-cli-auth/apply", {
        method: "POST",
        headers,
        body: JSON.stringify({ accountId }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => null);
        throw new Error(extractErrorMessage(body, `HTTP ${resp.status}`));
      }
      const result = await resp.json() as { status: CodexCliAuthStatus };
      if (result.status) setStatus(result.status);
      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      return msg;
    } finally {
      setApplying(false);
    }
  }, [apiKey]);

  useEffect(() => { load(); }, [load]);

  return { status, applying, error, apply, reload: load };
}
