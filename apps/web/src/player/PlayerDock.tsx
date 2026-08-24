import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { AnimatePresence, motion } from "motion/react";

import { coverUrl } from "../lib/library-api";
import { useMotionTransition } from "../lib/motion";
import { usePlaybackStore, type PlaybackItem } from "../store/playback-store";
import {
  IconButton,
  PlayPauseButton,
  ScrubTrack,
  SkipButton,
  TimeReadout,
} from "./transport";

/**
 * The persistent player dock (brief 31, design.md "Components" → "Player
 * dock"): full-width, `paper-raised`, a 1px top `line`; artwork, title, source,
 * transport, scrub track and tabular elapsed/total. It lives in the app SHELL
 * (`routes/root-layout.tsx`), which is what lets it — and the playback it
 * controls — survive every navigation.
 *
 * Hidden entirely when nothing is loaded: this is a dock, not a permanent empty
 * bar. It rises from the foot in 280ms on the system curve when playback starts
 * (design.md "Motion" → "Dock enter"), and `useMotionTransition("dock")`
 * collapses that to an instant appearance under `prefers-reduced-motion`.
 *
 * Phone layout compresses to artwork + title + play (plus a dismiss): the scrub
 * track, the times, the ±15s skips and the mute control are desktop-only, and
 * the played fraction shows instead as a 3px line along the dock's top edge so
 * a phone still reads position at a glance.
 */

/**
 * The dock's height, in px. Exported because the shell — not the dock — is
 * responsible for reserving the space (`root-layout.tsx` pads the shell and
 * publishes `--dock-height` for surfaces that size themselves to the viewport).
 * One height for both breakpoints keeps that reservation a single number.
 */
export const DOCK_HEIGHT_PX = 64;

export function PlayerDock() {
  const item = usePlaybackStore((s) => s.item);
  const stop = usePlaybackStore((s) => s.stop);
  const transition = useMotionTransition("dock");

  return (
    <AnimatePresence>
      {item ? (
        <motion.div
          key="player-dock"
          role="region"
          aria-label="Now playing"
          // Rises from the foot; nothing bounces past its mark (design.md
          // "Motion"). `exit` runs the same move in reverse when the dock is
          // dismissed, so it leaves the way it arrived.
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={transition}
          style={{ height: DOCK_HEIGHT_PX }}
          className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-paper-raised"
        >
          {/* Phone-only position line — the scrub track's read-only stand-in. */}
          <MiniProgressLine />
          <div className="mx-auto flex h-full max-w-6xl items-center gap-3 px-page">
            <DockArtwork item={item} />
            <DockTitle item={item} />
            <div className="flex shrink-0 items-center gap-1">
              <span className="hidden sm:inline-flex">
                <SkipButton direction="back" />
              </span>
              <PlayPauseButton />
              <span className="hidden sm:inline-flex">
                <SkipButton direction="forward" />
              </span>
            </div>
            <div className="hidden min-w-0 flex-1 items-center gap-3 sm:flex">
              <ScrubTrack className="flex-1" />
              <TimeReadout />
            </div>
            <span className="hidden md:inline-flex">
              <MuteButton />
            </span>
            <IconButton label="Close the player" onClick={stop}>
              <CloseIcon className="h-[18px] w-[18px]" />
            </IconButton>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/** 40px square of artwork at the cover radius (2px — artwork is structural). */
function DockArtwork({ item }: { item: PlaybackItem }) {
  const [imgFailed, setImgFailed] = useState(false);
  const showArt = item.hasCover && !imgFailed;
  return (
    <div
      className={`grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-cover ${
        item.kind === "audio" ? "bg-tint-music" : "bg-tint-video"
      }`}
    >
      {showArt ? (
        <img
          src={coverUrl(item.id)}
          alt=""
          onError={() => setImgFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <KindGlyph kind={item.kind} className="h-5 w-5 text-ink-variant/70" />
      )}
    </div>
  );
}

/**
 * Title + source. The title is the way back: clicking it returns to the item's
 * surface, and because the store keeps the position (and re-loading the item
 * already loaded is a no-op for position and play state), that surface picks up
 * exactly where the dock was — brief 31's "resume".
 */
function DockTitle({ item }: { item: PlaybackItem }) {
  return (
    <div className="min-w-0 flex-1 sm:max-w-56">
      <Link
        to="/read"
        search={{ book: item.id, format: item.format }}
        className="block truncate rounded text-sm leading-tight font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {item.title}
      </Link>
      <p className="truncate text-xs text-ink-variant">
        {item.author ?? (item.kind === "audio" ? "Music" : "Video")}
      </p>
    </div>
  );
}

/** The played fraction as a 3px line across the dock's top edge, phones only. */
function MiniProgressLine() {
  const currentTime = usePlaybackStore((s) => s.currentTime);
  const storeDuration = usePlaybackStore((s) => s.duration);
  const itemDuration = usePlaybackStore((s) => s.item?.durationSeconds ?? null);
  const duration = storeDuration > 0 ? storeDuration : (itemDuration ?? 0);
  const pct = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;
  return (
    <div aria-hidden className="absolute inset-x-0 top-0 h-[3px] bg-paper-container sm:hidden">
      <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
    </div>
  );
}

function MuteButton() {
  const muted = usePlaybackStore((s) => s.muted);
  const toggleMuted = usePlaybackStore((s) => s.toggleMuted);
  return (
    <IconButton label={muted ? "Unmute" : "Mute"} onClick={toggleMuted}>
      <VolumeIcon muted={muted} className="h-[18px] w-[18px]" />
    </IconButton>
  );
}

function KindGlyph({ kind, className }: { kind: "audio" | "video"; className?: string }) {
  if (kind === "video") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className={className} aria-hidden>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path strokeLinejoin="round" d="M11 9.5v5l4-2.5z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className={className} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 18V6l11-2v12" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="17" cy="16" r="3" />
    </svg>
  );
}

function VolumeIcon({ muted, className }: { muted: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className={className} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 9.5h3L11 6v12l-4-3.5H4z" />
      {muted ? (
        <path strokeLinecap="round" d="M15 9.5l4.5 5M19.5 9.5l-4.5 5" />
      ) : (
        <path strokeLinecap="round" d="M15 9a4.5 4.5 0 0 1 0 6M17.5 6.5a8 8 0 0 1 0 11" />
      )}
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className={className} aria-hidden>
      <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
