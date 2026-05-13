import { useCallback, useState } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import type { TranslationKey } from "../../../shared/i18n/translations";
import type { Account, ProxyEntry } from "../../../shared/types";
import { buildAccountQuotaSections, type AccountQuotaSection } from "./account-card-quota";
import { AccountLogPanel } from "./AccountLogPanel";
import { AccountRefreshStatus } from "./AccountRefreshStatus";

const statusStyles: Record<string, [string, TranslationKey]> = {
  active: [
    "bg-green-100 text-green-700 border-green-200 dark:bg-[#11281d] dark:text-primary dark:border-[#1a442e]",
    "active",
  ],
  expired: [
    "bg-red-100 text-red-600 border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800/30",
    "expired",
  ],
  quota_exhausted: [
    "bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-900/20 dark:text-orange-400 dark:border-orange-800/30",
    "quotaExhausted",
  ],
  rate_limited: [
    "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-800/30",
    "rateLimited",
  ],
  refreshing: [
    "bg-blue-100 text-blue-600 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800/30",
    "refreshing",
  ],
  disabled: [
    "bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800/30 dark:text-slate-400 dark:border-slate-700/30",
    "disabled",
  ],
  banned: [
    "bg-rose-100 text-rose-700 border-rose-300 dark:bg-rose-900/30 dark:text-rose-400 dark:border-rose-800/40",
    "banned",
  ],
};

interface AccountOverviewListItemProps {
  account: Account;
  onDelete: (id: string) => Promise<string | null>;
  proxies?: ProxyEntry[];
  onProxyChange?: (accountId: string, proxyId: string) => void;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
  onRefreshQuota?: (id: string) => Promise<void>;
  onToggleStatus?: (id: string, currentStatus: string) => Promise<string | null>;
  onUpdateLabel?: (id: string, label: string | null) => Promise<string | null>;
  onApplyToCli?: (id: string) => Promise<string | null>;
  cliInUse?: boolean;
}

function formatShortResetTime(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })}`;
}

function UsageSummary({ labelKey, section }: { labelKey: "current5hUsage" | "weeklyUsage"; section?: AccountQuotaSection }) {
  const t = useT();
  const percentage = section?.percentage ?? null;
  const resetAt = section?.resetAt ? formatShortResetTime(section.resetAt) : null;
  const percentValue = percentage == null ? 0 : Math.max(0, Math.min(100, percentage));
  const gaugeClass = percentage == null
    ? "bg-slate-300 dark:bg-slate-600"
    : percentage >= 90 || section?.state === "limit_reached"
      ? "bg-red-500 dark:bg-red-400"
      : percentage >= 60
        ? "bg-amber-500 dark:bg-amber-400"
        : section?.kind === "secondary"
          ? "bg-indigo-500"
          : "bg-primary";
  const textClass = percentage == null
    ? "text-slate-500 dark:text-text-dim"
    : percentage >= 90 || section?.state === "limit_reached"
      ? "text-red-500 dark:text-red-400"
      : percentage >= 60
        ? "text-amber-600 dark:text-amber-500"
        : section?.kind === "secondary"
          ? "text-indigo-500"
          : "text-primary";

  return (
    <div class="rounded-lg bg-slate-50 dark:bg-bg-dark px-3 py-2 md:bg-transparent md:dark:bg-transparent md:px-0 md:py-0">
      <span class="block text-[0.65rem] font-medium uppercase tracking-wide text-slate-400 dark:text-text-dim md:hidden">
        {t(labelKey)}
      </span>
      {percentage == null ? (
        <span class="block text-sm font-semibold md:text-xs text-primary">
          {section?.state === "used" ? t("active") : t("quotaDataUnavailable")}
        </span>
      ) : (
        <div class="flex items-center gap-2">
          <div class="h-2 flex-1 min-w-16 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
            <div
              class={`h-full rounded-full transition-[width] duration-300 ${gaugeClass}`}
              style={{ width: `${percentValue}%` }}
            />
          </div>
          <span class={`w-9 text-right text-xs font-semibold tabular-nums ${textClass}`}>
            {percentage}%
          </span>
        </div>
      )}
      {resetAt && (
        <span class="mt-1 flex items-center gap-1 text-[0.65rem] text-slate-400 dark:text-text-dim truncate">
          <svg class="size-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992m0 0v-4.99m0 4.99-3.181-3.182a8.25 8.25 0 0 0-13.803 3.7m-.046 4.786H2.985m0 0v4.992m0-4.992 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7" />
          </svg>
          <span>{resetAt}</span>
        </span>
      )}
    </div>
  );
}

export function AccountOverviewListItem({ account, onDelete, proxies, onProxyChange, selected, onToggleSelect, onRefreshQuota, onToggleStatus, onUpdateLabel, onApplyToCli, cliInUse }: AccountOverviewListItemProps) {
  const t = useT();
  const email = account.email || "Unknown";
  const plan = account.planType || t("freeTier");
  const [statusCls, statusKey] = statusStyles[account.status] || statusStyles.disabled;
  const quotaSections = buildAccountQuotaSections(account);
  const primaryUsage = quotaSections.find((section) => section.kind === "primary");
  const weeklyUsage = quotaSections.find((section) => section.kind === "secondary");
  const [quotaRefreshing, setQuotaRefreshing] = useState(false);
  const [statusToggling, setStatusToggling] = useState(false);
  const [applyingCli, setApplyingCli] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState(account.label || email);

  const isEnabled = account.status !== "disabled";
  const canToggle = account.status === "active" || account.status === "disabled" || account.status === "rate_limited" || account.status === "refreshing" || account.status === "quota_exhausted";

  const handleDelete = useCallback(async () => {
    if (!confirm(t("removeConfirm"))) return;
    const err = await onDelete(account.id);
    if (err) alert(err);
  }, [account.id, onDelete, t]);

  const handleToggle = useCallback(() => {
    onToggleSelect?.(account.id);
  }, [account.id, onToggleSelect]);

  const handleRefreshQuota = useCallback(async () => {
    if (!onRefreshQuota) return;
    setQuotaRefreshing(true);
    try {
      await onRefreshQuota(account.id);
    } finally {
      setQuotaRefreshing(false);
    }
  }, [account.id, onRefreshQuota]);

  const handleStatusToggle = useCallback(async () => {
    if (!onToggleStatus || !canToggle) return;
    setStatusToggling(true);
    try {
      const err = await onToggleStatus(account.id, account.status);
      if (err) console.error(err);
    } finally {
      setStatusToggling(false);
    }
  }, [account.id, account.status, canToggle, onToggleStatus]);

  const handleApplyToCli = useCallback(async () => {
    if (!onApplyToCli) return;
    setApplyingCli(true);
    try {
      await onApplyToCli(account.id);
    } finally {
      setApplyingCli(false);
    }
  }, [account.id, onApplyToCli]);

  const handleLabelEdit = useCallback(() => {
    setLabelDraft(account.label || email);
    setEditingLabel(true);
  }, [account.label, email]);

  const handleLabelSave = useCallback(async () => {
    if (!onUpdateLabel) return;
    const trimmed = labelDraft.trim();
    const nextLabel = !trimmed || trimmed === email ? null : trimmed;
    const err = await onUpdateLabel(account.id, nextLabel);
    if (err) console.error(err);
    setEditingLabel(false);
  }, [account.id, email, labelDraft, onUpdateLabel]);

  const handleLabelKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Enter") handleLabelSave();
    if (e.key === "Escape") setEditingLabel(false);
  }, [handleLabelSave]);

  return (
    <div class={`border border-transparent border-b-gray-100 dark:border-b-border-dark/60 last:border-b-transparent transition-colors ${selected ? "border-primary bg-primary/5 ring-1 ring-inset ring-primary/30 dark:bg-primary/10" : "hover:border-primary/30 dark:hover:border-primary/50"}`}>
      <div class="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1.7fr)_9rem_8rem_8rem_minmax(12rem,1fr)] md:items-center">
        <div class="flex items-start gap-3 min-w-0">
          {onToggleSelect && (
            <input
              type="checkbox"
              checked={selected}
              onChange={handleToggle}
              class="mt-1 size-4 rounded border-gray-300 dark:border-border-dark text-primary focus:ring-primary/50 cursor-pointer shrink-0"
            />
          )}
          <div class="min-w-0 flex-1">
            {editingLabel ? (
              <input
                type="text"
                value={labelDraft}
                onInput={(e) => setLabelDraft((e.target as HTMLInputElement).value)}
                onKeyDown={handleLabelKeyDown}
                onBlur={handleLabelSave}
                maxLength={64}
                placeholder={t("labelPlaceholder")}
                class="text-sm font-semibold w-full px-1.5 py-0.5 -ml-1.5 rounded border border-primary bg-white dark:bg-bg-dark text-slate-700 dark:text-text-main focus:outline-none focus:ring-1 focus:ring-primary"
                autoFocus
              />
            ) : (
              <div class="flex items-center gap-1 group min-w-0">
                <h3 class="text-sm font-semibold truncate text-slate-700 dark:text-text-main">
                  {account.label || email}
                </h3>
                {onUpdateLabel && (
                  <button
                    onClick={handleLabelEdit}
                    class="p-0.5 text-slate-300 dark:text-text-dim/50 opacity-0 group-hover:opacity-100 hover:text-primary transition-all shrink-0"
                    title={t("editLabel")}
                  >
                    <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125" />
                    </svg>
                  </button>
                )}
              </div>
            )}
            <p class="text-xs text-slate-500 dark:text-text-dim truncate">
              {account.label ? `${email} · ${plan}` : plan}
            </p>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2 md:block">
          <span class="text-[0.65rem] font-medium uppercase tracking-wide text-slate-400 dark:text-text-dim md:hidden">
            {t("authStatus")}
          </span>
          <span class={`px-2 py-0.5 rounded-full text-[0.68rem] font-medium border ${statusCls}`}>
            {t(statusKey)}
          </span>
          <AccountRefreshStatus account={account} compact />
        </div>

        <UsageSummary labelKey="current5hUsage" section={primaryUsage} />
        <UsageSummary labelKey="weeklyUsage" section={weeklyUsage} />

        <div class="flex flex-col gap-2">
          <div class="flex items-center gap-1.5 flex-wrap md:justify-end">
            {onToggleStatus && (
              <button
                onClick={handleStatusToggle}
                disabled={!canToggle || statusToggling}
                title={canToggle ? (isEnabled ? t("disableAccount") : t("enableAccount")) : undefined}
                class={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
                  !canToggle ? "opacity-40 cursor-not-allowed" : "cursor-pointer"
                } ${isEnabled ? "bg-primary" : "bg-slate-300 dark:bg-slate-600"}`}
              >
                <span
                  class={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white dark:bg-slate-200 shadow transform transition-transform duration-200 ${
                    isEnabled ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </button>
            )}
            {onRefreshQuota && (
              <button
                onClick={handleRefreshQuota}
                disabled={quotaRefreshing}
                class="p-1.5 text-slate-400 dark:text-text-dim hover:text-amber-500 transition-colors rounded-md hover:bg-amber-50 dark:hover:bg-amber-900/20 disabled:opacity-40"
                title={t("refreshQuota")}
              >
                <svg class={`size-[16px] ${quotaRefreshing ? "animate-spin" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                  <path d="M21 3v5h-5" />
                  <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                  <path d="M3 21v-5h5" />
                </svg>
              </button>
            )}
            {onApplyToCli && (
              <button
                onClick={handleApplyToCli}
                disabled={applyingCli}
                class={`p-1.5 transition-colors rounded-md disabled:opacity-40 ${
                  cliInUse
                    ? "text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
                    : "text-slate-400 dark:text-text-dim hover:text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
                }`}
                title={cliInUse ? t("applyToCodexCliBadge") : t("applyToCodexCli")}
              >
                <svg class="size-[16px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9-9h13.5a1.5 1.5 0 011.5 1.5v12a1.5 1.5 0 01-1.5 1.5H5.25a1.5 1.5 0 01-1.5-1.5v-12a1.5 1.5 0 011.5-1.5z" />
                </svg>
              </button>
            )}
            <button
              onClick={() => setLogsOpen((open) => !open)}
              class="p-1.5 text-slate-400 dark:text-text-dim hover:text-primary transition-colors rounded-md hover:bg-slate-100 dark:hover:bg-border-dark"
              title={logsOpen ? t("hideLogs") : t("viewLogs")}
            >
              <svg class="size-[17px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75Zm0 5.25h.007v.008H3.75V12Zm0 5.25h.007H3.75v-.008Z" />
              </svg>
            </button>
            <button
              onClick={handleDelete}
              class="p-1.5 text-slate-400 dark:text-text-dim hover:text-red-500 transition-colors rounded-md hover:bg-red-50 dark:hover:bg-red-900/20"
              title={t("deleteAccount")}
            >
              <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
              </svg>
            </button>
          </div>

          {proxies && onProxyChange && (
            <select
              value={account.proxyId || "global"}
              onChange={(e) => onProxyChange(account.id, (e.target as HTMLSelectElement).value)}
              class="w-full text-xs px-2 py-1 rounded-md border border-gray-200 dark:border-border-dark bg-white dark:bg-bg-dark text-slate-700 dark:text-text-main focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
            >
              <option value="global">{t("globalDefault")}</option>
              <option value="direct">{t("directNoProxy")}</option>
              <option value="auto">{t("autoRoundRobin")}</option>
              {proxies.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.health?.exitIp ? ` (${p.health.exitIp})` : ""}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {logsOpen && (
        <div class="px-4 pb-3">
          <AccountLogPanel account={account} onClose={() => setLogsOpen(false)} />
        </div>
      )}
    </div>
  );
}
