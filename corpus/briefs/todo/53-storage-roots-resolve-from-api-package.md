# Task 53 — Storage roots and `.env` resolve from the API package again

**Filed 2026-09-25** by the improvements sweep. **Critical:** a live deploy of the
current code serves an empty library.

## Context

Brief 52 moved `config.ts` from `apps/api/src/` into `apps/api/src/common/`
(commit `0cf1e7f`, a pure rename with 0 lines changed). The file anchors every
path on its own location, and nobody updated those anchors
([`config.ts:18-20`](../../../apps/api/src/common/config.ts)):

```ts
const HERE = dirname(fileURLToPath(import.meta.url)); // apps/api/src (or dist)
const API_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(API_ROOT, "..", "..");
```

`HERE` is now `…/src/common`, so each anchor sits one directory too shallow.
Measured on 2026-09-25 by importing the module with the env set inline:

| Constant | Resolves to (dev) | Should be |
|---|---|---|
| `DATA_DIR` | `apps/api/src/data` | `apps/api/data` |
| `LIBRARY_FILES_DIR` | `apps/api/src/library` | `apps/api/library` |
| `THUMBNAILS_DIR` | `apps/api/src/images/thumbnails` | `apps/api/images/thumbnails` |
| `LATEX_PROJECTS_DIR` | `apps/api/src/latex` | `apps/api/latex` |
| `DOCUMENT_VERSIONS_DIR` | `apps/api/src/versions` | `apps/api/versions` |
| `ENV_FILE` | `apps/.env` (absent) | `<repo>/.env` |

In the built output the same arithmetic yields `apps/api/dist/data` and so on.

**Nothing fails loudly, and that is the dangerous part.**
[`knex.ts:36`](../../../apps/api/src/database/knex.ts) runs
`mkdirSync(DATA_DIR, { recursive: true })` and the migrations run against a
brand-new file. The API boots and serves an **empty library** as if that were
true, and every upload lands in the wrong directory.

Consequences:

- **Local dev:** the root `.env` is never loaded. From a clean shell,
  `npm run dev` exits with "Invalid or missing environment configuration" even
  though `.env` exists, which was verified with `env -i`.
- **Deploy:** the container
  ([`infrastructure/Dockerfile`](../../../infrastructure/Dockerfile)) bind-mounts
  the real library at `/app/apps/api/{data,library,images}`. The API would open
  `/app/apps/api/dist/data/library.db` inside the container layer instead:
  - the real books on the bind mounts become invisible;
  - new uploads land in the container layer and are lost on the next recreate.

  vps-deploy's `stacks/atrium.ts` sets none of the five root overrides, so nothing
  corrects the defaults.

The verification after brief 52 missed this because every run redirected all
five roots inline, per the practice in
[open-questions.md](../../wiki/open-questions.md). **The defaults were the one
configuration never exercised.** This is the same class as the 2026-08-25 and
2026-08-29 incidents: a storage root silently pointing somewhere unintended.

## Scope

**In:** correct root resolution; a guard that makes a wrong anchor fail loudly; a
startup log of all five resolved roots; a guard against creating a fresh database
beside a populated library.

**Out:** the container's volumes and `.dockerignore` (brief 55); changing
`paths.ts` derivations; any migration.

## Files you OWN

- `apps/api/src/common/config.ts`
- `apps/api/src/index.ts` (the "API ready" log line only)
- `apps/api/src/database/knex.ts` (or `database/bootstrap.ts`, whichever is the
  cleaner home for the fresh-database guard)

## Files you must NOT touch

- `apps/api/src/common/paths.ts`: the derivations are correct; only their roots
  were wrong.
- `infrastructure/**`, which brief 55 owns.
- `apps/api/data/`, `library/`, `images/`, `latex/`, `versions/`: the **real
  library**. See the warning under Acceptance.

## What to do

1. **Anchor on the package, not on the file's depth.** Resolve `API_ROOT` so a
   future move cannot shift it silently. Two acceptable ways:
   - walk up from `HERE` to the first directory whose `package.json` has
     `name === "@ebook-reader/api"`; or
   - use `resolve(HERE, "..", "..")` and then **assert** that
     `API_ROOT/package.json` exists with that name, throwing a message naming
     both paths.

   `REPO_ROOT` follows from `API_ROOT`. Fix the stale `// apps/api/src (or
   dist)` comment either way.
2. **Log the five resolved roots once at startup.** Add them to the existing
   "API ready" line in `index.ts`, plus the `.env` path and whether it was
   loaded. After two incidents about roots pointing at the wrong place, this
   costs a line and makes the next one visible in the first log line.
3. **Refuse to create a fresh database beside a populated library.** If
   `DB_PATH` does not exist when the API starts, but `LIBRARY_FILES_DIR` or
   `THUMBNAILS_DIR` already contains entries, stop with a message naming all the
   resolved paths. That combination is this bug, or a half-redirected test root:
   never a normal first boot. A legitimately empty first boot (no DB, empty
   directories) must still work.

## Acceptance

- `config.ts` resolves every root to `apps/api/<root>` both from `src` under
  `tsx` and from the built `dist`. Show this by importing the module and printing
  the constants, **not by booting the server** (see the warning below).
- With only the repo-root `.env` present and a clean environment, the config
  module loads without the "Invalid or missing environment" exit.
- If the anchor is wrong (simulate by pointing the check at a directory with no
  API `package.json`), startup fails with a message rather than resolving
  somewhere new.
- The fresh-database guard, exercised against a scratch base:
  - an empty DB path plus a non-empty files directory → refuses to start;
  - both empty → boots.
- The startup log names all five roots.
- Typecheck and build are clean.
- If [brief 63](63-api-test-harness.md)'s harness has landed, pin the resolution
  in a test.

**Do not "prove" the fix by booting the API on its defaults on this machine.** The
defaults *are* the real library. Show resolution by printing. Boot only with all
five roots set **inline** to a scratch base and asserted before start, per
[open-questions.md](../../wiki/open-questions.md).

**Before deploying the fix,** check whether production ran any build after
`0cf1e7f`. If it did, the running container may hold rows and uploads under
`/app/apps/api/dist/{data,library,images}` that exist nowhere else. Copy them out
before the fix points the API back at the real library.
