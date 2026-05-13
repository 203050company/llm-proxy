import { describe, it, expect } from "vitest";
import { interpolateTranslation } from "./context";
import { translations } from "./translations";

describe("interpolateTranslation", () => {
  it("replaces template variables", () => {
    expect(interpolateTranslation("共 {count} 条", { count: 2 })).toBe("共 2 条");
  });

  it("keeps unknown variables unchanged", () => {
    expect(interpolateTranslation("{count} / {total}", { count: 2 })).toBe("2 / {total}");
  });
});

describe("Korean dashboard translations", () => {
  it("does not fall back to English for core dashboard labels", () => {
    expect(translations.ko.addAccount).toBe("계정 추가");
    expect(translations.ko.connectedAccounts).toBe("연결된 계정");
    expect(translations.ko.manageAccounts).toBe("계정 관리");
    expect(translations.ko.usageStats).toBe("사용량 통계");
    expect(translations.ko.logs).toBe("로그");
    expect(translations.ko.errorsTab).toBe("오류");
    expect(translations.ko.settings).toBe("설정");
    expect(translations.ko.addAccount).not.toBe(translations.en.addAccount);
  });
});
