---
summary: Archive of Atrium's most recent shipped phases — briefs 39–52, 2026-08-29 to 2026-08-30 (the engine's math, the worker thread, the Knex move) — what each run delivered, fixed and verified. Split out of status.md, which keeps the current snapshot.
updated: 2026-10-03
---

# Status history

Split out of [status.md](status.md) on 2026-08-26, when that page passed the
corpus 200-line rule. It kept the current snapshot and the briefs table; this
holds the most recent narrative, newest first; older entries moved to
[status-history-v2.md](status-history-v2.md) on 2026-10-03 when this page filled.
Nothing here has been rewritten — these are the entries as they were written at
the time.

---

**2026-08-30 —** ✅ **Brief 52 shipped — `apps/api` is modular and runs
on Knex.** 18 flat files became six domain modules, each controller / service /
model, with `src/database/` (Knex instance, one idempotent baseline migration,
boot tasks) and `src/common/`. The 2,210-line `db.ts` is gone, and the schema no
longer arrives as a side effect of an `import` — `initDatabase()` is awaited
before `listen`, so a failed migration stops the server instead of surfacing as
a 500 on the first request. **D24's synchronous-API clause is revised → D47.**

**What the async move cost, and why it was worth writing down.** Three
correctness properties held *only* because `better-sqlite3` statements could not
be interleaved, and all three would have failed silently: the conversion
single-flight (two concurrent requests could both spawn `ebook-convert` — now one
atomic `claimConvertSlot` UPDATE), the compile single-flight (now an explicitly
await-free claim region), and `cancelAndSettleLatexCompile`, which could return
*immediately while reporting that it had waited* on a job whose promise was not
yet assigned — orphaning a build tree on delete-mid-compile. The bug class is
"an invariant that was paid for by the runtime, not by the code".

**Verified, not tested.** A copy of the live database (all five storage roots
redirected per D39) migrated with every row count preserved and no FK
violations; 128 live requests across every route group; both single-flight
guards confirmed under six-way concurrency; clean SIGTERM. Typecheck + build
green, 647/647 tests pass. **`apps/api` still has no automated tests** — now the
largest gap in the repo, and much cheaper to close than it was.

**Earlier (2026-08-29):** ✅ **Briefs 40 and 43 shipped — the brief backlog is
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

**Both verification gaps were then closed in a browser, and each caught a defect
nothing else could have.**

**Brief 40 shipped an engine the app could not use.** Every engine test passed
and the rasterised PDF looked right, yet the preview reported *"8 errors — math
typesetting is brief 40, a separate future brief"*: `apps/api` imports the
**built** package and `dist/` was a day stale, and `latex-worker.ts` never
injected the renderer at all. **The brief's own "do not touch `apps/api`" made
its headline acceptance unreachable** — brief 38 needed no change to show new
*diagnostics*, which is not the same as rendering. Fixed; measured cost
prose-only 867 ms, math 996 ms.

**Brief 43's initial was rendering behind the tile.** 18 correctly-hashed spans
existed at full size with computed visibility `true`, and were invisible in
every theme: `-z-10` put the letter behind the *ancestor's* tinted ground rather
than behind its own siblings. Fixed, then verified on a seeded 18-item grid in
light and dark.

**An incident, no data lost:** resuming after a quota interruption, the
scratchpad holding the storage-root redirects had been wiped, so the dev servers
booted against the **real** library and applied briefs 34 and 41's pending
migrations. They were due and had been tested against a copy, and everything
survived — 5 books, 9 files, 7 thumbnails, all user data. But it was
unintentional, and the lesson is that **a redirect sourced from a file is
silently optional**: set the roots inline and assert them before starting. See
[open-questions.md](open-questions.md).

**The math gate was widened** on the owner's call: `gather*`, `\displaystyle`
and `\boldsymbol` are now admitted. `\boldsymbol` turned out to be a real bug
rather than a scope question — it reported `undefined-command`, because
MathJax's base input lacks it and `autoload` is dropped, so ordinary amsmath
read as a thing that does not exist. `\begin{math}` was admitted and **not
delivered**: it is a parser-mode problem, not a table entry, since an
environment's body is never read in math mode. Still refused by design:
`\mathsf`, `\mathtt`, `\mathfrak`, `smallmatrix`, `multline`, `alignat`,
`eqnarray` — D41's accepted cost, each a one-line widening.

**Next:** [brief 45](../briefs/done/45-profile-delete-cancels-compiles.md)
(profile delete must cancel the compiles it orphans — it can wedge an account's
slot) and [brief 46](../briefs/done/46-compile-status-write-failure.md) (a
swallowed status write can wedge until restart). Both promoted from brief 44's
review, and both re-confirmed unbuilt in the source on 2026-08-29. Then **47**
(bibliography label width), **48** (orphan-thumbnail reaper) and **49–51**
(notes: export, folders, ink tools).

**Corpus housekeeping (2026-08-29):** `CLAUDE.md` moved to the **repo root** so
the D33 checklist auto-loads; `HANDOFF.md` + `test-plans/` retired; and
**`todos/` was merged into `briefs/todo/`** — one queue now, nine trail files
deleted, five new briefs (47–51). See [../log.md](../log.md).

---

**2026-08-29 —** ✅ **Briefs 44, 42 and 39 shipped** — one backlog run,
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

Older entries, from 2026-08-27 back to brief 34, are in [status-history-v2.md](status-history-v2.md); the v1 era is in [status-history-v1.md](status-history-v1.md).
