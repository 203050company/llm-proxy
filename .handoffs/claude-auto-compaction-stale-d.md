# Handoff: Claude auto compaction stale daemon cleanup

**Generated**: 2026-05-19T06:24:19Z
**Branch**: worktree-handoff-auto-compaction
**Base Commit**: 392b38b
**Slug**: claude-auto-compaction-stale-d
**Session Marker**: 2026-05-19T06:24:19Z-5c2c
**Worktree**: /home/ber/llm-proxy/.claude/worktrees/handoff-auto-compaction
**Stash At Create**: 10
**Status**: In Progress

## Goal

Investigate why Claude Code sessions still show `Context limit reached · /clear to continue` after launcher changes intended to restore auto compaction. Preserve the root-cause evidence and next cleanup steps so a new session can safely finish without losing context.

This handoff was written from an isolated background worktree because the harness blocked writes to the shared checkout. The investigation evidence came from the original repo path `/home/ber/llm-proxy` on `main` at `a985ff1` (`WIP(launchers): keep Claude compaction enabled in wrappers`).

## Completed

- [x] Compared upstream `https://github.com/icebear0828/codex-proxy` against local `llm-proxy` for compaction-related settings.
- [x] Cloned upstream into `$CLAUDE_JOB_DIR/codex-proxy-upstream` and checked current upstream branch/commit: `dev` at `7efc5e2`.
- [x] Verified upstream has no `DISABLE_COMPACT` or `CLAUDE_CODE_MAX_CONTEXT_TOKENS` references.
- [x] Verified upstream `bin/` only tracks `bin/README.md`; custom `bin/cc-codex` and `bin/cc-opencode` are local/fork additions.
- [x] Verified upstream compaction support is server-side proxy routing for `/v1/responses/compact` to `/codex/responses/compact`, not Claude Code client env tuning.
- [x] Verified local config files no longer contain `DISABLE_COMPACT` or `CLAUDE_CODE_MAX_CONTEXT_TOKENS`:
  - `/home/ber/.claude/codex-proxy-settings.json`
  - `/home/ber/.claude/opencode-proxy-settings.json`
  - `/home/ber/.claude-agent-view/codex/settings.json`
  - `/home/ber/.claude-agent-view/opencode-go/all/settings.json`
- [x] Verified current local wrappers unset stale compaction env before launching child `claude`:
  - `bin/cc-codex`
  - `bin/cc-opencode`
- [x] Checked running process env and found many live Claude/daemon/MCP child processes still inheriting old values:
  - `DISABLE_COMPACT=1`
  - `CLAUDE_CODE_MAX_CONTEXT_TOKENS=400000`

## Not Yet Done

- [ ] Save/confirm any active work before killing Claude daemon/session processes.
- [ ] Stop/restart the Claude Code daemon and stale sessions that still carry `DISABLE_COMPACT=1`.
- [ ] Start a fresh `cc-codex`/`cc-opencode` session and verify the new process env no longer has `DISABLE_COMPACT` or `CLAUDE_CODE_MAX_CONTEXT_TOKENS`.
- [ ] In the fresh session, check `/context` or equivalent Claude Code status to confirm auto compaction is available again.
- [ ] If the symptom persists after daemon restart, inspect shell snapshots or parent launch environment for where the old vars are still injected.
- [ ] Clean up accidental QA/session-log artifacts from any WIP commits if automatic checkpointing included them.
- [ ] If this handoff needs to live in the primary checkout, copy it from the isolated worktree path to `/home/ber/llm-proxy/.handoffs/` after user approval or from a foreground/non-isolated session.

## Failed Approaches

- **Assuming file edits alone would fix active sessions**: The launchers and settings now remove the stale env, but `/proc` inspection showed already-running Claude/daemon processes still carry `DISABLE_COMPACT=1` and `CLAUDE_CODE_MAX_CONTEXT_TOKENS=400000`. Process env is fixed at process start, so existing sessions must be restarted.
- **Searching broad local Claude project logs with `rg`**: Searching `$HOME/.claude` and `$HOME/.claude-agent-view` without pruning project logs produced a 239.7MB result because JSONL transcripts contain old diffs and logs. Future searches should prune `projects/` and `jobs/` or target settings/scripts directly.
- **Trying to use `Read` on some markdown files**: The tool repeatedly sent an invalid empty `pages` parameter and failed with `Invalid pages parameter: ""`. Python file reads were used as a workaround for handoff-pro template/checklist reads.
- **Writing the handoff directly to the shared checkout from a background session**: The harness blocked the write with `This background session hasn't isolated its changes yet`. Entered worktree `handoff-auto-compaction` and wrote the handoff there.

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| Treat upstream as source-of-truth for original compaction behavior | Upstream contains no Claude Code env overrides, so any `DISABLE_COMPACT` behavior is local wrapper/config drift. |
| Do not kill stale Claude processes automatically | Killing daemon/session processes can lose active work and affect other parallel jobs. User confirmation is needed. |
| Focus next work on process restart and env verification | Code/config already appears fixed; the observed broken state lives in running process environments. |
| Keep cleanup as remaining work | User explicitly noted automatic checkpoints included QA artifacts/session logs and wanted cleanup recorded in handoff. |
| Write handoff in isolated worktree | Background session policy required isolation before filesystem writes. |

## Current State

**Working**: Local code and settings in the original checkout no longer intentionally inject compaction-disabling env. Focused launcher tests had previously passed after wrapper changes: `npx vitest run tests/unit/scripts/cc-launchers.test.ts` → 22 tests passed; `npx tsc --noEmit --pretty false` → exit 0; `npm run test:unit` → 191 files / 1988 tests passed.

**Broken**: Existing live Claude Code processes still show stale env in `/proc`:

```text
CLAUDE_CONFIG_DIR=/home/ber/.claude-agent-view/codex
ANTHROPIC_BASE_URL=http://127.0.0.1:8080
ANTHROPIC_MODEL=gpt-5.5-xhigh
CLAUDE_CODE_MAX_CONTEXT_TOKENS=400000
DISABLE_COMPACT=1
```

This explains why `Context limit reached · /clear to continue` can continue even after wrapper/config edits.

**Uncommitted Changes**: collect_context for this isolated worktree reported none. The original checkout collect_context earlier reported branch `main`, base commit `a985ff1`, ahead of `origin/main` by 26 commits, no uncommitted changes, and 10 stashes.

## Files to Know

| File | Why It Matters |
|------|----------------|
| `bin/cc-codex` | Local wrapper that now unsets `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and `DISABLE_COMPACT` before executing `claude`. |
| `bin/cc-opencode` | Local OpenCode wrapper; both normal and `agents` paths now unset stale compaction env. |
| `tests/unit/scripts/cc-launchers.test.ts` | Regression tests assert wrappers clear compaction-disabling env for child `claude`. |
| `/home/ber/.claude/codex-proxy-settings.json` | Proxy settings file; currently no stale compaction env entries. |
| `/home/ber/.claude/opencode-proxy-settings.json` | OpenCode proxy settings file; currently no stale compaction env entries. |
| `/home/ber/.claude-agent-view/codex/settings.json` | Agent View config used by local `cc-codex`; currently no stale compaction env entries. |
| `/home/ber/.claude-agent-view/opencode-go/all/settings.json` | Agent View config used by local `cc-opencode`; currently no stale compaction env entries. |
| `/home/ber/.claude/hooks/context-handoff-signal.py` | Warning hook only; it cannot compact mid-turn and uses context limit/threshold for warnings. |
| `src/proxy/codex-api.ts` | Proxy method for upstream compact endpoint. Upstream/local both support compact routing here. |
| `src/routes/responses.ts` | Registers `/v1/responses/compact`. This is server-side support, not the client auto-compact switch. |
| `.gitignore` | Upstream ignores all `bin/*` except README; local additionally tracks custom launcher(s). |
| `.handoffs/claude-auto-compaction-stale-d.md` | This handoff file in the isolated worktree. |

## Code Context

**Local launcher clears stale compaction env** (`bin/cc-codex`):

```bash
env \
    -u CLAUDE_CODE_MAX_CONTEXT_TOKENS \
    -u DISABLE_COMPACT \
    claude "$@"
```

**Local OpenCode launcher clears stale compaction env on both paths** (`bin/cc-opencode`):

```bash
env \
    -u ANTHROPIC_AUTH_TOKEN \
    -u CLAUDE_CODE_MAX_CONTEXT_TOKENS \
    -u DISABLE_COMPACT \
    ...
```

**Upstream compact route evidence**:

```text
src/proxy/codex-api.ts: POST /codex/responses/compact → { output: ResponseItem[] }
src/routes/responses.ts: app.post("/v1/responses/compact", compactHandler)
```

**Running process env check used**:

```bash
python3 - <<'PY'
from pathlib import Path
for proc in Path('/proc').iterdir():
    if not proc.name.isdigit():
        continue
    try:
        cmd=(proc/'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace').strip()
        if 'claude' not in cmd.lower():
            continue
        envb=(proc/'environ').read_bytes()
    except Exception:
        continue
    env={}
    for part in envb.split(b'\0'):
        if b'=' in part:
            k,v=part.split(b'=',1)
            ks=k.decode(errors='replace')
            if ks in {'DISABLE_COMPACT','CLAUDE_CODE_MAX_CONTEXT_TOKENS','HANDOFF_PRO_CONTEXT_LIMIT','HANDOFF_PRO_CONTEXT_THRESHOLD','CLAUDE_CONFIG_DIR','ANTHROPIC_BASE_URL','ANTHROPIC_MODEL'}:
                env[ks]=v.decode(errors='replace')
    print(f'PID={proc.name} CMD={cmd[:180]}')
    print(env)
PY
```

## Resume Instructions

1. **Confirm no active work will be lost before restart**: Ask the user whether it is safe to stop stale Claude daemon/session processes.
   - Expected: explicit user approval before killing any process.
   - If not approved: stop and tell the user to manually close/restart Claude Code sessions when ready.

2. **List stale processes again**: rerun the `/proc` env check above.
   - Expected: list of PIDs and commands still carrying `DISABLE_COMPACT=1` / `CLAUDE_CODE_MAX_CONTEXT_TOKENS=400000`.
   - If none remain: skip restart and move to fresh-session verification.

3. **Restart stale Claude daemon/session processes only after approval**.
   - Expected: old PIDs disappear; newly launched `claude` processes should not show either stale env var.
   - If processes respawn with the same env: inspect parent process, shell snapshot files under `/home/ber/.claude-agent-view/codex/shell-snapshots/`, and any launcher outside `bin/cc-codex` / `bin/cc-opencode`.

4. **Start a fresh proxy session through the wrapper**: use the normal user workflow for `cc-codex` or `cc-opencode`.
   - Expected: `/proc` env check for the new process shows no `DISABLE_COMPACT` and no `CLAUDE_CODE_MAX_CONTEXT_TOKENS`.
   - If stale vars still appear: search only targeted config/script paths, not transcript logs.

5. **Verify user-visible context behavior**: in the fresh session, check Claude Code context/compact status.
   - Expected: auto compaction should be enabled/default again; the session should no longer require `/clear` solely because `DISABLE_COMPACT=1` blocked compaction.
   - If `Context limit reached` persists: collect exact `/context` output and current process env, then investigate Claude Code version behavior.

6. **Cleanup checkpoint pollution**: inspect recent WIP commits and remove QA artifacts/session logs if automatic checkpointing included them.
   - Expected: product commits contain only intentional source/test/config changes, not generated QA artifacts or session transcript logs.
   - If unsure: use `git show --stat <commit>` and `git show --name-only <commit>` before rewriting or making cleanup commits.

7. **Move/copy this handoff if needed**: because this background session wrote from an isolated worktree, the file currently lives at `/home/ber/llm-proxy/.claude/worktrees/handoff-auto-compaction/.handoffs/claude-auto-compaction-stale-d.md`.
   - Expected: if the next session resumes in the primary checkout, copy the file to `/home/ber/llm-proxy/.handoffs/claude-auto-compaction-stale-d.md` only after user approval.
   - If staying in the worktree: resume directly from the worktree handoff path.

## Setup Required

- Network was used to clone `https://github.com/icebear0828/codex-proxy` into `$CLAUDE_JOB_DIR/codex-proxy-upstream`; this temp clone may be cleaned when the job is deleted.
- Primary repo path: `/home/ber/llm-proxy`.
- Isolated handoff worktree path: `/home/ber/llm-proxy/.claude/worktrees/handoff-auto-compaction`.
- Current date: 2026-05-19.
- Any process-kill or daemon restart is user-visible and should be confirmed first.

## Edge Cases & Error Handling

- Existing Claude sessions cannot have their process env changed in place. A file/config fix only affects new processes.
- MCP child processes can inherit stale env from the parent Claude process; seeing stale env in Serena/Discord children is evidence of inheritance, not necessarily the source.
- `context-handoff-signal.py` only warns on `UserPromptSubmit`; it does not perform compaction and cannot save a turn that already hits the hard limit.
- Broad `rg` over `.claude/projects` can produce huge outputs because transcripts contain old diffs/logs. Prune `projects/` and `jobs/` in future searches.
- Upstream `codex-proxy` supports compact routes, but it does not configure Claude Code auto compaction. Do not conflate server compact endpoint support with client auto-compact env behavior.
- The isolated worktree was created from commit `392b38b`, not original checkout `a985ff1`; treat code-state drift carefully if using this worktree for anything beyond reading the handoff.

## Warnings

- Do not run destructive `kill`/daemon cleanup without user approval.
- Do not assume a fresh file state means active sessions are fixed; always verify `/proc/<pid>/environ` or start a new process.
- The original repo is 26 commits ahead of `origin/main`; avoid pushing or force operations unless the user explicitly asks.
- There are 10 stashes. Do not clear or apply stashes without explicit user direction.
- The requested cleanup must include QA artifacts/session logs accidentally captured by automatic WIP checkpointing.
- If resuming from the primary checkout, be aware that this handoff was created in an isolated worktree due background write guard.
