---
summary: Archive of Atrium's earliest shipped phases — the v1 build through brief 23 (media library), July 2026. Split off status-history.md, which holds the more recent archive.
updated: 2026-08-29
---

# Status history — the v1 era (through 2026-07-16)

Split off [status-history.md](status-history.md) on 2026-08-29 when that page
passed the corpus 200-line rule, exactly as it was itself split off
[status.md](status.md). Newest first. Nothing here has been rewritten — these
are the entries as they were written at the time.

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
