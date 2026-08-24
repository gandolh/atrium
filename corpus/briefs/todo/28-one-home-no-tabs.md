# Brief 28 — One home: chips replace the per-type routes

The **IA reversal**. Collapses brief 25's `/books` `/music` `/videos` areas back
into a single home where `kind` is a filter chip with a count, and removes brief
21's Shelves ⇄ Stacks grouping. Depends on **brief 27**.

## Grilled decisions applied
- **One home, no tabs** (D33 move 1). Kind is a filter, not an address — this
  deliberately reverses D32/brief 25.
- **Notes stays its own destination** (D33g), reached from the header, not a chip.
- **Grouping is removed** (D33h) — the UI only. The backfilled
  `author`/`series`/`subject` columns stay populated and feed chips + search.

## What to do
1. **Routes** — [router.tsx](../../../apps/web/src/router.tsx): `/` becomes the
   real home. Keep `/books` `/music` `/videos` as **redirects to `/?kind=…`** so
   existing links, browser history and the **installed PWA's start_url** keep
   working (do not just delete them). `/notes`, `/read`, `/discover` unchanged.
2. **Home component** — refactor
   [LibraryArea.tsx](../../../apps/web/src/library/LibraryArea.tsx) into a single
   `LibraryHome`: no `kind` parameter, no per-area config table, no per-area
   heading/empty/upload variants. Kind filter comes from `?kind` (absent = all).
3. **Chips** — a `KindChips` control above the grid: All / Books / Music / Video
   with **live counts** from the loaded list, 20px radius, active inverts to
   `ink-fill` (design.md "Components"). Selecting one writes `?kind` so back /
   refresh / share behave.
4. **Header** — [AppHeader.tsx](../../../apps/web/src/components/AppHeader.tsx):
   delete `NavTabs` entirely. Header becomes wordmark · search slot (brief 30) ·
   **Notes** link · Add button · avatar/theme. Two clusters, one row.
5. **Remove grouping** — delete
   [GroupedGallery.tsx](../../../apps/web/src/library/GroupedGallery.tsx),
   [ShelfView.tsx](../../../apps/web/src/library/ShelfView.tsx),
   [StackIndex.tsx](../../../apps/web/src/library/StackIndex.tsx) and the
   `?g` drill-in; drop `groupBy`/`groupView` from
   [library-prefs.ts](../../../apps/web/src/lib/library-prefs.ts). **Keep**
   [grouping.ts](../../../apps/web/src/library/grouping.ts)'s metadata
   accessors — brief 30 reuses them. Sort survives as a single control.
6. **Grid** — one responsive grid holding mixed aspect ratios (book 2:3, music
   1:1, video 16:9 — kept from brief 25) without ragged rows. Video tiles may
   span two columns (see the comp).
7. **Discover** — reachable from the Add flow and the empty state, no longer
   from a Books area.

## Must NOT touch
- Tile visuals, tints, resume strip, empty state (brief 29).
- Reader, players, notes editor internals.
- Backend, contract, offline store, the metadata columns themselves.

## Acceptance
- `/` shows the whole library; chips filter in place with correct counts;
  `?kind` round-trips through back/refresh/share.
- `/books` `/music` `/videos` redirect rather than 404; the installed PWA still
  launches; no dead nav.
- No grouping UI anywhere; no orphaned imports or prefs; `grouping.ts` retained.
- Typecheck + build clean; all three themes; design.md conformance.
