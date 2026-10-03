# Task 66 — The notes list and the profile-delete check never load the ink

**Filed 2026-09-25** by the improvements sweep. Opening the Notes tab reads and
parses every stroke of every notebook just to count pages.

## Context

`NoteSummary` is documented as the "lightweight row for the notes list (no page
contents)" ([`packages/shared/src/notes.ts:320`](../../../packages/shared/src/notes.ts)).
The query behind it loads the page contents anyway:

- [`listNotes`](../../../apps/api/src/modules/notes/notes.model.ts)
  (`notes.model.ts:31-35`) selects **every column**, including `data`, the whole
  notebook's JSON.
- [`toSummary`](../../../apps/api/src/modules/notes/notes.mapper.ts)
  (`notes.mapper.ts:39-47`) then `JSON.parse`s each row's `data`, only to read
  `.length` for `pageCount`.

Every `GET /notes` therefore:
1. moves every notebook's ink through the single database connection (D47);
2. parses it on the event loop;
3. throws it away.

The same query is reused twice in
[`profiles.service.ts`](../../../apps/api/src/modules/profiles/profiles.service.ts)
just to count notes before a profile delete (`:156`, `:210`). That use also
reaches across the layering rule, because the service imports the **notes
model** directly (`:15`) rather than a notes function
([api-layering.md](../../wiki/api-layering.md)).

This is small today, with two notes totalling 10 KB. It grows linearly with ink,
and [brief 56](../done/56-notes-autosave-reliable.md) is about to let a single notebook
grow past 1 MiB. Land this with or after it.

## Scope

**In:** the list query, the summary mapping, and a count for the profile checks.

**Out:** the note editor's own load (`GET /notes/:id` legitimately needs the
ink); pagination; indexes.

## Files you OWN

- `apps/api/src/modules/notes/notes.model.ts`
- `apps/api/src/modules/notes/notes.mapper.ts`
- `apps/api/src/modules/notes/notes.service.ts`: export a count for the profiles
  module to call
- `apps/api/src/modules/profiles/profiles.service.ts`: use that instead of the
  notes model

## Files you must NOT touch

- `packages/shared/src/notes.ts`: the wire shape does not change.
- `apps/web/**`.

## What to do

1. **Select only what the list needs.** In `listNotes`, select `id`, `title`,
   `updated_at` and `folder_id`, plus the page count computed in SQL. The stored
   `data` is a JSON array of pages, and `parsePages` treats anything else as
   zero pages. Match that exactly:
   `CASE WHEN json_valid(data) AND json_type(data) = 'array' THEN
   json_array_length(data) ELSE 0 END AS page_count`.
   The JSON1 functions are compiled into `better-sqlite3`'s bundled SQLite.
2. **Map the count.** `toSummary` reads `page_count`, and nothing on the list path
   parses JSON.
3. **Add a scoped count.** A `countNotes(profileId)` in the notes module (one
   `count(*)`), called by both profile checks through the notes **service**.

## Acceptance

- `GET /notes` returns byte-identical JSON before and after, over a scratch
  database containing:
  - several notes;
  - one note whose `data` is malformed JSON (`pageCount: 0` before and after);
  - one whose `data` is a JSON object rather than an array (also `0`).
- The list query's SQL (log it once, or read `.toSQL()`) no longer selects `data`.
- Deleting a profile with notes still refuses with `HAS_NOTES` and the right
  `noteCount`, and deleting one without notes still succeeds.
- Typecheck and build are clean.
- Verify against a scratch base with all five storage roots set inline and
  asserted before start.

## Outcome (2026-10-03)

Done.

**Change:**
- `listNotes` selects `id`, `title`, `updated_at` and `folder_id`, plus `CASE WHEN json_valid(data) AND json_type(data) = 'array' THEN json_array_length(data) ELSE 0 END AS page_count`, and returns a `NoteSummaryRow`.
- `toSummary` maps `page_count`, so the list path parses no JSON.
- `countNotes`/`countProfileNotes` is one `count(*)`.
- The profile-delete checks, the refusal and the RESTRICT-race fallback, call it through the notes **service**.
- So does the reassign step, through a new `reassignProfileNotes`. `profiles.service.ts` had also imported `reassignNotes` from the folders model, the same layering break. No module outside `notes/` imports a notes model now.

**Tests** (`test/notes-list.test.ts`):
- The list holds a 3-page and a 1-page note, malformed JSON and a JSON object; the counts are 3, 1, 0, 0.
- No `notes` query in the request selects `*` or `data`, shown with a knex `query` listener.
- A non-default profile with two notes refuses deletion with 409 and `noteCount: 2`, and an empty one deletes.
- On the old code only the SQL assertion fails; the counts and the refusal already held.
- 63 API tests pass, and typecheck and build are clean.

**Byte-identical.** One scratch database (all roots asserted) with a 1-page note, a 3-page note, malformed JSON and a JSON object was served by the old code, then the new. `GET /notes` was identical: 469 bytes, `cmp` clean.
