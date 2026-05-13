import { useState } from "preact/hooks";
import { useGeminiSettings } from "../../../shared/hooks/use-gemini-settings";
import { useT } from "../../../shared/i18n/context";

export function GeminiSettings() {
  const t = useT();
  const { settings, loading, save } = useGeminiSettings();
  const [message, setMessage] = useState("");

  if (loading) {
    return <div class="text-sm text-slate-400 dark:text-text-dim">{t("loading")}</div>;
  }
  if (!settings) {
    return <div class="text-sm text-red-500">{t("geminiSettingsUnavailable")}</div>;
  }

  const saveField = async (patch: Partial<typeof settings>) => {
    await save(patch);
    setMessage(t("apiKeySaved"));
    setTimeout(() => setMessage(""), 2000);
  };

  return (
    <section class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl p-5 shadow-sm">
      <div class="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 class="text-sm font-bold text-slate-800 dark:text-text-main">{t("geminiSettings")}</h2>
          <p class="text-xs text-slate-500 dark:text-text-dim mt-1">{t("geminiSettingsDescription")}</p>
        </div>
        {message && <span class="text-xs text-primary">{message}</span>}
      </div>
      <div class="grid md:grid-cols-2 gap-4">
        <label class="flex items-center gap-2 text-sm text-slate-700 dark:text-text-main">
          <input
            type="checkbox"
            checked={settings.oauth_enabled}
            onChange={(e) => void saveField({ oauth_enabled: (e.target as HTMLInputElement).checked })}
          />
          {t("geminiOAuthEnabled")}
        </label>
        <label class="flex items-center gap-2 text-sm text-slate-700 dark:text-text-main">
          <input
            type="checkbox"
            checked={settings.refresh_enabled}
            onChange={(e) => void saveField({ refresh_enabled: (e.target as HTMLInputElement).checked })}
          />
          {t("geminiRefreshEnabled")}
        </label>
        <TextField label={t("geminiCredentialsPath")} value={settings.credentials_path} onCommit={(v) => saveField({ credentials_path: v })} />
        <TextField label={t("geminiCodeAssistEndpoint")} value={settings.code_assist_endpoint} onCommit={(v) => saveField({ code_assist_endpoint: v })} />
        <TextField label={t("geminiApiVersion")} value={settings.code_assist_api_version} onCommit={(v) => saveField({ code_assist_api_version: v })} />
        <TextField label={t("geminiProjectId")} value={settings.project_id ?? ""} onCommit={(v) => saveField({ project_id: v || null })} />
      </div>
      <div class="grid md:grid-cols-3 gap-4 mt-4">
        <NumberField label={t("geminiRefreshMarginSeconds")} value={settings.refresh_margin_seconds} onCommit={(v) => saveField({ refresh_margin_seconds: v })} />
        <NumberField label={t("geminiRefreshConcurrency")} value={settings.refresh_concurrency} onCommit={(v) => saveField({ refresh_concurrency: v })} />
        <label class="flex flex-col gap-1 text-xs text-slate-500 dark:text-text-dim">
          {t("geminiApiKeyPriority")}
          <select
            value={settings.api_key_priority}
            onChange={(e) => void saveField({ api_key_priority: (e.target as HTMLSelectElement).value as "api_key" | "oauth" })}
            class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
          >
            <option value="api_key">{t("geminiPriorityApiKey")}</option>
            <option value="oauth">{t("geminiPriorityOAuth")}</option>
          </select>
        </label>
      </div>
      <div class="mt-4 text-xs text-slate-500 dark:text-text-dim">
        {t("geminiRoutingSummary")}: opus → {String(settings.routing.opus ?? "")}, sonnet → {String(settings.routing.sonnet ?? "")}, haiku → {String(settings.routing.haiku ?? "")}
      </div>
    </section>
  );
}

function TextField({ label, value, onCommit }: { label: string; value: string; onCommit: (value: string) => void | Promise<void> }) {
  const [draft, setDraft] = useState(value);
  return (
    <label class="flex flex-col gap-1 text-xs text-slate-500 dark:text-text-dim">
      {label}
      <input
        value={draft}
        onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
        onBlur={() => void onCommit(draft)}
        class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
      />
    </label>
  );
}

function NumberField({ label, value, onCommit }: { label: string; value: number; onCommit: (value: number) => void | Promise<void> }) {
  const [draft, setDraft] = useState(String(value));
  return (
    <label class="flex flex-col gap-1 text-xs text-slate-500 dark:text-text-dim">
      {label}
      <input
        type="number"
        value={draft}
        onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
        onBlur={() => void onCommit(Number(draft))}
        class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
      />
    </label>
  );
}
