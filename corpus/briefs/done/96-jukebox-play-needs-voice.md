# Task 96: Jukebox: say "join a voice channel first" instead of pretending to play

## Context

`control()` (`jukebox.service.ts:454-458`) checks only that the bot is online. Play, Next,
Previous and Play-this-song start a track and queue a play command while the Player has no voice
channel, and the page enables Play in that state (`NowPlaying.tsx:39`, `:72`). The bot then
reports idle, so the page shows Playing briefly and flips back to Stopped. Reproduced: a report
with no voice channel, then `control play` → playing, a track, no voice channel.

Improvement sweep of 2026-10-20 (Jukebox lens), vetted against the code; the ranked report is the owner's "Repo improvement sweep" doc.

## Files you OWN

- `apps/api/src/modules/jukebox/jukebox.service.ts` (`control`)
- the Jukebox page's `NowPlaying.tsx`
- tests

## What to do

1. Refuse play-type controls with 409 `NOT_IN_VOICE` while the Player has no voice channel.
2. On the page, disable Play in that state and point at Join.

## Acceptance

- A test: `control play` with no voice channel answers 409.
- The page shows the hint instead of a dead Play button.

## Outcome (2026-10-27)

**Done**, code in `4e6bebb`.

- [`control()`](../../../apps/api/src/modules/jukebox/jukebox.service.ts) refuses
  `play`, `resume`, `next`, `previous` and `playTrack` with 409 `NOT_IN_VOICE`
  while `voice_channel_id` is null, after the offline check. `resume` is not in the
  brief's list; it continues a Track in the same way, so it is refused too. Pause,
  Stop, Leave, Join, settings and Queue edits are unchanged. `join` writes the
  channel before the bot acts on it, so Join then Play is accepted at once.
- [`NowPlaying.tsx`](../../../apps/web/src/jukebox/NowPlaying.tsx): with no voice
  channel (and the bot online), Previous, Play and Next are disabled; Pause stays
  usable if a Track is playing. A line under the transport says "Join a voice
  channel below to play: pick one and press Join.", and the disabled Play button
  points at it (`aria-describedby`, and its title). First tried as part of the
  voice row's "Not in a voice channel", but that text is `truncate` and was cut at
  1280 px, so the hint got its own line.
- [`use-jukebox.ts`](../../../apps/web/src/jukebox/use-jukebox.ts), one line
  outside the brief's file list: `NOT_IN_VOICE` gets its own message, because the
  Playlist's "Play now" buttons (`PlaylistPanel.tsx`, not touched) still send
  `playTrack` and would otherwise say "Couldn't reach atrium".

**Checked:**
- [`jukebox.test.ts`](../../../apps/api/test/jukebox.test.ts): a Player reported
  with no voice channel answers 409 `NOT_IN_VOICE` to all five, stays idle with no
  Track and has no command queued for the bot; Stop is still 200; Join then Play
  starts a Track.
- In a browser on the scratch library with the stand-in bot (brief 95's setup),
  after the stand-in restarted out of any channel: Previous, Play and Next disabled,
  the hint shown, Play's title "Join a voice channel to play"; the Playlist's "Play
  Low Tide now" showed "Join a voice channel first: pick one and press Join."; after
  Join the hint went, Play was enabled, and Play reached the stand-in as `join`
  then `play`. Light, Warm and Dark at 1280 px. Design checklist: tokens only,
  Archivo, no accent, no new radius or motion.
- `npm run typecheck`, the web build and the API suite (128 of 128) are clean.

**Left:** the voice row's own "Not in a voice channel" is cut to "Not in a voice
ch…" at 1280 px, as it was before this brief (the select and two buttons share the
row). Discord's `/jukebox` command reaches `control` through the same route, so the
bot now gets 409 `NOT_IN_VOICE` where it used to get a 200 and a dead play; whether
it words that well is just-a-bot's, and was not checked.
