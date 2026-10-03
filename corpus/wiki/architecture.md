---
summary: How the app is put together — the npm-workspaces monorepo (web/api/shared), the API's module/controller/service/model layering, Knex migrations, the auth guard, and the upload→store→read data flow.
updated: 2026-10-03
---

# Architecture

## Monorepo (npm workspaces)

```
ebook-reader/
  package.json            root — workspaces + orchestration scripts
  apps/
    web/                  React + Vite frontend
    api/                  Node + Fastify backend
  packages/
    shared/               Zod schemas + inferred TS types
```

Root `workspaces` is `["packages/shared", "packages/typeset", "apps/*"]`, dependencies first on purpose: npm runs
`--workspaces` scripts in declaration order and the apps compile against the packages' built `dist/` (brief 59). `npm run dev`
builds both packages, then runs web + api + a `tsc --watch` on typeset. Plain npm, no Turborepo. TypeScript throughout.

## Dependency direction
```
apps/web  ─┐
           ├─►  packages/shared   (Zod contract + types)
apps/api  ─┘
```
`packages/shared` depends on nothing internal. Neither app depends on the other.

## Data flow

**Library (D24–D26) — the new front door:**
```
web: file upload ──POST /library──► api: validate (Zod) → store original on disk
                                          → extract cover (EPUB OPF / PDF pg1)
                                          → write thumbnail to images/thumbnails/
                                          → INSERT book row (SQLite)
     gallery of cover cards ◄─GET /library─◄ list rows (metadata only)
     cover img ◄──GET /library/:id/cover──◄ stream file from disk
     open to read ◄─GET /library/:id/file─◄ stream original from disk → reader
     progress saved ──PATCH /library/:id/progress──► UPSERT active PROFILE's reading_progress row (D31/D35)
     remove ──DELETE /library/:id──► delete row + file + thumbnail
```

Since 2026-07-16 (briefs 21–22): extraction also pulls `series`/`seriesIndex`/
`subjects` (EPUB OPF; best-effort PDF Info) with a one-time startup backfill
for older rows, and books carry `source`/`source_id` provenance
(`upload` | `gutenberg`). Two catalog routes sit beside the library:
`GET /catalog/gutenberg` (proxies the public Gutendex API with a 15-min
in-memory TTL cache; base URL env-overridable via `GUTENDEX_BASE_URL`) and
`POST /library/import` (downloads a Gutenberg EPUB server-side, size-capped,
then reuses the exact upload pipeline above). The library home groups by
author/series/subject behind a Shelves ⇄ Stacks view toggle; the drilled
group lives in the `?g` search param.

Since brief 23 the library is a **media library**: formats widened to
pdf/epub/**mp3/mp4/webm** with `kind` (`book|audio|video`) +
`duration_seconds` columns. mp3 metadata (`music-metadata`, pure JS) maps
artist→author, album→series, track→series_index, genre→subjects — so grouping
works on music unchanged — with embedded art as a square 400×400 cover.
`GET /library/:id/file` honors **HTTP Range** (206/`Content-Range`, 416,
`Accept-Ranges: bytes` always) for seek/scrub; `/read` branches on `kind` to
lazy `AudioPlayer`/`VideoPlayer` (native controls, a plain `src` the
`ward_session` cookie rides on, per-profile resume via the same
`reading_progress` PATCH). Offline downloads remain
books-only; no transcoding/ffmpeg.

**Identity is Ward's (D53)**: an `onRequest` guard in front of everything (`modules/ward/ward.guard.ts`). The D30 `users`/`sessions` tables, `/auth/*`, scrypt and `?token=` were removed at the cutover (`migrations/20260906000000-ward-cutover.ts`).
```
every request ──ward_session cookie (Path=/, shared origin)──► verify locally (EdDSA, Ward's JWKS)
     → ask Ward /introspect: live? grants? (cached 30 s per token)
     → 401 no/dead session      (client navigates to /ward/login?next=/atrium/)
     → 403 NO_ATRIUM_GRANT      (live session, no `atrium` grant; never redirects)
     → 503 IDENTITY_UNAVAILABLE (Ward unreachable or atrium's app key refused; fails closed)
     → else: first request ever for this subject provisions a Default profile,
       then request.ward + request.authProfile (selected per device via profile_selections)
     (allowlist: GET /health, OPTIONS)
```

**Reading (100% client-side once the file is fetched):**
```
open library book → GET /library/:id/file → PDF?  → react-pdf viewer
                                           → EPUB? → react-reader viewer
```

**Convert — an async job producing a linked library row (D34):**
```
reader ──POST /library/:id/convert──► api: 202, job starts (one at a time, 24h ceiling)
                                            spawn ebook-convert (+--enable-heuristics on PDF→EPUB)
                                            quality gate → ready | poor
       ◄── poll GET /library/:id ────       insert CONVERTED row (converted_from = source)
       reader switches format = open the other book id
```
Both directions. The converted book is read in-app, not downloaded — the
stateless `POST /convert` and its temp-file workspace are gone (D34 revises
D1/D15). See [conversion.md](conversion.md).

## Server-side storage (D25)
```
apps/api/
  data/library.db            SQLite (better-sqlite3) — books, profiles, profile_selections, reading_progress, notes, LaTeX projects
  library/<id>.<ext>         original uploaded PDF/EPUB files
  images/thumbnails/<id>.jpg extracted cover thumbnails
```
Every storage root is **gitignored** and independently redirectable by env.
There are **five** (D39, extended by brief 38):

| Env var | Holds |
|---|---|
| `LIBRARY_DATA_DIR` | the SQLite database |
| `LIBRARY_FILES_DIR` | uploaded book/music/video files |
| `THUMBNAILS_DIR` | cover thumbnails |
| `LATEX_PROJECTS_DIR` | LaTeX project working trees |
| `DOCUMENT_VERSIONS_DIR` | published version PDFs and project zips |

**Redirect all five together** to point a test at a scratch root. Redirecting
only some of them leaves the rest pointing at real data — redirecting the
database alone is how a verification run destroyed a book on 2026-08-25, and
the same trap now has five doors instead of three.

The DB stores **metadata only, never paths** (D39). A file's location is
*derived* — `paths.ts` is the single definition: an original is
`filePathFor(id, format)`, a cover is `coverPathFor(converted_from ?? id)`,
that last being D34's linked-row rule (a converted book shares its source's
thumbnail). Bytes live on disk; the disk is also the sole authority on whether
a cover exists, so `hasCover` is a `stat` rather than a column and cannot drift.

Tables (created by `src/database/migrations/`, queried by each module's model):
- `books`: `id, title, author, format, size_bytes, progress, created_at,
  last_opened_at, series, series_index, subjects, source, source_id, kind,
  duration_seconds, converted_from, convert_status, convert_error,
  convert_started_at` — shared library, install-wide (there is no `user_id`;
  only progress and notes are scoped). The `progress` column is legacy —
  per-profile progress lives in `reading_progress`. `file_path`/`cover_path`
  were dropped by D39.
- `latex_projects`: `id, profile_id → profiles ON DELETE CASCADE, title,
  entrypoint, compile_status, published_book_id → books ON DELETE **SET NULL**,
  created_at, updated_at` — per-profile LaTeX drafts (brief 38). The `SET NULL`
  is load-bearing: deleting the published entry must not delete the draft, or
  vice versa.
- `document_versions`: `id, book_id → books ON DELETE CASCADE, version_no,
  published_at`, unique on `(book_id, version_no)` — one publish each. **No path
  columns** (D39); both artifacts derive from the version id.
- `books` also carries the convert link (D34): `converted_from` (FK to
  `books.id`, `ON DELETE CASCADE`, unique — at most one conversion per source),
  plus `convert_status` / `convert_error` / `convert_started_at`. The three list
  statements filter `converted_from IS NULL`, which is what keeps one card per
  book — and what search, chips, grouping and counts all inherit, since they run
  client-side over that list.
- `profiles`: `id, subject, name, color, is_default, preferences, created_at`,
  unique on `(subject, name)`, where `subject` is the Ward account (no FK: Ward
  owns accounts) — the people inside one account (D35, re-keyed by D53). `preferences` is a JSON blob (theme,
  font settings, page mode, TOC sidebar), which is why D9 no longer holds for
  those four.
- `profile_selections`: `(subject, sid) PK → profile_id → profiles ON DELETE
  CASCADE, updated_at` — which profile a device last activated, keyed on the
  Ward token's `sid` so switching on one device does not switch the others
  (`profiles/profile-selection.model.ts`).
- `reading_progress`: `(profile_id, book_id) PK` → `progress, locator,
  updated_at`, both FKs `ON DELETE CASCADE` — progress + resume position, keyed
  on the **profile** since D35 (was `user_id`; the composite PK meant SQLite
  could not ALTER it, so brief 35 rebuilt the table).

## Backend layering (`apps/api/src`)

Six domain modules, each **controller** (HTTP) / **service** (rules) / **model**
(SQL), plus `database/`, `common/`, and `app.ts` split from `index.ts` (D47).
Full layout, per-layer rules and migrations: [api-layering.md](api-layering.md).

## Frontend stack (`apps/web`)
- **TanStack Router** — routes between views (home/upload ↔ reader).
- **TanStack Query** — library/notes/profile queries; the convert control polls
  `GET /library/:id` at a flat 30s while a conversion is running (D34).
- **Zustand** — in-memory reader state (current page, theme, font settings).
- **Zod** — client-side file validation (shared schemas).
- **Tailwind** + **Base UI** (`@base-ui/react`) — styling + unstyled accessible
  primitives (drawer, popover, slider, tabs) for the reader chrome.
- **react-pdf** (PDF.js) — PDF rendering.
- **react-reader** (epub.js) — EPUB rendering.

## Backend stack (`apps/api`)
- **Fastify** + `@fastify/multipart` (upload). No CORS since brief 65: nothing calls the API cross-origin.
- **Knex** over **`better-sqlite3`** (D24 as revised by D47) — same driver,
  still synchronous underneath, but every query is a promise. One connection in
  the pool, which is what keeps transactions exclusive and `foreign_keys` (a
  per-connection pragma) a property of the database.
- **Library routes** (D24): `POST /library`, `GET /library`, `GET /library/:id`,
  `GET /library/:id/file`, `GET /library/:id/cover`,
  `PATCH /library/:id/progress`, `DELETE /library/:id`, and the convert pair
  `POST /library/:id/convert` / `DELETE /library/:id/convert` (D34).
- **Ward guard** (D53, `modules/ward/`): see the diagram above; a stale selected profile falls back to the default, never a 401.
- **Cover extraction** (D26): EPUB OPF manifest cover; PDF page-1 render → JPEG.
- **Conversion** (D34): `POST`/`DELETE /library/:id/convert`, an async job
  shelling out to Calibre `ebook-convert`; the stateless `POST /convert` is gone.

## Client↔server wiring
One origin in development as in the deploy (D54): the web dev server proxies
`/atrium-api` (prefix stripped) and `/ward`, `/ward-api`. The API sends no CORS headers.

See [reader.md](reader.md) and [conversion.md](conversion.md) for the two
subsystems in detail.
