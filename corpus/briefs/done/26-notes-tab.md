# Brief 26 — Notes tab: paged notebook with ink + text boxes

Promoted from `todos/notes-tab.md`. A new Notes
subsystem: a peer area (nav tab) where you draw + write on paged notes,
Samsung-Notes-like, mobile + stylus friendly. Depends on brief 25's nav shell.

## Grilled decisions applied
- Content = **ink + movable typed text boxes** on a page (not full doc-flow).
- Engine = **vector ink from scratch** — Pointer Events + `perfect-freehand`.
- Storage = **per-user server-side** (SQLite; reuses the `authUser` guard).
- Structure = **paged notebook** (discrete pages), not infinite canvas.
- v1 tools = **pen + highlighter + eraser (per-stroke)**, small color palette,
  a few thickness steps; **blank pages** only; flat notes list; online-only.
  (Handwriting→text, folders, templates, export, offline = follow-ups.)

## What to do
1. **Contract** ([packages/shared](../../../packages/shared/src/)): new
   `notes.ts` with Zod schemas —
   `Stroke { tool: 'pen'|'highlighter', color, size, points: [x,y,pressure][] }`,
   `TextBox { id, x, y, w, text, size }`,
   `NotePage { strokes: Stroke[], texts: TextBox[] }`,
   `Note { id, title, pages: NotePage[], createdAt, updatedAt }`, plus a
   lightweight `NoteSummary { id, title, updatedAt, pageCount }` for the list.
   Export from `index.ts` (leaf-import pattern, D11).
2. **Backend** ([apps/api](../../../apps/api/src/)): `notes` table (per-user:
   `id, user_id, title, data TEXT (JSON pages), created_at, updated_at`) via the
   idempotent `CREATE TABLE IF NOT EXISTS` + `db.ts` helpers (mirror the
   `reading_progress` per-user pattern; FK to `users` ON DELETE CASCADE). New
   `notes-routes.ts` with `registerNotesRoutes(app)` (registered in
   [index.ts](../../../apps/api/src/index.ts) after the guard → auto per-user
   via `request.authUser`): `GET /notes` (summaries for the current user),
   `POST /notes` (create), `GET /notes/:id`, `PATCH /notes/:id` (title + pages),
   `DELETE /notes/:id`. Scope every query by `authUser.id`; 404 on another
   user's id.
3. **Frontend deps**: add `perfect-freehand` (pinned exact, D21) to
   `apps/web`.
4. **Frontend** ([apps/web/src](../../../apps/web/src/)):
   - Route `/notes` in the router; a **Notes** nav tab in `AppHeader`.
   - `notes/` module: `use-notes.ts` (React Query CRUD),
     `NotesList.tsx` (quiet cards: title + updated date + "New note" + delete),
     `NoteEditor.tsx` (the editor).
   - **Editor**: a page-sized `<canvas>` (or SVG) surface; Pointer-Events
     capture → `perfect-freehand` stroke geometry → render; a tool bar (pen /
     highlighter / eraser, color swatches, thickness), **undo/redo**, a
     text-box tool (tap to place, drag to move, edit inline), page nav + add
     page. Debounced autosave PATCH (like the progress flush). Honors the three
     themes + Atrium tokens.
   - **Mobile/stylus**: `touch-action: none` on the canvas; palm rejection
     (ignore `touch` pointers while a `pen` pointer is active); pressure from
     `event.pressure` (fallback simulated); `getCoalescedEvents()` for smooth
     fast strokes; responsive tool bar (bottom sheet on mobile ↔ side rail on
     desktop).

## Must NOT touch
- Auth (the app-wide guard already covers `/notes`), the library/readers/
  players, offline store (notes are online-only v1).

## Acceptance
- A **Notes** nav tab opens a per-user notes list; "New note" creates one;
  delete works; notes are isolated per user (another user can't fetch them).
- The editor draws smooth pressure-sensitive ink (pen + highlighter), erases
  strokes, places/moves/edits typed text boxes, adds/flips pages; autosaves and
  restores on reload.
- Works with mouse, touch, and stylus; drawing doesn't scroll the page; palm
  rejection holds; the tool bar is usable on mobile and desktop.
- Honors all three themes + design conformance; `npm run build` + typecheck
  clean.

---

> **Outcome (2026-07-20):** Shipped. Shared `notes.ts` contract; API `notes`
> table + `notes-routes.ts` (per-user via authUser guard) registered in index;
> `perfect-freehand@1.2.3` pinned; `/notes` route + nav tab; `NotesList` +
> `NoteEditor` (pen/highlighter/eraser/text tools, colors, thickness, paged,
> undo/redo, debounced autosave, mobile/stylus). **Live audit caught + fixed 3
> real bugs:** (1) tool bar/page-nav fell below the fold on desktop (`md:static`
> under an A4-tall sheet) → page-nav moved to header, tool bar always fixed;
> (2) strokes never committed — `getCoalescedEvents()` returns `[]` for some
> events, dropping all move points → empty-array fallback; (3) ink rendered as
> giant blobs — perfect-freehand degenerates on normalized 0..1 coords → compute
> geometry in a ×1000 viewBox space. Plus `setPointerCapture` hardened with
> try/catch. Verified live: draw/erase/text/pages/undo/persist/delete + per-user
> isolation, all breakpoints, dark theme. Typecheck + build clean. Uncommitted.
