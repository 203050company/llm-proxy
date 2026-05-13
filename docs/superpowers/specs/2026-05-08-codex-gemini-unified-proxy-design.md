# Spec: LLM-Proxy Gemini CLI OAuth Integration

## Summary

`codex-proxy` will become `LLM-Proxy`: one dashboard and one proxy surface for Codex accounts, Gemini CLI OAuth accounts, existing runtime API keys, proxy assignment, and usage statistics.

The Gemini integration must follow the Gemini CLI "Login with Google" path, not the simple Gemini API key path. Local inspection of Gemini CLI `0.41.2` shows that `oauth-personal` stores credentials in `~/.gemini/oauth_creds.json`, uses Google OAuth scopes including `cloud-platform`, `userinfo.email`, and `userinfo.profile`, and routes OAuth requests through Gemini Code Assist endpoints under `https://cloudcode-pa.googleapis.com/v1internal`.

The project will not import `claude-code-proxy` wholesale. That repository is useful as a routing and compatibility reference, but this project already has a richer TypeScript/Hono dashboard, account pool, route translation, and usage system.

## Goals

- Rename the product header from `Codex Proxy` to `LLM-Proxy`.
- Add Gemini as a first-class dashboard account type using Gemini CLI OAuth/Code Assist, not only API keys.
- Keep Codex and Gemini account storage, token refresh, quota handling, upstream transport, and errors isolated.
- Show Codex and Gemini accounts as separate sections across overview, account management, API key, proxy assignment, and usage screens.
- Preserve the existing Gemini API key support as a separate runtime provider path.
- Add usage aggregation so `All Models` means Codex plus Gemini OAuth plus API key providers.
- Add settings for Gemini OAuth, Gemini CLI credential import, Code Assist project/tier/quota status, routing, and connection testing.
- Fix the Codex OAuth auth-management issue as a separate checkpoint because `native/index.js` currently returns `500 {"error":"Native addon not found"}`.

## Non-Goals

- Do not replace the TypeScript/Hono server with Python FastAPI or LiteLLM.
- Do not merge Gemini OAuth accounts into the Codex `AccountPool`.
- Do not remove existing Gemini API key support.
- Do not implement CLI helper commands in this phase unless they naturally fall out of the final implementation plan.
- Do not treat Gemini OAuth access tokens as direct `generativelanguage.googleapis.com/v1beta?key=` credentials.

## Current Findings

### Existing Project

- The dashboard title is hardcoded as `Codex Proxy` in `web/src/components/Header.tsx`.
- The account add button currently calls Codex OAuth immediately through `useAccounts().startAdd()`.
- Codex accounts are managed through `AccountPool`, `/auth/login-start`, `/auth/code-relay`, `/auth/accounts`, and related refresh logic.
- Runtime provider API keys are managed separately by `ApiKeyPool` and `/auth/api-keys`.
- `VALID_PROVIDERS` already includes `gemini`.
- `data/api-keys.json` currently contains one persisted Gemini API key entry:
  - `provider: "gemini"`
  - `model: "gemini-3.1-pro"`
  - `status: "active"`
  - usage counters are all zero
- This stored key explains why the API key tab currently shows one key. It is a Gemini API key entry, not a Gemini OAuth account.
- Usage stats currently aggregate Codex accounts and runtime API key entries, with recent local changes adding external adapter usage tracking.
- Proxy assignment currently reads Codex accounts only from `AccountPool`.
- The Codex OAuth failure is caused by the local native transport shim:
  - `native/index.js` logs dummy transport usage
  - `httpPost` returns `500 {"error":"Native addon not found"}`
  - Codex `/auth/code-relay` depends on this path during token exchange

### Gemini CLI

Gemini CLI OAuth mode should be treated as the source of truth for Gemini login compatibility.

Relevant observed behavior:

- Auth type: `oauth-personal`
- Credential cache: `~/.gemini/oauth_creds.json`
- Local credential fields: `access_token`, `refresh_token`, `id_token`, `expiry_date`, `scope`, `token_type`
- OAuth scopes include `https://www.googleapis.com/auth/cloud-platform`, `userinfo.email`, `userinfo.profile`, and `openid`
- Login callback uses a local loopback OAuth server
- OAuth requests for logged-in users are sent through Code Assist, not the simple API key Gemini endpoint
- Code Assist base endpoint: `https://cloudcode-pa.googleapis.com/v1internal`
- Streaming method shape: `POST {base}/:streamGenerateContent?alt=sse`
- Non-streaming method shape: `POST {base}/:generateContent`
- Quota/credits are exposed through Code Assist responses and quota-related calls such as `retrieveUserQuota`

## Architecture

### Provider Boundaries

Codex and Gemini must share UI concepts but not backend account internals.

- Codex:
  - Keep `AccountPool`
  - Keep Codex OAuth and Codex refresh scheduler
  - Keep Codex upstream transport

- Gemini OAuth:
  - Add `GeminiAccountPool`
  - Add Gemini OAuth session manager
  - Add Gemini token refresh path
  - Add `GeminiCodeAssistUpstream`
  - Add Code Assist request/response translators

- Runtime API keys:
  - Keep `ApiKeyPool`
  - Keep Gemini API key direct adapter support
  - Display separately from Gemini OAuth accounts

### Account Identity

Dashboard-facing account IDs must include provider namespace when crossing shared surfaces.

Examples:

- `codex:<accountId>`
- `gemini:<accountId>`
- `apikey:<keyId>`

Provider namespaces are required for proxy assignment, selection state, batch actions, logs, and usage filtering so IDs cannot collide.

### Gemini OAuth Account Data

Persist Gemini OAuth accounts in a new data file, for example `data/gemini-accounts.json`.

Each entry stores:

- `id`
- `email`
- `label`
- `status`: `active`, `expired`, `refreshing`, `rate_limited`, `quota_exhausted`, `disabled`, or `error`
- `accessToken`
- `refreshToken`
- `idToken`
- `scope`
- `tokenType`
- `expiresAt`
- `projectId`
- `userTier`
- `userTierName`
- `paidTier`
- `quota`
- `quotaFetchedAt`
- `lastUsedAt`
- `lastRefreshSuccessAt`
- `lastRefreshFailureAt`
- `lastRefreshFailureCode`
- `usage`
- `models`

Sensitive token fields must never be returned unmasked to the dashboard.

### Gemini OAuth Flow

Add backend routes under a Gemini-specific namespace.

- `POST /auth/gemini/login-start`
  - Creates a Gemini OAuth session.
  - Starts a loopback callback server or returns a callback relay URL flow compatible with the existing dashboard pattern.
  - Returns `{ authUrl, state }`.

- `POST /auth/gemini/code-relay`
  - Accepts `{ callbackUrl }`.
  - Validates `state`.
  - Exchanges the code through Google OAuth token endpoint.
  - Stores or updates a Gemini account.
  - Fetches user info and Code Assist setup metadata.

- `GET /auth/gemini/callback`
  - Handles browser callback when the server is reachable directly.
  - Posts the same success/error messages used by the current popup flow.

- `POST /auth/gemini/import-cli`
  - Reads `~/.gemini/oauth_creds.json`.
  - Validates token freshness or refreshes it.
  - Imports the account into `GeminiAccountPool`.
  - Does not print or return token values.

- `GET /auth/gemini/accounts`
  - Lists masked Gemini account summaries.

- `DELETE /auth/gemini/accounts/:id`
  - Removes a Gemini account.

- `POST /auth/gemini/accounts/:id/refresh`
  - Refreshes one Gemini account token.

- `POST /auth/gemini/accounts/health-check`
  - Refreshes and validates selected Gemini accounts.

### Code Assist Upstream

Add `GeminiCodeAssistUpstream` for OAuth-backed Gemini traffic.

Responsibilities:

- Select a Gemini OAuth account.
- Refresh the account token before request if near expiry.
- Convert Codex-format requests to Code Assist `generateContent` request shape.
- Send requests to Code Assist using OAuth bearer credentials.
- Parse Code Assist SSE events.
- Convert Code Assist responses to the existing internal Codex SSE event shape.
- Record usage from `usageMetadata`.
- Record Code Assist consumed/remaining credit data when returned.
- Mark account state on auth, quota, and rate-limit errors.

The existing `GeminiUpstream` remains the API key adapter for `generativelanguage.googleapis.com/v1beta`.

### Routing

`UpstreamRouter` must distinguish these Gemini paths:

- Runtime API key exact model match: existing `ApiKeyPool` path.
- Explicit provider prefix for API key or static adapter paths: existing behavior.
- Gemini OAuth models: new Code Assist path when an active Gemini OAuth account supports the requested model and no exact runtime API key entry should take precedence.
- Codex models: existing Codex account path.

Provider routing settings should support:

- default provider for Claude-style aliases
- `opus`, `sonnet`, `haiku` alias mapping
- model failover chain
- whether Gemini OAuth or Gemini API key has priority for matching Gemini models

Default priority should be:

1. Exact runtime API key model entry
2. Explicit provider prefix
3. Explicit routing table
4. Gemini OAuth account route for Gemini Code Assist models
5. Existing built-in model pattern rules
6. Codex fallback for known Codex models

### Usage Stats

Usage history must store enough metadata to support provider and model views.

Each usage event or snapshot model entry should include:

- provider: `codex`, `gemini-oauth`, `api-key`, or provider name
- model
- source account/key id
- input tokens
- output tokens
- request count

Dashboard behavior:

- `All Models` sums Codex accounts, Gemini OAuth accounts, Gemini API keys, and other provider keys.
- Selecting a Gemini model shows that model across Gemini OAuth and Gemini API key sources unless a provider filter is later added.
- Existing summary cards continue to show total input tokens, output tokens, request count, and account/key counts.
- Active account count should either be renamed to active upstreams or split into Codex active accounts and Gemini active accounts.

### Proxy Assignment

The proxy pool remains shared.

Assignment records must support namespaced account IDs:

- Codex assignments use `codex:<id>`.
- Gemini assignments use `gemini:<id>`.

Dashboard proxy assignment view displays:

- `Codex Accounts` section first.
- `Gemini Accounts` section below.
- Shared proxy group sidebar counts all visible accounts, with provider breakdown available in labels or tooltips.
- Bulk assignment works independently per selected provider but can also apply to mixed selections because the assignment IDs are namespaced.

## Dashboard UI Specification

### 1. Header

Change the header title from `Codex Proxy` to `LLM-Proxy`.

The GitHub star link can remain unchanged unless project ownership changes later.

### 2. Account Add Flow

Current behavior opens Codex login immediately. Replace it with a provider chooser.

When the user clicks `Add Account`:

- Show an inline panel under the header or at the current add-account location.
- Display two provider choices:
  - `Codex`
  - `Gemini`
- `Codex` starts the current Codex OAuth popup flow unchanged.
- `Gemini` starts the Gemini CLI-compatible Google OAuth popup flow.
- The existing callback URL paste box remains available for Codex and Gemini, with provider-specific labels and relay endpoints.
- Refresh-token direct add remains Codex-only unless Gemini CLI credential import is selected.

### 3. Overview Tab

The overview account table becomes provider-sectioned.

Order:

1. `Codex Accounts`
2. `Gemini Accounts`

Codex rows keep current fields.

Gemini rows show:

- email
- label
- status
- project id
- tier
- quota/credits summary
- last used
- token refresh status
- proxy assignment summary if available

### 4. Account Management Tab

Use the same provider-sectioned layout as the overview tab.

Codex actions remain:

- refresh list
- health check
- import/export
- apply to Codex CLI
- status toggle
- delete
- label update

Gemini actions:

- refresh list
- refresh token
- import from Gemini CLI
- health check
- status toggle
- delete
- label update
- test Code Assist request

Do not offer `apply to Codex CLI` for Gemini accounts.

### 5. API Key Tab

Use provider sections.

Sections:

- `Proxy API Key`
- `Gemini API Keys`
- `OpenAI API Keys`
- `Anthropic API Keys`
- `Custom Provider API Keys`

The existing single registered key is explained in the UI or documentation as a persisted Gemini API key from `data/api-keys.json`, not a Gemini OAuth account.

Gemini OAuth accounts do not appear in the API key table.

### 6. Proxy Assignment Management

Use the same sectioning:

1. `Codex Accounts`
2. `Gemini Accounts`

Both sections use the same proxy selector component.

Bulk actions must operate on namespaced IDs so mixed selections are safe.

### 7. Usage Statistics

Model list behavior:

- Include Codex models from the model catalog.
- Include Gemini models from the model catalog.
- Include runtime active API key models.
- Include models seen in usage history even if no longer active.

Filtering behavior:

- Empty model filter / `All Models`: sum all providers and all models.
- Gemini model selected: show usage for that model across Gemini OAuth and Gemini API key sources.
- Codex model selected: show usage for Codex account traffic for that model.

The chart should not assume all Codex account usage belongs to a synthetic `codex` model once model-level usage is available. Until model-level Codex attribution is complete, legacy Codex usage can remain under `codex` and be included in `All Models`.

### 8. Settings

Current settings sections:

- General settings
- Quota settings
- Rotation settings
- Proxy API key settings
- API config/code examples/test connection

Add Gemini-specific settings:

#### Gemini OAuth

- Enable Gemini OAuth login.
- Import credentials from `~/.gemini/oauth_creds.json`.
- Show credential cache path.
- Show signed-in email and token expiry.
- Revoke/remove account action.

#### Gemini Code Assist

- Code Assist endpoint, default `https://cloudcode-pa.googleapis.com`.
- Code Assist API version, default `v1internal`.
- Project ID override, matching Gemini CLI behavior with `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_PROJECT_ID`.
- Tier and paid-tier display.
- Quota/credit refresh action.

#### Gemini Token Refresh

- Refresh enabled.
- Refresh margin seconds.
- Refresh concurrency.
- Last refresh failure display.

These settings are separate from Codex token refresh settings.

#### Gemini Routing

- Preferred provider for Claude aliases.
- Alias mapping for `opus`, `sonnet`, `haiku`.
- Gemini OAuth versus Gemini API key priority for Gemini model names.
- Failover chain editor for Gemini models.

#### Gemini Connection Test

- Test selected Gemini OAuth account.
- Test selected Gemini model.
- Show auth, project setup, quota, and minimal generateContent result.

## External Repo Comparison

`https://github.com/1rgs/claude-code-proxy` is partially applicable as design reference.

Applicable ideas:

- provider/model mapping such as preferred provider, big model, and small model
- Anthropic `/v1/messages` compatibility
- `/v1/messages/count_tokens` compatibility
- provider-specific schema cleanup before Gemini calls
- Vertex/Google auth awareness

Not applicable as direct implementation:

- Python FastAPI runtime
- LiteLLM dependency
- environment-only provider configuration
- replacing existing dashboard/account architecture
- flattening tool calls to text for non-Claude models when native conversion is available

## Error Handling

Gemini OAuth errors should be provider-specific and must not be reported as Codex OAuth failures.

Expected error classes:

- invalid or expired OAuth session
- Google token exchange failure
- Google token refresh failure
- missing refresh token
- project id required
- Code Assist onboarding required
- Code Assist permission denied
- quota exhausted
- rate limited
- malformed Code Assist stream

Codex native transport error remains a separate issue:

- Current symptom: `Token exchange failed: Token exchange failed (500): {"error":"Native addon not found"}`
- Root cause: `native/index.js` dummy transport returns 500 for native HTTP calls.
- Required fix: restore or replace Codex native transport for Linux, or bypass it safely for OAuth token exchange.

## Security

- Never log access tokens, refresh tokens, id tokens, API keys, or full callback URLs.
- Mask sensitive fields in all dashboard responses.
- Do not copy Gemini CLI credential files into logs.
- Restrict Gemini credential import to local dashboard sessions or require existing admin write authentication.
- Keep dashboard write authentication requirements for all account mutations.
- Store provider namespace with IDs so proxy/API operations cannot target the wrong account type.

## Testing Strategy

Backend unit tests:

- Gemini OAuth session creation and state validation.
- Gemini callback relay success and failure.
- Gemini CLI credential import with masked response.
- Gemini token refresh success and failure.
- Gemini Code Assist request conversion.
- Code Assist SSE parsing.
- Usage stats aggregation across Codex, Gemini OAuth, and API key sources.
- Proxy assignment with namespaced Codex and Gemini IDs.
- Regression test for Codex `/auth/code-relay` native addon failure path after the transport fix.

Frontend tests:

- Header displays `LLM-Proxy`.
- Add account button opens provider chooser.
- Codex choice calls existing Codex login flow.
- Gemini choice calls Gemini login flow.
- Overview shows Codex section above Gemini section.
- Account management shows provider-specific actions.
- API key tab explains existing Gemini API key entries separately from Gemini OAuth accounts.
- Proxy assignment shows both provider sections.
- Usage model selector includes Gemini models and `All Models` aggregates all sources.
- Settings shows Gemini OAuth, Code Assist, refresh, routing, and connection-test sections.

Manual verification:

- Import an existing `~/.gemini/oauth_creds.json`.
- Add a Gemini account through browser OAuth.
- Send a request to a Gemini model through the proxy.
- Confirm usage appears under the selected Gemini model.
- Confirm `All Models` includes Codex plus Gemini totals.
- Confirm Codex account addition works after the native transport fix.

## Implementation Order

1. Update the spec and implementation plan.
2. Fix Codex native transport token exchange so the existing account flow is healthy.
3. Add Gemini account data model and persistence.
4. Add Gemini OAuth and CLI credential import routes.
5. Add Gemini token refresh and account health checks.
6. Add Gemini Code Assist upstream adapter and translators.
7. Extend routing for Gemini OAuth accounts.
8. Extend usage stats provider/model aggregation.
9. Extend proxy assignment for provider namespaced IDs.
10. Update dashboard UI sections and settings.
11. Add tests and run build/test verification.

## Acceptance Criteria

- Header reads `LLM-Proxy`.
- Clicking `Add Account` shows `Codex` and `Gemini` choices.
- Codex login still uses the current Codex OAuth flow.
- Gemini login uses Gemini CLI-compatible Google OAuth.
- Existing Gemini API key entry remains visible as an API key, not an OAuth account.
- Overview and account management show Codex accounts above Gemini accounts.
- API key tab separates proxy/API provider keys from Gemini OAuth accounts.
- Proxy assignment supports both Codex and Gemini accounts without ID collision.
- Usage stats model list includes Gemini models.
- `All Models` aggregates Codex and Gemini usage.
- Settings include Gemini OAuth, Code Assist, token refresh, routing, quota, and connection testing controls.
- Codex callback URL token exchange no longer fails with `Native addon not found`.
- No sensitive tokens are logged or returned unmasked.
