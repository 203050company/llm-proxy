import { describe, expect, it, vi } from "vitest";
import {
  extractGeminiCodeAssistTierInfo,
  fetchGeminiCodeAssistTier,
} from "@src/auth/gemini-code-assist-profile.js";

describe("Gemini Code Assist profile", () => {
  it("keeps Code Assist tier separate from a Google AI Pro paid tier", () => {
    const info = extractGeminiCodeAssistTierInfo({
      currentTier: { id: "standard-tier", name: "Gemini Code Assist" },
      paidTier: { id: "g1-pro-tier", name: "Gemini Code Assist in Google One AI Pro" },
    });

    expect(info).toEqual({
      userTier: "standard-tier",
      userTierName: "Gemini Code Assist",
      paidTier: { id: "g1-pro-tier", name: "Gemini Code Assist in Google One AI Pro" },
      googleAiSubscription: {
        tier: "Pro",
        source: "code-assist-paid-tier",
        raw: { id: "g1-pro-tier", name: "Gemini Code Assist in Google One AI Pro" },
      },
      projectId: null,
      quota: null,
    });
  });

  it("uses currentTier when no paidTier is present", () => {
    const info = extractGeminiCodeAssistTierInfo({
      currentTier: { id: "free-tier", name: "Free" },
    });

    expect(info).toEqual({
      userTier: "free-tier",
      userTierName: "Free",
      paidTier: null,
      googleAiSubscription: {
        tier: "Free",
        source: "code-assist-free-tier",
        raw: { id: "free-tier", name: "Free" },
      },
      projectId: null,
      quota: null,
    });
  });

  it("does not treat Code Assist standard paidTier as a Google AI subscription", () => {
    const info = extractGeminiCodeAssistTierInfo({
      currentTier: { id: "standard-tier", name: "Gemini Code Assist" },
      paidTier: { id: "standard-tier", name: "Standard" },
    });

    expect(info).toEqual({
      userTier: "standard-tier",
      userTierName: "Gemini Code Assist",
      paidTier: { id: "standard-tier", name: "Standard" },
      googleAiSubscription: null,
      projectId: null,
      quota: null,
    });
  });

  it("treats a standard Code Assist account without paidTier as Free", () => {
    const info = extractGeminiCodeAssistTierInfo({
      currentTier: { id: "standard-tier", name: "Gemini Code Assist" },
    });

    expect(info).toMatchObject({
      userTier: "standard-tier",
      userTierName: "Gemini Code Assist",
      paidTier: null,
      googleAiSubscription: {
        tier: "Free",
        source: "code-assist-free-tier",
      },
    });
  });

  it("falls back to the default allowed tier during onboarding responses", () => {
    const info = extractGeminiCodeAssistTierInfo({
      allowedTiers: [
        { id: "legacy-tier", name: "Legacy" },
        { id: "standard-tier", name: "Standard", isDefault: true },
      ],
    });

    expect(info).toEqual({
      userTier: "standard-tier",
      userTierName: "Standard",
      paidTier: null,
      googleAiSubscription: null,
      projectId: null,
      quota: null,
    });
  });

  it("returns null when Code Assist does not expose a usable tier", () => {
    expect(extractGeminiCodeAssistTierInfo({ allowedTiers: [] })).toBeNull();
    expect(extractGeminiCodeAssistTierInfo({})).toBeNull();
    expect(extractGeminiCodeAssistTierInfo(null)).toBeNull();
  });

  it("calls the Gemini CLI-compatible loadCodeAssist endpoint without requiring project id", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      currentTier: { id: "standard-tier", name: "Standard" },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const info = await fetchGeminiCodeAssistTier("access-token", {
      endpoint: "https://cloudcode.example.test",
      apiVersion: "v1internal",
      fetchImpl,
    });

    expect(info?.userTierName).toBe("Standard");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://cloudcode.example.test/v1internal:loadCodeAssist");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer access-token",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      metadata: {
        ideType: "IDE_UNSPECIFIED",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      },
    });
  });

  it("fetches model-specific quota buckets when Code Assist returns a project", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        cloudaicompanionProject: "project-1",
        currentTier: { id: "standard-tier", name: "Gemini Code Assist" },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        buckets: [
          { modelId: "gemini-3.1-pro", remainingFraction: 0.25, resetTime: "2026-05-11T12:00:00Z" },
          { modelId: "gemini-3.1-flash-lite", remainingFraction: 0.9 },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

    const info = await fetchGeminiCodeAssistTier("access-token", {
      endpoint: "https://cloudcode.example.test",
      apiVersion: "v1internal",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toBe("https://cloudcode.example.test/v1internal:retrieveUserQuota");
    expect(JSON.parse(String((fetchImpl.mock.calls[1][1] as RequestInit).body))).toEqual({
      project: "project-1",
    });
    expect(info?.projectId).toBe("project-1");
    expect(info?.quota?.modelBuckets).toEqual([
      { modelId: "gemini-3.1-pro", remainingFraction: 0.25, resetTime: "2026-05-11T12:00:00Z", remainingAmount: null, tokenType: null },
      { modelId: "gemini-3.1-flash-lite", remainingFraction: 0.9, resetTime: null, remainingAmount: null, tokenType: null },
    ]);
  });
});
