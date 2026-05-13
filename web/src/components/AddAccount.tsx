import { useState, useCallback } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import type { TranslationKey } from "../../../shared/i18n/translations";

type AddProvider = "codex" | "gemini" | null;

interface AddAccountProps {
  visible: boolean;
  provider: AddProvider;
  onChooseProvider: (provider: Exclude<AddProvider, null>) => void;
  onStartCodex: () => Promise<void>;
  onStartGemini: () => Promise<void>;
  onCancel: () => void;
  onSubmitRelay: (provider: Exclude<AddProvider, null>, callbackUrl: string) => Promise<void>;
  onAddByRefreshToken: (refreshToken: string) => Promise<string | null>;
  onImportGeminiCli?: () => Promise<void>;
  addInfo: string;
  addError: string;
}

export function AddAccount({
  visible,
  provider,
  onChooseProvider,
  onStartCodex,
  onStartGemini,
  onCancel,
  onSubmitRelay,
  onAddByRefreshToken,
  onImportGeminiCli,
  addInfo,
  addError,
}: AddAccountProps) {
  const t = useT();
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [rtInput, setRtInput] = useState("");
  const [rtSubmitting, setRtSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (!provider) return;
    setSubmitting(true);
    await onSubmitRelay(provider, input);
    setSubmitting(false);
    setInput("");
  }, [input, onSubmitRelay, provider]);

  const handleRtSubmit = useCallback(async () => {
    const trimmed = rtInput.trim();
    if (!trimmed) return;
    setRtSubmitting(true);
    await onAddByRefreshToken(trimmed);
    setRtSubmitting(false);
    setRtInput("");
  }, [rtInput, onAddByRefreshToken]);

  const handleRtKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Enter") handleRtSubmit();
  }, [handleRtSubmit]);

  if (!visible && !addInfo && !addError) return null;

  return (
    <>
      {addInfo && (
        <p class="text-sm text-primary">{t(addInfo as TranslationKey)}</p>
      )}
      {addError && (
        <p class="text-sm text-red-500">{t(addError as TranslationKey)}</p>
      )}
      {visible && (
        <section class="bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-xl p-5 shadow-sm transition-colors space-y-4">
          <div class="flex justify-end">
            <button
              onClick={onCancel}
              class="text-slate-400 hover:text-slate-600 dark:text-text-dim dark:hover:text-text-main transition-colors text-sm"
            >
              {t("cancel")}
            </button>
          </div>
          {!provider && (
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                onClick={() => {
                  onChooseProvider("codex");
                  void onStartCodex();
                }}
                class="px-4 py-4 text-left rounded-lg border border-gray-200 dark:border-border-dark hover:border-primary/50 hover:bg-slate-50 dark:hover:bg-border-dark transition-colors"
              >
                <div class="text-sm font-semibold text-slate-800 dark:text-text-main">Codex</div>
                <div class="text-xs text-slate-500 dark:text-text-dim mt-1">{t("codexProviderDescription")}</div>
              </button>
              <button
                onClick={() => {
                  onChooseProvider("gemini");
                  void onStartGemini();
                }}
                class="px-4 py-4 text-left rounded-lg border border-gray-200 dark:border-border-dark hover:border-primary/50 hover:bg-slate-50 dark:hover:bg-border-dark transition-colors"
              >
                <div class="text-sm font-semibold text-slate-800 dark:text-text-main">Gemini</div>
                <div class="text-xs text-slate-500 dark:text-text-dim mt-1">{t("geminiProviderDescription")}</div>
              </button>
            </div>
          )}
          {/* OAuth callback relay */}
          {provider && (
          <div>
            <ol class="text-sm text-slate-500 dark:text-text-dim mb-4 space-y-1.5 list-decimal list-inside">
              {provider === "codex" ? (
                <>
                  <li dangerouslySetInnerHTML={{ __html: t("addStep1") }} />
                  <li dangerouslySetInnerHTML={{ __html: t("addStep2") }} />
                  <li dangerouslySetInnerHTML={{ __html: t("addStep3") }} />
                </>
              ) : (
                <>
                  <li>{t("geminiAddStep1")}</li>
                  <li>{t("geminiAddStep2")}</li>
                  <li>{t("geminiAddStep3")}</li>
                </>
              )}
            </ol>
            <div class="flex gap-3">
              <input
                type="text"
                value={input}
                onInput={(e) => setInput((e.target as HTMLInputElement).value)}
                placeholder={t("pasteCallback")}
                class="flex-1 px-3 py-2.5 bg-slate-50 dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-sm font-mono text-slate-600 dark:text-text-main focus:ring-2 focus:ring-primary/50 focus:border-primary outline-none transition-colors"
              />
              <button
                onClick={handleSubmit}
                disabled={submitting}
                class="px-4 py-2.5 bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-lg text-sm font-medium text-slate-700 dark:text-text-main hover:bg-slate-50 dark:hover:bg-border-dark transition-colors"
              >
                {submitting ? t("submitting") : t("submit")}
              </button>
            </div>
          </div>
          )}

          {/* Refresh token direct add */}
          {provider === "codex" && (
          <div class="pt-3 border-t border-gray-100 dark:border-border-dark">
            <div class="flex gap-3">
              <input
                type="text"
                value={rtInput}
                onInput={(e) => setRtInput((e.target as HTMLInputElement).value)}
                onKeyDown={handleRtKeyDown}
                placeholder={t("pasteRefreshToken")}
                class="flex-1 px-3 py-2.5 bg-slate-50 dark:bg-bg-dark border border-gray-200 dark:border-border-dark rounded-lg text-sm font-mono text-slate-600 dark:text-text-main focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500 outline-none transition-colors"
              />
              <button
                onClick={handleRtSubmit}
                disabled={rtSubmitting || !rtInput.trim()}
                class="px-4 py-2.5 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30 rounded-lg text-sm font-medium text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors disabled:opacity-40"
              >
                {rtSubmitting ? t("addingByRt") : t("addByRt")}
              </button>
            </div>
          </div>
          )}
          {provider === "gemini" && onImportGeminiCli && (
            <div class="pt-3 border-t border-gray-100 dark:border-border-dark">
              <button
                onClick={() => void onImportGeminiCli()}
                class="px-4 py-2.5 bg-white dark:bg-card-dark border border-gray-200 dark:border-border-dark rounded-lg text-sm font-medium text-slate-700 dark:text-text-main hover:bg-slate-50 dark:hover:bg-border-dark transition-colors"
              >
                {t("importFromGeminiCli")}
              </button>
            </div>
          )}
        </section>
      )}
    </>
  );
}
