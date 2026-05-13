import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

function readLauncher(name: string): string {
  return readFileSync(resolve(process.cwd(), "bin", name), "utf-8");
}

describe("Claude Code launcher scripts", () => {
  it.each(["cc-codex", "cc-gemini"])("%s uses the proxy origin as ANTHROPIC_BASE_URL", (name) => {
    const script = readLauncher(name);

    expect(script).toContain('BASE_URL="http://localhost:$PORT"');
    expect(script).not.toContain('BASE_URL="http://localhost:$PORT/v1"');
  });

  it.each(["cc-codex", "cc-gemini"])("%s checks the actual health endpoint", (name) => {
    const script = readLauncher(name);

    expect(script).toContain('curl -s "http://localhost:$PORT/health"');
    expect(script).not.toContain('curl -s "http://localhost:$PORT/admin/health"');
  });

  it("cc-gemini defaults Claude Code to bare mode", () => {
    const script = readLauncher("cc-gemini");

    expect(script).toContain("CC_GEMINI_BARE:-1");
    expect(script).toContain("CLAUDE_ARGS+=(--bare)");
    expect(script).toContain('claude "${CLAUDE_ARGS[@]}" "$@"');
  });

  it("cc-gemini pins every Claude Code model env to Gemini models", () => {
    const script = readLauncher("cc-gemini");

    expect(script).toContain('export ANTHROPIC_MODEL="${MODEL}[1m]"');
    expect(script).toContain('export ANTHROPIC_DEFAULT_SONNET_MODEL="${MODEL}[1m]"');
    expect(script).toContain('export ANTHROPIC_DEFAULT_OPUS_MODEL="${MODEL}[1m]"');
    expect(script).toContain('export ANTHROPIC_SMALL_FAST_MODEL="gemini-3.1-flash-lite[1m]"');
    expect(script).toContain('export ANTHROPIC_DEFAULT_HAIKU_MODEL="gemini-3.1-flash-lite[1m]"');
  });

  it("cc-gemini auto-applies a default proxy Gemini account when CLI auth drifts", () => {
    const script = readLauncher("cc-gemini");

    expect(script).toContain("CC_GEMINI_SYNC_CLI_AUTH:-1");
    expect(script).toContain("/auth/gemini/cli-auth");
    expect(script).toContain("/auth/gemini/cli-auth/apply-default");
  });
});
