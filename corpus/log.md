# Log

## [2026-08-29] build | Briefs 40 and 43 shipped — the brief backlog is empty

Every brief 01–44 is now in `briefs/done/` or `superseded/`. **637 tests** (from
506 when this backlog started), typecheck clean across four workspaces, both
apps build, all five goldens byte-identical.

**Brief 40 — the engine sets mathematics.** MathJax v4 SVG through our own
SVG→PDF emitter, gated to the declared subset (D41). Inline math on the text
baseline, displays centred with numbers at the margin, `\ref` through the
existing reference pass, growing delimiters, matrices, integrals, symbol
coverage. Built as three parallel chunks against disjoint files, then a layout
chunk.

**The defect worth remembering.** Wave 1 left math **silently dropped**:
`layout/vlist.ts` had no arm for either new kind and **neither dispatcher was
exhaustiveness-checked**, so growing the `Inline` and `Block` unions produced no
typecheck error. A document with `$x^2 + \alpha$` and a numbered `equation`
compiled to a valid 5172-byte PDF with **zero diagnostics and no mathematics on
the page** — while `\ref` still resolved, so even the labels looked healthy. The
contract chunk found it and correctly refused to reach into `src/layout/`; the
controller reproduced it before dispatching the fix. All three dispatchers now
carry a `never` guard, and that is the actual lesson: the bug class is not "math
was forgotten", it is **"a switch over a union can grow in silence"**.

**A real purity hole closed.** Leaving MathJax's `require` and `autoload`
enabled lets a *document* trigger a component load off disk — `\require{physics}`,
or even a plain `\color{red}{x}` via autoload. Same class as `\write18`, arriving
through a dependency rather than our own code, and it would have falsified the
no-I/O claim the engine's security design rests on. Both dropped alongside
`noundefined`. Two more v4 behaviours had to be switched off: fonts load lazily
in ~40 ranges so a cold `\mathbb{R}` *throws* (warmed at construction, with a
test sweeping the symbol corpus), and v4 line-breaks inline math by itself.

**Deviations, each deliberate and recorded in the brief:** `page.ts` was on the
must-not-touch list and is touched — a `PlacedMath` variant, a `case` arm, and
the guard, with **none** of the page-*breaking* algorithm moved. `<rect>` joined
the SVG emitter's scope because it carries every fraction bar and radical rule.
SVG arcs are refused with a diagnostic rather than implemented, MathJax emitting
none.

**Known gaps, reported rather than hidden:** per-line numbering inside a
multi-line display is not implemented (`\begin{align}` is one MathJax run, so
per-line baselines live inside a single SVG) and says so at the display's own
line. The gate is literal about the In list, so `\displaystyle`, `\boldsymbol`,
`\mathfrak` and friends are refused despite rendering — D41's accepted cost.
`gather*` and `\begin{math}` are refused while `align*` and `\(…\)` work; those
read as brief transcription slips and were left pending the owner rather than
widened unilaterally, since the strict gate was an explicit choice.

**Brief 43 — coverless tiles, with D42's second axis corrected on measurement.**
A hashed title initial whose size and corner vary, six variants. The
ground-lightness ladder D42 originally specified was built, reported as passing
D33's tint test, and **the claim did not survive checking**: the kind signal
(closest pair) is 0.0194 in OKLab while the lightness spread was 0.1871 — ~10×
stronger, so the grid would have read by lightness rather than kind, the exact
inversion the brief exists to prevent. Sweeping the range found no working
value; the window is empty because Reading Room's tints are near-achromatic, not
because the arithmetic was tuned wrong. Both axes moved onto the letterform and
the ground reverted, which also makes a tile *with* artwork untouched by
construction rather than by a gate.

**How the wrong answer passed its own check**, kept because the lesson is about
the fixture: the first build verified the tint test with swatches **grouped by
kind** — same-step across kinds, same-kind across steps, examined separately.
That is precisely the arrangement that hides the failure, which only shows up in
the mixed grid the test describes.

**Verification.** Brief 40's replaced acceptance criterion (no TeX exists here,
and D38's point is that Atrium depends on none) was met by rasterising a
paper-shaped document at 2× and looking at it: 7 formulas, one page, one
pre-existing `\date` warning. One suspected defect was chased and **disproved** —
line spacing looked tight around a tall inline fraction, but measurement showed
the baseline gap opening from 12pt to 13.85pt with 8.05pt clearance, `\lineskip`
firing exactly as TeX specifies.

**Two verification gaps, recorded as gaps:** brief 40 was driven through the
engine directly rather than brief 38's editor in a live browser, and brief 43
has no real coverless grid to look at — the library holds two coverless items.

**Corpus:** `wiki/typeset-math.md` split out of `typeset.md`, and
`wiki/status-history-v1.md` split out of `status-history.md`, both on the
200-line rule.


## [2026-08-29] build | Briefs 44, 42 and 39 shipped — worker thread, video covers, figures/tables/bibliography

One backlog run on branch `briefs-44-42-39`, cut from `main` at brief 38.
**Typecheck 0, builds 0, 506/506** (from 332). All four brief-37 goldens
**byte-identical**.

**Brief 44 — the engine runs on a `worker_thread`, and cancel is real.**
`latex-compile.ts` spawns `latex-worker.ts` per compile; `compile()`'s
synchronous contract is untouched — only where it runs changed. Measured: a
**10.4 s** compile left the spawning thread with **514 heartbeats, worst extra
gap 1 ms**. Worker-per-compile is a ruling, not an implementation detail: a
reused worker cannot be `terminate()`d without destroying the next compile's
host, so stopping it must be cooperative — exactly what cannot work against an
engine that never yields. 3 finders, 3 Important, all fixed. The one to carry
forward: **a "re-check the flag" fix on a synchronous-resume path needs an
`await`** — the microtask queue drains fully before any timer or I/O callback,
so a re-check with nothing to yield on cannot observe a flag an inbound request
set. Proven with a three-way rig after the controller specified the fix wrongly.

**Brief 42 — video covers, decoded in the browser (D40).** `<video>` → seek →
`drawImage` → `toBlob`; no ffmpeg, so brief 23's declined binary stands. Capture
at upload (3 candidates, highest luminance variance) **and** as a backfill on
first playback — which is what covers the existing library with no re-upload and
is the iOS mitigation. Native aspect at a 640 bound (`fit: "inside"`),
letterboxed in a `4/3` tile. 2 finders, fixed. **Everything iOS is unverified —
no device here**; `MAX_ATTEMPTS_PER_SESSION = 2` exists to reserve an attempt for
the backfill after an upload-time failure and must not be reduced to 1.

**Brief 39 — the engine sets a paper, not just a report.** Floats with `[htbp]`
and a deferral queue, `\includegraphics` embedding real PNG and JPEG, `tabular`
with two-pass column measurement and rules, and a `.bib` file becoming numbered
citations. Images embed **verbatim** where they can — PDF's `/Predictor 15` is
PNG's own scanline filtering and a `/DCTDecode` stream is a JPEG datastream — so
every PNG chunk's CRC is verified instead, since those paths never look at a
pixel. Built as one contract chunk plus four typed stub seams; three ran
concurrently with two shared files reserved to the controller, and **zero writes
were lost**.

**Brief 39's review ran late — after its code was committed — and broke the
pattern.** For five builds running, every serious defect had spanned chunk
boundaries. This one lay *inside* a single owned file: a `tabular` row that
stops short of the last column had its `HBox` end at the last written cell, so
the table's right-hand `|` border was drawn partway across the grid and every
vertical rule past the short row vanished. `a & b \\` in a `{|l|l|l|}` is legal
LaTeX — `\halign` supplies the omitted entries. **A diagnostic-free wrong
picture is the one failure mode the loud-failure contract cannot catch**, since
nothing was unimplemented and so nothing had anything to report; the pre-existing
test asserted the case "stays quiet", which it did, while rendering wrongly.
Fixed by padding short rows the way `\halign` does, with a regression test
comparing each row's rule x-positions against the full row's — confirmed to fail
without the fix. Cleared on inspection: the deferral queue's prefix invariant and
termination, the PNG/JPEG walks (bounds, CRC, CMYK, progressive, interlace all
handled), and the bibliography's `[?]`-plus-diagnostic on an unknown key.

**Corpus corrections this closeout made** — two wiki claims the code had
falsified: `latex.md`'s "Known limitation" said `compile()` blocks the API and a
cancel cannot be delivered (**all four of its statements were inverted by brief
44**), and `design.md`'s tile line said "video 16:9 (kept from brief 25)" when
the box has been `4/3` since brief 25/29 — dormant-wrong before brief 42, and
operative after it. `decisions.md`'s summary still said D1–D38.

**Filed, not fixed:** three todos — `DELETE /profiles/:id` never cancelling the
compiles it orphans (the root cause of one of brief 44's findings), a swallowed
`setLatexCompileStatus` failure that can wedge an account until restart, and
`BibliographyBlock.widestLabel` being parsed and never used.

**Not verified by eye:** brief 39's "check a paper-shaped document in brief 38's
preview" criterion — no browser run this session.

**Open for the owner:** brief 40 needs a **34.3 MB** `mathjax-full@3.2.2`
(Apache-2.0, server-side only) — not added, awaiting a yes. Brief 43 is held
until there is a real count of coverless videos surviving 42's backfill.

## [2026-08-27] build | Brief 38 shipped — LaTeX in Atrium

10 chunks (6 senior, 4 junior), 6 waves, 3 scoped finders, 2 fix rounds.
~6,600 lines of new source. **Typecheck 0, build 0, 332/332.** Verified live in
a browser against the real database; every test artifact removed afterwards and
the library ended exactly as it started — 5 books, 9 files, 7 thumbnails.

**The whole loop works on real data.** A project compiles with our own engine —
no TeX, no binary — the PDF previews beside the source, diagnostics carry file
and line and clicking one moves the caret, and three publishes produced **one**
library card with versions 3/2/1 and a cover extracted from page 1 of our own
output.

**The brief was wrong about one thing and it was caught before dispatch.** Step
6 said to point `books.file_path` at the newest version's PDF; brief 41 had
dropped that column hours earlier. Publish now writes to the *derived* library
path instead, and `document_versions` was created without the two path columns
the brief's DDL listed — reintroducing stored paths in a new table would have
undone D39 on its first day. Both corrections dated in the brief.

**Fifth build running: every serious defect crossed chunk boundaries, and none
tripped a gate.** Three finders returned 13 findings (3 Critical, 6 Important):

- The compile preview mounts a second `PdfReader` against the **shared reader
  store**, so scrolling it — then losing a 1.2 s race with the next book's
  download — overwrote that book's saved position. The same bug class brief 35
  already shipped and fixed once.
- The editor's file-text cache was `staleTime: Infinity` and writes never
  updated it, so switching files and back **reverted a saved edit** and the next
  keystroke PUT the stale version over it.
- `flush()` was fire-and-forget, so compile and publish could run against the
  previous autosave — despite the code asserting "flush() FIRST, always". For
  publish, those stale bytes become a permanent version.
- Publish read `published_book_id` from a snapshot taken **before** the compile,
  so two racing publishes could each create a card — the exact thing decision 8
  exists to prevent.
- A leaked job-map entry would have wedged compilation **account-wide with no
  reaper** if the status write threw between claiming and scheduling.
- The size cap was bypassable past 32 directories deep, and the same truncation
  **silently dropped those files from a published version's zip** — defeating
  the one reason the zip exists.

Both fix rounds worked to the right standard: reproduce the failure against a
pre-fix variant first, then show it gone. Not assertions.

**A diagnostic code was borrowed for the third time, and caught for the third
time.** A wall-clock stop was reporting `budget-exceeded`, which means the
*deterministic* step budget — the same document stopping in the same place,
which is what makes it testable. A wall clock stops somewhere different every
run. Added `stopped`; conflating them tells a writer to go simplify a document
that was never too complex.

**Decided during the build:** deleting the entrypoint is refused (409) rather
than silently repointed or left dangling; a published document's `source` is
`latex`, not `upload`; the monospace source pane is a recorded, bounded
exception to the two-family type rule.

**Deferred deliberately, now [brief 44](briefs/done/44-compile-worker-thread.md):**
`compile()` is synchronous and blocks the API process. Fine at ~80 ms, but it
means a cancel cannot reach a *running* compile and a compile on one device
stalls another — which sits badly with D36's premise. Briefs 39 and 40 make
compiles longer, so 44 should land before 40.

## [2026-08-27] build | Brief 41 shipped — derived storage paths, and a sandbox that works

4 chunks (3 senior, 1 junior), 3 waves, 3 scoped finders, 1 fix round.
Typecheck 0, build 0, **332/332 tests**. The owner's database is byte-identical;
it migrates on the next real boot.

**The capability this brief created got used on itself.** Every destructive
check ran against a copy with all three storage roots redirected — which is
precisely what was impossible before, and precisely how a book was destroyed on
2026-08-25. Chunk 1 (the overrides) was gated on my own proof, not the agent's
claim, before anything else was allowed to run.

**The review's best finding was against the brief, not the code.** Brief 41
asserted that deriving paths is "a *repair* for rows from an old checkout". That
is an assumption. For a row whose stored path disagrees with the derivation, the
stored path is the **only surviving record of where those bytes are** — and the
migration dropped it unread. The finder's framing carried it: this repo's other
destructive migration, `migrateToProfileScope`, verifies row counts and rolls
back, and this one had no verification step at all. The migration now reads both
columns first and warns, naming every drifted row and its old location. Proven
by seeding one drifted row into a copy of the real DB: one drift line, four
healthy rows correctly silent.

**A latent type hole worth the fix.** `coverOwnerId` declared `converted_from?:`
optional, so the wire-shaped `LibraryBook` — which spells the link
`convertedFrom` — satisfied it structurally and resolved to the conversion's own
id: a cover that never loads on read, the wrong file unlinked on delete. No live
call site, but the optionality had disabled the type system on the single most
expensive mistake in the change.

**Discovered, unrelated:** the real database is **pre-brief-34** (no
`converted_from`) while `reading_progress` is already profile-scoped — so brief
35's migration was applied directly during that build, and the API has not booted
with brief 34's code since. Convert has never run against the real library. The
next boot runs brief 34's column additions and brief 41's drop together; that
combined path was tested and converges.

**Deleted, not replaced:** `reconcileMissingCovers`, `clearCoverPath`,
`listBooksWithCover`, `clearBookCover` and the boot reconcile. They existed to
repair DB/disk drift; making the disk authoritative stops the drift being
representable, so the repair has nothing to repair. That is the shape worth
repeating — the best outcome of a correctness fix is machinery you get to delete.

**Accepted, not fixed:** one `existsSync` per book per `GET /library`, and a
converted pair paying two stats for one shared file. Priced in by D39. A finder
filed it anyway because it was deliberately not told the cost was already
decided — which is the right way to test whether a priced cost still looks
defensible from outside.

## [2026-08-27] grill | Every open question closed — D39, D40, briefs 41-43

Seven questions, one at a time, at the owner's request. The whole of
`open-questions.md` is now decided; nothing is built yet.

**The three long-running threads turned out to be one bug.** `progress`/`fraction`
was cosmetic, but the other two — dead rows after a checkout move (open since
2026-07-07) and the untestable file directories (2026-08-25) — share a single
cause: **the API persisted absolute paths while two of its three storage roots
could not be redirected**. That is why pointing a test at a copied database
still reached the real files, and why brief 34's verification destroyed a book.
Both halves are fixed together in brief 41 (D39): all three roots become
overrides, and paths derive from `id` + `format`.

**Two findings made the fix much cheaper than it looked.** Every *write* already
derives its path — `filePathFor` / `coverPathFor` are what uploads, catalog
downloads and conversions all call — so the stored column was a cache of a pure
function whose only capability was to disagree. And cover *ownership* was already
encoded: D34's `converted_from` is exactly the "whose thumbnail is this" relation,
so the derivation needed **no new column**. That let the decision go further than
planned: `cover_path` is dropped and `hasCover` becomes a disk check, so the DB
cannot drift from disk — which **deletes `reconcileMissingCovers` and
`clearCoverPath`**, machinery written to repair a drift that stops being
representable.

**A question answered by fact rather than by decision.** video-covers listed a
trust boundary on `POST /library/:id/cover` as an open call. `books` has no
`user_id` — the library is install-wide, only progress and notes are scoped
(D35) — so setting a cover is strictly *less* privileged than the delete route
already unscoped. There was nothing to decide. Recorded in D40 so it is not
re-asked.

**And a decision that was narrower than its record.** Brief 23 reads as *no video
covers, ever*. What was actually declined was the **ffmpeg binary**; frame
extraction was just the only route on the table. mp4/webm are accepted formats
*because the browser decodes them* (D12), so the browser does the capture and the
declined dependency stays declined. Capture runs at upload **and** as a playback
backfill — not redundancy: the backfill is what covers the existing library, and
it is the iOS Safari fallback.

**Corpus corrections found while checking claims:** open-questions.md said the
offline store was "already at v2" — it is at **v4**, and its v3→v4 upgrade had
already rewritten every progress record successfully, which is what made the v5
rename a known shape rather than a new risk. The video-covers todo said the
coverless video tile is "identical to the book one" — brief 25 gave each kind its
own glyph and D33 its own tint; what is actually identical is every video tile to
every *other* video tile, which is a different (and smaller) problem, now brief 43.

Briefs written: **41** (storage, gates 38), **42** (video covers, needs 41), **43**
(coverless tile readability, needs 42). Build order: 41 → 38.

## [2026-08-26] build | Brief 37 shipped — Atrium's own typesetting engine (D38)

`compile()` takes a `.tex` file map and returns a PDF. Ours, in TypeScript, no
TeX involved. **10,708 lines of engine, 5,335 of tests, 332 tests green** — and
the repo's first test suite, because a typesetting engine without golden tests
is unmaintainable: every layout change silently moves every line on every page.
Built via plan-split-dispatch: 9 chunks, 5 waves, then 3 scoped finders and 2
fix rounds. Verified by rendering pages and looking at them, not only by golden.

**Purity replaced sandboxing.** Brief 36 spent a section on confining Tectonic.
A pure no-I/O function *deletes* that problem: no shell escape is written, so
`\write18` cannot exist; `\input` resolves against an in-memory map, so
`/etc/passwd` has nothing to reach. A deterministic step budget replaces the
wall clock — reproducible where a timer is not.

**The brief named `pdfkit` and it was wrong.** Measured before dispatching: it
`readFileSync`s its bundled `Helvetica.cjs` during *document construction*, even
when only a custom font is embedded. That would have put filesystem access
inside `src/` and closed the browser path. Switched to `pdf-lib`, which does
zero filesystem calls. **Briefs 39 and 40 were written naming pdfkit too and
have been corrected in place** — an unstarted brief carrying a disproven
dependency is a trap, not a record.

**Two upstream bugs found and fixed rather than worked around.**
`@pdf-lib/fontkit` writes `cff.length` into the CFF header's `offSize` byte — 6
for every Latin Modern face, where the spec allows 1–4 — which made poppler
render **every page in a substitute typeface**. Silent, catastrophic, and
invisible to any layout test. `@unified-latex` parses a CRLF as a paragraph
break and drops position data on boundary whitespace inside macro-gathered
arguments; both fixes are exact rather than approximate.

**Seven bugs came from attacking the engine, none from the gates.** The worst:
`\label` inside a `\section{}` title made `\pageref` print the table of
contents' page — three chunks each correct alone, sharing one `Inline[]` between
a heading and its ToC entry. And `\begin{equation}` reported
`undefined-environment` ("not a thing") instead of `unsupported` ("not yet"),
while stuffing a non-string into a field the shared schema validates at brief
38's API boundary — it would have surfaced as a serialization failure in a
different package entirely.

**The recurring lesson, now three briefs running (34, 35, 37): every serious
finding spanned files owned by different chunks, and none tripped the gates.**
Per-chunk verification was honest and still insufficient, because each chunk was
right about its own half. Two of this brief's findings were defects in the
controller's *own* fix — latching "already reported" on a diagnostic code that
two unrelated failures also used, which could swallow a genuine budget
exhaustion and truncate a document silently. Budget the scoped review on 39 and
40 accordingly; it is not optional.

**Left knowingly:** footnotes never split across pages (a too-tall note now
reports rather than overflowing silently), `\raggedbottom` is hard-coded, ToC
dot leaders fall back to `\hfil` when an entry wraps, and `geometry` validates
paper but not text dimensions.

New `wiki/typeset.md`. Brief 38 (the editor) is unblocked and next.

## [2026-08-26] decision | Atrium will write its own typesetting engine (D38, brief 37)

**D37's engine clause is revised before a line of brief 36 was built.** The
owner walked the engine question from Tectonic → SwiftLaTeX → "why an external
engine at all", and the answer landed on **our own TypeScript library**
(`packages/typeset`, brief 37). Nothing else in D37 moves: drafts, publishing,
versions and the editor stand exactly as grilled.

**What the research actually turned up**, since it is what makes the decision
defensible rather than romantic:

- **SwiftLaTeX cannot compile at all today.** It fetches every class and font
  from a package server; `texlive.swiftlatex.com` has **no DNS record** and
  `texlive2.swiftlatex.com` returned **HTTP 522 on 4/4 attempts**. The engine is
  local, the package tree never was — which also corrects the claim that it buys
  offline compilation.
- **The scale of real TeX, measured not guessed:** `tex.web` is **25,010 lines**
  of literate Pascal; the LaTeX kernel is **79 `.dtx` files, 4.81 MB**, before
  `article.cls`. **Typst's team looked at reimplementing TeX and designed a new
  language instead** — the single most useful data point on the question.
- **WASM turned out to be unnecessary.** It was only ever needed to run someone
  else's C. Writing it ourselves, TypeScript runs in Node *and* the browser with
  no toolchain and no artifact — so the owner's "no second language" constraint
  made the design simpler, not weaker.
- **The JS stack is well supplied:** `@unified-latex` (AST, maintained),
  `fontkit` (47M/mo), `pdfkit` (24M/mo), `hypher`, `mathjax-full`. We borrow
  glyphs and PDF bytes; we write the engine.

**Two consequences worth remembering.** First, a **pure no-I/O function deletes
D37's sandboxing spec** rather than implementing it — `\write18` cannot execute
because we never write a shell escape, and `\input{/etc/passwd}` has no
filesystem to reach. A deterministic step budget replaces the wall clock.
Second, brief 37 brings the repo's **first test suite** (golden layout dumps,
not PDF bytes), because a typesetting engine without them is unmaintainable.

**The load-bearing caveat:** this is a LaTeX *subset* — syntax, not semantics.
It is defensible only because brief 36 decision 4 already established the owner
has nothing to import. If a legacy `.tex` corpus ever appears, D38 is the first
thing to revisit.

**Brief 36 is superseded; the work is re-planned as four briefs.** The engine
turned out to be too big to sit inside the editor brief, so it was split along
the lines that ship independently — and the order was chosen so a usable product
arrives second, not last:

| | | |
|---|---|---|
| **37** | Engine: foundation | test harness, prose, structure. Proves or kills the architecture |
| **38** | LaTeX editor | projects, compile, publish, versions — **end-to-end usable** |
| **39** | Engine: figures, tables, bibliography | |
| **40** | Engine: math | MathJax SVG + our own SVG→PDF emitter |

The reorder is the point: after **37** the engine can set a written report, so
**38** delivers something the owner can actually use, and **39**/**40** then
improve documents underneath a UI that already exists and needs no further work.
39 and 40 are independent — **swap them if most of what gets written is math.**

Brief 36's editor design was owner-confirmed over three grill rounds and is
carried into 38 unchanged; only the engine moved. 36 is kept in `superseded/`
because it records the Tectonic reasoning D38 had to answer.

## [2026-08-26] build | Brief 34 shipped — Convert (D34)

A PDF now offers a reflowable EPUB twin and an EPUB offers a PDF. A **converted
book** is its own `books` row linked to its **source book**, hidden from the
grid, so there is one card per book and each format keeps its own resume
position. Built via orchestrate → plan-split-dispatch: 6 chunks, 3 waves, 2
senior / 4 junior.

**The architecture paid for itself.** Linked rows made per-format resume, "which
format did I last use", and "no reader changes" all fall out for free — the
readers open a book id, as they always have. The whole cost is one
`WHERE converted_from IS NULL` on three list statements, which search, chips,
grouping and counts inherit because they run client-side over that list.

**D1 is revised, not overturned.** Its reason — "conversion discards reflow" —
was direction-specific and *inverts* for PDF→EPUB, which adds reflow. It was
right when only one direction existed. D15's 60s synchronous cap is revised
too; its 50MB limit and "no queue" stand.

**Review: 7 findings, 1 Critical, all fixed but two Minor.** The Critical was
reported by **two finders independently**, and is the run's lesson: deleting a
book never cancelled its running conversion, so the job runner kept its
single-flight slot claimed for a row that no longer existed — refusing every
other conversion in the app with a 409 naming the deleted book, unreleasable
because the cancel route resolves `getBook(id)` first and 404s once the row is
gone. Every component was individually correct. Nothing told the runner the book
was gone. Integration defects live in the gaps between correct pieces, which is
exactly what per-chunk verification cannot see.

Three more worth keeping:
- A cancel landing during the quality gate was ignored and the conversion
  committed anyway — the `cancelled` flag was read once, then two more awaits
  ran before the commit. A single early check is how that invariant rotted.
- A process death orphaned the output forever, because the converted book's id
  was a `randomUUID` living only in-process. Naming the in-progress file from
  the **source** row makes the leftover addressable, so a boot sweep can delete
  exactly it rather than hunting unreferenced files near real library data.
- Reading a converted twin never moved the library card: progress is recorded
  against the row you opened, and that row is hidden from the list. The card
  stands for the book now.

**A perf trap worth remembering:** mounting the convert control by importing it
from the route cost **+41 kB gzip** on the entry chunk — it dragged reader
chrome out of the lazy reader bundle and undid brief 15's code-splitting.
Passing the row down as *data* instead keeps it in the reader chunk; final cost
+1.15 kB. A typecheck never catches this and a reviewer rarely thinks to measure
it.

**An incident.** During verification an agent ran the whole-book-delete route
against a pre-existing row and **permanently destroyed one of the owner's
books**. `LIBRARY_DATA_DIR` redirects only the database, so a copied DB still
carries absolute paths into the real, gitignored file directories. It was
recovered only because an orphaned byte-identical duplicate happened to be on
disk — luck, not a safety net. `config.ts` now warns at the definition,
[wiki/open-questions.md](wiki/open-questions.md) records the real fix (make the
file directories overridable too), and a manual backup now lives outside the
repo. The practice, stated plainly: to test a destructive path, upload a
throwaway fixture and act on that — never on a row that was already there.

**Not verified:** this machine's Calibre has an `lxml`/`html5-parser` ABI
mismatch, so anything with an outline fails to convert. A clean 21-page PDF→EPUB
ran in 2.0s with `--enable-heuristics` confirmed on the spawned command line,
but the two-column and scanned-PDF readability judgements await a working
install.

`wiki/status.md` passed the 200-line rule and split: the dashboard keeps the
current snapshot and the briefs table, [wiki/status-history.md](wiki/status-history.md)
takes the archive.

See [briefs/done/34-convert.md](briefs/done/34-convert.md), D34, and
[wiki/conversion.md](wiki/conversion.md) (rewritten — every claim on the old
page was false).

## [2026-08-25] build | Brief 35 shipped — profiles (D35)

An account became a household and a **profile** a person in it. Reading
progress, notes and four reading preferences moved from user scope to profile
scope; switching is one tap with no credential (D35 — a profile is an identity
boundary and explicitly never a security one).

Built via orchestrate → plan-split-dispatch: 7 chunks in 3 waves, 3 senior /
4 junior. Wave 2 was interrupted twice by session quota mid-verification and
resumed from disk state rather than re-dispatched cold.

**The migration.** `reading_progress` is keyed on a composite PK, which SQLite
cannot ALTER, so both it and `notes` needed a create-copy-drop-rename rebuild
on a database holding real reading positions. It ran inside one transaction
with row-count assertions that throw rather than log; proven by injecting an
orphan row and watching the whole thing roll back, leaving the original schema
and all 9 rows untouched. The live DB was backed up first and never opened for
writing — every test ran against a WAL-consistent copy.

**Review: 10 findings, 3 Critical, all fixed but one Minor.** The pattern worth
keeping: *every Critical spanned files owned by different chunks, and none
tripped typecheck or build.* Per-chunk verification was honest and still
insufficient, because each chunk was right about its own half.
- A switch cleared the query cache but not the reader store, so the next
  profile inherited the previous one's resume position — and `use-progress-sync`
  wrote it back to *their* row. Progress invented on a book they never opened,
  fully online, no offline involved.
- An offline boot with the picker due hung on "Loading…" forever: the gate
  blocked on an empty profile list that nothing behind it could fetch. Fixed by
  caching the profile list on the device, so decision 6 survives with no
  connectivity.
- The preferences boot cache's legacy fallback was unreachable on precisely the
  load it was written for — `ebook-reader.profile` is new in this brief, so
  every existing device boots once with no profile id, and the `!profileId`
  guard returned `{}` before the fallback could answer.
- Offline progress was keyed by book alone, so a second profile's write
  destroyed the first's un-synced position permanently. Now keyed per
  (profile, book) at DB v4, migrated by pure copy.

**A verification lesson.** Chunk 5 proved "no theme flash" by aborting the
fetch and watching `data-theme` hold steady — genuinely good evidence, and
still wrong, because it tested with the profile key already populated. The
scenario that mattered was the one boot where that key does not exist yet. A
proof is only as good as the state it starts from.

**Deviations from the brief, all recorded in the brief's outcome:** the default
profile cannot be deleted; `notes.profile_id` is RESTRICT not CASCADE;
`GET /profiles/:id/preferences` added; `updateProgressSchema` gained an optional
`profileId` because step 7's requirement was otherwise impossible to satisfy.

**Corpus drift found and fixed:** `performance.md`'s headline "123 kB gzip
entry" is a brief-15 number never re-taken across briefs 19–33. A build at the
commit before this brief measures **195.76 kB**. Brief 35 itself costs +4.90 kB
gzip, measured by building both trees rather than guessing.

See [briefs/done/35-profiles.md](briefs/done/35-profiles.md), D35, and
[wiki/architecture.md](wiki/architecture.md).

## [2026-08-24] grill+todo | Brief 36 (LaTeX) grilled and rewritten — D36, D37

Three rounds. **Why it belongs here** reframed the product: owner said LaTeX is in
Atrium *"for the same thing as notes… like a personal cloud space"* — so D32's
"media gallery + Notes" framing is superseded by **D36: your stuff, reachable
from anywhere**, media you collect plus documents you author. Notes was the first
thing that didn't fit "gallery"; LaTeX is the second, and two is a pattern.
PRODUCT.md gets rewritten in the brief rather than drifting a third time.

**D37** settles the rest. Engine is **server-side Tectonic**, decided by two
answers — light phone edits (not authoring) and online-only — which removed every
reason to run TeX in the browser: SwiftLaTeX/WASM buys offline compile nobody
asked for, at multiples of the entire 3 MB shell, on the phone, against briefs
15–17's payload work (the app's whole initial JS is 123 kB gz). Sandboxing is
spec: shell escape explicitly off, paths confined, short wall-clock timeout,
capped output. **Draft vs published** is the spine: a draft lives only in
`/latex` and never appears in the gallery; publishing creates **one** library
entry that accumulates **versions**, each storing its PDF *and a zip of the whole
project* so it can be rebuilt. `books.file_path` tracks the newest version so the
file route, offline download and reader work unchanged. v1 is deliberately three
features; autocomplete, SyncTeX, collaboration and templates are out. Editor is
CodeMirror 6 (Monaco is ~10× the entry chunk for one destination).

Three findings made the design cheaper: `PdfReader` takes a **`File`**, so the
whole preview half already exists unmodified; brief 34's job runner is the
compile machine; Notes established the per-profile authored-content pattern.

**Glossary split.** Adding the LaTeX terms pushed `glossary.md` past the 200-line
rule, so it split along D36's own line — collected vocabulary stays in
[glossary.md](wiki/glossary.md), authored vocabulary (Notes + LaTeX) moves to
[glossary-authoring.md](wiki/glossary-authoring.md), cross-linked. Same authority,
two pages.

Order: **35 → 34 → 36**. See [briefs/superseded/36-latex-editor.md](briefs/superseded/36-latex-editor.md).

## [2026-08-24] grill+todo | Briefs 34 + 35 grilled and rewritten; brief 36 (LaTeX) filed

**Grill (five rounds, owner)** reshaped both briefs and produced **D34** and
**D35**.

*Brief 34 — Convert.* The architecture changed on the owner's call: a converted
book is **its own linked `books` row** (`converted_from`), not a sibling file on
the source's row — which makes per-format resume positions and "which format did
I last use" fall out of existing `reading_progress` rows for free, needs no
variant param in the reader, and decouples the brief from 35 entirely. Cost is
one FK plus a `WHERE` on three list statements; search being client-side means
search/chips/grouping/counts inherit the hiding, so one book stays one card.
Owner defined **Convert** as either direction and asked for both to be built, so
the stateless `/convert` export retires and the EPUB reader's Download-as-PDF is
reimplemented on top of library conversion — no capability lost. Async job with a
**24h** ceiling, cancellable, one at a time per account, reaped to `failed` on
restart; flat 30s polling **driven by row status, not a client flag**, which is
what makes "start it, refresh, return hours later" behave identically. Renamed
`34-pdf-reflow.md` → [`34-convert.md`](briefs/done/34-convert.md).

*Brief 35 — Profiles.* Owner's framing — *"an account is like a household,
profiles are for different persons from the household, they can change freely"* —
settled the shape: shared library, free switching, identity boundary and
explicitly **not** a security one. Preferences move **server-side** into a JSON
blob on the profile row (theme, font settings, page mode, TOC sidebar), revising
D9; found in passing that **font settings are not persisted at all today**
(`setFontSettings` writes only to Zustand), so this makes them durable for the
first time. Picker returns after **24h** idle, device-side — the fix for
`sessions` having no expiry, which would otherwise let a household tablet
attribute everyone's reading to whoever used it last.

*Brief 36 — LaTeX* ([36-latex-editor.md](briefs/superseded/36-latex-editor.md)),
**ungrilled**, filed on request. Three things fall out for free: `PdfReader`
takes a `File`, so the preview pane needs **no changes**; brief 34's job runner
is the compile machine; Notes established the per-profile authored-content
pattern D33 keeps out of the media grid. Engine recommendation is **server-side
Tectonic** over SwiftLaTeX WASM (single ~75MB binary with on-demand packages, D5
precedent, and no TeX engine shipped to a phone against briefs 15–17's payload
work). Brief treats TeX as the code-execution engine it is: shell escape
explicitly off, every project path confined, hard wall-clock timeout. Six open
questions listed for a grill, including whether the feature belongs in Atrium at
all.

Also corrected `status.md` (21/22 shown as todo though both are in `done/`;
27–33 missing entirely).

## [2026-08-24] todo | Brief 35 filed — Profiles: several readers behind one account

Owner asked for Netflix-style profiles and framed it mid-brief: **an account is a
household, a profile is a person in it, and switching is free**. That framing
settles the feature's two usual questions — the library stays shared (a household
shares its shelves), and free switching makes a profile an **identity** boundary,
explicitly not a security one (recorded so nobody later mistakes it for a
permission; housemates needing real separation are a second account). The brief
answers the "isn't this just more users?" objection head-on: D30 already gives
multi-account + shared library + per-user progress, so the whole delta is
friction — one tap vs. a password, a button vs. `scripts/seed.ts` over SSH.
Blast radius verified as exactly two tables (`reading_progress`, `notes`), ~10
prepared statements and four route sites; the session carries the active profile
(`sessions.active_profile_id`) so nothing about request authentication changes.
Three client-side traps flagged as data bugs rather than polish: identity-free
query keys, the offline pending-progress queue re-attributing reads after a
switch, and globally-keyed reader prefs. Migration is the risk — SQLite cannot
ALTER a composite PK, so `reading_progress` needs a create-copy-drop-rename
rebuild with row-count verification. Amends D30/D31. Filed as
[briefs/done/35-profiles.md](briefs/done/35-profiles.md).

## [2026-08-24] todo | Brief 34 filed — Convert: the same book in either format

Owner asked for PDF→EPUB conversion with "show EPUB" / "show original" on PDF
books. Research finding that shapes the brief: `runEbookConvert`
([calibre.ts](../apps/api/src/calibre.ts)) is **already format-agnostic** —
Calibre infers both formats from the extensions, so `in.pdf → out.epub` needs no
change to the spawn wrapper; and `filePathFor(id, format)` already yields a
free, non-colliding `library/<id>.epub` beside the PDF. What is *not* reusable is
`/convert` itself — it is stateless (upload → temp workspace → download →
delete), the exact opposite of a persisted library-attached sibling. **D1 is not
a blocker:** its rationale ("conversion discards reflow") is direction-specific
and inverts for PDF→EPUB, which *adds* reflow; only its flat "never a reading
path" clause needs amending. Calibre's manual calls PDF *"a really, really bad
format to use as input"* (multi-column interleaves, headers/footers pollute the
body, no OCR), so the brief makes reflow opt-in, disposable, and quality-gated,
with "show original" as the designed safety net rather than a convenience. Three
decisions marked **[CONFIRM]** (async 202 + poll, per-variant locator, the
"reflow" vs "convert" naming split). Filed as
[briefs/done/34-convert.md](briefs/done/34-convert.md). Also corrected
`status.md`, which still showed briefs 21/22 as todo and was missing 27–33.

## [2026-08-24] capture | Video covers todo filed — capture a frame client-side

Owner asked for better covers on media files. Investigated: video is the only
kind with no real cover, and brief 23's blocker was the **ffmpeg binary
dependency**, not the feature — everything downstream of the frame
(`toJpegThumbnail` geometry, D25 disk storage, the cover route, `hasCover`, the
SW cover cache, the missing-file reconcile) is already kind-agnostic. Proposed
route needs no server binary: the browser already decodes mp4/webm (that is why
they are accepted formats), so capture the frame there — `<video>` → seek →
canvas → `POST /library/:id/cover`, with a variance-scored pick across ~3
candidate timestamps and a player-side backfill for existing items. Two gates
also hide any cover that does exist: the `format === "mp3"` guard around the
embedded-picture branch (mp4 `covr` is parsed and discarded) and `CoverArt`'s
`kind !== "video"`. Filed as [todos/video-covers.md](todos/video-covers.md);
iOS Safari canvas behavior, the cover-route trust boundary, and whether this
warrants a decisions.md entry are left for the promote-time grill.

## [2026-08-24] done | Briefs 27–33 — the Reading Room rework shipped

Built via `plan-split-dispatch` in four waves on branch `reading-room-rework`,
one commit per brief, then a three-finder review pass and two fix rounds.
Wave plan: `27 → 28‖32 → 29‖33 → 31‖30`. **Not merged — owner controls git.**

**What shipped.** 27 tokens + the Newsreader/Archivo type stack + motion
primitives; 28 one home with kind as a filter chip (reversing brief 25's
per-type routes, kept as redirects) and the Shelves ⇄ Stacks UI removed; 32 the
reader at a 620px measure with the rail's drag preview on an anime.js timeline;
29 tinted tiles, badges dropped, the Continue strip in time-remaining, the
dropzone confined to the empty state; 33 Notes as its own destination; 31 a
player dock that survives navigation; 30 cross-library search. Per-brief
outcomes are appended to each brief in `briefs/done/`.

**Review found 14 findings, all fixed.** Two Critical: a new video inherited the
*previous* track's position (the handoff seed read the store during render,
before the load effect swapped the item), and the wordmark rendered in synthetic
bold (Newsreader 700 requested, only 400/500/600 self-hosted). Nine Important,
the sharpest being: the dock covered the reader's progress rail — its only
scrub control — because `fixed` readers ignore the shell's padding; the search
field ate a typed trailing space, so `the ` + `hobbit` became `thehobbit` and
matched nothing; and bold text inside EPUBs synthesised because the injected
iframe `@font-face` set registered weight 400 only, where the browser's own
serif had previously supplied a real bold cut.

**Gates were typecheck + build only — this repo has no test suite.** That is why
the review pass carried so much weight, and it is the single biggest reason to
be cautious about this branch. Three scoped finders (one opus on integration,
two sonnet on conformance and dead code) caught things no single generalist pass
would have; the parallel-lane build made seam bugs the dominant failure mode,
exactly as expected.

### Rulings
- [wave 2] first attempt died on a session quota mid-flight; only `router.tsx`
  had been written (brief 28, partial but correct) — kept, not discarded.
- [waves] batched at 2 agents after that, not 3, to bound what a quota kill loses.
- [brief 32] re-tiered opus → sonnet once the brief enumerated its own traps
  (raster staleness, one-seek-per-drag, D31 locators). It completed DONE with
  live browser verification — the reference-pattern rule working as intended.
- [brief 32] edited `routes/read.tsx`, outside its declared lane but claimed by
  nobody — accepted, because it flagged it rather than hiding it.
- [brief 27] the brief's own acceptance criterion ("payload down") was **wrong**:
  three families → two is still five faces → seven. The real waste was dead
  `.woff` fallbacks in the PWA glob; dropping them gave the reduction.
- [brief 28] `lib/library-prefs.ts` deleted rather than emptied; its two
  localStorage keys are orphaned in existing browsers and logged, not migrated.
- [brief 29] mixed-aspect baseline resolved by normalizing the tile *shell*
  (2:3 single-column, 4:3 across two) rather than accepting staggered captions.
- [brief 30] **controller ruling reversing an earlier instruction of mine**: chip
  counts now follow the active query. As first specified they reported
  whole-library numbers during a search, so a chip could advertise 8 and land on
  "No matches".
- [brief 33] deviation accepted: the notes list is a row list, not the comp's
  master-detail split — an architectural change, deliberately deferred.
- [review] my own check of the sepia `tint-book` collision was against `--paper`
  and passed; the finder compared against `--paper-container` and found ~5 RGB
  units. The finder was right.
- [briefs 25/28 + one todo] links to files brief 28 deleted were converted to
  code spans. Briefs stay immutable as *specs*; a dead link is not spec content.
- [reader.md] was straddling at 205 body lines. Fixed by reducing its "entry:
  library home" section to a pointer — the home is not the reader — rather than
  shaving padding to sneak under the cap.
- [process] agents left orphaned vite/API watchers three separate times. Cleaned
  up each time; worth a standing instruction in future dispatch prompts.

**Known and accepted, not fixed:** the Notes master-detail split; orphaned
`library:groupBy`/`library:groupView` localStorage keys; three unused exports in
`grouping.ts`; closing the dock while the video surface is mounted leaves an
orphaned `<video>`; glyph SVGs duplicated between `PlayerDock` and
`CoverFallback`; `AudioPlayer`'s coverless state shows bare text where the
library tile shows a kind glyph.

`bash corpus/lint.sh` passes. Typecheck + build green at every wave gate.

## [2026-08-24] decision | UI/UX rework locked — "Reading Room" (D33), briefs 27–33 filed

The owner rejected the current surface ("the main idea is good, I just don't like
the UI/UX"). Read the corpus + the shipped components, diagnosed the current home
from the code rather than from the July screenshots (which all predate the
library *and* the rebrand, so they were useless as evidence), then mocked **three
complete directions** as working screens rather than descriptions:

- **A · Reading Room** — Notion-calibrated; borrowed move: tinted content cards.
- **B · Vault** — Spotify-calibrated; borrowed move: content-first darkness.
- **C · Index** — Vercel-calibrated; borrowed move: hairline density, mono as a
  UI voice, with a live ⌘K palette.

Design study: <https://claude.ai/code/artifact/d4f543af-8e05-4a1e-850f-b14c924cf31e>

**Five faults the diagnosis named:** type became navigation (brief 25 promoted a
filter to an address); three rows of chrome before content; the dashed dropzone
squatting on prime real estate forever; a book-shaped design system worn by music
and film; and nothing that searches the library.

**Owner picked A.** Four scope questions were then settled: full sweep *including*
the notes editor; adopt Newsreader + Archivo **fully**; Notes stays its **own
destination**; Shelves ⇄ Stacks grouping is **dropped**. B's persistent player
dock was folded into A — it was the one genuinely new *capability* in the set
rather than paint, and nothing about A prevented it.

**Recorded as D33**, which revises **D27** (Quiet Paper as enforced system) and
D32's "evolved not pivoted" clause. `wiki/design.md` was rewritten end-to-end as
the Reading Room system — warm neutrals, four kind tints, the Newsreader/Archivo
split, a warm dark ground (`#141310`, so cover art stops reading sour), motion
rules, and a new conformance checklist including the **tint test** (strip every
badge; the grid must still read by kind). Full comps for home, reader, notes,
phone and empty state:
<https://claude.ai/code/artifact/3c194acd-f8fd-431b-964e-f74edb85a8d3>

**Vocabulary moved with it** (`glossary.md`): *Area* retired — kind is a filter
again, so **Chip**, **Tint** and **Dock** are the new terms; *Quiet Paper* →
**Reading Room**; *Shelves / Stacks* kept only as a retired-name entry so old
briefs stay readable. Also fixed a naming drift this surfaced: `globals.css` has
called the system "Quiet Gallery" since the rebrand while `design.md` still said
"Quiet Paper" — both names now retire together.

**Briefs 27–33 filed in `todo/`** (foundation → IA → surface → search → dock →
reader → notes), with dependencies stated per brief; 27 gates the rest, 32 can
run in parallel with 28–31. Motion idiom is **Motion Primitives**, with
**anime.js** confined to the progress rail; **SmoothUI was evaluated and
rejected** as a near-total overlap — two motion idioms in one app read as two apps.

**Nothing is implemented.** `status.md` says so explicitly, and every other wiki
page still describes the shipped pre-rework app, which is correct until the code
changes. `bash corpus/lint.sh` passes. **Uncommitted — owner controls git.**

## [2026-08-24] maintenance | Corpus synced to personal-skills v0.29.0 conventions

The project moved from personal-skills v0.23.0 to **v0.29.0**; this folds the
skill changes that have a corpus-side artifact into the corpus itself.

**`corpus-flow` §9 (domain modeling) — the headline change.** Added
[wiki/glossary.md](wiki/glossary.md): ~28 project-specific terms across content,
reading state, access, offline, notes and design, each with the `_Avoid_`
synonyms it displaces. Only terms Atrium uses in a particular way — general
programming vocabulary was deliberately left out. Grounded in the shared contract
and the wiki rather than invented, so `kind` vs `format`, `progress` vs
`locator`, and *download* vs *runtime cache* now have one name each.

**Writing the glossary surfaced one real vocabulary drift**, filed in
[wiki/open-questions.md](wiki/open-questions.md): the per-user 0..1 value is
`progress` in the wire contract but `fraction` in the offline IndexedDB record.
Glossary names `progress` canonical; the persisted field was **not** renamed
(that needs an IndexedDB migration past v2 for a cosmetic gain), so the call —
migrate, or record it as a deliberate boundary translation — is left open rather
than silently settled.

**`decisions.md`** gained the v0.29.0 recording bar (hard to reverse · surprising
without context · a genuine trade-off) and the "record the *why*" rule. Audited
D1–D32 against it: **no undefended entries** — every row already carries its
rationale, so nothing needed reconstructing.

**`CLAUDE.md`** — glossary + decisions added to the layout; two conventions added
(glossary as naming authority, and the decision bar). Also refreshed the stale
**project one-liner**, which still described "a personal ebook reader" three
briefs after D32 made it a media gallery + Notes.

**`routing.md`** — rebuilt against the v0.29.0 `orchestrate` intent table: new
rows for *audit* (`improve`), *design* (`impeccable` / `design-md-library`),
*docs* (`writing-guidelines`, `diagram-design`), *domain* (corpus-flow §9) and
strict review (`thermo-nuclear-review`); the retired `web-research` /
`performance-analysis` routes are gone (research is now inline and gated). Added
the **knowledge-routing table** (§0b), which this corpus never had, and noted
that no `codegraph` project skill is bootstrapped here. READ/SKIP/SKILLS gained a
notes row and routes glossary terms into dispatched chunks.

Corpus headings and the lint header renamed ebook-reader → Atrium. Stale
`performance-analysis` mentions in `log.md` and `briefs/done/18` were **left
alone** — both are immutable historical records. `bash corpus/lint.sh` passes
(11 wiki pages); catalog regenerated. **Uncommitted — owner controls git.**

## [2026-07-20] follow-ups | Cover reconcile + /atrium deploy rename + Notes page templates

Continued the [HANDOFF](HANDOFF.md) — picked up three of its open follow-ups.

**#1 Stale covers (open-questions):** new startup reconcile `reconcileMissingCovers`
in [library-routes.ts](../apps/api/src/library-routes.ts) nulls `cover_path` when
the thumbnail file is gone (stale absolute-path rows from another box), so
`hasCover` reports false and the client renders its fallback tile instead of
firing the doomed cover request that surfaced as `ERR_BLOCKED_BY_ORB`. Fired off
the request path like the metadata backfill; db helpers `listBooksWithCover` /
`clearBookCover` added. The `file_path` half is unchanged (column is NOT NULL).

**#4 Deploy sub-path `/ebook-reader/` → `/atrium/` (D32):** the web app is fully
parameterized on `BASE_PATH` (zero app-code change); the value lives in the
**vps-deploy** repo. Updated `projects/ebook-reader/.env` + `.env.example`
(BASE_PATH, REMOTE_DIR `/var/www/atrium`, PUBLIC_URL, SERVER_DIR `/srv/atrium-api`,
PM2_NAME `atrium-api`), the shared `infrastructure/Caddyfile` client route, and
`deploy.ts` defaults; added a **`teardown`** phase that migrates the old API dir
(preserving the SQLite DB + uploaded library + covers) then removes the old
client dir + pm2 process. localStorage survives (keyed to origin, not path → no
logout); the installed PWA re-scopes to `/atrium/` (re-add to home screen).
**Server cutover not run** (no SSH from the build box): owner runs
`teardown --confirm` then `all`.

**#5 Notes page templates:** blank / ruled / grid page backgrounds (a v1
follow-up from brief 26). New `template` field on `notePageSchema`
(`.default("blank")` → old notes parse cleanly); rendered as an SVG ruling behind
the ink in the scaled viewBox space; per-page selector in the editor toolbar
(undoable). No new deps.

Verified: `@ebook-reader/shared` build, `apps/web` production build + PWA, and
`apps/api` typecheck all clean. **Not live-audited** — the agent-browser /
Chrome-for-Testing path is flaky on this box (see HANDOFF); the template ruling
is deterministic SVG, code-verified only. **Uncommitted — owner controls git.**

## [2026-07-20] build+audit | Atrium rebrand (briefs 24–25) + Notes tab (brief 26)

Promoted the two capture todos into three briefs and built them via orchestrate
(inline — the frontend files are too coupled for subagent-splitting to pay off),
then ran a live 4-breakpoint UI + functionality audit.

**Brief 24 (identity):** wordmark / `<title>` / PWA manifest / README / root
package name / globals.css system header → **Atrium**; arch-mark favicon;
neutral contrast-disc sepia glyph. Internal npm scope `@ebook-reader/*` kept
(documented — renaming = ~40 import churn + native reinstall, zero user value).
**Brief 25 (IA + cards):** `/books` `/music` `/videos` routes (+ `/`→`/books`),
nav tabs, shared `LibraryArea` per kind, retired the in-header type filter;
per-media card shapes (2:3 / square / 16:9) + per-kind fallback glyphs + per-area
grids; Continue strip kind-aware. **Brief 26 (Notes):** shared contract + API
`notes` table/routes (per-user) + `/notes` list & editor with perfect-freehand
vector ink (pen/highlighter/eraser/text, paged, undo/redo, autosave, mobile/
stylus).

**Audit (Playwright, monitor/laptop/tablet/mobile + themes) — PASS.** Caught &
fixed 3 real Notes bugs (tool bar below the fold on desktop; strokes never
committing due to empty `getCoalescedEvents()`; giant-blob ink from
normalized-coord degeneracy) + a redundant empty-area dropzone; hardened
`setPointerCapture`. Verified drawing/erase/text/pages/undo/persist/delete +
per-user isolation; no horizontal overflow at any width; dark theme legible.
Typecheck + build clean across all workspaces. See
[test-plans/TP-06-RESULTS.md](test-plans/TP-06-RESULTS.md) and briefs 24–26 in
`briefs/done/`. **Not exercised:** populated music/video cards + playback (no
sample media on the box) — shape logic code-verified only. **Uncommitted —
owner controls git.**

## [2026-07-20] capture | Notes tab todo filed + rebrand name = Atrium

Owner confirmed the rebrand name is **Atrium** (recorded in the rebrand todo's
Acceptance) and requested a new **Notes** feature: open a note, draw + write,
mobile responsive, Samsung Notes-like. Small inline research (Samsung Notes UX;
perfect-freehand + Pointer Events for vector ink; tldraw/Excalidraw ruled out as
heavy/off-brand). Grilled four decisions: **(1)** content = ink + movable typed
text boxes on a page (not full doc-flow); **(2)** engine = vector ink from
scratch (perfect-freehand, self-hosted); **(3)** storage = per-user server-side
(reuses accounts + D30/D31); **(4)** structure = paged notebook (not infinite
canvas). Captured as [todos/notes-tab.md](todos/notes-tab.md) with an
implementation sketch, the rebrand-nav sequencing dependency, and open questions
(tool set, eraser mode, templates, export, folders, offline). Corpus-only
capture; nothing built. **Uncommitted — owner controls git.**

## [2026-07-20] capture | Rebrand todo filed: ebook-reader → media gallery

Owner asked to switch the app's **name + design** now that briefs 21–23 turned
it into a books+music+video media gallery. Explored the codebase for every
"ebook reader" surface (npm scopes, wordmark, 📖 favicon, PWA manifest,
"Quiet Paper" design system, book-only metaphors, copy) and did a small inline
design-research pass (Plex/Jellyfin per-media card shapes + per-type sections;
2025 multi-media UX best practices). Grilled the owner on four decisions:
**(1)** name direction = warm/curated, media-neutral (exact name still open);
**(2)** design = evolve Quiet Paper, keep the calm, drop book metaphors — not a
Plex-style pivot; **(3)** structure = split into separate Books/Music/Videos
areas (nav, not in-place filter); **(4)** cards = per-media shapes (books 2:3,
music square, video 16:9). Captured as
[todos/rebrand-to-media-gallery.md](todos/rebrand-to-media-gallery.md) — an
epic with a suggested 5-brief split and the exact-name pick as the one blocking
open decision. Nothing built; corpus-only capture. **Uncommitted — owner
controls git.**

## [2026-07-16] design | UI review implementation: hierarchy, conformance, reader immersion

Screenshot-driven UI review (live browser, desktop 1280 + mobile 390, all three
themes, findings cross-checked against wiki/design.md D27 and WCAG 2.2),
published as an artifact, then all three approved tracks implemented.
**Uncommitted — owner controls.**

**Track A — conformance & polish:** new `components/QuietSelect.tsx` (native
select restyled to the design.md bottom-border input; `color-scheme` per theme
in globals.css so UA popups follow dark/sepia) replaces the four unthemed
selects (home Group/Sort, discover Topic/Language). Card titles 2-line-clamp
instead of single-line ellipsis ("The Apot…") in `CoverCard` +
`CatalogResultCard`, with `title=` hover. Lock-screen button: muted
`paper-container` disabled state + Ink-fill pulse while submitting (was
50%-opacity gray). Shelf group counts to full `ink-variant` on a chip (the
70%-opacity value sat below AA at that size); downloads caps label likewise.
EPUB light reading palette retuned to Quiet Paper (`#ffffff→#fcf9f8`,
`#2563eb→#30568b` — the D27 merge change had never reached
`use-epub-theme.ts`). Empty states gained direct actions (Upload an MP3 /
Browse free classics). **Theme is now a persisted preference**
(`ebook-reader:theme`, same pattern as pageMode) — it used to reset to light
on every full load.

**Track B — hierarchy & navigation:** new `components/AppHeader.tsx` (wordmark
home-link / page actions / theme toggle) shared by `/` and `/discover` — the
catalog page previously dropped the shell entirely; it also now calls
`useApplyTheme`. The All/Books/Music/Videos filter + Shelves⇄Stacks toggle
moved out of the header to sit beside "Recent Reads" with Group/Sort (they
scope the shelf, not the app). New `library/ContinueReading.tsx` resume strip
(most recently opened unfinished item within the active type filter — cover,
2-line title, 2px accent progress, whole-card button) leads the page.
`UploadZone` gained a `variant`: **hero** (unchanged full dropzone) only while
the library is empty; otherwise **ambient** — the header's Ink "+ Add to
library" button opens the picker via a `browseRef` handle and a window-level
dragenter raises a full-screen "Drop to add" overlay, so drag-drop capability
survives while upload stops outranking the library. Discover covers render the
typographic `CoverFallback` UNDER the image with a fade-in on load (lazy rows
showed dead gray slabs).

**Track C — reader immersion:** auto-hide chrome REINTRODUCED through the seam
kept for it (`use-auto-hide-chrome.ts`, 3s idle, window activity listeners +
EPUB rendition click/keydown/relocated forwarding, holds via the store's
existing `chromeHoldCount`, toolbar pins while focus is within it, chrome
restored on unmount) — **this reverses the earlier "bars always shown"
decision, per the owner's approval of review finding F7**. `ReaderToolbar`
takes `visible` and regrouped to *navigation | view | position*: TOC + search
moved to the left cluster beside Home (`PdfNavControls`/`EpubNavControls` split
out of the old monolith controls), zoom/settings/mode stay center, page-jump
right. Narrow-bar compaction: "Page" label, Go button, % chip, zoom readout,
and fit-width hide below sm/md so nothing clips at 390px (both were clipping
before — "'age 1 / 21" at 1280, total+Go+% cut off on mobile). EPUB narrow
viewports (≤520px) left-align paragraphs (publisher justify + short lines =
rivers; hyphenation stays on).

**Verified live:** typecheck ×3 clean; desktop light/dark/sepia, discover,
grouped views; mobile 390 home/reader/lock; auto-hide hide+reveal cycle;
go-to-page 120/1020 with real input (an earlier "possible bug" report was a
synthetic-event artifact — the Go button listens on mousedown). Review
artifact: claude.ai/code/artifact/53b5cecf-f076-48df-baef-5ca176d2500e.

**Follow-up 3 (same day — tap zones; supersedes follow-up 2's always-visible
circles on touch):** the floating circles overlapped prose on phones (the
column IS the screen). Researched the convention (Kindle/Books/Kobo: no
persistent nav while reading — invisible tap zones + swipe; and swipe alone
fails WCAG 2.5.1, path-based gestures need a single-pointer alternative),
options artifact claude.ai/code/artifact/ff123472-327d-4d35-b2c0-84fb6057c26c,
owner chose option A. Implemented: `resolveTapZone` in `chrome/swipe.ts`
(outer 30% flips, center toggles); EPUB classifies epub.js-relayed clicks —
`frameElement.getBoundingClientRect().left + clientX` maps the iframe-space
coordinate into the viewport (raw `clientX` spans ALL laid-out columns; the
first cut misread every tap as center) — with link/selection guards and no
overlay elements, so selection is untouched; PDF mirrors it on its content
row. `useChromeToggle` backs the center tap; on coarse pointers the auto-hide
hook stops treating bare taps/moves as "reveal" (a silent page flip must not
pop the toolbar) and `PageNav` circles join the chrome (`pointer-coarse:`
hidden while reading, shown with the toolbar; fine pointers keep them
persistent). Scroll mode: any tap toggles chrome. Verified via touch
emulation: EPUB 118→119→118 and PDF 1→2→1 with chrome staying hidden,
center-tap toggling both ways; typecheck clean.

**Follow-up 2 (same day, owner feedback — mobile page turning):** the paged-
mode flip affordance and touch gestures. ① `PageNav`'s full-height edge bars
(flush to the physical screen edge — unreachable on rounded-corner phones and
colliding with system back gestures) became two floating 44px circular
buttons, vertically centered, translucent (`reader-surface/70` + backdrop
blur so text stays readable underneath) and inset by at least
`env(safe-area-inset-*)`. ② Swipe-to-turn on both readers (paged mode only):
gesture math shared in `chrome/swipe.ts` (≥48px travel, 1.5× horizontal
bias, ≤600ms); EPUB listens on epub.js's relayed `touchstart`/`touchend`
(iframe touches never reach app listeners), PDF on its own content row with a
guard that a zoomed page's horizontal pan never turns pages. ③ Found live
during testing: a rightward swipe with nothing to scroll horizontally
triggered **Chrome's back-navigation overscroll gesture** and yanked the
reader out of the book — fixed with `overscroll-behavior-x: none` on
html/body. ④ Paged PDF turns get a 180ms direction-aware slide-in
(`page-slide-fwd/back` keyframes, motion-safe only); EPUB turns stay instant
(animating transform/opacity on the epub iframe's ancestors caches stale
pixels — the jump-veil comment's constraint). Verified via CDP touch
emulation at 390px: EPUB 118→119→118, PDF 1→2→1, no history hijack;
typecheck clean.

**Follow-up (same day, owner feedback):** the library toolbar controls and
the Discover search. ① `QuietSelect`'s OPEN list is now themed via
`appearance: base-select` + `::picker(select)` (Chromium 135+; Firefox keeps
the color-scheme'd native popup) — paper-raised sheet, hairline border,
paper-container hover/checked fills, accent `::checkmark`; the UA's built-in
`::picker-icon` is hidden (it doubled the component's chevron). Inline select
labels went label-caps to match the segmented controls sharing the row. ② The
All/Books/Music/Videos + Shelves⇄Stacks segments adopt the theme-pill
treatment (`paper-low` container, active segment `paper-raised` + shadow-sm).
③ Discover search: root cause of "search doesn't work" was environmental — a
half-dead API from an interrupted dev-server teardown (a surviving `tsx
watch` supervisor held a broken :3001); one clean instance fixed it, endpoint
verified 200 with results. Two UI hardenings landed anyway: an explicit
Search submit button beside the input (Enter/click commits immediately; the
debounce's `trimmed === q` guard keeps its later tick a no-op), and visible
in-flight feedback ("Searching…" pulse + dimmed held-over grid) since
Gutendex round-trips measured ~7.6 s and `keepPreviousData` otherwise shows a
frozen page.

## [2026-07-16] feature | PWA: installable shell + offline reading (briefs 19–20)

Built via orchestrate → plan-split-dispatch (wave 1 = brief 19 senior; wave 2 =
brief 20 split into a senior core-lib chunk and a junior UI chunk), then a
2-finder scoped review + one senior fix pass, then live browser E2E.
**Uncommitted — owner controls.**

**Brief 19 (shell):** `vite-plugin-pwa@1.3.0`, generateSW, manifest + 4 icon
PNGs, prompt-mode updates (`UpdateToast` via `useRegisterSW`, no
skipWaiting/clientsClaim), precache incl. the pdf.js `.mjs` worker (~3 MB / 34
entries), SWR runtime cache for cover thumbnails only, everything derived from
`BASE_PATH`/`VITE_API_URL` (base normalized to trailing slash; cover pattern
from the URL **origin** to match `coverUrl`'s path-dropping `new URL`).

**Brief 20 (offline reading):** `offline-store.ts` (IndexedDB
`ebook-reader:offline` v2 — `books` metadata / `files` blobs / `progress` local
rows), offline-first open at the `useHydrateBook` seam, `useLibraryList`
cached-rows fallback + `isOffline`, per-cover `OfflineToggle`
(idle/downloading/downloaded/error), offline banner, storage caption,
upload/delete disabled offline, `useReconnectProgressSync` last-write-wins
flush. No convert affordance exists in the library UI (convert is disabled
code in the EPUB reader), so "convert offline state" was N/A.

**Review caught (all fixed):** ① duplicate reconnect PATCHes — unstable
`books` array identity re-fired the flush effect and there was no in-flight
guard; **observed live as 3 identical PATCHes per book**, fixed with memoized
rows + a module-level latch, re-verified at exactly 1. ② single-store IDB
design rewrote/loaded every blob on snapshot refresh/listing (100s of MB with
a few PDFs) → v2 blob/metadata split with a live-exercised v1→v2 migration.
③ resume tiebreak: `snapshotAt` bumped on every refresh could shadow newer
offline progress → only bump on real change + prefer pending local rows.
④ stale `offlineBook` could paint the previous book's title/cover on another
book's opening screen → reset on bookId change. ⑤ icons precached twice →
dropped `includeAssets` overlap (38→34 entries). ⑥ unhandled rejection in the
remove path → error state + invalidate in `finally`.

**E2E (production build via `vite preview` + real API, throwaway seeded user,
removed after):** login → download EPUB (24.6 MB) + PDF → offline reload →
shell from SW, banner, downloaded covers, upload "Requires connection" →
EPUB opens offline, jumps to p.25, offline reload resumes at p.25 (exact CFI)
→ PDF renders offline → reconnect flushes pending progress with a single
PATCH per book → next rebuild surfaced the update toast; Reload activated the
new SW and ran the IDB migration cleanly (both blobs intact). New wiki page:
[wiki/pwa.md](wiki/pwa.md). Typecheck + build clean; no absolute paths in
tracked files (user rule).

## [2026-07-13] change | EPUB scroll mode → continuous manager (+ horizontal-scroll & toolbar-overlap fixes)

Follow-up to the image-collapse fix below, informed by an open-source study of
epub.js/react-reader/foliate-js/Readium/audiobookshelf. Three things shipped:

**1. Scroll mode now uses the continuous manager.** Was `flow: "scrolled-doc"`
(default manager — one isolated section per iframe, no cross-chapter scroll).
Now `manager: "continuous" + flow: "scrolled"`, epub.js's canonical
continuous-scroll pairing (its own `continuous-scrolled.html` example;
react-reader README: "scrolled … works best with 'continuous'"; audiobookshelf
uses the same for manga). Stitches consecutive spine sections into ONE seamless
vertical scroll and preloads the next section off-screen. `EpubReader`:
`flow`/`manager` derived from `isScroll`; `epubOptions={{ flow, manager,
spread:"none" }}`. `key={flow}` remount kept — REQUIRED, epub.js can't swap
managers on a live rendition (#995). Verified live on the 302-page EPUB:
`.epub-container` scrollHeight ~17.6k, 2 section iframes mounted, % tracks
(52→54% on scroll), toggling back to paged restores position + edge bars.

**2. Stray horizontal scrollbar (classic scrollbars).** epub.js's
`.epub-container` scrolls both axes; with classic (space-occupying) scrollbars
the vertical bar shrinks client width while the section view stays full-width →
a few px horizontal overflow → stray horizontal scrollbar (WSL/Linux; invisible
with macOS overlay bars — `scrollbarWidth: 0` in headless, so not reproducible
there). Fix: `globals.css` clips the horizontal axis in scroll mode only —
`[data-reader-flow="scroll"] .epub-container, .epub-view { overflow-x: hidden
!important }` + `overflow-anchor: none` (continuous-manager scroll-jump
mitigation, per audiobookshelf) + `overflow-x: hidden` on `html,body` inside the
iframe (themeRules, scroll-only) to catch fixed-width manga wrappers. Image is
centred/narrower than the column, so nothing visible is cut.

**3. Toolbar overlap with long chapter labels.** The grid bar's right cluster
used `justify-self-end`, which sizes the grid item to its content — a long
chapter label + 3-digit page counter overflowed the track and spilled over the
centre cluster, making the mode-toggle unclickable (`elementFromPoint` = the
label span, not the button). Fix: side tracks `1fr` → `minmax(0,1fr)`, and the
right slot drops `justify-self-end` (defaults to `stretch` → fills its track);
flex `justify-end` right-aligns content, `min-w-0 overflow-hidden` truncates the
chapter label instead of overflowing. Verified at page 159 (chapter label
present): clusters no longer overlap, toggle clickable, label ellipsises.

## [2026-07-13] fix | EPUB scroll mode collapsed image pages to a sliver

Follow-up to the reading-bar change below. User report: "Switch to paged view
doesn't work properly — scroll doesn't appear and it even shrinks." Reproduced
on the real Apothecary Diaries EPUB (a manga, many full-page illustrations): in
scroll mode an **image page collapsed to ~8px** with nothing to scroll (looked
"shrunk"). Root cause is pre-existing but was newly surfaced by the scroll-mode
work: `use-epub-theme.ts` `themeRules` capped `img`/`svg` at **`max-height:
94vh`**. In paged mode that fits a full-page illustration to the single screen;
in `scrolled-doc` `vh` resolves against the section iframe's OWN
(content-driven) height, so it's circular — the iframe starts ~0px → 94vh ≈ 0 →
the image lays out ~0 → the iframe never grows. Proven live: forcing
`max-height:none` on the image grew the body 8px → 1205px.

Fix: `themeRules` takes an `isScroll` flag and **omits the `vh` cap in scroll
mode** (width-capped only, natural aspect, the tall page just scrolls); paged
keeps the cap. `useEpubTheme` subscribes `pageMode` and passes it (added to the
effect deps so a mode flip re-registers the theme with the right rule). The
off-screen page-map `applyStyles` stays paged (default `false`; it's skipped in
scroll mode anyway).

Verified live (real 302-page EPUB, page 4 = illustration): scroll mode iframe
`8px → 1013px`, container `vScroll:true / hScroll:false`, 0 edge bars; toggling
back to paged restores the fit-to-screen illustration + edge bars. Round-trip
paged⇄scroll clean. PDF scroll→paged also re-checked (canvas full size, vertical
scroll present). Typecheck clean.

## [2026-07-13] change | Reading-bar stability + visible page-flip edge bars + scroll-mode axis lock

User report against the floating reader bar: (1) its items shifted as content
changed; (2) scroll mode allowed horizontal scrolling; (3) paged mode had no
visible flip affordance; (4) flips fired from clicking the page body. Fixed
across four files in `apps/web/src/reader`:

- **Bar no longer shifts** — `ReaderToolbar` switched from `flex justify-between`
  to `grid grid-cols-[1fr_auto_1fr]` (left→start, centre→centre, right→end).
  `justify-between` only centres the middle cluster when the two side clusters
  are equal width; ours aren't (Home vs chapter+page+%), so the middle controls
  slid whenever the chapter label or page-digit count changed. The grid pins the
  centre cluster; sides grow into equal side tracks.
- **Visible edge bars** — `PageNav` rewritten from invisible outer-third
  click-zones to two **visible full-height edge bars** (faint `bg-reader-fg/[.03]`
  fill + hairline `border-reader-border/60` inner edge + centred 1.75-stroke
  chevron; `w-9`/`sm:w-12`). Hover deepens; disabled → fades out + non-clickable.
- **Flip only via the bars** — the full-page tap-zones are gone, so clicking the
  page body no longer flips (verified: `elementFromPoint(centre)` = the epub
  iframe / PDF page, not a button). Keyboard arrows kept (`use-page-nav-keys`) —
  user chose "keep keyboard arrows", buttons are the visible primary affordance.
- **No horizontal scroll in scroll mode** — PDF scroll container is
  `overflow-y-auto overflow-x-hidden` and `pageWidth` ignores `zoom` in scroll
  mode (fit-to-column), so a zoomed page can't force a sideways scrollbar. Zoom-
  to-pan stays a paged-mode affordance. EPUB `scrolled-doc` was already clipped
  by the content row's `overflow-hidden`.

Verified live (dev server, `?dev=1` PDF + `?format=epub&dev=1`): typecheck
clean; EPUB paged flip via edge bar works and the centre cluster stayed pinned
as the right cluster grew (`0%`→`100%`); page centre = iframe (no flip on body);
PDF scroll mode after 3 zoom-ins → `scrollWidth == clientWidth`, `overflow-x:
hidden`, zero page-flip buttons, no document horizontal scroll. Conforms to
design.md (theme tokens only, 1.75-stroke icons, soft radii; the toolbar pill
keeps its sanctioned transient-overlay radius). `wiki/reader.md` updated.

## [2026-07-08] decision | Env validated + required at startup (D29, revises D28)

Prompted by a user report: opening the app with empty localStorage never asked
for the platform password. Root cause was working-as-designed — brief 09 (D28)
made `APP_PASSWORD` **opt-in**: unset → API open, no lock screen, only a startup
warning. The dev server was simply running without the var set.

User decided to reverse that: **all `.env` vars are now required and validated
at startup, no defaults** (chose "all vars required" + a single root
`.env.example`). Implemented:
- `apps/api/src/config.ts` rewritten — loads the repo-root `.env` best-effort
  (`process.loadEnvFile`, guarded by `existsSync` so prod can inject via a
  process manager), then validates `PORT`/`HOST`/`APP_PASSWORD`/`MAX_UPLOAD_MB`/
  `CONVERT_TIMEOUT_MS` with a zod schema. Any missing/blank/malformed value →
  clear stderr box + `process.exit(1)`. `APP_PASSWORD` is now typed non-null.
- `apps/web/vite.config.ts` — `envDir` pointed at the repo root (single `.env`
  feeds web too) and throws if `VITE_API_URL` is unset. Dropped the
  `?? "http://localhost:3001"` fallback in `api-client.ts`; `vite-env.d.ts`
  makes `VITE_API_URL` non-optional.
- `apps/api/src/index.ts` — the now-unreachable "API is OPEN" startup warning
  simplified to a confirming log (`isAuthEnabled` kept as defence-in-depth).
- `.env.example` completed (was missing `APP_PASSWORD` + `HOST`); added `zod` to
  `apps/api` deps.

Verified: `node dist/index.js` with `.env` moved aside → exit 1 listing every
missing var; with a valid `.env` → boots + logs "APP_PASSWORD is set". Typecheck
clean ×3. Optional overrides `LIBRARY_DATA_DIR`/`BASE_PATH` stay non-required.
Brief 09 left immutable (records the original opt-in design); D28 clause struck
in decisions.md with a pointer to D29.

## [2026-07-07] done | EPUB accurate book-wide page count (pre-pagination, research option 3)

Replaced the EPUB "Page N/M" counter. It previously used epub.js char-based
`locations` (~1000-char chunks) as the page unit — book-wide but stepped by 2 /
repeated on image pages, and "total" was a chunk count, not pages.

Researched the options (see the summary in-session): per-chapter `displayed`
(resets at boundaries), locations (what we had), and **option 3 — cumulative
per-section rendered-page counts**, the only one that is book-wide + smooth-+1 +
correct-total. Implemented option 3: `reader/epub/epub-page-map.ts` walks every
spine item **on the same rendition the reader uses** (a separate hidden rendition
risks a ±1px width mismatch → boundary jumps, epub.js #274), reads each chapter's
`currentLocation().start.displayed.total`, and builds a prefix sum. Book page =
`offset[section] + displayed.page`. Waits for the column width to settle before
counting (else the total is measured against a transient mount layout and jumps
once). Precompute runs **behind a full loading veil** ("Preparing your book —
counting pages N/M chapters") so the book isn't shown until pages are known;
recomputed (debounced, veil, position preserved) on font size/family/spacing/
margin change and viewport resize. Char `locations` kept for the % rail + seek +
chapter ticks (layout-independent). PDF unchanged (real fixed pages already).

Verified live (Apothecary EPUB): Page 1/242 from the first frame, +1 per turn,
chapter jump to Ch.8 → Page 106/242 (41%). Typecheck ×3 + build clean. Trade-off:
open is slightly slower (one full pre-pagination pass), hidden by the veil.

## [2026-07-07] done | Persistent library + "Quiet Paper" home implemented & verified

Built the feature the decision entry below planned. Three commits: corpus, then
backend, then frontend+integration.

**Backend** (`apps/api`): `better-sqlite3` `books` table + on-disk storage
(`library/<id>.<ext>`, `images/thumbnails/<id>.jpg`, all gitignored). Cover +
metadata extraction (`extract.ts`): EPUB via OPF (EPUB3 cover-image / EPUB2
meta[cover] / first-image fallback, + dc:title/dc:creator); PDF page-1 render
via `pdf-to-img` (bundled pdfjs+canvas, no system deps) → `sharp` 400×600 JPEG.
Routes: POST/GET/`:id/file`/`:id/cover`/PATCH `:id/progress`/DELETE. Shared Zod
`libraryBook` contract. Deps pinned exact (D21).

**Frontend** (`apps/web`): home rebuilt as the library per `wiki/design.md` —
`LibraryHeader` (wordmark + theme toggle), `UploadZone`, `CoverCard` (2:3 cover,
badge, 2px progress bar, typographic fallback, overflow→remove), sort, skeleton,
empty state. `library-api` + React Query hooks; `use-progress-sync` debounced
PATCH. Store gains `loadedBookId`/`progressFraction`. Fonts self-hosted via
`@fontsource` (Playfair Display / Source Serif 4 / Inter — no CDN, D14). Quiet
Paper tokens in `globals.css`, with sepia/dark remaps so the library themes with
the reader.

**Verified live** (Playwright + real arXiv PDF): upload→store+extract, gallery
(real covers + fallback tiles), open→PDF renders, progress persists (page 4/21 →
`progress=0.19`, blue bar on card), delete, sort, light+dark themes. **Bug
found+fixed mid-run:** CORS preflight blocked PATCH (default methods allowlist
omits it) → enumerated methods in `index.ts`. Dark-mode legibility fixed via
theme-variant token remap. Typecheck ×3 + web build clean. See
[test-plans/TP-01-home-upload.md](test-plans/TP-01-home-upload.md).

Not exhaustively verified: sepia theme (spot-checked), EPUB open-to-read with a
real cover-bearing book, refresh-persistence (books persist server-side by
construction; not re-driven in-browser).

## [2026-07-07] decision | Persistent library + "Quiet Paper" design system (reverses D3/D4)

New feature: the home page becomes a **persistent library**. Upload a PDF/EPUB →
it's saved and shows as a **cover card** in a gallery; reopen anytime.

Product-direction change: this **reverses D3** (no persistence) and amends **D4**
(backend was one stateless route). New locked decisions: **D24** persistent
library via SQLite (`better-sqlite3`) in `apps/api`; **D25** thumbnails on disk
(`apps/api/images/thumbnails/`, path in DB) + originals at `apps/api/library/`;
**D26** covers extracted server-side (EPUB OPF cover / PDF page-1 render);
**D27** the merged **[wiki/design.md](wiki/design.md)** ("Quiet Paper") is the
enforced design system. D2 (single-user, no auth) and D9 (reading *position* is
session-only) still hold. Design merged from the Stitch exploration
(`design/stitch_extracted/`) with the existing `--reader-*` reader themes; the
light reading theme's bg/accent were retuned to match the paper surface.
Enforcement wired into [CLAUDE.md](CLAUDE.md). See design.md conformance
checklist. Implementation follows in the next log entries.

## [2026-07-02] decision | Corpus bootstrapped + full spec ingested

Bootstrapped `corpus/` for the ebook-reader project. Folded the finalized spec
from the grill session into the wiki (overview, architecture, decisions, reader,
conversion, status, open-questions). Filed briefs 01–07 covering the full
implementation plan. See [wiki/overview.md](wiki/overview.md).

## [2026-07-02] decision | Tailwind v4 locked (D20)

Resolved the open Tailwind-version question in favor of **Tailwind v4** (matches
Base UI's documented examples). Removed from open-questions; recorded as D20 in
[wiki/decisions.md](wiki/decisions.md). Build to run all waves autonomously.

## [2026-07-02] done | Brief 01 — monorepo scaffold

npm-workspaces monorepo stood up: `@ebook-reader/{web,api,shared}`. React 19 +
Vite 6, Fastify 5 (`tsx watch`, port 3001, `/health`), shared = zod lib. Verified:
`npm install` clean, `npm run typecheck` passes across all three, shared resolves
in both apps. Deferred: gitignored `shared/dist` needs a build before cold-clone
typecheck. See [briefs/done/01-monorepo-scaffold.md](briefs/done/01-monorepo-scaffold.md).

## [2026-07-02] done | Brief 02 — shared Zod contract

`packages/shared` now the source of truth: `detectFileType`, size guards,
`convertRequestSchema` (EPUB-only), `convertErrorSchema` (`{error, code}` union).
Legacy `SUPPORTED_FORMATS`/`Format` preserved for the apps. Typecheck passes.
See [briefs/done/02-shared-zod-contract.md](briefs/done/02-shared-zod-contract.md).

## [2026-07-02] decision | Pin exact dependency versions (D21)

User: all deps pinned exact (no `^`/`~`), latest stable. Retrofitted root +
`packages/shared` to installed versions (concurrently 9.2.3, typescript 5.9.3,
zod 3.25.76). In-flight briefs 03/04 told to pin what they add. Recorded as D21.

## [2026-07-02] done | Brief 03 — backend /convert route

Stateless Fastify `POST /convert` (config/calibre/temp-files/convert-route modules).
Validates via shared schemas, spawns `ebook-convert` with 60s timeout, streams PDF
as attachment, cleans temp in `finally`. Error→HTTP mapping wired to shared
`convertErrorSchema`. Deps pinned (`@fastify/cors 11.2.0`, `@fastify/multipart 10.0.0`),
`fastify` pinned to 5.9.0. Verified except live conversion (Calibre absent on dev box).
See [briefs/done/03-backend-convert-route.md](briefs/done/03-backend-convert-route.md).

## [2026-07-02] done | Brief 04 — frontend shell

Vite+React shell: code-based TanStack Router (`/`, `/read`), Query provider,
Zustand reader store, Tailwind v4 (theme tokens), Base UI Dialog proven, api
client reading `VITE_API_URL`. Base UI package confirmed `@base-ui/react@1.6.0`
(D22). All web deps pinned exact; Node pinned ≥22 / `.nvmrc` 22.23.1 (D23).
Wave 3 complete. See [briefs/done/04-frontend-shell.md](briefs/done/04-frontend-shell.md).

## [2026-07-02] done | Brief 05 — smart uploader + convert flow

`/` dropzone classifies via shared `detectFileType`; PDF → `/read?format=pdf`,
EPUB → Read | Convert fork. Convert `useMutation` → Download + Go back; shared
`convertErrorSchema` mapped to friendly messages. File handed to reader via
additive Zustand `loadedFile`/`loadedFormat`. No deps added. Verified typecheck +
build + live API contract. See [briefs/done/05-uploader-and-convert-flow.md](briefs/done/05-uploader-and-convert-flow.md).

## [2026-07-02] done | Brief 06 — PDF reader + shared chrome (crux)

Format-agnostic shared chrome in `reader/chrome/` with a slot-based
format-adaptive toolbar seam (`formatControls`) for brief 07 to reuse. react-pdf
+ bundled PDF.js worker (Vite `?url`), TextLayer on. PDF TOC only when outline
exists (resolves open Q). Invert-dark for fixed layout. Deps pinned `react-pdf
10.4.1` + `pdfjs-dist 5.4.296`. Store additive `zoom`. Verified typecheck + build
+ pdfjs Node validation; not pixel-verified (no headless browser). Wave 4 complete.
See [briefs/done/06-pdf-reader.md](briefs/done/06-pdf-reader.md).

## [2026-07-02] done | Brief 07 — EPUB reader + shared search (final brief)

react-reader EPUB reader in `reader/epub/`, reusing the shared chrome via the
`formatControls` seam (no forks). Full light/sepia/dark applied to the epub.js
rendition (real reflow theming). TOC from `book.navigation.toc`. Shared
`SearchPanel` with providers for both formats: EPUB spine walk + PDF
search-on-demand (resolves the last open Q). Deps pinned `react-reader 2.0.15`,
`epubjs 0.3.93`, `react-swipeable 7.0.2`; no epubjs/Vite polyfill needed. Verified
typecheck ×3 + Vite build (599 modules). **All 7 briefs done — build complete.**
Remaining gaps are dev-machine only: Calibre absent (live conversion untested) +
no headless browser (readers not pixel-verified). See
[briefs/done/07-epub-reader-and-search.md](briefs/done/07-epub-reader-and-search.md).

## [2026-07-02] verify+fix | Full browser test run (Playwright) + UI audit — both verification gaps closed

First live run of the whole app against real files (arXiv PDF; a real 24MB
commercial EPUB) with Playwright MCP + Calibre 5.37 on host. Test practice
scaffolded: plans in `corpus/test-plans/` (TP-01…TP-05 + RESULTS.md), run hub in
`playwright/` (gitignored per owner request, incl. screenshots). All five plans
PASS after a verify→fix loop. Big catches: EPUB reader rendered **blank** on
real-world books (EPUB3 nav hrefs relative to a subdirectory nav doc don't
resolve in the epub.js spine → "No Section Found"; fixed with a spine-href
resolver + `location={cfi ?? 0}`); no way back home from either reader (new
shared `HomeButton`); auto-hide chrome hid under the open popover/cursor and
never revealed over the EPUB iframe (chrome-hold + rendition event forwarding);
search jumps now highlight the match (PDF `<mark>` via customTextRenderer, EPUB
`annotations.highlight`); fresh-checkout `npm run dev` failed until shared is
built (dev script now builds it); live conversion worked only with
`PYTHONNOUSERSITE=1` (host pip lxml vs distro Calibre — API now sets it;
verified 200 + valid 28MB PDF in ~6s). UI audit fixes: toolbar wraps at mobile,
EPUB progress shows a single % chip, favicon, contrast bump. Typecheck ×3
clean. Full detail: [test-plans/RESULTS.md](test-plans/RESULTS.md).

## [2026-07-02] build | "Quiet paper" EPUB reader redesign + one-step upload flow

Designed via impeccable shape (brief confirmed by owner: quiet-paper feel,
single centered column, all four priority areas). Reader changes: measure-capped
centered column (`spread: none`, max-w-2xl, `relative` anchor is load-bearing);
running header (book title / current chapter) + scrubbable bottom progress rail
with chapter ticks + hover tooltip (locations-space, exact alignment with fill);
footer chapter·% button opens the TOC scrolled to the current chapter
(highlight + dot); "Aa" settings panel (theme swatches as miniature pages, font
specimens, A−/A+ steppers); search panel groups results by chapter and bolds
the query; skeleton-page loading; jump crossfade as an overlay veil; hyphenation
+ centered/fitted cover images; unified 1.75 icon strokes; quieter edge arrows
(pointer-fine only). Toolbar wrapper is pointer-events-none so the rail under
it stays scrubbable. **Flow collapsed (owner request): upload → read directly
for both formats — the EPUB fork screen is gone; "Download as PDF" is now a
secondary toolbar button in the EPUB reader (spinner while converting, transient
error notice). PRODUCT.md added (impeccable init).** Verified live with the
real book: column/rail/TOC/search/Aa/download all exercised; themes proven
correct via print-pipeline render (viewport screenshots in this WSL headless
env can serve stale composited frames for pages hosting huge epub iframes — a
capture artifact, not a product bug; settings changes also re-render the
current section as belt-and-suspenders). PDF reader regression-checked.
Typecheck + build clean.

## [2026-07-07] done | Brief 08 — draggable progress rail, shared by both readers

The EPUB-only `ProgressRail` moved to `reader/chrome/` and gained pointer-capture
drag: the fill + chapter tooltip preview the grab position live; the seek commits
once on release (no per-move rendition thrash); touch scrubs without scrolling;
pointer-cancel aborts cleanly. The PDF reader now mounts the same rail (page-based
percent, ticks from top-level outline entries, page-number tooltip) — it previously
had no rail at all. Scope widened from the source todo to both formats (owner call).
Verified headless-Playwright against both fixtures: 10/10 drag/click/tooltip checks,
zero console errors; typecheck clean ×3. See
[briefs/done/08-draggable-progress-rail.md](briefs/done/08-draggable-progress-rail.md),
[wiki/reader.md](wiki/reader.md). Env note: the library DB rows from the old
`/home/gandolh` checkout point at dead absolute paths (500s on file/cover) —
pre-existing, worked around by re-uploading fixtures; filed as an open question.

## [2026-07-07] done | Brief 09 — platform password (D28, revises D2)

The whole platform now gates behind one shared password (`APP_PASSWORD` env on
the API; unset → auth off + loud startup warning, dev stays frictionless).
API-enforced `onRequest` guard (allowlist: login/status/health/OPTIONS);
stateless token = `sha256hex(password)` accepted as `Authorization: Bearer` or
`?token=` (cover `<img>`s); web stores it in `localStorage`, shows a Quiet-Paper
lock screen (gate in `root-layout.tsx`), and re-locks on any non-login 401.
Built via plan-split-dispatch (haiku contract / opus API / sonnet web); two
sonnet review finders caught three real issues, all fixed: token redacted from
request logs, duplicate `?token=` no longer 500s (clean 401), React Query stops
retrying 401s. Verified end-to-end headless: 10/10 with auth on, disabled mode
clean, zero unexpected console errors, typecheck ×3. See
[briefs/done/09-platform-password.md](briefs/done/09-platform-password.md),
[wiki/decisions.md](wiki/decisions.md) D28.

## [2026-07-07] done | Brief 10 — loading feedback: instant open + download progress

Probing the live deployment confirmed the todo: clicking a cover froze the
library for the whole file transfer (24MB EPUB) with only a subtle card dim,
and a failed download showed nothing (`try/finally`, no `catch`). Now the click
navigates instantly; `useHydrateBook` is the single download path (click +
refresh) and streams with byte progress against the row's `sizeBytes` (the
server sends no Content-Length); `/read` shows an opening screen (cover,
Playfair title, determinate accent bar, %) and an error state with "Try again"
+ back-to-library. Verified on a CDP-throttled network: opening screen in
~65ms, bar advances, error path + retry recover; typecheck ×3. See
[briefs/done/10-loading-feedback.md](briefs/done/10-loading-feedback.md).
Out of scope: the live host's ~3s first-HTML latency (server-side). Owner
instruction mid-brief: the VPS address never goes into git, and nothing is
committed until they say so.

## [2026-07-13] todo | Briefs 11–14 filed — reader UX + a bug

Filed four reader briefs from user requests (all in `briefs/todo/`, not started):
[11 — paged⇄scroll mode toggle](briefs/done/11-reading-mode-toggle.md) (store
flag + PDF multi-page render + EPUB `flow: scrolled-doc`),
[12 — bottom-bar clustering](briefs/done/12-bottom-bar-clustering.md) (move PDF's
settings gear out of the right cluster so PDF matches EPUB's home/actions/page
layout; the `ReaderToolbar` shell already does justify-between),
[13 — page-input digit bug](briefs/done/13-page-input-select-bug.md) (root cause
found: `PageJumpInput` calls `.select()` in a `[draft]` effect, so every
keystroke re-selects and the next digit replaces — typing "12" lands "2";
shared control, affects PDF too), and
[14 — PDF/EPUB visual parity](briefs/done/14-reader-visual-parity.md) (give PDF
the EPUB running-header + column/background frame; must conform to design.md D27).

## [2026-07-13] maintenance | DB seeded with two user accounts

Inserted users **teo** and **alex** directly into `apps/api/data/library.db`
(reusing the app's scrypt `hashPassword` + `upsertUser`; no `seed.ts` written per
owner request). Confirms the code now uses per-user accounts, not the shared
`APP_PASSWORD` — see the drift note below.

## [2026-07-13] ingest | Performance benchmark (bundle + code) → briefs 15–18

Ran a performance pass ("use personal skills"). The `performance-analysis` skill
needs Chrome DevTools MCP (not registered here) and the app is auth-gated, so
live CWV/traces weren't possible; measured what was: a production `vite build`
and a code audit of the reader hot paths. Findings (measured):
- **Entry JS = 1,418.94 kB (gzip 434 kB), one monolithic chunk** — `read.tsx`
  statically imports BOTH readers, so pdf.js + epub.js ship to every user. Vite
  warns on the >500 kB chunk. → [brief 15](briefs/done/15-code-split-readers.md).
- **pdf.worker.min = 1,046 kB** (already on-demand — fine).
- **Fonts = 920 KB** (412 KB woff2 + 508 KB legacy woff; cyrillic/greek/vietnamese
  subsets for an English-first app). → [brief 17](briefs/done/17-font-payload-trim.md).
- **EPUB open parses the file twice** (react-reader buffer + a throwaway `Book`
  for the off-screen page-map walk) plus `locations.generate(1000)`, eagerly on
  every open. → [brief 16](briefs/done/16-epub-open-cost.md).
- Filed [brief 18](briefs/done/18-live-perf-benchmark.md) to stand up the live
  CWV/trace measurement the pass couldn't run, so 15–17 can be ranked by measured
  user time, not payload alone.

## [2026-07-13] maintenance | Corpus structure upgraded to personal-skills v0.20.0 conventions

Added `summary:`+`updated:` frontmatter to all 8 wiki pages; wrote `corpus/lint.sh`
(frontmatter / relative-link / page-size checks + `--index` catalog generator);
`index.md`'s wiki catalog is now generated; added the retrieval budget + lint rule
to `CLAUDE.md`; restored `briefs/todo` + `briefs/superseded` dirs and fixed 4
broken links the linter caught. Also documented this project's `test-plans/` layer
in the `corpus-flow` skill source. `bash corpus/lint.sh` passes.

## [2026-07-13] incident | Corpus content drift vs. code (auth / reading progress) — UNRESOLVED

Per-user accounts + per-user reading progress landed in code (commits `7caaa42`,
`207cf7b`; `users`/`sessions`/`reading_progress` in `apps/api/src/db.ts`;
`config.ts` no longer requires `APP_PASSWORD`), but the wiki still describes the
shared-password model (`decisions.md` D28/D29, and D2/D9 stances). No prior log
entry recorded the change. Flagged in `CLAUDE.md` + `status.md`; needs an explicit
decisions reconciliation (new D-entry + wiki update) rather than a quiet rewrite.

## [2026-07-13] done | Briefs 11–18 built via orchestrate → plan-split-dispatch (6 waves)

Built the whole reader backlog with the model-routed subagent orchestrator
(controller opus; sonnet for mechanical chunks, opus for design/perf). Waves:
1 (parallel) 13‖15‖17, then serial 12 → 14 → 11 (shared reader files), then 18
(measure) → 16 (optimize). Every wave passed a controller verify gate (typecheck
+ build). All briefs moved to `briefs/done/` with per-brief outcome notes.

**What shipped:**
- **11** paged⇄scroll toggle (`pageMode` store field; PDF windowed multi-page +
  IntersectionObserver; EPUB `flow: scrolled-doc`).
- **12** PDF bottom bar clustered like EPUB (settings gear → middle; right = page/%).
- **13** page-jump digit bug fixed (select-all only on focus transition).
- **14** shared `ReaderHeader`; PDF adopts EPUB's 3-row grid frame.
- **15** readers code-split — **entry JS 1,418.94 kB → ~407 kB (gzip 434 → 123 kB)**.
- **16** EPUB open-cost caching (locations + page-map) — **same-book re-open
  locations 4711→66 ms, page-map 2814→376 ms**; cold unchanged.
- **17** font payload **920 KB → 544 KB** (per-subset imports).
- **18** live perf benchmark harness + `wiki/performance.md` baseline.

**Review + fixes (scoped 3-finder review → 1 opus fix pass):** eight findings
fixed, incl. two real bugs — PageNav tap-zones stayed live in scroll mode (both
readers), and deep-page scroll-mode resume was corrupted by late page-aspect
reflow — plus EPUB cache-key collision (added `lastModified`), sub-pixel stale
page-map key, a `locations.generate` cancellation guard, a chunk-load
`ReaderChunkErrorBoundary`, and removal of the dead `layoutMode` store field.
Final typecheck + build clean; readers still split. See
[wiki/reader.md](wiki/reader.md), [wiki/performance.md](wiki/performance.md).
Nothing committed — owner controls.

Follow-ups noted (not filed): `/file` served no-cache so the 24 MB EPUB
re-downloads every open (server-side caching); a durable IndexedDB locations
cache for first-open-after-reload; dropping legacy `.woff` (needs `sass`).

## [2026-07-13] decision | Corpus reconciled with per-user auth + reading progress (D30, D31)

Resolved the flagged content drift: the per-user work that shipped in code on
2026-07-08 (commits `7caaa42` per-user accounts, `207cf7b` per-user reading
progress) is now recorded as locked decisions. **D30** — per-user accounts
(operator-seeded, scrypt-hashed, opaque `sessions`, always-on `onRequest` guard;
`APP_PASSWORD` removed) replaces the shared platform password, revising D2/D28/D29.
**D31** — per-user reading progress + exact resume position (`reading_progress`
table) revises D9's "position is session-only" and the legacy global
`books.progress` column. Verified against `apps/api/src/{auth,db,password,config}.ts`.
Marked D2/D9/D28/D29 revised; updated `overview.md`, `architecture.md` (tables +
auth flow + backend stack), and `CLAUDE.md` (one-liner, dropped the drift box).
Also fixed a duplicated line in `open-questions.md`. `bash corpus/lint.sh` passes.
The library remains shared across users (no per-book ownership).

## [2026-07-16] todo | Brief 21 filed — group the library by metadata

Captured [todos/group-library-by-metadata.md](todos/group-library-by-metadata.md)
(with inline web research: EPUB OPF `dc:subject` + `calibre:series` /
`belongs-to-collection` series conventions; PDF Info dict is best-effort only),
grilled the owner, and promoted it to
[briefs/done/21-group-library-by-metadata.md](briefs/done/21-group-library-by-metadata.md).
Locked in the grill: group keys author + series + subject, section-headers-only
UX, PDFs best-effort → "Unknown" group, multi-valued fields use first value
only. Extraction extends the native OPF parse in `extract.ts` (no Calibre
shell-out); existing rows get a one-time backfill. Not started.

## [2026-07-16] decision | Brief 21 display treatment: a shelf per group

Rendered four Quiet Paper mockups of the grouped gallery as an artifact
("Brief 21 — Group display options": chapter-head rules, shelf per group,
margin index, collapsible groups — same fake library in each, real
Playfair/Inter tokens). Owner picked **B — a shelf per group**: caps label +
count over one horizontal row of covers on a hairline plank, horizontal
overflow scroll, Unknown shelf last. Brief 21's UI step + acceptance updated
(it's still in `todo/`, so mutable); drill-in filtering stays out of scope per
the original grill.

## [2026-07-16] decision | Brief 21 finalized — Shelves ⇄ Stacks behind a View toggle

Second design artifact ("Brief 21 — Library view toggle", interactive Quiet
Paper demo) approved: the grouped library gets a two-segment **View** control
(Shelves | Stacks) in the header, visible only while Group by ≠ None. Shelves
(option B) stays the default browse view; Stacks is the drill-in exploration E
(fanned stack index → filtered group page via `/library?g=<key>`, browser-Back
safe). Preference persists to localStorage like paged⇄scroll. Brief 21's UI
step + acceptance rewritten to the final spec; still pure-client on top of the
brief's metadata fields — no extra backend work. Ready to build.

## [2026-07-16] maintenance | Closed two stale todos; captured in-app catalog download

Closed `todos/draggable-reading-progress-bar.md` (shipped in brief 08) and
`todos/add-platform-password.md` (obsolete — D30 per-user accounts replaced
the shared password) at the owner's direction. Captured a new todo,
[todos/in-app-catalog-download.md](todos/in-app-catalog-download.md):
Foliate-style in-app download from free/legal catalogs, with inline research —
OPDS is the standard; Project Gutenberg via Gutendex is the v1 pick (respect
the PG robot policy, cache catalog queries, download EPUBs through the
existing upload pipeline server-side); Standard Ebooks quality is great but
its full feeds are patron-gated; Internet Archive lending ruled out.

## [2026-07-16] todo | Brief 22 filed — Gutenberg discover page

Grilled and promoted [todos/in-app-catalog-download.md](todos/in-app-catalog-download.md)
to [briefs/done/22-gutenberg-discover.md](briefs/done/22-gutenberg-discover.md).
Locked: v1 = Project Gutenberg via the public Gutendex instance (server-side
TTL cache, PG robot policy honored); a dedicated `/discover` page with search +
popular landing + topic/language browse, built on the existing TanStack
Router (code-based tree, Zod search schema) + TanStack Query (import mutation
invalidates the library query); imports run through the existing upload
pipeline and land as normal library cards with `source`/`source_id`
provenance; duplicates get an "In library" badge, reimport allowed. Noted
schema-migration coordination with unbuilt Brief 21 (disjoint columns).
Not started.

## [2026-07-16] todo | Brief 23 filed — media library (music + video)

Grilled and filed [briefs/done/23-media-library.md](briefs/done/23-media-library.md)
directly from an owner request (no source todo): the library also holds
**mp3 audio and MP4/WebM video**, uploaded and played in-app. Locked: one
gallery with a persisted type filter (no separate routes); browser-native
formats only — no transcoding and **no ffmpeg** (video cards use the
typographic tile; metadata via the pure-JS `music-metadata` package, with
artist/album mapped onto the existing author/series columns so grouping just
works); full D31 progress parity (per-user resume, seconds-offset locator);
`GET /library/:id/file` gains HTTP Range support (206) for scrubbing —
Safari requires it. Offline downloads stay books-only for v1. Inline research:
MDN codec guide + caniuse (H.264/WebM are the native baseline, HEVC/MKV are
not), music-metadata (ID3 + cover art + duration, mp4/webm best-effort),
range-request serving patterns. Noted three-way schema-migration coordination
with unbuilt briefs 21/22 (disjoint columns). Not started.

## [2026-07-16] done | Briefs 21 + 22 — grouped library and Gutenberg discover shipped

Built via orchestrate → plan-split-dispatch in two waves (21 backend → 21
frontend → gate → 22 backend → 22 frontend → gate), 3 opus + 1 sonnet chunks.
Brief 21: series/subjects extraction + migration + backfill, grouped gallery
with the Shelves ⇄ Stacks toggle (`?g` drill-in, localStorage prefs). Brief 22:
`/discover` page over an API-side Gutendex proxy (TTL cache) importing EPUBs
through the existing pipeline with provenance fields. Scoped review (3 finders:
integration/backend/frontend) surfaced 7 real findings — attribute-order OPF
meta parsing, EPUB3 refines fragility, mirror sub-path loss in
GUTENDEX_BASE_URL, numeric XML entities, StackIndex fallback drift, case-split
group buckets, history spam from debounced search — all fixed and re-gated.
Verified: typecheck + build green ×3 gates; live API E2E on a scratch data dir
(seeded user, popular/search proxied, cache hit 167ms→8ms, book #55 imported
in 3.5s with cover + 14 subjects, file/cover streamed, typed 400/404 errors).
Briefs moved to done/ with outcome notes; status.md + architecture.md updated.
**Uncommitted — owner controls git.** Brief 23 (media-library, owner-filed)
remains in todo/.

## [2026-07-16] done | Brief 23 — media library (music + video) shipped

One library, type filter: mp3/mp4/webm join pdf/epub. Backend: widened
formats + MIME tables, `kind`/`duration_seconds` columns, `music-metadata`
(pinned 11.14.0) extraction (ID3 → artist/album/track/genre map onto brief
21's columns, square 400×400 art), HTTP Range on the file route (206/416,
ETag preserved). Frontend: lazy AudioPlayer/VideoPlayer with `?token=` src,
resume-at-locator + throttled progress PATCH (D31 parity); All/Books/Music/
Videos filter persisted and applied before grouping; per-kind cards; UploadZone
widened; offline stays books-only. Review caught 5 real bugs (incl. lost
final-position flush and stale-format misrouting) — fixed. Live E2E with real
CC0 media on a scratch DB; typecheck + build green. See
[briefs/done/23-media-library.md](briefs/done/23-media-library.md).
**Uncommitted — owner controls git.**
