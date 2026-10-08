# Task 81: The Jukebox API

**Filed 2026-10-08** from the Jukebox grilling with the owner. Decisions D55,
D56 and D57; vocabulary in [glossary-jukebox.md](../../wiki/glossary-jukebox.md).
Depends on brief 80. Brief 82 and just-a-bot briefs 25 to 27 build against the
contract below, so change it only with a note in all four.

## Context

The Jukebox lets the Discord bot (just-a-bot) play atrium's music, and gives
every signed-in person a Winamp-style page to steer it (brief 82). Three
decisions shape this API.

- **D57: atrium owns every Player.** The bot binds no port and accepts no
  incoming connections, so atrium keeps each Player in SQLite and the bot holds
  a long-poll open for commands. Discord's slash commands also go through this
  API, so a Player has exactly one writer and survives bot restarts.
- **D56: the Playlist is the music library.** Every library item of kind
  `audio`, in artist, album, track-number order. There is no playlist table.
  Each Player has its own Queue, which plays before the Playlist continues.
- **D55: the bot is its own Ward account** with the role `jukebox`. Brief 80
  sets `request.jukeboxOnly` in the guard and limits that account to `/jukebox/*`
  plus the audio file and cover routes.

Audio never travels on the long-poll. The bot fetches each Track from the
existing `GET /library/:id/file`, which already serves Range requests.

Facts this brief relies on, checked 2026-10-08:
- `books.id` is TEXT (`20260830000000-baseline.ts:130`). Artist is `author`,
  album is `series`, track number is `series_index`, duration is
  `duration_seconds`, and kind `audio` means MP3.
- Migrations are static imports in `apps/api/src/database/migrations/index.ts`
  (imports :2-4, `MIGRATIONS` :32-36); the newest is
  `20260925000000-prune-cutover-orphans.ts`. Foreign keys are on per
  connection (`database/knex.ts:60`), so `ON DELETE` clauses work.
- Modules follow `modules/<domain>/` with controller, service, model, mapper and
  types (`modules/library/` is the model). Routes register in `app.ts:83-87`.
- The guard answers errors as `{error: "CODE"}` (`ward.guard.ts:128-149`).
  `requireAtriumRole()` (:192) throws Fastify's default error shape instead, so
  don't use it for the checks here.
- The atrium API runs as **one** container process, so an in-process event
  emitter is enough to wake waiting long-polls.

## Scope

**In:** the migration, the `jukebox` module, the shared contract in
`packages/shared`, the next-Track rules, the long-poll, and tests.

**Out:**
- the page (brief 82) and the bot (just-a-bot 25 to 27);
- seek and volume (deferred by the owner);
- any change to library upload or delete;
- WebSocket or SSE. Polling and long-polling only (D57).

## Data model

One migration, `20261008000000-jukebox.ts`.

**`jukebox_players`**, one row per Discord guild:
- `guild_id` TEXT primary key, `guild_name` TEXT not null
- `voice_channel_id`, `voice_channel_name` TEXT null
- `voice_channels` TEXT not null default `'[]'`: JSON `[{id, name}]` the bot reported
- `state` TEXT not null, CHECK in `idle`, `playing`, `paused`, default `idle`
- `play_id` INTEGER not null default 0. It goes up by one every time the current
  Track starts, including a repeat of the same Track.
- `current_book_id` TEXT null, references `books(id)` ON DELETE SET NULL
- `position_ms` INTEGER not null default 0, `position_at` TEXT null: when the bot
  measured that position
- `playlist_cursor_book_id` TEXT null, references `books(id)` ON DELETE SET NULL.
  The last Track played *from the Playlist*. Queue entries never move it.
- `shuffle` INTEGER not null default 0
- `repeat` TEXT not null, CHECK in `off`, `one`, `all`, default `off`
- `last_seen_at` TEXT null, `updated_at` TEXT not null

**`jukebox_queue_entries`**:
- `id` INTEGER primary key autoincrement
- `guild_id` TEXT not null, references `jukebox_players` ON DELETE CASCADE
- `book_id` TEXT not null, references `books(id)` ON DELETE CASCADE
- `sort_key` INTEGER not null
- `added_by_kind` TEXT CHECK in `profile`, `discord`; `added_by_name` TEXT not null
- `added_at` TEXT not null

**`jukebox_history`**: `id`, `guild_id` (cascade), `book_id` (cascade),
`played_at`. Keep the newest 100 rows per Player.

**`jukebox_commands`**: `id` INTEGER primary key autoincrement, `guild_id`,
`body` TEXT (JSON), `created_at`. Delete rows older than 5 minutes whenever one
is inserted.

Shuffle needs its next picks stored so they stay stable between polls. Store
them however is simplest, for example a JSON column of pre-picked book ids on
the Player. The rule is in Acceptance.

## The contract

Put every schema below in `packages/shared/src/jukebox.ts` as zod, export it
from the barrel, and add `comparePlaylistOrder(a, b)` there: artist, then album,
then track number, then title, case-insensitive, with empty values last. The
API and brief 82 both sort with it.

Paths are as the API sees them. Caddy strips `/atrium-api`. Errors are
`{error: "CODE"}`. `guildId` must match `^\d{17,20}$`.

**Shapes**
- `Track`: `{id, title, artist, album, trackNumber, durationSeconds}`. The bot
  builds `/library/:id/file` and `/library/:id/cover` from `id`.
- `QueueEntry`: `{id, track, addedBy: {kind: "profile" | "discord", name}, addedAt}`
- `Player`: `{guildId, guildName, online, lastSeenAt, voiceChannel: {id, name} | null,
  voiceChannels, state, playId, track: Track | null, positionMs, positionAt,
  shuffle, repeat: "off" | "one" | "all", queue: QueueEntry[], upcoming: Track[]}`.
  `online` means `last_seen_at` is under 30 seconds old. `upcoming` is the next
  two Tracks: Queue first, then the Playlist.
- `BotCommand`, each with `{id, guildId}` plus one of:
  `{kind: "join", channelId}`, `{kind: "leave"}`,
  `{kind: "play", playId, track, upcoming}`, `{kind: "pause"}`,
  `{kind: "resume"}`, `{kind: "stop"}`, `{kind: "upcoming", upcoming}`.

**Routes for people and the bot**
- `GET /jukebox/players`: `Player[]`
- `GET /jukebox/players/:guildId`: `Player`, or 404 `PLAYER_NOT_FOUND`
- `GET /jukebox/tracks?q=`: `Track[]` in Playlist order. `q` matches title,
  artist or album as a case-insensitive substring.
- `POST /jukebox/players/:guildId/control`. The body is one of
  `{action: "play" | "pause" | "resume" | "next" | "previous" | "stop" | "leave"}`,
  `{action: "join", channelId}` or `{action: "playTrack", bookId}`. Returns the
  `Player`. Returns 409 `PLAYER_OFFLINE` when the bot is offline.
- `PATCH /jukebox/players/:guildId/settings` `{shuffle?, repeat?}`: `Player`
- `POST /jukebox/players/:guildId/queue` `{bookId, at: "end" | "next", addedBy?: {name}}`:
  `Player`. Returns 400 `NOT_A_TRACK` if the item is not `audio`. Queue edits
  work while the bot is offline.
- `DELETE /jukebox/players/:guildId/queue/:entryId`: `Player`, or 404 `ENTRY_NOT_FOUND`
- `POST /jukebox/players/:guildId/queue/:entryId/move` `{toIndex}`: `Player`
- `DELETE /jukebox/players/:guildId/queue`: clears it, returns `Player`

Attribution: a person's entries take `request.authProfile.name` with kind
`profile`, and any `addedBy` in the body is ignored. The bot account must send
`addedBy.name` (1 to 64 characters, the Discord display name), stored with kind
`discord`.

**Routes for the bot only.** A caller whose `request.jukeboxOnly` is false gets
403 `JUKEBOX_BOT_ONLY`, so nobody can fake the bot's status.
- `GET /jukebox/bot/commands?after=<id>&wait=<seconds>`: `{cursor, commands: BotCommand[]}`.
  `wait` is at most 20. Without `after`, it returns the current cursor and no
  commands at once, so stale commands are dropped when the bot starts. With
  `after`, it answers as soon as a command newer than `after` exists, or with an
  empty list once `wait` runs out. It stamps `last_seen_at` when it starts and
  when it answers. Remove the waiter when the client disconnects.
- `POST /jukebox/bot/status` `{guildId, guildName, voiceChannel, voiceChannels, playId, state, positionMs}`:
  `{upcoming: Track[]}`. This upsert is how Players come to exist. If `playId`
  is not the stored one, keep only the voice fields and the liveness stamp. If
  the bot reports no voice channel for a Player atrium thinks is playing or
  paused, set it `idle` with no current Track and keep the Queue. That is what a
  bot restart looks like.
- `POST /jukebox/bot/players/:guildId/advance` `{playId, reason: "ended" | "error"}`:
  `{play: {playId, track, upcoming} | null}`. If `playId` is stale, answer
  `{play: null, stale: true}` and change nothing. This is how a skip racing a
  natural end avoids advancing twice.

## Next-Track rules

All of these run in one transaction, and every change to the current Track
writes a `play` command, except `advance`, which returns the play directly.

- **Next** (the button, `/jukebox skip`, or an `error`): take the Queue head if
  there is one. Otherwise, take the Playlist Track after the cursor and move the
  cursor to it. At the end of the Playlist, `repeat: all` wraps to the first
  Track, and `off` stops: state `idle`, no current Track.
- **Ended** (the Track finished on its own): with `repeat: one`, replay the same
  Track under a new `play_id`. Otherwise, the same as Next. The Next button
  always advances, even with `repeat: one`.
- **Shuffle:** the Playlist part picks a random Track that is not among the
  last 50 played, or the last n-1 for a smaller library, and shuffle never ends
  on its own. The next two picks are decided ahead of time, so `upcoming` stays
  the same across polls until someone changes the Queue or the settings.
- **Previous:** play the newest history entry and remove it from history. If it
  was a Playlist Track and shuffle is off, move the cursor to it. With no
  history, restart the current Track.
- **Play:** if paused, resume. If idle, start with the Queue head, or the
  Playlist after the cursor, or the first Track.
- **Play Track** (a row in the Playlist): play it now and move the cursor to it.
- **Stop:** state `idle`, no current Track. The Queue and the voice channel stay.
- **Join, leave, pause, resume:** pass the command through and update the
  state. `leave` sets the state to `idle` with no voice channel.
- Starting a Track pushes the previous current Track onto history.
- Queue edits and settings changes write an `upcoming` command, so the bot can
  change what it buffers.
- Deleting a library Track removes its Queue entries and clears it as current,
  through the foreign keys. The bot finishes its buffered copy and then calls
  `advance`, which moves on normally.

## Files you OWN

- `apps/api/src/database/migrations/20261008000000-jukebox.ts` (new), and one
  import plus one `MIGRATIONS` entry in `migrations/index.ts`
- `apps/api/src/modules/jukebox/` (new): controller, service, model, mapper, types
- `apps/api/src/app.ts`: one `registerJukeboxRoutes(app)` line after :87
- `packages/shared/src/jukebox.ts` (new), and its export in `packages/shared/src/index.ts`
- `apps/api/test/jukebox.test.ts` (new)

Do not touch `ward.guard.ts`. Brief 80 owns it. Read `request.jukeboxOnly`
from there.

## Acceptance

Tests in `apps/api/test/jukebox.test.ts`, using `buildTestApp()` and
`FakeWard.signIn` with `{atrium: ["jukebox"]}` for the bot and the default grant
for a person:
- The migration runs up and down on a scratch database.
- A bot status call creates a Player, and `GET /jukebox/players` lists it with
  `online: true`. With `last_seen_at` set 31 seconds back, it shows `online: false`.
- A person adds a Track. The entry carries the active profile's name, and an
  `addedBy` in the body is ignored. The bot adds one with `addedBy.name`, and it
  is stored with kind `discord`.
- Adding a `book` item returns 400 `NOT_A_TRACK`.
- Long-poll: the bot waits with `after` and `wait=5`. A person posts `next`, and
  the poll answers within one second with a `play` command for the Queue head.
  With no command, it answers with an empty list after about five seconds.
- `advance` with a stale `playId` returns `stale: true` and changes nothing.
- Next order: the Queue first, then the Playlist after the cursor, and the
  cursor does not move while the Queue drains. `repeat: off` stops at the end,
  and `all` wraps. `repeat: one` plus `ended` replays the Track under a new
  `playId`, and Next with `repeat: one` advances.
- Previous plays the last history entry.
- With shuffle on, `upcoming` is the same across two GETs, and Next plays
  `upcoming[0]`.
- A person calling `/jukebox/bot/*` gets 403 `JUKEBOX_BOT_ONLY`.
- The bot account can call `GET /jukebox/tracks` and `GET /jukebox/players`.
  just-a-bot's `/jukebox play` autocomplete depends on it, so a later tightening
  of brief 80's allowlist must keep these working.
- A control action on an offline Player gets 409 `PLAYER_OFFLINE`, and a Queue
  edit on it succeeds.
- Deleting a library Track that is queued and current removes the entry and
  clears the current Track.

Live check, with the time measured using `time curl`:
- A `wait=20` long-poll with a jukebox session cookie holds for about 20
  seconds and returns 200 through the Vite dev proxy (`/atrium-api`, D54).
- The same through the built container, with `docker compose up`.
- A command posted during the wait returns in under one second.
- Record both timings in the outcome. If anything in between cuts the request
  off early, lower the maximum `wait` and say so in the outcome and in
  just-a-bot brief 26.

`npm test -w apps/api`, typecheck and build are clean.
