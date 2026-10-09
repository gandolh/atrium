---
summary: Jellyfin 12.2.0 next to Atrium's media half, axis by axis (ingest, metadata, artwork, playback, music, video, books, people, resume and home, search, offline and clients, ops), with a verdict per axis, what Atrium already does better, and a ranked shortlist of ten things worth taking or adapting. Seen on a running instance on 2026-10-09 (brief 79). Read before proposing media features.
updated: 2026-10-09
---

# Jellyfin compared with Atrium

Jellyfin **12.2.0** (Docker `jellyfin/jellyfin:12.2`), run locally on
2026-10-09 against Atrium at `eddc873`. Both apps got the same samples:
Blender's *Big Buck Bunny* (320×180 mp4, 64 MB) and the *Sintel* trailer
(remuxed to MKV with an SRT track, and to mp4 with a `mov_text` track), four
tracks of Nine Inch Nails' *Ghosts I–IV* (CC BY-NC-SA, Internet Archive) tagged
with artist, album, track and cover art, Gutenberg's *Frankenstein* (EPUB), a
PDF from `testing_files/`, and a four-page CBZ made from Bunny frames.
Screenshots are in `playwright/jellyfin/` (gitignored). A claim with no URL was
seen on the running instance or read from its API.

## Atrium today, corrected

Brief 79's table predates the Jukebox. Four lines changed:
- **Playback.** Still direct play only. The Jukebox adds a Queue and a Playlist
  for the Discord bot (D56, D57); the browser Dock still has neither
  ([playback-store.ts](../../apps/web/src/store/playback-store.ts)).
- **Clients.** The PWA, and since 2026-10-08 the Discord bot, which plays the
  music library through the Jukebox ([jukebox.md](jukebox.md)).
- **People.** Plus the Bot account, whose only role, `jukebox`, is an
  allowlist (D55).
- **Ingest.** Uploads stop at `MAX_UPLOAD_MB` (50 here;
  [config.ts](../../apps/api/src/common/config.ts)). The 64 MB *Big Buck Bunny*
  was refused with 413, so a feature film cannot be added at all.

## Axis by axis

| Axis | Jellyfin 12.2.0 | Atrium | Verdict |
|---|---|---|---|
| Ingest | Libraries are folders on disk; a scan or an optional real-time monitor finds files. The 294-path OpenAPI has **no media upload**. | Upload from any browser, many files per drop, plus Gutenberg import; 50 MB ceiling. MKV and CBZ refused with 400 ([file-validation.ts](../../packages/shared/src/file-validation.ts)). | **Atrium ahead** on adding from anywhere; the 50 MB ceiling needs a revisit for video (shortlist 3). |
| Metadata | Fetched online on the first scan: both films matched TMDb and IMDb with overviews; the album matched MusicBrainz, the artist MusicBrainz and AudioDB with a biography. The PDF got only its filename. | From the file only. The PDF got its real title and authors from its info dictionary; mp3 tags fold onto author, series and series index ([extract.service.ts](../../apps/api/src/modules/library/extract.service.ts)). | **Adapt**, as an on-demand lookup (shortlist 6); online by default is a question for the owner. |
| Artwork | Posters and backdrops fetched online; embedded album art used; the PDF shows a generic icon. | Covers extracted on the server (D26): the PDF's first page, the EPUB cover, embedded album art. Video covers decoded in the browser (D40). | **Atrium ahead** for files with no online match. |
| Playback | Direct play, remux, or transcode with ffmpeg (8.1.3-Jellyfin in the image). The MKV direct-played in Chrome; at 420 kbps the session switched to Transcode and ffmpeg logged the job. Player menu: aspect, speed, quality, repeat, subtitle offset. External and embedded subtitles, audio-track choice ([codec support](https://jellyfin.org/docs/general/clients/codec-support)). | Native `<audio>`/`<video>` on the original bytes over Range. No subtitle tracks (the mp4's `mov_text` track showed nothing), no speed control, no audio-track choice ([PlaybackHost.tsx](../../apps/web/src/player/PlaybackHost.tsx)). | **Take** speed (shortlist 1); **adapt** subtitles as WebVTT sidecars (shortlist 2); transcoding is **skip, decision** (brief 23, D40) unless revisited. |
| Music | Album and artist pages built from tags; Instant Mix (it returned the album's four tracks); playlists; lyrics (`.lrc`) and a lyrics task; loudness normalisation task. **No gapless**: no `gapless` or `crossfade` in jellyfin-web at tag `v12.2` (source). | Tracks are tiles; grouping by series shows an album; the Dock plays one track at a time. The Jukebox has a Queue and Playlist, for Discord only. | **Adapt**: an album page and a queue in the Dock (shortlist 4). Lyrics: **skip, scope** for now. |
| Video | Movies matched online; series and seasons, Next Up, intro skip through media segments (detection needs a plugin, [segments](https://jellyfin.org/docs/general/server/metadata/media-segments)); trickplay and chapter-image tasks. | Single files; no series model; 50 MB ceiling. | Series and Next Up: **skip, scope** (a household's own clips, not a TV library). Scrub previews: **skip, decision** (D40). |
| Books | EPUB, PDF and CBZ readers in the web client (`bookPlayer`, `pdfPlayer`, `comicsPlayer`); a plain page view; no bookmarks or highlights ([books](https://jellyfin.org/docs/general/server/media/books)). | Its own reader: paged or scroll, in-book search, themes, progress rail, resume per profile, offline download; Convert PDF ⇄ EPUB ([reader.md](reader.md)). No comics. | **Atrium ahead**. Comics: **skip, decision** (D12) unless asked. |
| People | Separate accounts with passwords; per user: libraries, devices, max parental rating, allowed and blocked tags, access schedules, download, delete and transcode rights. No household profiles ([request](https://forum.jellyfin.org/t-first-class-household-profiles-for-shared-devices)). | One Ward account per household with profiles inside (D35, D53); every profile sees everything. | **Atrium ahead** on profiles. Per-profile hiding by tag: **adapt**, but only as a convenience, since profiles are not a security boundary (shortlist 8). |
| Resume, watched, home | Per-user resume, Played and PlayCount (Sintel became Played after one run); fixed home rows: Continue Watching, Listening, Reading, Next Up, Latest. | Per-profile progress and resume (D31); one home with kind chips and Continue by time remaining (briefs 28–30). | **Adapt** a "mark finished" toggle (shortlist 5). |
| Search | Search page, and from 12.0 plugin search providers. | One search across title, author and series on the home (brief 30). | Even. |
| Offline and clients | Official apps for every platform; Chromecast module and SyncPlay in the web client (both buttons on every page); the web client offers a raw file download, not offline playback ([clients](https://jellyfin.org/downloads/clients/)). | Installable PWA with per-book offline downloads; no offline audio or video (brief 23); the Discord bot as a second client. | **Skip, scope** for native apps and SyncPlay; **adapt** offline audio (shortlist 7). |
| Ops and API | One container, `/config` `/cache` `/media`, 8 GB RAM and a GPU recommended for transcoding; 18 scheduled tasks; backup and restore of metadata, trickplay, subtitles and the database, not media (`BackupOptionsDto`); REST API with SDKs ([container](https://jellyfin.org/docs/general/installation/container)). | One container, five storage roots (brief 55), SQLite through Knex (D47), no background tasks. | **Adapt** a one-command backup (shortlist 9). |

## Where Atrium is ahead

- **Adding media from any browser.** Jellyfin cannot: its API accepts images,
  lyrics and subtitles only.
- **Household profiles** inside one account. Jellyfin declined them.
- **Books.** Real PDF covers and titles where Jellyfin showed an icon and a
  filename; a reader with search, scroll mode, themes and offline downloads;
  PDF ⇄ EPUB conversion.
- **Files with no online match.** Everything Atrium shows comes from the file,
  so a personal recording looks as finished as a film.
- **Light to run.** No transcoding hardware and no scheduled jobs.
- **Notes, LaTeX and the Discord Jukebox**, which Jellyfin has nothing like.

## Shortlist, ranked

Value to a household of a few people against cost (S, M, L). An item the owner
picks becomes a brief numbered 83 or later.

| # | Item | Verdict | Cost | Touches |
|---|---|---|---|---|
| 1 | Playback speed for audio and video (0.75–2×), remembered per profile | take | S | none |
| 2 | Subtitles: upload an `.srt` or `.vtt` beside a video, converted to WebVTT in JS, shown as a `<track>` | adapt | M | D12 (a sidecar format) |
| 3 | Larger video uploads: a higher ceiling with chunked, resumable upload | adapt | M | D15's 50 MB cap |
| 4 | Album page and a play queue in the Dock: play an album, play next, add to queue | adapt | M | D56 (keep it separate from the Jukebox Queue) |
| 5 | "Mark finished" and "mark unfinished" per profile | take | S | D31 |
| 6 | Look up metadata and cover art on demand (MusicBrainz and Cover Art Archive for music, Open Library for books), never automatically | adapt | M | none recorded; see the open question |
| 7 | Offline downloads for music | adapt | M | brief 23 (books only) |
| 8 | Hide items from a profile by tag, as a convenience for children | adapt | M | D35 |
| 9 | One-command backup of the database and covers, with a restore check | adapt | S | none |
| 10 | Lyrics from an `.lrc` sidecar in the audio player | adapt | S | D12 |

The three questions in [open-questions.md](open-questions.md) (ffmpeg, a
watched folder, online metadata) and the upload ceiling decide whether items 2,
3 and 6 grow or stay small.
