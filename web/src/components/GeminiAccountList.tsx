import { useT } from "../../../shared/i18n/context";
import type { TranslationKey } from "../../../shared/i18n/translations";
import type { GeminiAccount } from "../../../shared/hooks/use-gemini-accounts";
import { useGeminiCliAuth } from "../../../shared/hooks/use-gemini-cli-auth";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { buildGeminiLicenseDisplay } from "./gemini-license-display";
import {
  buildGeminiModelUsageRows,
  getVisibleGeminiModelUsageRows,
  type GeminiModelUsageRow,
} from "./gemini-model-usage";
import { formatNumber } from "./UsageChart";

interface GeminiAccountListProps {
  accounts: GeminiAccount[];
  loading: boolean;
  refreshing?: boolean;
  onRefresh: () => void | Promise<void>;
  onDelete: (id: string) => Promise<string | null>;
  onHealthCheck: (id?: string) => Promise<void>;
  onImportCli?: () => Promise<void>;
}

const statusLabels: Record<string, TranslationKey> = {
  active: "active",
  expired: "expired",
  refreshing: "refreshing",
  rate_limited: "rateLimited",
  quota_exhausted: "quotaExhausted",
  disabled: "disabled",
  error: "geminiStatusError",
};

const MAX_VISIBLE_GEMINI_MODELS = 3;
const geminiDetailRows = ["status-row", "license-row", "model-usage-row", "token-row", "actions-row"] as const;

function fill(template: string, values: Record<string, string | number>): string {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.replace(`{${key}}`, String(value));
  }
  return result;
}

function usageBarColor(row: GeminiModelUsageRow): string {
  if (!row.hasQuota) return "bg-blue-500";
  if (row.graphPercent >= 90) return "bg-red-500";
  if (row.graphPercent >= 60) return "bg-amber-500";
  return "bg-primary";
}

function usageTextColor(row: GeminiModelUsageRow): string {
  if (!row.hasQuota) return "text-blue-500";
  if (row.graphPercent >= 90) return "text-red-500";
  if (row.graphPercent >= 60) return "text-amber-600 dark:text-amber-500";
  return "text-primary";
}

function formatResetTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getMonth() + 1}/${date.getDate()} ${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}

function IconButton(props: {
  label: string;
  tone?: "default" | "danger" | "active";
  disabled?: boolean;
  onClick: () => void;
  children: ComponentChildren;
}) {
  const toneClass = props.tone === "danger"
    ? "text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
    : props.tone === "active"
      ? "text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800/30"
      : "text-slate-500 dark:text-text-dim hover:bg-slate-50 dark:hover:bg-border-dark";
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      aria-label={props.label}
      title={props.label}
      class={`inline-flex h-8 w-8 items-center justify-center rounded-md border border-gray-200 dark:border-border-dark disabled:opacity-50 disabled:cursor-not-allowed ${toneClass}`}
    >
      {props.children}
    </button>
  );
}

function CliApplyIcon() {
  return (
    <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 17 10 12 4 7" />
      <path d="M12 19h8" />
      <path d="M14 5h4a2 2 0 0 1 2 2v6" />
    </svg>
  );
}

function HealthCheckIcon(props: { animate?: boolean }) {
  return (
    <svg class={`h-4 w-4 ${props.animate ? "animate-spin" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v5" />
      <path d="M14 11v5" />
    </svg>
  );
}

function renderModelUsage(
  account: GeminiAccount,
  t: ReturnType<typeof useT>,
  isExpanded: boolean,
  toggleExpandedUsage: (id: string) => void,
) {
  const modelUsageRows = buildGeminiModelUsageRows(account);
  if (modelUsageRows.length === 0) {
    return <span class="text-slate-400 dark:text-text-dim">{t("quotaDataUnavailable")}</span>;
  }

  const compactRows = isExpanded
    ? { visible: modelUsageRows, hiddenCount: 0 }
    : getVisibleGeminiModelUsageRows(modelUsageRows, MAX_VISIBLE_GEMINI_MODELS);
  return (
    <div class="space-y-2 min-w-[220px]">
      {compactRows.visible.map((row) => {
        const resetAt = formatResetTime(row.quotaResetTime);
        return (
          <div key={row.model}>
            <div class="flex items-center justify-between gap-3 mb-1">
              <span class="font-mono text-[0.72rem] text-slate-600 dark:text-text-main truncate" title={row.model}>
                {row.model}
              </span>
              <span class={`font-medium whitespace-nowrap ${usageTextColor(row)}`}>
                {row.hasQuota ? `${row.graphPercent}% ${t("used")}` : `${row.graphPercent}%`}
              </span>
            </div>
            <div class="h-2 rounded-full bg-slate-100 dark:bg-border-dark overflow-hidden">
              <div
                class={`h-2 rounded-full transition-all ${usageBarColor(row)}`}
                style={{ width: `${row.graphPercent}%` }}
              />
            </div>
            <div class="mt-1 flex items-center justify-between gap-2 text-[0.7rem] text-slate-400 dark:text-text-dim">
              <span>{formatNumber(row.totalTokens)} tok · {formatNumber(row.requestCount)} req</span>
              {resetAt && (
                <span class="flex items-center gap-1">
                  <svg class="size-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
                  </svg>
                  {resetAt}
                </span>
              )}
            </div>
          </div>
        );
      })}
      {(compactRows.hiddenCount > 0 || isExpanded) && modelUsageRows.length > MAX_VISIBLE_GEMINI_MODELS && (
        <button
          type="button"
          onClick={() => toggleExpandedUsage(account.id)}
          aria-expanded={isExpanded}
          class="text-[0.72rem] text-slate-400 dark:text-text-dim hover:text-primary"
        >
          {isExpanded ? "Show fewer models" : (
            <>
              +
              {compactRows.hiddenCount}
              {" models"}
            </>
          )}
        </button>
      )}
    </div>
  );
}

export function GeminiAccountList({
  accounts,
  loading,
  refreshing,
  onRefresh,
  onDelete,
  onHealthCheck,
  onImportCli,
}: GeminiAccountListProps) {
  const t = useT();
  const cliAuth = useGeminiCliAuth();
  const [expandedUsageAccounts, setExpandedUsageAccounts] = useState<Set<string>>(() => new Set());
  const [cliMessage, setCliMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const toggleExpandedUsage = (id: string) => {
    setExpandedUsageAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };
  const licensePrimaryLabel = (account: GeminiAccount): string => {
    const license = buildGeminiLicenseDisplay(account);
    if (license.licenseKind === "paid" && license.licenseName) return license.licenseName;
    if (license.licenseKind === "free_individual" && license.licenseName) return license.licenseName;
    if (license.licenseKind === "free_individual") return t("geminiFreeIndividual");
    return t("geminiLicenseUnknown");
  };
  const handleApplyToCli = async (id: string) => {
    const path = cliAuth.status?.path ?? "~/.gemini/oauth_creds.json";
    if (!confirm(t("applyToGeminiCliConfirm").replace("{path}", path))) return;

    const err = await cliAuth.apply(id);
    if (err) {
      setCliMessage({ text: t("applyToGeminiCliFailed").replace("{error}", err), error: true });
      setTimeout(() => setCliMessage(null), 5000);
      return;
    }
    setCliMessage({ text: t("applyToGeminiCliSuccess") });
    setTimeout(() => setCliMessage(null), 5000);
  };

  return (
    <section class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl shadow-sm overflow-hidden">
      <div class="px-4 py-3 border-b border-gray-100 dark:border-border-dark flex items-center justify-between gap-3">
        <div class="text-sm text-slate-500 dark:text-text-dim">
          {fill(t("geminiOAuthAccounts"), { count: accounts.length })}
        </div>
        <div class="flex items-center gap-2">
          {onImportCli && (
            <button
              onClick={onImportCli}
              class="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 dark:border-border-dark text-slate-600 dark:text-text-dim hover:bg-slate-50 dark:hover:bg-border-dark"
            >
              {t("importFromGeminiCli")}
            </button>
          )}
          <button
            onClick={() => onHealthCheck()}
            class="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 dark:border-border-dark text-slate-600 dark:text-text-dim hover:bg-slate-50 dark:hover:bg-border-dark"
          >
            {t("healthCheck")}
          </button>
          <button
            onClick={() => onRefresh()}
            disabled={refreshing}
            class="px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-white disabled:opacity-50"
          >
            {refreshing ? t("refreshing") : t("refresh")}
          </button>
        </div>
      </div>

      {cliMessage && (
        <div class={`mx-4 mt-3 rounded-lg px-3 py-2 text-xs ${cliMessage.error ? "bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300" : "bg-primary/10 text-primary"}`}>
          {cliMessage.text}
        </div>
      )}

      {loading ? (
        <div class="p-8 text-center text-sm text-slate-400 dark:text-text-dim">{t("loading")}</div>
      ) : accounts.length === 0 ? (
        <div class="p-8 text-center text-sm text-slate-400 dark:text-text-dim">{t("noGeminiOAuthAccounts")}</div>
      ) : (
        <div class="overflow-x-auto">
          <table class="w-full min-w-[760px] text-sm" data-table="geminiAccountColumnTable" data-detail-rows={geminiDetailRows.length}>
            <thead class="bg-slate-50 dark:bg-bg-dark text-xs text-slate-500 dark:text-text-dim">
              <tr>
                <th class="text-left font-medium px-4 py-2 w-36 sticky left-0 z-10 bg-slate-50 dark:bg-bg-dark">{t("accountIdentifier")}</th>
                {accounts.map((account) => (
                  <th key={account.id} class="text-left font-medium px-4 py-2 min-w-[260px]">
                    <div class="font-medium text-slate-700 dark:text-text-main">{account.label || account.email}</div>
                    <div class="text-xs text-slate-400 dark:text-text-dim font-normal">{account.email}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100 dark:divide-border-dark">
              <tr key="status-row" class="text-slate-700 dark:text-text-main align-top">
                <th scope="row" class="px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-text-dim sticky left-0 z-10 bg-white dark:bg-card-dark">
                  {t("authStatus")}
                </th>
                {accounts.map((account) => (
                  <td key={account.id} class="px-4 py-3">
                    <span class="px-2 py-1 rounded-full text-xs bg-primary/10 text-primary">{t(statusLabels[account.status] ?? "geminiStatusError")}</span>
                  </td>
                ))}
              </tr>
              <tr key="license-row" class="text-slate-700 dark:text-text-main align-top">
                <th scope="row" class="px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-text-dim sticky left-0 z-10 bg-white dark:bg-card-dark">
                  {t("geminiProjectTier")}
                </th>
                {accounts.map((account) => {
                  const license = buildGeminiLicenseDisplay(account);
                  return (
                    <td key={account.id} class="px-4 py-3 text-xs text-slate-500 dark:text-text-dim">
                      <div>{licensePrimaryLabel(account)}</div>
                    </td>
                  );
                })}
              </tr>
              <tr key="model-usage-row" class="text-slate-700 dark:text-text-main align-top">
                <th scope="row" class="px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-text-dim sticky left-0 z-10 bg-white dark:bg-card-dark">
                  {t("usage")}
                </th>
                {accounts.map((account) => (
                  <td key={account.id} class="px-4 py-3 text-xs text-slate-500 dark:text-text-dim">
                    <div class="mb-2">
                      <div>{fill(t("requests"), { count: account.usage?.request_count ?? 0 })}</div>
                      <div>{fill(t("inputOutputTokens"), { input: account.usage?.input_tokens ?? 0, output: account.usage?.output_tokens ?? 0 })}</div>
                    </div>
                    {renderModelUsage(account, t, expandedUsageAccounts.has(account.id), toggleExpandedUsage)}
                  </td>
                ))}
              </tr>
              <tr key="token-row" class="text-slate-700 dark:text-text-main align-top">
                <th scope="row" class="px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-text-dim sticky left-0 z-10 bg-white dark:bg-card-dark">
                  {t("token")}
                </th>
                {accounts.map((account) => (
                  <td key={account.id} class="px-4 py-3 text-xs text-slate-500 dark:text-text-dim">
                    <div>{account.hasRefreshToken ? t("refreshToken") : t("noRefreshToken")}</div>
                    <div>{account.expiresAt ? new Date(account.expiresAt).toLocaleString() : t("expiryUnknown")}</div>
                  </td>
                ))}
              </tr>
              <tr key="actions-row" class="text-slate-700 dark:text-text-main align-top">
                <th scope="row" class="px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-text-dim sticky left-0 z-10 bg-white dark:bg-card-dark">
                  {t("actions")}
                </th>
                {accounts.map((account) => (
                  <td key={account.id} class="px-4 py-3">
                    <div class="flex items-center gap-2">
                      {(() => {
                        const cliInUse = cliAuth.status?.matchedEntryId === account.id;
                        return (
                          <IconButton
                            label={cliInUse ? t("applyToGeminiCliBadge") : t("applyToGeminiCli")}
                            tone={cliInUse ? "active" : "default"}
                            disabled={cliAuth.applying || !account.hasRefreshToken}
                            onClick={() => handleApplyToCli(account.id)}
                          >
                            <CliApplyIcon />
                          </IconButton>
                        );
                      })()}
                      <IconButton label={t("checkHealth")} onClick={() => onHealthCheck(account.id)}>
                        <HealthCheckIcon animate={refreshing} />
                      </IconButton>
                      <IconButton label={t("deleteAccount")} tone="danger" onClick={() => onDelete(account.id)}>
                        <DeleteIcon />
                      </IconButton>
                    </div>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
