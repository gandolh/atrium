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

## Outcome (2026-08-24) — DONE
Landed as committed `f69fb73`. Playback lives above the route in its own store;
the shell owns the single `<audio>`; audio survives navigation.

The **no-double-audio guarantee is structural**, which is better than the brief
asked for: the dock's `<audio>` is not rendered at all while the full-surface
`<video>` owns the output, rather than being muted by a flag two components
have to keep in sync. Verified in a browser — zero `<audio>` elements in the
DOM while a video plays.

Two defects the review pass caught, both fixed in `4a77b51`:
- **a new video inherited the previous track's position.** The handoff seed was
  read during render, before the `load()` effect swapped the item, so opening a
  video after a track at 1:27 started the video at 1:27 — overriding its own
  saved resume locator.
- the dock **covered the reader's progress rail.** Readers are `fixed inset-0`
  and so ignored the shell's bottom padding; the rail, the reader's only scrub
  control, sat underneath and could not be clicked while anything played.

Brief 23's throttled progress PATCH and its final flush both survive. Known and
accepted: closing the dock while the video surface is mounted leaves the
`<video>` in the tree with no store item.
