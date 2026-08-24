import { create } from "zustand";
import type { FileType, LibraryBook } from "@ebook-reader/shared";

/**
 * Media playback state, lifted **above the route** (brief 31, D33 move 4:
 * "playback persists"). This is the whole point of the store: a media element
 * owned by a route component dies the moment the route unmounts, so before this
 * brief starting a track and going back to the library silently stopped it.
 *
 * Deliberately a SIBLING of `reader-store.ts`, not an extension of it: that
 * store is the reader's in-memory session (theme, font settings, the handed-over
 * `File`) and is consumed by every reader surface. Playback shares none of that
 * state and has a different lifetime, so mixing the two would make every reader
 * component re-render on each `timeupdate`.
 *
 * ## Who owns the sound
 * Exactly one element makes sound at a time, named by `output`:
 *
 * - `"dock"` — the single `<audio>` the app shell owns (`player/PlaybackHost`).
 *   This is the survives-navigation case: the element is mounted by the shell,
 *   so no route change can unmount it.
 * - `"surface"` — the full-screen `<video>` on `/read` owns it, because video
 *   needs its own element for the picture. The dock's `<audio>` is not merely
 *   paused in this state, it is **not rendered at all** (see `PlaybackHost`) —
 *   the "no double audio" guarantee is structural rather than a mute flag that
 *   could get out of sync. The video surface claims the output when it mounts
 *   (`load(item, { output: "surface" })`) and hands it back when it unmounts
 *   (`releaseSurface`), which is the "hands off to the player and back" of the
 *   brief: leave a playing video and its audio continues in the dock.
 *
 * The audio surface (`player/AudioPlayer`) never owns an element at all — it is
 * a big remote control for the shell's `<audio>`.
 *
 * ## Position
 * `currentTime`/`duration` are **reports** from whichever element owns the
 * output (`reportProgress`), so the store is a mirror, never the clock. Seeks
 * travel the other way as a `pendingSeek` the owning element applies and then
 * clears — a plain `currentTime` write would be indistinguishable from a report
 * and would fight the element on every tick.
 *
 * Per-user *persistence* of the position is untouched by all this: it stays in
 * `player/use-media-progress.ts` (brief 23's throttled PATCH + final flush),
 * attached to whichever element is mounted.
 */

/** Only audio and video play; books read (`kind: "book"`) and notes are drawn. */
export type PlaybackMediaKind = "audio" | "video";

/** Which element currently owns the sound — see the module comment. */
export type PlaybackOutput = "dock" | "surface";

/**
 * The playing item, flattened out of `LibraryBook` (see `playbackItemFromBook`)
 * to exactly what the dock and the elements need. Copied rather than referenced
 * so a library refetch can't swap the object under a playing track.
 */
export interface PlaybackItem {
  id: string;
  title: string;
  author: string | null;
  kind: PlaybackMediaKind;
  /** Needed for the dock's "back to the surface" link (`/read?format=…`). */
  format: FileType;
  hasCover: boolean;
  /** Server-known length, or null — the dock's total time before metadata lands. */
  durationSeconds: number | null;
  /** The row's stored resume position (a seconds offset as a string), for `useMediaProgress`. */
  locator: string | null;
}

export interface PlaybackState {
  /** `null` = nothing loaded, which is what hides the dock (never an empty bar). */
  item: PlaybackItem | null;
  output: PlaybackOutput;
  /** Play/pause INTENT. The owning element follows it and reports back. */
  playing: boolean;
  currentTime: number;
  /** Measured length once metadata lands; falls back to `item.durationSeconds`. */
  duration: number;
  /** 0..1, applied to whichever element owns the output. */
  volume: number;
  muted: boolean;
  /** A seek the owning element hasn't applied yet. `nonce` keeps repeats distinct. */
  pendingSeek: { time: number; nonce: number } | null;

  /**
   * Make `item` the playing item. Re-loading the item that is ALREADY loaded is
   * a no-op for position and play state (`autoplay` included) — clicking the
   * dock title of a paused track must return to its surface without secretly
   * resuming it, and must not restart a playing one.
   */
  load: (
    item: PlaybackItem,
    options?: { autoplay?: boolean; output?: PlaybackOutput },
  ) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  /** Report the element's real play state (its own `play`/`pause`/`ended` events). */
  reportPlaying: (playing: boolean) => void;
  /** Report the element's position; a non-finite/0 duration leaves `duration` alone. */
  reportProgress: (currentTime: number, duration: number) => void;
  /** Ask the owning element to seek (absolute seconds). */
  seek: (time: number) => void;
  /** Seek relative to the current position (the ±15s transport buttons). */
  nudge: (deltaSeconds: number) => void;
  /** Called by the element once it has applied that exact seek. */
  clearPendingSeek: (nonce: number) => void;
  /** Hand the output back to the dock when a surface element unmounts. */
  releaseSurface: (itemId: string) => void;
  setVolume: (volume: number) => void;
  toggleMuted: () => void;
  /** Unload everything — the dock's close button. Hides the dock. */
  stop: () => void;
}

let seekNonce = 0;

function clampTime(time: number, duration: number): number {
  const upper = Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(time, 0), upper);
}

const initialState = {
  item: null as PlaybackItem | null,
  output: "dock" as PlaybackOutput,
  playing: false,
  currentTime: 0,
  duration: 0,
  volume: 1,
  muted: false,
  pendingSeek: null as { time: number; nonce: number } | null,
};

export const usePlaybackStore = create<PlaybackState>((set) => ({
  ...initialState,

  load: (item, options = {}) =>
    set((state) => {
      const same = state.item?.id === item.id;
      if (same) {
        // Same track: only the output can change (audio surface ⇄ dock ⇄ video
        // surface). Position and play state are the element's, not ours.
        return { item, output: options.output ?? state.output };
      }
      return {
        item,
        output: options.output ?? "dock",
        playing: options.autoplay ?? false,
        currentTime: 0,
        duration: item.durationSeconds ?? 0,
        pendingSeek: null,
      };
    }),

  play: () => set({ playing: true }),
  pause: () => set({ playing: false }),
  toggle: () => set((state) => ({ playing: !state.playing })),
  reportPlaying: (playing) => set({ playing }),

  reportProgress: (currentTime, duration) =>
    set((state) => ({
      currentTime,
      duration: Number.isFinite(duration) && duration > 0 ? duration : state.duration,
    })),

  seek: (time) =>
    set((state) => {
      const target = clampTime(time, state.duration);
      // `currentTime` moves immediately so the scrub track tracks the pointer;
      // the element confirms it on its next `seeked`/`timeupdate`.
      return { currentTime: target, pendingSeek: { time: target, nonce: ++seekNonce } };
    }),

  nudge: (deltaSeconds) =>
    set((state) => {
      const target = clampTime(state.currentTime + deltaSeconds, state.duration);
      return { currentTime: target, pendingSeek: { time: target, nonce: ++seekNonce } };
    }),

  clearPendingSeek: (nonce) =>
    set((state) =>
      // Only the seek the element actually applied is cleared: a newer one that
      // landed in between must survive to be applied in turn.
      state.pendingSeek && state.pendingSeek.nonce === nonce ? { pendingSeek: null } : {},
    ),

  releaseSurface: (itemId) =>
    set((state) =>
      state.item?.id === itemId && state.output === "surface" ? { output: "dock" } : {},
    ),

  setVolume: (volume) => set({ volume: Math.min(Math.max(volume, 0), 1), muted: false }),
  toggleMuted: () => set((state) => ({ muted: !state.muted })),

  // Unloading unmounts the owning element, whose `useMediaProgress` cleanup
  // flushes the final position on the way out (brief 23) — so "close the dock"
  // still records where the listener stopped.
  stop: () => set({ ...initialState }),
}));

/**
 * Narrow a library row to a {@link PlaybackItem}, or `null` when the row isn't
 * playable (a book or an unknown kind). The single conversion point: the dock,
 * both media surfaces and any future "play from a tile" affordance all go
 * through it, so the item shape can't drift per call site.
 */
export function playbackItemFromBook(book: LibraryBook): PlaybackItem | null {
  const kind = book.kind ?? "book";
  if (kind !== "audio" && kind !== "video") return null;
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    kind,
    format: book.format,
    hasCover: book.hasCover,
    durationSeconds: book.durationSeconds,
    locator: book.locator,
  };
}
