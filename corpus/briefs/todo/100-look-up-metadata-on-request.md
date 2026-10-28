# Task 100 — Look up an item's metadata and cover, on request

## Context

The Jellyfin study (brief 79,
[jellyfin-comparison.md](../../wiki/jellyfin-comparison.md)) ranked this as
shortlist 6, and on 2026-10-28 the owner picked it (D59 in
[decisions.md](../../wiki/decisions.md)): metadata comes from the file, **plus
a lookup the user asks for, on one item at a time, never automatic**.

Today Atrium reads metadata from the file only (`extract.service.ts`): title,
author, series and series index (mp3 tags fold onto author, series and index),
subjects, and an embedded cover. Nothing lets a user fix a wrong or missing
title, and there is no metadata route: `library.controller.ts` has upload,
list, get, file, cover (`GET`/`POST /library/:id/cover`, D40's last-write-wins
setter through sharp), progress, convert and delete.

Sources, all keyless:

- **Music** (mp3): MusicBrainz's search API
  for the recording or release, and the Cover Art Archive for the front cover.
  MusicBrainz asks for a descriptive `User-Agent` with a contact and at most
  one request a second.
- **Books** (pdf, epub): Open Library's search API
  and its covers service.
- **Films**: none. They need a TMDb key, and D59 leaves them out until the
  owner registers one. The Look up action does not appear on video.

The API already calls outside services the same way for the Gutenberg catalog
(`apps/api/src/modules/catalog/gutendex.service.ts`: `fetch` with
`AbortSignal.timeout`, a `User-Agent`, an in-memory cache). Follow it.

## Files you OWN

- A new `apps/api/src/modules/lookup/` (service, routes, tests), registered
  where the other modules are
- `apps/api/src/modules/library/library.controller.ts`,
  `library.service.ts`, `library.types.ts` (a metadata update)
- `packages/shared` types for the new routes
- `apps/web/src/library/CoverCard.tsx` (the tile menu) and a new lookup dialog
  beside it
- corpus: this brief's outcome, `corpus/wiki/status.md`, `corpus/log.md`, the
  library concept page that describes metadata

## Files you must NOT touch

- `extract.service.ts`: reading from the file stays as it is.
- The upload path: nothing is looked up on upload.

## What to do

1. **API, search.** `GET /library/:id/lookup` searches the right source for the
   item's kind, starting from its current title and author (and a query the
   user typed, if given), and returns up to 10 candidates: title, author,
   album or series and position, year, a cover thumbnail URL, the source and
   its id. Outbound calls go from the API, not the browser, with a timeout, a
   `User-Agent` naming Atrium, and MusicBrainz held to one request a second.
2. **API, apply.** `POST /library/:id/lookup` takes the chosen candidate and
   the fields the user kept, writes title, author, series and series index,
   and fetches the cover from the source through the existing cover path
   (sharp re-encodes it; client bytes are never stored as-is). Every field
   is optional; unticked fields stay as they were.
3. **Web.** A **Look up** item in the tile menu (Base UI Menu, D22) for music
   and books. It opens a dialog: the search box filled from the item, the
   candidates with their covers, and on picking one, each field with its
   current and new value and a tick box (all ticked), then Apply.
4. **Failures say so.** A source that is down or slow shows "Couldn't reach
   MusicBrainz" (or Open Library) in the dialog; no results says so; nothing
   changes on the item.
5. Say in the outcome what reaches the third parties (the search terms, the
   server's IP) so it is on record.

## Acceptance

- A song with wrong tags: Look up finds its release, Apply sets title, artist,
  album as series with its track number, and the cover; the tile shows them.
- A PDF titled from its filename: Look up finds the book on Open Library, and
  Apply with only title and author ticked leaves the cover alone.
- Video has no Look up item.
- Sources mocked in the API tests (no network in tests); one manual check
  against the real MusicBrainz and Open Library, recorded in the outcome.
- The dialog passes the conformance checklist at the bottom of
  [design.md](../../wiki/design.md) (D33), in all three themes.
- `npm run typecheck`, `npm run lint`, `npm test` pass. Test on a scratch
  library with every storage root redirected (D39 and the 2026-08-29 incident
  in [open-questions.md](../../wiki/open-questions.md)), never the real one.
