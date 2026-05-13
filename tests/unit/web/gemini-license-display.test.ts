import { describe, expect, it } from "vitest";
import { buildGeminiLicenseDisplay } from "../../../web/src/components/gemini-license-display";

describe("buildGeminiLicenseDisplay", () => {
  it("uses the normalized Google AI subscription as the confirmed license", () => {
    expect(buildGeminiLicenseDisplay({
      googleAiSubscription: { tier: "Pro", source: "code-assist-paid-tier" },
      paidTier: { id: "google-ai-pro", name: "Google AI Pro" },
      userTier: "standard-tier",
      userTierName: "Standard",
    })).toEqual({
      licenseKind: "paid",
      licenseName: "Pro",
      codeAssistTierName: null,
    });
  });

  it("infers Google AI Ultra from a paidTier id when the normalized field is missing", () => {
    expect(buildGeminiLicenseDisplay({
      paidTier: { id: "google-ai-ultra" },
      userTier: "standard-tier",
    })).toEqual({
      licenseKind: "paid",
      licenseName: "Ultra",
      codeAssistTierName: null,
    });
  });

  it("collapses stale paid tier values stored as the Code Assist tier", () => {
    expect(buildGeminiLicenseDisplay({
      userTier: "g1-pro-tier",
      userTierName: "Gemini Code Assist in Google One AI Pro",
    })).toEqual({
      licenseKind: "paid",
      licenseName: "Pro",
      codeAssistTierName: null,
    });
  });

  it("does not show a verbose paid tier name as the internal Code Assist tier", () => {
    expect(buildGeminiLicenseDisplay({
      googleAiSubscription: { tier: "Pro", source: "code-assist-paid-tier" },
      paidTier: { id: "g1-pro-tier", name: "Gemini Code Assist in Google One AI Pro" },
      userTier: "standard-tier",
      userTierName: "Gemini Code Assist in Google One AI Pro",
    })).toEqual({
      licenseKind: "paid",
      licenseName: "Pro",
      codeAssistTierName: null,
    });
  });

  it("does not treat a Code Assist standard paidTier as a Google AI subscription", () => {
    expect(buildGeminiLicenseDisplay({
      paidTier: { id: "standard-tier", name: "Standard" },
      userTier: "standard-tier",
      userTierName: "Standard",
    })).toEqual({
      licenseKind: "unknown",
      licenseName: null,
      codeAssistTierName: null,
    });
  });

  it("shows a standard Code Assist account without paidTier as Free", () => {
    expect(buildGeminiLicenseDisplay({
      userTier: "standard-tier",
      userTierName: "Gemini Code Assist",
    })).toEqual({
      licenseKind: "free_individual",
      licenseName: "Free",
      codeAssistTierName: null,
    });
  });

  it("treats free-tier as the free individual Code Assist license", () => {
    expect(buildGeminiLicenseDisplay({
      googleAiSubscription: { tier: "Free", source: "code-assist-free-tier" },
      userTier: "free-tier",
    })).toEqual({
      licenseKind: "free_individual",
      licenseName: "Free",
      codeAssistTierName: null,
    });
  });

  it("returns unknown when neither paid license nor internal tier exists", () => {
    expect(buildGeminiLicenseDisplay({})).toEqual({
      licenseKind: "unknown",
      licenseName: null,
      codeAssistTierName: null,
    });
  });
});
