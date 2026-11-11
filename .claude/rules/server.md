---
paths:
  - "apps/api/src/**"
  - "packages/shared/src/**"
---

# The API and the shared package (`apps/api/src`, `packages/shared/src`)

- Read [corpus/wiki/api-layering.md](../../corpus/wiki/api-layering.md) before you add or move a route. A
  controller owns HTTP, a service owns the rules, a model owns the SQL.
- A service returns a tagged union for a normal outcome. A thrown error is a 500 that says nothing to the client.
- Every notes, folders and LaTeX query is keyed on `profile_id`. A foreign id is a 404, never a 403.
- `apps/api/vendor/` is Ward's generated library. Never edit it.
- Tests go through `buildTestApp` in `apps/api/test/harness.ts`.
- A value the guard or a write guarantees is narrowed with `present()` from `common/present.ts`, not a `!`.
- `common/config.ts` reads the environment. `index.ts`, `calibre.service.ts` and the seed command still read it
  themselves (an ESLint warning until the API takes its settings from `config.ts`); add no other reader.
- `npm run check:conventions` runs `check-structure` over these folders, `--warn-only` until the API layout work
  is done.
