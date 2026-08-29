# Task 10 — Loading feedback: instant navigation + download progress

## Context

From `todos/improve-loading-state.md`.
Probed the live VPS deployment (2026-07-07; owner has the URL — never record
it in git): clicking a
cover card silently downloads the **whole file** (24MB EPUB) before anything
changes — the only cue is the card dimming to 60% opacity; on the probe's fast
connection that's 2.7s of apparent dead UI, on slower links it's tens of
seconds. Root cause: `openBook` in `apps/web/src/routes/home.tsx` awaits
`fetchBookFile` **before** navigating, and its `try/finally` has no `catch`,
so a failed download shows nothing at all. The `/read` route's refresh-hydrate
path (`use-hydrate-book`) duplicates the same fetch with only a bare
"Opening your book…" text state.

Facts that shape the fix:
- `GET /library/:id/file` streams with no `Content-Length`, but the library row
  carries `sizeBytes` — determinate progress needs no API change.
- Home already shows `GallerySkeleton` while the list loads — that part is fine.
- The live host's ~3s first-HTML latency is server/network, out of scope here.

## Files you OWN

- `apps/web/src/routes/home.tsx` (openBook → navigate immediately; drop the
  pre-navigation fetch + `openingId` dimming)
- `apps/web/src/lib/library-api.ts` (`fetchBookFile` gains streaming +
  `onProgress`)
- `apps/web/src/lib/use-hydrate-book.ts` (expose `progress`, `book`, `error`,
  `retry`)
- `apps/web/src/routes/read.tsx` (designed opening screen + error/retry states)

## Files you must NOT touch

- `apps/api/**` (no API change needed)
- `apps/web/src/reader/**` (readers stay unchanged; the EPUB pre-pagination
  veil already covers post-download loading)

## What to do

1. `openBook` just navigates to `/read?book=<id>&format=<fmt>` — the hydrate
   hook becomes the single download path (click and refresh now share one
   loading experience).
2. `fetchBookFile(book, onProgress?)`: read `response.body` chunk-by-chunk,
   report `receivedBytes / book.sizeBytes` (clamp < 1 until done; `null`
   progress if the stream API is unavailable → indeterminate UI).
3. `useHydrateBook` returns `{ status, progress, book, retry }`; a fetch
   failure → `status: "error"` (today it's silent).
4. Replace `HydratingState` with a Quiet-Paper opening screen: centered card
   with the cover thumbnail (typographic fallback tile if none), title
   (Playfair), a determinate accent progress bar (`role="progressbar"`), and
   percentage; error state gets a message + "Try again" (calls `retry`) + a
   back-to-library link. Conform to wiki/design.md (D27) — tokens only.

## Acceptance

- Clicking a cover changes the screen **immediately** (< 1 frame of intent
  ambiguity) to the opening screen; the bar visibly fills as the book
  downloads (verify with a throttled network); the reader appears when done.
- Refreshing `/read?book=<id>` shows the same opening screen.
- Killing the API mid-download (or a 404 book) shows the error state; "Try
  again" re-attempts; the back link returns to the library.
- `npm run typecheck` clean; design.md conformance for the new screen.

---

**Outcome (2026-07-07):** Shipped as specced, implemented inline (2 coupled
chunks, under the dispatch threshold). `openBook` now navigates instantly
(opening screen visible in ~65ms after click, was 2.7s+ of frozen library);
`fetchBookFile` streams with a progress callback against `sizeBytes`;
`useHydrateBook` returns `{ status, progress, book, retry }` and is the single
download path for click + refresh; read.tsx gained `OpeningState` (cover +
Playfair title + determinate accent bar + %) and `OpeningErrorState` (retry +
back link) with a cover `onError` typographic fallback. Verified with a CDP-
throttled network (3MB/s): 8/8 checks — instant screen, bar 9%→25% mid-
download, reader after ~16s, refresh path identical, aborted download → error
→ "Try again" recovers. Typecheck ×3 clean. Out of scope (noted): the live
host's ~3s first-HTML latency is server-side. Per owner instruction this brief
is NOT committed and the live URL is not recorded anywhere in git.
