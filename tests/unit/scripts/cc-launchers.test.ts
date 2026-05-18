import { execFileSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { describe, expect, it } from "vitest";

function readLauncher(name: string): string {
  return readFileSync(resolve(process.cwd(), "bin", name), "utf-8");
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function runCcOpencode(args: string[], env: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "cc-opencode-"));
  const home = join(root, "home");
  const binDir = join(root, "bin");
  const claudeBinDir = join(home, ".claude", "bin");

  mkdirSync(binDir, { recursive: true });
  mkdirSync(claudeBinDir, { recursive: true });

  writeExecutable(join(binDir, "curl"), "#!/bin/bash\nexit 0\n");
  writeExecutable(join(binDir, "docker"), "#!/bin/bash\necho unexpected docker >&2\nexit 99\n");
  writeExecutable(
    join(binDir, "claude"),
    [
      "#!/bin/bash",
      'printf "CLAUDE_CONFIG_DIR=%s\\n" "$CLAUDE_CONFIG_DIR"',
      'printf "ANTHROPIC_AUTH_TOKEN=%s\\n" "${ANTHROPIC_AUTH_TOKEN:-}"',
      'printf "ANTHROPIC_BASE_URL=%s\\n" "${ANTHROPIC_BASE_URL:-}"',
      'printf "ANTHROPIC_MODEL=%s\\n" "${ANTHROPIC_MODEL:-}"',
      'printf "ANTHROPIC_DEFAULT_OPUS_MODEL=%s\\n" "${ANTHROPIC_DEFAULT_OPUS_MODEL:-}"',
      'printf "ANTHROPIC_DEFAULT_SONNET_MODEL=%s\\n" "${ANTHROPIC_DEFAULT_SONNET_MODEL:-}"',
      'printf "ANTHROPIC_DEFAULT_HAIKU_MODEL=%s\\n" "${ANTHROPIC_DEFAULT_HAIKU_MODEL:-}"',
      'printf "ANTHROPIC_SMALL_FAST_MODEL=%s\\n" "${ANTHROPIC_SMALL_FAST_MODEL:-}"',
      'printf "CC_OPENCODE_MODEL=%s\\n" "${CC_OPENCODE_MODEL:-}"',
      'printf "CC_OPENCODE_AGENT_MODEL=%s\\n" "${CC_OPENCODE_AGENT_MODEL:-}"',
      'printf "ARGS=%s\\n" "$*"',
      "",
    ].join("\n"),
  );
  writeExecutable(join(claudeBinDir, "codex-proxy-api-key.sh"), "#!/bin/bash\nprintf fake-key\n");

  try {
    return execFileSync(resolve(process.cwd(), "bin", "cc-opencode"), args, {
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HOME: home,
        ...env,
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

  it.each([
    ["cc-codex", 'curl -s "$BASE_URL/health"'],
    ["cc-gemini", 'curl -s "$BASE_URL/health"'],
    ["cc-opencode", 'curl -fsS "$BASE_URL/health"'],
  ])("%s checks the actual health endpoint", (name, expectedHealthCheck) => {
    const script = readLauncher(name);

    expect(script).toContain(expectedHealthCheck);
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

  it("cc-opencode hard-pins Agent View-created sessions to Kimi", () => {
    const script = readLauncher("cc-opencode");

    expect(script).toContain('DEFAULT_MODEL="opencode-kimi-k2.6"');
    expect(script).toContain('AGENT_MODEL="$DEFAULT_MODEL"');
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
    expect(script).toContain('ANTHROPIC_MODEL="$MODEL"');
    expect(script).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL="$MODEL"');
    expect(script).toContain('ANTHROPIC_DEFAULT_SONNET_MODEL="$MODEL"');
    expect(script).toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL="$MODEL"');
    expect(script).toContain('ANTHROPIC_SMALL_FAST_MODEL="$MODEL"');
  });

  it("cc-opencode agents ignores terminal model selection and uses Kimi", () => {
    const script = readLauncher("cc-opencode");

    expect(script).toContain('if [[ "${1:-}" == "agents" ]]; then');
    expect(script).toContain('ANTHROPIC_MODEL="$AGENT_MODEL"');
    expect(script).toContain("-u CC_OPENCODE_MODEL");
    expect(script).toContain("-u CC_OPENCODE_AGENT_MODEL");
  });

  it("cc-opencode prevents Anthropic auth token leakage in every launch path", () => {
    const script = readLauncher("cc-opencode");

    expect(script.match(/-u ANTHROPIC_AUTH_TOKEN/g)).toHaveLength(2);
    expect(script).toContain('ANTHROPIC_API_KEY="$proxy_api_key"');
  });

  it("cc-opencode does not force dangerous permission skipping", () => {
    const script = readLauncher("cc-opencode");

    expect(script).not.toContain("--dangerously-skip-permissions");
  });

  it("cc-opencode terminal path passes the selected model through the proxy and clears launcher model env", () => {
    const output = runCcOpencode(["--model", "opencode-minimax-m2.7", "--print-shape"], {
      ANTHROPIC_AUTH_TOKEN: "real-token",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "gpt-5.5",
      CC_OPENCODE_MODEL: "opencode-qwen3.6-plus",
      CC_OPENCODE_AGENT_MODEL: "opencode-qwen3.6-plus",
    });

    expect(output).toContain("CLAUDE_CONFIG_DIR=");
    expect(output).toContain("/.claude-agent-view/opencode-go/all");
    expect(output).toContain("ANTHROPIC_AUTH_TOKEN=\n");
    expect(output).toContain("ANTHROPIC_BASE_URL=http://127.0.0.1:8080");
    expect(output).toContain("ANTHROPIC_MODEL=opencode-minimax-m2.7");
    expect(output).toContain("ANTHROPIC_DEFAULT_OPUS_MODEL=opencode-minimax-m2.7");
    expect(output).toContain("CC_OPENCODE_MODEL=\n");
    expect(output).toContain("CC_OPENCODE_AGENT_MODEL=\n");
    expect(output).toContain("ARGS=--settings ");
    expect(output).toContain(" --model opencode-minimax-m2.7 --print-shape");
    expect(output).not.toContain("--dangerously-skip-permissions");
  });

  it("cc-opencode agents path hard-pins Kimi and clears launcher model env", () => {
    const output = runCcOpencode(["agents"], {
      ANTHROPIC_AUTH_TOKEN: "real-token",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "gpt-5.5",
      CC_OPENCODE_MODEL: "opencode-minimax-m2.7",
      CC_OPENCODE_AGENT_MODEL: "opencode-qwen3.6-plus",
    });

    expect(output).toContain("/.claude-agent-view/opencode-go/all");
    expect(output).toContain("ANTHROPIC_AUTH_TOKEN=\n");
    expect(output).toContain("ANTHROPIC_BASE_URL=http://127.0.0.1:8080");
    expect(output).toContain("ANTHROPIC_MODEL=opencode-kimi-k2.6");
    expect(output).toContain("ANTHROPIC_DEFAULT_OPUS_MODEL=opencode-kimi-k2.6");
    expect(output).toContain("CC_OPENCODE_MODEL=\n");
    expect(output).toContain("CC_OPENCODE_AGENT_MODEL=\n");
    expect(output).toContain("ARGS=agents");
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
