import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { importCliAuth } from "@src/auth/oauth-pkce.js";

describe("importCliAuth", () => {
  let tempRoot: string;
  let originalCwd: string;
  let originalCodexHome: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "codex-proxy-import-cli-"));
    originalCwd = process.cwd();
    originalCodexHome = process.env.CODEX_HOME;
    process.chdir(tempRoot);
  });

  afterEach(() => {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
    process.chdir(originalCwd);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("reads nested tokens from CODEX_HOME/auth.json", () => {
    const codexHome = join(tempRoot, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
      tokens: {
        access_token: "access-from-tokens",
        refresh_token: "refresh-from-tokens",
        id_token: "id-from-tokens",
      },
    }));
    process.env.CODEX_HOME = codexHome;

    expect(importCliAuth()).toEqual({
      access_token: "access-from-tokens",
      refresh_token: "refresh-from-tokens",
      id_token: "id-from-tokens",
    });
  });

  it("falls back to data/codex-home/auth.json when CODEX_HOME auth is absent", () => {
    process.env.CODEX_HOME = join(tempRoot, "missing-codex-home");
    const fallbackDir = join(tempRoot, "data", "codex-home");
    mkdirSync(fallbackDir, { recursive: true });
    writeFileSync(join(fallbackDir, "auth.json"), JSON.stringify({
      access_token: "fallback-access",
      refresh_token: "fallback-refresh",
    }));

    expect(importCliAuth()).toEqual({
      access_token: "fallback-access",
      refresh_token: "fallback-refresh",
    });
  });
});
