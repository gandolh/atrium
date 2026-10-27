# Task 93: `npm run typecheck` works on a fresh clone

## Context

`packages/shared` and `packages/typeset` publish their types from `dist/` (`"types":
"./dist/index.d.ts"`), which only `npm run build` creates. `docs/getting-started.md:91-97` lists
`npm run typecheck` before `npm run build`. On a fresh clone (checked 2026-10-20) typecheck fails
with TS2307 in typeset and the API; after building shared and typeset it passes.

Improvement sweep of 2026-10-20 (mechanical checks lens), vetted against the code; the ranked report is the owner's "Repo improvement sweep" doc.

## Files you OWN

- the root `package.json` scripts
- `packages/*/package.json`
- `docs/getting-started.md`

## What to do

1. Either build shared and typeset first (a `pretypecheck` script), or point the workspace consumers at the sources (TypeScript project references or a source `types` condition).
2. Fix the order in the docs.

## Acceptance

- A fresh clone, `npm ci`, then `npm run typecheck` exits 0.

## Outcome (2026-10-27)

**Done**, code in `78cbece`. Chose the first option, building first, over pointing
the consumers at the sources: the API runs its tests and dev server through tsx,
which resolves `@ebook-reader/shared` at runtime through the same `exports`, so a
source `types` condition would fix the typecheck and leave the tests broken.

- The root [`package.json`](../../../package.json) has `build:packages` (shared,
  then typeset, about 4 s), and `pretypecheck` and `pretest` run it. `dev` uses it
  instead of the same two commands written inline. `packages/*/package.json` did
  not need a change.
- **`pretest` goes past the brief's acceptance**, for the same cause: on the
  fresh clone before the change, `npm test` failed too, with all 23 API test
  files at `ERR_MODULE_NOT_FOUND` for `@ebook-reader/shared/dist/index.js`
  (the typeset suite passed, 647 of 647).
- [`getting-started.md`](../../../docs/getting-started.md): the section is
  "Build, typecheck, test" in that order, and says the two packages are built
  first and that a single workspace's script needs one of the root scripts to
  have run.

**Checked**, each on a `git clone` of the local repo into a scratch directory,
then `npm ci`:
- before the change (`3cd0e95`): `npm run typecheck` exited 2 with TS2307
  ("Cannot find module '@ebook-reader/shared'") in typeset and the API;
- after it (`78cbece`): `npm run typecheck` exited 0, with no `error TS`, through
  all five workspaces; then, with both `dist/` folders deleted again, `npm test`
  exited 0 (typeset 647 of 647, API 123 of 123).
- In the working repo `npm run typecheck` is clean.
