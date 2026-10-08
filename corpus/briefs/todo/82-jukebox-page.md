# Task 82: The Jukebox page

**Filed 2026-10-08** from the Jukebox grilling with the owner. Decisions D56
and D57; vocabulary in [glossary-jukebox.md](../../wiki/glossary-jukebox.md).
Needs brief 81's API and shared contract (`packages/shared/src/jukebox.ts`).

## Context

The owner wants a page where anyone signed in, on any profile, can steer the
Discord bot "like VLC or Winamp". It should show what's playing, let people
add to the queue, skip, and so on. They also want to upload and delete songs
there, and "the playlist is the list of songs available to the discord bot".

What was settled:
- **The Playlist is the music library (D56).** Upload on this page is the
  normal library upload, MP3 only. Delete is the normal library delete, so the
  Track is gone for everyone. This page asks for confirmation first.
- **Each Player has a Queue** that plays before the Playlist continues. "Play
  next", "Add to queue" and the new "Add to Discord queue" on music tiles put
  Tracks there. Reorder, remove and clear work on the Queue only.
- **Controls for v1:** now playing with a progress bar, play/pause, next,
  previous, stop, shuffle, repeat (off/one/all), join and leave a voice channel.
  Seek and volume come later.
- **A Player per guild.** The page lists Players, though there is one today.
- **The Dock stays local.** It plays in this browser, and it does not show or
  control Discord playback. The glossary now says so.
- **Atrium owns the state and the page polls (D57),** every 1 to 2 seconds,
  like the LaTeX compile status (`apps/web/src/latex/use-latex.ts:80`).

Where things are, checked 2026-10-08:
- Routes: `apps/web/src/router.tsx`. Pattern at `notesRoute` :69-74, tree at
  :141-151. `/music` is only a redirect to `/?kind=audio` (:47-62).
- Header links: `apps/web/src/components/AppHeader.tsx`. `<NotesLink/>` and
  `<LatexLink/>` are placed at :67-68 and defined at :86 and :103.
- Music tiles: `apps/web/src/library/CoverCard.tsx`, kebab menu :180-212, with a
  single "Remove" item. `LibraryHome.tsx:195` deletes **with no confirmation**,
  and there is no shared confirm component. The inline two-step confirm in
  `apps/web/src/latex/LatexFileTree.tsx` (doc :16-18) is the pattern to copy.
- Upload: `apps/web/src/library/UploadZone.tsx` (`ACCEPT` :56-67, applied :183,
  filter :113-124) and `useUploadQueue` (`apps/web/src/lib/use-library.ts:129`).
  Delete is `useDeleteBook` (:211).
- API helper: `apiFetch` in `apps/web/src/lib/api-client.ts:99`.
- Design: [design.md](../../wiki/design.md) ("Reading Room", D33). Its
  conformance checklist is at :185.

## Scope

**In:**
1. **Route and link.** A `/jukebox` route and a `JukeboxLink` in the header next
   to Notes and LaTeX.
2. **Data.** `apps/web/src/jukebox/use-jukebox.ts`: a players query polling
   every 1.5 seconds while the page is mounted and visible, plus a mutation per
   brief 81 route that updates the cache from the returned `Player`. The
   Playlist comes from the existing library query, filtered to `audio` and
   sorted with the shared `comparePlaylistOrder`.
3. **The page**, `apps/web/src/jukebox/`:
   - **Player picker** when there is more than one Player. If there are none,
     an empty state explains that the bot has not checked in yet.
   - **Offline**, when `online` is false: a notice, transport and voice
     controls disabled, Queue edits still allowed.
   - **Now playing:** cover, title, artist, album, and a progress bar with
     elapsed and total time. While playing, the bar moves on from `positionMs`
     and `positionAt` between polls.
   - **Transport:** previous, play/pause, stop, next, a shuffle toggle, and a
     repeat control cycling off, one and all.
   - **Voice:** the current channel, a select of `voiceChannels` with Join, and
     Leave.
   - **Queue:** each entry with who added it, remove, move up and down, and
     clear with a two-step confirm.
   - **Playlist:** every Track in Playlist order, with a text filter and the
     current Track marked. Row actions: play now (`playTrack`), play next, add
     to queue, and delete. Delete is a two-step inline confirm whose copy says
     it removes the song from atrium for everyone.
   - **Upload:** an upload area that takes MP3 only. If `UploadZone` can't
     narrow its accepted types, give it an optional prop that does, and keep
     its default unchanged.
4. **"Add to Discord queue"** in `CoverCard`'s kebab menu, for `audio` items
   only. With one Player it adds there. With several, it offers each Player by
   guild name. With none, the item is hidden. Confirm success inline, naming the
   guild.
5. UI copy may say "song". Code and docs say Track (glossary).

**Out:**
- seek and volume;
- any change to the Dock or the playback store;
- drag-and-drop reordering, unless it is cheap. Up and down buttons are enough;
- a confirmation for the home grid's own Remove. That's a separate gap this
  brief only notes.

## Files you OWN

- `apps/web/src/jukebox/` (new)
- `apps/web/src/router.tsx`: the route and its place in the tree
- `apps/web/src/components/AppHeader.tsx`: the link
- `apps/web/src/library/CoverCard.tsx`: the menu item only
- `apps/web/src/library/LibraryHome.tsx`: only the wiring that passes Players
  to `CoverCard`, if it needs any
- `apps/web/src/library/UploadZone.tsx`: the optional accept prop only, if needed

## Acceptance

- The design.md conformance checklist passes in all three themes, including
  artwork, and with `prefers-reduced-motion`.
- The page works at 360 px wide with no horizontal scroll.
- To test before the real bot exists, act as the bot with `curl` against brief
  81's bot routes, using a session for the local `discord-bot-dev` account
  (brief 80's owner steps). With that "bot" online:
  - play, pause, next, previous, stop, shuffle, repeat, join and leave each
    show on the page within 2 seconds;
  - the progress bar moves while playing and holds while paused.
- Stop the fake bot's status calls, and within about 30 seconds the page shows
  the Player offline, with transport disabled and Queue edits still working.
- Uploading an MP3 on the page adds it to the Playlist and to the home grid. A
  PDF is refused.
- Deleting from the Playlist takes two clicks, and the Track is then gone from
  the Playlist and the home grid.
- "Add to Discord queue" on a music tile on the home grid puts the Track in the
  Queue under the active profile's name. The item does not appear on book or
  video tiles.
- The Dock still plays locally and is unaffected by the Jukebox.
- Browser-verified with agent-browser. Screenshots stay out of git.
- Typecheck, build and tests are clean.
