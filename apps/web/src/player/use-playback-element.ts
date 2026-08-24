import { useCallback, useEffect, useRef, useState } from "react";

import { usePlaybackStore, type PlaybackItem } from "../store/playback-store";
import { useMediaProgress } from "./use-media-progress";

/**
 * Binds ONE `<audio>`/`<video>` element to the playback store (brief 31): the
 * element follows the store's play/pause intent, seeks and volume, and reports
 * its real position and play state back. Used by both element owners — the app
 * shell's single `<audio>` (`PlaybackHost`) and the full-surface `<video>`
 * (`VideoPlayer`) — so the two can't drift into two subtly different transports.
 *
 * It wraps, and does not replace, `useMediaProgress` (brief 23): per-user resume
 * and the throttled progress PATCH **including the final flush on unmount** stay
 * exactly where they were. Every handler below calls the progress hook's handler
 * FIRST, because that's what refreshes the hook's `lastSnapshot` — the fallback
 * the unmount flush reads after React has nulled the element ref (a lost final
 * position was found and fixed there once; do not reorder these).
 *
 * ## The hand-off seek
 * An element can mount into a session that is already mid-track: leaving a
 * playing video hands its audio to the dock at, say, 87s. Seeking after `play()`
 * would blip a moment of audio from 0, so the position is captured once at mount
 * (`handoffAt`), applied on `loadedmetadata`, and playback is gated on that being
 * done (`canPlay`). When there is nothing to hand off (`handoffAt` ≈ 0 — a fresh
 * open) the gate is open from the start and `useMediaProgress`'s stored-locator
 * resume is what positions the element, unchanged from brief 23.
 *
 * There is only something to hand off when the store is ALREADY on this item
 * (see `handoffPositionFor`) — otherwise a fresh open would inherit the
 * outgoing track's position.
 */
export interface PlaybackElementBinding<T extends HTMLMediaElement> {
  /** Attach to the media element. */
  mediaRef: React.RefObject<T | null>;
  /** Spread onto the media element — all of them, or the store goes stale. */
  handlers: {
    onLoadedMetadata: () => void;
    onTimeUpdate: () => void;
    onPause: () => void;
    onPlay: () => void;
    onSeeked: () => void;
    onEnded: () => void;
    onError: () => void;
  };
}

/**
 * The position a freshly mounted element should be handed: the store's live
 * `currentTime`, but ONLY when the store already describes this same item.
 *
 * The guard matters because an element owner can render BEFORE its own
 * `load()` lands — `VideoPlayer`'s `VideoSurface` calls `usePlaybackElement`
 * during render and calls `load(item, …)` in an effect afterwards — so at seed
 * time the store can still hold the PREVIOUS item and its position. Without the
 * id check, opening a video while a track played at 1:27 started the video at
 * 1:27, overriding both "start at 0" and the row's own saved resume locator.
 * (`load()` on the item that is already loaded deliberately KEEPS `currentTime`,
 * so a genuine dock↔surface hand-off still reads a real position here.)
 */
function handoffPositionFor(item: PlaybackItem): number {
  const state = usePlaybackStore.getState();
  return state.item?.id === item.id ? state.currentTime : 0;
}

export function usePlaybackElement<T extends HTMLMediaElement>(
  item: PlaybackItem,
): PlaybackElementBinding<T> {
  const {
    mediaRef,
    onLoadedMetadata: progressLoadedMetadata,
    onTimeUpdate: progressTimeUpdate,
    onPause: progressPause,
  } = useMediaProgress<T>(item.id, item.locator);

  const playing = usePlaybackStore((s) => s.playing);
  const volume = usePlaybackStore((s) => s.volume);
  const muted = usePlaybackStore((s) => s.muted);
  const pendingSeek = usePlaybackStore((s) => s.pendingSeek);
  const reportPlaying = usePlaybackStore((s) => s.reportPlaying);
  const reportProgress = usePlaybackStore((s) => s.reportProgress);
  const clearPendingSeek = usePlaybackStore((s) => s.clearPendingSeek);
  const pause = usePlaybackStore((s) => s.pause);

  // Read ONCE, at mount: from here on the element is the authority on its own
  // position, and re-reading the store would fight it.
  const handoffAt = useRef(handoffPositionFor(item));
  const [canPlay, setCanPlay] = useState(() => handoffAt.current <= 0.5);

  const report = useCallback(() => {
    const el = mediaRef.current;
    if (el) reportProgress(el.currentTime, el.duration);
  }, [mediaRef, reportProgress]);

  const onLoadedMetadata = useCallback(() => {
    progressLoadedMetadata();
    const el = mediaRef.current;
    const at = handoffAt.current;
    handoffAt.current = 0;
    if (el && at > 0.5) {
      // Guard a stale hand-off position past the end (the element would park on
      // the last frame); an unknown duration means "seek, we can't check".
      if (!Number.isFinite(el.duration) || at < el.duration) {
        try {
          el.currentTime = at;
        } catch {
          /* seeking can throw before the element is ready — keep going. */
        }
      }
    }
    setCanPlay(true);
    report();
  }, [mediaRef, progressLoadedMetadata, report]);

  const onTimeUpdate = useCallback(() => {
    progressTimeUpdate();
    report();
  }, [progressTimeUpdate, report]);

  const onPause = useCallback(() => {
    progressPause();
    reportPlaying(false);
  }, [progressPause, reportPlaying]);

  const onPlay = useCallback(() => reportPlaying(true), [reportPlaying]);
  const onSeeked = useCallback(() => report(), [report]);
  const onEnded = useCallback(() => {
    progressPause();
    reportPlaying(false);
  }, [progressPause, reportPlaying]);
  const onError = useCallback(() => reportPlaying(false), [reportPlaying]);

  // Follow the play/pause intent. `play()` can be rejected (autoplay policy on a
  // refresh, or an interrupting pause) — the store is then corrected to paused
  // rather than left claiming to play.
  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;
    if (playing) {
      if (!canPlay) return;
      const started = el.play();
      if (started) void started.catch(() => pause());
    } else {
      el.pause();
    }
  }, [playing, canPlay, mediaRef, pause]);

  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;
    el.volume = volume;
    el.muted = muted;
  }, [volume, muted, mediaRef]);

  // Apply a requested seek, then clear it so it can't be re-applied. Before
  // metadata lands the element ignores `currentTime` writes, so the request is
  // folded into the hand-off position instead and applied on `loadedmetadata`.
  useEffect(() => {
    if (!pendingSeek) return;
    const el = mediaRef.current;
    if (!el) return;
    if (!Number.isFinite(el.duration) || el.duration <= 0) {
      handoffAt.current = pendingSeek.time;
      clearPendingSeek(pendingSeek.nonce);
      return;
    }
    try {
      el.currentTime = pendingSeek.time;
    } catch {
      /* ignore — the store keeps the requested position for the UI. */
    }
    clearPendingSeek(pendingSeek.nonce);
  }, [pendingSeek, mediaRef, clearPendingSeek]);

  return {
    mediaRef,
    handlers: { onLoadedMetadata, onTimeUpdate, onPause, onPlay, onSeeked, onEnded, onError },
  };
}
