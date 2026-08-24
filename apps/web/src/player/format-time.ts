/**
 * Format a playback position/length in seconds as `m:ss`, or `h:mm:ss` once it
 * reaches an hour — the dock's elapsed/total readout and the audio surface's.
 *
 * `body` already sets `font-variant-numeric: tabular-nums` (globals.css), so
 * digits line up and the readout doesn't jitter as the seconds tick without any
 * per-call-site class (design.md "Numbers line up").
 *
 * A non-finite length (metadata not ready, a live stream) reads as `--:--`
 * rather than `NaN:NaN`.
 */
export function formatTime(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null || !Number.isFinite(totalSeconds)) return "--:--";
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  if (hours >= 1) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
