---
summary: Dated snapshot of current state — a one-liner per brief/area and where things stand right now. The living dashboard.
updated: 2026-08-24
---

# Status — 2026-08-24

**Latest (2026-08-24):** 🎨 **UI/UX rework locked — "Reading Room" (D33),
briefs 27–33 filed, none built yet.** The owner rejected the current surface;
three costed directions were mocked and *Reading Room* chosen. It reverses
brief 25's per-type routes (kind becomes a filter chip again), makes Continue
the hero, adds a persistent player dock, retires Playfair/Source Serif 4/Inter
for **Newsreader + Archivo**, warms the dark theme, keeps Notes as its own
destination, and **removes brief 21's Shelves ⇄ Stacks grouping**. Nothing is
implemented — everything below still describes the *shipped* app, which is the
pre-rework surface. See [design.md](design.md), D33, and `briefs/todo/27`–`33`.


**Latest (2026-07-20):** ✅ **The app is now "Atrium" — briefs 24–26 shipped
(uncommitted — owner controls).** A rebrand + a new Notes subsystem, built via
orchestrate and live-audited across monitor/laptop/tablet/mobile. **24:**
identity swap to **Atrium** (wordmark, title, PWA manifest, favicon arch mark,
neutral theme glyph, design-system header) — internal `@ebook-reader/*` npm
scope kept by decision. **25:** per-type IA — `/books` `/music` `/videos`
routes + nav tabs + shared `LibraryArea`, retiring the in-header media-type
filter; per-media card shapes (book 2:3 / music square / video 16:9) + per-kind
fallback glyphs + per-area grids. **26:** a **Notes** tab — paged notebook with
perfect-freehand vector ink (pen/highlighter/eraser), movable typed text boxes,
undo/redo, per-user server storage, debounced autosave, mobile/stylus. The
audit caught + fixed 3 real Notes bugs (tool bar below the fold; strokes not
committing via empty `getCoalescedEvents()`; giant-blob ink from
normalized-coord degeneracy) + a redundant empty-area dropzone. Typecheck +
build clean; [TP-06-RESULTS](../test-plans/TP-06-RESULTS.md) = PASS. Not
exercised: populated music/video cards + playback (no sample media). See the
2026-07-20 log entry + briefs 24–26.

**Earlier (2026-07-16 eve):** ✅ **Brief 23 shipped — media library
(uncommitted — owner controls)**. One gallery now holds books + music (mp3) +
video (mp4/webm): `kind`/`durationSeconds` on the contract, `music-metadata`
extraction (ID3 artist/album/track/genre map onto brief 21's grouping columns,
square embedded art), HTTP **Range** on `GET /library/:id/file` (Safari-proof
206/416), lazy Audio/Video players with per-user resume (D31 parity), an
All/Books/Music/Videos filter ahead of grouping, per-kind cards; offline stays
books-only; no ffmpeg (video cards are typographic tiles). Review caught 5
real bugs (lost final-position flush, stale-format misroute, MIME variants,
MIME-over-extension, stacks art crop) — all fixed; live E2E with real CC0
media on a scratch DB. Briefs 21–22 were committed earlier today (`8f13cbf`,
`3d45a8b`).

**Earlier (2026-07-16 pm):** ✅ **Briefs 21–22 shipped — grouped library +
Gutenberg discover** (orchestrate → plan-split-dispatch, 2 waves + 3 scoped
review finders + fix pass; **uncommitted — owner controls**). 21: books now
carry `series`/`seriesIndex`/`subjects` (EPUB OPF + best-effort PDF Info,
idempotent migration + startup backfill) and the library groups by
author/series/subject behind a **Shelves ⇄ Stacks view toggle** (shelf rows vs
fanned-stack drill-in via `?g`, prefs in localStorage; design picked via two
mockup artifacts). 22: a `/discover` page browses/searches Project Gutenberg
through an API-side Gutendex proxy (15-min TTL cache, robot-policy-clean) and
imports EPUBs through the existing upload pipeline with `source`/`sourceId`
provenance + "In library" badges. Review found 7 real findings (attribute-order
OPF parsing, mirror-URL resolution, case-split groups, …) — all fixed and
re-verified; live E2E imported a real book (cover + 14 subjects) against a
scratch DB. Open: brief 23 (media library) filed by owner, untouched.

**Earlier (2026-07-16):** ✅ **Briefs 19–20 shipped — the app is a PWA**
(orchestrate → plan-split-dispatch, 2 waves + scoped review + fix pass;
**uncommitted — owner controls**). 19: installable shell via `vite-plugin-pwa`
(generateSW, prompt-mode update toast, icons, cover-only runtime cache,
BASE_PATH-safe). 20: offline reading — per-book "Available offline" toggle,
IndexedDB v2 (metadata/blobs/progress split), offline library fallback +
banner, last-write-wins progress flush on reconnect. Review caught 6 findings
incl. a live-confirmed 3×-duplicate-PATCH bug and a blob-thrash design flaw;
all fixed and re-verified E2E in a real browser (EPUB + PDF read fully
offline, exact-position resume, single PATCH on reconnect). See
[pwa.md](pwa.md) + the 2026-07-16 log entry.

**Earlier (2026-07-13):** ✅ **Briefs 11–18 shipped** (built via orchestrate →
plan-split-dispatch, 6 waves; reviewed + fixed; **uncommitted — owner controls**).
Reader UX (11 paged⇄scroll toggle, 12 bottom-bar clustering, 14 PDF/EPUB frame
parity via shared `ReaderHeader`), a bug fix (13 page-jump digits), and a perf
pass: **15 code-split readers → entry JS 1.42 MB→407 kB (gzip 434→123 kB)**, 16
EPUB open-cost caching (same-book re-open ~4.7 s→66 ms locations), 17 fonts
920→544 KB, 18 a live benchmark harness + [performance.md](performance.md)
baseline. A scoped 3-finder review + opus fix pass caught two real bugs
(scroll-mode PageNav tap-zones, deep-page resume corruption) + 6 more, all fixed;
typecheck + build clean. See the 2026-07-13 log entry.
✅ Resolved (2026-07-13): the auth/reading-progress **corpus drift** is
reconciled — per-user accounts + per-user reading progress (commits `7caaa42`,
`207cf7b`, 2026-07-08) are now locked as **D30/D31**, with D2/D9/D28/D29 marked
revised and overview/architecture/CLAUDE updated to match the code.

**Latest (2026-07-07):** ✅ **Brief 10 — loading feedback** (2026-07-07 pm, **uncommitted by
owner instruction**). Cover clicks navigate instantly; the book downloads behind
an opening screen with a real progress bar (streamed against `sizeBytes`);
failures get an error state + retry (previously silent). All three 2026-07-07
todos are now done. NOTE: briefs 08/09 are committed; brief 10 + this corpus
update are not — owner decides when.

**Earlier today:** ✅ **Brief 09 — platform password** (D28 revises D2).
`APP_PASSWORD` on the API gates everything (stateless sha256 token, Bearer or
`?token=` for covers); Quiet-Paper lock screen, localStorage persistence,
re-lock on 401. Review-hardened (log redaction, duplicate-token 401, no 401
retries). Verified end-to-end headless. **Update 2026-07-08 (D29): `APP_PASSWORD`
is now a REQUIRED, validated env var — the old "unset → auth off" open mode is
gone; the API refuses to start without it (and every `.env` var).**
**Deploy note: set `APP_PASSWORD` (and all `.env` vars) on the VPS — the API
won't boot otherwise.**

**Also today:** ✅ **Brief 08 — draggable progress rail, both readers**.
The scrub rail is now shared chrome: pointer-capture drag with live preview,
commit-on-release; the PDF reader gained the rail (outline ticks, page tooltip).
Verified headless (10/10 checks, both fixtures, zero console errors). Remaining
open todos: loading-state polish (needs the live link).
New open question: library DB stores absolute file paths (dead rows after a
checkout move — see [open-questions.md](open-questions.md)).

**Prior phase:** ✅ **Persistent library + "Quiet Paper" home shipped & verified**
(2026-07-07; reverses D3/D4, see D24–D27 and [design.md](design.md)). SQLite +
on-disk file/cover storage, server-side cover extraction, library CRUD, and the
rebuilt cover-card home. Verified live (Playwright + real files); see the log +
TP-01. Not exhaustively covered: sepia theme, EPUB open-to-read with a real
cover.

**Earlier:** ✅ v1 verified + "quiet paper" redesign shipped (2026-07-02 pm).

Since the morning test run: the EPUB reader got a designer pass (single centered
column, running header, scrubbable chapter-tick progress rail, "Aa" settings
panel, chapter-aware TOC/search, skeleton loading) and the upload flow collapsed
to one step — upload → read for both formats, with "Download as PDF" as a
secondary toolbar action inside the EPUB reader. PRODUCT.md now anchors design
work. See log entry + wiki/reader.md.

All 7 briefs done + a full Playwright test run against real files (arXiv PDF +
a real 24MB commercial EPUB) with live Calibre. Both former verification gaps
are closed; every test plan passes after a verify→fix loop. Zero console
errors on a fresh load. Typecheck clean ×3.

## What the run fixed (headlines)
- **EPUB blank-render on real-world books** (nav-doc-relative hrefs vs epub.js
  spine) — the reader now opens the Apothecary Diaries volume correctly.
- **No way home from the readers** — shared `HomeButton` in both toolbars.
- **Auto-hide chrome misbehaviors** (hid under open popover / resting cursor;
  never revealed over the EPUB iframe) — chrome-hold + event forwarding.
- **Search jumps highlight the match** in both formats now.
- **Fresh `npm run dev` works** (builds `shared` first).
- **Live conversion verified** (~6s for the 24MB EPUB → valid 28MB PDF);
  API spawns Calibre with `PYTHONNOUSERSITE=1` to dodge host pip lxml.
- UI audit: mobile toolbar wraps, EPUB progress is a single % chip, favicon,
  contrast bump.

## Testing practice (new)
- Plans: `corpus/test-plans/` (TP-01…TP-05, RESULTS.md — latest run).
- Run hub: `playwright/` (bring-up, fixtures, conventions; gitignored).
- Fixtures: `testing_files/` (personal books; gitignored).

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
| 21 | Group library by metadata (author/series/subject) | **todo** |
| 22 | Gutenberg discover page | **todo** |
| 23 | Media library: music + video alongside books | **done (2026-07-16)** |
| 24 | Atrium rebrand: identity + design-system neutralize | **done (2026-07-20)** |
| 25 | Per-type IA (Books/Music/Videos) + per-media card shapes | **done (2026-07-20)** |
| 26 | Notes tab: paged ink + text boxes (perfect-freehand) | **done (2026-07-20)** |
