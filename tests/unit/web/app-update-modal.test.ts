import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const appSourcePath = resolve(__dirname, "../../../web/src/App.tsx");

describe("dashboard update modal", () => {
  it("does not auto-open the update modal when startup status reports an update", () => {
    const source = readFileSync(appSourcePath, "utf-8");

    expect(source).not.toMatch(/useEffect\(\(\) => \{[\s\S]*setShowModal\(true\)[\s\S]*update\.hasUpdate/);
  });

  it("imports the footer component before rendering it", () => {
    const source = readFileSync(appSourcePath, "utf-8");

    expect(source).toContain('import { Footer } from "./components/Footer";');
    expect(source).toContain("<Footer updateStatus={update.status} />");
  });
});
