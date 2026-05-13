import { readFileSync } from "fs";
import { resolve } from "path";
import vm from "vm";
import { describe, expect, it } from "vitest";

describe("native addon loader", () => {
  it("loads the Linux x64 native binding when it exists", () => {
    const source = readFileSync(resolve("native/index.js"), "utf-8");
    const fakeBinding = {
      httpGet: () => undefined,
      httpPost: () => undefined,
      httpPostStream: () => undefined,
    };
    const module = { exports: {} as Record<string, unknown> };

    const fakeRequire = (id: string) => {
      if (id === "fs") {
        return {
          existsSync: (path: string) => path.endsWith("codex-tls.linux-x64-gnu.node"),
        };
      }
      if (id === "path") {
        return {
          join: (...parts: string[]) => parts.join("/"),
        };
      }
      if (id.endsWith("codex-tls.linux-x64-gnu.node")) {
        return fakeBinding;
      }
      throw new Error(`unexpected require: ${id}`);
    };

    vm.runInNewContext(source, {
      require: fakeRequire,
      module,
      exports: module.exports,
      process: { platform: "linux", arch: "x64" },
      __dirname: "/native",
      console: { warn: () => undefined },
    });

    expect(module.exports.httpGet).toBe(fakeBinding.httpGet);
    expect(module.exports.httpPost).toBe(fakeBinding.httpPost);
    expect(module.exports.httpPostStream).toBe(fakeBinding.httpPostStream);
  });
});
