---
summary: Dated snapshot of current state — a one-liner per brief/area and where things stand right now. The living dashboard.
updated: 2026-08-26
---

# Status — 2026-08-26

**Latest (2026-08-26):** ✅ **Brief 37 shipped — the typesetting engine.**
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

**Earlier (2026-08-25):** ✅ **Brief 35 shipped — profiles.** An account is now
a household and a **profile** is a person in it (D35): reading progress, notes
and four reading preferences moved from user scope to profile scope, switching
is one tap with no credential, and the picker returns after 24h idle. Built via
orchestrate → plan-split-dispatch in 3 waves (7 chunks, 3 senior / 4 junior).
The `reading_progress` rebuild — SQLite cannot ALTER a composite PK — landed all
8 live rows and both notes on the right Default profile with zero loss, proven
against a copy before the real DB was touched.

Three scoped finders caught **10 findings (3 Critical)**, all fixed but one
Minor. Every Critical crossed chunk boundaries and none tripped the gates: a
switch leaving the reader loaded so one profile's page was written to another's
row; an offline boot hanging forever on the picker gate; and the preferences
boot cache flashing the wrong theme on exactly the load its fallback existed
for. Details in [briefs/done/35-profiles.md](../briefs/done/35-profiles.md).

**Known and accepted:** the account's default profile cannot be deleted (rename
works); a session whose profile is deleted from another device silently reads as
Default until reload. **This repo still has no test suite**, which is again why
the review pass carried the weight.

**Older entries** — every shipped phase before brief 35, with what each run
fixed and how it was verified — moved to
[status-history.md](status-history.md) when this page passed the 200-line rule.
The dashboard is what is true *now*; the archive is how it got here.

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
| 38 | LaTeX editor: projects, compile, publish, versions | **todo — next, unblocked** |
| 39 | Engine: figures, tables, bibliography | **todo** |
| 40 | Engine: math (MathJax SVG → PDF) | **todo** |
