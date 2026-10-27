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

## Outcome (2026-10-27)

**Done**, code in `42df849`.

- **Idle for the current play** ([`reportStatus`](../../../apps/api/src/modules/jukebox/jukebox.service.ts))
  no longer sets the state: it stamps `idle_reported_at` (the first stamp counts if
  a second idle report comes) and the Player keeps its Track and its believed
  state. The `advance` that follows finds a playing Player and plays the next
  Track as before. A later playing or paused report for the play clears the stamp,
  as do `startTrack` (any new play) and `goIdle` (any stop), and brief 92's
  delete-to-idle.
- **The grace** is `IDLE_REPORT_GRACE_MS`, 5 s; the brief said "a few seconds",
  and the bot's advance normally follows its idle in one request.
  `expireIdleReport` runs at the start of every operation on a Player
  (`withPlayer`: controls, Queue edits, reports, advances, reads) and for every
  row of `listPlayers`, which the page polls every 1.5 s. So the Player goes idle
  when someone next looks, not on a timer, and a late `advance` meets the
  existing "already idle, start nothing" rule. No `stop` is sent: the bot said it
  is idle.
- **A column, not a timer in memory**: a new forward migration,
  [`20261027000000-jukebox-idle-report.ts`](../../../apps/api/src/database/migrations/20261027000000-jukebox-idle-report.ts),
  registered in `migrations/index.ts` (outside the brief's file list, which named
  only the service and tests). In memory, an API restart inside the grace would
  leave the Player "playing" a finished Track until someone pressed a control,
  because only the bot's own restart resets Players; and the test can backdate a
  column, the pattern the offline test already uses.
- **Lost voice takes two reports.** The report before is read from the stored
  `voice_channel_id`, which every report rewrites and a `join` sets. Caveat: a
  report about an older play with no voice channel also nulls it, so a following
  voiceless report for the current play counts as the second. Still strictly more
  lenient than before, when one report idled the Player.
- During the grace the page still shows the Track playing and its bar keeps
  moving from the last position: up to 5 s of drift past the end, left as is.

**Checked** in [`jukebox.test.ts`](../../../apps/api/test/jukebox.test.ts), the
new cases failing on the old service first (`actual: 'idle', expected: 'playing'`):
- an idle report for the current play leaves `t1` playing, then `advance(ended)`
  plays `t2` and the stamp is clear;
- an idle report, still playing inside the grace; with the stamp backdated past
  it, the listing shows the Player idle with no Track and the same `playId`, and a
  late `advance` plays nothing; a playing report after an idle one clears the
  stamp;
- one voiceless report leaves the Track playing, a voiced one resets the count, two
  in a row idle it (the old test sent one);
- the migration round trip downs the new migration first, then the Jukebox one.
- `npm run typecheck` is clean; the API suite passes (125 of 125). One full run
  under a load average near 20 failed the long-poll test's upper bound (`waited
  7738 ms`, bound 7000), a timing test this brief does not touch; two reruns
  passed.

Not checked live: just-a-bot's real timing between its idle report and its
advance, and a real Discord voice reconnect.
