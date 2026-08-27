> **Superseded 2026-08-26 — do not build from this brief.**
> Its engine (server-side Tectonic) was replaced by Atrium's own TypeScript
> typesetting engine (**D38**). The editor, projects, publish and versions design
> was owner-confirmed and survives unchanged in
> [brief 38](../done/38-latex-editor.md); the engine is
> [brief 37](../done/37-engine-foundation.md),
> [39](../todo/39-engine-figures-tables-bib.md) and
> [40](../todo/40-engine-math.md). Kept because it records the Tectonic
> reasoning D38 had to answer.

# Task 36 — LaTeX: write, compile, publish

## Context

Owner request (2026-08-24): *"add latex support. I would like an editor like
overleaf."* Grilled over three rounds the same day; **every decision below is
owner-confirmed** unless marked otherwise.

### Why it belongs in Atrium — and what that costs

**Owner's framing:** LaTeX is here *"for the same thing as notes. Maybe you are
on the road and want to sync what's on your phone with what's on pc and
vice-versa. It's like a personal cloud space."*

That answers the identity question and **widens the product premise**. D32 calls
Atrium *"a media gallery + Notes"*; the operative idea is now **your stuff,
reachable from anywhere** — media you collect, plus documents you author. Notes
was the first thing that didn't fit "gallery"; LaTeX is the second, and two is a
pattern. **Record the widening as a decision and rewrite PRODUCT.md's one-liner
in this brief** rather than letting the premise drift a third time.

Rejected: a separate app sharing the design system, which would mean re-solving
auth, profiles, deploy, and design for one user.

### What Atrium already gives this feature for free

1. **The preview pane already exists.** `PdfReader` takes a **`File`**, not a URL
   ([PdfReader.tsx:70](../../../apps/web/src/reader/pdf/PdfReader.tsx#L70)), so a
   compiled PDF blob is handed to it as `new File([blob], "out.pdf")`. Paged
   rendering, zoom, page nav, search, theming — **already built, unchanged**.
2. **The compile job is brief 34's job runner** — a status column, single-flight
   guard, boot reaping, polling status button, cancellation. Same machine, a
   different child process, a far shorter ceiling.
3. **Authored content has a home pattern.** Notes (brief 26) established
   per-profile, server-stored content living **outside** the media grid, which
   D33 locked deliberately.

What does **not** fit is the notes *storage* shape — `notes` is one JSON blob per
note ([db.ts:143](../../../apps/api/src/db.ts#L143)). A LaTeX project is
multi-file including binaries, so it needs files on disk plus a row: the split
D25 already chose for the library.

### Draft and Published are different things in different places

The owner's rule, and the spine of the whole design:

- A **draft** is the live project you edit. It lives **only** in `/latex` and is
  **never** shown in the gallery.
- **Publishing** puts a compiled PDF in the library as **one entry**, which
  accumulates **versions**. Each publish adds a version; it never creates a
  second card.
- Each version stores **the compiled PDF and a zip of the whole project** at that
  moment — *"so it's easy to resume"*. A version that can't be rebuilt isn't a
  version, and figures are what make rebuilding real.
- Deleting the **draft** does not touch published entries. Publishing is the act
  of making something independent.

### The part a reviewer will flag: TeX is a code execution engine

Running code *is* what TeX does, so sandboxing is spec, not afterthought:

- **Shell escape** (`\write18`) executes arbitrary shell commands. Tectonic
  disables it by default; **disable it explicitly** rather than trusting a default.
- **`\input{/etc/passwd}`** reads any path the process can reach. The compile
  runs with its cwd pinned to the project and must not escape it.
- **Non-terminating documents** are trivial to write by accident. A hard
  wall-clock timeout is mandatory — and unlike brief 34's 24-hour conversion
  ceiling, this one is **short** (a minute or two), because a compile the user is
  waiting on has no reason to run longer.
- **Output size**: a runaway document can fill the disk. Cap the artifact.

### The engine: server-side Tectonic

Settled by two answers — **light phone edits** (not full authoring) and
**online-only** — which together remove every reason to run TeX in the browser.

| | Tectonic (server) | SwiftLaTeX / WASM (browser) |
|---|---|---|
| Dependency | one self-contained binary, ~75 MB image | none server-side |
| Packages | **auto-downloaded on demand** + cached | bundled set, more limited |
| Payload to a phone | none | multiples of the **entire 3 MB shell** |
| Repeat compiles | server round-trip | ~2–3× faster, local |
| Licence | permissive | **AGPL-3.0** |
| Buys offline compile | no | yes — **and nobody asked for it** |

The deciding arguments are **precedent and payload**: D5 already accepts a binary
dependency (`ebook-convert`) for a core capability, and Tectonic is a *single*
binary that fetches packages on demand rather than a ~5 GB TeX Live install.
Meanwhile the app's entire initial JS is **123 kB gzip** and briefs 15–17 were
explicitly about trimming payload ([performance.md](../../wiki/performance.md));
shipping a WebAssembly TeX engine to a phone reverses that work.

Sources: [Tectonic](https://github.com/tectonic-typesetting/tectonic),
[Tectonic Docker (~75 MB, on-demand packages)](https://hub.docker.com/r/dxjoke/tectonic-docker),
[SwiftLaTeX](https://github.com/SwiftLaTeX/SwiftLaTeX),
[TeX Live scheme tiers](https://tex64.com/learn/install/docker-ci).

### Grilled decisions (2026-08-24, owner-confirmed)

1. **In Atrium, as a third destination** (`/latex`), sibling to Notes, outside
   the media grid. The product premise widens to a personal cloud space.
2. **Per-profile**, like Notes — so this brief follows **brief 35**.
3. **v1 is exactly three things**: multi-file projects (`.tex`/`.bib`/figures),
   compile + PDF preview, and an error log with file and line. Explicitly
   **out**: autocomplete, SyncTeX, version history *of the draft*, collaboration,
   rich-text mode, bibliography tooling, and a template gallery.
4. **A new project starts from a small hello-world.** No zip import — the owner
   has nothing to bring in.
5. **Light edits on the phone**, not full authoring. Compose on a desktop; on a
   phone fix a typo and recompile. Drives **CodeMirror 6** over Monaco (Monaco is
   roughly 10× the entry chunk for one destination, and is not touch-credible).
6. **Online-only**, matching Notes and D32. If offline editing ever matters it
   deserves one brief covering Notes *and* LaTeX — solving sync twice, differently,
   is how a codebase grows a permanent seam.
7. **Single-writer**, last-write-wins per file. No CRDTs, no live cursors.
8. **Publish → one library entry with versions** (above).
9. **Opening a published card shows the latest version**, or the version you were
   last reading if you had explicitly opened an older one.
10. **A new version starts at page 0** — *"when you are on page 40 on v3 and
    publish v4, you will resume from page 0 of v4."*
11. **Deletion**: deleting a version removes its row and its files; deleting the
    library entry removes every version; deleting the draft leaves the published
    entry untouched.

## Files you OWN

- `apps/api/src/tectonic.ts` — **new**: the child-process wrapper, modelled on
  [calibre.ts](../../../apps/api/src/calibre.ts) (same discriminated outcome, a
  promise that never rejects, its own timeout and process-tree kill).
- `apps/api/src/latex-routes.ts` — **new**: project + file CRUD, compile, log, publish.
- `apps/api/src/db.ts` — `latex_projects`, `document_versions`, the
  `reading_progress` version column, and their statements.
- `apps/api/src/library-routes.ts` — `?version=` on the file route only.
- `apps/api/src/config.ts` + `.env.example` — `LATEX_TIMEOUT_MS`,
  `LATEX_MAX_OUTPUT_MB`, `LATEX_MAX_PROJECT_MB`, the Tectonic cache dir.
- `apps/api/src/index.ts` — registration + the startup binary check.
- `packages/shared/src/latex.ts` — **new**: project/file/compile/version contracts.
- `apps/web/src/latex/` — **new**: project list, editor, file tree, compile
  button, log panel, publish dialog.
- `apps/web/src/routes/latex.tsx` — **new**: the destination.
- `apps/web/src/reader/chrome/` — the version picker (chrome only).
- `apps/web/src/components/AppHeader.tsx` — the nav entry.
- `PRODUCT.md` — the premise rewrite (decision 1).

## Files you must NOT touch

- `apps/web/src/reader/pdf/**` — the preview and the published reader both reuse
  `PdfReader` **unmodified**. The version picker is reader *chrome*; if PdfReader
  itself seems to need changing, stop and say so.
- `apps/web/src/reader/epub/**`, `apps/web/src/player/**`, `notes-routes.ts`,
  `apps/web/src/notes/**` — Notes and LaTeX are siblings, not relatives.
- `extract.ts` — a published version's cover comes from the existing PDF page-1
  path, unchanged.
- `calibre.ts` and brief 34's job runner — **model** the new runner on them; do
  not generalize the existing one mid-flight. A shared job abstraction is a later
  cleanup, once two real users exist.
- `offline-store.ts` — decision 6.

## What to do

1. **Contract** (`packages/shared/src/latex.ts`): `latexProject`
   (id, title, entrypoint, compileStatus, publishedBookId, createdAt, updatedAt);
   `latexFile` (path, sizeBytes, updatedAt); a compile result with `status`,
   `log`, and parsed `diagnostics: { file, line, severity, message }[]`; and
   `documentVersion` (id, versionNo, publishedAt, sizeBytes).

2. **DB**:
   - `latex_projects (id TEXT PK, profile_id TEXT NOT NULL REFERENCES
     profiles(id) ON DELETE CASCADE, title TEXT NOT NULL, entrypoint TEXT NOT
     NULL DEFAULT 'main.tex', compile_status TEXT NOT NULL DEFAULT 'none',
     published_book_id TEXT REFERENCES books(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL)` + index on
     `(profile_id, updated_at DESC)`. **`ON DELETE SET NULL`** is decision 11:
     deleting the library entry must not delete the draft, and vice versa.
   - `document_versions (id TEXT PK, book_id TEXT NOT NULL REFERENCES books(id)
     ON DELETE CASCADE, version_no INTEGER NOT NULL, pdf_path TEXT NOT NULL,
     source_zip_path TEXT NOT NULL, published_at TEXT NOT NULL)` + unique
     `(book_id, version_no)`.
   - `reading_progress` gains a nullable `version_id` recording which version the
     saved locator belongs to — **not** part of the PK, so no rebuild. Opening a
     version whose id differs from the stored one starts at 0, which is exactly
     decision 10. Deliberate simplification: an older version does not retain its
     own position. That matches the owner's rule and keeps this from becoming a
     third progress mechanism.

3. **The engine wrapper** (`tectonic.ts`): spawn Tectonic with cwd pinned to the
   project dir, `--chatter minimal`, **shell escape explicitly disabled**, the
   package cache dir from config, and a hard `LATEX_TIMEOUT_MS` wall clock that
   kills the process tree. Return `ok | failed | timeout | missing` plus the
   captured log, capped so a chatty failure can't balloon memory. **The promise
   never rejects.**

4. **Path safety, at every path-accepting route**: validate each project-relative
   path as relative, normalize it, and confirm it resolves **inside** the project
   directory — no absolute paths, no `..`, no symlinks out. Applies to create,
   rename, upload, delete, and the entrypoint field. One unchecked join here is an
   arbitrary file write.

5. **Routes** (`latex-routes.ts`): project CRUD; file list/read/write/rename/
   delete; binary upload for figures and `.bib` (reuse the library's multipart
   size discipline, plus `LATEX_MAX_PROJECT_MB`); `POST /latex/:id/compile`;
   `GET /latex/:id/pdf` streaming the draft artifact; `GET /latex/:id/log`;
   `POST /latex/:id/publish`. Compile is **one at a time per account** and
   cancellable, following brief 34's pattern.

6. **Publish** (`POST /latex/:id/publish`): compile first and **refuse to publish
   a failing document**. On success — create the `books` row if this project has
   none (kind `book`, format `pdf`, title from the project, cover via the existing
   page-1 extraction), then append a `document_versions` row storing the PDF and a
   **zip of the entire project tree**. Point `books.file_path` at the newest
   version's PDF so every existing consumer — the file route, offline download,
   the reader — keeps working with no changes; `?version=` selects an older one.
   Refresh the cover from the newest version.

7. **Version picker** (reader chrome + `library-routes.ts`): a quiet control
   listing versions by number and date, shown **only** on a book that has more
   than one. Default to the latest, or to the version last opened (decision 9).
   `GET /library/:id/file?version=<id>` streams that version, with the existing
   ETag conventions derived from the version's own path. A version can be deleted
   from here; deleting the last remaining version deletes the library entry too,
   since an entry with no versions has nothing to show.

8. **Log parsing**: turn TeX's log into structured diagnostics (`file`, `line`,
   `severity`, `message`). This is the difference between a usable editor and a
   toy — a LaTeX error with no line number is the daily experience of the format.
   Errors first, warnings collapsible, "compiled with N warnings" on success.

9. **Editor** (`apps/web/src/latex/`): CodeMirror 6, lazy-loaded (brief 15's
   precedent), LaTeX mode, file tree, **debounced autosave** at the notes editor's
   cadence. Compile is explicit — a button plus a keybinding — never on keystroke.
   Split view on desktop (source | PDF), **tabbed on mobile**: decision 5 means a
   phone must be *workable*, not equal. A new project is seeded with a small
   hello-world (decision 4).

10. **Preview**: feed the compiled blob to `PdfReader` as a `File`, keeping its
    own chrome. On a failed compile keep showing the **last good PDF** beside the
    errors rather than blanking the pane — that is what makes an editor tolerable
    to work in.

11. **Corpus**: record two decisions — the **premise widening** (Atrium as a
    personal cloud space, superseding D32's "media gallery + Notes" framing) and
    the **LaTeX implementation** (Tectonic server-side with the rejected
    alternatives, the sandboxing rules, and the draft/published/versions model).
    Add **LaTeX project**, **Draft**, **Published document**, and **Version** to
    the glossary. New `wiki/latex.md`; update `wiki/architecture.md`,
    `wiki/overview.md`, `PRODUCT.md`, `wiki/status.md`, `log.md`.

12. **Verify live**: hello-world compiles and previews; a package not in the cache
    is pulled and compiles; a syntax error surfaces a diagnostic with the right
    file and line **while the previous PDF stays visible**; a `\loop` with no exit
    is killed at the timeout with a clear message; `\write18{...}` does **not**
    execute; `\input{/etc/passwd}` and `../` paths are rejected at every
    path-accepting route; a figure uploads and renders; a second concurrent
    compile is refused; publish creates **one** library card; publish again adds a
    version and the card still appears **once**; the version picker opens an older
    version and page 0 is the start after a new publish; a version's zip restores
    a working project; deleting a version removes its files; deleting the library
    entry removes all versions; deleting the draft leaves the published entry
    intact; drafts never appear in the gallery, search, chips, or counts; another
    profile sees none of it; a missing Tectonic binary produces a clear startup
    warning and a clear in-app error; library, readers, players and Notes are
    untouched.

## Acceptance

- A project can be created from a hello-world, edited across multiple files,
  compiled, and read as a PDF without leaving Atrium — comfortably on a desktop,
  workably on a phone.
- Compile errors arrive with file and line, and a failed compile never blanks a
  previously good preview.
- Shell escape is off, every project path is confined to its project directory, a
  non-terminating document is killed by wall clock, and output size is capped.
- **Drafts never appear in the gallery.** Publishing creates exactly one library
  card no matter how many times it is pressed.
- Each version stores its PDF and a zip of the whole project; a zip restores a
  project that still compiles.
- The card opens the latest version (or the last one you opened); a newly
  published version starts at page 0.
- Deleting a version removes its files; deleting the library entry removes every
  version; deleting the draft leaves the published entry alone.
- Projects belong to a profile and are invisible to the household's other profiles.
- Tectonic absent → a loud startup warning and a clear in-app error; nothing else
  degrades.
- `PdfReader` is used unmodified.
- PRODUCT.md describes what Atrium now is.
- Typecheck + build + tests clean; Reading Room (D33) conformance passes on the
  project list, editor chrome, log panel, publish dialog, and version picker.
