import type { ReactNode } from "react";

import { ToolbarButton } from "../chrome";

/**
 * PDF-specific toolbar controls, split into the toolbar's two
 * semantic groups (2026-07-16 UI review, track C — the bar reads as
 * *navigation | view | position* instead of Home alone in a corner):
 *
 * - `PdfNavControls` → the LEFT cluster, beside Home: outline + search
 *   (moving around the document).
 * - `PdfViewControls` → the CENTER format-adaptive slot: zoom out / fit-width /
 *   zoom in, the "invert colors" dark toggle (the only viable dark mode for a
 *   fixed-layout PDF), and the settings trigger. EPUB fills the same slot with
 *   its font/theme trigger (`EpubViewControls`) — the shell is untouched.
 *
 * The numeric zoom readout and fit-width hide on narrow bars so the pill never
 * overflows a phone viewport; zoom in/out and invert stay.
 */
export function PdfNavControls({
  hasToc,
  onOpenToc,
  onOpenSearch,
}: {
  /** Only render the TOC button when the PDF has an outline (open-question resolution). */
  hasToc: boolean;
  onOpenToc: () => void;
  /** Open the shared in-book search panel (additive). */
  onOpenSearch: () => void;
}) {
  return (
    <>
      {hasToc && (
        <ToolbarButton label="Table of contents" onClick={onOpenToc}>
          <TocIcon />
        </ToolbarButton>
      )}
      <ToolbarButton label="Search in book" onClick={onOpenSearch}>
        <SearchIcon />
      </ToolbarButton>
    </>
  );
}

export function PdfViewControls({
  zoom,
  onZoomIn,
  onZoomOut,
  onFitWidth,
  inverted,
  onToggleInvert,
  settingsTrigger,
}: {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitWidth: () => void;
  inverted: boolean;
  onToggleInvert: () => void;
  /** The settings popover trigger (theme picker + the fixed-layout note). */
  settingsTrigger?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-1">
      <ToolbarButton label="Zoom out" onClick={onZoomOut} disabled={zoom <= 0.5}>
        <MinusIcon />
      </ToolbarButton>
      <span className="hidden min-w-12 text-center text-xs text-reader-fg/80 tabular-nums sm:inline">
        {Math.round(zoom * 100)}%
      </span>
      <ToolbarButton label="Zoom in" onClick={onZoomIn} disabled={zoom >= 3}>
        <PlusIcon />
      </ToolbarButton>
      <span className="hidden sm:block">
        <ToolbarButton label="Fit width" onClick={onFitWidth}>
          <FitWidthIcon />
        </ToolbarButton>
      </span>
      <ToolbarButton label="Invert colors (dark)" onClick={onToggleInvert} active={inverted}>
        <InvertIcon />
      </ToolbarButton>
      {settingsTrigger}
    </div>
  );
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

const MinusIcon = () => icon(<path d="M5 12h14" {...stroke} />);
const PlusIcon = () => icon(<path d="M12 5v14M5 12h14" {...stroke} />);
const FitWidthIcon = () => icon(<path d="M3 12h18M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" {...stroke} />);
const InvertIcon = () =>
  icon(
    <>
      <circle cx="12" cy="12" r="9" {...stroke} />
      <path d="M12 3a9 9 0 000 18z" fill="currentColor" />
    </>,
  );
const TocIcon = () => icon(<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" {...stroke} />);
const SearchIcon = () =>
  icon(
    <>
      <circle cx="11" cy="11" r="7" {...stroke} />
      <path d="M21 21l-4.3-4.3" {...stroke} />
    </>,
  );
