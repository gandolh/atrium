import { useCallback, useEffect, useRef } from "react";

import { updateProgress } from "../lib/library-api";

/**
 * Per-user resume for the audio/video players (D31 parity). Wires a
 * native `<audio>`/`<video>` element to the SAME progress-PATCH mechanism the
 * readers use — `updateProgress` (`PATCH /library/:id/progress`) — on the
 * player's own cadence:
 *
 * - `loadedmetadata` → seek to the saved `locator` (a seconds offset string),
 *   but only for media of at least `MIN_RESUME_DURATION_S` — short clips/tracks
 *   always restart from the beginning (their position is still saved, so the
 *   library's progress display keeps working).
 * - `timeupdate`, throttled to ~5s → PATCH `{progress, locator}`.
 * - `pause` → PATCH (so a deliberate stop is captured immediately).
 * - tab hide / SPA unmount → a final flush.
 *
 * `progress` = `currentTime / duration`, clamped 0..1 and guarded against a 0 /
 * NaN duration (metadata not ready). Media is excluded from offline v1, so this
 * PATCHes the server directly — it never touches the offline blob/progress
 * store (unlike `use-progress-sync`, which this deliberately does not reuse or
 * modify).
 *
 * Generic over the element type so `<audio>` (HTMLAudioElement) and `<video>`
 * (HTMLVideoElement) each get a correctly-typed ref.
 */
const THROTTLE_MS = 5000;
// Media shorter than this never resumes mid-way — rewatching/relistening from
// the start is cheaper than landing in the middle of a short clip or track.
const MIN_RESUME_DURATION_S = 10 * 60;

export interface MediaProgressHandlers<T extends HTMLMediaElement> {
  /** Attach to the media element so the hook can read its `currentTime`/`duration`. */
  mediaRef: React.RefObject<T | null>;
  onLoadedMetadata: () => void;
  onTimeUpdate: () => void;
  onPause: () => void;
}

export function useMediaProgress<T extends HTMLMediaElement>(
  bookId: string,
  resumeLocator: string | null,
): MediaProgressHandlers<T> {
  const mediaRef = useRef<T | null>(null);
  const lastSentAt = useRef(0);
  // Dedupe identical positions so a paused/settled element doesn't PATCH on a loop.
  const lastSignature = useRef<string | null>(null);
  // Latest position seen from the element, kept current on every timeupdate/pause
  // (cheap, no re-render). React nulls host refs BEFORE an effect's cleanup runs,
  // so the unmount flush can't read `mediaRef.current` for the final position — it
  // falls back to this snapshot instead, which is why the last position survives
  // in-app back-navigation.
  const lastSnapshot = useRef<{ currentTime: number; duration: number } | null>(null);

  const send = useCallback(
    (snapshot: { currentTime: number; duration: number } | null) => {
      if (!snapshot) return;
      const { currentTime, duration } = snapshot;
      // Guard: metadata not ready (duration 0 / NaN / Infinity) → nothing sound
      // to compute a fraction from yet.
      if (!Number.isFinite(duration) || duration <= 0) return;
      const progress = Math.min(Math.max(currentTime / duration, 0), 1);
      const locator = String(currentTime);
      const signature = `${locator}|${progress.toFixed(4)}`;
      if (signature === lastSignature.current) return;
      lastSignature.current = signature;
      // Best-effort, exactly like the readers' progress sync: a failed PATCH
      // (offline / server down) just means this position isn't persisted.
      void updateProgress(bookId, progress, locator).catch(() => {});
    },
    [bookId],
  );

  // Read the element's live position into `lastSnapshot` (for the unmount-flush
  // fallback) and return it. Returns null when the element is already gone.
  const snapshot = useCallback((): { currentTime: number; duration: number } | null => {
    const el = mediaRef.current;
    if (!el) return null;
    const snap = { currentTime: el.currentTime, duration: el.duration };
    lastSnapshot.current = snap;
    return snap;
  }, []);

  const onLoadedMetadata = useCallback(() => {
    const el = mediaRef.current;
    if (!el || !resumeLocator) return;
    // Short media restarts from the beginning instead of resuming. An unknown
    // duration (non-finite at loadedmetadata) counts as short: without a length
    // we can't tell it's long enough to be worth dropping into mid-way.
    if (!Number.isFinite(el.duration) || el.duration < MIN_RESUME_DURATION_S) return;
    const seconds = Number(resumeLocator);
    // Seek only to a sane position strictly inside the media; a stale locator at
    // or past the end would leave the element parked on the last frame.
    if (Number.isFinite(seconds) && seconds > 0 && seconds < el.duration) {
      try {
        el.currentTime = seconds;
      } catch {
        /* seeking can throw on some elements before they're ready — ignore. */
      }
    }
  }, [resumeLocator]);

  const onTimeUpdate = useCallback(() => {
    // Refresh the flush fallback every tick, even when throttled below.
    const snap = snapshot();
    const now = Date.now();
    if (now - lastSentAt.current < THROTTLE_MS) return;
    lastSentAt.current = now;
    send(snap);
  }, [send, snapshot]);

  const onPause = useCallback(() => send(snapshot()), [send, snapshot]);

  // Final flush on tab hide (mobile Safari may never fire a clean unload) and on
  // SPA unmount (navigating away without a page reload). By cleanup time React
  // has nulled `mediaRef.current`, so fall back to the last snapshot; the dedupe
  // in `send` keeps this from double-PATCHing a position already sent on pause.
  useEffect(() => {
    const flush = () => send(snapshot() ?? lastSnapshot.current);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [send, snapshot]);

  return { mediaRef, onLoadedMetadata, onTimeUpdate, onPause };
}
