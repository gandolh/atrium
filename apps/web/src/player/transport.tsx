import type { ReactNode } from "react";

import { usePlaybackStore } from "../store/playback-store";
import { formatTime } from "./format-time";

/**
 * The transport vocabulary shared by the persistent dock (`PlayerDock`) and the
 * full-surface audio view (`AudioPlayer`), brief 31. Both drive the same store,
 * so they must also *look* like the same instrument — one definition of the
 * play button, the ±15s skips, the scrub track and the time readout rather than
 * two that drift.
 *
 * design.md conformance: the play control is the system's one solid button (ink
 * fill, `on-ink-fill` glyph, 4px radius) — accent never fills a button, it only
 * ever marks state, which here is the played portion of the track, the scrub
 * handle and focus. Icons are inline line SVG at the unified 1.75 stroke.
 */

/** Seconds a skip button moves. 15s is the podcast/audiobook convention. */
const SKIP_SECONDS = 15;

export function PlayPauseButton({ size = "sm" }: { size?: "sm" | "lg" }) {
  const playing = usePlaybackStore((s) => s.playing);
  const toggle = usePlaybackStore((s) => s.toggle);
  const large = size === "lg";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={playing ? "Pause" : "Play"}
      className={`grid shrink-0 place-items-center rounded-card bg-ink-fill text-on-ink-fill transition-opacity ease-paper hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none ${
        large ? "h-14 w-14" : "h-9 w-9"
      }`}
    >
      {playing ? (
        <PauseIcon className={large ? "h-6 w-6" : "h-[18px] w-[18px]"} />
      ) : (
        <PlayIcon className={large ? "h-6 w-6" : "h-[18px] w-[18px]"} />
      )}
    </button>
  );
}

export function SkipButton({ direction }: { direction: "back" | "forward" }) {
  const nudge = usePlaybackStore((s) => s.nudge);
  const back = direction === "back";
  return (
    <IconButton
      label={back ? `Back ${SKIP_SECONDS} seconds` : `Forward ${SKIP_SECONDS} seconds`}
      onClick={() => nudge(back ? -SKIP_SECONDS : SKIP_SECONDS)}
    >
      <SkipIcon className="h-[18px] w-[18px]" flip={back} />
    </IconButton>
  );
}

/** A quiet, transparent icon control — the secondary button of the transport. */
export function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="grid h-8 w-8 shrink-0 place-items-center rounded-card text-ink-variant transition-colors ease-paper hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none"
    >
      {children}
    </button>
  );
}

/**
 * The scrub track: a 3px `paper-container` rail with the played portion in
 * accent (design.md "Progress: 3px"), a handle at the head, and a transparent
 * `<input type="range">` laid over it so dragging, tapping and **arrow keys**
 * all work without reimplementing a slider. The native control carries the
 * a11y semantics (`aria-valuenow` etc.) — the painted rail is decoration over
 * it, which is why the focus ring is driven by `has-[input:focus-visible]`.
 */
export function ScrubTrack({ className = "" }: { className?: string }) {
  const currentTime = usePlaybackStore((s) => s.currentTime);
  const storeDuration = usePlaybackStore((s) => s.duration);
  const itemDuration = usePlaybackStore((s) => s.item?.durationSeconds ?? null);
  const seek = usePlaybackStore((s) => s.seek);

  const duration = storeDuration > 0 ? storeDuration : (itemDuration ?? 0);
  const pct = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;

  return (
    <div
      className={`relative h-3 min-w-0 rounded-card has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-accent ${className}`}
    >
      <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 overflow-hidden rounded-full bg-paper-container">
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <span
        aria-hidden
        className="absolute top-1/2 h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent"
        style={{ left: `${pct}%` }}
      />
      <input
        type="range"
        min={0}
        max={duration > 0 ? duration : 0}
        step={0.5}
        value={Math.min(currentTime, duration > 0 ? duration : 0)}
        disabled={duration <= 0}
        onChange={(event) => seek(Number(event.target.value))}
        aria-label="Seek"
        aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration > 0 ? duration : null)}`}
        className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0 disabled:cursor-default"
      />
    </div>
  );
}

/**
 * `elapsed / total`, tabular by inheritance from `body` (design.md). `split`
 * pushes the two figures to the ends of their row — the full-surface layout,
 * where the readout sits under a full-width scrub track.
 */
export function TimeReadout({
  className = "",
  split,
}: {
  className?: string;
  split?: boolean;
}) {
  const currentTime = usePlaybackStore((s) => s.currentTime);
  const storeDuration = usePlaybackStore((s) => s.duration);
  const itemDuration = usePlaybackStore((s) => s.item?.durationSeconds ?? null);
  const duration = storeDuration > 0 ? storeDuration : (itemDuration ?? 0);
  const total = formatTime(duration > 0 ? duration : null);

  if (split) {
    return (
      <div className={`flex items-baseline justify-between text-xs text-ink-variant ${className}`}>
        <span>{formatTime(currentTime)}</span>
        <span>{total}</span>
      </div>
    );
  }
  return (
    <span className={`shrink-0 text-xs text-ink-variant ${className}`}>
      {formatTime(currentTime)}
      <span className="px-1 opacity-55">/</span>
      {total}
    </span>
  );
}

export function PlayIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
    </svg>
  );
}

export function PauseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M8.5 5.5h3v13h-3zM12.5 5.5h3v13h-3z" fill="currentColor" />
    </svg>
  );
}

/** Circular arrow with the skip amount inside — mirrored for "back". */
function SkipIcon({ className, flip }: { className?: string; flip?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      className={className}
      aria-hidden
      style={flip ? { transform: "scaleX(-1)" } : undefined}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 5a7 7 0 1 1-6.6 4.7M12 5 8.6 2.4M12 5 8.6 7.6"
      />
    </svg>
  );
}
