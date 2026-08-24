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
