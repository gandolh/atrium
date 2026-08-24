import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createTimeline, type Timeline } from "animejs";

import { MOTION_MS, usePrefersReducedMotion } from "../../lib/motion";

/** A chapter boundary on the rail, as a 0–100 percentage plus its title. */
export interface RailTick {
  pct: number;
  label: string;
}

/**
 * Scrubbable reading-progress rail (the reader's one moment of delight), shared
 * by both readers (brief 08 — formerly EPUB-only). A hairline strip along the
 * very bottom edge: accent-filled to the current position, faint ticks at
 * chapter boundaries, and a small accent **knob** at the current spot so the
 * strip reads as a grabbable handle rather than decor (the hit area is a
 * taller-than-visible 24px band). Hovering reveals the chapter under the
 * pointer; clicking,
 * dragging (pointer capture — mouse or touch), or arrow keys when focused jump
 * there. While dragging, the fill and tooltip preview the grab position; the
 * seek commits ONCE on release (a live seek per pointermove would thrash the
 * EPUB rendition). Appears and fades with the rest of the chrome; never steals
 * reading space.
 *
 * The drag preview (brief 32) is driven by an anime.js `Timeline`, the ONE
 * sanctioned use of the library (design.md "Motion") — an imperative escape
 * from React state for the fill/knob's continuous position, scrubbed via
 * `.seek()` on every pointermove rather than a `setState` (`hover` already
 * re-renders on every move for the tooltip; routing the fill/knob through the
 * SAME state would mean React reconciling those styles on every tick instead
 * of anime writing them directly to the DOM). The mapping is deliberately
 * LINEAR: the preview must track the pointer exactly, not ease toward it, or
 * the fill would visually promise a release position it doesn't land on.
 * Under reduced motion the timeline is skipped and JSX renders the fill/knob
 * straight from `shownPct` instead — both paths commit the seek identically
 * (see `onPointerUp`, unchanged from brief 08).
 */
export function ProgressRail({
  percent,
  totalPages,
  ticks,
  visible,
  onSeek,
}: {
  /** Current position, 0–100. */
  percent: number;
  /** Total location-based page count; tooltip shows pages when available. */
  totalPages?: number | null;
  ticks: RailTick[];
  visible: boolean;
  /** Jump to a 0–100 position. */
  onSeek: (pct: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLSpanElement>(null);
  const timelineRef = useRef<Timeline | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  const [hover, setHover] = useState<{ x: number; pct: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  // One paused anime.js timeline per mount, scrubbed via `.seek()`/`.progress`
  // as the pointer moves. `duration: 100` is a unit choice, not a playback
  // speed — it's never played, only sought, so time (ms) maps 1:1 onto percent
  // (0–100). `ease: "linear"` for the same reason: no smoothing, exact tracking.
  useLayoutEffect(() => {
    if (reducedMotion) return;
    const fill = fillRef.current;
    const knob = knobRef.current;
    if (!fill || !knob) return;
    const tl = createTimeline({
      autoplay: false,
      // The knob's `left` uses the same `clamp()` the CSS-only fallback did —
      // anime can't natively tween INTO a `calc()` end value, so it's set here
      // from the timeline's own progress instead of as a native property tween.
      onUpdate: (self) => {
        knob.style.left = `clamp(6px, ${self.progress * 100}%, calc(100% - 6px))`;
      },
    }).add(fill, { width: { from: "0%", to: "100%" }, duration: 100, ease: "linear" }, 0);
    timelineRef.current = tl;
    tl.seek(percent);
    return () => {
      tl.revert();
      timelineRef.current = null;
    };
    // Only (re)built when motion allowance flips — `percent` is synced by the
    // idle-sync effect below, not by recreating the timeline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedMotion]);

  // Idle sync: whenever the committed `percent` changes from OUTSIDE a drag
  // (auto page-turn, a completed seek, resize), mirror it onto the timeline so
  // the fill/knob track it — the same imperative path the drag preview uses,
  // just driven by the prop instead of the pointer. Skipped while dragging
  // (the pointer owns the timeline then) and under reduced motion (JSX owns
  // the style directly there).
  useLayoutEffect(() => {
    if (reducedMotion || dragging) return;
    timelineRef.current?.seek(percent);
  }, [percent, dragging, reducedMotion]);

  const pctFromEvent = useCallback((clientX: number) => {
    const el = trackRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100));
  }, []);

  // Tooltip x, clamped to the track so a captured drag past the edges doesn't
  // strand the tooltip off-screen.
  const tooltipXFromEvent = useCallback((clientX: number) => {
    const el = trackRef.current;
    if (!el) return clientX;
    const rect = el.getBoundingClientRect();
    return Math.min(rect.right, Math.max(rect.left, clientX));
  }, []);

  const chapterAt = useCallback(
    (pct: number): string | null => {
      let label: string | null = null;
      for (const t of ticks) {
        if (t.pct <= pct) label = t.label;
        else break;
      }
      return label;
    },
    [ticks],
  );

  // Drive the anime.js timeline's live preview to `pct` — a no-op under
  // reduced motion (JSX renders `shownPct` directly there instead, see below).
  const previewTo = useCallback(
    (pct: number) => {
      if (!reducedMotion) timelineRef.current?.seek(pct);
    },
    [reducedMotion],
  );

  const hoverLabel = hover ? chapterAt(hover.pct) : null;
  // `hover.pct` is already updated on every pointermove that matters for a
  // drag (see the handlers below — mouse always, touch only while dragging),
  // so it doubles as the live drag value for BOTH the ARIA `aria-valuenow`
  // (must track the pointer for a screen-reader user regardless of which
  // visual path is driving the fill) and the reduced-motion fallback style.
  const shownPct = dragging && hover ? hover.pct : percent;

  return (
    <div
      // While hovered or dragged the rail (and its tooltip) must rise above the
      // toolbar pill (z-30), which otherwise paints over the tooltip.
      className={`absolute inset-x-0 bottom-0 transition-opacity ease-paper ${
        hover || dragging ? "z-40" : "z-20"
      } ${visible ? "opacity-100" : "pointer-events-none opacity-0"}`}
      // design.md "Motion": 600ms out / 150ms in, same asymmetric fade as the
      // running header/toolbar (all three chrome pieces move together).
      style={{ transitionDuration: `${visible ? MOTION_MS.chromeIn : MOTION_MS.chromeOut}ms` }}
    >
      {hover && (
        <div
          className="pointer-events-none absolute bottom-5 -translate-x-1/2 whitespace-nowrap rounded-card border border-reader-border bg-reader-surface px-2 py-1 text-xs text-reader-fg shadow-l1"
          style={{ left: hover.x }}
        >
          {hoverLabel ? `${hoverLabel} · ` : ""}
          {totalPages
            ? `${Math.max(1, Math.min(totalPages, Math.round((hover.pct / 100) * totalPages)))}/${totalPages}`
            : `${Math.round(hover.pct)}%`}
        </div>
      )}

      <div
        ref={trackRef}
        role="slider"
        aria-label="Reading progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(shownPct)}
        tabIndex={0}
        // touch-none: a touch drag scrubs the rail, never scrolls the page.
        // Taller hit area (h-6) + grab cursor so the hairline is actually
        // catchable and reads as draggable (was a 16px band, easy to miss).
        className="group relative h-6 cursor-grab touch-none outline-none active:cursor-grabbing"
        onPointerDown={(e) => {
          // Left button only for mice; any contact for touch/pen.
          if (e.pointerType === "mouse" && e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          const pct = pctFromEvent(e.clientX);
          setDragging(true);
          previewTo(pct);
          setHover({ x: tooltipXFromEvent(e.clientX), pct });
        }}
        onPointerMove={(e) => {
          if (!dragging && e.pointerType !== "mouse") return;
          const pct = pctFromEvent(e.clientX);
          setHover({ x: tooltipXFromEvent(e.clientX), pct });
          if (dragging) previewTo(pct);
        }}
        onPointerUp={(e) => {
          if (!dragging) return;
          setDragging(false);
          if (e.pointerType !== "mouse") setHover(null);
          // Commit once, on release — this is also the plain-click path.
          onSeek(pctFromEvent(e.clientX));
        }}
        onPointerCancel={() => {
          // Aborted drag (e.g. the browser reclaimed the gesture): no seek.
          setDragging(false);
          setHover(null);
        }}
        onPointerLeave={() => {
          // Pointer capture keeps events flowing mid-drag; only a true
          // walk-away (not dragging) dismisses the tooltip.
          if (!dragging) setHover(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            // Don't let the global page-turn keys double-handle this.
            e.preventDefault();
            e.stopPropagation();
            const delta = e.key === "ArrowLeft" ? -2 : 2;
            onSeek(Math.min(100, Math.max(0, percent + delta)));
          }
        }}
      >
        <div
          className={`absolute inset-x-0 bottom-0 bg-reader-border/60 transition-all duration-150 group-hover:h-[8px] group-focus-visible:h-[8px] group-focus-visible:ring-1 group-focus-visible:ring-reader-accent ${
            dragging ? "h-[8px]" : "h-[4px]"
          }`}
        >
          <div
            ref={fillRef}
            className="h-full bg-reader-accent"
            // While motion is allowed the anime.js timeline (above) owns this
            // element's width directly — omitting the style here (rather than
            // setting it to a stale value) keeps React's reconciliation from
            // fighting that on every re-render `hover` causes mid-drag.
            style={reducedMotion ? { width: `${shownPct}%` } : undefined}
          />
          {ticks.map((t) => (
            <span
              key={`${t.pct}-${t.label}`}
              className="absolute bottom-0 h-full w-px bg-reader-fg/25"
              style={{ left: `${t.pct}%` }}
            />
          ))}
        </div>

        {/* Draggable knob at the current position — the affordance that says
            "grab me here". Sits ON the bottom line and rises upward (never
            below the screen edge), always visible while the rail is shown and
            growing on hover/drag. `clamp` keeps the 12px dot fully on-screen at
            0% / 100% instead of half-clipping past the edge. */}
        <span
          ref={knobRef}
          aria-hidden="true"
          className={`pointer-events-none absolute bottom-0 h-3 w-3 -translate-x-1/2 rounded-full border-2 border-reader-surface bg-reader-accent shadow transition-transform duration-150 group-hover:scale-110 group-focus-visible:scale-110 ${
            dragging ? "scale-125" : ""
          }`}
          style={
            reducedMotion
              ? { left: `clamp(6px, ${shownPct}%, calc(100% - 6px))` }
              : undefined
          }
        />
      </div>
    </div>
  );
}
