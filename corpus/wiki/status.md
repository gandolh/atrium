---
summary: Dated snapshot of current state — a one-liner per brief/area and where things stand right now. The living dashboard.
updated: 2026-10-09
---

# Status — 2026-10-08

**2026-10-09: atrium's half of the Jukebox is built** (briefs 80, 81, 82). The
bot's account is limited to the Jukebox (D55), atrium owns every Player and
its Queue (D57), the Playlist is the music library (D56), and `/jukebox` steers
it. How it fits together: [jukebox.md](jukebox.md). The bot side is just-a-bot
briefs 25 to 27. Owed by the owner: the production `discord-bot` account, and a
deploy. Terms are in [glossary-jukebox.md](glossary-jukebox.md).

**Latest (2026-10-03):** ✅ **The 2026-09-25 improvements sweep is worked
through: briefs 53–72 are done.** Every API fix landed with a regression test on
brief 63's harness (69 tests, from none). Owed, each named in its brief's outcome:
- ~~The vps-deploy change for brief 55~~ **made 2026-10-04** (vps-deploy
  `7dc0ccd`): the latex and versions folders are excluded from the rsync and
  passed to the container, and the dead `APP_PASSWORD` and `CONVERT_TIMEOUT_MS`
  are gone. Not deployed yet.
- **Brief 60's gate is answered (owner, 2026-10-04): prune, as D53 says.**
  What remains is mechanical: take a copy of the production database, then
  deploy.
- ~~Upstream `wzd_auth` change for brief 61~~ **made 2026-10-04** (wzd_auth `496b9e6`): the reference client now classifies a failed key-set fetch as Ward unavailable.

Brief 72 moved the Node line to 24 on the brief's recommendation; the owner
confirmed it on 2026-10-04 (D23). Filed during the run: briefs 73–77.

**2026-09-27:** development runs on one origin like the deploy (D54, revises
D14), and the storage roots and `.env` resolve from the API package again
(brief 53).

**2026-09-06:** **atrium moves to Ward (D53).** Its own auth is deleted (users,
sessions, scrypt, `/auth/*`, `?token=`). An app-wide guard verifies Ward's
`ward_session` cookie and requires an `atrium` grant (401 / 403 / 503), and
profiles are re-keyed onto the Ward subject. The same day the API became a
container image (`infrastructure/`), and a documentation site at `/atrium/docs`
started rendering the corpus.

**Older entries**, with what each run fixed and how it was verified, live in
[status-history.md](status-history.md) (2026-08-29 to 08-30),
[status-history-v2.md](status-history-v2.md) (08-26 to 08-27) and
[status-history-v1.md](status-history-v1.md) (the v1 era); entries move there as
this page passes the 200-line rule. The dashboard is what is true *now*; the archive is how it
got here.

## Briefs
| # | Brief | State |
|---|---|---|
| 01–07 | v1 build | **done** |
| — | Full browser verification + UI audit | **done (2026-07-02)** |
| 08 | Draggable progress rail (shared, both readers) | **done (2026-07-07)** |
| 09 | Platform password (`APP_PASSWORD`, D28) | **done (2026-07-07)** |
| 10 | Loading feedback (instant open + download progress) | **done (2026-07-07, uncommitted)** |
| 11 | Reading bottom bar: paged ⇄ scroll mode toggle | **done (2026-07-13)** |
| 12 | Bottom bar clustering (align PDF to EPUB) | **done (2026-07-13)** |
| 13 | Bug: page-jump input eats digits (12 → 2) | **done (2026-07-13)** |
| 14 | PDF/EPUB reading view visual parity | **done (2026-07-13)** |
| 15 | Perf: code-split / lazy-load the readers | **done (2026-07-13)** |
| 16 | Perf: reduce EPUB open cost (double-parse) | **done (2026-07-13)** |
| 17 | Perf: trim font payload | **done (2026-07-13)** |
| 18 | Stand up a live perf benchmark (CWV/trace) | **done (2026-07-13)** |
| 19 | PWA phase 1: installable app + cached shell | **done (2026-07-16, uncommitted)** |
| 20 | PWA phase 2: offline reading | **done (2026-07-16, uncommitted)** |
| 21 | Group library by metadata (author/series/subject) | **done (2026-07-16)** |
| 22 | Gutenberg discover page | **done (2026-07-16)** |
| 23 | Media library: music + video alongside books | **done (2026-07-16)** |
| 24 | Atrium rebrand: identity + design-system neutralize | **done (2026-07-20)** |
| 25 | Per-type IA (Books/Music/Videos) + per-media card shapes | **done (2026-07-20)** |
| 26 | Notes tab: paged ink + text boxes (perfect-freehand) | **done (2026-07-20)** |
| 27–33 | Reading Room rework (D33) — tokens, one home, tiles/tints, search, dock, reader, notes | **done (2026-08-24)** |
| 34 | Convert: the same book in either format (linked rows, D34) | **done (2026-08-25)** |
| 35 | Profiles: several readers behind one account (household model, D35) | **done (2026-08-25)** |
| 36 | LaTeX: write, compile, publish (Tectonic) | **superseded by 37–40 (2026-08-26)** |
| 37 | Engine: foundation — prose + structure → PDF, first test suite (D38) | **done (2026-08-26)** |
| 38 | LaTeX editor: projects, compile, publish, versions | **done (2026-08-27)** |
| 39 | Engine: figures, tables, bibliography | **done (2026-08-29)** |
| 40 | Engine: math (MathJax v4 SVG → PDF, gated subset — D41) | **done (2026-08-29)**, browser-verified |
| 41 | Storage: portable paths, redirectable dirs, offline rename (D39) | **done (2026-08-27)** |
| 42 | Video covers, decoded in the browser (D40) | **done (2026-08-28)** |
| 43 | Readable tiles for coverless media (D42) | **done (2026-08-29)**, browser-verified |
| 44 | Host the typesetting engine on a worker thread | **done (2026-08-28)** |
| 45 | `DELETE /profiles/:id` cancels the compiles it orphans | **done (2026-08-30)** |
| 46 | A swallowed compile-status write no longer wedges an account | **done (2026-08-30)** |
| 47 | Bibliography sizes its label column from `widestLabel` | **done (2026-08-30)** |
| 48 | Reap orphan thumbnails on API startup (D46) | **done (2026-08-30)** |
| 49 | Notes: export a note to PDF and image (D44) | **done (2026-08-30)** |
| 50 | Notes: folders | **done (2026-08-30)** |
| 51 | Notes: fountain-pen + pencil nibs (D45) | **done (2026-08-30)** |
| 52 | `apps/api` modules + Knex (D47) | **done (2026-08-30)** |
| 53 | Storage roots and `.env` resolve from the API package again | **done (2026-09-27)** |
| 54 | LaTeX compile slot keyed on the Ward subject (was a dropped column) | **done (2026-10-03)** |
| 55 | Container persists and names all five storage roots | **done (2026-10-03)**, Docker-checked (found and fixed missing typeset fonts in the image); vps-deploy follow-up made 2026-10-04 |
| 56 | Note autosave serialized, dirty until acknowledged, 16 MiB cap with `NOTE_TOO_LARGE` | **done (2026-10-03)** |
| 57 | Reading position flushed on leave, tab close and twin/version switch | **done (2026-10-03)**; twin switch-back resume is brief 75 |
| 58 | Aborted or failed uploads/imports leave no file; boot sweep reclaims `*.uploading` | **done (2026-10-03)** |
| 59 | Root scripts build workspaces in dependency order; dev watches typeset | **done (2026-10-03)** |
| 60 | Ward cutover orphans pruned by a forward migration | **done (2026-10-03)**; owner chose prune (2026-10-04); copy the production DB before the deploy that runs it |
| 61 | Ward key-set outage answers 503, never "signed out" | **done (2026-10-03)**; upstream `wzd_auth` change owed |
| 62 | Re-published file and replaced covers not served stale (mtime validators, `coverVersion`) | **done (2026-10-03)**; same-session reopen is brief 76 |
| 63 | `apps/api` test harness that cannot touch the real library | **done (2026-10-03)** |
| 64 | EPUB extraction refuses entries over declared-size ceilings; cover decodes pixel-limited | **done (2026-10-03)** |
| 65 | Local dev on one origin (D54, 2026-09-27); CORS removed (no origin granted) | **done (2026-10-03)**; Ward-down screen is brief 77 |
| 66 | Notes list counts pages in SQL, never loads ink; profile checks use a count via the notes service | **done (2026-10-03)** |
| 67 | Conversion terminal writes parked and replayed; a failed write no longer wedges the install-wide slot | **done (2026-10-03)** |
| 68 | Folder move and preference merge are each one transaction (no cycle, no lost key) | **done (2026-10-03)** |
| 69 | Dead seed/password files and `CONVERT_TIMEOUT_MS` retired | **done (2026-10-03)** |
| 70 | Multi-file drop/pick uploads every file sequentially; rejects named | **done (2026-10-03)** |
| 71 | Corpus and `CLAUDE.md` describe the Ward auth that exists | **done (2026-10-03)** |
| 72 | Dependency and Node versions back in line with D21 and D23 (Node 24) | **done (2026-10-03)**; Node line taken on the recommendation, owner may revisit |
| 73 | A 500 does not send the error's message (SQL) to the client | **done (2026-10-03)** |
| 74 | Picking the already-active profile is remembered | **done (2026-10-03)** |
| 75 | Switching back to a converted twin resumes from its own position (list row is a merged card) | **done (2026-10-03)** |
| 76 | A versioned document reopened in-session is hydrated again (not reused from memory) | **done (2026-10-03)**; the default-version half is brief 78 |
| 77 | Ward down: the gate says so and retries; downloaded books open when the library list fails or the tab is offline | **done (2026-10-03)**, checked against the local Ward container |
| 78 | Publishing releases positions on the version it supersedes (D38 decisions 9/10) | **done (2026-10-03)** |
| 79 | Study Jellyfin: differences and what to take (gated research, ends in options) | **todo (filed 2026-10-07)** |
| 80 | The bot account's `jukebox` role is an allowlist (D55) | **done (2026-10-08)**; local `discord-bot-dev` made; the production account is the owner's |
| 81 | The Jukebox API: Players, Queue, next-Track rules, bot long-poll (D56, D57) | **done (2026-10-08)**; long-poll timed live through Vite and the container |
| 82 | The Jukebox page, plus "Add to Discord queue" on music tiles | **done (2026-10-09)**; browser-checked with a stand-in bot; status rules fixed on the way |
