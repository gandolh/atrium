# Brief 30 — Search across the whole library

Closes the fifth fault in the design study: search is currently **in-book only**,
so nothing can find anything across the collection. Depends on **brief 28**.

## Grilled decisions applied
- **Client-side first** over the already-loaded library list. A server endpoint
  only if the library outgrows it — do not add one speculatively.
- `/` focuses the field (the comp's shortcut). Not `⌘K` — that was direction C's
  thesis and was not chosen.

## What to do
1. **Field** — in [AppHeader.tsx](../../../apps/web/src/components/AppHeader.tsx),
   the search slot brief 28 left: 1px `line`, 4px radius, `/` hint chip. Focus on
   `/` from anywhere except inside an input; `Esc` clears and blurs.
2. **Index** — match over title, author, series, subject, artist, album and
   format, reusing the accessors kept in
   [grouping.ts](../../../apps/web/src/library/grouping.ts). Case- and
   diacritic-insensitive; match on token prefixes so "rad" finds "Radiohead".
3. **Results** — filter the home grid in place (not a separate results page) and
   combine with the active kind chip. Show a count and a "clear" affordance.
   Empty result gets a real message naming what was searched, not a shrug.
4. **Debounce** input ~120ms and keep the query in `?q` so it round-trips.
5. **Offline** — search must work against the offline snapshot with no network.

## Must NOT touch
- The in-book/in-reader search (`reader/chrome/SearchPanel.tsx`) — unrelated.
- Backend, contract. No new endpoint in this brief.

## Acceptance
- `/` focuses; typing filters the grid live; `?q` round-trips; `Esc` clears.
- Query and kind chip compose correctly; counts stay accurate.
- Works offline. Reduced-motion respected. Typecheck + build clean.
