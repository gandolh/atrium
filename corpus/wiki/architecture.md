---
summary: How the app is put together — the npm-workspaces monorepo (web/api/shared), layer boundaries, the auth guard, and the upload→store→read data flow.
updated: 2026-08-25
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

Root `package.json` declares `workspaces: ["apps/*", "packages/*"]`. Scripts run
each workspace (e.g. `npm run dev` runs web + api concurrently). Plain npm — no
pnpm, no Turborepo. TypeScript throughout.

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
lazy `AudioPlayer`/`VideoPlayer` (native controls, `?token=` src, per-user
resume via the same `reading_progress` PATCH, per profile since D35). Offline downloads remain
books-only; no transcoding/ffmpeg.

**Auth (D30) — an `onRequest` guard in front of everything:**
```
web login ──POST /auth/login (username+password)──► verify scrypt hash → mint session token
     every request ──Bearer <token> / ?token=<token>──► guard resolves session → request.authUser
     (allowlist: POST /auth/login, GET /auth/status, GET /health, OPTIONS)  else → 401
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
  data/library.db            SQLite (better-sqlite3) — books, users, profiles, sessions, reading_progress
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

Tables (`db.ts`):
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
- `users`: `id, username (unique), password_hash (scrypt), created_at` —
  operator-seeded accounts (D30).
- `sessions`: `token PK, user_id → users ON DELETE CASCADE, created_at` — opaque
  login sessions (D30).
- `books` also carries the convert link (D34): `converted_from` (FK to
  `books.id`, `ON DELETE CASCADE`, unique — at most one conversion per source),
  plus `convert_status` / `convert_error` / `convert_started_at`. The three list
  statements filter `converted_from IS NULL`, which is what keeps one card per
  book — and what search, chips, grouping and counts all inherit, since they run
  client-side over that list.
- `profiles`: `(user_id, name)` unique → `name, color, is_default, preferences`
  — the people inside one account (D35). `preferences` is a JSON blob (theme,
  font settings, page mode, TOC sidebar), which is why D9 no longer holds for
  those four.
- `reading_progress`: `(profile_id, book_id) PK` → `progress, locator,
  updated_at`, both FKs `ON DELETE CASCADE` — progress + resume position, keyed
  on the **profile** since D35 (was `user_id`; the composite PK meant SQLite
  could not ALTER it, so brief 35 rebuilt the table).

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
- **Fastify** + `@fastify/multipart` (upload) + `@fastify/cors`.
- **`better-sqlite3`** (D24) — synchronous single-file DB for the library.
- **Library routes** (D24): `POST /library`, `GET /library`, `GET /library/:id`,
  `GET /library/:id/file`, `GET /library/:id/cover`,
  `PATCH /library/:id/progress`, `DELETE /library/:id`, and the convert pair
  `POST /library/:id/convert` / `DELETE /library/:id/convert` (D34).
- **Auth** (D30, `auth.ts` + `password.ts`): app-wide `onRequest` guard +
  `POST /auth/login` / `GET /auth/status` / `POST /auth/logout`; scrypt password
  hashing; opaque sessions. Accounts seeded by `scripts/seed.ts` (no
  self-registration). Reading progress (D31) via `reading_progress`, keyed on
  the active **profile** since D35 — the guard resolves
  `request.authProfile` alongside `request.authUser`, and a session whose
  profile is missing or dangling falls back to the account default rather than
  401-ing. Notes are profile-scoped too.
- **Cover extraction** (D26): EPUB OPF manifest cover; PDF page-1 render → JPEG.
- `POST /convert` — unchanged, still stateless; shells out to Calibre
  `ebook-convert` via child process.

## Client↔server wiring
Web calls `VITE_API_URL` (`http://localhost:3001`) directly; Fastify enables
CORS. No Vite proxy.

See [reader.md](reader.md) and [conversion.md](conversion.md) for the two
subsystems in detail.
