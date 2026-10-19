# Task 86: The page-turn arrows must not cover the text on a phone

**Filed 2026-10-09** from README screenshot captures. The finding is from a
390 px wide capture; the cause below is a **lead, not a proven cause**.

## Context

At 390 px wide the two circular page-turn buttons sit over the text column. The
component's own header says they float "over the reading pane's side margins",
which is true on a desktop and false on a phone, where the margin is smaller
than the button.

## Reproduce

1. Scratch library, open any EPUB, set the browser to 390 px wide.
2. Paged mode, chrome visible. Look at the left and right edges at mid-height.

Check both pointer types: in a desktop browser with a narrow window the
buttons are persistent; on a real touch device they are chrome-gated
(`pointer-coarse:` classes), so confirm whether the capture came from the
first case. Also check the PDF reader, which uses the same component.

## Leads (unverified)

- [`PageNav.tsx`](../../../apps/web/src/reader/chrome/PageNav.tsx) lines
  62-76: `h-11 w-11` buttons (44 px) at `left/right: max(0.5rem, safe-area)`
  take 8 to 52 px from each edge.
- The text column inset is the `margins` setting, 24 px by default
  ([`reader-store.ts`](../../../apps/web/src/store/reader-store.ts) line 186),
  applied as body padding in `themeRules`
  ([`use-epub-theme.ts`](../../../apps/web/src/reader/epub/use-epub-theme.ts)
  lines 115-116). 24 px of padding under a 52 px button means about half of
  each button sits on text.
- Mounted from
  [`EpubReader.tsx`](../../../apps/web/src/reader/epub/EpubReader.tsx) line
  940 and `PdfReader.tsx` line 616.
- Touch users already have swipe and the tap zones (EpubReader lines
  596-633), so on a narrow screen the buttons may be unnecessary.

## Scope

**In:** on narrow screens the buttons stop covering text.

**Out:** the tap zones and swipe, desktop layout, the margins slider's range.

## Files you OWN

- `apps/web/src/reader/chrome/PageNav.tsx`
- `apps/web/src/reader/epub/use-epub-theme.ts` only if the fix reserves
  gutters through the text padding

## What to do

1. Reproduce at 390 px and measure how far into the text each button reaches.
2. Pick one and record why: hide the buttons below the narrow breakpoint
   (the epub narrow query is 520 px), shrink them into the margin, or make the
   narrow text padding at least the button's width plus its inset.
3. Run the design conformance checklist (design.md).

## Acceptance

- At 390 px, paged mode, chrome visible, in Light, Sepia and Dark, no button
  overlaps a glyph on an EPUB or a PDF page.
- Page turning still works by swipe, tap zone and keyboard.
- Desktop width looks the same as before.
- Typecheck and build are clean.

## Outcome (2026-10-19)

**Done.** Reproduced at 390 px in a desktop browser (fine pointer, so the
circles were persistent; on a touch device they show with the chrome). Each
44 px circle spans x=8 to 52 from its edge. The EPUB text ran from x=23 to
366, so about 29 px of each button sat on glyphs. The fitted PDF page ran
from x=24 to 366; on the test PDF its own margins kept glyphs clear (text from
x=91), but the buttons sat on the paper and would cover a tighter PDF.

**The overlap is wider than phones.** Both readers set the page in the 620 px
measure with an 8 px inset, and the circles reach 52 px in (60 px from 640 px
up). Measured EPUB text start: x=32 at 521 px, x=81 at 640 px, x=93 at
740 px. So the 520 px narrow query would have left 521 to about 675 px
overlapping, which includes landscape phones.

**Chosen: hide the circles below 740 px** (`PageNav.tsx`,
`[@media(max-width:739px)]:hidden`), for every pointer type. 740 is the
measure plus a 60 px gutter each side, where the circles sit fully outside the
column whatever the margins setting. Rejected: shrinking them into a 24 px
margin (too small to hit), and widening the narrow text padding to clear them
(about a sixth of a phone's measure, and no help for PDF). The trade-off,
written in the component header: a desktop window under 740 px has no mouse
target for turning, because the tap zones are touch-only (`EpubReader.tsx`,
`PdfReader.tsx`, not in this brief); the arrow keys, the page field and the
rail still work there.

**Checked:**
- At 390 px, paged mode, chrome visible: both circles are `display: none` in
  the EPUB (Light, Sepia, Dark) and the PDF reader.
- At 739 px hidden; at 740 px shown at x=16 to 60 with the EPUB text from
  x=93; at 1280 px unchanged (x=16 to 60 and 1220 to 1264).
- ArrowRight and ArrowLeft turned the page at 390 px (52, 53, 52). Swipe and
  the tap zones are untouched code, gated on a coarse pointer; not driven here,
  because the headless browser is a fine pointer.
- Design checklist: no new colours or tokens, nothing else on the circles
  changed, no motion added.
- Typecheck and build are clean.

**Not covered:** with the contents sidebar docked on a desktop, the reading
pane is narrower than the window, and the query reads the window. That was
the same before this brief.
