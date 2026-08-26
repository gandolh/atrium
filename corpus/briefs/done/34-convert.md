# Task 34 — Convert: the same book in either format

## Context

Owner request (2026-08-24): convert PDF books to EPUB, and let a PDF offer both
*"show EPUB"* and *"show original"*. PDFs are fixed-page — on a phone that means
pinch-zoom and horizontal panning, the exact reading experience the rest of the
app exists to avoid. A reflowable twin fixes that; the original stays one tap
away because the conversion is unreliable (see "The quality problem").

Grilled with the owner across five rounds on 2026-08-24. Every decision below is
**owner-confirmed** unless marked otherwise.

### What already exists (verified 2026-08-24)

The conversion primitive is **already format-agnostic**. `runEbookConvert` in
[calibre.ts](../../../apps/api/src/calibre.ts) spawns
`ebook-convert <input> <output>` with no format-specific flags, and Calibre
infers both formats from the extensions. `in.pdf → out.epub` works today;
nothing about the wrapper, its timeout, or its
`ok | failed | timeout | missing` outcome type is direction-specific.

What *is* direction-specific is everything around it.
`convert-route.ts` *(deleted by this brief)* is **stateless**: it
takes a fresh multipart EPUB upload, works in a temp workspace
(`temp-files.ts` *(deleted by this brief)*), streams a PDF back as a
download, and deletes both files in a `finally`. This brief needs the opposite —
an existing library row in, a persisted library row out.

### The architecture: linked rows, not sibling files

**Owner's call:** a converted book is **its own `books` row**, linked to its
source by a foreign key — not an alternate file hanging off the source's row.
The first draft of this brief had one row with two files; the owner's model is
better, and measurably cheaper:

| | One row + sibling file (rejected) | Linked rows (chosen) |
|---|---|---|
| Per-variant resume position | needs a new locator column | **free** — two `reading_progress` rows |
| "Which format last used" | needs a `last_variant` column | **free** — the newer `updated_at` wins |
| Reader changes | a `variant` param threaded through `read.tsx` | **none** — open a different book id |
| Library grid | nothing | hide derived rows: one `WHERE` on three statements |
| Couples to brief 35 | yes (both migrate `reading_progress`) | **no** |

It also generalizes: a third format later is another row, not another column
pair. The cost is one FK column plus a `WHERE converted_from IS NULL` on the
three list statements in [db.ts:318](../../../apps/api/src/db.ts#L318) — and
because cross-library search is **client-side over the loaded list**
([search.ts](../../../apps/web/src/library/search.ts)), search, grouping, chips,
and counts all inherit the hiding for free.

### Both directions, and what that costs

**Owner's definition:** *"convert is changing from one format to another. epub to
pdf or pdf to epub."* One umbrella verb, both directions, both building now.

This collides with the existing export: `/convert` already turns an EPUB into a
PDF, as a stateless download, and D1 locks that as *"export-only, never a reading
path"*. Two ways to do one thing is not shippable, so this brief resolves it:

- **Library conversion supersedes the stateless route.** The in-reader
  "Download as PDF" button is reimplemented on top of it — convert (which leaves
  a readable PDF row in the library), then download that row's file through the
  existing file route. **No user-facing capability is lost**; the user gains a
  readable PDF where they previously got only a file.
- `convert-route.ts`, `temp-files.ts`, and the web `convert-api.ts` are
  **retired** once the button is reimplemented. Delete them in the same brief —
  a dead stateless twin is exactly the kind of thing that survives for a year.
- **D1 is revised, not merely amended** (step 9). Note that D1's stated reason —
  *"conversion discards reflow"* — is direction-specific and inverts for
  PDF→EPUB, which *adds* reflow. The decision was never wrong; it was written
  when only one direction existed.

### The quality problem — why "show original" is the feature, not a nicety

Calibre's own manual is blunt: PDF is *"a really, really bad format to use as
input"*, and users should *"be prepared for an output ranging anywhere from
decent to unusable"*. Specifically, and confirmed across sources:

- **Paragraph boundaries are guesswork** — a fixed-page format has no paragraph
  structure, so Calibre infers it from line length and punctuation.
- **Multi-column is unsupported** — a two-column academic PDF is read straight
  across both columns, interleaving them into nonsense.
- **Headers/footers land in the body**, and their presence *further* throws off
  paragraph unwrapping.
- **Hyphenation** at line ends survives as broken words.
- **Vector images, tables, links, and the ToC are not extracted**; non-Unicode
  embedded fonts garble text; RTL and mathematical typesetting fail.
- **Scanned/OCR PDFs** convert to little or nothing — there is no OCR step.

Sources: [Calibre conversion manual](https://manual.calibre-ebook.com/conversion.html),
[Calibre FAQ](https://manual.calibre-ebook.com/faq.html),
[ebook-convert options](https://manual.calibre-ebook.com/generated/en/ebook-convert.html),
[PDFs to ePub conversion tips](https://dearauthor.com/ebooks/calibre-pdfs-epub-conversion-tips/).

Three consequences shape the brief: **never auto-convert on upload** (most books
never need it); **a conversion is additive and disposable** (the source is never
touched, the result can always be deleted and re-run); and **detect the hopeless
case and say so** rather than presenting a blank book as success.

### Grilled decisions (2026-08-24, owner-confirmed)

1. **Convert is the umbrella verb** for changing format in either direction —
   one glossary sense, both paths. (Rejected: a separate "reflow" term for the
   new direction; the owner preferred one word.)
2. **Linked rows** via `converted_from`, derived rows hidden from the grid.
3. **Both directions built now**; the stateless export retires (above).
4. **An async API job**, ceiling **24 hours**. Not a UX guard — a last-resort
   reaper. (Rejected: synchronous, and a 10-minute cap.)
5. **Cancellable**, because a 24h ceiling leaves no other recourse. *(Builder's
   call, unopposed.)*
6. **One conversion at a time per account**; a second request is refused with a
   clear message. Not a queue — D15's "no queue" survives intact. *(Builder's
   call, unopposed.)*
7. **API restart mid-job reaps the row to `failed`**, retry sits in the button.
   Rejected: auto-resume on boot, which turns one bad row into a boot loop.
   *(Builder's call, unopposed.)*
8. **Polling is flat 30s** — owner accepted drift on a fast conversion over the
   extra requests a taper costs.
9. **Server status drives the polling, not a client flag.** The reader polls
   whenever the row reads `running` — whether this tab started it, another tab
   did, or it was still going when the app was closed. This is what makes
   "started it, refreshed, came back hours later" behave identically without a
   client-side started-it flag.
10. **The trigger lives in the reader only**, not on the library card. The
    moment you want a conversion is the moment a PDF is painful to read, and
    that happens in the reader.
11. **Reopening a book uses the format last used** *by that reader* — derived
    from whichever linked row has the newer `reading_progress.updated_at`, so
    it becomes per-profile for free once brief 35 lands.
12. **The quality gate warns, never blocks.**

## Files you OWN

- `apps/api/src/calibre.ts` — an optional trailing `args: string[]`, and a
  kill/cancel handle. Do not change the outcome type.
- `apps/api/src/convert-jobs.ts` — **new**: the job runner, its single-flight
  guard, and boot reaping.
- `apps/api/src/library-routes.ts` — the convert/cancel/delete-conversion
  routes and the derived-row hiding.
- `apps/api/src/db.ts` — `converted_from`, the status columns, the three list
  statements, and the linked-row helpers.
- `apps/api/src/config.ts` + `.env.example` — `CONVERT_JOB_TIMEOUT_MS`.
- `apps/api/src/index.ts` — registration; drop the retired route.
- `packages/shared/src/library-book.ts` — the wire contract.
- `apps/web/src/library/` + `apps/web/src/reader/chrome/` — the convert status
  button and the format switch.
- `apps/web/src/routes/read.tsx` — open-the-remembered-format resolution.
- `apps/web/src/lib/library-api.ts`, `use-library.ts` — the calls + polling.

**Delete when the reimplementation lands:** `apps/api/src/convert-route.ts`,
`apps/api/src/temp-files.ts`, `apps/web/src/lib/convert-api.ts`, and the
now-unused convert schemas in `packages/shared`.

## Files you must NOT touch

- `auth.ts` / `password.ts` — the app-wide guard already covers the new routes.
- `extract.ts` — the source book's cover already exists; a converted row reuses
  its source's cover rather than re-extracting.
- `apps/web/src/reader/pdf/**`, `apps/web/src/reader/epub/**` internals — both
  readers are used **unmodified**; only which row you open changes.
- `offline-store.ts` — offline downloads the row you downloaded, unchanged. A
  converted row is downloadable like any other; nothing is duplicated per format.
- `catalog-routes.ts`, `notes-routes.ts`, `apps/web/src/player/**`.
- **Coordination:** brief 35 (profiles) rebuilds `reading_progress`. This brief
  does **not** touch that table (decision 2), so the two are independent. Build
  35 first by preference, not by constraint.

## What to do

1. **Contract** (`packages/shared`): add to `libraryBookSchema` —
   `convertedFrom: z.string().nullable()` (the source book's id, null for a
   source), `convertedTo: z.string().nullable()` (the derived row's id, null when
   none), and
   `convertStatus: z.enum(["none","running","ready","poor","failed"])`.
   `poor` = produced but probably unusable; it still opens, the UI just warns.

2. **DB** (`db.ts`): on `books`, add `converted_from TEXT REFERENCES books(id)
   ON DELETE CASCADE`, `convert_status TEXT NOT NULL DEFAULT 'none'`,
   `convert_error TEXT`, `convert_started_at TEXT` — all via the existing
   `pragma table_info` idempotent-ALTER pattern. Add
   `WHERE converted_from IS NULL` to `listRecent` / `listByTitle` /
   `listByAuthor` so derived rows never reach the grid. On boot, reap any row
   left in `running` to `failed` with an explanatory `convert_error` (decision
   7). The `ON DELETE CASCADE` is what makes deleting a source remove its
   conversion; the file cleanup in `DELETE /library/:id` must handle both rows.

3. **The job runner** (`convert-jobs.ts`): an in-process map of
   `bookId → { child, startedAt }`. Starting a job sets `running`, spawns
   `runEbookConvert(sourcePath, targetPath, CONVERT_JOB_TIMEOUT_MS, args)`, and
   on completion inserts the derived row (title/author/subjects/cover copied
   from the source, `converted_from` set, `format` the target format) and flips
   the source to `ready`/`poor`. Refuse a second concurrent job **account-wide**
   with a clear message (decision 6). Map `missing` → `failed` carrying the
   existing Calibre-missing copy. **It must never throw into the process** —
   same best-effort discipline as extraction.
   - PDF→EPUB passes `--enable-heuristics`: line unwrapping is what turns
     fixed-page line breaks back into paragraphs and it is **off by default**.
     Leave `--unwrap-factor` at its default — it is per-document tuning.
   - EPUB→PDF passes no extra flags (today's export behavior).

4. **Routes** (`library-routes.ts`): `POST /library/:id/convert` → 404 unknown;
   400 if the format has no conversion target or the row is itself derived; 409
   if a job is already running anywhere; 200 no-op if a conversion already
   exists (unless `?force=1`); otherwise **202**. `DELETE
   /library/:id/convert` cancels a running job **or** deletes a finished
   conversion (kill the child, remove the derived row + file, reset the source
   to `none`). `GET /library/:id` must expose both link directions so the reader
   can offer the switch from either side.

5. **The quality gate**: after a successful PDF→EPUB, unzip the result and
   measure extracted text against the source's page count. Under roughly **200
   characters per page** means a scanned or image-only PDF → status `poor`
   instead of `ready`. Cheap, catches the most common disappointing case, and
   turns a silently blank book into an explained one. **Warning only** — never
   blocks opening, never a confirmation dialog (decision 12).

6. **The status button** (`apps/web`): one component owning the whole machine —
   `none` → "Convert to EPUB" / "Convert to PDF"; `running` → a disabled
   processing state that says it can take a while, plus Cancel; `ready` → the
   format switch; `poor` → the switch plus a one-line "this looks scanned"
   note on first use; `failed` → the reason and a retry. It enables a React
   Query poll at a **flat 30s** `refetchInterval` **whenever the row reads
   `running`** (decision 9) and disables it otherwise, so no book that nobody is
   converting is ever polled, and a reopened app resumes polling by itself.

7. **Opening the remembered format** (`read.tsx`): opening a book from the
   library resolves to whichever of the linked pair has the newer
   `reading_progress.updated_at` for the current reader; opening a variant
   **touches** that row's `updated_at` so the choice sticks even if no reading
   happens. No `variant` param, no new column — the reader opens a book id, as
   it always has.

8. **Retire the stateless export**: reimplement the EPUB reader's "Download as
   PDF" as convert-then-download-the-linked-row, then delete
   `convert-route.ts`, `temp-files.ts`, `convert-api.ts`, and the orphaned
   shared schemas. Confirm nothing else imports them.

9. **Corpus** (last, matching what shipped): record the decision that **Convert
   is symmetric, library-attached, and produces a readable linked row**,
   **revising D1** (export-only → conversions are a reading path; note that
   D1's reason inverts by direction) and **D15** (60s synchronous → a 24h async
   job, one at a time, no queue). Rewrite the **Convert** entry in
   `wiki/glossary.md` as the umbrella verb and add **Source book** / **Converted
   book**. Rewrite `wiki/conversion.md` — it currently claims conversion is "the
   only backend feature", is stateless, and never leads to reading; all three
   change. Update `wiki/architecture.md`'s convert flow, `wiki/status.md`, and
   `log.md`.

10. **Verify live**: a clean text PDF → convert → readable EPUB with sane
    paragraphs; a two-column academic PDF → interleaved output (**expected** —
    the switch back is the answer, and the brief is not done if that path is
    awkward); a scanned PDF → `poor` + warning, still opens; an EPUB → PDF and
    read the result in-app; each format resumes at its own position and the
    library shows **one** card per book; close the app mid-conversion, reopen,
    confirm the button is still processing and polling resumed; cancel a running
    job; kill the API mid-job and confirm the row reaps to `failed` rather than
    hanging; a second concurrent convert → clean 409; delete the source and
    confirm both rows and both files are gone; delete just the conversion and
    re-run it; confirm search, chips, grouping, and counts show no derived rows;
    confirm uploads, covers, players, and Notes are untouched.

## Acceptance

- A PDF offers "convert to EPUB" from the reader; once ready, the reader
  switches between the two formats, and the EPUB reflows on a phone with no
  horizontal panning. An EPUB offers the same in reverse.
- The library shows **one card per book** — a converted row is never a second
  tile, and never appears in search, chips, grouping, or counts.
- The source file is never modified and is always one tap away regardless of
  conversion quality.
- A scanned PDF is reported as `poor` with a plain warning and still opens; the
  warning never blocks.
- Reopening a book lands in the format that reader last used.
- Each format keeps its own resume position; neither ever receives the other's
  locator.
- A conversion survives a refresh, an app close, and a return hours later: the
  button still says processing and polling resumes with no user action.
- A running conversion can be cancelled; an API restart mid-job leaves the row
  `failed` with a retry, never stuck in `running`.
- A second concurrent conversion is refused with a clear message.
- Deleting a book removes its conversion and both files; a conversion can be
  deleted and re-run on its own.
- Calibre absent → the failure says so specifically and nothing else breaks.
- The stateless `/convert` route and its temp-file machinery are **gone**, and
  the EPUB reader's Download-as-PDF still works.
- Typecheck + build + tests clean; Reading Room (D33) conformance passes on the
  status button, the format switch, and the warning.

---

> **Outcome (2026-08-25):** Shipped as specced via orchestrate →
> plan-split-dispatch: 6 chunks in 3 waves (2 senior / 4 junior), then three
> scoped review finders and one fix round. Verified against real Calibre 5.37
> and a copy of the live database throughout.
>
> **Review found 7 findings — 1 Critical, 4 Important, 2 Minor.** All fixed but
> the two Minor. The Critical was reported **independently by two finders**, and
> is the one worth remembering: deleting a book never cancelled its running
> conversion, so the runner kept its single-flight slot claimed for a row that
> no longer existed — refusing every other conversion in the app with a 409
> naming the deleted book, with no way to release it, since the cancel route
> resolves `getBook(id)` first and 404s once the row is gone. Every component
> was individually correct; nothing told the runner the book was gone.
>
> The other Important findings: a cancel landing during the quality gate was
> silently ignored and the conversion committed anyway (the `cancelled` flag was
> read once, before two more awaits); a process death mid-job orphaned its
> output forever, because the converted book's id was a `randomUUID` living only
> in-process; reading a converted twin never moved the library card, because
> progress is recorded against the row you opened and that row is hidden from
> the list; and the "looks scanned" note was frozen off by a mount-time
> `useState` initializer for the most ordinary path to `poor`.
>
> **Deviations from this brief, accepted:** `convertError` joined the wire
> contract (step 1 specified three fields, but the `failed` state has to show a
> reason and nothing else carried it) and `lastReadAt` joined it too (step 7's
> comparison was impossible from the client, which deliberately saw no progress
> timestamp). A unique index on `converted_from` was added, so a re-run must
> delete before it inserts. The single-flight guard is **store-wide** rather
> than per-account — the library is shared with no per-book ownership (D30/D24),
> so the two are the same query. Deleting a converted book directly now resets
> its source's status, which the brief did not cover. `use-hydrate-book.ts`
> needed a by-id fallback, since hydration sourced only from the library list
> can never open a row that list hides by design.
>
> **Known and accepted, not fixed:** the boot reap can mislabel a live job if a
> second process imports `db.ts` (running the seed script mid-conversion); it
> self-heals when the job completes. The three convert hooks live in
> `use-library.ts`, so a few hundred bytes ship in the entry chunk — the
> component itself correctly stays in the lazy reader chunk.
>
> **Not verified:** step 10's live matrix was only partially exercisable. This
> machine's Calibre has an `lxml`/`html5-parser` ABI mismatch, so any PDF or
> EPUB **with an outline** fails to convert — a host defect, not a code one.
> Clean single-page fixtures convert correctly (a real 21-page PDF→EPUB in 2.0s
> with the heuristics flag confirmed on the spawned command line), but the
> two-column-academic and real-scanned-PDF readability judgements remain for the
> owner on a working Calibre install.
>
> **Cost:** entry chunk 200.66 → 201.81 kB gzip (+1.15). An earlier wiring
> measured +41 kB, because importing the convert control from the route dragged
> reader chrome out of the lazy reader bundle; the row is passed down as data
> instead.
>
> Commits `afd7f1e`, `a7bd493`, `7f3c4e8`.
>
> **An incident worth recording:** during verification an agent ran the
> whole-book-delete route against a pre-existing row and **permanently destroyed
> one of the owner's books**. `LIBRARY_DATA_DIR` redirects only the database, so
> a copied DB still points at the real files. It was recovered only because an
> orphaned byte-identical duplicate happened to be on disk. `config.ts` now
> carries the warning at the definition and
> [../../wiki/open-questions.md](../../wiki/open-questions.md) records the fix
> (make the file directories overridable too).
