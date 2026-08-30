# Task 52 — restructure `apps/api` into modules, and move the data layer to Knex

**Filed and built 2026-08-30**, at the owner's direct request: *"refactor the api
to be organized in a model with modules, controllers, services and models"* and
*"use knex library for database interactions"*.

## Context

`apps/api/src` was 18 flat files, ~440 KB of TypeScript, with two shapes doing
most of the work: six `*-routes.ts` files that mixed HTTP with business rules,
and one **2,210-line `db.ts`** that held every row type, all 63 query functions,
the whole schema, every migration, and the boot-time reapers — all executed as a
side effect of `import`.

The owner asked for two changes. They are separable, and the second one was
raised as a conflict before any code was written:

**D24 locks `better-sqlite3` and names its *synchronous API* as the reason.**
Knex has no synchronous mode. Adopting it turns all 63 data functions async and
propagates `await` through every caller, and — more sharply — it removes the
implicit atomicity that several guards in this codebase were silently relying on
(see "The three real bugs" below). The owner was shown the conflict, the blast
radius, and the fact that `apps/api` has **no test suite at all**, and chose to
do both in one pass and revisit D24. That choice is D47.

## Scope

**In:**
- `src/modules/<domain>/` for auth, profiles, library, catalog, notes, latex —
  each with a **controller** (HTTP), a **service** (rules), and a **model**
  (SQL), plus mappers and domain services where they earn a file.
- `src/database/` — the Knex instance, one **baseline migration**, the migration
  source, and `bootstrap.ts` (migrations + the boot-time data repairs).
- `src/common/` — `config.ts`, `paths.ts`, `password.ts`.
- `src/app.ts` (build the Fastify instance) split from `src/index.ts` (bring the
  database up, listen, shut down).
- Every `db.ts` query rewritten as a Knex query; the `await` cascade carried
  through every caller including both seed scripts.

**Out:** any change to the wire contract, to `packages/shared`, or to `apps/web`.
No route was added, removed, or renamed. No behaviour was intended to change.

## Files owned

Everything under `apps/api/src` and `apps/api/scripts`. Nothing else.

## The three real bugs the async move exposed

These are the substance of the brief. Each was a correctness property that held
**only** because `better-sqlite3` was synchronous, and each would have broken
silently under Knex.

**1. The conversion single-flight (D34 decision 6).** `startConvert` read
`getRunningConvert()` and then wrote `markConvertRunning()`. On one thread those
two statements could not be interleaved; as promises they can, so two concurrent
`POST /library/:id/convert` calls would both find the slot free and both spawn
`ebook-convert`. Fixed by moving the decision into SQL:
`claimConvertSlot()` is one `UPDATE … WHERE id = ? AND NOT EXISTS (…running…)`,
atomic regardless of scheduling. The loser reads the running row only to name it
in the 409.

**2. The compile single-flight (brief 38 step 3).** Same shape, but the guard has
an in-process half as well as a durable one. Fixed by making the **in-process
claim** the guarantee: `runningLatexCompileInProcess()` and the `jobs.set()` that
follows it are now an explicitly marked region with **no `await` between them**,
so two callers serialise on the map. The durable read stays in front of it as a
cheaper, earlier refusal.

**3. `cancelAndSettleLatexCompile` could stop waiting.** `job.done` was assigned
*after* the status write. With an `await` in between there was a window where a
job in the map had `done === null` — and the delete path does
`await job.done?.catch(…)`, which on `null` returns **immediately, reporting that
it waited**. `DELETE /latex/:id` would then `rm -r` the tree, the compile would
start afterwards and recreate `.atrium-build/`, and those bytes would be orphaned
for the life of the installation. Fixed by scheduling inside the atomic region,
so every job reachable through `jobs` has a promise to wait on.

One window was **accepted rather than closed**, and is documented at
`releaseCompileRow`: the map entry is freed before the row write lands, so a
compile request arriving in between reads a stale `running` and gets a
retry-able 409. Closing it would mean deleting the map entry only *after* the
write, which reopens the far worse failure the ordering exists to prevent — a
throwing write leaving the in-process slot claimed forever.

## The migration strategy, and why it is one idempotent file

There was never a numbered migration history to replay: `db.ts` ran
`CREATE TABLE IF NOT EXISTS` plus a chain of hand-guarded `ensure*` functions on
**every boot**. So a live database arriving at Knex is already fully migrated
but has no `knex_migrations` row saying so, and a fresh one is empty.

`20260830000000-baseline.ts` therefore has to be correct on both, and every
guard in it is for that. **Migrations added after it are ordinary forward
migrations and must not be written idempotently** — that is the whole point of
adopting a runner, and it is stated at the top of the file.

Two mechanical choices worth keeping:
- **Migrations are static imports, not a scanned directory.** Knex's `directory:`
  source picks a loader by file extension, which does not survive this build:
  `.ts` under tsx in dev, `.js` under `dist/` in production, and `tsc` copies no
  `.ts` into the output. A `migrationSource` backed by an array means dev and
  production run byte-identical code.
- **`disableTransactions: true`.** The baseline toggles `PRAGMA foreign_keys`,
  which SQLite refuses inside a transaction, and opens its own transaction
  around the profile-scope rebuild.

The pool is pinned to **one connection** (`min: 1, max: 1`): `foreign_keys` is
per-connection, and `knex.transaction()` holds a connection for its duration, so
one connection is what restores the exclusivity `better-sqlite3` gave for free.

## Acceptance criteria

- [x] `npm run typecheck` and `npm run build` clean across the monorepo.
- [x] `npm test` — 647/647 (the `packages/typeset` suite; unaffected, confirming
      no collateral damage).
- [x] Baseline migration on a **fresh** database produces a schema whose tables,
      columns and indexes match the pre-refactor `db.ts` output exactly.
- [x] Baseline migration on a **copy of the live database** (5 books, 3 users,
      4 profiles, 2 notes, 1 LaTeX project, 9 progress rows, 39 sessions)
      preserves every row count, adds the missing `note_folders` table and
      `notes.folder_id`, and reports no `foreign_key_check` violations. Re-running
      it is a no-op.
- [x] 128 live requests against the refactored server on that copy, covering
      every route group: auth + session revocation, profiles (incl. the
      `NAME_TAKEN` 409 from the unique index and the `PROFILE_HAS_NOTES` 409 from
      `ON DELETE RESTRICT`), preferences merge + unknown-key passthrough, library
      list/read/upload/stream/cover, ETag → 304, byte ranges (206, suffix, 416),
      progress with locator preservation, notes + folders (incl. `FOLDER_CYCLE`
      and lift-on-delete), note PDF export, LaTeX CRUD, path-traversal refusals,
      compile, publish (two versions on one card), and every delete path's
      artifact rules.
- [x] **6 concurrent compiles across two projects → exactly one 202, five 409s.**
- [x] **6 concurrent converts across two books → exactly one 202, five 409s, and
      exactly one row in `convert_status = 'running'`.**
- [x] Graceful SIGTERM shutdown; no unhandled rejections in the whole run; the
      only two error-level log lines are the offline Gutendex calls.
- [x] Session tokens still redacted in logs (0 plaintext occurrences).
- [x] The **real** `apps/api/data/library.db` and its files untouched — all work
      ran against a copy with all five storage roots redirected (D39).

## Known gap

`apps/api` still has **no automated tests**. Everything above was verified by
migration inspection and live request exercise, both reproducible but neither
committed. That is the same gap the refactor started with; it is now much
cheaper to close, because the model layer is a set of plain async functions with
one seam (`knex`) rather than a 2,210-line module with import-time side effects.
Worth its own brief.
