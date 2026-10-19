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

## Outcome (2026-10-19)

**Done.** Reproduced on `main` with the Project Gutenberg EPUB of *Pride and
Prejudice*, not at page 40 but at page 55 of 976 at 390 px: Light to Sepia to
Dark went 55, 55, 56. The CFI moved, not only the badge.

**Why it moved.** None of the three leads. The repaint nudge calls
`rendition.clear()` and then `display(cfi)`. `clear()` throws the section's
iframe away, and the new iframe places the CFI while its web fonts are still
loading. epub.js measures the text in the fallback face, scrolls to that page,
and then Newsreader arrives and the text reflows under the old scroll offset.
Measured on page 55: the anchor word sat at x=19837 with the fonts loaded and
at x=20372 while they loaded, one 374 px page later. `display(cfi)` without
`clear()` was exact every time; with `clear()` it moved every time on that page.

**Fix** (`use-epub-theme.ts`): the nudge now waits for the new document's
`fonts.ready` and displays the same CFI a second time. That call finds the
section rendered and only scrolls, which is exact. The CFI is also read before
the new settings are applied rather than 180 ms later, which is brief 84's fix
and is harmless for a colour change. The `clear()` itself stays, because
Chromium still needs it to repaint large section iframes.

**Checked:**
- At 390 px, pages 38 to 42 and 54 to 56, Light to Sepia to Dark to Light, kept
  the badge on its page each time; page 55 also through two full cycles with
  the same start CFI throughout.
- At 1280 px, pages 38 to 42, 58 to 65, 70, 100 and 200 the same. One run right
  after a viewport resize showed 60 to 59; it did not repeat in two later runs
  and lines up with the page map rebuilding after the resize.
- Page 40 at 390 px repainted in Sepia and Dark with the same text on screen.
- Typecheck and build are clean. No test: `apps/web` has no test runner, and
  the fix is the order of epub.js calls against a live iframe, which needs a
  browser.

**Revised the same day under [brief 84](84-reader-font-size-keeps-your-place.md):**
waiting for `fonts.ready` alone still moved page 55 to 56 once after a fresh
load, because the font set read "loaded" while the column strip was still
growing. The nudge now also waits for the section's width to hold still.
