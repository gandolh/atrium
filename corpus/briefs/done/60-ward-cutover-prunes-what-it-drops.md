# Task 60 — The Ward cutover's prune actually removes what it orphans

**Filed 2026-09-25** by the improvements sweep. **Owner gate before this runs on
production:** see "Before running".

## Context

D53 decided on a **full prune**: "the cascade takes profiles and everything under
them". The migration that implements it does not prune anything under the
profiles.

[`20260906000000-ward-cutover.ts`](../../../apps/api/src/database/migrations/20260906000000-ward-cutover.ts)
turns foreign keys **off** (`:49`), then drops and rebuilds `profiles`
(`:58-81`). Its comment says "Their children go with them by cascade" (`:31`),
and the code relies on that. Two things make it false:

1. **With `foreign_keys = OFF`, SQLite's `DROP TABLE` does no implicit `DELETE`**,
   so no `ON DELETE` action fires
   ([SQLite: foreign keys §5](https://www.sqlite.org/foreignkeys.html)).
   Reproduced during the sweep on an in-memory replica: every child row survived,
   and `PRAGMA foreign_key_check` reported one violation per row.
2. **`notes` and `note_folders` are `ON DELETE RESTRICT`, not CASCADE**, and have
   been since brief 35 made deleting a profile with notes a refusal
   (`PROFILE_HAS_NOTES`). See
   [`baseline.ts:205, 239`](../../../apps/api/src/database/migrations/20260830000000-baseline.ts).
   Even with foreign keys on, the drop would have been refused rather than
   cascading.

After the cutover, every pre-cutover row in `reading_progress`, `notes`,
`note_folders` and `latex_projects` points at a profile id that exists nowhere.
The rebuilt `profiles` table has the same name, so the children's `REFERENCES
profiles(id)` now binds to it, and every orphan is a live integrity violation.
The consequences:

- Data D53 decided to destroy is **kept**, unreachable.
- The pruned projects' `latex/<id>/` trees are never removed, because only a
  row-driven delete removes one.
- **A trap for the next table rebuild.** Any future migration that asserts
  `PRAGMA foreign_key_check`, as the baseline's `migrateToProfileScope` does
  (`baseline.ts:436`), will throw and **stop the API from booting**.

## Before running (owner gate)

**Stop and ask the owner before this migration runs against the production
database.** If production has already run the cutover, the orphaned rows are the
**only remaining copy** of the household's pre-cutover notes and LaTeX drafts.
Pruning them carries out D53 as written, and it is also irreversible. Present:

- the orphan counts per table;
- the choice: prune (D53), or first re-point them to the owner's new `Default`
  profile as a one-off, which would be a D53 revisit plus a log note.

Take a database copy either way (D53 already requires one).

## Scope

**In:**
- a new forward migration that deletes orphaned profile-scoped rows and proves
  the database is referentially clean;
- **comment-only** corrections in the cutover migration.

**Out:**
- changing the cutover migration's behaviour, since it may already have run
  somewhere;
- deleting `latex/<id>/` directories from a migration, since migrations own SQL
  only ([api-layering.md](../../wiki/api-layering.md));
- a boot-time directory sweep, which is D46-class and would need its own owner
  decision.

## Files you OWN

- `apps/api/src/database/migrations/20260925000000-prune-cutover-orphans.ts`
  (new; take a later timestamp if one exists)
- `apps/api/src/database/migrations/index.ts`: register it **by static import**,
  as the page above requires
- `apps/api/src/database/migrations/20260906000000-ward-cutover.ts`: comments only

## Files you must NOT touch

- `20260830000000-baseline.ts`, and every model file.

## What to do

1. **Follow the baseline's own foreign-key dance:**
   - `PRAGMA foreign_keys = OFF` outside any transaction (it is ignored inside
     one);
   - then a transaction that deletes, from `reading_progress`, `notes`,
     `note_folders` and `latex_projects`, every row whose `profile_id` is not in
     `profiles`;
   - then `PRAGMA foreign_key_check` **inside** the transaction must return zero
     rows, or throw and roll back;
   - then foreign keys back on in a `finally`.
2. **Before deleting, collect the orphaned `latex_projects` ids and log them**
   with a count (`console.warn`, since migrations have no Fastify logger). The
   operator can then remove those `latex/<id>/` trees by hand. Published books in
   `books` are **not** touched: D37 keeps a published document independent of its
   draft, via `published_book_id … ON DELETE SET NULL`.
3. **Write it as an ordinary forward migration.** It is naturally a no-op on a
   database with no orphans, but it must not branch on its own history
   ([api-layering.md](../../wiki/api-layering.md)).
4. **Correct the cutover's comments** (`:20-33`, `:60-62`). Say what it actually
   does, and point at this migration for the prune.

## Acceptance

Run each case against a scratch copy, with all five storage roots set inline and
asserted before start:

- **A pre-cutover database with notes, folders, progress and a LaTeX project:**
  after boot, those tables hold no orphans, `PRAGMA foreign_key_check` is empty,
  and the orphaned project ids appear in the log.
- **A published book from a pruned project** is still in the library and still
  opens.
- **A database created fresh after the cutover:** the migration is a no-op.
- **An API that boots against a database the cutover already ran on:** the prune
  runs cleanly.
- Typecheck and build are clean.

## Outcome (2026-10-03)

Done in code and tests. **The owner gate still stands.** Nothing has been pushed or deployed. The next deploy runs this migration on production, so the owner has to see the orphan counts on the production database first, and choose between pruning (D53) and re-pointing to `Default`, with a copy taken either way.

**The migration** (`20260925000000-prune-cutover-orphans.ts`, registered by static import):
- Foreign keys go off outside the transaction.
- Inside it:
  - count orphans per table;
  - `console.warn` the orphaned LaTeX project ids, so the operator can remove `latex/<id>/` by hand;
  - set `folder_id` to NULL on a *surviving* note filed in an orphaned folder, which is what its `ON DELETE SET NULL` would have done;
  - delete orphans from `reading_progress`, `notes`, `note_folders` and `latex_projects`;
  - log the counts;
  - require `PRAGMA foreign_key_check` to be empty, or throw and roll back.
- Foreign keys go back on in `finally`.
- `down` is a no-op.
- It has no history branch: with no orphans every statement matches nothing.

**The cutover's comments** now say what it does: the children survive the drop, because foreign keys are off and two of the FKs are `RESTRICT`. They point at the new migration. The diff is comment-only.

**Tests** (`test/cutover-prune.test.ts`). The database starts at the baseline alone and is seeded with a household: user, profile, progress, a folder holding a note, and a LaTeX project whose published book has a version.
- The cutover by itself leaves all four child rows and 4 FK violations.
- The prune empties them, logs the project id, and leaves `foreign_key_check` empty.
- The published book and its version survive, and `GET /library/b2/file` serves it to a new subject.
- A re-run is a silent no-op.

The prune test fails with the migration unregistered. The fresh-database case is `migrations.test.ts`, which is still green. 34 API tests pass, and typecheck and build are clean.

**A real pre-cutover database.** A copy of the local `apps/api/data/library.db` (2026-08-25, pre-Knex, 3 users, 3 profiles, 8 progress rows, 2 notes, 5 books) went to a scratch base with all five roots asserted.
- `runMigrations` ran baseline → cutover → prune.
- It logged `pruned orphaned rows: {"reading_progress":8,"notes":2,"note_folders":0,"latex_projects":0}`.
- Every scoped table ended empty, all 5 books stayed, and there were 0 FK violations.
- The original file's hash was unchanged.

**For the owner.** That local database is a development copy, not production. It shows what this does to a database that has not yet booted past the cutover: the two notes and eight reading positions are deleted. Production's own counts must be taken there before deploy, with the same queries:

```sql
SELECT COUNT(*) FROM <table> WHERE profile_id NOT IN (SELECT id FROM profiles)
```

**Addendum (2026-10-04): the owner chose prune.** Asked directly, the owner
chose D53 as written over re-pointing the orphans to `Default` (recorded on
D53's row). The gate's remaining step is mechanical: copy the production
database before the deploy that runs this migration.
