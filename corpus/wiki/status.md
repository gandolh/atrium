---
summary: Dated snapshot of current state — a one-liner per brief/area and where things stand right now. The living dashboard.
updated: 2026-08-29
---

# Status — 2026-08-29

**Latest (2026-08-29):** ✅ **Briefs 40 and 43 shipped — the brief backlog is
empty.** Every brief 01–44 is now in `briefs/done/` or `superseded/`.

**40 — the engine sets mathematics.** Inline math on the text baseline, displays
centred with numbers at the margin, `\ref` into the existing reference pass,
growing delimiters, matrices, integrals and the symbol coverage. MathJax v4 SVG
through our own SVG→PDF emitter, **gated to the declared subset** (D41).
**637 tests** (from 506 when this backlog started), all five goldens
byte-identical. Verified by eye: a paper-shaped document rasterised at 2× and
looked at — 7 formulas, one page, one pre-existing `\date` warning.

**The defect worth remembering:** wave 1 left math **silently dropped** —
`layout/vlist.ts` had no arm for either new kind and **neither dispatcher was
exhaustiveness-checked**, so growing the unions produced no typecheck error. A
document compiled to a valid PDF with **zero diagnostics and no mathematics on
it**, while `\ref` still resolved so even the labels looked healthy. Fixed, and
all three dispatchers now carry a `never` guard — that second half is the point.
The bug class is not "math was forgotten", it is "a switch over a union can grow
in silence".

**A real purity hole closed along the way.** Leaving MathJax's `require` and
`autoload` enabled lets a *document* trigger a component load off disk
(`\require{physics}`, or a plain `\color{red}{x}` via autoload). Same class as
`\write18`, arriving through a dependency instead of our own code. Both dropped.

**43 — coverless tiles tell each other apart**, by a hashed title initial whose
size and corner vary. **D42's second axis was corrected on measurement:** the
ground-lightness ladder it originally specified was ~10× stronger than the kind
signal (0.1871 vs 0.0194 in OKLab), so the grid would have read by lightness
rather than kind — the exact D33 inversion the brief exists to prevent. No mix
value works; the palette is near-achromatic. Both axes now sit on the
letterform and the ground is untouched.

**Two verification gaps, recorded as such:** brief 40's math was driven through
the engine directly rather than through brief 38's editor in a live browser, and
brief 43 has no real coverless grid to look at (the library holds 2 coverless
items). Neither is a claim that they were checked.

**Open, deliberately:** the math gate is literal about brief 40's In list, so
`\displaystyle`, `\boldsymbol`, `\mathfrak`, `smallmatrix`/`multline`/
`alignat`/`eqnarray` and friends are refused despite rendering fine — D41's
accepted cost, each a one-line widening. `gather*` and `\begin{math}` are
refused while `align*` and `\(…\)` work; those two read as brief transcription
slips rather than decisions, and were left unchanged pending the owner.

**Earlier (2026-08-29):** ✅ **Briefs 44, 42 and 39 shipped** — one backlog run,
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
| 40 | Engine: math (MathJax v4 SVG → PDF, gated subset — D41) | **done (2026-08-29)** |
| 41 | Storage: portable paths, redirectable dirs, offline rename (D39) | **done (2026-08-27)** |
| 42 | Video covers, decoded in the browser (D40) | **done (2026-08-28)** |
| 43 | Readable tiles for coverless media (D42) | **done (2026-08-29)** |
| 44 | Host the typesetting engine on a worker thread | **done (2026-08-28)** |
