import { describe, expect, it } from "vitest";
import { UsageStatsStore } from "@src/auth/usage-stats.js";

describe("UsageStatsStore provider/model aggregation", () => {
  it("records external provider usage with model and source metadata", () => {
    const store = new UsageStatsStore({
      load: () => ({ version: 1, snapshots: [] }),
      save: () => {},
    });

    store.recordExternalUsage("gemini-3.1-pro", { input_tokens: 4, output_tokens: 6 }, "gemini-oauth", "gemini:g1");
    const summary = store.getExternalUsageSummary();

    expect(summary.models?.["gemini-3.1-pro"]).toEqual({
      input_tokens: 4,
      output_tokens: 6,
      request_count: 1,
    });
    expect(summary.sources?.["gemini:g1"].request_count).toBe(1);
  });
});
