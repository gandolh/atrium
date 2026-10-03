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

## Outcome (2026-10-03)

Done. **The root cause was the list's twin merge, not only cache staleness.**

`listLibraryForProfile` gives each card the position of whichever twin was read more recently. That is right for the grid and the Continue strip (brief 34 step 7). The reader, though, took the opened book's resume position from that list row. After reading the EPUB, the PDF's list row held the EPUB's CFI, which `resumeLocation(…, "pdf")` cannot parse as a page, so the PDF opened on page 1. Instrumenting the reader store showed `initialLocation` arriving as `null`. The twin "touch" then re-PATCHed the merged values onto the PDF's own row. That explains both observations in the context above: the `{"progress":0,"locator":null}` write, and the run that opened on page 1 although the cached row looked right.

**Change:**
- **`use-hydrate-book.ts`:** before computing `initialLocation`, the network path fetches the book's own row with `GET /library/:id` (`getBookForProfile`, no merge, never cached). If that fetch fails, it falls back to the list row. The file fetch is unchanged.
- **`read.tsx`:** the touch keeps its trigger (once per opened row of a pair) but sends values from a fresh `GET /library/:id` of that row, never the list row. It can no longer write a twin's position or a stale fraction.
- `currentLocation` from the other format does not leak: the store log shows `PdfReader`'s mount effect replacing it with the seeded page straight away. `reader-store.ts` is unchanged.

**Browser check** (scratch base, all roots asserted, scripted Ward, the 12-page PDF and its EPUB twin):
- PDF at page 6, then to EPUB and back: it reopened on **6**, and the server still holds 6. Before the fix it reopened on 1 and wrote 1.
- Two page turns (6→8) and "Switch to EPUB" in the same tick, then back: it reopened on **8**. Brief 57's flush wrote it, and the touch re-sent the PDF's own fresh values.

Typecheck and build are clean.

Note for testing: the scripted Ward gives every request the same `sid`, so a profile picked in the browser is also the profile a `curl` with that cookie writes to. One run here looked like a failure until that was noticed.
