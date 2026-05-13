import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve } from "path";

const PUBLIC_DIR = resolve(__dirname, "../../../public");
const ASSETS_DIR = resolve(PUBLIC_DIR, "assets");

const LIST_ITEM_SOURCE = resolve(__dirname, "../../../web/src/components/AccountOverviewListItem.tsx");
const CARD_SOURCE = resolve(__dirname, "../../../web/src/components/AccountCard.tsx");
const LOG_PANEL_SOURCE = resolve(__dirname, "../../../web/src/components/AccountLogPanel.tsx");
const ACCOUNT_LIST_SOURCE = resolve(__dirname, "../../../web/src/components/AccountList.tsx");

let js = "";
let listItemSource = "";
let cardSource = "";
let logPanelSource = "";
let accountListSource = "";

beforeAll(() => {
  if (!existsSync(ASSETS_DIR)) {
    throw new Error("public/assets/ not found — run `npm run build` first");
  }
  const jsFile = readdirSync(ASSETS_DIR).find((f) => f.endsWith(".js"));
  if (!jsFile) {
    throw new Error("No JS file in public/assets/ — run `npm run build` first");
  }
  js = readFileSync(resolve(ASSETS_DIR, jsFile), "utf-8");
  listItemSource = readFileSync(LIST_ITEM_SOURCE, "utf-8");
  cardSource = readFileSync(CARD_SOURCE, "utf-8");
  logPanelSource = readFileSync(LOG_PANEL_SOURCE, "utf-8");
  accountListSource = readFileSync(ACCOUNT_LIST_SOURCE, "utf-8");
});

describe("account overview view mode", () => {
  it("includes grid/list view labels in the built dashboard", () => {
    expect(js).toContain("Grid view");
    expect(js).toContain("List view");
  });

  it("defaults the account overview to list view unless grid is saved", () => {
    expect(accountListSource).toContain('return saved === "grid" ? "grid" : "list";');
  });

  it("places the grid/list toggle after the filter and expired refresh actions", () => {
    const viewToggleIndex = accountListSource.indexOf('aria-label={t("gridView")}');
    const statusFilterIndex = accountListSource.indexOf('{/* Status filter dropdown */}');
    const refreshExpiredIndex = accountListSource.indexOf('{/* Refresh expired tokens */}');

    expect(statusFilterIndex).toBeGreaterThan(-1);
    expect(refreshExpiredIndex).toBeGreaterThan(-1);
    expect(viewToggleIndex).toBeGreaterThan(refreshExpiredIndex);
    expect(viewToggleIndex).toBeGreaterThan(statusFilterIndex);
  });

  it("includes compact usage labels required by list view", () => {
    expect(js).toContain("Auth Status");
    expect(js).toContain("Current 5h Usage");
    expect(js).toContain("Weekly Usage");
  });

  it("uses border emphasis instead of a hover background for list rows", () => {
    expect(listItemSource).toContain("hover:border-primary/30");
    expect(listItemSource).not.toContain("hover:bg-slate-50");
  });

  it("uses high-contrast dark surfaces for account log panels", () => {
    expect(logPanelSource).toContain("dark:bg-[#0f1720]");
    expect(logPanelSource).toContain("dark:bg-card-dark");
    expect(logPanelSource).not.toContain("dark:bg-bg-dark/60");
    expect(logPanelSource).not.toContain("dark:hover:bg-border-dark");
  });

  it("prefills account name editors with the current display name", () => {
    expect(listItemSource).toContain("account.label || email");
    expect(listItemSource).toContain("setLabelDraft(account.label || email)");
    expect(cardSource).toContain("account.label || email");
    expect(cardSource).toContain("setLabelDraft(account.label || email)");
  });
});
