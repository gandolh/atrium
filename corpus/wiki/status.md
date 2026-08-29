---
summary: Dated snapshot of current state — a one-liner per brief/area and where things stand right now. The living dashboard.
updated: 2026-08-29
---

# Status — 2026-08-29

**Latest (2026-08-29):** ✅ **Briefs 44, 42 and 39 shipped** — one backlog run,
built on branch `briefs-44-42-39`.

**44 — the engine runs on a `worker_thread`, and cancel is real.** A compile no
longer blocks the API: a **10.4 s** compile left the spawning thread with **514
heartbeats, worst extra gap 1 ms**. Worker-*per-compile*, deliberately — a
reused worker cannot be `terminate()`d without destroying the next compile's
host, so stopping it would have to be cooperative, which is exactly what cannot
work against a synchronous engine that never yields. A `DELETE` now kills a
compile mid-engine instead of waiting out `LATEX_TIMEOUT_MS`. 3 finders, 3
Important, all fixed.

**42 — video has real covers, decoded in the browser (D40).** `<video>` → seek →
`drawImage` → `toBlob`, no ffmpeg, so brief 23's declined binary stands. Capture
at upload (3 candidate frames, highest luminance variance — one fixed seek hits
a black fade-in too often) *and* as a **backfill on first playback**, which is
what covers the existing library with no re-upload. Native aspect at a 640
bound, letterboxed in the tile. **Everything iOS is unverified — no device
here.**

**39 — the engine sets a paper, not just a report.** Floats with `[htbp]` and a
deferral queue, `\includegraphics` embedding real PNG and JPEG, `tabular` with
measured columns and rules, and a `.bib` file becoming numbered citations.
**506 tests** (from 332), and **all four brief-37 goldens byte-identical** —
the load-bearing check, because a page-builder change that silently reflows
plain prose is the failure mode they exist to catch.

**Brief 39's review broke the pattern this project keeps seeing, and that is
the interesting part.** For five builds running, every serious defect had
spanned chunk boundaries. This one lay *inside* a single owned file: a `tabular`
row that stops short of the last column drew the table's right-hand border
partway across the grid and dropped every vertical rule past it. Legal LaTeX
with a diagnostic-free wrong picture — the one failure mode the loud-failure
contract cannot catch, since nothing was unimplemented and so nothing had
anything to report. The pre-existing test asserted the case *"stays quiet"*,
which it did, while rendering wrongly. **Geometry needs assertions on
coordinates, not on diagnostics.** Fixed, with a test that fails without the fix.

**Not verified by eye:** brief 39's "check a paper-shaped document in the
preview" acceptance criterion. No browser run this session; the float fixture
and the `floats.txt` golden cover the geometry programmatically.

**Open for the owner:** brief 40 (math) needs a **34.3 MB** `mathjax-full@3.2.2`
dependency — Apache-2.0, server-side only, so no browser payload, but a large
addition to a package that has shipped with `pdf-lib` alone. **Not added,
awaiting a yes.** Brief 43 (coverless tiles) is held by its own design until
there is a real count of how many coverless videos survive brief 42's backfill.

**Earlier (2026-08-27):** ✅ **Brief 38 shipped — LaTeX in Atrium.** You can
write a multi-file project at `/latex`, compile it with **our own engine** (no
TeX, no binary), preview the PDF beside the source, and **publish** it into the
library as a document that accumulates **versions** — press publish ten times
and you get ten versions on one card, verified on real data. Diagnostics carry
file and line and clicking one jumps the caret; an unimplemented construct reads
as *"not supported yet"* and is visibly distinct from a typo. The engine's
purity means the remaining attack surface is one path-confinement module, which
rejects traversal, absolutes, escaping symlinks and — the case naive
implementations write straight through — **dangling** symlinks.

10 chunks, 3 finders, **13 findings (3 Critical)**, all fixed. Every serious one
crossed chunk boundaries and none tripped a gate: the compile preview
overwriting the real reader's saved position, a stale cache reverting a saved
edit, a fire-and-forget `flush()` letting publish immortalise stale bytes, and
publish racing itself into two cards. Details in
[briefs/done/38-latex-editor.md](../briefs/done/38-latex-editor.md) and
[latex.md](latex.md).

**Was known, now fixed:** `compile()` blocking the API process for its duration
was brief 38's standing limitation. **Brief 44 closed it** — the engine is
hosted on a `worker_thread` and `compile()`'s synchronous contract is unchanged.

**Earlier (2026-08-27):** ✅ **Brief 41 shipped — storage paths are derived, and
testing is finally sandboxable.** All three storage roots are env overrides, so
a scratch database and scratch files move together; the `file_path`/`cover_path`
columns are **dropped** and every location derives from `paths.ts`. `hasCover`
is now a disk `stat`, which makes DB/disk drift unrepresentable and deleted
`reconcileMissingCovers` outright. The offline store is at **v5** with the field
renamed `fraction` → `progress`. The review's best catch was against the brief
itself: dropping a stored path *unread* destroys the only record of where a
misplaced file actually is, so the migration now warns and names every drifted
row first. **Your real database is untouched — it migrates on the next API
boot**, and note it is still pre-brief-34, so that boot runs two briefs'
migrations at once (tested together, converges cleanly).

**Earlier (2026-08-27):** 🧭 **Grill session — every open question closed.**
The three threads in [open-questions.md](open-questions.md), two of them open
since July, are now **D39** and **D40** and are specified as briefs 41–43. The
headline: the API stored absolute paths while two of its three storage roots
could not be redirected, which is why pointing a test at a *copied* database
still reached the **real** files — the hazard that destroyed a book on
2026-08-25. Paths become derived and all three roots become overridable, so a
scratch database and scratch files finally move together. `cover_path` is
dropped and `hasCover` becomes a disk check, which deletes
`reconcileMissingCovers` outright. Also settled: the offline store's `fraction`
→ `progress` rename (IndexedDB v5), and video covers captured **in the browser**
— no ffmpeg, since what brief 23 declined was the binary, not the feature.
**Nothing is built yet**; 41 is the next build and gates 38.

**Earlier (2026-08-26):** ✅ **Brief 37 shipped — the typesetting engine.**
Atrium compiles LaTeX with **its own TypeScript engine** (D38), not Tectonic and
not any TeX: `packages/typeset` takes a `.tex` file map and returns PDF bytes as
a pure function with no filesystem, network or processes. That purity *is* the
sandbox — `\write18` cannot execute because no shell escape is written, and
`\input{/etc/passwd}` has no filesystem to reach. 10,708 lines of engine, 5,335
of tests, **332 tests** — the repo's first test suite. Prose, sections, ToC,
lists, footnotes, cross-references, `\newcommand` and verbatim all set
correctly; figures/tables/bibliography are brief 39 and math is brief 40, and
every construct outside the subset reports a diagnostic with file and line
rather than failing silently. Details in
[briefs/done/37-engine-foundation.md](../briefs/done/37-engine-foundation.md)
and [typeset.md](typeset.md).

**Earlier (2026-08-26):** ✅ **Brief 34 shipped — Convert.** A PDF now offers a
reflowable EPUB twin and an EPUB offers a PDF, as **linked `books` rows** (D34)
— one card per book, each format with its own resume position, and reopening
lands in the format that reader last used. Conversion is an async job: one at a
time, cancellable, 24h reaper, restart-safe. A quality gate flags a likely scan
`poor` and warns without ever blocking, because the honest answer to a bad
conversion is that the source is one tap away. The stateless `POST /convert`,
its temp-file workspace and `convert-api.ts` are **deleted** — D1's export-only
rule is revised, its reason having been direction-specific all along.

Three finders caught **7 findings (1 Critical)**, all fixed but two Minor. The
Critical was reported by two finders independently: deleting a book never
cancelled its running conversion, wedging conversion app-wide behind a slot held
for a row that no longer existed. Details in
[briefs/done/34-convert.md](../briefs/done/34-convert.md).

**Incident:** an agent destroyed a real book during verification (a copied DB
still points at the real files) — recovered from a duplicate; `config.ts` and
[open-questions.md](open-questions.md) now record the hazard, and a manual
backup exists outside the repo.

**Not verified:** this machine's Calibre has an `lxml`/`html5-parser` ABI
mismatch, so anything with an outline fails to convert. The two-column and
scanned-PDF readability checks await a working install.

**Older entries** — every shipped phase through brief 35, with what each run
fixed and how it was verified — live in
[status-history.md](status-history.md); entries move there as this page passes
the 200-line rule. The dashboard is what is true *now*; the archive is how it
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
| 40 | Engine: math (MathJax SVG → PDF) | **todo — blocked on an owner call: a 34.3 MB `mathjax-full` dep** |
| 41 | Storage: portable paths, redirectable dirs, offline rename (D39) | **done (2026-08-27)** |
| 42 | Video covers, decoded in the browser (D40) | **done (2026-08-28)** |
| 43 | Readable tiles for coverless media | **todo — held: needs a real count of surviving coverless videos** |
| 44 | Host the typesetting engine on a worker thread | **done (2026-08-28)** |
