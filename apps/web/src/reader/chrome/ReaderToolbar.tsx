import { useState, type ReactNode } from "react";

import { useChromeHold } from "./use-auto-hide-chrome";
import { MOTION_MS } from "../../lib/motion";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * FORMAT-ADAPTIVE TOOLBAR SEAM  (the crux of brief 06 for brief 07)
 * ─────────────────────────────────────────────────────────────────────────────
 * `ReaderToolbar` is the SHARED chrome shell used by BOTH readers. The shell
 * owns the layout (an in-flow bottom bar that fades with the auto-hide chrome
 * via `visible`) and three named slots. The format-specific reader fills the
 * slots:
 *
 *   - `leftControls`   → TOC button, back-to-home, etc. (per format).
 *   - `formatControls` → the ADAPTIVE region. This is where the toolbar's
 *                        controls swap by format (wiki/reader.md
 *                        "Format-adaptive toolbar"):
 *                          • PDF  (brief 06): zoom out / fit-width / zoom in +
 *                            an "invert colors" dark toggle.
 *                          • EPUB (brief 07): font size / family / line-spacing
 *                            / margins + the full theme picker.
 *   - `rightControls`  → progress indicator, settings popover trigger, etc.
 *
 * Brief 07 REUSES this component verbatim — it does NOT fork it. It only passes
 * different slot contents. Keep this shell format-agnostic: no `format`
 * branching, no PDF/EPUB imports here. If a control needs format knowledge,
 * it belongs in the slot the reader supplies, not in this file.
 *
 * The paired seam for pop-out settings is `SettingsPopover` (also slot-driven).
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function ReaderToolbar({
  leftControls,
  formatControls,
  rightControls,
  visible = true,
}: {
  leftControls?: ReactNode;
  formatControls?: ReactNode;
  rightControls?: ReactNode;
  /** Fades with the auto-hide chrome (track C); the row keeps its grid slot so
   *  the content column never shifts. Hidden = non-interactive too. */
  visible?: boolean;
}) {
  // Keyboard users: while focus sits anywhere inside the toolbar (tabbing the
  // buttons, typing a page number), pin the chrome so it can't fade mid-tab.
  const [focusWithin, setFocusWithin] = useState(false);
  useChromeHold(focusWithin);

  return (
    // In-flow bottom row of the reader's 3-row grid (top bar / content / this).
    // The wrapper never eats pointer events — the progress rail sits at the
    // very bottom edge beneath it; only the pill is interactive.
    <div
      onFocusCapture={() => setFocusWithin(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false);
      }}
      className={`pointer-events-none relative z-30 w-full shrink-0 transition-opacity ease-paper motion-reduce:transition-none ${
        visible ? "opacity-100" : "opacity-0"
      }`}
      // design.md "Motion": 600ms out / 150ms in, same asymmetric fade as
      // `ReaderHeader`/`ProgressRail` (all three chrome pieces move together).
      style={{ transitionDuration: `${visible ? MOTION_MS.chromeIn : MOTION_MS.chromeOut}ms` }}
    >
      {/* Single-line pill laid out as a 3-track grid — NOT `justify-between`.
          `justify-between` only keeps the middle cluster centred when the two
          side clusters are equal width; ours aren't (left = Home, right =
          chapter + page-jump + %), so the middle controls slid sideways every
          time the chapter label changed length or the page number gained a
          digit. `minmax(0,1fr) auto minmax(0,1fr)` pins the centre cluster to
          its own content width between two equal side tracks, so the bar's items
          never shift: left grows into the left track, right into the right
          track, the centre stays put. The side tracks use `minmax(0,1fr)` (not
          plain `1fr`) so they can shrink BELOW their content's min-content width
          — without the `0` floor a long chapter label + a 3-digit page counter
          widen the right track past its share and overlap the centre cluster
          (which made the mode-toggle unclickable). With the floor the right
          cluster stays in its track and its `min-w-0` truncating chapter label
          shrinks instead; `overflow-hidden` clips any residual rather than
          letting it spill over the centre. */}
      <div
        className={`mx-auto mb-3 grid w-full max-w-3xl grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1.5 rounded-card border border-reader-border/80 bg-reader-surface/95 px-2 py-2 shadow-l1 backdrop-blur sm:gap-3 sm:px-3 ${
          visible ? "pointer-events-auto" : "pointer-events-none"
        }`}
      >
        <div className="flex shrink-0 items-center gap-1 justify-self-start">{leftControls}</div>
        <div className="flex shrink-0 items-center gap-1 justify-self-center">{formatControls}</div>
        {/* No `justify-self-end`: that sizes the item to its content, letting a
            wide right cluster overflow its track and spill over the centre.
            Default `stretch` makes the item fill the track instead; flex
            `justify-end` right-aligns the content inside it, and `min-w-0` +
            `overflow-hidden` make the truncating chapter label actually shrink. */}
        <div className="flex min-w-0 items-center justify-end gap-2 overflow-hidden">
          {rightControls}
        </div>
      </div>
    </div>
  );
}

/**
 * Shared toolbar button styling so PDF and EPUB controls look consistent.
 * Exported for reuse by brief 07's EPUB controls.
 */
export function ToolbarButton({
  label,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={`grid h-9 min-w-9 place-items-center rounded-card px-2 text-reader-fg/80 transition hover:bg-reader-bg disabled:opacity-30 ${
        active ? "bg-reader-accent/15 text-reader-accent" : ""
      }`}
    >
      {children}
    </button>
  );
}
