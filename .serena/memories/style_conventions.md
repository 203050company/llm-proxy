# Style conventions

The codebase uses TypeScript ESM imports, named exports, Preact hooks for UI state, Hono route factories on the backend, and Vitest tests. Keep changes focused and prefer existing local patterns over new abstractions. Shared frontend/backend contracts live in `shared/types.ts`; dashboard strings are keyed through `shared/i18n/translations.ts` and accessed with `useT()`.