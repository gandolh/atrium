# Task 50 — folders for notes

**Promoted 2026-08-29** from the `notes-tab` epic, where folders were listed as a
v1 follow-up (Samsung Notes has folders/subfolders) and left unspecified. Owner
selected it on 2026-08-29. Independent of briefs 49 and 51.

## Context

The notes list is flat
([`NotesList.tsx`](../../../apps/web/src/notes/NotesList.tsx) — a left column of
title / page count / relative date, restyled onto Reading Room in
[brief 33](../done/33-notes-destination.md)). Notes are per-profile:
`notes.profile_id REFERENCES profiles(id) ON DELETE RESTRICT`
([`db.ts:385-392`](../../../apps/api/src/db.ts)) — note the **RESTRICT**, which
differs on purpose from the LaTeX tables' CASCADE.

**An honest caveat the owner should weigh before this is dispatched:** the real
library currently holds **2 notes**. Folders solve an organisation problem that
does not exist yet, and a flat list of two items is better UI than a tree of two
items. This brief is written to be correct whenever it is built; whether now is
the right time is a scheduling call, not a spec one.

## Scope

**In:** nested folders, notes filed into them, moving a note, renaming and
deleting a folder, and a list UI that reflects the tree.

**Out:** tags, colours, favourites, sort orders beyond what the list has. Out:
drag-and-drop as a *requirement* — a move control is enough; add DnD only if it
falls out for free. Out: folders for LaTeX projects or library media, which have
their own organisation and are not in scope here.

## Files you OWN

- `packages/shared/src/notes.ts` — the folder contract
- `apps/api/src/db.ts` — the `note_folders` table + migration, and the notes
  query changes
- `apps/api/src/notes-routes.ts` — folder CRUD + move
- `apps/web/src/notes/NotesList.tsx`, `use-notes.ts`, `notes-api.ts`
- tests beside the existing API tests

## Files you must NOT touch

- `apps/web/src/notes/NoteEditor.tsx` — the editor does not change. A note does
  not know or care what folder it is in.
- `apps/api/src/profile-routes.ts`, `latex-*`.

## What to do

1. **A `note_folders` table, not a path string.** `{id, profile_id, parent_id,
   name, created_at}` with `parent_id REFERENCES note_folders(id)`. Root is
   `parent_id IS NULL`. A path string cannot be renamed atomically and goes
   wrong the first time a name contains a separator.
2. **`notes` gains `folder_id`, nullable** — `NULL` is the root. Nullable is what
   makes this migration safe on the existing rows: every note that exists today
   stays exactly where the user last saw it, at the root, with no backfill.
3. **Match the existing FK discipline deliberately.** `notes.profile_id` is
   `ON DELETE RESTRICT` — a profile with notes cannot be deleted. Give
   `note_folders.profile_id` the same, and state in a comment why
   `notes.folder_id` uses `ON DELETE SET NULL` (deleting a folder must not
   delete notebooks — see 5). Brief 38 decision 11 set the precedent that these
   differences are chosen, not defaulted.
4. **Reject a cycle on the server.** `parent_id` makes a tree only if nothing
   ever sets a folder's parent to its own descendant. Walk up the chain on every
   create and move and refuse with a 400. A cycle here hangs the list render.
5. **Deleting a folder never deletes notes.** Move its notes and child folders to
   the deleted folder's parent. Losing a notebook to a mis-clicked folder delete
   is unrecoverable — notes are the one subsystem where the user *authored* the
   content rather than uploaded a copy of it.
6. **Scope every folder query by `profile_id`**, exactly as the note routes do.
   A folder id from another profile must 404, not resolve.
7. **List UI** — collapsible tree on Reading Room tokens, per D33; the active
   note keeps its 2px `accent` rule. Persist the collapsed set per profile in
   `localStorage` (it is a per-viewer convenience, not shared state). Run the
   `design.md` conformance checklist before calling it done.

## Acceptance

- Create nested folders, file notes into them, move a note between folders, and
  reopen the app — the tree is exactly as it was left.
- **Every note that existed before the migration is still present and openable**,
  sitting at the root. Demonstrated on a copy of the real library, not asserted.
- Deleting a folder holding notes and a subfolder **keeps all of them**, lifted
  to the parent.
- Setting a folder's parent to its own descendant is refused with a 400.
- A folder id belonging to another profile 404s.
- A profile that still has notes cannot be deleted (existing RESTRICT behaviour
  is unchanged by this brief).
- Typecheck + `apps/web` build clean; `design.md` checklist run.

**Verify against a scratch database with all five storage roots redirected, set
inline and asserted before the server starts** — this brief ships a schema
migration. See [open-questions.md](../../wiki/open-questions.md).

---

## Outcome (2026-08-30) — shipped, `77ce483`

`note_folders` with `parent_id`; `notes.folder_id` nullable, so every existing
note stays at the root with no backfill. Cycles refused server-side by walking
the parent chain (400 `FOLDER_CYCLE`). Deleting a folder lifts its notes *and*
child folders to the parent. Every folder query scoped by `profile_id`.

`parent_id` deliberately carries no `ON DELETE` clause: NO ACTION is checked at
end-of-statement, so `deleteProfile`'s one legitimate bulk delete works
regardless of row order while a single-folder delete that skipped the lift is
still refused.

**Consequential change, not scope creep:** the mandated `RESTRICT` on
`note_folders.profile_id` would have made `DELETE /profiles/:id` throw a raw FK
error for a profile with folders but no notes, and would have stranded reassigned
notes in folders the receiving profile cannot see. `reassignNotes` and
`deleteProfile` now move folders with the notes in one transaction. Brief 45's
ordering through that route is unchanged — verified.

Verified against a **copy** of the real library, which was itself only ever opened
readonly: both notes present, openable and byte-identical after migration; brief
49's export still returns a PDF; tree and collapsed state survive a restart. The
controller independently confirmed the real database has no `note_folders` table
and no `folder_id` column.

**Known and accepted:** sibling folders may share a name — a `(profile_id,
parent_id, name)` unique index would be a separate call.
