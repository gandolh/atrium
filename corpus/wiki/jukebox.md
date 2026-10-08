---
summary: How the Jukebox works end to end — the bot account's allowlist, atrium-owned Players in SQLite, the command long-poll, the next-Track and status rules (restart, lost voice, stale reports), and the /jukebox page. Read before touching modules/jukebox, apps/web/src/jukebox or just-a-bot's link.
updated: 2026-10-09
---

# Jukebox

just-a-bot plays atrium's music in Discord voice channels, and anyone signed in
steers it from `/jukebox` or from Discord's `/jukebox` command. Terms are in
[glossary-jukebox.md](glossary-jukebox.md). The calls are D55 (the bot's own
account and its allowlist), D56 (the Playlist is the library) and D57 (atrium
owns every Player, the bot long-polls). Built by briefs 80, 81 and 82.

## Who may call what

The bot signs in as its own Ward account whose only atrium role is `jukebox`.
The guard (`modules/ward/ward.guard.ts`) sets `request.jukeboxOnly` and limits
that account to `/jukebox/*` and `GET /library/:id/file` and `/cover`, matched
on the route pattern. The file and cover handlers refuse anything not `audio`.
`jukebox` beside any other role is full access. The `/jukebox/bot/*` routes
answer 403 `JUKEBOX_BOT_ONLY` to anyone else, so only the bot reports status.

## State lives in atrium

`modules/jukebox/` keeps one `jukebox_players` row per guild, plus its Queue,
its play history (newest 100) and the commands waiting for the bot. Every
change runs in one transaction on the single connection (D47), and a change
the bot must act on is written to `jukebox_commands`. The shared contract is
`packages/shared/src/jukebox.ts`, which also holds `comparePlaylistOrder`.

The bot holds `GET /jukebox/bot/commands?after=&wait=` open (at most 20 s,
measured live through Vite and the container on 2026-10-08). An in-process
emitter wakes it after the commit; it holds no database handle while it
waits. Audio never travels there: the bot fetches each Track from the library
file route.

## The rules that are easy to get wrong

- **`playId`** goes up every time a Track starts, a repeat included. `advance`
  with an old `playId` changes nothing, which is how a skip racing a natural
  end advances once. `advance` on a Player already idle (a Stop that crossed
  the Track's end) answers `{play: null}` and starts nothing.
- **A restart is the fresh cursor.** A poll without `after` (just-a-bot takes
  one at ready) sends every playing or paused Player to idle, keeping its
  Queue.
- **A status report** carries state and position only for the current
  `playId`, and only while atrium has not already stopped that play. Stop,
  Leave and the end of the Playlist set idle without a new `playId`, so a
  report the bot sent before it saw the `stop` must not start the play again.
  No voice channel on the current play means lost voice: idle.
- **A report for an older play** changes only voice and liveness. The bot may
  not have reached the `join` and `play` atrium just queued.
- **Idle never keeps a current Track.**
- **History** gets a Track whenever it stops being current, except through
  Previous (two presses would swap the same two) and a `repeat: one` replay.
- **Online** means the bot was seen in the last 30 s. Each poll stamps every
  Player, because one bot process serves every guild and reports idle guilds
  only on change. The cost: a guild the bot has left still shows online while
  the bot runs. Nothing removes a Player today.

## The page

`apps/web/src/jukebox/` polls `GET /jukebox/players` every 1.5 s while visible
and puts each write's returned `Player` straight into the cache. While playing,
the progress bar moves on from `positionMs` at `positionAt` between polls.
Offline, the transport and voice controls are disabled and Queue edits still
work. The Playlist is the library query filtered to `audio` and sorted with
`comparePlaylistOrder`; upload there is `UploadZone` with `audioOnly`, and
delete is the library delete behind a two-step confirm. Music tiles on the home
grid get "Add to Discord queue". The Dock stays local playback.
