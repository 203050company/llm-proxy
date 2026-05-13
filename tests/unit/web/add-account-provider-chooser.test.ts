import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const SOURCE = readFileSync(
  resolve(__dirname, "../../../web/src/components/AddAccount.tsx"),
  "utf-8",
);

describe("AddAccount provider chooser", () => {
  it("shows Codex and Gemini choices before starting OAuth", () => {
    expect(SOURCE).toContain("onStartCodex");
    expect(SOURCE).toContain("onStartGemini");
    expect(SOURCE).toContain(">Codex<");
    expect(SOURCE).toContain(">Gemini<");
  });
});
