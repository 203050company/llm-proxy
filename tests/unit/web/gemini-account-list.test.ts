import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const SOURCE = readFileSync(
  resolve(__dirname, "../../../web/src/components/GeminiAccountList.tsx"),
  "utf-8",
);

describe("GeminiAccountList", () => {
  it("separates license display from the internal Code Assist tier", () => {
    expect(SOURCE).toContain('t("geminiProjectTier")');
    expect(SOURCE).toContain("buildGeminiLicenseDisplay(account)");
    expect(SOURCE).toContain("buildGeminiModelUsageRows(account)");
    expect(SOURCE).toContain('t("geminiLicenseUnknown")');
    expect(SOURCE).not.toContain('t("geminiCodeAssistInternalTier")');
    expect(SOURCE).not.toContain('account.userTierName || account.userTier || t("tierUnknown")');
    expect(SOURCE).not.toContain('t("noProject")');
  });

  it("uses accounts as columns with fixed detail rows", () => {
    expect(SOURCE).toContain("geminiAccountColumnTable");
    expect(SOURCE).toContain("geminiDetailRows");
    expect(SOURCE).toContain('key="license-row"');
    expect(SOURCE).toContain('key="model-usage-row"');
    expect(SOURCE).toContain('key="token-row"');
    expect(SOURCE).toContain('key="actions-row"');
    expect(SOURCE).not.toContain("<th class=\"text-left font-medium px-4 py-2\">{t(\"accountIdentifier\")}</th>");
  });

  it("uses icon-only account action buttons with accessible labels", () => {
    expect(SOURCE).toContain("aria-label={props.label}");
    expect(SOURCE).toContain("title={props.label}");
    expect(SOURCE).toContain("useGeminiCliAuth()");
    expect(SOURCE).toContain("handleApplyToCli");
    expect(SOURCE).toContain('label={cliInUse ? t("applyToGeminiCliBadge") : t("applyToGeminiCli")}');
    expect(SOURCE).toContain('label={t("checkHealth")}');
    expect(SOURCE).toContain('label={t("deleteAccount")}');
    expect(SOURCE).not.toContain('label={t("refresh")}');
    expect(SOURCE).not.toContain("onRefreshToken");
    expect(SOURCE).not.toContain('>{t("checkHealth")}</button>');
    expect(SOURCE).not.toContain('>{t("deleteAccount")}</button>');
  });

  it("can expand hidden Gemini model usage rows", () => {
    expect(SOURCE).toContain("expandedUsageAccounts");
    expect(SOURCE).toContain("toggleExpandedUsage");
    expect(SOURCE).toContain("aria-expanded={isExpanded}");
    expect(SOURCE).toContain("compactRows.hiddenCount");
    expect(SOURCE).toContain('t("showFewerModels")');
    expect(SOURCE).toContain('t("moreModels"');
    expect(SOURCE).not.toContain("Show fewer models");
  });
});
