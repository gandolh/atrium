/**
 * Shared on-screen page navigation (wiki/reader.md "Page nav"). Two circular
 * flip buttons floating over the reading pane's side margins, vertically
 * centered (2026-07-16 UI review follow-up — the old full-height edge bars sat
 * flush against the physical screen edge, where phones with rounded corners
 * and system back-swipe gestures made them genuinely hard to press).
 *
 * The circles are translucent (soft reader-surface fill + backdrop blur) so
 * page text stays readable underneath when the column is narrow, and they're
 * inset from the edge by at least the device's safe area
 * (`env(safe-area-inset-*)`). Touch users can also just swipe — the readers
 * wire horizontal swipes to the same `onPrev`/`onNext` — so the buttons are
 * one of two affordances, not the only one.
 *
 * **Only where those margins exist** (brief 86). Both readers set the page in
 * the 620 px reading measure (`max-w-measure`, design.md) with an 8 px inset,
 * and each circle reaches 52 px in from its edge (60 px from 640 px up). At
 * 390 px the EPUB text starts 24 px in (the default margins setting) and a
 * fitted PDF page 24 px in, so about 28 px of each button sat on the page; the
 * overlap lasts until the window is wide enough for a 60 px gutter on each side
 * of the measure, 620 + 2 × 60 = 740 px (measured: EPUB text began at x=32 at
 * 521 px and x=81 at 640 px, under buttons reaching 52 and 60). So below
 * 740 px the circles are hidden for every pointer type. A phone pages by swipe
 * and the tap zones, a keyboard by the arrow keys. Shrinking them into a 24 px
 * margin would make them too small to hit, and widening the text padding to
 * clear them would cost a phone's measure a sixth of its width. The trade-off:
 * a desktop window under 740 px has no mouse target for turning (the arrow
 * keys, the page field and the rail still work), since the tap zones are
 * touch-only.
 *
 * Only mounted in paged mode (the reader gates on `!isScroll`) — in continuous
 * scroll there are no discrete pages to flip. Format-agnostic: `onPrev`/`onNext`
 * mean the next reading unit — a page for PDF, a location for EPUB. Kept out
 * of the tab order (keyboard users page with the arrow keys); when a flip
 * isn't possible the button fades out rather than sitting there dead.
 */
export function PageNav({
  onPrev,
  onNext,
  canPrev,
  canNext,
  chromeVisible = true,
}: {
  onPrev: () => void;
  onNext: () => void;
  canPrev: boolean;
  canNext: boolean;
  /**
   * On TOUCH screens the circles are part of the chrome ("tool mode" in the
   * tap-zone grammar): hidden while reading — tap zones + swipe page instead —
   * and shown alongside the toolbar. Fine-pointer devices ignore this and keep
   * the circles persistent (the margins are empty there anyway).
   */
  chromeVisible?: boolean;
}) {
  return (
    <>
      <FlipButton side="left" label="Previous page" onClick={onPrev} disabled={!canPrev} chromeVisible={chromeVisible} />
      <FlipButton side="right" label="Next page" onClick={onNext} disabled={!canNext} chromeVisible={chromeVisible} />
    </>
  );
}

function FlipButton({
  side,
  label,
  onClick,
  disabled,
  chromeVisible,
}: {
  side: "left" | "right";
  label: string;
  onClick: () => void;
  disabled: boolean;
  chromeVisible: boolean;
}) {
  const isLeft = side === "left";
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      tabIndex={-1}
      className={`absolute top-1/2 z-10 grid h-11 w-11 [@media(max-width:739px)]:hidden -translate-y-1/2 place-items-center rounded-full border border-reader-border/60 bg-reader-surface/70 text-reader-fg/70 shadow-sm backdrop-blur-sm transition outline-none hover:bg-reader-surface/90 hover:text-reader-fg focus:outline-none focus-visible:outline-none active:scale-95 disabled:pointer-events-none disabled:opacity-0 motion-reduce:transition-none ${
        isLeft
          ? "left-[max(0.5rem,env(safe-area-inset-left))] sm:left-[max(1rem,env(safe-area-inset-left))]"
          : "right-[max(0.5rem,env(safe-area-inset-right))] sm:right-[max(1rem,env(safe-area-inset-right))]"
      } ${chromeVisible ? "" : "pointer-coarse:pointer-events-none pointer-coarse:opacity-0"}`}
    >
      <Chevron dir={side} />
    </button>
  );
}

// Line chevron matching the reader chrome's 1.75-stroke style (design.md "Icons").
function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d={dir === "left" ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"}
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
