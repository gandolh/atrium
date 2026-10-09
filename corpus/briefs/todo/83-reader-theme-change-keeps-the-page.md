# Task 83: Changing the reader theme must not move the page

**Filed 2026-10-09** from README screenshot captures (Project Gutenberg EPUBs
in a scratch library). Seen twice and stable on repeat; not yet isolated to a
cause. The code pointers below are **leads, not proven causes**.

## Context

In the EPUB reader, switching the theme from Light to Sepia moved the reader
from page 40 to page 41. A theme is colour only, so it must not change the
layout or the position.

## Reproduce

1. Scratch library (see [getting-started](../../../docs/getting-started.md)),
   upload a Project Gutenberg EPUB such as *Pride and Prejudice*.
2. Open it in paged mode, go to page 40 with the page field, theme Light.
3. Open the settings popover and pick Sepia. Read the page badge.

Expected 40, seen 41. Repeat from Sepia to Dark and back to see whether other
pairs move too. Confirm first that it still reproduces on the current `main`;
if it does not, close the brief with a note.

## Leads (unverified)

- [`use-epub-theme.ts`](../../../apps/web/src/reader/epub/use-epub-theme.ts)
  lines 191-244: one effect re-registers the theme, re-applies font size and
  family, then (lines 220-233) after 180 ms calls `rendition.clear()` and
  `rendition.display(cfi)` with `currentLocation().start.cfi`. `theme` is in
  its dependency list (line 239), so a colour-only change triggers the same
  clear-and-redisplay as a layout change. Re-displaying the start CFI of the
  page can land on the neighbouring page if the column geometry differs by a
  pixel after the re-render.
- Same file, lines 111-117: `themeRules` sets body padding from `margins`;
  check that no rule differs between themes in a way that changes layout
  (font weight, `!important` sizes, image caps).
- [`EpubReader.tsx`](../../../apps/web/src/reader/epub/EpubReader.tsx) lines
  383-390 (`onLocationChanged`) write whatever react-reader reports into the
  controlled `location`; an interim relocation during the redisplay may echo a
  neighbouring CFI back (`location={cfi ?? 0}`, line ~908).

## Scope

**In:** make a theme change leave the page where it was, and say why it moved.

**Out:** font size and family (brief 84), the page map, the PDF reader.

## Files you OWN

- `apps/web/src/reader/epub/use-epub-theme.ts`
- `apps/web/src/reader/epub/EpubReader.tsx` only if the fix needs it

## What to do

1. Reproduce and log the CFI and page before and after the switch, to see
   whether the CFI moved or only the page badge did.
2. A colour-only change should not need the clear-and-redisplay. If the repaint
   workaround is still needed, skip it when only `theme` changed, or restore
   the exact pre-change CFI.
3. Add a test if the logic can be pulled out of the hook.

## Acceptance

- At page 40 on the repro book, Light to Sepia to Dark to Light leaves the
  page badge at 40 each time, on desktop width and at 390 px.
- The page still repaints in the new colours (the reason for the nudge).
- Typecheck and build are clean.
