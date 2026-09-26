# Task 59 — Root scripts build the workspaces in dependency order

**Filed 2026-09-25** by the improvements sweep. A fresh clone cannot `npm run
build`, and `npm run dev` runs the LaTeX engine from a stale or missing build.

## Context

npm runs `--workspaces` scripts in **declaration order**. The root
[`package.json`](../../../package.json) declares `["apps/*", "packages/*"]`, which
npm expands (checked with `npm pkg get name --workspaces` on 2026-09-25) to:

```
@ebook-reader/api → docs-site → web → shared → typeset
```

Both apps compile against the **built** packages:
- `packages/shared` and `packages/typeset` point their `types` at `./dist`;
- `apps/api` imports both;
- `apps/web` imports `shared`.

What that breaks:

- **`npm run build`** (`--workspaces --if-present`) on a clean checkout type-checks
  `apps/api` before either package has a `dist/`, so it fails with
  cannot-find-module errors, before reaching the packages that would fix it.
  **`npm run typecheck`** fails the same way.
- **`npm run dev`** builds `@ebook-reader/shared` only, never `typeset`.
  `apps/api` boots anyway, because the engine is imported only by the worker entry
  ([`latex-worker.ts:2-4`](../../../apps/api/src/modules/latex/latex-worker.ts)).
  So on a fresh clone the **first compile** fails. On an existing checkout it
  **silently runs yesterday's engine**. That second case already happened:
  [status.md](../../wiki/status.md) records brief 40 shipping math the app could
  not use because "`apps/api` imports the **built** package and `dist/` was a day
  stale".

Two places already hand-order the build to work around this:

- [`infrastructure/Dockerfile`](../../../infrastructure/Dockerfile), whose comment
  at lines 36-42 describes this exact failure;
- vps-deploy's `stacks/atrium.ts`: "shared must build first … the root `build`
  script runs the workspaces in the other order".

The root scripts are the last place still doing it the wrong way.

## Scope

**In:** the root `package.json` scripts and workspace order.

**Out:**
- per-workspace scripts;
- the Dockerfile, whose explicit order is correct and can stay;
- TypeScript project references (`tsc -b`), a larger change not needed to fix
  this;
- `apps/docs`, which deliberately has a `docs` script rather than `build`
  (2026-09-06 log).

## Files you OWN

- `package.json` (root)
- `package-lock.json`, only as far as npm rewrites it for a workspace reorder

## Files you must NOT touch

- `infrastructure/**` (brief 55), `apps/*/package.json`,
  `packages/*/package.json`.

## What to do

1. **Declare dependencies before dependents.** Use
   `"workspaces": ["packages/shared", "packages/typeset", "apps/*"]`, listed
   explicitly rather than globbed: `typeset` depends on `shared`, and an explicit
   list does not depend on alphabetical luck when a package is added.
2. **Build both packages in `dev`** before starting the apps:
   `npm run build -w @ebook-reader/shared && npm run build -w @ebook-reader/typeset
   && concurrently …`. Chain with `&&`, rather than relying on the flag order of
   several `-w`.
3. **Optionally keep typeset fresh while dev runs.** Add `tsc --watch -p
   packages/typeset` to the `concurrently` set. The worker loads the engine from
   disk on every compile, so this makes engine edits reach the app without a
   restart. That is precisely the brief 40 failure, prevented.

## Acceptance

Verify in a **fresh clone in a scratch directory**, not this checkout, so no
existing `dist/` hides the problem:

- `npm ci && npm run build` succeeds.
- `npm run typecheck` succeeds.
- `npm run test` runs typeset's suite and passes (647 tests at the time of
  writing).
- `npm run dev`, with all five storage roots set inline to a scratch base and
  asserted, starts both apps, and the first LaTeX compile runs the current
  engine. Brief 54 must have landed for a compile to work at all. If it has not,
  check that `packages/typeset/dist/` exists and is fresh after startup.
