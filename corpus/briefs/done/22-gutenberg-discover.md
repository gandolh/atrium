# Task 22 — Discover page: in-app downloads from Project Gutenberg

## Context

Foliate-style catalog integration: search/browse Project Gutenberg inside the
app and pull a book straight into the library. Source todo (with research +
sources): `todos/in-app-catalog-download.md`.

**Grilled decisions (2026-07-16, owner-confirmed):**
- v1 source: **Project Gutenberg only**, metadata via the **public Gutendex
  instance** (`gutendex.com` — community-run, no key, best-effort; our
  server-side cache softens it). Standard Ebooks / generic OPDS = follow-up.
- Discovery scope: **search + browse** — search box, popular
  (most-downloaded) landing list, topic/subject browsing, language filter.
- Entry point: **its own page** (`/discover` route), linked quietly from the
  library; room to grow into multiple catalogs later.
- Duplicates: **badge + reimport allowed** — imported books remember their
  Gutenberg id; results already in the library show an "In library" mark but
  can be downloaded again.
- Resolved without asking: all catalog traffic goes through `apps/api`
  (browser CORS + being polite to PG); downloads prefer the
  `application/epub+zip` (images) entry in Gutendex's `formats` map; imports
  run through the **existing** extract→cover→SQLite pipeline so a downloaded
  book is a perfectly normal library card; Gutendex failures surface as a
  plain error + retry (brief 10 pattern). Per PG's
  [robot-access policy](https://www.gutenberg.org/policy/robot_access.html):
  never crawl gutenberg.org — metadata from Gutendex only, one file download
  per explicit user action.

## Files you OWN

- `packages/shared/src/library-book.ts` — extend the wire contract
  (provenance fields) + new catalog schemas (search request/response, import
  request).
- `apps/api/src/catalog-routes.ts` (new) — Gutendex proxy + import route.
- `apps/api/src/db.ts` — `source` / `source_id` columns + idempotent
  migration.
- `apps/api/src/index.ts` — register the new routes.
- `apps/web/src/routes/**` + `router.tsx` — the `/discover` page + route.
- `apps/web/src/library/LibraryHeader.tsx` — the quiet "Browse catalogs"
  entry link.

## Files you must NOT touch

- Reader code, convert route, `auth.ts`/`password.ts` (the global `onRequest`
  guard covers new routes automatically — do not add bespoke auth).
- `extract.ts` — consume it as-is; imports must not fork the pipeline.
- **Coordination:** Brief 21 (unbuilt) also edits `library-book.ts` + `db.ts`
  (metadata columns). Whichever builds second rebases its schema migration on
  the other's; the columns are disjoint so there is no real conflict.

## What to do

1. **Contract** (`packages/shared`): add to `libraryBookSchema`:
   `source: z.enum(["upload", "gutenberg"])` (default `"upload"`) and
   `sourceId: z.string().nullable()`. New schemas: catalog search params
   (`q`, `topic`, `languages`, `page`, `sort`), a catalog book (id, title,
   authors, subjects, languages, coverUrl, downloadCount, epubAvailable), the
   search response (results + total + next page), and the import request
   (`gutenbergId`).
2. **DB** (`db.ts`): `source TEXT NOT NULL DEFAULT 'upload'`,
   `source_id TEXT` on `books`, guarded by the same `pragma table_info`
   idempotent-migration pattern as Brief 21. No backfill needed (existing rows
   are uploads).
3. **Catalog proxy** (`catalog-routes.ts`):
   - `GET /catalog/gutenberg` → proxies Gutendex `/books` (search, `topic`,
     `languages`, `page`, popular sort as the default when no query). Map the
     response to our catalog-book schema; `coverUrl` = the `image/jpeg`
     formats entry; `epubAvailable` from an `application/epub+zip` entry.
   - **Cache**: in-memory TTL map (~15 min, keyed on the normalized query
     string, capped size). A repeat query must not re-hit Gutendex inside the
     TTL.
   - Upstream failure → 502 with a clean error body; never a hang.
4. **Import** (`catalog-routes.ts`): `POST /library/import`
   `{ gutenbergId }` → resolve the book via Gutendex (cache ok), pick the
   EPUB format (prefer the images variant), stream-download server-side with
   a size cap (reuse the upload size limit from
   `packages/shared` file validation), then run the existing extract→store
   path and insert with `source: 'gutenberg'`, `source_id`. Return the new
   `LibraryBook`. Errors (no EPUB format, download failure, over-cap) → typed
   4xx/5xx.
5. **Discover page** (`apps/web`): `/discover` route built on the existing
   stack (owner-confirmed 2026-07-16): a `createRoute` in the code-based
   TanStack Router tree in `router.tsx` (no file-based plugin — brief 04) with
   a Zod-validated search schema (`q`, `topic`, `lang`, `page`) so searches
   are deep-linkable and refresh-safe; **TanStack Query** for catalog fetches
   (`queryKey` derived from those params — its client cache layers over the
   server TTL cache) and an import **mutation** that invalidates the library
   list query so the "In library" badge and the gallery update without a
   refetch dance. Quiet Paper throughout
   ([wiki/design.md](../../wiki/design.md), D27 — this is a utility surface:
   efficient and plain, polish budget stays on the reader):
   - Landing state: "Popular on Project Gutenberg" — cover grid (2:3 tiles,
     hotlinked PG cover URLs with the typographic fallback tile when absent).
   - Search box (title/author, debounced) + topic browse + language filter;
     paged results ("More" affordance, no infinite scroll).
   - Each result: cover, title, author, downloads count (quiet caps meta);
     an **"In library" badge** when its Gutenberg id matches a library book's
     `sourceId` (cross-referenced client-side from the already-fetched
     library list); an "Add to library" action → in-flight state → success
     (badge flips) or error + retry. Import stays possible when the badge
     shows (reimport allowed).
   - Back link to the library; `LibraryHeader` gains the quiet
     "Browse catalogs" link.
6. **Verify live** against the real Gutendex: search, topic browse, language
   filter, import one real book end-to-end (card appears with extracted
   cover/author, opens in the EPUB reader), repeat-search served from cache
   (assert via a server log line), badge behavior on reimport.

## Acceptance

- `/discover` (auth-gated like everything else) lands on the popular list;
  search, topic, and language filters all return mapped Gutendex results.
- Importing a book yields a normal library card (extracted cover + metadata,
  progress, offline toggle) with `source: 'gutenberg'` + `sourceId`; the book
  opens in the reader.
- A result whose Gutenberg id is already in the library shows the
  "In library" badge and can still be reimported (second card).
- Repeat catalog queries within the TTL are served from the server cache
  (no second upstream request); Gutendex/download failures render a plain
  error + retry, never a spinner that hangs.
- No requests to gutenberg.org except cover `<img>`s and the single EPUB
  download per user-initiated import (robot policy honored).
- Uploads are untouched (`source` defaults to `'upload'`); existing rows
  migrate cleanly.
- Typecheck + build + tests clean; design.md conformance checklist passes on
  the new page.

---

> **Outcome (2026-07-16):** Shipped as specced via plan-split-dispatch (opus
> backend, sonnet frontend). Live E2E against real Gutendex: popular/search
> proxied, TTL cache hit confirmed (167ms→8ms), book #55 imported end-to-end in
> 3.5s (cover + author + 14 subjects extracted), file/cover served, typed
> 400/404 error paths. Review fix-ups: mirror sub-path preserved in
> GUTENDEX_BASE_URL resolution, history-replace on debounced search. Note: the
> "More" affordance paginates (replaces the page) rather than accumulating —
> flagged as a judgment call. Uncommitted — owner controls git.
