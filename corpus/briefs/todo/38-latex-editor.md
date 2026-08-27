# Task 38 — LaTeX: write, compile, publish

**Second of four.** [37](../done/37-engine-foundation.md) (foundation) → **38** (editor)
→ [39](39-engine-figures-tables-bib.md) → [40](40-engine-math.md).

**Replaces superseded brief 36**, which specified Tectonic. Everything here about
projects, drafts, publishing and versions is unchanged from that brief's
owner-confirmed grill (2026-08-24, three rounds); only the engine changed. **This
brief requires brief 37 to be done** — it calls `packages/typeset`, it does not
build it.

## Context

Owner request: *"add latex support. I would like an editor like overleaf."* On
why it belongs in Atrium: *"it is in Atrium for the same thing as notes. Maybe
you are on the road and want to sync what's on your phone with what's on pc and
vice-versa. It's like a personal cloud space."*

That widened the product premise (**D36**): Atrium is **your stuff, reachable
from anywhere** — media you collect plus documents you author. Rewrite
PRODUCT.md's one-liner here rather than letting the premise drift a third time.

### What Atrium already gives this for free

1. **The preview pane exists.** `PdfReader` takes a **`File`**, not a URL
   ([PdfReader.tsx](../../../apps/web/src/reader/pdf/PdfReader.tsx)), so a
   compiled PDF is handed over as `new File([blob], "out.pdf")`. Paged
   rendering, zoom, page nav, search, theming — already built, unchanged.
2. **The compile job is brief 34's job runner** — a status column, single-flight
   guard, boot reaping, a polling status button, cancellation. Same machine, a
   far shorter ceiling, and now an in-process call instead of a child process.
3. **Authored content has a home pattern.** Notes (brief 26) established
   per-profile, server-stored content living **outside** the media grid, which
   D33 locked deliberately.

What does *not* fit is the notes *storage* shape — `notes` is one JSON blob per
note. A LaTeX project is multi-file including binaries, so it needs files on disk
plus a row: the split D25 already chose for the library.

### Draft and Published are different things in different places

- A **draft** is the live project you edit. It lives **only** in `/latex` and is
  **never** shown in the gallery.
- **Publishing** puts a compiled PDF in the library as **one entry**, which
  accumulates **versions**. Each publish adds a version; it never adds a card.
- Each version stores **the compiled PDF and a zip of the whole project** —
  *"so it's easy to resume"*. A version that can't be rebuilt isn't a version,
  and figures are what make rebuilding real.
- Deleting the **draft** does not touch published entries. Publishing is the act
  of making something independent.

### What changed from brief 36: the engine, and the sandbox

Brief 36 spawned Tectonic and spent a whole section on sandboxing, because
running code is what TeX *is*. **Our engine is a pure function with no I/O**
(D38), so most of that section is gone rather than implemented: no shell escape
exists to disable, and `\input` resolves against an in-memory file map, not a
filesystem.

**What survives, and is still on you:**

- **Upload path validation.** The engine never sees a path it can abuse, but
  *this* brief accepts uploads and writes them to disk. Every path-accepting
  route must validate each project-relative path as relative, normalize it, and
  confirm it resolves **inside** the project directory — no absolutes, no `..`,
  no symlinks out. Applies to create, rename, upload, delete, and the entrypoint
  field. **One unchecked join here is an arbitrary file write.**
- **A wall-clock ceiling on the route**, as the outer backstop behind the
  engine's own deterministic step budget.
- **A project size cap** (`LATEX_MAX_PROJECT_MB`) on uploads.

**What is gone:** `tectonic.ts`, the binary startup check, the Tectonic cache
dir, shell-escape disabling, and `LATEX_TIMEOUT_MS` as an engine concern (it
stays as the route's backstop).

### Grilled decisions (2026-08-24, owner-confirmed; carried from brief 36)

1. **In Atrium, as a third destination** (`/latex`), sibling to Notes, outside
   the media grid.
2. **Per-profile**, like Notes — so this follows **brief 35**.
3. **v1 is exactly three things**: multi-file projects, compile + PDF preview,
   and an error log with file and line. Explicitly **out**: autocomplete,
   SyncTeX, version history *of the draft*, collaboration, rich-text mode,
   bibliography tooling, a template gallery.
4. **A new project starts from a small hello-world.** No zip import — the owner
   has nothing to bring in. *(This is also what makes D38's subset scope
   defensible; see brief 37.)*
5. **Light edits on the phone**, not full authoring. Drives **CodeMirror 6**
   over Monaco (~10× the entry chunk for one destination, and not
   touch-credible).
6. **Online-only**, matching Notes and D32.
7. **Single-writer**, last-write-wins per file. No CRDTs, no live cursors.
8. **Publish → one library entry with versions.**
9. **Opening a published card shows the latest version**, or the version you were
   last reading if you had explicitly opened an older one.
10. **A new version starts at page 0** — *"when you are on page 40 on v3 and
    publish v4, you will resume from page 0 of v4."*
11. **Deletion**: deleting a version removes its row and files; deleting the
    library entry removes every version; deleting the draft leaves the published
    entry untouched.

## Files you OWN

- `apps/api/src/latex-routes.ts` — **new**: project + file CRUD, compile, log,
  publish.
- `apps/api/src/latex-compile.ts` — **new**: the compile job, modelled on brief
  34's runner. Calls `packages/typeset`; **no child process**.
- `apps/api/src/db.ts` — `latex_projects`, `document_versions`, the
  `reading_progress` version column, and their statements.
- `apps/api/src/library-routes.ts` — `?version=` on the file route only.
- `apps/api/src/config.ts` + `.env.example` — `LATEX_TIMEOUT_MS` (route
  backstop), `LATEX_MAX_OUTPUT_MB`, `LATEX_MAX_PROJECT_MB`.
- `apps/api/src/index.ts` — route registration. **No binary check** — there is
  no binary.
- `packages/shared/src/latex.ts` — project/file/compile/version contracts,
  extending the `Diagnostic` type brief 37 put there.
- `apps/web/src/latex/` — **new**: project list, editor, file tree, compile
  button, log panel, publish dialog.
- `apps/web/src/routes/latex.tsx` — **new**: the destination.
- `apps/web/src/reader/chrome/` — the version picker (chrome only).
- `apps/web/src/components/AppHeader.tsx` — the nav entry.
- `PRODUCT.md` — the premise rewrite (D36).

## Files you must NOT touch

- `apps/web/src/reader/pdf/**` — the preview and the published reader both reuse
  `PdfReader` **unmodified**. The version picker is reader *chrome*; if
  `PdfReader` itself seems to need changing, stop and say so.
- `packages/typeset/**` — brief 37 owns the engine. If a document won't render,
  that is a brief 39/40 scope item or an engine bug to report, **not** something
  to patch from here.
- `apps/web/src/reader/epub/**`, `apps/web/src/player/**`, `notes-routes.ts`,
  `apps/web/src/notes/**` — Notes and LaTeX are siblings, not relatives.
- `extract.ts` — a published version's cover comes from the existing PDF page-1
  path, unchanged.
- `offline-store.ts` — decision 6.

## What to do

1. **Contract** (`packages/shared/src/latex.ts`): `latexProject` (id, title,
   entrypoint, compileStatus, publishedBookId, createdAt, updatedAt);
   `latexFile` (path, sizeBytes, updatedAt); a compile result with `status`,
   `log` and `diagnostics: Diagnostic[]`; `documentVersion` (id, versionNo,
   publishedAt, sizeBytes).

2. **DB**:
   - `latex_projects (id TEXT PK, profile_id TEXT NOT NULL REFERENCES
     profiles(id) ON DELETE CASCADE, title TEXT NOT NULL, entrypoint TEXT NOT
     NULL DEFAULT 'main.tex', compile_status TEXT NOT NULL DEFAULT 'none',
     published_book_id TEXT REFERENCES books(id) ON DELETE SET NULL, created_at
     TEXT NOT NULL, updated_at TEXT NOT NULL)` + index on `(profile_id,
     updated_at DESC)`. **`ON DELETE SET NULL`** is decision 11: deleting the
     library entry must not delete the draft, or vice versa.
   - `document_versions (id TEXT PK, book_id TEXT NOT NULL REFERENCES books(id)
     ON DELETE CASCADE, version_no INTEGER NOT NULL, pdf_path TEXT NOT NULL,
     source_zip_path TEXT NOT NULL, published_at TEXT NOT NULL)` + unique
     `(book_id, version_no)`.
   - `reading_progress` gains a **nullable** `version_id` recording which version
     the saved locator belongs to — **not** part of the PK, so no rebuild.
     Opening a version whose id differs from the stored one starts at 0, which is
     decision 10. Deliberate simplification: an older version does not keep its
     own position. That matches the owner's rule and stops this becoming a third
     progress mechanism.

3. **The compile job** (`latex-compile.ts`): read the project's files into a map,
   call `compile()` from `packages/typeset`, persist the PDF and the diagnostics.
   **One at a time per account** and cancellable, following brief 34's pattern.
   A `LATEX_TIMEOUT_MS` wall clock is the outer backstop; the engine's step
   budget is the real guard. Because the engine is in-process, **cancellation
   must be cooperative** — pass an abort signal the engine checks at its step
   boundary, and never leave a claimed slot behind (brief 34's Critical: a
   claimed slot for a deleted project wedges compilation app-wide).

4. **Path safety, at every path-accepting route** — see "What changed" above.
   This is the one place the sandbox still lives.

5. **Routes** (`latex-routes.ts`): project CRUD; file list/read/write/rename/
   delete; binary upload for figures and `.bib` (reuse the library's multipart
   size discipline, plus `LATEX_MAX_PROJECT_MB`); `POST /latex/:id/compile`;
   `GET /latex/:id/pdf` streaming the draft artifact; `GET /latex/:id/log`;
   `POST /latex/:id/publish`. Every route verifies the project belongs to the
   requesting **profile** and answers **404, not 403** (brief 35's rule).

6. **Publish** (`POST /latex/:id/publish`): compile first and **refuse to publish
   a failing document**. On success — create the `books` row if the project has
   none (kind `book`, format `pdf`, title from the project, cover via the
   existing page-1 extraction), then append a `document_versions` row storing the
   PDF and a **zip of the entire project tree** (`adm-zip` is already an API
   dependency). Point `books.file_path` at the newest version's PDF so every
   existing consumer — file route, offline download, reader — keeps working
   unchanged; `?version=` selects an older one. Refresh the cover from the newest
   version.

7. **Version picker** (reader chrome + `library-routes.ts`): a quiet control
   listing versions by number and date, shown **only** on a book with more than
   one. Default to the latest, or the version last opened (decision 9).
   `GET /library/:id/file?version=<id>` streams that version with the existing
   ETag conventions derived from that version's own path. A version can be
   deleted from here; deleting the last one deletes the library entry too, since
   an entry with no versions has nothing to show.

8. **Diagnostics panel**: the engine returns structured `Diagnostic`s already —
   this brief **displays** them. Errors first, warnings collapsible, "compiled
   with N warnings" on success. Clicking one jumps the editor to that file and
   line. A LaTeX error with no line number is the daily experience of the format;
   this is the difference between a usable editor and a toy.

9. **Editor** (`apps/web/src/latex/`): CodeMirror 6, lazy-loaded (brief 15's
   precedent), LaTeX mode, file tree, **debounced autosave** at the notes
   editor's cadence. Compile is explicit — a button plus a keybinding — never on
   keystroke. Split view on desktop (source | PDF), **tabbed on mobile**:
   decision 5 means a phone must be *workable*, not equal. A new project is
   seeded with a small hello-world (decision 4) **that the brief-37 engine can
   actually render** — no math, no figures, no tables until 39 and 40 land.

10. **Preview**: feed the compiled blob to `PdfReader` as a `File`, keeping its
    own chrome. On a failed compile keep showing the **last good PDF** beside the
    errors rather than blanking the pane — that is what makes an editor tolerable
    to work in.

11. **Corpus**: add **LaTeX project**, **Draft**, **Published document** and
    **Version** — already in
    [glossary-authoring.md](../../wiki/glossary-authoring.md); verify they match
    what shipped. New `wiki/latex.md` for the destination (the engine has its own
    `wiki/typeset.md` from brief 37); update
    [architecture.md](../../wiki/architecture.md),
    [overview.md](../../wiki/overview.md), `PRODUCT.md`,
    [status.md](../../wiki/status.md), [log.md](../../log.md).

12. **Verify live**: hello-world compiles and previews; a syntax error surfaces a
    diagnostic with the right file and line **while the previous PDF stays
    visible**; an unimplemented command surfaces a clear "not supported"
    diagnostic rather than rendering wrong; a `\newcommand` that recurses forever
    is stopped and the slot is released; cancelling a compile releases the slot;
    `\input{/etc/passwd}` and `../` paths are rejected at every path-accepting
    route; a figure uploads and is stored (rendering it is brief 39); a second
    concurrent compile is refused; publish creates **one** library card; publish
    again adds a version and the card still appears **once**; the version picker
    opens an older version and page 0 is the start after a new publish; a
    version's zip restores a working project; deleting a version removes its
    files; deleting the library entry removes all versions; deleting the draft
    leaves the published entry intact; drafts never appear in the gallery,
    search, chips or counts; another profile sees none of it; library, readers,
    players and Notes are untouched.

## Acceptance

- A project can be created from a hello-world, edited across multiple files,
  compiled, and read as a PDF without leaving Atrium — comfortably on a desktop,
  workably on a phone.
- Compile errors arrive with file and line, clicking one jumps to it, and a
  failed compile never blanks a previously good preview.
- An unimplemented construct is reported as unsupported, never rendered wrong.
- Every project path is confined to its project directory; a runaway document is
  stopped and its slot released; output size is capped.
- **Drafts never appear in the gallery.** Publishing creates exactly one library
  card no matter how many times it is pressed.
- Each version stores its PDF and a zip of the whole project; a zip restores a
  project that still compiles.
- The card opens the latest version (or the last one you opened); a newly
  published version starts at page 0.
- Deleting a version removes its files; deleting the library entry removes every
  version; deleting the draft leaves the published entry alone.
- Projects belong to a profile and are invisible to the household's other
  profiles.
- `PdfReader` is used unmodified; `packages/typeset` is unmodified.
- PRODUCT.md describes what Atrium now is.
- Typecheck + build + tests clean; Reading Room (D33) conformance passes on the
  project list, editor chrome, log panel, publish dialog and version picker.
