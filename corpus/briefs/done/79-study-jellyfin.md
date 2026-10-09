# Task 79 — Study Jellyfin: how Atrium's media half differs, and what is worth taking

**Filed 2026-10-07** at the owner's request. This is a **gated research run**
([routing.md](../../routing.md)): it ends in a ranked list of options for the
owner to pick from. Nothing is built under this brief.

## Context

Jellyfin is the best-known self-hosted media server. Atrium's collected-media
half (books, music, video; D36) covers some of the same ground in a much smaller
shape. The owner wants two things: what Atrium could do better, and how the two
implementations differ.

Atrium has looked at Jellyfin once before, narrowly. On 2026-07-20 a design
pass borrowed Plex's and Jellyfin's per-kind card shapes and rejected a
Plex-style pivot ([log.md](../../log.md), entry "Rebrand todo filed"). That
settled the look, and D33 has since replaced it with Reading Room. This brief
is about **features and implementation**, not visual design.

### Atrium today (checked in code 2026-10-07)

The run re-checks each line against the code before relying on it.

| Area | What Atrium does | Where |
|---|---|---|
| Ingest | Browser upload, one file or a multi-file drop (brief 70), plus Gutenberg import (brief 22). No folder scan, no watcher. Five formats (pdf, epub, mp3, mp4, webm), detected by extension and MIME (D12, D13). | [file-validation.ts](../../../packages/shared/src/file-validation.ts) |
| Metadata | Read from the file only. EPUB OPF and PDF info for books. For mp3, ID3 through `music-metadata`, folded onto the book columns: artist → author, album → series, track → series index. mp4 and webm get a title from the filename. No online provider. | [extract.service.ts](../../../apps/api/src/modules/library/extract.service.ts) |
| Artwork | Book covers and embedded album art extracted server-side (D26). Video covers decoded in the browser (D40). Typographic tile when there is no cover (D42). | same, plus [video-cover.ts](../../../apps/web/src/lib/video-cover.ts) |
| Playback | Native `<audio>`/`<video>` on the original bytes over HTTP Range: direct play only. ffmpeg was declined in brief 23 and the refusal upheld by D40, so there is no transcoding and no server-side frame grab. One shell-owned `<audio>` and the player dock survive navigation (brief 31). No queue, playlist, subtitle track or playback-speed control found in the player. | [PlaybackHost.tsx](../../../apps/web/src/player/PlaybackHost.tsx), [media-url.ts](../../../apps/web/src/player/media-url.ts) |
| People | A Ward account is the household. Profiles inside it are an identity boundary, not a security one (D35, D53). Every profile sees the whole library. Progress and resume position are per profile (D31). | [profiles/](../../../apps/api/src/modules/profiles/) |
| Home and search | One home with kind filter chips, a Continue strip ordered by time remaining, and one search across the library (briefs 28–30). | [LibraryHome.tsx](../../../apps/web/src/library/LibraryHome.tsx) |
| Offline | Installable PWA. Explicit per-item downloads for **books only**: the offline toggle is not rendered for audio or video, by brief 23's decision. | [offline-store.ts](../../../apps/web/src/lib/offline-store.ts), [CoverCard.tsx](../../../apps/web/src/library/CoverCard.tsx) |
| Clients | The web app (PWA). Nothing else. | — |
| Ops | One container image, five storage roots (brief 55), SQLite through Knex (D47). | [infrastructure/](../../../infrastructure/) |
| Books | Its own PDF and EPUB reader: paged or scroll mode, in-book search, themes, the progress rail, resume per profile, offline downloads. No bookmarks or highlights (D18). | [reader.md](../../wiki/reader.md) |
| Atrium only | Convert (PDF ⇄ EPUB, D34), Notes, LaTeX. | — |

### Jellyfin (baseline from 2026-10-07 research)

These facts come from the docs, release notes and source, not from running it.
The run confirms them on a live instance, or keeps the URL.

- **Version.** The current stable release is **12.2** (2026-10-05). 12.0
  (2026-09-08) dropped the leading "10.", so 10.11 (2025-10-19) came right
  before it.
  [Releases](https://github.com/jellyfin/jellyfin/releases),
  [12.0 post](https://jellyfin.org/posts/jellyfin-release-12.0).
- **Stack.** The server is C# on .NET 10, using SQLite through EF Core. The web
  client is React 18, MUI and TanStack Query, partway through a migration from
  jQuery, and still ships a "Legacy" layout next to the default "Modern" one.
- **Ingest.** The server scans folders on disk, with an optional real-time
  monitor per library. It relies on naming conventions
  (`Movie (Year) [imdbid-…]`, `poster.jpg`) and Kodi-style NFO files, and local
  metadata always beats online metadata.
  **There is no media upload API:** the OpenAPI spec accepts only images,
  lyrics and subtitles.
  [Movies](https://jellyfin.org/docs/general/server/media/movies),
  [NFO](https://jellyfin.org/docs/general/server/metadata/nfo).
- **Metadata.** Built-in online providers: TMDb, OMDb, MusicBrainz, AudioDB and
  ListenBrainz. TheTVDB, Fanart, Open Library, Google Books and Comic Vine come
  as official plugins. Personal media with no online match falls back to the
  filename or an NFO file, and the "mixed" library type is "discouraged due to
  unreliable metadata".
  [Libraries](https://jellyfin.org/docs/general/server/libraries).
- **Playback.** Three delivery modes:
  - **Direct play:** the client plays the file as-is.
  - **Direct stream:** the server remuxes the file without re-encoding it.
  - **Transcode:** the server re-encodes with ffmpeg, optionally on a GPU.

  The server will not start without ffmpeg (since 10.10). On top of that:
  - embedded and external subtitles, including ASS and PGS in the browser;
  - per-user audio-language preference and playback speed;
  - chapters, and trickplay (scrub thumbnails made by a scheduled task);
  - media segments for skipping intros. The framework is native, but detecting
    the intros needs a plugin.

  [Codec support](https://jellyfin.org/docs/general/clients/codec-support),
  [media segments](https://jellyfin.org/docs/general/server/metadata/media-segments).
- **People.** Each person is a separate full account with a password. An admin
  can set, per user:
  - which libraries and devices they can use;
  - a maximum parental rating, plus allowed and blocked tags;
  - when they can log in;
  - whether they may download, delete or transcode.

  Quick Connect signs in a new device with a code. LDAP is an official plugin.
  **Jellyfin has no profiles inside a household account.** That has been
  requested, and a moderator answered that it will not come.
  [Users](https://jellyfin.org/docs/general/server/users/adding-managing-users),
  [request](https://forum.jellyfin.org/t-first-class-household-profiles-for-shared-devices).
- **Music.** Albums and artists come from the tags. Also: synced lyrics
  (`.lrc`), Instant Mix, playlists that can be shared, and loudness
  normalization (a LUFS scan task, and ReplayGain since 12.0). No gapless code
  was found in jellyfin-web; that is unverified. Finamp, the main third-party
  music client, advertises gapless playback.
  [Music](https://jellyfin.org/docs/general/server/media/music).
- **Books.** 12.0 made books a priority but calls the work "still maturing".
  - The server indexes epub, pdf, mobi/azw3, comic archives (cbz, cbr) and
    audiobooks.
  - The web reader opens only epub (epub.js), pdf (pdf.js) and comics.
  - The reader has no bookmarks or highlights.
  - Series are not first-class items yet.
  - The old Bookshelf plugin is archived.

  [Books](https://jellyfin.org/docs/general/server/media/books).
- **Home and browsing.** Fixed home sections: Continue Watching, Continue
  Listening, Continue Reading, Next Up and Latest. Favourites, collections and
  playlists, and per-user resume points and watched state. Since 12.0, plugins
  can supply search providers.
- **Clients.** Official apps for Android, iOS, Android TV, Roku, webOS, Tizen,
  Xbox, Kodi and the desktop. The web client contains a cast module for
  Chromecast. DLNA is a plugin. SyncPlay is part of the core server, with
  `/SyncPlay/*` endpoints and a web client module. Offline downloads depend on
  the client; the web client only offers a raw file download.
  [Clients](https://jellyfin.org/downloads/clients/).
- **Ops.** Docker image `jellyfin/jellyfin`, with `/config`, `/cache` and
  `/media` volumes on port 8096. The docs recommend 8 GB of RAM and a GPU for
  transcoding.
  - Backup and restore are built in since 10.11. Media files are not included,
    and a backup restores only onto the system that made it.
  - Scheduled tasks cover scanning, trickplay, chapter images, normalization
    and segments.
  - It has a REST API (OpenAPI, 294 paths) with TypeScript, Kotlin and Swift
    SDKs.

  [Container](https://jellyfin.org/docs/general/installation/container),
  [backup](https://jellyfin.org/docs/general/administration/backup-and-restore/).
- **Known weak spots** a small app could do better on:
  - no adding media from the browser;
  - no household profiles;
  - books behind video;
  - weak handling of media with no online match;
  - upgrade friction: one-way migrations, mandatory rescans, plugins removed
    before an upgrade;
  - a web client caught between two layouts;
  - intro detection, SSO, book metadata and DLNA all depend on plugins.

**Not verified by the research:**
- whether the web client lacks gapless playback;
- how SyncPlay works (its docs page returned 404);
- what the web client's Chromecast support can actually do;
- offline downloads in the iOS apps;
- what the backup covers beyond the database.

The run settles these on the live instance or leaves them marked.

## Scope

**In:**

1. **See Jellyfin running.** Run a local Docker instance pinned to
   `jellyfin/jellyfin:12.2`, or the newest 12.x patch on the day, with the tag
   written on the page. Walk the web client, then the parts only an admin sees:
   adding a library, scanning, users, and transcoding settings. Load the same
   sample files into both apps.
2. **Compare along these axes, and only these:** ingest · metadata · artwork ·
   playback (direct play, transcoding, subtitles, audio tracks, speed,
   chapters, scrub thumbnails) · music (albums, artists, playlists, queue,
   lyrics, gapless) · video (series and seasons, Next Up, intro skip) · books ·
   people (users, per-user access, parental controls) · resume, watched state
   and home sections · search · offline and clients · ops and API.
3. **Give each axis a verdict:**
   - **take**: worth building in Atrium more or less as Jellyfin has it;
   - **adapt**: the idea is worth having in a smaller or different form;
   - **skip, decision**: blocked by a named locked decision (say whether
     asking to revisit it is worthwhile);
   - **skip, scope**: not what Atrium is for;
   - **Atrium ahead**: Atrium already does this better. The owner asked about
     differences, not only gaps.
4. **Rank the take and adapt items** by value to a household of a few people
   against cost (S, M or L), each tagged with the decision it touches, or
   "none".
5. **End with questions for the owner.** At least these three, each with
   what Jellyfin shows the change would buy and the original reason it was
   declined:
   - Should ffmpeg come back for video (transcoding, server-side thumbnails,
     scrub previews)? Brief 23 and D40 declined it.
   - Should Atrium also ingest from a watched folder, next to upload?
   - Should metadata come from online sources (MusicBrainz, TMDB, Open
     Library) or stay file-only?

**Out:**

- Building anything. Options the owner picks become briefs 80 and up,
  written after they pick.
- Visual design. D33 is settled, and the 2026-07-20 pass already did the card
  shapes.
- Notes and LaTeX. Jellyfin has nothing comparable.
- Pointing Jellyfin at Atrium's real storage roots or database.

**Locked decisions the run treats as fixed:** D12 and D13 (formats,
detection), D33 (design), D35 and D53 (identity), D36 (premise), D40 and
brief 23 (no ffmpeg). A "take" that needs one of them to change is written up
as a revisit question for the owner, quoting the decision's own reason. It is
never assumed.

## How to run it

- **Docker:** run `jellyfin/jellyfin` at a pinned tag, with its config, cache
  and media directories in a fresh scratch directory outside the repo. Do not
  write the admin password into any repo file.
- **Samples:** `testing_files/` holds only two books. Fetch public-domain or
  CC-licensed media into its own empty directory: a Blender open movie (Big
  Buck Bunny or Sintel), a short tagged album with embedded art, one video
  with a subtitle track, one MKV and one CBZ comic. Atrium rejects MKV and CBZ,
  and that difference is worth showing.
- **Browser:** drive both apps with the agent-browser MCP tools. Screenshots
  go to `playwright/jellyfin/` (gitignored).
- **Source:** read `jellyfin/jellyfin` (server, C#) or `jellyfin/jellyfin-web`
  only where the docs leave a mechanism unclear, for example how resume
  points and watched state are stored.

## Files you OWN

- `corpus/wiki/jellyfin-comparison.md` (new). Carries `summary:` and
  `updated:` frontmatter, the Jellyfin version and date it describes, the
  per-axis table, the "Atrium ahead" list and the ranked shortlist. Stays under
  ~200 body lines.
- `corpus/wiki/open-questions.md`: the revisit questions until the owner
  answers them.
- `corpus/wiki/status.md` (this brief's row), `corpus/log.md` (one entry),
  `corpus/index.md` (through `bash corpus/lint.sh --index` only).
- Scratch outside git: `playwright/jellyfin/`, the container and its
  directories.

## Files you must NOT touch

- `apps/`, `packages/`, `infrastructure/`. This brief only studies.
- `corpus/wiki/decisions.md`. A revisit is the owner's call; record it after
  they answer.
- `corpus/wiki/glossary.md`. Jellyfin's terms ("direct play", "Next Up") are
  quoted as Jellyfin's, not adopted, unless a later brief adopts one.

## Acceptance

- `jellyfin-comparison.md` covers every axis in Scope item 2 and names the
  Jellyfin version it describes.
- Every Jellyfin claim was either seen on the running instance or carries a
  source URL. Every Atrium claim names the file it was checked in, and any
  line of "Atrium today" above that turned out wrong is corrected on the page.
- The shortlist has at most ten items, each with a verdict, a cost and the
  decision it touches.
- The run ends by putting the shortlist and the revisit questions to the
  owner. No brief 80+ is written before they pick.
- No app code changed. `bash corpus/lint.sh` passes.
- The Jellyfin container is stopped and removed at the end unless the owner
  asks to keep it.

## Outcome (2026-10-09)

Done. [jellyfin-comparison.md](../../wiki/jellyfin-comparison.md) covers every
axis against Jellyfin **12.2.0** (`jellyfin/jellyfin:12.2`), run locally with
the same samples in both apps, and the four revisit questions are in
[open-questions.md](../../wiki/open-questions.md). The shortlist and the
questions go to the owner; nothing is built.

- **Settled on the instance or in source:** the web client has no gapless or
  crossfade code (`jellyfin-web` at `v12.2`); SyncPlay and Cast buttons sit on
  every page; a backup holds metadata, trickplay, subtitles and the database,
  not media (`BackupOptionsDto`); an MKV with H.264 and AAC direct-played in
  Chrome, and a 420 kbps cap switched the session to a transcode.
- **Not verified:** what SyncPlay and Chromecast can do beyond their buttons,
  and offline downloads in the iOS app.
- **Corrections to the "Atrium today" table:** the Jukebox's Queue and Playlist
  (D56, D57), the Discord bot as a client, the Bot account (D55), and the
  50 MB upload ceiling, which refused the 64 MB *Big Buck Bunny* with 413.
- "No brief 80+ is written before they pick" could not hold literally: briefs
  80 to 82 came from the Jukebox grilling on 2026-10-08. A shortlist item the
  owner picks becomes 83 or later.
- Samples: Blender's *Big Buck Bunny* and *Sintel* trailer, four tracks of Nine
  Inch Nails' *Ghosts I–IV* (CC BY-NC-SA, Internet Archive; the archive's MP3s
  carried only a title, so artist, album, track and cover were written in),
  Gutenberg's *Frankenstein*, and a CBZ and SRTs made here. All in scratch,
  removed afterwards.
- The container was stopped and removed. No app code changed.
