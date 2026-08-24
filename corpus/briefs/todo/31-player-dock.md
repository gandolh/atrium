# Brief 31 — The persistent player dock

The one item in the rework that is a **capability, not a repaint**: playback
currently dies on navigation. Borrowed from the rejected *Vault* direction
(D33d). Depends on **brief 27**.

## Grilled decisions applied
- Playback state lifts **above the route** so it survives navigation.
- One dock, at the foot of the app shell, for music **and** video audio; opening
  a video full-surface hands off to the player and back.

## What to do
1. **Lift state** — a playback store (extend
   [reader-store.ts](../../../apps/web/src/store/reader-store.ts) or add a sibling)
   holding current item, position, playing/paused, volume. A **single**
   `<audio>` element owned by the shell, not by a route component — this is the
   whole point; a per-route element cannot survive navigation.
2. **Dock** — rendered in
   [root-layout.tsx](../../../apps/web/src/routes/root-layout.tsx): artwork,
   title, source, transport, scrub track, **tabular** elapsed/total (design.md
   "Components"). Hidden when nothing is loaded; rises 280ms on playback start
   (Motion Primitives), respecting reduced motion.
3. **Rewire players** — [AudioPlayer.tsx](../../../apps/web/src/player/AudioPlayer.tsx)
   and [MediaFrame.tsx](../../../apps/web/src/player/MediaFrame.tsx) drive the
   shared store instead of owning their own element. Video keeps its own
   `<video>` for picture; its transport reports to the dock.
4. **Progress sync** — keep brief 23's throttled `PATCH` and the
   **final-position flush** (a bug that was already found and fixed once — do not
   regress it) via
   [use-media-progress.ts](../../../apps/web/src/player/use-media-progress.ts).
5. **Resume** — clicking a dock title returns to the item's surface at the
   current position.
6. **Mobile** — dock compresses to artwork + title + play (see the phone comp).

## Must NOT touch
- The reading progress path for books (D31 semantics) beyond shared helpers.
- Backend, contract, offline store.

## Acceptance
- Start music, navigate the whole app: audio never stops, position never resets.
- Progress persists including the final flush; resume returns to the right spot.
- Video audio routes correctly with no double playback.
- Dock hidden when idle; mobile layout intact; three themes; typecheck + build clean.
