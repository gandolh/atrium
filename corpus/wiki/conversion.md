---
summary: Convert — the same book in either format, as linked library rows produced by an async Calibre job. Both directions, cancellable, quality-graded, and read in-app.
updated: 2026-08-25
---

# Convert (PDF ⇄ EPUB)

**Convert** is one verb for both directions (D34). A conversion produces a
**converted book** — its own `books` row, linked to its **source book** — which
is read in-app like any other. It is not an export.

This page was rewritten by brief 34. Everything it previously described (a
single stateless `POST /convert`, a 60s cap, a downloaded file that could not be
read in the app) is gone; see "What changed, and why" at the foot.

## The shape

A converted book is a **linked row**, not a second file on the source's row:
`books.converted_from` points at the source, `ON DELETE CASCADE`, with a unique
index so a source has at most one conversion.

The payoff is that almost everything comes for free. Per-format resume position
is just two `reading_progress` rows. "Which format did I last use" is whichever
row has the newer `updated_at`. The readers open a book id, as they always
have — so neither reader changed. And a third format later is another row, not
another column pair.

The cost is one `WHERE converted_from IS NULL` on the three list statements in
[library.model.ts](../../apps/api/src/modules/library/library.model.ts). Because cross-library
search, kind chips, grouping and counts are all **client-side over that list**,
they inherit the hiding from those three statements and nowhere else — which is
the thing to remember before adding a fourth.

**One card per book.** The card stands for the book, not for one of its rows: it
merges the pair's progress by whichever half was read more recently, and
"recent" orders on the pair's latest activity. Without that, reading a PDF's
EPUB twin left the card at 0% and out of the Continue strip.

## The job

`POST /library/:id/convert` starts an **async job** (D34, revising D15's 60s
synchronous cap):

- **One at a time**, refused with a 409 naming the book in flight. Not a queue —
  D15's "no queue" survives.
- **24 hours** (`CONVERT_JOB_TIMEOUT_MS`), a last-resort reaper rather than a UX
  guard.
- **Cancellable**, because a 24h ceiling leaves no other recourse. Cancellation
  is checked after *every* await on the path to the commit — a single early
  check silently loses a cancel that lands during the quality gate.
- **Deleting the book cancels its job.** Nothing else tells the runner the book
  is gone, and a claimed slot for a deleted book wedges conversion app-wide.
- **A restart reaps the row to `failed`**, with a retry in the button. No
  auto-resume: one bad row would become a boot loop.
- Output is written under a name derived from the **source** row and renamed
  into place on success, so a job killed mid-flight leaves a leftover that boot
  can actually name and delete.

`--enable-heuristics` is passed on PDF→EPUB and nowhere else: line unwrapping is
what turns fixed-page line breaks back into paragraphs, and it is off by
default. `--unwrap-factor` stays at its default — that is per-document tuning,
and guessing it globally makes things worse.

## The quality problem — why "show original" is the feature

Calibre's own manual calls PDF *"a really, really bad format to use as input"*.
Paragraph boundaries are inferred from line length and punctuation; multi-column
text is read straight across and interleaved into nonsense; headers and footers
land in the body and further wreck unwrapping; hyphenation survives as broken
words; tables, links and the ToC are not extracted; and there is **no OCR**, so
a scanned PDF converts to little or nothing.

Three consequences shape the design: never auto-convert on upload; a conversion
is additive and disposable (the source is never touched); and the hopeless case
is detected rather than presented as success.

**The quality gate** measures extracted text against the source's page count.
Under roughly 200 characters per page means a scan → status `poor` instead of
`ready`. It **warns, never blocks** (D34 decision 12): `poor` opens exactly like
`ready`, with a one-line note. It also **fails open** — a measurement error
yields `ready`, because a false `poor` puts a scary warning on a book that is
fine.

The source is always one tap away. That is the answer to a bad conversion, and
it is why the switch matters more than the conversion quality.

## Where it lives

- [convert.service.ts](../../apps/api/src/modules/library/convert.service.ts) — the runner, the
  single-flight guard, the quality gate, the boot sweep.
- [calibre.service.ts](../../apps/api/src/modules/library/calibre.service.ts) — the `ebook-convert` wrapper.
  Format-agnostic; it always was. Spawns with `PYTHONNOUSERSITE=1` so a pip
  `lxml` can't shadow the distro one — load-bearing, not theoretical.
- [library.controller.ts](../../apps/api/src/modules/library/library.controller.ts) — convert, cancel /
  delete-conversion, and the delete paths that must never unlink a **shared
  cover** (a converted book reuses its source's thumbnail rather than
  re-extracting).
- `reader/chrome/ConvertControl.tsx` — the whole state machine
  (`none → running → ready|poor`, `failed` escaped only by retry), polling at a
  flat 30s **whenever the row reads `running`** and never otherwise. Server
  status drives it, not a client "I started it" flag — which is what makes
  "started it, refreshed, came back hours later" behave identically.

## What changed, and why

**D1 said EPUB→PDF was export-only, never a reading path.** Its reason —
"conversion discards reflow" — is direction-specific and *inverts* for PDF→EPUB,
which adds reflow. The decision was never wrong; it was written when only one
direction existed. D34 revises it.

The stateless `POST /convert`, its temp-file workspace and the web
`convert-api.ts` are **deleted**. The in-reader "Download as PDF" they served
had already been commented out, so no capability was lost — and EPUB→PDF is now
a reading path rather than a download.

See D1, D15 and D34 in [decisions.md](decisions.md), and
[glossary.md](glossary.md) for **Convert** / **Source book** / **Converted
book**.
