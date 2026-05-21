import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const SOURCE = readFileSync(
  resolve(__dirname, "../../../web/src/components/AddAccount.tsx"),
  "utf-8",
);
const APP_SOURCE = readFileSync(
  resolve(__dirname, "../../../web/src/App.tsx"),
  "utf-8",
);

describe("AddAccount provider chooser", () => {
  it("shows only the Codex choice before starting OAuth", () => {
    expect(SOURCE).toContain("onStartCodex");
    expect(SOURCE).toContain(">Codex<");
    expect(SOURCE).toContain(">Codex<");
  });

  it("wires the dashboard add dialog to the Codex account flow", () => {
    expect(APP_SOURCE).toContain("const [showAdd, setShowAdd]");
    expect(APP_SOURCE).toContain("const [addProvider, setAddProvider]");
    expect(APP_SOURCE).toContain("visible={showAdd || accounts.addVisible}");
    expect(APP_SOURCE).toContain("provider={addProvider}");
    expect(APP_SOURCE).toContain("onChooseProvider={setAddProvider}");
    expect(APP_SOURCE).toContain("onStartCodex={accounts.startAdd}");
    expect(APP_SOURCE).toContain("onStartCodex={accounts.startAdd}");
  });
});
