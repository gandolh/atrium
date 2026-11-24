---
summary: Convert — the same book in either format, as linked library rows produced by an async Calibre job. Both directions, cancellable, quality-graded, and read in-app.
updated: 2026-11-24
---

# Convert (PDF ⇄ EPUB)

**Convert** is one verb for both directions (D34). A conversion produces a
**converted book** — its own `books` row, linked to its **source book** — which
is read in-app like any other. It is not an export.

This page was rewritten by the convert work (2026-08-26). Everything it previously described (a
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
[db/library-store.ts](../../apps/api/src/db/library-store.ts). Because cross-library
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

## Runs as a non-root user

EPUB→PDF goes through Calibre's Qt WebEngine (Chromium), which will not start as
root unless its sandbox is switched off. Until brief 09 (2026-11-24) the image had
no `USER` line, so every EPUB→PDF failed with "Running as root without
--no-sandbox is not supported" (PDF→EPUB never touches WebEngine and worked). The
image now ends in `USER node` (uid 1000) and the sandbox stays on:
`QTWEBENGINE_CHROMIUM_FLAGS=--no-sandbox` was rejected, because it would render
uploaded books in Chromium with the sandbox off. A local run confirmed EPUB→PDF
finishes and downloads a PDF with no extra flag or capability.

What the API writes at run time: the five storage roots (`data`, `library`,
`images` with `thumbnails/`, `latex`, `versions`, all under `/app/apps/api`),
`/tmp`, and Calibre's config and cache under node's `HOME` (`/home/node`). The
image creates the roots owned by `node`, but a bind mount takes its owner from the
host folder, so on the VPS (rootless daemon, where container root is the deploy
account and uid 1000 is a subuid) the folders must be handed to uid 1000 once.
Without it, an image with `USER node` can't write its database: the API
crash-loops on `SQLITE_READONLY_DIRECTORY`. That happened in the 2026-11-24
rollout, and vps-deploy's server phase still reported ok.

`docker exec` can't reach a container that keeps restarting, and the step needs
no container name: compose starts a one-off container from the service, with the
same bind mounts, as user 0. As the service account on the box, in the API's
server directory:

```
export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock
docker compose -f infrastructure/docker-compose.yml stop atrium-api
docker compose -f infrastructure/docker-compose.yml run --rm --no-deps -u 0 --entrypoint chown atrium-api \
  -R 1000:1000 /app/apps/api/data /app/apps/api/library /app/apps/api/images /app/apps/api/latex /app/apps/api/versions
docker compose -f infrastructure/docker-compose.yml start atrium-api
```

Then open the live site, open a book and save a note. The step does nothing
harmful when the folders already belong to uid 1000.

A plain host `chown -R 1000:1000` is wrong under a rootless daemon: it would not
map to container uid 1000. Nothing on the host writes into these folders (the
deploy's rsync excludes them, and the stack's service-directory `chown` is not
recursive). A fresh box would still need the step: having vps-deploy's atrium stack
apply the ownership itself is a follow-up there.

## Calibre packaging: the tarball is not smaller (2026-11-24)

A spike (brief 08) compared Debian's `calibre` package with Calibre's own Linux
tarball. The cheap check failed the bar, so no image was built and the Dockerfile
is unchanged. The bar was: the image shrinks by at least 150 MB, and both
directions convert every sample at the same page or chapter count.

| Packaging | Calibre | Calibre layer | Image | Conversions |
| --- | --- | --- | --- | --- |
| Debian bookworm `calibre`, `--no-install-recommends` (today) | bookworm's | 767 MB (`docker history`) | 1.25 GB | the walk passes, EPUB to PDF as uid 1000 since brief 09 |
| Calibre's tarball, unpacked untrimmed | 9.19.0 | 912 MB folder plus about 30 MB of system libraries | not built | not run |

- The tarball is 241 MB packed (`.txz`) and unpacks to 912 MB: `lib` 526 MB (Qt
  WebEngine core alone is 193 MB, `calibre-extensions` 136 MB), `resources` 318 MB
  (245 MB of it the grammar checker's `langtool`), `translations` 40 MB, `share` 20 MB.
- The libraries Calibre's download page names (X11-XCB, EGL and OpenGL, plus the Qt
  WebEngine set of nss, fontconfig, xkb and friends) add about 30 MB over
  bookworm-slim, measured by installing them with `--no-install-recommends`.
- So the tarball layer is about 175 MB larger than the apt layer, where the bar needs
  it 150 MB smaller. Deleting `langtool`, `translations` and the devtools pak
  (all unneeded by the CLI) is a projection, not a measurement: it lands near 650 MB,
  about 110 MB under today's layer, still short, and the rest of the tree (Qt, ICU,
  the extensions, onnxruntime) is what the conversion runs on. Trimming a vendor
  tarball by hand would also be a fragile fork of the build.
- Failed part of the bar: the size. The conversion half, and whether Qt WebEngine's
  sandbox starts as uid 1000 from the tarball, were not reached.
- The pin, had it passed: version 9.19.0, SHA-256
  `35c1cbda1a2548aceeb89cb0a4be47a36025b5dc102ac046f7eaf98ba46a452d` for
  `calibre-9.19.0-x86_64.txz`, taken from a download over HTTPS because the download
  site publishes no checksum file (its `.sha512` URL returns an HTML page). The
  `code.calibre-ebook.com` host failed certificate verification and was not used.
- Revisit if the box's disk pressure changes or Debian's package grows; the numbers
  above are the baseline.

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

- [convert.service.ts](../../apps/api/src/features/library/convert.service.ts) — the runner, the
  single-flight guard, the quality gate, the boot sweep.
- [calibre.service.ts](../../apps/api/src/features/library/calibre.service.ts) — the `ebook-convert` wrapper. The tests that need Calibre probe for it once and skip with "Calibre not installed" when it is missing (2026-10-27).
  Format-agnostic; it always was. Spawns with `PYTHONNOUSERSITE=1` so a pip
  `lxml` can't shadow the distro one — load-bearing, not theoretical.
- [features/library/routes.ts](../../apps/api/src/features/library/routes.ts) — convert, cancel /
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
