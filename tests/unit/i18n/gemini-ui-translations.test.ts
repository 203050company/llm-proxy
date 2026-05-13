import { describe, expect, it } from "vitest";
import { translations, type LangCode } from "../../../shared/i18n/translations";

const keys = [
  "codexProviderDescription",
  "geminiProviderDescription",
  "geminiAddStep1",
  "geminiAddStep2",
  "geminiAddStep3",
  "apiKeys",
  "addApiKey",
  "importApiKeys",
  "noApiKeysConfigured",
  "geminiApiKeys",
  "openaiApiKeys",
  "anthropicApiKeys",
  "openrouterApiKeys",
  "customApiKeys",
  "geminiApiKeysSeparateHint",
  "geminiSettings",
  "geminiSettingsDescription",
  "geminiOAuthEnabled",
  "geminiRefreshEnabled",
  "geminiCredentialsPath",
  "geminiCodeAssistEndpoint",
  "geminiApiVersion",
  "geminiProjectId",
  "geminiRefreshMarginSeconds",
  "geminiRefreshConcurrency",
  "geminiApiKeyPriority",
  "geminiPriorityApiKey",
  "geminiPriorityOAuth",
  "geminiRoutingSummary",
  "applyToGeminiCli",
  "applyToGeminiCliBadge",
  "applyToGeminiCliConfirm",
  "applyToGeminiCliSuccess",
  "applyToGeminiCliFailed",
] as const;

describe("remaining Gemini UI translations", () => {
  it("defines every remaining Gemini UI key in each language", () => {
    for (const lang of Object.keys(translations) as LangCode[]) {
      for (const key of keys) {
        expect(translations[lang][key], `${lang}.${key}`).toBeTruthy();
      }
    }
  });

  it("uses Korean text for Gemini dashboard labels", () => {
    expect(translations.ko.geminiSettings).toBe("Gemini 설정");
    expect(translations.ko.geminiOAuthEnabled).toBe("Gemini OAuth 활성화");
    expect(translations.ko.geminiRefreshEnabled).toBe("갱신 활성화");
    expect(translations.ko.geminiApiKeys).toBe("Gemini API 키");
    expect(translations.ko.geminiRoutingSummary).toBe("모델 라우팅");
    expect(translations.ko.applyToGeminiCli).toBe("Gemini CLI에서 사용");
    expect(translations.ko.geminiAddStep1).toContain("Google OAuth");
  });
});
