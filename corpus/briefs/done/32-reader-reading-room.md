# Brief 32 — The reader in Reading Room

Reworks the reading surface and its chrome onto the new system. Depends on
**brief 27**. Independent of 28–31, so it can run in parallel.

## Grilled decisions applied
- Reading face is **Newsreader** at 18/1.78, measure capped at **620px**.
- Chrome fades on idle; the rail and the Aa panel are the only controls.
- The `--reader-*` three-theme architecture stays; light + dark move warm.
- The **progress rail** is the one place **anime.js** is sanctioned.

## What to do
1. **Reading pane** — wire Newsreader into the EPUB rendition and the PDF text
   layer where applicable; measure to 620px; line-height 1.78.
2. **Chrome** — restyle
   [ReaderHeader.tsx](../../../apps/web/src/reader/chrome/ReaderHeader.tsx),
   [ReaderToolbar.tsx](../../../apps/web/src/reader/chrome/ReaderToolbar.tsx),
   [ProgressIndicator.tsx](../../../apps/web/src/reader/chrome/ProgressIndicator.tsx)
   to the new tokens: running header (title / chapter), footer `chapter · %`.
   Fade 600ms out / 150ms in on idle.
3. **Progress rail** —
   [ProgressRail.tsx](../../../apps/web/src/reader/chrome/ProgressRail.tsx): 3px,
   chapter ticks in locations-space, hover tooltip, click / drag / arrow seek.
   Move the drag preview onto an **anime.js timeline** (the sanctioned use);
   commit one seek on release exactly as brief 08 established.
4. **Aa panel** — [SettingsPopover.tsx](../../../apps/web/src/reader/chrome/SettingsPopover.tsx)
   / [ThemePicker.tsx](../../../apps/web/src/reader/chrome/ThemePicker.tsx):
   theme swatches as miniature pages, **face toggle (Newsreader / Archivo)**
   replacing the old family list, A−/A+ steppers.
5. **Cover → reader transition** — the tile's artwork expands into the page it
   opens (Motion Primitives shared layout, 420ms), degrading to a plain
   navigation under reduced motion.
6. **TOC / search panels** — restyle to the new tokens; keep the crossfade veil
   (never opacity on the iframe's ancestors — the Chromium raster-staleness fix).

## Must NOT touch
- Renderer internals (`react-pdf`, `react-reader`) beyond fonts and theming.
- Resume/locator semantics (D31). Offline reading. Backend.

## Acceptance
- Both readers render in Newsreader at the capped measure, all three themes.
- Chrome fades and returns; rail scrubs and commits one seek; no raster staleness.
- Aa panel drives theme/face/size correctly and persists as before.
- Reduced motion disables the transition and the rail preview. Typecheck + build clean.

## Outcome (2026-08-24) — DONE
Landed as committed `c16cca9`, built on **sonnet** rather than opus: once this
brief enumerated its own traps (raster staleness, one-seek-per-drag, D31
locators) it was well-gated executor work.

Both hard-won fixes held. The rail's drag preview moved onto an anime.js
timeline writing fill/knob imperatively, and was verified to still commit
**exactly one** seek on release (instrumented counter, real pointer sequence).
No opacity landed on an EPUB iframe ancestor — the whole ancestor chain was
walked with `getComputedStyle` during a jump.

Real `@font-face` rules had to be injected into the epub.js section iframe via
`?url` imports: the parent document's `@fontsource` CSS does not cascade in.
The first pass registered **weight 400 only**, which made bold headings and
`<strong>` synthesise where the browser's own serif had previously supplied a
real bold cut — a regression in the primary reading surface, caught by review
and fixed in `4a77b51` by adding Newsreader 500/600 and Archivo 600/700.

The cover → reader transition needed review work too: as first built the
`layoutId` was absent until hydration resolved and the first commit rendered a
node without one, so the morph could never fire.
