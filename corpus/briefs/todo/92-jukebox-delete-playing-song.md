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
