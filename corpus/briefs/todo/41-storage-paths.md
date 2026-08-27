# Task 41 — Storage: portable paths, redirectable dirs, and the offline rename

**Closes all three entries in [open-questions.md](../../wiki/open-questions.md)**,
grilled with the owner 2026-08-27. Records **D39**.

**Build this before [brief 38](38-latex-editor.md).** 38 is the next brief to
touch `apps/api` and `apps/web`, and it inherits the data-safety hazard this
brief retires. Doing 41 first means 38's verification can be sandboxed properly
instead of relying on discipline.

## Context

Three separate-looking problems, one root cause: **the API stores absolute
filesystem paths in the database, and two of its three storage roots cannot be
redirected.**

### The hazard this exists to kill

`LIBRARY_DATA_DIR` redirects the **database only**. `LIBRARY_FILES_DIR` and
`THUMBNAILS_DIR` resolve from the API package's own location
([config.ts:114-116](../../../apps/api/src/config.ts#L114-L116)) and have no
override. So pointing the API at a *copied* database does **not** sandbox the
files: the copied rows still carry absolute paths into the real
`apps/api/library/` and `apps/api/images/thumbnails/`, both gitignored, neither
with any version history.

**This has already destroyed one of the owner's books** (2026-08-25, brief 34
verification — recovered only because a byte-identical orphan happened to be on
disk from an earlier deletion). The standing mitigation is a practice, not a
mechanism: *upload a throwaway fixture and act on that, never on a pre-existing
row.* A practice re-learned by every future agent from a comment block is not a
control.

### The portability bug it shares a cause with

Rows created under an old checkout 500 (now 404) on `GET /library/:id/file`
because `file_path` persists an absolute path that no longer exists. The cover
half was partly mitigated 2026-07-20 by a startup reconcile that nulls a missing
`cover_path`; the file half has been open since 2026-07-07 and cannot self-heal
because `file_path` is `NOT NULL`.

### What makes the fix cheap

**Every write already derives its path.** `filePathFor(id, format)` and
`coverPathFor(id)` ([library-routes.ts:99-103](../../../apps/api/src/library-routes.ts#L99-L103))
are what uploads, catalog downloads and conversions all use. Only *reads* go
through the stored column. So the stored path is already redundant with a
derivation the code performs everywhere else — it is a cache of a pure function,
and the only thing it can do is disagree.

**Cover ownership is already encoded.** A converted book reuses its source's
thumbnail rather than re-extracting, so both rows hold the *same* `cover_path`
([db.ts:915-927](../../../apps/api/src/db.ts#L915-L927)) and the delete path is
careful about it ([library-routes.ts:478-492](../../../apps/api/src/library-routes.ts#L478-L492)).
That relationship is exactly `converted_from ?? id` — the derivation needs **no
new ownership column**.

## Decisions taken (D39, grilled 2026-08-27)

1. **Both halves, not one.** Env overrides *and* derived paths. Overrides alone
   leave the library non-portable; derivation alone leaves the test hazard open,
   because the dirs would still resolve from the package location regardless of
   which database you point at.

2. **The disk is the single source of truth for covers.** `cover_path` is
   dropped outright and `hasCover` becomes "does the derived file exist". The DB
   then *cannot* disagree with the disk, which **deletes `reconcileMissingCovers`
   and `clearCoverPath` entirely** — they exist only to repair a drift that stops
   being representable. Cost accepted: one `stat` per book per `GET /library`.
   At this library's size that is a few milliseconds against a warm page cache,
   and it buys the removal of a whole bug class.

3. **`fraction` → `progress`, IndexedDB v5, now.** The same 0..1 quantity is
   `progress` on the wire and `fraction` in the offline store, and
   [glossary.md](../../wiki/glossary.md) already names `progress` canonical.
   Rejected: deferring to "the next migration", because nothing schedules one —
   that is the status quo with a note attached.

## Scope

**In:**

- **`LIBRARY_FILES_DIR` and `THUMBNAILS_DIR` become optional env overrides**,
  exactly like `LIBRARY_DATA_DIR`: `resolve(process.env.X)` when set, the
  current package-relative default otherwise. **Not** added to the required
  D29 contract — they are deploy/test overrides. Document both in
  `.env.example` alongside `LIBRARY_DATA_DIR`, and say what they are *for*.
- **Derive the original file path** at all eight read sites from
  `filePathFor(row.id, row.format)`. `GET /library/:id/file` (both the ranged
  and unranged branches), the delete paths, the convert paths, the metadata
  backfill re-extract.
- **Derive the cover path** as `coverPathFor(row.converted_from ?? row.id)`.
- **`hasCover` = the derived cover file exists.** Replace the `cover_path !==
  null` test in `toWire()`.
- **Drop both columns** from `books`, and delete the statements and helpers
  that only served them: `reconcileMissingCovers`, `clearCoverPath`,
  `statements.withCover`, and the boot-time reconcile call in the API's startup
  path. `insertConvertedBook` stops copying `cover_path`; its doc comment about
  one file with two rows moves to `coverPathFor`, because the *relationship* is
  still true and is now what the derivation encodes.
- **IndexedDB v5**: `DB_VERSION` 4 → 5, an `onupgradeneeded` step that rewrites
  each `PROFILE_PROGRESS_STORE` record `{fraction, …}` → `{progress, …}`, and
  the rename through the ~7 files that touch the persisted field
  (`offline-store.ts`, `use-progress-sync.ts`, `use-hydrate-book.ts`,
  `use-library.ts`, `library-api.ts`, `reader-store.ts`,
  `use-media-progress.ts`). **Leave every unrelated `fraction` alone** — swipe
  zones, nib widths and the dock scrub line are different quantities that share
  an English word.

**Out:** any change to what a cover *is* or how it is extracted (that is
[brief 42](42-video-covers.md)); renaming `LIBRARY_DATA_DIR`; making the
overrides required; touching `books.progress` (the legacy global column D31
superseded — leave it exactly as it is, it is not this brief's fight).

## Files you OWN

- `apps/api/src/config.ts` — the two overrides, and **delete the warning block**
  that documents the hazard, because the hazard is gone. Replace it with a short
  note saying all three roots are redirectable together.
- `apps/api/src/db.ts` — the `books` migration, `BookRow`, `toWire`,
  `insertConvertedBook`, and the removed statements
- `apps/api/src/library-routes.ts` — the read sites and the reconcile removal
- `apps/api/src/catalog-routes.ts`, `apps/api/src/convert-jobs.ts` — path
  derivation
- `apps/api/src/index.ts` — the boot reconcile call
- `apps/web/src/lib/offline-store.ts` and the six other web files above
- `.env.example`

## Files you must NOT touch

- `packages/typeset/**` — brief 37 is done and this brief has nothing to do
  with it.
- `apps/web/src/library/CoverCard.tsx` — brief 42 owns the video gate. This
  brief changes where a cover *comes from*, not which kinds display one.
- Anything under `corpus/briefs/done/`.

## What to do

1. **The overrides first, and alone.** They are the smallest piece and they are
   what makes step 2 testable safely — with all three roots redirected, a
   scratch database and scratch files finally move together. Prove it: point all
   three at a temp dir, upload a fixture, confirm nothing lands in
   `apps/api/library/`.

2. **Derive the original file path.** Read sites only; the write sites already
   do this. Every row created normally already has `stored == derived`, so this
   is a no-op for healthy rows and a *repair* for rows from an old checkout.

3. **Derive the cover path and flip `hasCover` to a `stat`.** Then delete the
   reconcile machinery. Check the linked-row case explicitly: a converted book
   and its source must both report `hasCover: true` from the *source's* file.

4. **Drop the two columns.** SQLite's `ALTER TABLE … DROP COLUMN` is available;
   follow whatever migration idiom `db.ts` already uses. Both columns are
   recomputable from `id`/`format`/`converted_from`, so nothing is lost — say so
   in the migration comment, because a future reader will ask.

5. **IndexedDB v5.** The v3→v4 upgrade at
   [offline-store.ts:265-291](../../../apps/web/src/lib/offline-store.ts#L265-L291)
   already did this exact shape against real data successfully — follow it,
   including its care about not dropping a store while a cursor reads it.

6. **Corpus**: record **D39** in [decisions.md](../../wiki/decisions.md), delete
   **all three** entries from [open-questions.md](../../wiki/open-questions.md),
   update [status.md](../../wiki/status.md) and [log.md](../../log.md).

## ⚠️ Verification is the risky part of this brief

The migration runs against the owner's **real library**, which has no version
history and one manual backup outside the repo.

- **Prove the migration on a copy first** — and now you can do it properly:
  copy the DB *and* both file directories to a temp root, point all three env
  vars at it, run the migration there, and confirm every book still serves its
  file and its cover.
- **Only then** run it against the real database.
- The DATA-SAFETY RULE still applies while the overrides do not yet exist: until
  step 1 lands, do not run any destructive route against a pre-existing row.
- Verify the v5 upgrade in a real browser with existing offline data, not only a
  fresh profile — an upgrade path that works on an empty database proves nothing.

## Acceptance

- All three storage roots are redirectable by env, documented in `.env.example`,
  and pointing them at a temp dir provably sandboxes uploads, covers, conversions
  and deletes.
- `books` has no `file_path` and no `cover_path`. Every path is derived.
- A row whose underlying file is missing still 404s cleanly and never 500s.
- A converted book and its source both report `hasCover: true`, and deleting
  **either one** leaves the other's cover intact — the regression this
  derivation most plausibly introduces.
- `reconcileMissingCovers` and `clearCoverPath` are gone, and no boot-time
  reconcile runs.
- The offline store is at v5, the persisted field is `progress`, and a browser
  holding v4 data upgrades without losing a single progress record.
- Unrelated `fraction` identifiers are untouched.
- `npm run typecheck`, `npm run build` and `npm test` all clean.
