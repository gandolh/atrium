# Task 84: Changing the font size must keep your place

**Filed 2026-10-09** from README screenshot captures. The cause is not
isolated; the code pointers are **leads, not proven causes**.

## Context

In the EPUB reader, from the start of Chapter I of *Pride and Prejudice*,
pressing A+ twice landed at the end of the List of Illustrations (before the
chapter). Pressing A- twice landed at the end of the chapter (after). A font
change reflows the text, so the page number changes, but the first words on the
screen should stay roughly where they were.

## Reproduce

1. Scratch library, upload a Project Gutenberg EPUB such as *Pride and
   Prejudice*.
2. Open it and go to the first page of Chapter I.
3. In the settings popover, press A+ twice, and note the text on screen. Go
   back to Chapter I and press A- twice.

Confirm it still reproduces on the current `main` first. Also try a page in
the middle of a chapter, and the line-spacing and margin sliders, which share
the same path.

## Leads (unverified)

- [`use-epub-theme.ts`](../../../apps/web/src/reader/epub/use-epub-theme.ts)
  lines 205-208 and 216-233: the new size is applied with
  `themes.fontSize`, and 180 ms later the reader reads
  `currentLocation().start.cfi`, calls `rendition.clear()` and
  `rendition.display(cfi)`. If `currentLocation()` is read after epub.js has
  already re-laid out and relocated, the CFI is of the wrong spot. A Chapter I
  heading that starts a section is the likely edge: the start CFI of the page
  may point at the previous section's end.
- The first A+ press happens while the page-map walk is running:
  [`EpubReader.tsx`](../../../apps/web/src/reader/epub/EpubReader.tsx) lines
  292-307 re-run the walk 500 ms after each setting change, and 383-390
  (`onLocationChanged`) writes interim relocations into the controlled
  `location`. Two quick presses give two overlapping redisplays.
- Remember the `font-size` rule is injected per section and epub.js has to
  recompute columns; check whether the display call needs to wait for the
  `rendered` or `layout` event instead of a fixed 180 ms.

## Scope

**In:** a font size change keeps the reader at the same text.

**Out:** the theme change (brief 83), the page-count recompute, the PDF reader.

## Files you OWN

- `apps/web/src/reader/epub/use-epub-theme.ts`
- `apps/web/src/reader/epub/EpubReader.tsx` only if the fix needs it

## What to do

1. Reproduce and log the CFI read before and after each press.
2. Capture the CFI when the setting is changed, not 180 ms later, and
   redisplay that one; debounce or coalesce rapid presses so the last wins.
3. Add a regression check if the logic can be isolated.

## Acceptance

- From the first page of Chapter I, A+ twice, A- four times, A+ twice again
  all show Chapter I's opening text on the page.
- From the middle of a chapter, the same sequence keeps the same paragraph on
  screen.
- Typecheck and build are clean.

## Outcome (2026-10-19)

**Done.** Reproduced on `main` (with brief 83's commit reverted for the run)
at 390 px on *Pride and Prejudice*. From the first page of Chapter I, A+ twice
landed back in the List of Illustrations ("Heading to Chapter XXXII.", the
chapter heading three pages ahead), A- four times landed nine pages past the
heading ("I hope Mr. Bingley will like it."), and A+ twice ended five pages
past it.

**Why.** The first lead. The nudge read `currentLocation()` 180 ms after the
new size had reflowed the section under the same scroll offset, so it saved
the start of whatever text now sat at that offset: earlier text after A+,
later text after A-. Two further causes turned up on the way:
- The redisplay itself drifted. It lands on the page that contains the anchor,
  and that page usually starts a few lines earlier. Re-reading the start after
  every change walked the reader back: with only the read-before fix, A+ twice,
  A- four times, A+ twice ended one page before Chapter I.
- The fresh iframe positions the CFI before its layout settles (brief 83). The
  fonts-ready wait from 83 was not enough after a fresh page load:
  `document.fonts.status` already read "loaded" while the column strip grew from
  44,506 to 63,954 px over about 180 ms, and one run of 83's check moved 55 to
  56 again.

**Fix** (`use-epub-theme.ts` only):
- The anchor is read before the new settings reach the rendition.
- It is sticky: kept while a redisplay is pending or in flight, so rapid
  presses coalesce and the last setting wins, and kept while the reader is
  still on the page the redisplay landed on. Turning a page or jumping
  replaces it (checked: next page, theme change, stayed on the new page; two
  pages back, theme change, stayed there).
- The redisplay waits for the fonts and then for every section's document and
  iframe width to hold still for six frames (capped at 2 s) before it displays
  the anchor a second time.

**Checked**, at 390 px and 1280 px:
- From the first page of Chapter I, A+ twice, A- four times, A+ twice kept
  Chapter I's opening on the page at every step (at 1280 px the page starts
  with " Chapter I." each time).
- From pages 300 and 450 (mid-chapter), the same sequence kept the page's
  first words on screen at every step, and the last step showed the same first
  words as the start.
- Four A+ presses 80 ms apart, then four A-, settled at 22 px and 18 px with
  the anchor on screen.
- Line spacing 2.0 and 1.4, and Archivo and back, kept the anchor on screen.
- Brief 83 rechecked on this code: three fresh loads at page 55, and pages 38,
  40, 42 and 56, kept their page through Light, Sepia, Dark and Light.
- Typecheck and build are clean. No regression test: `apps/web` has no test
  runner, and adding one is outside the files this brief owns.
