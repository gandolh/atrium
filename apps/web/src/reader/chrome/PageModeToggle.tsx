import { useReaderStore } from "../../store/reader-store";
import { ToolbarButton } from "./ReaderToolbar";

/**
 * Reading-mode toggle for the bottom bar's format-adaptive cluster.
 * Flips the active reader between "paged" (one page/screen per view) and
 * "scroll" (continuous vertical scroll), reading + writing the durable
 * `pageMode` preference in the store. Format-agnostic: each reader interprets
 * the mode in its own terms (EPUB `flow`, PDF single-vs-multi-page render).
 *
 * The icon shows the mode the button will SWITCH TO (the affordance), while
 * `aria-pressed` reflects whether scroll mode is currently active — so screen
 * readers announce state and the button reads as pressed when scrolling.
 */
export function PageModeToggle() {
  const pageMode = useReaderStore((s) => s.pageMode);
  const togglePageMode = useReaderStore((s) => s.togglePageMode);
  const isScroll = pageMode === "scroll";

  return (
    <ToolbarButton
      label={isScroll ? "Switch to paged view" : "Switch to scroll view"}
      onClick={togglePageMode}
      active={isScroll}
    >
      {isScroll ? <PagedIcon /> : <ScrollIcon />}
    </ToolbarButton>
  );
}

// Icons follow the reader chrome's 1.75-stroke line style (design.md "Icons").
const stroke = {
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

// Single framed page — the affordance shown while in scroll mode.
function PagedIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="6" y="4" width="12" height="16" rx="1.5" {...stroke} />
      <path d="M9 9h6M9 12h6M9 15h4" {...stroke} />
    </svg>
  );
}

// A single framed page between top/bottom edge marks with a downward arrow,
// suggesting continuous vertical flow — the affordance shown while in paged mode.
function ScrollIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M7 3h10M7 21h10" {...stroke} />
      <rect x="6" y="7" width="12" height="10" rx="1.5" {...stroke} />
      <path d="M12 9.5v5m0 0l-1.75-1.75M12 14.5l1.75-1.75" {...stroke} />
    </svg>
  );
}
