# Task 48 — reap orphan thumbnails on API startup

**Promoted 2026-08-29** from the `orphan-thumbnails` capture, filed the same day
while counting coverless items for
[brief 43](../done/43-coverless-tiles.md).

## Context

`apps/api/images/thumbnails/` holds **7** files; only **3** belong to a row in
`books`. The other four are left over from rows deleted in earlier checkouts.

Harmless today — nothing reads them, and D39 made `hasCover` a disk `stat` keyed
on the row's id, so an orphan can never be served as some other book's cover. It
is wasted disk and a small piece of confusion for anyone counting covers, which
is exactly how it was found.

**Direction matters here.** D39 deliberately *deleted* `reconcileMissingCovers`,
which handled the **opposite** case — a row pointing at a missing file — because
paths are now derived (`coverPathFor(coverOwnerId(row))`,
[`paths.ts:60,90`](../../../apps/api/src/paths.ts)) and that state is no longer
representable. This is the direction that survives, and it needs its own small
thing rather than a revival of that one.

## The trigger was an owner decision, and it carries a known risk

**Owner's call (2026-08-29): a startup sweep**, matching `backfillLibraryMetadata`
and `sweepInterruptedOutputs`
([`index.ts:105-112`](../../../apps/api/src/index.ts)).

The reviewed alternative was an on-demand admin route, on the grounds that this
sweep **deletes files on every boot** — including a boot nobody intended, which
is precisely what happened on 2026-08-29 when redirected storage roots silently
fell back to their defaults (see
[open-questions.md](../../wiki/open-questions.md)). The owner chose the startup
sweep anyway. **Because of that, the guards in "What to do" are not optional
polish — they are the reason this is safe to run unattended.**

## Scope

**In:** a startup sweep that lists `THUMBNAILS_DIR`, subtracts every live row's
`coverPathFor(coverOwnerId(row))`, and deletes the remainder.

**Out:** library files (`LIBRARY_FILES_DIR`), LaTeX project trees, and any
reconcile in the row→file direction. Out: any change to `hasCover`, D39's path
derivation, or the cover routes.

## Files you OWN

- `apps/api/src/library-routes.ts` — export the sweep beside
  `backfillLibraryMetadata`, which is the closest existing shape
- `apps/api/src/index.ts` — the boot call only
- `apps/api/src/db.ts` — only if a "every row that can own a cover" query does
  not already exist
- a test alongside the existing API tests

## Files you must NOT touch

- `apps/api/src/paths.ts` — `coverPathFor` / `coverOwnerId` are the authority
  this brief reads. If they seem to need changing, stop and say so.
- `apps/web/**`, `packages/**`.

## What to do

1. **Build the keep-set from every row, not from `listBooks`.** `coverOwnerId`
   resolves `converted_from ?? id` ([`paths.ts:90`](../../../apps/api/src/paths.ts)),
   so a converted book and its source **share one thumbnail**. Deriving the
   keep-set from a filtered or sorted list will delete a live cover. Take every
   row's `{id, converted_from}` and map both through `coverOwnerId`.
2. **Only ever delete a name this module could itself have written** — a
   basename matching the `<id>.jpg` convention. A stray file that does not match
   is not this sweep's business; leave it and log it.
3. **Never delete on a partial read.** If the row query throws, or the directory
   read throws, or the keep-set comes back **empty while the table is
   non-empty**, log and do nothing. An empty keep-set against a populated
   library means the query failed, not that every cover is an orphan — and
   without this arm that state deletes the entire thumbnail directory.
4. **Log every deletion by name, and log the count even when it is zero.** This
   sweep runs unattended and deletes files; a silent one is unauditable.
5. Fire-and-forget after `listen`, with a `.catch` that logs — the exact shape of
   `backfillLibraryMetadata` at [`index.ts:105`](../../../apps/api/src/index.ts).
   A failed sweep must never stop the API from serving.

## Acceptance

- Against a scratch library seeded with known orphans: the orphans are gone,
  every live cover survives, and **a converted book and its source still share
  their one surviving thumbnail** — the case that a naive keep-set breaks.
- A row whose thumbnail does not exist is untouched and produces no error (that
  is the D39 direction, and it is not this sweep's job).
- A non-matching file in the directory survives and is logged.
- With the books query stubbed to throw, or to return empty against a populated
  table, **nothing is deleted**.
- The count is logged on a clean run with zero orphans.
- A failing sweep leaves the API serving normally.
- Typecheck + build clean.

**Verify against a scratch database with all five storage roots redirected, set
inline on the command that starts the server and asserted to resolve inside the
scratch base before anything starts.** This brief deletes files unattended; the
2026-08-29 incident in [open-questions.md](../../wiki/open-questions.md) is what
happens when that redirect is sourced from a file that can vanish.

---

## Outcome (2026-08-30) — shipped, `7b99eb2` (D46)

`sweepOrphanThumbnails` fires fire-and-forget after `listen`, the same shape as
`backfillLibraryMetadata`. All five guards demonstrated against a scratch
library, including both never-delete-on-partial-read arms and the case a naive
keep-set breaks.

**The brief's own premise was wrong and the build caught it.** `listBooks`
filters conversions (`NOT_CONVERTED`), so it does not return all rows. The
keep-set is still provably complete — every listed row owns its own cover, and
`startConvert` refuses a source with `converted_from` set, so no conversion chain
can exist — and mapping through `coverOwnerId` keeps it correct if that query
ever changes. Verified independently by the controller. The invariant is stated
in the doc comment.

**Deviation from the spec, accepted:** an empty keep-set refuses
*unconditionally* rather than only when the table is non-empty, because the
row-count query would have meant editing `db.ts`, which another brief owned that
wave. A strict superset of the required guard; the only cost is that a genuinely
empty library is never swept.

**Standing note:** on the first real boot of this branch the four genuine orphans
are deleted. Intended, but it is the first unattended deletion this app performs.
