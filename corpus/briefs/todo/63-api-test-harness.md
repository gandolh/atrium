# Task 63 — `apps/api` gets a test harness that cannot touch the real library

**Filed 2026-09-25** by the improvements sweep. This closes the gap D47 named as
"the largest gap in the repo".

## Context

`apps/api` has **no automated tests**. D47 and
[status.md](../../wiki/status.md) (2026-08-30) both call that the largest gap in
the repo, and "much cheaper to close than it was". This sweep shows what it
costs. Four of its confirmed defects are the kind one request in a test would
have caught, and that typecheck and "verified by hand" did not:

- **[Brief 53](../done/53-storage-roots-resolve-from-api-package.md):** a file move
  shifted every default storage root.
- **[Brief 54](54-latex-compile-slot-keyed-on-subject.md):** a Knex column
  string named a column that no longer exists.
- **[Brief 61](61-ward-outage-is-503-not-signed-out.md):** the guard answers 401
  where D53 requires 503.
- **[Brief 60](60-ward-cutover-prunes-what-it-drops.md):** a migration's
  cascade never ran.

Most of the harness's seams already exist:

- [`app.ts`](../../../apps/api/src/app.ts) was split from `index.ts` "to make
  the app reachable from `app.inject`";
- `registerWardGuard(app, { client })` takes an injected client;
- `resetWardClientForTests()` exists
  ([`ward.guard.ts:91-111`](../../../apps/api/src/modules/ward/ward.guard.ts)).

Two import-time behaviours shape the design:

- [`config.ts`](../../../apps/api/src/common/config.ts) validates the environment
  **at import** and calls `process.exit(1)` on failure.
- [`knex.ts`](../../../apps/api/src/database/knex.ts) opens `DB_PATH` **at
  import**, creating the directory.

So every storage root must be set and **asserted** before the first `import` of
any API module. That is the practice [open-questions.md](../../wiki/open-questions.md)
adopted after the 2026-08-29 incident, now enforced by code instead of by
discipline.

## Scope

**In:**
- the harness: runner, setup, a fake Ward client, `buildApp` options;
- a first suite over behaviour that is correct today;
- a root `test` hook so `npm run test` runs it.

**Out:**
- tests for the fixes in briefs 53–62: each of those briefs adds its own
  regression test once this lands;
- web tests, and Playwright;
- CI.

## Files you OWN

- `apps/api/package.json`: a `test` script, and `typecheck` covering `test/`
- `apps/api/tsconfig.test.json` (new), on the pattern of
  `packages/typeset/tsconfig.test.json`
- `apps/api/test/**` (new)
- `apps/api/src/app.ts`: `buildApp(options?: { wardClient?: WardClient })`,
  passed through to `registerWardGuard`. Nothing else changes.

## Files you must NOT touch

- Every other file under `apps/api/src/**`. A test that needs a production change
  to pass is a finding for its own brief, not a patch here.
- `apps/api/data|library|images|latex|versions`.

## What to do

1. **Runner:** `node --import tsx --test 'test/**/*.test.ts'`. The sources use
   `.js` import specifiers, which Node's own type stripping will not remap and
   `tsx` (already a devDependency) will. Each test file runs in its own process,
   which is what lets each file own its own database.
2. **Setup that refuses to be unsafe** (`test/setup.ts`, loaded via `--import`):
   - create a fresh directory under the OS temp dir;
   - point **all five** roots at subdirectories of it;
   - set whatever `config.ts`'s schema requires at the time. Today that is
     `PORT`, `HOST`, `MAX_UPLOAD_MB`, `CONVERT_TIMEOUT_MS`,
     `CONVERT_JOB_TIMEOUT_MS` and the three `WARD_*`; brief 69 drops
     `CONVERT_TIMEOUT_MS`;
   - then import `config.ts` and **throw unless every exported root resolves
     inside that directory**.

   Nothing imports `knex.ts` before that assertion passes.
3. **Fake Ward:** implement `WardClient` so `authenticate()` returns a scripted
   `WardCaller` (subject, sid, grants) or throws the real error classes, keyed on
   a test cookie value.
4. **First suite, over behaviour that should hold today:**
   - **Guard:** no cookie → 401; the client throws `WardUnavailableError` → 503
     `IDENTITY_UNAVAILABLE`; a live session with no `atrium` grant → 403
     `NO_ATRIUM_GRANT`; granted → 200.
   - **First contact:** a first request provisions exactly one `Default` profile,
     and five concurrent first requests still produce one, with no 500.
   - **Profile scoping:** another subject's note, folder and LaTeX project ids
     answer **404**, never 403 ([api-layering.md](../../wiki/api-layering.md)).
   - **Library round trip:** upload a small fixture PDF, list it, fetch it (full,
     `Range: bytes=0-99` → 206, out of range → 416), delete it. The file and
     thumbnail are gone from the scratch roots.
   - **Migrations:** a fresh database migrates, and `PRAGMA foreign_key_check` is
     empty.
5. **Hook it into the root:** `npm run test` reaches the API through
   `--workspaces --if-present`. Brief 59 fixes the ordering that makes a clean
   checkout build first.

## Acceptance

- `npm run test -w @ebook-reader/api` passes, and fails loudly if the setup's
  root assertion is sabotaged (e.g. one root unset).
- A test run leaves the real storage directories byte-for-byte unchanged. Check
  file counts and mtimes before and after.
- Root `npm run test` runs both the typeset suite and this one.
- Typecheck covers `test/`, and typecheck and build are clean.
- The outcome note lists which briefs among 53–62 already have a regression test
  here, and which still need one.
