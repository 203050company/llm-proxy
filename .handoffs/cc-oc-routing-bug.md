# Handoff: cc-oc OpenCode Proxy Routing Bug

## Problem Statement
`cc-oc` (OpenCode proxy launcher) sessions were silently routing ALL requests to the **Codex** upstream instead of the actual **OpenCode** upstream (`opencode.ai`). Statusline showed the correct OpenCode model name, but the actual API call went to Codex.

## Root Cause Analysis (COMPLETED)

### Bug #1: Model Name Corruption in upstream-router.ts
**File:** `src/proxy/upstream-router.ts`, `resolveMatch()` method

**Chain:**
1. `cc-opencode` sends `ANTHROPIC_MODEL="opencode-kimi-k2.7"`
2. Claude Code sends request with `"model": "opencode-kimi-k2.7"`
3. `resolveMatch()` calls `parseModelNameSafe("opencode-kimi-k2.7")`
4. `parseModelNameSafe` → `parseModelName` → `resolveModelId()` in `model-store.ts`
5. `resolveModelId()` doesn't find "opencode-kimi-k2.7" in Codex catalog/aliases
6. Returns **default Codex model** (e.g., `gpt-5.5`)
7. `cleanModel` becomes `"gpt-5.5"` instead of `"opencode-kimi-k2.7"`
8. `isKnownCodexModel("gpt-5.5")` returns `true`
9. Request routed to Codex upstream: `return { kind: "codex" }`
10. `isOpencodeGoModel()` check at line 145 never reached

### Bug #2: Missing OpenCode Auth Volume in Docker
**File:** `docker-compose.yml`

Docker container could not access `~/.local/share/opencode/auth.json`, so `opencode-go` adapter was **never registered**.
- `~/.codex` and `~/.gemini` were mounted
- `~/.local/share/opencode` was **missing**
- Result: `[Init] opencode-go upstream configured` never appeared in logs

### Bug #3: Docker Image Not Rebuilt on Auto-Start
**File:** `bin/cc-opencode`, `start_proxy_if_needed()`

`docker compose up -d` without `--build` reused old image containing pre-fix code.

## Fixes Applied (COMPLETED)

### Fix 1: upstream-router.ts
Moved `isOpencodeGoModel` check to the **very beginning** of `resolveMatch()`, before `parseModelNameSafe()`:

```typescript
resolveMatch(model: string, triedModels: string[] = []): UpstreamRouteMatch {
  const trimmedModel = model.trim();

  // OpenCode Go models must be checked BEFORE Codex model resolution to
  // prevent parseModelNameSafe from falling back to the default Codex model.
  if (isOpencodeGoModel(trimmedModel)) {
    if (this.adapters.has("opencode-go")) {
      return { kind: "adapter", adapter: this.adapters.get("opencode-go")! };
    }
    return { kind: "not-found" };
  }

  const parsed = parseModelNameSafe(model);
  const cleanModel = parsed.modelId || trimmedModel;
  // ... rest of method
}
```

**Note:** There is a **duplicate** `isOpencodeGoModel(cleanModel)` check remaining at the original location (around line 157). This should be removed as it's now redundant.

### Fix 2: docker-compose.yml
Added volume mount for OpenCode auth:
```yaml
volumes:
  - ${HOME}/.local/share/opencode:/home/node/.local/share/opencode
```

### Fix 3: bin/cc-opencode
Changed `docker compose up -d` to `docker compose up -d --build` in `start_proxy_if_needed()`.

### Fix 4: Regression Tests
Added test in `tests/unit/proxy/opencode-go-router.test.ts` that mocks `model-store` to simulate the buggy fallback and verifies routing to `opencode-go` adapter.

## Verification Status

### ✅ Unit Tests Pass
- All 25 proxy unit tests pass
- New regression test passes
- `npm run build` succeeds

### ✅ Docker Container Has Fix
```bash
docker exec llm-proxy-codex-proxy-1 cat /app/src/proxy/upstream-router.ts | grep -A 5 "isOpencodeGoModel"
# Shows the new early check
```

### ✅ opencode-go Adapter Registered
Docker logs show:
```
[Init] opencode-go upstream configured (/home/node/.local/share/opencode/auth.json:opencode-go.key; key=sk-...lGcc)
```

### ✅ curl Test Reaches OpenCode Server
```bash
curl -X POST http://localhost:8080/v1/messages \
  -H "Authorization: Bearer <proxy_api_key>" \
  -d '{"model": "opencode-kimi-k2.7", ...}'
```
Response: `{"type":"error","error":{"type":"ModelError","message":"Model kimi-k2.7 not supported"}}`

**This is OpenCode server's direct response** → routing works.

## ❌ REMAINING ISSUE: Claude Code Session Returns 401

### Problem
When user runs `cc-oc` and Claude Code sends requests, the proxy returns **401** status:
```
→ POST /v1/messages
← POST /v1/messages 401 257ms
```

### What We Know
- curl test with same `Authorization: Bearer <key>` works (reaches OpenCode)
- Claude Code session gets 401
- `messages.ts` has two 401 paths:
  1. `!allowUnauthenticated && !accountPool.isAuthenticated()` → `"authentication_error"`
  2. `config.server.proxy_api_key` check fails → `"api_error"` or `"Invalid API key"`

### Hypotheses to Investigate
1. **Model name mismatch**: Claude Code may send a different `model` value than expected (e.g., after internal resolution). Check `req.model` value in actual requests.
2. **Auth header format**: Claude Code may send auth differently than curl. Verify `Authorization` header parsing in `messages.ts`.
3. **proxy_api_key mismatch**: `codex-proxy-api-key.sh` reads from `data/local.yaml`, but that file may not have `proxy_api_key`. The script falls back to fetching from `/auth/status` endpoint.
4. **Config file location**: `find_config_file()` in `codex-proxy-api-key.sh` searches multiple paths. Verify which config file is actually being read.
5. **Duplicate isOpencodeGoModel check**: The old `isOpencodeGoModel(cleanModel)` check at line ~157 is redundant and should be removed. It doesn't cause 401 but is dead code.

### Files to Investigate
- `src/routes/messages.ts` — Add logging for `req.model`, `routeMatch`, `allowUnauthenticated` values
- `src/auth/account-pool.ts` — Check `validateProxyApiKey()` logic
- `bin/cc-opencode` — Verify `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` env vars
- `$HOME/.claude/bin/codex-proxy-api-key.sh` — Trace which config file/key is returned
- `data/local.yaml` — Check if `proxy_api_key` is defined

### Quick Debug Steps
1. Check actual `data/local.yaml` for `proxy_api_key`:
   ```bash
   cat data/local.yaml | grep proxy_api_key
   ```
2. Add temporary console.log in `messages.ts` to trace:
   - `req.model` value
   - `routeMatch?.kind`
   - `allowUnauthenticated`
   - `providedKey` from auth header
3. Check if `accountPool.validateProxyApiKey()` returns true for the key

## Modified Files (Git Diff)
- `src/proxy/upstream-router.ts`
- `tests/unit/proxy/opencode-go-router.test.ts`
- `bin/cc-opencode`
- `docker-compose.yml`

## Related Files
- `src/routes/messages.ts` — Auth/routing logic (needs investigation)
- `src/proxy/opencode-go-upstream.ts` — OpenCode adapter
- `src/models/model-store.ts` — Model resolution logic
- `bin/cc-codex` — For comparison (uses `ANTHROPIC_API_KEY="unused"`)
