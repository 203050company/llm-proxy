import { describe, expect, it } from "vitest";
import {
  buildGeminiModelUsageRows,
  getVisibleGeminiModelUsageRows,
} from "../../../web/src/components/gemini-model-usage";

describe("buildGeminiModelUsageRows", () => {
  it("sorts Gemini usage rows with newest models first", () => {
    const rows = buildGeminiModelUsageRows({
      models: [
        "gemini-2.5-pro",
        "gemini-3.1-flash-lite",
        "gemini-3-pro",
        "gemini-3.1-pro",
        "gemini-2.5-flash",
      ],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        request_count: 0,
        models: {},
      },
      quota: {
        modelBuckets: [
          { modelId: "gemini-2.5-pro", remainingFraction: 0.1, resetTime: null, remainingAmount: null, tokenType: null },
          { modelId: "gemini-3.1-flash-lite", remainingFraction: 0.2, resetTime: null, remainingAmount: null, tokenType: null },
          { modelId: "gemini-3-pro", remainingFraction: 0.3, resetTime: null, remainingAmount: null, tokenType: null },
          { modelId: "gemini-3.1-pro", remainingFraction: 0.4, resetTime: null, remainingAmount: null, tokenType: null },
          { modelId: "gemini-2.5-flash", remainingFraction: 0.5, resetTime: null, remainingAmount: null, tokenType: null },
        ],
      },
    });

    expect(rows.map((row) => row.model)).toEqual([
      "gemini-3.1-pro",
      "gemini-3.1-flash-lite",
      "gemini-3-pro",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
    ]);
  });

  it("keeps quota usage separate for each Gemini model", () => {
    const rows = buildGeminiModelUsageRows({
      models: ["gemini-3.1-pro", "gemini-3.1-flash-lite"],
      usage: {
        input_tokens: 130,
        output_tokens: 70,
        request_count: 5,
        models: {
          "gemini-3.1-pro": { input_tokens: 100, output_tokens: 50, request_count: 3 },
          "gemini-3.1-flash-lite": { input_tokens: 30, output_tokens: 20, request_count: 2 },
        },
      },
      quota: {
        modelBuckets: [
          { modelId: "gemini-3.1-pro", remainingFraction: 0.25, resetTime: "2026-05-11T12:00:00Z", remainingAmount: null, tokenType: null },
          { modelId: "gemini-3.1-flash-lite", remainingFraction: 0.9, resetTime: null, remainingAmount: null, tokenType: null },
        ],
      },
    });

    expect(rows.map((row) => ({
      model: row.model,
      totalTokens: row.totalTokens,
      quotaUsedPercent: row.quotaUsedPercent,
      graphPercent: row.graphPercent,
    }))).toEqual([
      { model: "gemini-3.1-pro", totalTokens: 150, quotaUsedPercent: 75, graphPercent: 75 },
      { model: "gemini-3.1-flash-lite", totalTokens: 50, quotaUsedPercent: 10, graphPercent: 10 },
    ]);
  });

  it("falls back to token share when quota data is unavailable", () => {
    const rows = buildGeminiModelUsageRows({
      models: ["gemini-3.1-pro", "gemini-3.1-flash-lite"],
      usage: {
        input_tokens: 80,
        output_tokens: 20,
        request_count: 2,
        models: {
          "gemini-3.1-pro": { input_tokens: 40, output_tokens: 10, request_count: 1 },
          "gemini-3.1-flash-lite": { input_tokens: 40, output_tokens: 10, request_count: 1 },
        },
      },
    });

    expect(rows.map((row) => ({ model: row.model, tokenSharePercent: row.tokenSharePercent, graphPercent: row.graphPercent }))).toEqual([
      { model: "gemini-3.1-pro", tokenSharePercent: 50, graphPercent: 50 },
      { model: "gemini-3.1-flash-lite", tokenSharePercent: 50, graphPercent: 50 },
    ]);
  });

  it("does not show unavailable free-tier Pro buckets as fully used", () => {
    const rows = buildGeminiModelUsageRows({
      models: ["gemini-3.1-pro", "gemini-3.1-flash-lite"],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        request_count: 0,
        models: {},
      },
      quota: {
        modelBuckets: [
          { modelId: "gemini-3.1-pro-preview", remainingFraction: 0, resetTime: "1970-01-01T00:00:00Z", remainingAmount: null, tokenType: "REQUESTS" },
          { modelId: "gemini-3.1-flash-lite-preview", remainingFraction: 1, resetTime: "2026-05-12T07:58:13Z", remainingAmount: null, tokenType: "REQUESTS" },
        ],
      },
    });

    expect(rows.map((row) => ({ model: row.model, hasQuota: row.hasQuota, graphPercent: row.graphPercent }))).toEqual([
      { model: "gemini-3.1-pro", hasQuota: false, graphPercent: 0 },
      { model: "gemini-3.1-flash-lite-preview", hasQuota: true, graphPercent: 0 },
      { model: "gemini-3.1-flash-lite", hasQuota: false, graphPercent: 0 },
    ]);
  });

  it("limits visible model rows for compact account columns", () => {
    const rows = buildGeminiModelUsageRows({
      usage: {
        input_tokens: 100,
        output_tokens: 0,
        request_count: 4,
        models: {
          "gemini-3.1-pro": { input_tokens: 40, output_tokens: 0, request_count: 1 },
          "gemini-3.1-flash": { input_tokens: 30, output_tokens: 0, request_count: 1 },
          "gemini-3.1-flash-lite": { input_tokens: 20, output_tokens: 0, request_count: 1 },
          "gemini-3-pro": { input_tokens: 10, output_tokens: 0, request_count: 1 },
        },
      },
    });

    const compact = getVisibleGeminiModelUsageRows(rows, 3);

    expect(compact.visible.map((row) => row.model)).toEqual([
      "gemini-3.1-pro",
      "gemini-3.1-flash",
      "gemini-3.1-flash-lite",
    ]);
    expect(compact.hiddenCount).toBe(1);
  });

  it("shows aggregate usage when model-level usage is unavailable", () => {
    const rows = buildGeminiModelUsageRows({
      usage: {
        input_tokens: 120,
        output_tokens: 30,
        request_count: 3,
        models: {},
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      model: "All Gemini models",
      inputTokens: 120,
      outputTokens: 30,
      requestCount: 3,
      totalTokens: 150,
      graphPercent: 100,
      hasQuota: false,
    });
  });
});
