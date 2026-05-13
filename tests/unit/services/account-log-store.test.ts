import { describe, expect, it } from "vitest";
import { AccountLogStore } from "@src/services/account-log-store.js";

describe("AccountLogStore", () => {
  it("appends and lists account logs with process-local sequence cursors", () => {
    const store = new AccountLogStore();

    const first = store.append("acct-1", {
      category: "proxy",
      level: "info",
      eventType: "proxy.request_started",
      requestId: "req-1",
    });
    const second = store.append("acct-1", {
      category: "auth",
      level: "warn",
      eventType: "auth.refresh.failed_transient",
      message: "temporary failure",
    });

    const result = store.list("acct-1");

    expect(result.logs).toEqual([first, second]);
    expect(result.nextSince).toBe(second.seq);
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
  });

  it("filters by since, level, and category", () => {
    const store = new AccountLogStore();
    const info = store.append("acct-1", {
      category: "proxy",
      level: "info",
      eventType: "proxy.request_started",
    });
    store.append("acct-1", {
      category: "auth",
      level: "warn",
      eventType: "auth.refresh.retry_scheduled",
    });
    const error = store.append("acct-1", {
      category: "proxy",
      level: "error",
      eventType: "proxy.request_error",
    });

    expect(store.list("acct-1", { since: info.seq }).logs.map((log) => log.eventType)).toEqual([
      "auth.refresh.retry_scheduled",
      "proxy.request_error",
    ]);
    expect(store.list("acct-1", { level: "error" }).logs).toEqual([error]);
    expect(store.list("acct-1", { category: "auth" }).logs.map((log) => log.eventType)).toEqual([
      "auth.refresh.retry_scheduled",
    ]);
  });

  it("applies per-account limit", () => {
    const store = new AccountLogStore({ perAccountLimit: 2 });

    store.append("acct-1", { category: "proxy", level: "info", eventType: "proxy.first" });
    const second = store.append("acct-1", { category: "proxy", level: "info", eventType: "proxy.second" });
    const third = store.append("acct-1", { category: "proxy", level: "info", eventType: "proxy.third" });

    expect(store.list("acct-1", { limit: 10 }).logs).toEqual([second, third]);
  });

  it("applies global limit across accounts", () => {
    const store = new AccountLogStore({ perAccountLimit: 10, globalLimit: 3 });

    store.append("acct-1", { category: "proxy", level: "info", eventType: "proxy.a1" });
    const acct2First = store.append("acct-2", { category: "proxy", level: "info", eventType: "proxy.b1" });
    const acct1Second = store.append("acct-1", { category: "proxy", level: "info", eventType: "proxy.a2" });
    const acct2Second = store.append("acct-2", { category: "auth", level: "info", eventType: "auth.refresh.scheduled" });

    expect(store.list("acct-1", { limit: 10 }).logs).toEqual([acct1Second]);
    expect(store.list("acct-2", { limit: 10 }).logs).toEqual([acct2First, acct2Second]);
  });

  it("clears one account or all accounts", () => {
    const store = new AccountLogStore();
    store.append("acct-1", { category: "proxy", level: "info", eventType: "proxy.request_started" });
    store.append("acct-2", { category: "auth", level: "info", eventType: "auth.refresh.scheduled" });

    store.clear("acct-1");

    expect(store.list("acct-1").logs).toEqual([]);
    expect(store.list("acct-2").logs).toHaveLength(1);

    store.clearAll();

    expect(store.list("acct-2").logs).toEqual([]);
  });

  it("sanitizes request ids and messages before storing", () => {
    const store = new AccountLogStore();
    const event = store.append("acct-1", {
      category: "auth",
      level: "error",
      eventType: "auth.refresh.failed_permanent",
      requestId: "req-1\nAuthorization: Bearer secret",
      message: "Authorization=Bearer abc123 refresh_token=oaistb_rt_secret cookie=sessionid",
    });

    expect(event.requestId).toBe("req-1Authorization:Bearersecret");
    expect(event.message).toContain("Authorization=[REDACTED]");
    expect(event.message).toContain("refresh_token=[REDACTED]");
    expect(event.message).toContain("cookie=[REDACTED]");
    expect(event.message).not.toContain("oaistb_rt_secret");
  });
});
