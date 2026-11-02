import type { ReactNode } from "react";

import { ToolbarButton } from "../chrome";

/**
 * EPUB-specific toolbar controls, split into the toolbar's two
 * semantic groups (2026-07-16 UI review, track C — the bar reads as
 * *navigation | view | position* instead of Home alone in a corner):
 *
 * - `EpubNavControls` → the LEFT cluster, beside Home: contents + search
 *   (moving around the book).
 * - `EpubViewControls` → the CENTER format-adaptive slot: the font/theme
 *   settings trigger (how the book looks). PDF fills the same slot with
 *   zoom/invert (`PdfViewControls`) — the shell (`ReaderToolbar`) is untouched.
 */
export function EpubNavControls({
  onOpenToc,
  hasToc,
  tocActive = false,
  onOpenSearch,
}: {
  onOpenToc: () => void;
  hasToc: boolean;
  /** Whether the contents sidebar is currently docked open (button reads as pressed). */
  tocActive?: boolean;
  onOpenSearch: () => void;
}) {
  return (
    <>
      {hasToc && (
        <ToolbarButton
          label={tocActive ? "Hide contents" : "Show contents"}
          onClick={onOpenToc}
          active={tocActive}
        >
          <TocIcon />
        </ToolbarButton>
      )}
      <ToolbarButton label="Search in book" onClick={onOpenSearch}>
        <SearchIcon />
      </ToolbarButton>
    </>
  );
}

export function EpubViewControls({
  settingsTrigger,
}: {
  /** The settings popover trigger (font/family/spacing/margins + theme). */
  settingsTrigger: ReactNode;
}) {
  return <div className="flex items-center gap-1">{settingsTrigger}</div>;
}

function icon(children: ReactNode) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {children}
    </svg>
  );
}

const stroke = {
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const TocIcon = () =>
  icon(<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" {...stroke} />);
const SearchIcon = () =>
  icon(
    <>
      <circle cx="11" cy="11" r="7" {...stroke} />
      <path d="M21 21l-4.3-4.3" {...stroke} />
    </>,
  );
