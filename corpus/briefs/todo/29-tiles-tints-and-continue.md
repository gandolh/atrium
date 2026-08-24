# Brief 29 — Tinted tiles, the Continue hero, and a dropzone that leaves

The **surface layer** of the home. Depends on **briefs 27 + 28**.

## Grilled decisions applied
- **Continue is the hero** (D33 move 2), labelled in **time remaining**, not percent.
- **Tint carries kind** (D33 move 3) — tints become the primary kind signal, so
  format badges stop being load-bearing.
- The dashed dropzone exists **only in the empty state**; otherwise drag-anywhere
  plus the Add button.

## What to do
1. **Resume hero** — rework
   [ContinueReading.tsx](../../../apps/web/src/library/ContinueReading.tsx) into
   a three-up strip at the top of the home: artwork, title, source, **time
   remaining**, 3px progress bar. Compute remaining from `progress` ×
   `durationSeconds` for music/video; for books estimate from page count (state
   the assumption in a comment — an estimate is fine, a wrong-looking one is not).
   Falls back to "Not started" and hides entirely when nothing is in progress.
2. **Tinted tiles** — [CoverCard.tsx](../../../apps/web/src/library/CoverCard.tsx)
   / [CoverFallback.tsx](../../../apps/web/src/library/CoverFallback.tsx): tile
   ground becomes `--tint-{kind}`, 1px `line-soft`, 4px radius, artwork at 2px
   with the bottom-heavy shadow. Title in Archivo 600, source in `ink-variant`.
   **Drop the EPUB/PDF corner badges** — tint plus the format line carries it.
3. **Hover lift** — 4px translate + deepened shadow, 300ms on the shared easing
   from brief 27; reduced-motion path.
4. **Grid re-filter motion** — when a chip changes the set, tiles settle with a
   20ms stagger (Motion Primitives `AnimatedGroup`).
5. **Empty state** — the dashed dropzone, the greeting, and a
   "Browse Gutenberg" secondary action, shown **only** when the library is empty.
6. **Upload everywhere else** — window-level drag-and-drop with a subtle overlay
   on dragover; the Add button opens the same picker. Retire the always-present
   [UploadZone.tsx](../../../apps/web/src/library/UploadZone.tsx) block from the
   populated home (keep the component for the empty state).

## Must NOT touch
- Routing, chips, header (brief 28). Search (brief 30). Dock (brief 31).
- Cover extraction or any backend behaviour.

## Acceptance
- Continue shows the right items with plausible time-remaining and hides when empty.
- A mixed grid reads by kind **with every badge removed** (the design.md tint test).
- Populated home has no dashed box; drag-anywhere works; empty state still guides.
- Reduced-motion disables lift + stagger. Three themes. Typecheck + build clean.
