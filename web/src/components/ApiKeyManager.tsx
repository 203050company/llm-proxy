/**
 * API Key Manager — Dashboard component for managing third-party API keys.
 * Supports add/delete/toggle/import/export with predefined model catalogs.
 */

import { useState, useCallback, useMemo, useRef } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { useApiKeys } from "../../../shared/hooks/use-api-keys";
import type { ApiKeyProvider, ApiKeyEntry, CatalogModel } from "../../../shared/hooks/use-api-keys";
import { useT } from "../../../shared/i18n/context";
import { formatNumber } from "./UsageChart";

const PROVIDER_OPTIONS: Array<{ value: ApiKeyProvider; label: string }> = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "custom", label: "Custom" },
];

type CustomModelStatus = "idle" | "loading" | "loaded" | "fallback";

function normalizeCustomModelInput(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function renderModelChecklist(models: CatalogModel[], selectedModelSet: Set<string>, onToggle: (modelId: string) => void) {
  return (
    <div class="max-h-56 overflow-y-auto rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark p-2 flex flex-col gap-1">
      {models.map((model) => (
        <label key={model.id} class="flex items-center gap-2 px-2 py-1 rounded hover:bg-white/70 dark:hover:bg-card-dark/70 text-sm text-slate-800 dark:text-text-main">
          <input
            type="checkbox"
            checked={selectedModelSet.has(model.id)}
            onChange={() => onToggle(model.id)}
          />
          <span>{model.displayName}</span>
          <span class="text-xs font-mono text-slate-400 dark:text-text-dim ml-auto">{model.id}</span>
        </label>
      ))}
    </div>
  );
}

function AddKeyForm({ onAdd, catalog, fetchCustomModels }: {
  onAdd: (input: { provider: ApiKeyProvider; models: string[]; apiKey: string; baseUrl?: string; label?: string }) => Promise<{ ok: boolean; error?: string }>;
  catalog: Record<string, { displayName: string; defaultBaseUrl: string; models: Array<{ id: string; displayName: string }> }>;
  fetchCustomModels: (input: { provider: "custom"; apiKey: string; baseUrl: string }) => Promise<{ ok: true; models: CatalogModel[] } | { ok: false; error: string }>;
}) {
  const t = useT();
  const CUSTOM_MODELS_HINT = t("customModelsHint");
  const CUSTOM_MODELS_FALLBACK_HINT = t("customModelsFallbackHint");

  const [provider, setProvider] = useState<ApiKeyProvider>("anthropic");
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [label, setLabel] = useState("");
  const [manualModelsInput, setManualModelsInput] = useState("");
  const [customModels, setCustomModels] = useState<CatalogModel[]>([]);
  const [customModelStatus, setCustomModelStatus] = useState<CustomModelStatus>("idle");
  const [customModelMessage, setCustomModelMessage] = useState(CUSTOM_MODELS_HINT);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const latestCustomRequestRef = useRef(0);
  const latestResolvedSignatureRef = useRef("");

  const isCustom = provider === "custom";
  const providerCatalog = !isCustom ? catalog[provider]?.models ?? [] : [];
  const selectedModelSet = useMemo(() => new Set(selectedModels), [selectedModels]);

  const resetCustomModels = useCallback((status: CustomModelStatus = "idle", message = CUSTOM_MODELS_HINT) => {
    setCustomModels([]);
    setSelectedModels([]);
    setCustomModelStatus(status);
    setCustomModelMessage(message);
  }, [CUSTOM_MODELS_HINT]);

  const handleModelToggle = (modelId: string) => {
    setSelectedModels((prev) => prev.includes(modelId)
      ? prev.filter((id) => id !== modelId)
      : [...prev, modelId]);
  };

  const triggerCustomModelFetch = useCallback(async () => {
    if (!isCustom) return;

    const normalizedApiKey = apiKey.trim();
    const normalizedBaseUrl = baseUrl.trim();
    if (!normalizedApiKey || !normalizedBaseUrl) {
      resetCustomModels();
      return;
    }

    const signature = `${normalizedBaseUrl}::${normalizedApiKey}`;
    if (latestResolvedSignatureRef.current === signature && customModels.length > 0) return;

    const requestId = latestCustomRequestRef.current + 1;
    latestCustomRequestRef.current = requestId;
    setCustomModelStatus("loading");
    setCustomModelMessage(t("fetchingModels"));
    setError("");

    const result = await fetchCustomModels({
      provider: "custom",
      apiKey: normalizedApiKey,
      baseUrl: normalizedBaseUrl,
    });

    if (latestCustomRequestRef.current !== requestId) return;

    if (!result.ok || result.models.length === 0) {
      setCustomModels([]);
      setSelectedModels([]);
      setCustomModelStatus("fallback");
      setCustomModelMessage(result.ok ? CUSTOM_MODELS_FALLBACK_HINT : `${CUSTOM_MODELS_FALLBACK_HINT}: ${result.error}`);
      latestResolvedSignatureRef.current = "";
      return;
    }

    setCustomModels(result.models);
    setCustomModelStatus("loaded");
    setCustomModelMessage("");
    latestResolvedSignatureRef.current = signature;
    setSelectedModels((prev) => {
      const next = prev.filter((id) => result.models.some((model) => model.id === id));
      return next.length > 0 ? next : [result.models[0].id];
    });
  }, [apiKey, baseUrl, customModels.length, fetchCustomModels, isCustom, resetCustomModels, t, CUSTOM_MODELS_FALLBACK_HINT]);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setError("");

    const normalizedApiKey = apiKey.trim();
    const normalizedBaseUrl = baseUrl.trim();
    const normalizedManualModels = normalizeCustomModelInput(manualModelsInput);
    const models = isCustom && customModelStatus === "fallback"
      ? normalizedManualModels
      : selectedModels;

    if (models.length === 0 || !normalizedApiKey) {
      setError(isCustom && customModelStatus === "fallback"
        ? t("customModelsEnterModels")
        : t("selectModelAndKey"));
      return;
    }
    if (isCustom && !normalizedBaseUrl) {
      setError(t("baseUrlRequired"));
      return;
    }

    setAdding(true);
    const result = await onAdd({
      provider,
      models,
      apiKey: normalizedApiKey,
      baseUrl: isCustom ? normalizedBaseUrl : undefined,
      label: label.trim() || undefined,
    });
    setAdding(false);
    if (result.ok) {
      setSelectedModels([]);
      setApiKey("");
      setBaseUrl("");
      setLabel("");
      setManualModelsInput("");
      resetCustomModels();
    } else {
      setError(result.error || "Failed to add key");
    }
  };

  return (
    <form onSubmit={handleSubmit} class="flex flex-col gap-3 p-4 bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl">
      <div class="flex flex-wrap gap-3">
        <div class="flex flex-col gap-1 min-w-[140px]">
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">Provider</label>
          <select
            value={provider}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value as ApiKeyProvider;
              setProvider(v);
              setSelectedModels([]);
              setBaseUrl("");
              setApiKey("");
              setLabel("");
              setManualModelsInput("");
              latestResolvedSignatureRef.current = "";
              resetCustomModels();
            }}
            class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
          >
            {PROVIDER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        <div class="flex flex-col gap-1 flex-1 min-w-[200px]">
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">API Key</label>
          <input
            type="password"
            value={apiKey}
            onInput={(e) => {
              setApiKey((e.target as HTMLInputElement).value);
              if (isCustom) {
                latestResolvedSignatureRef.current = "";
                resetCustomModels();
              }
            }}
            placeholder="sk-..."
            class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
          />
        </div>
      </div>

      <div class="flex flex-col gap-1">
        <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">Models</label>
        {!isCustom && renderModelChecklist(providerCatalog, selectedModelSet, handleModelToggle)}
        {isCustom && customModelStatus === "loaded" && renderModelChecklist(customModels, selectedModelSet, handleModelToggle)}
        {isCustom && customModelStatus !== "loaded" && (
          <div class="flex flex-col gap-2">
            <div class="px-2.5 py-2 text-sm rounded-lg border border-dashed border-gray-200 dark:border-border-dark text-slate-400 dark:text-text-dim">
              {customModelStatus === "loading" ? t("fetchingModels") : customModelMessage}
            </div>
            {customModelStatus === "fallback" && (
              <input
                type="text"
                value={manualModelsInput}
                onInput={(e) => setManualModelsInput((e.target as HTMLInputElement).value)}
                placeholder="model-name-1, model-name-2"
                class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
              />
            )}
          </div>
        )}
      </div>

      {isCustom && (
        <div class="flex flex-col gap-1">
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">Base URL</label>
          <input
            type="url"
            value={baseUrl}
            onInput={(e) => {
              setBaseUrl((e.target as HTMLInputElement).value);
              latestResolvedSignatureRef.current = "";
              resetCustomModels();
            }}
            onBlur={() => { void triggerCustomModelFetch(); }}
            placeholder="https://api.example.com/v1"
            class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
          />
        </div>
      )}

      <div class="flex gap-3 items-end">
        <div class="flex flex-col gap-1 flex-1">
          <label class="text-[0.7rem] font-medium text-slate-500 dark:text-text-dim">Label (optional)</label>
          <input
            type="text"
            value={label}
            onInput={(e) => setLabel((e.target as HTMLInputElement).value)}
            placeholder="e.g. Production, Team A"
            class="px-2.5 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-border-dark bg-slate-50 dark:bg-bg-dark text-slate-800 dark:text-text-main"
          />
        </div>
        <button
          type="submit"
          disabled={adding}
          class="px-4 py-1.5 text-sm font-medium text-white bg-primary-action hover:bg-primary-action-hover rounded-lg transition-colors disabled:opacity-40 whitespace-nowrap"
        >
          {adding ? t("submitting") : t("addApiKey")}
        </button>
      </div>

      {error && <p class="text-xs text-red-500">{error}</p>}
    </form>
  );
}

export { AddKeyForm };

function providerBadgeColor(provider: ApiKeyProvider): string {
  switch (provider) {
    case "anthropic": return "bg-warning-container text-warning";
    case "openai": return "bg-success-container text-success";
    case "openrouter": return "bg-avatar-purple-bg text-avatar-purple-text";
    default: return "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400";
  }
}

function KeyRow({ entry, onDelete, onToggle }: {
  entry: ApiKeyEntry;
  onDelete: (id: string) => void;
  onToggle: (id: string, status: "active" | "disabled") => void;
}) {
  const t = useT();
  const isActive = entry.status === "active";

  const totalTokens = entry.usage.input_tokens + entry.usage.output_tokens;

  return (
    <div class={`flex items-center gap-3 px-4 py-2.5 bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl transition-opacity ${!isActive ? "opacity-50" : ""}`}>
      <span class={`text-[0.65rem] font-semibold uppercase px-1.5 py-0.5 rounded ${providerBadgeColor(entry.provider)}`}>
        {entry.provider}
      </span>

      <span class="text-sm font-mono text-slate-800 dark:text-text-main">
        {entry.model}
      </span>

      {entry.label && (
        <span class="text-xs text-slate-500 dark:text-text-dim">
          {entry.label}
        </span>
      )}

      <div class="flex flex-col items-end ml-auto mr-2">
        <span class="text-[0.65rem] font-medium text-slate-500 dark:text-text-dim uppercase">Usage</span>
        <div class="flex items-center gap-2">
          <span class="text-xs font-mono text-slate-700 dark:text-text-main" title={`${entry.usage.input_tokens} in / ${entry.usage.output_tokens} out`}>
            {formatNumber(totalTokens)}
          </span>
          <span class="text-[0.6rem] text-slate-400 dark:text-text-dim">
            {entry.usage.request_count} reqs
          </span>
        </div>
      </div>

      <span class="text-xs font-mono text-slate-400 dark:text-text-dim hidden sm:inline">
        {entry.apiKey}
      </span>

      <button
        onClick={() => onToggle(entry.id, isActive ? "disabled" : "active")}
        title={isActive ? t("disable") : t("enable")}
        class={`relative w-8 h-[18px] rounded-full transition-colors flex-shrink-0 ${
          isActive ? "bg-primary" : "bg-slate-300 dark:bg-slate-600"
        }`}
      >
        <span class={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white shadow transition-transform ${
          isActive ? "translate-x-[16px]" : "translate-x-0.5"
        }`} />
      </button>

      <button
        onClick={() => onDelete(entry.id)}
        title={t("deleteAccount")}
        class="p-1 text-slate-400 hover:text-red-500 transition-colors"
      >
        <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
        </svg>
      </button>
    </div>
  );
}

export function ApiKeyManager() {
  const t = useT();
  const { keys, catalog, loading, addKey, deleteKey, toggleStatus, importKeys, fetchCustomModels } = useApiKeys();
  const [showForm, setShowForm] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const grouped = useMemo(() => ({
    openai: keys.filter((k) => k.provider === "openai"),
    anthropic: keys.filter((k) => k.provider === "anthropic"),
    openrouter: keys.filter((k) => k.provider === "openrouter"),
    custom: keys.filter((k) => k.provider === "custom"),
  }), [keys]);

  const handleImport = useCallback(async () => {
    const files = fileRef.current?.files;
    if (!files || files.length === 0) return;
    try {
      const result = await importKeys(files[0]);
      setImportResult(`Added: ${result.added}, Failed: ${result.failed}`);
      setTimeout(() => setImportResult(null), 5000);
    } catch {
      setImportResult("Import failed");
    }
    if (fileRef.current) fileRef.current.value = "";
  }, [importKeys]);

  if (loading) {
    return <div class="text-sm text-slate-400 dark:text-text-dim animate-pulse">{t("loadingApiKeys")}</div>;
  }

  return (
    <div class="flex flex-col gap-3">
      <div class="flex items-center gap-2">
        <h2 class="text-sm font-semibold text-slate-700 dark:text-text-main flex items-center gap-2">
          <svg class="size-4 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z" />
          </svg>
          {t("apiKeys")}
          <span class="text-xs font-normal text-slate-400 dark:text-text-dim">
            ({keys.length})
          </span>
        </h2>

        <div class="ml-auto flex items-center gap-1">
          {importResult && (
            <span class="text-xs text-slate-500 dark:text-text-dim mr-2">{importResult}</span>
          )}

          <input ref={fileRef} type="file" accept=".json" onChange={handleImport} class="hidden" />
          <button
            onClick={() => fileRef.current?.click()}
            title={t("importApiKeys")}
            class="p-1.5 text-slate-400 dark:text-text-dim hover:text-primary transition-colors rounded-md hover:bg-primary/10"
          >
            <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12M12 16.5V3" />
            </svg>
          </button>
          <button
            onClick={() => setShowForm(!showForm)}
            title={t("addApiKey")}
            class="p-1.5 text-slate-400 dark:text-text-dim hover:text-primary transition-colors rounded-md hover:bg-primary/10"
          >
            <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </button>
        </div>
      </div>

      {showForm && (
        <AddKeyForm
          onAdd={async (input) => {
            const result = await addKey(input);
            if (result.ok) setShowForm(false);
            return result;
          }}
          catalog={catalog}
          fetchCustomModels={fetchCustomModels}
        />
      )}

      {keys.length === 0 ? (
        <div class="text-center py-8 text-sm text-slate-400 dark:text-text-dim">
          {t("noApiKeysConfigured")}
        </div>
      ) : (
        <div class="flex flex-col gap-4">
          <KeySection title={t("openaiApiKeys")} entries={grouped.openai} onDelete={deleteKey} onToggle={toggleStatus} />
          <KeySection title={t("anthropicApiKeys")} entries={grouped.anthropic} onDelete={deleteKey} onToggle={toggleStatus} />
          <KeySection title={t("openrouterApiKeys")} entries={grouped.openrouter} onDelete={deleteKey} onToggle={toggleStatus} />
          <KeySection title={t("customApiKeys")} entries={grouped.custom} onDelete={deleteKey} onToggle={toggleStatus} />
        </div>
      )}
    </div>
  );
}

function KeySection({
  title,
  entries,
  onDelete,
  onToggle,
  children,
}: {
  title: string;
  entries: ApiKeyEntry[];
  onDelete: (id: string) => void;
  onToggle: (id: string, status: "active" | "disabled") => void;
  children?: ComponentChildren;
}) {
  if (entries.length === 0 && !children) return null;
  return (
    <section class="flex flex-col gap-2">
      <div>
        <h3 class="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-text-dim">{title}</h3>
        {children}
      </div>
      {entries.map((entry) => (
        <KeyRow key={entry.id} entry={entry} onDelete={onDelete} onToggle={onToggle} />
      ))}
    </section>
  );
}
