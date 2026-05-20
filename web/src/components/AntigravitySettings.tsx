import { useState, useCallback } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { useAntigravityCliAuth } from "../../../shared/hooks/use-antigravity-cli-auth";

interface AntigravitySettingsProps {
  apiKey: string | null;
}

export function AntigravitySettings({ apiKey }: AntigravitySettingsProps) {
  const t = useT();
  const cli = useAntigravityCliAuth(apiKey);
  const [collapsed, setCollapsed] = useState(true);

  const status = cli.status;
  const isOk = status?.exists ?? false;

  return (
    <section class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl shadow-sm transition-colors">
      <button
        onClick={() => setCollapsed(!collapsed)}
        class="w-full flex items-center justify-between p-5 cursor-pointer select-none border-none bg-transparent outline-none text-left"
      >
        <div class="flex items-center gap-2">
          <svg class="size-5 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.63 8.41a6 6 0 00-5.84 7.38h11.8M9.63 8.41a14.93 14.93 0 016.16-4.57 14.93 14.93 0 011.66 8.35m-7.82-3.78l3.18 3.18" />
          </svg>
          <div class="flex flex-col">
            <h2 class="text-[0.95rem] font-bold text-slate-800 dark:text-text-main">Antigravity CLI Settings</h2>
            <p class="text-xs text-slate-500 dark:text-text-dim mt-0.5">
              Manage accounts and status for your local Antigravity CLI sessions.
            </p>
          </div>
        </div>
        <svg class={`size-5 text-slate-400 dark:text-text-dim transition-transform ${collapsed ? "" : "rotate-180"}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {!collapsed && (
        <div class="px-5 pb-5 border-t border-slate-100 dark:border-border-dark pt-4 space-y-4">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div class="space-y-1">
              <span class="text-xs font-semibold text-slate-500 dark:text-text-dim">CLI CLI Status</span>
              <div class="flex items-center gap-2 mt-1">
                <span class={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${
                  isOk
                    ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
                    : "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
                }`}>
                  {isOk ? "Active" : "Not Found"}
                </span>
                <span class="text-xs text-slate-400 dark:text-text-dim font-mono truncate max-w-[200px]" title={status?.path}>
                  {status?.path ? status.path.replace(/\/home\/[^/]+/, "~") : ""}
                </span>
              </div>
            </div>

            <div class="space-y-1">
              <span class="text-xs font-semibold text-slate-500 dark:text-text-dim">Linked Account</span>
              <div class="text-xs font-medium text-slate-700 dark:text-text-main mt-1.5 flex items-center gap-1.5">
                {status?.currentEmail ? (
                  <>
                    <svg class="size-4 text-green-500" viewBox="0 0 20 20" fill="currentColor">
                      <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
                    </svg>
                    <span>{status.currentEmail}</span>
                  </>
                ) : (
                  <span class="text-slate-400 italic">No account matched or missing token file</span>
                )}
              </div>
            </div>
          </div>

          <div class="bg-slate-50 dark:bg-bg-dark rounded-lg p-3.5 border border-slate-100 dark:border-border-dark space-y-2">
            <h3 class="text-xs font-bold text-slate-700 dark:text-text-main">Automated Rotation Logs</h3>
            <p class="text-xs text-slate-500 dark:text-text-dim">
              Automatic rotation will replace the token file in <code>~/.gemini/antigravity-cli/antigravity-oauth-token</code> 
              automatically when the current account quota becomes exhausted.
            </p>
            {status?.lastModified && (
              <div class="text-[0.68rem] text-slate-400 dark:text-text-dim font-mono">
                Last modified: {new Date(status.lastModified).toLocaleString()}
              </div>
            )}
          </div>

          {cli.error && (
            <div class="text-xs font-semibold text-red-500 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded-lg p-3">
              {cli.error}
            </div>
          )}

          <div class="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-border-dark">
            <button
              onClick={() => cli.reload()}
              class="px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-100 dark:bg-[#21262d] text-slate-700 dark:text-text-main hover:bg-slate-200 dark:hover:bg-border-dark transition-colors"
            >
              Refresh Status
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
