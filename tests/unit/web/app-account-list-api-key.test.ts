import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const appSourcePath = resolve(__dirname, "../../../web/src/App.tsx");

describe("dashboard Codex account list wiring", () => {
  it("passes the current proxy API key to AccountList for Codex CLI mutations", () => {
    const source = readFileSync(appSourcePath, "utf-8");
    const start = source.indexOf("<AccountList");
    const end = source.indexOf("/>", start);
    const accountListBlock = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(accountListBlock).toContain("apiKey={status.apiKey}");
  });
});
