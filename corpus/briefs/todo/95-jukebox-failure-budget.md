# Task 95: Jukebox: stop a Player whose songs keep failing

## Context

`jukebox.service.ts:606-610`: `advance(reason: 'error')` always takes the next track, and on
shuffle (which never runs out) or repeat-all it never stops. just-a-bot asks again immediately after
a failure (its `player.ts:173`, `:202`). If the media volume is missing after a deploy, the two loop
through the library as fast as HTTP allows: 200 consecutive `advance(error)` calls all returned a
play, the history is rewritten each time (capped at 100 rows, which also wipes shuffle's memory),
and each call is a full-library transaction (about 16 ms at 3000 tracks) on the single database
connection.

Improvement sweep of 2026-10-20 (Jukebox lens), vetted against the code; the ranked report is the owner's "Repo improvement sweep" doc.

## Files you OWN

- `apps/api/src/modules/jukebox/jukebox.service.ts`
- the Jukebox page's status line
- tests

## What to do

1. Count consecutive failed advances per Player; after five, go idle and show "Playback failed: …" on the page.
2. Reset the count on an advance with reason `ended`.

## Acceptance

- Tests: five consecutive `advance(error)` leave the Player idle with a failure status; an `ended` in between resets the count.
