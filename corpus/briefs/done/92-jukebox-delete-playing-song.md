# Task 92: Jukebox: deleting the playing song must not restart the library

## Context

`apps/api/src/database/migrations/20261008000000-jukebox.ts:41` makes `playlist_cursor_book_id` a
foreign key with `ON DELETE SET NULL`. `apps/api/src/modules/jukebox/jukebox.service.ts:164-170`
(`playlistAfterCursor`) reads a NULL cursor as "before the first track", and `:190` does the same
lookup. Delete song 40 of 300 while it plays (the Jukebox page's delete is the library delete, D56)
and the next song is the library's first; delete the last song at repeat off and everything starts
over. The Player also stays "playing" with no track. Reproduced on a built copy (play `zz`, the last
track; delete it; advance returns `t1`). `apps/api/test/jukebox.test.ts:419-431` only asserts that
some play is returned.

Improvement sweep of 2026-10-20 (Jukebox lens), vetted against the code; the ranked report is the owner's "Repo improvement sweep" doc.

## Files you OWN

- `apps/api/src/modules/jukebox/jukebox.service.ts`
- the library delete path, if the cursor is moved there
- `apps/api/test/jukebox.test.ts`

## What to do

1. Before deleting a book that is a Player's cursor or current track, move that cursor to the previous track in Playlist order; if it was playing, advance as if it had ended.
2. Make the existing test assert the expected next track.

## Acceptance

- Tests: delete the current song 40 and the next is 41; delete the last song at repeat off and the Player goes idle.

## Outcome (2026-10-27)

**Done**, code in `b85aff9`.

- [`jukebox.service.ts`](../../../apps/api/src/modules/jukebox/jukebox.service.ts)
  has `deleteTrack(bookId, deleteRow)`. In one transaction, for every Player whose
  cursor or current Track is the doomed one: the cursor moves to the Track before
  it in Playlist order (none before the first, so the next is the new first); a
  playing current Track advances as if it had ended, on a Playlist that already
  lacks the Track, so a Queue entry of it is skipped too; the bot gets `play`, or
  `stop` when nothing follows. A **paused** current Track stops (the brief only
  named playing; the bot protocol has no paused start, and a paused Player with no
  Track is the same broken state). A Player whose cursor moved but whose current
  Track is another gets an `upcoming`. The deleted Track is not pushed to the
  history: the cascade would remove the row, and pushing it could trim a real one
  off the 100. Then `deleteRow` runs inside the same transaction.
- **The delete path:** [`library.service.ts`](../../../apps/api/src/modules/library/library.service.ts)'s
  `deleteBookWithArtifacts` calls it for `kind === "audio"` and passes
  `deleteBook(id, trx)`; [`library.model.ts`](../../../apps/api/src/modules/library/library.model.ts)'s
  `deleteBook` takes an optional handle. One transaction rather than "release, then
  delete", so nothing (a Previous, a Play-this-song) can make the Track current
  again in between. A service calling another module's service is within
  api-layering.md's rules.
- The Jukebox migration's header still says there is "no Jukebox code on the
  library's delete path". Left alone, as a shipped migration;
  [jukebox.md](../../wiki/jukebox.md) has the rule now.

**Checked** in [`jukebox.test.ts`](../../../apps/api/test/jukebox.test.ts), each
case failing on the old code first (`actual: 'playing'` / `undefined` / `null` /
`'paused'`):
- the last Track (`zz`) playing at repeat off, also queued: delete it and the
  Player is idle with no Track, an empty Queue and the same `playId`, the cursor
  is `t3`, the last command is `stop`, and the bot's late advance starts nothing
  (it used to return `t1`);
- the middle of `t1, t2, t3, y1..y4`: delete the playing `y2` and `y3` plays under
  the next `playId`, the cursor is `y3`, the last command is `play` with `y3`, and
  an advance for `y2`'s play is stale;
- a Queue Track (`t1`) playing with the cursor on `y1`: delete `y1` and `t1` plays
  on, the cursor is `t3`, upcoming is `y3, y4`, and the advance plays `y3`;
- a paused `y4`: delete it and the Player is idle, the last command `stop`.
- `npm run typecheck` is clean and the API suite passes (123 of 123).

Not checked live: the bot switching streams on the `play` it gets mid-song.
