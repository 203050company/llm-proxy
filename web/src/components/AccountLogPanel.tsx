import { useState } from "preact/hooks";
import { useAccountLogs } from "../../../shared/hooks/use-account-logs";
import { useI18n, useT } from "../../../shared/i18n/context";
import type { TranslationKey } from "../../../shared/i18n/translations";
import type { Account, AccountLogCategory, AccountLogEvent } from "../../../shared/types";

type LogFilter = AccountLogCategory | "all";

interface AccountLogPanelProps {
  account: Pick<Account, "id" | "email" | "label">;
  onClose?: () => void;
}

const eventLabelKeys: Record<string, TranslationKey> = {
  "proxy.request_started": "requestStarted",
  "proxy.proxy_selected": "proxySelected",
  "proxy.request_succeeded": "requestSucceeded",
  "proxy.request_error": "requestError",
  "proxy.fallback_triggered": "fallbackTriggered",
  "proxy.fallback_selected": "fallbackSelected",
  "proxy.empty_response_retry": "emptyResponseRetry",
  "proxy.stream_completed": "streamCompleted",
  "proxy.stream_aborted": "streamAborted",
  "proxy.stream_error": "streamError",
  "proxy.stream_write_error": "streamWriteError",
  "auth.refresh.triggered": "refreshTriggered",
  "auth.refresh.started": "refreshStarted",
  "auth.refresh.scheduled": "refreshScheduled",
  "auth.refresh.succeeded": "refreshSucceeded",
  "auth.refresh.failed_permanent": "refreshFailedPermanent",
  "auth.refresh.failed_transient": "refreshFailedTransient",
  "auth.refresh.unavailable_no_refresh_token": "refreshUnavailableNoToken",
  "auth.refresh.retry_scheduled": "refreshRetryScheduled",
  "auth.refresh.recovery_scheduled": "refreshRecoveryScheduled",
  "auth.refresh.missing_refresh_token": "refreshUnavailableNoToken",
};

const filterLabels: Record<LogFilter, TranslationKey> = {
  all: "filterAll",
  proxy: "proxyLogs",
  auth: "authLogs",
};

const levelClasses: Record<AccountLogEvent["level"], string> = {
  info: "bg-blue-500",
  warn: "bg-amber-500",
  error: "bg-red-500",
};

function formatDateTime(value: string, lang: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const locale = lang === "zh" ? "zh-CN" : lang === "ko" ? "ko-KR" : "en-US";
  return date.toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function eventLabel(log: AccountLogEvent, t: (key: TranslationKey) => string): string {
  const key = eventLabelKeys[log.eventType];
  return key ? t(key) : log.eventType;
}

function logDetails(log: AccountLogEvent): string {
  const parts: string[] = [];
  if (log.routeTag) parts.push(log.routeTag);
  if (log.model) parts.push(log.model);
  if (log.proxyName || log.proxyMode) parts.push(log.proxyName || log.proxyMode || "");
  if (log.attempt != null) parts.push(`attempt ${log.attempt}`);
  if (log.statusCode != null) parts.push(`HTTP ${log.statusCode}`);
  if (log.durationMs != null) parts.push(`${log.durationMs}ms`);
  if (log.trigger) parts.push(log.trigger);
  if (log.failureCode) parts.push(log.failureCode);
  if (log.fallbackReason) parts.push(log.fallbackReason);
  if (log.message) parts.push(log.message);
  return parts.filter(Boolean).join(" · ");
}

export function AccountLogPanel({ account, onClose }: AccountLogPanelProps) {
  const t = useT();
  const { lang } = useI18n();
  const [filter, setFilter] = useState<LogFilter>("all");
  const { logs, loading, refreshing, error, refresh } = useAccountLogs(account.id, {
    category: filter,
    enabled: true,
    limit: 100,
    pollIntervalMs: 5_000,
  });

  return (
    <div class="mt-3 rounded-xl border border-slate-100 bg-white px-3 py-3 shadow-sm dark:border-border-dark dark:bg-[#0f1720]">
      <div class="flex items-start justify-between gap-3 mb-3">
        <div>
          <h4 class="text-[0.8rem] font-semibold text-slate-700 dark:text-text-main">{t("accountLogs")}</h4>
          <p class="text-[0.68rem] text-slate-400 dark:text-text-dim truncate max-w-[20rem]">
            {account.label || account.email || account.id}
          </p>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => refresh()}
            disabled={loading || refreshing}
            class="px-2 py-1 text-[0.68rem] font-medium rounded-md border border-gray-200 bg-white text-slate-500 hover:bg-slate-50 dark:border-border-dark dark:bg-card-dark dark:text-text-main dark:hover:border-primary/50 disabled:opacity-40"
          >
            {t("refreshLogs")}
          </button>
          {onClose && (
            <button
              onClick={onClose}
              class="px-2 py-1 text-[0.68rem] font-medium rounded-md border border-gray-200 bg-white text-slate-500 hover:bg-slate-50 dark:border-border-dark dark:bg-card-dark dark:text-text-main dark:hover:border-primary/50"
            >
              {t("close")}
            </button>
          )}
        </div>
      </div>

      <div class="flex flex-wrap gap-1.5 mb-3">
        {(["all", "proxy", "auth"] as LogFilter[]).map((value) => (
          <button
            key={value}
            onClick={() => setFilter(value)}
            class={`px-2 py-1 rounded-md text-[0.68rem] font-medium border transition-colors ${
              filter === value
                ? "bg-primary text-white border-primary"
                : "bg-white dark:bg-card-dark border-gray-200 dark:border-border-dark text-slate-500 dark:text-text-main hover:border-primary/50"
            }`}
          >
            {t(filterLabels[value])}
          </button>
        ))}
      </div>

      {error && (
        <div class="mb-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-xs">
          {t("logsLoadFailed")}: {error}
        </div>
      )}

      {loading && logs.length === 0 ? (
        <div class="py-6 text-center text-xs text-slate-400 dark:text-text-dim">{t("loading")}</div>
      ) : logs.length === 0 ? (
        <div class="py-6 text-center text-xs text-slate-400 dark:text-text-dim">{t("noLogs")}</div>
      ) : (
        <div class="max-h-80 overflow-y-auto space-y-2 pr-1">
          {logs.map((log) => {
            const details = logDetails(log);
            return (
              <div key={log.id} class="rounded-lg border border-gray-100 bg-slate-50/80 px-3 py-2 dark:border-border-dark dark:bg-card-dark">
                <div class="flex items-center gap-2 min-w-0">
                  <span class={`size-2 rounded-full shrink-0 ${levelClasses[log.level]}`} />
                  <span class="text-[0.72rem] font-medium text-slate-700 dark:text-text-main truncate">
                    {eventLabel(log, t)}
                  </span>
                  <span class="ml-auto shrink-0 text-[0.65rem] text-slate-400 dark:text-text-dim">
                    {formatDateTime(log.timestamp, lang)}
                  </span>
                </div>
                {details && (
                  <p class="mt-1 text-[0.68rem] text-slate-500 dark:text-text-dim break-words">
                    {details}
                  </p>
                )}
                <div class="mt-1 flex flex-wrap items-center gap-1.5 text-[0.62rem] text-slate-400 dark:text-text-dim">
                  <span class="uppercase">{log.category}</span>
                  {log.requestId && <span>req {log.requestId}</span>}
                  {log.usage && (
                    <span>
                      in {log.usage.input_tokens ?? 0} · out {log.usage.output_tokens ?? 0}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
