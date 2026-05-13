import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import type { Account } from "../../../shared/types";
import { buildAccountQuotaSections } from "../../../web/src/components/account-card-quota";

const PUBLIC_DIR = resolve(__dirname, "../../../public");
const ASSETS_DIR = resolve(PUBLIC_DIR, "assets");

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: "acct_1",
    email: "user@example.com",
    status: "active",
    ...overrides,
  };
}

describe("buildAccountQuotaSections", () => {
  it("shows an unavailable 5h section for active accounts without quota data", () => {
    expect(buildAccountQuotaSections(makeAccount())).toEqual([
      {
        kind: "primary",
        labelKey: "current5hUsage",
        percentage: null,
        resetAt: null,
        state: "unavailable",
      },
    ]);
  });

  it("includes both 5h and weekly sections when both quota windows are present", () => {
    expect(buildAccountQuotaSections(makeAccount({
      quota: {
        rate_limit: { used_percent: 42.4, reset_at: 1_700_000_000, limit_reached: false },
        secondary_rate_limit: { used_percent: 73.2, reset_at: 1_700_500_000, limit_reached: false },
      },
    }))).toEqual([
      {
        kind: "primary",
        labelKey: "current5hUsage",
        percentage: 42,
        resetAt: 1_700_000_000,
        state: "used",
      },
      {
        kind: "secondary",
        labelKey: "weeklyUsage",
        percentage: 73,
        resetAt: 1_700_500_000,
        state: "used",
      },
    ]);
  });

  it("omits the 5h section for free accounts", () => {
    expect(buildAccountQuotaSections(makeAccount({
      planType: "free",
      quota: {
        rate_limit: { used_percent: 42.4, reset_at: 1_700_000_000, limit_reached: false },
        secondary_rate_limit: { used_percent: 73.2, reset_at: 1_700_500_000, limit_reached: false },
      },
    }))).toEqual([
      {
        kind: "secondary",
        labelKey: "weeklyUsage",
        percentage: 73,
        resetAt: 1_700_500_000,
        state: "used",
      },
    ]);
  });

  it("uses the primary weekly window for free accounts", () => {
    expect(buildAccountQuotaSections(makeAccount({
      planType: "free",
      quota: {
        rate_limit: {
          used_percent: 10,
          reset_at: 1_700_500_000,
          limit_reached: false,
          limit_window_seconds: 604800,
        },
        secondary_rate_limit: {
          used_percent: 0,
          reset_at: null,
          limit_reached: false,
          limit_window_seconds: null,
        },
      },
    }))).toEqual([
      {
        kind: "secondary",
        labelKey: "weeklyUsage",
        percentage: 10,
        resetAt: 1_700_500_000,
        state: "used",
      },
    ]);
  });

  it("omits the weekly section when only the primary quota exists", () => {
    expect(buildAccountQuotaSections(makeAccount({
      quota: {
        rate_limit: { used_percent: 12, reset_at: 1_700_000_000, limit_reached: false },
        secondary_rate_limit: null,
      },
    }))).toHaveLength(1);
  });

  it("marks exhausted quota windows as limit reached", () => {
    expect(buildAccountQuotaSections(makeAccount({
      quota: {
        rate_limit: { used_percent: null, reset_at: 1_700_000_000, limit_reached: true },
      },
    }))[0]).toEqual({
      kind: "primary",
      labelKey: "current5hUsage",
      percentage: 100,
      resetAt: 1_700_000_000,
      state: "limit_reached",
    });
  });

  it("marks the 5h section as limit reached when the weekly limit is reached", () => {
    expect(buildAccountQuotaSections(makeAccount({
      status: "rate_limited",
      quota: {
        rate_limit: { used_percent: 1, reset_at: 1_700_000_000, limit_reached: false },
        secondary_rate_limit: { used_percent: 100, reset_at: 1_700_500_000, limit_reached: true },
      },
    }))).toEqual([
      {
        kind: "primary",
        labelKey: "current5hUsage",
        percentage: 100,
        resetAt: 1_700_500_000,
        state: "limit_reached",
      },
      {
        kind: "secondary",
        labelKey: "weeklyUsage",
        percentage: 100,
        resetAt: 1_700_500_000,
        state: "limit_reached",
      },
    ]);
  });
});

describe("AccountCard quota labels in build output", () => {
  let js = "";

  beforeAll(() => {
    if (!existsSync(ASSETS_DIR)) {
      throw new Error("public/assets/ not found — run `npm run build` first");
    }
    const jsFile = readdirSync(ASSETS_DIR).find((f) => f.endsWith(".js"));
    if (!jsFile) {
      throw new Error("No JS file in public/assets/ — run `npm run build` first");
    }
    js = readFileSync(resolve(ASSETS_DIR, jsFile), "utf-8");
  });

  it("includes the new /status-style quota labels", () => {
    expect(js).toContain("Current 5h Usage");
    expect(js).toContain("Weekly Usage");
    expect(js).toContain("No quota data");
  });
});
