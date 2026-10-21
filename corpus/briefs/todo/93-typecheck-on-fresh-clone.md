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
