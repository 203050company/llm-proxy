import { useCallback, useEffect, useState } from "preact/hooks";

export interface GeminiSettingsState {
  oauth_enabled: boolean;
  credentials_path: string;
  code_assist_endpoint: string;
  code_assist_api_version: string;
  project_id: string | null;
  refresh_enabled: boolean;
  refresh_margin_seconds: number;
  refresh_concurrency: number;
  api_key_priority: "api_key" | "oauth";
  routing: Record<string, unknown>;
}

export function useGeminiSettings() {
  const [settings, setSettings] = useState<GeminiSettingsState | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const resp = await fetch("/admin/gemini-settings");
    if (resp.ok) setSettings(await resp.json());
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(async (patch: Partial<GeminiSettingsState>) => {
    const resp = await fetch("/admin/gemini-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Failed to save Gemini settings");
    setSettings(data);
  }, []);

  return { settings, loading, refresh: load, save };
}
