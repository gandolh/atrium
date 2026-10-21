# Task 94: Jukebox: an idle report must not stop playback between songs

## Context

`jukebox.service.ts:566-575` (`reportStatus`): a report for the current playId with state idle sets
the Player idle, and `goIdle` drops the track. `advance` then returns `{play: null}` because the
Player is idle (`:602`). Reproduced: report idle for the current play, then advance(ended) gives no
play. A report with no voice channel during a Discord voice reconnect idles the Player in the same
way while audio continues. Whether it happens in practice depends on just-a-bot's timing: its
`finished()` sets its own state to idle before awaiting the advance.

Improvement sweep of 2026-10-20 (Jukebox lens), vetted against the code; the ranked report is the owner's "Repo improvement sweep" doc.

## Files you OWN

- `apps/api/src/modules/jukebox/jukebox.service.ts`
- tests

## What to do

1. Treat idle for the current play as "ended, waiting for the advance": do not drop the track on the report alone; go idle if no advance arrives within a few seconds.
2. Treat a missing voice channel as lost voice only if it persists across two reports.

## Acceptance

- Tests: an idle report then advance(ended) plays the next track; an idle report with no advance goes idle after the grace period.
