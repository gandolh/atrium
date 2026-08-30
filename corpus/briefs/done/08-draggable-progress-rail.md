# Task 08 — Draggable progress rail, shared across both readers

## Context

From `todos/draggable-reading-progress-bar.md`.
The EPUB reader has a `ProgressRail` (bottom-edge scrub strip: click-to-seek,
hover tooltip, arrow keys) but it cannot be **dragged** — the user wants to grab
the bar and scrub horizontally. The PDF reader has **no rail at all**, only a
"page N/M" toolbar chip. Scope decision (user, 2026-07-07): **both formats** get
the draggable rail — one shared component.

Current wiring:
- `apps/web/src/reader/epub/ProgressRail.tsx` — the rail (percent, ticks,
  visible, onSeek — already format-agnostic props).
- `apps/web/src/reader/epub/EpubReader.tsx` — mounts it: `percent` from epub.js
  char-locations, `ticks` from chapter boundaries, `onSeek` →
  `locations.cfiFromPercentage` + `jumpTo`.
- `apps/web/src/reader/pdf/PdfReader.tsx` — no rail; has `currentPage`,
  `numPages`, `goToPage`, outline via `usePdfOutline`, `chromeVisible` in store.

## Files you OWN

- `apps/web/src/reader/chrome/ProgressRail.tsx` (moved here from `epub/`)
- `apps/web/src/reader/chrome/index.ts` (re-export)
- `apps/web/src/reader/epub/EpubReader.tsx` (import path only)
- `apps/web/src/reader/epub/ProgressRail.tsx` (deleted after move)
- `apps/web/src/reader/pdf/PdfReader.tsx` (mount the rail)

## Files you must NOT touch

- `apps/web/src/reader/epub/epub-page-map.ts` (pagination machinery)
- `apps/api/**` (backend untouched)

## What to do

1. **Move** `ProgressRail.tsx` to `reader/chrome/` and export it (+ `RailTick`)
   from `chrome/index.ts`; fix the EPUB import.
2. **Add drag** to the rail using pointer events + `setPointerCapture`:
   - `pointerdown` on the track starts a drag; local `dragPct` state drives the
     fill + tooltip while dragging (live preview).
   - `pointerup` commits **once** via `onSeek(dragPct)` — no live seeking while
     dragging (an EPUB `rendition.display()` per pointermove would thrash).
   - A click (down+up without move) still seeks — same commit path.
   - `touch-action: none` on the track so touch drags don't scroll the page.
   - `aria-valuenow` reflects the drag position while scrubbing.
3. **Mount the rail in `PdfReader`**: `percent = (currentPage / numPages) * 100`;
   `onSeek` → `goToPage(clamp(round(pct/100 * numPages), 1, numPages))`; ticks
   from top-level outline entries with numeric page targets
   (`pct = ((page - 1) / numPages) * 100`), empty if no outline; `visible` =
   `chromeVisible`; `totalPages = numPages` so the tooltip shows real pages.

## Acceptance

- EPUB: the rail can be grabbed and dragged; the fill + tooltip track the
  pointer; releasing jumps to that position. Click-seek and arrow keys still work.
- PDF: same rail appears at the bottom edge, fades with the chrome, drag/click
  seeks to the right page; chapter ticks show when the PDF has an outline.
- Works with touch (pointer events), no page scroll during a drag.
- `npm run typecheck` clean; conforms to wiki/design.md (theme tokens only —
  the rail already uses `reader-*` tokens; keep it that way).

---

**Outcome (2026-07-07):** Shipped as specced. `ProgressRail` moved to
`reader/chrome/` with pointer-capture drag (live fill + tooltip preview,
single `onSeek` commit on release, `touch-action: none`, pointer-cancel aborts
without seeking); PDF mounts it with page-based percent, outline-derived ticks,
and page-number tooltip. Verified live via headless Playwright against both
fixtures: 10/10 checks (rail present, fill tracks drag, tooltip mid-drag,
release seeks, click-seek) in both readers, zero console errors. Typecheck
clean ×3. Nothing deferred.
