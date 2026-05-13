import { useState, useEffect, useCallback } from "preact/hooks";
import { extractErrorMessage } from "../utils/extract-error";

export interface GeminiCliAuthStatus {
  path: string;
  exists: boolean;
  currentEmail: string | null;
  matchedEntryId: string | null;
  lastModified: string | null;
}

export function useGeminiCliAuth() {
  const [status, setStatus] = useState<GeminiCliAuthStatus | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const resp = await fetch("/auth/gemini/cli-auth");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data: GeminiCliAuthStatus = await resp.json();
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
      const resp = await fetch("/auth/gemini/cli-auth/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => null);
        throw new Error(extractErrorMessage(body, `HTTP ${resp.status}`));
      }
      const result = await resp.json() as { status: GeminiCliAuthStatus };
      if (result.status) setStatus(result.status);
      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      return msg;
    } finally {
      setApplying(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return { status, applying, error, apply, reload: load };
}
