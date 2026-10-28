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

## Outcome (2026-10-28)

**Done**, code in `2ef5d43`. Not deployed.

**What was built.**
- [`packages/shared/src/lookup.ts`](../../../packages/shared/src/lookup.ts): the
  contract. `lookupSourceForKind` (audio → MusicBrainz, book → Open Library,
  video → null) is the one rule the API and the tile menu both read. A
  candidate names its cover by an id (`coverRef`: a release group MBID or an
  Open Library cover id), never a URL, and `isLookupCoverRef` checks it, so
  the apply route cannot be pointed at an arbitrary host. A ticked field the
  candidate has no value for is a 400: a lookup sets fields, it never clears
  one the file gave.
- [`apps/api/src/modules/lookup/`](../../../apps/api/src/modules/lookup/):
  `GET /library/:id/lookup?title=&author=` (both absent: the item's own),
  `POST /library/:id/lookup` (`{ candidate, fields }`), and
  `GET /lookup/covers/:source/:ref`, the dialog's thumbnails fetched and
  re-encoded by the API so the browser never contacts a source. A source that
  is down or slow (10 s search timeout, 15 s cover) is a 502
  `{ error: "UPSTREAM", source }`. Apply fetches the cover, then decodes it
  through `setBookCover` (D40's setter, sharp re-encode), then writes the text
  fields, so any failure returns before anything is written. Title, author,
  series and series index go to **both rows of a converted pair** (D34), via a
  new assign-outright `setBookMetadata` in `library.model.ts` (the brief named
  the library controller/service/types; the model was needed for the SQL).
  The upload path and `extract.service.ts` are untouched.
- MusicBrainz: a fielded phrase query, `recording:"…" AND artist:"…" AND
  status:official`, with an unfiltered retry only when that finds nothing.
  Its own score ranks remixes above the album recording of a hit, so recordings
  are re-ranked by score plus 10·log2(1 + number of releases), and each shows
  its best release (official, album, no secondary type, earliest). One
  process-wide `RateGate` spaces MusicBrainz request starts a second apart,
  concurrent callers included. Searches and thumbnails are cached for 15
  minutes. Open Library: free-text `q` of title and author (it copes with a
  filename's underscores); its search carries no series, so a book candidate
  offers title, author and cover.
- [`apps/web/src/library/LookupDialog.tsx`](../../../apps/web/src/library/LookupDialog.tsx)
  (Base UI Dialog) opened by **Look up…** in the tile menu (Base UI Menu, D22),
  for music and books only, disabled offline like Remove. Two steps: title and
  artist/author fields filled from the item with the candidates and their
  covers (the first search runs as it opens; later ones on Enter or Search,
  never as you type, because of the gate), then each field the candidate has a
  value for, now beside new, all ticked, and Apply. A cover whose thumbnail
  will not load is not offered.

**What reaches the third parties** (on record, as asked): the search terms
(the title and artist or author as searched), the ids of the covers fetched,
the User-Agent `Atrium/0.1 ( https://github.com/gandolh/atrium )`, and the
server's IP. Not the browser's IP, its cookies, or anything about the account:
every call goes from the API.

**Checked.**
- `npm run typecheck` clean; `npm test` 647 + 147 pass, 0 fail. **There is no
  `npm run lint` script in any workspace**, so that line of the acceptance
  could not be run; typecheck and tests stand in for it.
- [`apps/api/test/lookup.test.ts`](../../../apps/api/test/lookup.test.ts), 18
  tests, with `fetch` replaced by a dispatcher that throws on any host it was
  not given: candidates mapped (artist credit with join phrases, album, track,
  year, cover ref; a vinyl `B1` is no track number), the item's own title and
  author escaped into the query, the unfiltered retry, two concurrent searches
  ≥ 1 s apart, the cache, Open Library's mapping, no results, a 503 and a
  timeout each naming the source, video refused, apply of all fields (cover
  re-encoded to JPEG, not stored as sent), apply of title and author only
  (cover file and mtime unchanged), a cover that is down, missing or not an
  image changing nothing, a ticked null field, a wrong source and a URL as
  `coverRef` refused, a converted pair written together, the thumbnail route,
  the bot's account refused, and nothing looked up on upload.
- **In a browser** (Playwright, headless Chromium), on a scratch library with
  all five storage roots set inline on the API's command and asserted inside
  the scratch base before the API module loaded; the fixtures were uploaded
  for the check. An mp3 tagged "Track 01" / "Unknown Artist": Look up opened
  with focus in the Title field and searched those tags (MusicBrainz really
  has a "Track 01" by "Unknown Artist", so one candidate); "Get Lucky" /
  "Daft Punk" returned ten, the first two "Get Lucky" by Daft Punk feat.
  Pharrell Williams (NRJ Music Awards 15th Edition, track 21) and by Daft Punk
  feat. Pharrell Williams & Nile Rodgers (Random Access Memories, track 8,
  2013), then covers and remixes. Applying the first set title, artist, album,
  track 21 and the cover, and the tile showed them; focus went back to the
  tile's menu button. A PDF uploaded as `the_hobbit_tolkien.pdf` (title from
  the filename): Look up found "The Hobbit", J.R.R. Tolkien, 1937 first;
  Apply with only title and author ticked set both and left the cover's
  version unchanged. The video tile's menu holds only Remove. The dialog was
  captured in light, sepia and dark, results and compare steps, with artwork.
- **Against the real services**, through the finished API, 2026-10-28: four
  MusicBrainz searches (the two queries above, each with its official filter;
  no retry was needed), each a 200, spaced by the gate; Cover Art Archive
  `release-group/<mbid>/front-250` for the thumbnails and `front-500` for the
  applied cover (307 to archive.org, then 200); Open Library
  `search.json?q=the hobbit tolkien&limit=10&fields=key,title,author_name,first_publish_year,cover_i`
  (200, ten works) and `covers.openlibrary.org/b/id/<id>-M.jpg?default=false`
  for the thumbnails. Before building, single curl probes of each (1 s apart,
  same User-Agent) settled the query shape: MusicBrainz's unfielded search
  matched "Get Lucky (Daft Punk)" by other artists, so the query is fielded.

**Conformance (design.md, D33).** Theme tokens only (the backdrop is
`bg-black/40` with the 12px blur, as every existing dialog); Newsreader for
the item's title, Archivo for everything the interface says, caps labels at
the `label-caps` scale; track numbers and years tabular; accent only on the
ticks and focus rings; 4px radius on the dialog, inputs and buttons, 2px on
artwork; thumbnails sit on their kind's tint, music 1:1 and books 2:3, so the
list reads by kind with no labels; the dialog's fade and settle are
`motion-safe:` only, so reduced motion gets no transition.

**Left.** Ranking is a heuristic over MusicBrainz's answer: for "Get Lucky" the
album recording came second, behind the same song on a compilation. The person
picks, so this is a quality note, not a bug.

**For the owner.** The User-Agent's contact is the repository's URL, not an
email address; if the repository is private, MusicBrainz has no way to reach
anyone. Say which address to name, and it is one constant in
`apps/api/src/modules/lookup/lookup-http.ts`.
