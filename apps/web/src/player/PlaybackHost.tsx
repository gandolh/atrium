import { usePlaybackStore, type PlaybackItem } from "../store/playback-store";
import { mediaFileUrl } from "./media-url";
import { PlayerDock } from "./PlayerDock";
import { usePlaybackElement } from "./use-playback-element";

/**
 * Everything the app SHELL owns for playback (brief 31): the single `<audio>`
 * element and the dock that drives it. Mounted once by
 * `routes/root-layout.tsx`, inside the auth gate, so neither is a child of any
 * route — which is the entire point of the brief. A `<audio>` owned by a route
 * component is destroyed by the navigation away from that route; this one isn't,
 * so a track keeps playing across the whole app.
 *
 * The element is rendered **only while the dock owns the output**. When the
 * full-surface `<video>` is up it owns the sound (`output: "surface"`) and this
 * element does not exist at all — the no-double-audio guarantee is structural,
 * not a mute flag two components have to agree about. Coming back off that
 * surface flips the output here and the element remounts, picking the position
 * up from the store (see `usePlaybackElement`'s hand-off seek).
 *
 * Keying by `item.id` is deliberate: a new track gets a genuinely new element
 * (fresh `src`, fresh resume seek) and the outgoing one unmounts — which is what
 * flushes the previous track's final position through `useMediaProgress`.
 */
export function PlaybackHost() {
  const item = usePlaybackStore((s) => s.item);
  const output = usePlaybackStore((s) => s.output);

  return (
    <>
      {item && output === "dock" ? <DockAudio key={item.id} item={item} /> : null}
      <PlayerDock />
    </>
  );
}

function DockAudio({ item }: { item: PlaybackItem }) {
  const { mediaRef, handlers } = usePlaybackElement<HTMLAudioElement>(item);
  return (
    <audio
      ref={mediaRef}
      src={mediaFileUrl(item.id)}
      preload="metadata"
      // No `controls`: the dock IS the interface. Hidden (a display:none audio
      // element still plays) rather than positioned off-screen.
      className="hidden"
      {...handlers}
    />
  );
}
