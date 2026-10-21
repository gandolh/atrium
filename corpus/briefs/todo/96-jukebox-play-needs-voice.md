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
