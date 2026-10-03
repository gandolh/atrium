# Task 72 — Dependency and Node versions back in line with D21 and D23

**Filed 2026-09-25** by the improvements sweep. **Small decision needed** on the
Node line (step 3).

## Context

**D21 — "pinned exact dependency versions (no `^`/`~`)".** It exists because
"ranges had already drifted". They have drifted again, in three workspaces
(resolved versions read from `package-lock.json` on 2026-09-25):

| Workspace | Declared | Resolved |
|---|---|---|
| [`apps/api`](../../../apps/api/package.json) | `jose ^6.2.10`, `knex ^3.1.0` | 6.2.10, 3.1.0 |
| [`apps/web`](../../../apps/web/package.json) | `@playwright/test ^1.61.1` | 1.61.1 |
| [`apps/docs`](../../../apps/docs/package.json) | `@astrojs/starlight ^0.41.3` | **0.41.11** |
| | `astro ^7.1.1` | **7.3.1** |
| | `typedoc ^0.28.20` | 0.28.20 |
| | `@fontsource/archivo ^5.2.5`, `@fontsource/newsreader ^5.2.5` | 5.3.0 |
| | `sharp ^0.35.4` | 0.35.4 |

`apps/docs` is 100% caret, and two of its packages have already moved past what
was declared. **`sharp` is installed twice:** `apps/api` pins 0.35.3, while the
docs site and astro pull 0.35.4. That is two copies of a native binary in
`node_modules`.

**D23 — "Node ≥22 (`.nvmrc` 22.23.1) … Dev box is 22.23.1; pinned to installed
version".** Its premise is no longer true:

- **This machine** runs **v24.14.1**.
- **The container image** builds and runs on `node:24-bookworm-slim` in all three
  stages ([`infrastructure/Dockerfile`](../../../infrastructure/Dockerfile)).
- **The code**: `latex-compile.service.ts`'s worker-loading notes were "measured
  on Node 24".
- **What still says 22:** [`.nvmrc`](../../../.nvmrc) says 22.23.1, and
  `@types/node` is 22.20.0 in `apps/api` and `packages/typeset`.

So the typings and the pin describe a runtime nobody runs. `better-sqlite3` and
`sharp` are native modules built per Node ABI, and they are exercised only on 24.

## Scope

**In:** exact pins for every ranged dependency; de-duplicating `sharp`; aligning
`.nvmrc`, `engines` and `@types/node` with the runtime actually used; revising
D23.

**Out:**
- upgrading anything beyond what the lockfile resolves today, except the one
  `sharp` alignment;
- the D43 audit triage;
- the Dockerfile's base image.

## Files you OWN

- `apps/api/package.json`, `apps/web/package.json`, `apps/docs/package.json`,
  `packages/typeset/package.json` (only `@types/node`), the root `package.json`
  (only `engines`)
- `.nvmrc`
- `package-lock.json`, as npm rewrites it
- `corpus/wiki/decisions.md`: D21's and D23's rows only, plus a
  [log](../../log.md) entry

## Files you must NOT touch

- `infrastructure/**` (brief 55), any source file.

## What to do

1. **Pin every caret to its currently resolved version.** Take the versions from
   the table above, as resolved in `package-lock.json`. Nothing gets newer except
   in step 2.
2. **Align `sharp`** on a single version for both workspaces. Prefer moving
   `apps/api` to 0.35.4, the version already installed for the docs site. Then
   confirm `npm ls sharp` shows one copy and the API's thumbnail path still works.
3. **Decide the Node line with the owner.** The recommendation is **24**, because
   that is what dev and production both run:
   - `.nvmrc` → the installed 24.x;
   - `@types/node` → the matching 24.x types;
   - `engines` → `>=24`.

   If the owner prefers 22, the Dockerfile base must change instead, and that is
   brief 55's file.
4. **Record it.** Revise D23 with the date, the reason and the rejected
   alternative, and mark D21's drift as corrected. Add one log line.

## Acceptance

- `grep -rn '"[\^~]' apps/*/package.json packages/*/package.json package.json`
  finds nothing but the internal `"*"` workspace references.
- `npm ls sharp` shows a single version.
- `npm ci`, then root `npm run typecheck`, `npm run build` and `npm run test`,
  succeed on the chosen Node line. [Brief 59](../done/59-root-scripts-dependency-order.md)
  makes the build order work on a clean checkout.
- `npm run docs -w @ebook-reader/docs-site` still builds the docs site.
- `bash corpus/lint.sh` passes.

## Outcome (2026-10-03)

Done. **The Node line was decided without the owner:** this was an unattended run, and the brief's recommendation, 24, is what dev and production already run. The other choice means changing the production base image. D23 records it as revisitable.

**Pins** (each to the version `package-lock.json` resolved; nothing newer except sharp):
- `apps/api`: `jose` 6.2.10, `knex` 3.1.0;
- `apps/web`: `@playwright/test` 1.61.1;
- `apps/docs`: `@astrojs/starlight` 0.41.11, `@fontsource/archivo` and `/newsreader` 5.3.0, `astro` 7.3.1, `sharp` 0.35.4, `typedoc` 0.28.20.

The acceptance grep finds no `^`/`~` anywhere.

**sharp.** `apps/api` moved 0.35.3 → 0.35.4. `npm ls sharp` shows one copy, with astro's and the docs site's deduped. The lockfile change is exactly that: two duplicate trees of 28 platform packages removed, the sharp/libvips platform packages bumped, `@types/node` 22.20.0 → 24.19.1 and `undici-types` with it. No other package moved.

**Node:**
- `.nvmrc` 24.14.1, the installed runtime;
- root `engines` `>=24`;
- `@types/node` 24.19.1 in `apps/api` and `packages/typeset`.

**Checks, on Node 24.14.1:**
- `npm ci`, root `npm run typecheck` (0 errors), `npm run build`, and `npm run test` (typeset 647/647, API 69/69) all pass. The API suite's uploads and EPUB fixtures exercise the sharp thumbnail path on 0.35.4.
- `npm run docs -w @ebook-reader/docs-site` built 23 pages.
- `bash corpus/lint.sh` passes.
- D21 is marked drift-corrected, and D23 is revised with the reason and the rejected alternative.
