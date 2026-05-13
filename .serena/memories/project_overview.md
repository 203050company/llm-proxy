# Project overview

codex-proxy is a TypeScript/Node.js reverse proxy that exposes Codex Desktop-style upstream functionality through OpenAI-compatible API routes and a Preact dashboard.

Main areas:
- `src/`: backend server, auth, proxy routing, account services, translation, update handling.
- `shared/`: frontend/backend shared types, hooks, i18n, formatting helpers.
- `web/`: Preact dashboard UI built with Vite.
- `tests/`: Vitest unit, integration, e2e, stress, and real-test suites.

Tech stack: TypeScript ESM, Hono, Preact, Vite, Zod, Vitest.