import { readFileSync, statSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

function readLauncher(name: string): string {
  return readFileSync(resolve(process.cwd(), "bin", name), "utf-8");
}

describe("Claude Code launcher scripts", () => {
  it.each([
    ["cc-codex", 'BASE_URL="http://127.0.0.1:$PORT"'],
    ["cc-gemini", 'BASE_URL="http://127.0.0.1:$PORT"'],
    ["cc-opencode", 'BASE_URL="${CC_OPENCODE_BASE_URL:-http://127.0.0.1:$PORT}"'],
  ])("%s uses the proxy origin as ANTHROPIC_BASE_URL", (name, expectedBaseUrl) => {
    const script = readLauncher(name);

    expect(script).toContain(expectedBaseUrl);
    expect(script).not.toContain("$PORT/v1");
  });

  it.each(["cc-codex", "cc-gemini", "cc-opencode"])("%s checks the actual health endpoint", (name) => {
    const script = readLauncher(name);

    expect(script).toContain('curl -s "$BASE_URL/health"');
    expect(script).not.toContain('curl -s "$BASE_URL/admin/health"');
  });

  it("cc-gemini keeps bare mode opt-in", () => {
    const script = readLauncher("cc-gemini");

    expect(script).toContain("CC_GEMINI_BARE:-0");
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

  it.each([
    ["cc-codex", "codex"],
    ["cc-gemini", "gemini"],
  ])("%s uses a proxy-specific Claude config dir for every invocation", (name, namespace) => {
    const script = readLauncher(name);

    expect(script).toContain(`local agent_config_dir=\"$HOME/.claude-agent-view/${namespace}\"`);
    expect(script).toContain("export CLAUDE_CONFIG_DIR");
    expect(script).toContain('CLAUDE_CONFIG_DIR="$(prepare_agent_view_config)"');
    expect(script).not.toContain('if [ "${1:-}" = "agents" ]; then');
  });

  it("cc-opencode uses one shared Agent View config dir for every OpenCode model", () => {
    const script = readLauncher("cc-opencode");

    expect(script).toContain('local agent_config_dir="${CC_OPENCODE_CONFIG_DIR:-$HOME/.claude-agent-view/opencode-go/all}"');
    expect(script).toContain("export CLAUDE_CONFIG_DIR");
    expect(script).toContain('CLAUDE_CONFIG_DIR="$(prepare_agent_view_config)"');
    expect(script).not.toContain("opencode-go/$model_slug");
  });

  it("cc-opencode defaults Agent View-created sessions to Kimi", () => {
    const script = readLauncher("cc-opencode");

    expect(script).toContain('DEFAULT_MODEL="opencode-kimi-k2.7"');
    expect(script).toContain('AGENT_MODEL="${CC_OPENCODE_AGENT_MODEL:-$DEFAULT_MODEL}"');
    expect(script).toContain('ANTHROPIC_MODEL="$AGENT_MODEL"');
    expect(script).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL="$AGENT_MODEL"');
    expect(script).toContain('ANTHROPIC_DEFAULT_SONNET_MODEL="$AGENT_MODEL"');
    expect(script).toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL="$AGENT_MODEL"');
    expect(script).toContain('ANTHROPIC_SMALL_FAST_MODEL="$AGENT_MODEL"');
  });

  it("cc-opencode lets terminal sessions choose an OpenCode model without changing the Agent View group", () => {
    const script = readLauncher("cc-opencode");

    expect(script).toContain('MODEL="${CC_OPENCODE_MODEL:-$DEFAULT_MODEL}"');
    expect(script).toContain('case "$1" in');
    expect(script).toContain('MODEL="${1:-}"');
    expect(script).toContain('--model "$MODEL"');
    expect(script).toContain('CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR"');
  });

  it("cc-opencode agents ignores CC_OPENCODE_MODEL and uses the Agent View default model", () => {
    const script = readLauncher("cc-opencode");

    expect(script).toContain('if [[ "${1:-}" == "agents" ]]; then');
    expect(script).toContain('ANTHROPIC_MODEL="$AGENT_MODEL"');
    expect(script).not.toContain('ANTHROPIC_MODEL="$MODEL"');
  });

  it("package metadata exposes cc-opencode as a first-class launcher", () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf-8")) as {
      bin: Record<string, string>;
    };
    const packageLock = JSON.parse(readFileSync(resolve(process.cwd(), "package-lock.json"), "utf-8")) as {
      packages: Record<string, { bin?: Record<string, string> }>;
    };
    const mode = statSync(resolve(process.cwd(), "bin", "cc-opencode")).mode;

    expect(packageJson.bin["cc-opencode"]).toBe("bin/cc-opencode");
    expect(packageLock.packages[""].bin?.["cc-opencode"]).toBe("bin/cc-opencode");
    expect(mode & 0o111).not.toBe(0);
  });
});
