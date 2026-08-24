# Brief 25 — Atrium IA: per-type areas + per-media card shapes

Promoted from [todos/rebrand-to-media-gallery.md](../../todos/rebrand-to-media-gallery.md).
The **structure layer** (after brief 24 brand). Splits the one unified gallery
into per-type areas and gives each media type its native card shape.

## Grilled decisions applied
- **Structure = separate library areas** (nav tabs / routes), not the in-place
  All/Books/Music/Videos filter. The filter *becomes* navigation.
- **Cards = per-media shapes:** book 2:3 portrait, music square, video 16:9.

## What to do
1. **Routes** — [router.tsx](../../../apps/web/src/router.tsx): add `/books`,
   `/music`, `/videos`. Make `/` redirect to `/books` (default area). Keep
   `/read`, `/discover`. Each area route renders a shared `LibraryArea`
   component filtered to its `kind` (book/audio/video).
2. **Nav shell** — [AppHeader.tsx](../../../apps/web/src/components/AppHeader.tsx):
   add a primary nav (Books · Music · Videos — Notes added in brief 26) with
   active-state styling, keyboard-operable, quiet (Inter label-ui, accent only
   on the active tab). Mobile: wraps/collapses cleanly.
3. **`LibraryArea`** — refactor the old `routes/home.tsx` (now removed) into a
   reusable `LibraryArea.tsx`
   parameterized by `kind`: it filters the library list to
   that kind, keeps grouping/sort where sensible (Books: author/series/subject;
   Music: artist/album via the existing column mapping; Video: sort only), its
   own empty state + uploader defaults (Books→pdf/epub, Music→mp3,
   Video→mp4/webm), and a per-area heading. Retire the in-header
   `TypeFilterControl` (now nav) and the `typeFilter` pref.
4. **Continue strip** — keep [ContinueReading.tsx](../../../apps/web/src/library/ContinueReading.tsx)
   but reword "Continue reading" → "Continue" (covers read/listen/watch); show
   the most-recent unfinished item **within the current area**.
5. **Per-media card shapes** —
   [CoverCard.tsx](../../../apps/web/src/library/CoverCard.tsx) /
   `CoverArt` / [CoverFallback.tsx](../../../apps/web/src/library/CoverFallback.tsx):
   book stays 2:3; **audio → square** album-art card (art fills the square, not
   centered in a 2:3 tile); **video → 16:9** landscape tile (typographic
   fallback, no frame extraction — brief 23). Badges/duration/progress overlays
   re-fit to each shape.
6. **Per-area grids** — each area's grid tuned to its card aspect (portrait /
   square / landscape column counts), replacing the single `lg:grid-cols-5`
   portrait grid.
7. **Discover** stays books-only, reachable from the **Books** area.

## Must NOT touch
- The readers/players internals (`reader/**`, `player/**`) beyond nav links.
- The shared contract's `kind` semantics (already correct from brief 23).
- Brand identity (brief 24), Notes (brief 26).

## Acceptance
- Books / Music / Videos are separate destinations with working nav +
  active state; `/` lands on Books; deep links + refresh work.
- Each media type renders in its native card shape (2:3 / square / 16:9) in a
  grid tuned to that shape; badges/duration/progress still read correctly.
- Per-area empty states + uploader accept the right formats; grouping/sort
  behave per area; Continue shows the right item per area.
- `npm run build` + typecheck clean; design.md conformance passes; all three
  themes intact.

---

> **Outcome (2026-07-20):** Shipped. New routes `/books` `/music` `/videos`
> (+ `/` → `/books` redirect), nav tabs in `AppHeader`, shared `LibraryArea`
> component per kind, retired the in-header type filter + pref. Per-media card
> shapes: book 2:3, music square, video 16:9; per-kind fallback glyphs
> (book/note/play); per-area grids; Continue strip kind-aware. Audit fix: empty
> areas now show a single area-specific empty state (dropped the redundant hero
> dropzone). Verified live at monitor/laptop/tablet/mobile, no horizontal
> overflow, dark theme legible. Typecheck + build clean. Uncommitted.
