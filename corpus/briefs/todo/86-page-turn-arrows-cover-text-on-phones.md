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
