# Repository Guidelines

## Project Structure & Module Organization

This is a TypeScript/Hono proxy server. Core server code lives in `src/`, with route handlers in `src/routes`, upstream adapters in `src/proxy`, protocol translators in `src/translation`, auth logic in `src/auth`, and model metadata in `src/models`. Browser UI code is under `web/`, static output goes to `public/`, and compiled backend output goes to `dist/`. Tests live in `tests/unit`, `tests/integration`, `tests/e2e`, `tests/stress`, and `tests/real`. Runtime configuration and state are in `config/` and `data/`; avoid committing generated or local secret data.

## Build, Test, and Development Commands

- `npm install`: install workspace dependencies.
- `npm run dev`: run the backend with `tsx watch src/index.ts`.
- `npm run dev:web`: run the Vite web UI dev server.
- `npm run build`: build the web UI and run `tsc`.
- `npm test`: run the full Vitest suite.
- `npm run test:unit`, `npm run test:integration`, `npm run test:e2e`: run focused test groups.
- `npm start`: run the compiled server from `dist/index.js`.

For Docker-based local use, `docker compose up -d --build` starts the `codex-proxy` service on port `8080`.

## Coding Style & Naming Conventions

Use TypeScript ES modules and existing local patterns. Prefer explicit interfaces for request/response shapes and keep protocol conversion inside `src/translation`. Use two-space indentation, double quotes, semicolons, and descriptive camelCase names for variables/functions. Classes and exported types use PascalCase. Keep adapters small and implement `UpstreamAdapter`.

## Testing Guidelines

Vitest is the test framework. Add unit tests under `tests/unit/<area>/*.test.ts`; use route/e2e tests for behavior that crosses Hono routes, auth, or streaming translation. When changing translators or upstream adapters, include regression tests for request body shape, routing decisions, and SSE/tool-call behavior where applicable. Run the smallest relevant test first, then `npm run build`.

## Commit & Pull Request Guidelines

Recent history uses short Conventional Commit style, for example `feat: add on-demand Gemini route status command` and `fix: include Gemini usage in dashboard totals`. Keep commits focused and imperative. Pull requests should describe the behavior change, list verification commands, note config or migration impacts, and include screenshots for visible UI changes.

## Security & Configuration Tips

Never commit real API keys, OAuth tokens, cookies, or generated account data from `data/`. Redact secrets in logs and tests. Prefer environment variables or local files for provider credentials, and document new configuration keys in the relevant README or API docs.
