# Task 75 — Switching back to a converted twin resumes from a stale row

**Filed 2026-10-03** while verifying brief 57.

## Context

Brief 57 made the reader write its position on every way out, the twin switch
included. Verifying it showed that the write is not the problem. The position
reaches the server, yet the round trip still loses it:

1. Open a PDF that has an EPUB twin, turn to page 5, and wait for the debounced
   write. The server row holds `locator: "5"`.
2. Switch to the EPUB, then back with "Show original PDF".
3. The PDF opens on **page 1**, writes page 1, and the position is gone.

The original code behaves the same (checked 2026-10-03 with brief 57's change
stashed), so this predates 57.

Evidence points at the client's cached library row, not the server:
- `useHydrateBook` resolves the row from the `libraryKey(profileId, "recent")`
  list cache. With the default `staleTime: 0` the cached data is served
  immediately and refetched in the background, so the effect that computes
  `initialLocation` sees the row **as it was when the list was last fetched**.
  In a tab opened straight on the reader, that is the position at load time.
- On reopen, `routes/read.tsx`'s twin "touch" re-PATCHes that same cached row's
  `progress`/`locator` "unchanged", so it writes the stale fraction back to the
  server. One run sent `{"progress":0,"locator":null}` for a book the server
  had at page 6.
- In one run the touch carried the correct locator (`"8"`) and the PDF still
  opened on page 1. Something on the switch-back path ignores
  `initialLocation` as well. One candidate is `currentLocation`, which
  `setLoadedBook` does not reset and which still holds the EPUB's CFI.

## Scope

**In:** the reopen path for a twin within one reader mount. That means where
`initialLocation` comes from, and what the touch PATCH sends.

**Out:** `use-progress-sync.ts` (brief 57, done) and the server routes.

## Files you OWN

- `apps/web/src/lib/use-hydrate-book.ts`
- `apps/web/src/routes/read.tsx`
- `apps/web/src/store/reader-store.ts`, only if `setLoadedBook` must reset
  `currentLocation`

## What to do

1. Reproduce with the steps above and log `initialLocation` at
   `setLoadedBook` and the first location the PDF reader reports.
2. Resolve the opened row fresh, not from the cache: `GET /library/:id`, or
   `fetchQuery` with `staleTime: 0`, before computing `initialLocation`.
3. Make the touch PATCH unable to move the position backwards. Either send no
   progress at all (only the timestamp has to move), or send the fresh row's
   values.
4. Check whether a stale `currentLocation` from the other format reaches the
   new reader.

## Acceptance

- PDF at page 5, switch to the EPUB, switch back: the PDF opens on page 5. The
  same holds when the switch happens within a second of the page turn.
- The touch never writes a fraction older than the server's.
- Typecheck and build are clean. Verify against a scratch base with all five
  storage roots set inline and asserted before start.
