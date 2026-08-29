---
summary: Archive of Atrium's shipped phases through brief 35 — what each run delivered, what it fixed, and how it was verified. Split out of status.md, which keeps the current snapshot.
updated: 2026-08-29
---

# Status history

Split out of [status.md](status.md) on 2026-08-26, when that page passed the
corpus 200-line rule. It kept the current snapshot and the briefs table; this
holds the narrative of everything that shipped through brief 35, newest first.
Nothing here has been rewritten — these are the entries as they were written at
the time.

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

**Earlier (2026-08-24):** ✅ **The Reading Room rework shipped — briefs 27–33 all
built, reviewed and committed on `reading-room-rework` (not merged; owner
controls git).** Seven briefs in four waves via plan-split-dispatch, then a
three-finder review pass and two fix rounds. **27:** Reading Room tokens, the
Newsreader + Archivo type stack (retiring Playfair/Source Serif 4/Inter), kind
tints, motion primitives; precache 3101.92 → 2815.40 KiB after dropping the dead
`.woff` fallbacks from the glob. **28:** one home — kind became a filter chip
again, per-type routes kept as redirects, Shelves ⇄ Stacks removed. **32:** the
reader at a 620px measure in Newsreader, chrome fade, the rail's drag preview on
an anime.js timeline. **29:** tinted tiles with badges dropped, the Continue
strip in time-remaining, the dropzone confined to the empty state. **33:** Notes
as its own destination. **31:** a player dock that survives navigation — the one
new *capability* in the rework, with no-double-audio guaranteed structurally.
**30:** cross-library search, client-side and offline-capable.

Review found **14 findings**, all fixed: two Critical (a new video inheriting the
previous track's position; the wordmark in synthetic bold), nine Important
(including the dock covering the reader's only scrub control, the search field
eating a typed space, and synthesised bold inside EPUBs), three Minor. Gates are
typecheck + build only — **this repo still has no test suite**, which is the
main reason the review pass carried so much weight.

**Known and accepted, not fixed:** Notes is a row list rather than the comp's
master-detail split (an architectural change, deliberately deferred — worth
revisiting); `library:groupBy`/`library:groupView` are orphaned in existing
users' `localStorage`; three unused exports remain in `grouping.ts`; closing the
dock while the video surface is mounted leaves an orphaned `<video>`; glyph SVGs
are duplicated between `PlayerDock` and `CoverFallback`.

---

**Everything before 2026-07-20** — the v1 build, the PWA phases, the perf
briefs, the media library and the first grouped-library work — is in
[status-history-v1.md](status-history-v1.md). Split off on 2026-08-29 when this
page passed the 200-line rule, the same way it was split off `status.md`.
