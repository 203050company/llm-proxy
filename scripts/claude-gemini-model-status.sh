#!/usr/bin/env bash
set -u

base_url="${LLM_PROXY_BASE_URL:-${ANTHROPIC_BASE_URL:-http://127.0.0.1:${CODEX_PROXY_PORT:-8080}}}"
base_url="${base_url%/}"
url="${base_url}/admin/session-routing/latest?provider=gemini"

tmp_body="$(mktemp)"
tmp_err="$(mktemp)"
trap 'rm -f "$tmp_body" "$tmp_err"' EXIT

status="$(
  curl -sS --max-time "${LLM_PROXY_STATUS_TIMEOUT_SECONDS:-3}" \
    -o "$tmp_body" \
    -w "%{http_code}" \
    "$url" \
    2>"$tmp_err" || true
)"

body="$(cat "$tmp_body")"

if [[ "$status" == "000" ]]; then
  echo "Gemini session"
  echo "Status:    llm-proxy is not reachable at ${base_url}"
  if [[ -s "$tmp_err" ]]; then
    echo "Detail:    $(tr '\n' ' ' < "$tmp_err")"
  fi
  exit 0
fi

if [[ "$status" == "404" ]]; then
  echo "Gemini session"
  echo "Status:    no Gemini request has been recorded yet"
  echo "Provider:  gemini"
  exit 0
fi

if [[ ! "$status" =~ ^2 ]]; then
  echo "Gemini session"
  echo "Status:    failed to read llm-proxy routing state (HTTP ${status})"
  if [[ -n "$body" ]]; then
    echo "Detail:    ${body}"
  fi
  exit 1
fi

node - "$body" <<'NODE'
const payload = JSON.parse(process.argv[2]);
const record = payload.record ?? payload;

const accountParts = [];
if (record.accountEmail) accountParts.push(record.accountEmail);
if (record.accountId) accountParts.push(`(${record.accountId})`);

console.log("Gemini session");
console.log(`Requested: ${record.requestedModel ?? "unknown"}`);
console.log(`Actual:    ${record.actualModel ?? "unknown"}`);
console.log(`Provider:  ${record.provider ?? "unknown"}`);
console.log(`Account:   ${accountParts.length ? accountParts.join(" ") : "unknown"}`);
console.log(`Updated:   ${record.updatedAt ?? "unknown"}`);
NODE
