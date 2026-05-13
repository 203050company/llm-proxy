import { useI18n, useT } from "../../../shared/i18n/context";
import type { TranslationKey } from "../../../shared/i18n/translations";
import type { Account } from "../../../shared/types";

export type RefreshStatusAccount = Pick<
  Account,
  | "hasRefreshToken"
  | "expiresAt"
  | "nextRefreshAt"
  | "refreshState"
  | "refreshInFlight"
  | "refreshBlockedReason"
  | "lastRefreshSuccessAt"
  | "lastRefreshFailureAt"
  | "lastRefreshFailureCode"
  | "lastRefreshTrigger"
>;

interface AccountRefreshStatusProps {
  account: RefreshStatusAccount;
  compact?: boolean;
}

const refreshStateLabels: Record<string, TranslationKey> = {
  idle: "refreshIdle",
  scheduled: "refreshScheduled",
  queued: "refreshQueued",
  refreshing: "refreshRefreshing",
  retry_scheduled: "refreshRetryScheduled",
  recovery_scheduled: "refreshRecoveryScheduled",
  blocked: "refreshBlocked",
};

function hasRefreshMetadata(account: RefreshStatusAccount): boolean {
  return account.hasRefreshToken !== undefined
    || account.expiresAt != null
    || account.nextRefreshAt != null
    || account.refreshState != null
    || account.lastRefreshSuccessAt != null
    || account.lastRefreshFailureAt != null
    || account.lastRefreshFailureCode != null
    || account.refreshBlockedReason != null;
}

function formatDateTime(value: string | null | undefined, lang: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const locale = lang === "zh" ? "zh-CN" : lang === "ko" ? "ko-KR" : "en-US";
  return date.toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function stateLabel(account: RefreshStatusAccount, t: (key: TranslationKey) => string): string {
  if (account.refreshInFlight) return t("refreshRefreshing");
  if (!account.refreshState) return "—";
  const key = refreshStateLabels[account.refreshState];
  return key ? t(key) : account.refreshState.replace(/_/g, " ");
}

export function AccountRefreshStatus({ account, compact = false }: AccountRefreshStatusProps) {
  const t = useT();
  const { lang } = useI18n();

  if (!hasRefreshMetadata(account)) return null;

  const hasFailure = !!account.lastRefreshFailureAt || !!account.lastRefreshFailureCode;
  const badgeClass = account.hasRefreshToken
    ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-800/30"
    : "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-800/30";

  if (compact) {
    return (
      <div class="mt-1 flex flex-wrap items-center gap-1.5 text-[0.65rem] text-slate-400 dark:text-text-dim">
        <span class={`px-1.5 py-0.5 rounded-full border ${badgeClass}`}>
          {account.hasRefreshToken ? t("refreshable") : t("noRefreshToken")}
        </span>
        {account.refreshState && <span>{stateLabel(account, t)}</span>}
        {hasFailure && (
          <span class="text-red-500 dark:text-red-400">
            {account.lastRefreshFailureCode || t("lastRefreshFailure")}
          </span>
        )}
      </div>
    );
  }

  return (
    <div class="pt-3 mt-3 border-t border-slate-100 dark:border-border-dark">
      <div class="flex items-center justify-between mb-2">
        <span class="text-[0.78rem] font-medium text-slate-600 dark:text-text-dim">{t("authStatus")}</span>
        <span class={`px-2 py-0.5 rounded-full text-[0.68rem] font-medium border ${badgeClass}`}>
          {account.hasRefreshToken ? t("refreshable") : t("noRefreshToken")}
        </span>
      </div>
      <div class="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[0.72rem]">
        <span class="text-slate-400 dark:text-text-dim">{t("refreshState")}</span>
        <span class="text-right text-slate-600 dark:text-text-main">{stateLabel(account, t)}</span>
        <span class="text-slate-400 dark:text-text-dim">{t("expiresAt")}</span>
        <span class="text-right text-slate-600 dark:text-text-main">{formatDateTime(account.expiresAt, lang)}</span>
        <span class="text-slate-400 dark:text-text-dim">{t("nextRefreshAt")}</span>
        <span class="text-right text-slate-600 dark:text-text-main">{formatDateTime(account.nextRefreshAt, lang)}</span>
        <span class="text-slate-400 dark:text-text-dim">{t("lastRefreshSuccess")}</span>
        <span class="text-right text-slate-600 dark:text-text-main">{formatDateTime(account.lastRefreshSuccessAt, lang)}</span>
        <span class="text-slate-400 dark:text-text-dim">{t("lastRefreshFailure")}</span>
        <span class={`text-right ${hasFailure ? "text-red-500 dark:text-red-400" : "text-slate-600 dark:text-text-main"}`}>
          {account.lastRefreshFailureCode || formatDateTime(account.lastRefreshFailureAt, lang)}
        </span>
      </div>
      {account.refreshBlockedReason && (
        <p class="mt-2 text-[0.7rem] text-amber-600 dark:text-amber-400">
          {t("refreshBlockedReason")}: {account.refreshBlockedReason}
        </p>
      )}
    </div>
  );
}
