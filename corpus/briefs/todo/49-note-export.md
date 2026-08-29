# Task 49 — export a note to PDF and image

**Promoted 2026-08-29** from the `notes-tab` epic, where export was listed as a
v1 follow-up and left unspecified. Owner selected it on 2026-08-29 alongside
folders (brief 50) and a richer tool set (brief 51). Depends on nothing; the
three notes briefs are independent of each other.

## Context

Notes shipped in [brief 26](../done/26-notes-tab.md) and became a first-class
destination in [brief 33](../done/33-notes-destination.md). A note is an ordered
set of pages, each holding vector `strokes` and `texts` in **normalized**
coordinates (page width = 1, height = `PAGE_ASPECT` = 1.414) — see
[`packages/shared/src/notes.ts`](../../../packages/shared/src/notes.ts). Samsung
Notes, the feel this subsystem was built against, exports to PDF/Word/image;
export is the most self-contained of the follow-ups because it adds no new
state, no new schema, and no new interaction.

## Do it server-side, and the reason is not effort

The editor renders ink as SVG paths built by `perfect-freehand` in a scaled
×1000 viewBox ([`NoteEditor.tsx:60-108`](../../../apps/web/src/notes/NoteEditor.tsx))
— the storage stays normalized, and that scale exists because perfect-freehand's
smoothing degenerates on 0..1 coordinates. **That is a rasterisation-free vector
description of the page**, which is exactly what a PDF wants.

`apps/web` carries **no PDF-writing library** and adding one is a browser-payload
cost on a codebase that has spent three briefs trimming payload (17, 15, 16).
The server already has `pdf-lib@1.17.1` in the tree via
`@ebook-reader/typeset`, and brief 40 built an **SVG-path→PDF emitter** for
MathJax output — the same problem, already solved once here. Add `pdf-lib` as a
**direct, pinned** dependency of `apps/api` (D21); it is already in the lockfile,
so this is a declaration, not a download.

**PNG is the exception:** render it client-side by serialising the existing SVG
to a canvas. It needs no new dependency on either side, and the browser already
holds the exact geometry on screen.

## Scope

**In:** `GET /notes/:id/export.pdf` (all pages, vector) and a client-side
single-page **PNG** download. An export control in the editor.

**Out:** Word/DOCX (Samsung has it; nothing here can produce it without a large
dependency). Out: export from the notes *list* — export is an editor action on
the open note. Out: any change to the note schema, the autosave path, or the
Calibre convert path, which is unrelated.

## Files you OWN

- `apps/api/src/notes-routes.ts` — the export route
- a new `apps/api/src/note-pdf.ts` — page geometry → PDF
- `apps/api/package.json` — `pdf-lib` pinned to `1.17.1`, matching typeset
- `apps/web/src/notes/NoteEditor.tsx` — the export control
- `apps/web/src/notes/notes-api.ts` — the fetch
- tests beside the existing API tests

## Files you must NOT touch

- `packages/shared/src/notes.ts` — the contract is sufficient as it stands. If
  export seems to need a schema change, stop and say so.
- `packages/typeset/**` — do not route note export through the LaTeX engine.
  It sets documents from LaTeX; a note is not one. Borrow the emitter's
  *approach*, not its pipeline.

## What to do

1. **Page box.** One PDF page per note page, portrait, `PAGE_ASPECT` (1.414).
   Multiply every normalized coordinate by the chosen page width in points; A4
   at 595.28pt wide is the obvious choice and matches the sheet's intent.
2. **Ink.** Rebuild each stroke's outline the way the editor does — the same
   `perfect-freehand` options, including `thinning: 0` for the highlighter
   ([`NoteEditor.tsx:98-108`](../../../apps/web/src/notes/NoteEditor.tsx)) — and
   emit it as a **filled path**. It is an outline, not a stroked line; stroking
   it produces a hollow double-edged mess.
3. **Highlighter must stay translucent** and must be drawn **under** the pen
   strokes it overlaps, in the page's stroke order. Ordering is the whole
   readability of a highlighted page.
4. **Text boxes** at their normalized `x/y/w`, `size` scaled by page width.
5. **Page template** (`blank` / `ruled` / `grid`) drawn behind the ink, from the
   same geometry the editor rules with.
6. **The page sheet is fixed light in every theme** — a deliberate brief-26 call
   for ink legibility. The export is a sheet of paper: never emit the dark or
   sepia chrome tokens into the PDF, whatever theme the browser is in.
7. **Per-user, like every other note route** — the export must go through the
   same profile guard as `GET /notes/:id`. A note is per-profile
   ([`db.ts:385-392`](../../../apps/api/src/db.ts)); an export route that skips
   the guard is a read of someone else's notebook.

## Acceptance

- A multi-page note with pen, highlighter and text on a ruled page exports to a
  PDF whose pages match the editor **by eye**, opened in a real viewer.
- The PDF is **vector** — zoom to 800% and the ink stays clean. A rasterised
  export fails this brief.
- Highlighter is translucent and sits under the pen where they cross.
- A dark-theme browser session exports the same light sheet as a light one.
- `GET /notes/:id/export.pdf` for a note on **another profile** is refused, and
  a test demonstrates it.
- An empty note (zero strokes, zero texts) exports a valid blank-sheet PDF
  rather than throwing.
- PNG export of the current page downloads and matches the sheet.
- Typecheck + `apps/web` build clean.
