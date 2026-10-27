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

## Outcome (2026-10-27)

**Done**, code in `266b9b4`.

- [`advance`](../../../apps/api/src/modules/jukebox/jukebox.service.ts): an
  `error` for the current play adds one to `failed_advances`; the fifth in a row
  (`JUKEBOX_FAILURE_BUDGET`, in the shared contract) goes idle instead of taking
  the next Track, answers `{play: null}`, and stores `failure`:
  `5 songs in a row would not play, the last “<title>”.` An `ended` advance resets
  the count, and so does going idle for any reason (`goIdle` and brief 92's
  delete), so a person's Play after a stop starts a fresh run. `startTrack` clears
  `failure`, so the message stays while the Player is idle and goes with the next
  play. The bot sends no error text, so the message says what atrium knows.
- **Storage**: a second forward migration,
  [`20261027000001-jukebox-failures.ts`](../../../apps/api/src/database/migrations/20261027000001-jukebox-failures.ts)
  (`failed_advances` integer, default 0, and `failure` text), registered in
  `migrations/index.ts`, for the reason brief 94 gives: it survives a restart and
  the test can read it. Outside the brief's file list, like 94's.
- **The contract**: `Player` in
  [`packages/shared/src/jukebox.ts`](../../../packages/shared/src/jukebox.ts)
  gains `failure: string | null`, and the shared index exports
  `JUKEBOX_FAILURE_BUDGET`. The file's header asks for a note in all four
  briefs that restate the shapes; brief 81 is done and immutable, and the other
  three are just-a-bot's 25 to 27, which this run could not touch. A new field is
  harmless to a zod parser that strips unknown keys, which is zod's default; the
  bot was not read to confirm it parses `Player` that way. Recorded in
  [jukebox.md](../../wiki/jukebox.md).
- **The page**: [`NowPlaying.tsx`](../../../apps/web/src/jukebox/NowPlaying.tsx)
  shows "Playback failed: 5 songs in a row would not play, the last “…”. Check that
  the songs’ files are still there, then press Play." under the title, a
  `role="status"` line in `text-danger`, while `failure` is set.

**Checked:**
- [`jukebox.test.ts`](../../../apps/api/test/jukebox.test.ts): at repeat-all,
  five `advance(error)` in a row: the first four answer a play, the fifth none;
  the Player is idle, no Track, `failure` matches the sentence; a person's Play
  clears it and four more failures still play. Four errors, an `ended`, four more
  errors: still playing, no failure; the fifth in a row stops. The migration round
  trip downs this migration first.
- In a browser, on a scratch library (API on port 3998, Vite on 5174, a local
  account, a stand-in script in place of the bot that signs in to a `jukebox`
  account, long-polls and reports): joined Lounge, played "Harbour Lights", then
  five failed advances; the stand-in got plays for four songs and none for the
  fifth, and the page showed the line within a poll. Pressing Play cleared it.
  Light, Warm and Dark at 1280 px: legible in each. Design checklist: tokens only
  (`text-danger`), Archivo, no accent, no new radius or motion; 390 px was not
  captured (the line sits in the title column, which wraps).
- `npm run typecheck`, the web build and the API suite (127 of 127) are clean.

Not checked live: the real bot's behaviour on `{play: null}` after an error
(it is the same answer as the end of the Playlist).
