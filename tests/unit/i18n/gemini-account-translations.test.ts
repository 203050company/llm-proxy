import { describe, expect, it } from "vitest";
import { translations, type LangCode } from "../../../shared/i18n/translations";

const geminiAccountKeys = [
  "geminiOAuthAccounts",
  "codexAccounts",
  "geminiAccounts",
  "importFromGeminiCli",
  "healthCheck",
  "refreshing",
  "refresh",
  "loading",
  "noGeminiOAuthAccounts",
  "accountIdentifier",
  "authStatus",
  "geminiProjectTier",
  "usage",
  "token",
  "actions",
  "noProject",
  "tierUnknown",
  "geminiLicenseUnknown",
  "geminiFreeIndividual",
  "geminiCodeAssistInternalTier",
  "requests",
  "moreModels",
  "showFewerModels",
  "allGeminiModels",
  "tokensShort",
  "requestsShort",
  "inputOutputTokens",
  "refreshToken",
  "noRefreshToken",
  "expiresAt",
  "expiryUnknown",
  "geminiStatusError",
  "checkHealth",
  "deleteAccount",
] as const;

describe("Gemini account table translations", () => {
  it("defines every Gemini account table key in each language", () => {
    for (const lang of Object.keys(translations) as LangCode[]) {
      for (const key of geminiAccountKeys) {
        expect(translations[lang][key], `${lang}.${key}`).toBeTruthy();
      }
    }
  });

  it("uses Korean labels for Gemini account table text", () => {
    expect(translations.ko.geminiOAuthAccounts).toContain("Gemini");
    expect(translations.ko.geminiAccounts).toBe("Gemini 계정");
    expect(translations.ko.importFromGeminiCli).toBe("Gemini CLI에서 가져오기");
    expect(translations.ko.noGeminiOAuthAccounts).toBe("Gemini OAuth 계정이 없습니다");
    expect(translations.ko.geminiProjectTier).toBe("라이선스");
    expect(translations.ko.geminiLicenseUnknown).toBe("라이선스 확인 불가");
    expect(translations.ko.geminiFreeIndividual).toBe("개인 무료");
    expect(translations.ko.geminiCodeAssistInternalTier).toBe("Code Assist 내부 등급: {tier}");
    expect(translations.ko.inputOutputTokens).toBe("{input} 입력 / {output} 출력");
    expect(translations.ko.refreshToken).toBe("갱신 토큰");
    expect(translations.ko.noRefreshToken).toBe("갱신 토큰 없음");
  });
});
