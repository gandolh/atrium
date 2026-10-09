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
