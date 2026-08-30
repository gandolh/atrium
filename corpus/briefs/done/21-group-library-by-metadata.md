# Task 21 — Group the library by metadata (author / series / subject)

## Context

The library gallery is flat: sort by `recent | title | author`, no grouping.
Books carry only `title` + `author`
([library-book.ts](../../../packages/shared/src/library-book.ts)), though the
files contain more — EPUB OPF has `dc:subject` (multi-valued) and series
metadata (`calibre:series`/`calibre:series_index`, or EPUB 3
`belongs-to-collection` + `group-position`); PDFs have a best-effort Info dict.

Source todo (with research + sources):
`todos/group-library-by-metadata.md`.

**Grilled decisions (2026-07-16, owner-confirmed):**
- Group keys: **author, series, and subject/genre** (plus "none" default).
- UX: **two user-switchable views behind a "View" toggle** (final,
  owner-approved 2026-07-16 across two design artifacts: "Brief 21 — Group
  display options" picked shelves from four mockups; "Brief 21 — Library view
  toggle" added the drill-in view + toggle integration):
  - **Shelves** (default): each group is one horizontal shelf — quiet caps
    label + count above a single row of covers standing on a hairline "plank";
    long groups scroll horizontally.
  - **Stacks** (drill-in): the gallery becomes an index of fanned cover
    stacks (first cover + offset paper edges, Playfair name + count); opening
    a stack shows only that group under a Playfair heading with a
    "← All books" way back.
  - The toggle is a two-segment Quiet Paper control in the library header,
    rendered **only while Group by ≠ None**. No header-click behavior on
    shelves.
- PDFs: **best-effort** — read the Info dict (`Author`, `Subject`, `Keywords`);
  missing values land in an "Unknown" group alongside sparse EPUBs.
- Multi-valued fields: **first value only** — every book appears exactly once.
- Resolved without asking: extraction extends the existing native OPF parse in
  [extract.ts](../../../apps/api/src/extract.ts) (no Calibre shell-out);
  existing rows get a one-time backfill re-scan; the Group-by choice persists
  to localStorage (same pattern as paged⇄scroll, D9-consistent); within a
  series group, books order by series index.

## Files you OWN

- `packages/shared/src/library-book.ts` — extend the D24 wire contract.
- `apps/api/src/extract.ts` — subject + series extraction (EPUB), Info-dict
  author/subject (PDF).
- `apps/api/src/db.ts` — schema columns + idempotent migration + backfill.
- `apps/api/src/library-routes.ts` — return the new fields.
- `apps/web/src/library/**` — Group-by control (`LibraryHeader.tsx`) + section
  headers in the gallery, and the route/component that renders the gallery.

## Files you must NOT touch

- Reader code (`apps/web/src/reader/**`), convert route, `auth.ts`,
  `password.ts` — unrelated.
- PWA service-worker/caching config (`vite.config` PWA block) — read-only;
  see step 6.

## What to do

1. **Contract** (`packages/shared`): add to `libraryBookSchema`:
   `series: z.string().nullable()`, `seriesIndex: z.number().nullable()`,
   `subjects: z.array(z.string())` (empty array when none). Add
   `LIBRARY_GROUPS = ["none", "author", "series", "subject"]` + schema/type,
   mirroring `LIBRARY_SORTS`.
2. **Extraction** (`extract.ts`, all best-effort, never throw):
   - EPUB: collect **all** `dc:subject` values (trimmed, deduped); series from
     `<meta name="calibre:series">` + `calibre:series_index` when present, else
     EPUB 3 `belongs-to-collection` (`collection-type: series`) +
     `group-position` refinement.
   - PDF: from the existing pdfjs document, read Info `Author` (fills the
     already-null author) and `Subject`/`Keywords` → subjects. No series.
3. **DB** (`db.ts`): add `series TEXT`, `series_index REAL`, `subjects TEXT`
   (JSON array) to `books` via an idempotent `ALTER TABLE` guard
   (`pragma table_info`). **Backfill**: after startup, for rows where
   `subjects IS NULL`, re-run extraction against `file_path` and update
   (async, off the request path; a book whose file is missing gets `[]`/nulls
   so the backfill doesn't rerun forever).
4. **API** (`library-routes.ts`): include the new fields in `GET /library`
   (and the single-book shape if one exists).
5. **UI** (`apps/web/src/library`): a "Group by" control next to "Sort by"
   (none / author / series / subject; default none = today's behavior).
   When grouping is active, a `GroupedGallery` owns the shared grouping logic
   and branches on the **View toggle**:
   - **Grouping logic (both views):** group key = **first** author/subject;
     missing value → "Unknown" group, rendered **last**; groups otherwise
     alphabetical; within a series group order by `seriesIndex` (nulls last),
     other groups follow the active sort.
   - **View toggle** (`LibraryHeader.tsx`): two-segment control
     ("Shelves | Stacks"), Inter `label-caps`, hairline border, 4px radius,
     active fill `surface-container-high`, **no accent color on the control**;
     rendered only while Group by ≠ None. A11y: `radiogroup` semantics, arrow
     keys, visible `primary` focus ring.
   - **`ShelfView`** (default): `label-caps` group name + count; hairline
     "plank" (`outline-variant`) under a single non-wrapping row; covers keep
     the bottom-heavy shadow so they stand on the plank; overflow scrolls
     horizontally with a quiet affordance (edge fade or `›`), native scroll +
     keyboard accessible.
   - **`StackIndex` / `GroupDetail`** (Stacks view): index of fanned stacks —
     the group's first cover with offset paper-edge layers behind
     (`surface-container-high` + hairline, 2px radius), Playfair group name +
     caps count beneath; stacks are real buttons. Opening one routes to the
     drilled page: "← All books" link, Playfair group heading + caps meta
     (count, in-progress), flat cover grid of that group only.
   - **Drill-in state is a URL search param** (`/library?g=<group-key>`), not
     component state — browser Back returns to the index, refresh restores the
     page, offline fallback can render it. Switching to Shelves or changing
     "Group by" clears `?g`.
   - **Persistence:** `localStorage["library:groupView"]` (default Shelves) +
     the Group-by choice, same pattern as paged⇄scroll (D9-consistent).
   - Must pass the Quiet Paper conformance checklist in
     [wiki/design.md](../../wiki/design.md) (D27) — typographic headers,
     hairlines, no card/chip chrome, accent spent only on active values /
     progress / links.
6. **Offline check**: the PWA offline fallback renders the library from the
   IndexedDB metadata store. Verify the cached shape carries the new fields
   (it likely stores `LibraryBook` verbatim — then nothing to do); if it
   projects fields explicitly, extend the projection. Do not touch SW caching
   strategy.

## Acceptance

- Upload an EPUB with series + subjects → `GET /library` returns
  `series`/`seriesIndex`/`subjects`; a metadata-less PDF returns nulls/`[]`.
- Restarting the API backfills pre-existing books (verify one gains subjects).
- Grouping by author/series/subject with **Shelves** renders one shelf per
  group (caps label + count, hairline plank, horizontal overflow scroll);
  every book appears exactly once; the "Unknown" shelf sits last; series
  shelves are ordered by series index.
- **Stacks** renders the fanned-stack index (same group order); opening a
  stack shows only that group with the Playfair heading + "← All books";
  browser Back returns to the index and a refresh restores the drilled page
  (`?g` param); switching views or changing Group-by clears the drill-in.
- The View toggle appears only while grouping is active, is keyboard-operable
  (radiogroup + arrow keys), and defaults to Shelves.
- Group-by and View selections survive a refresh; "none" is the default and
  matches today's gallery exactly.
- Offline fallback library still renders (grouped view degrades gracefully if
  cached rows predate the new fields).
- Typecheck + build + existing tests clean; design.md checklist pass on the
  changed library UI.

---

> **Outcome (2026-07-16):** Shipped as specced via plan-split-dispatch (2 opus
> chunks). Extraction/migration/backfill + both views + toggle landed; offline
> cache carries the new fields with no projection change. Review fix-ups:
> attribute-order-agnostic OPF meta parsing, numeric XML entities, shared
> CoverFallback in StackIndex, case-folded group bucketing. Verified: typecheck
> + build green; live API E2E confirmed subjects/series on the wire.
> Uncommitted — owner controls git.
