# Brief 08: Spike: a smaller Calibre for `ebook-convert`

**Depends on:** brief 07 built first, so the two size changes are measured
apart.

## Context

After brief 07, Calibre is most of `atrium-api`. Its layer was 804 MB on the
box on 2026-11-24 (`apt-get install --no-install-recommends calibre wget
ca-certificates` on bookworm). The API shells out to `ebook-convert` in both
directions, PDF→EPUB and EPUB→PDF ([conversion.md](../../wiki/conversion.md)).
Calibre writes PDF through Qt WebEngine, so Qt stays. The open question is
only how Calibre gets into the image.

Two ways to compare:

- **Debian's `calibre` package** (today): built on the system's Python and Qt,
  with their dependency tree. Its version is whatever bookworm ships.
- **Calibre's own Linux binary**, from calibre's download page: a tarball with
  its own Python and Qt, unpacked into one folder, plus a few system libraries
  the page lists. It is also a newer Calibre.

The image is otherwise unchanged by this brief, and it was the box's disk that
asked for it (vps-deploy's decisions: the box gets no extra storage).

## Decisions

- A spike: measure first, and change the Dockerfile only when the bar below is
  met.
- The bar: the image shrinks by at least 150 MB, and both directions convert
  every sample into a file that opens in Atrium's reader with the same page or
  chapter count as today's output. Otherwise the apt package stays and the
  outcome says which part of the bar failed.
- A build-time download is pinned to one version and checked against a
  SHA-256 written in the Dockerfile.

## Files you OWN

- `infrastructure/Dockerfile`, only if the bar is met
- `corpus/wiki/conversion.md`, a short section with the measurements
- A scratch folder outside the repo for the trial builds

## Files you must NOT touch

- `apps/api/src/features/library/calibre.service.ts` and the convert service:
  the command stays `ebook-convert`.
- Any `package.json` or lockfile.

## What to do

1. The cheap check first. Download the current Linux tarball from calibre's
   download page, unpack it, and `du -sh` the folder. Read the page's list of
   system libraries it needs, then `apt-get install -s --no-install-recommends`
   them in a bookworm-slim container to see what they would add. If the folder
   plus those libraries can't come in 150 MB under today's 804 MB layer, stop
   here and write that down.
2. Otherwise build two throwaway images from the same `prod` stage, one with
   today's apt line and one with the tarball (pinned, checksum checked,
   unpacked to `/opt/calibre`, `ebook-convert` on PATH) and the smallest set
   of libraries that converts both ways.
3. Measure each: the Calibre layer from `docker history`, the whole image, and
   the time and peak memory of PDF→EPUB and EPUB→PDF on three samples (a
   text-heavy EPUB, an illustrated EPUB, a born-digital PDF; no scans, and none
   of the owner's books).
4. Compare the outputs: page or chapter count, images present, and the file
   opens in Atrium's reader.
5. If the bar is met, change the Dockerfile and keep its header comment's
   reasoning current. If not, change nothing.
6. Write the measurements and the verdict into `conversion.md`.

If your session can't build images, write the two Dockerfile variants and the
measuring script, and hand back for the controller to run them.

## Acceptance

- `conversion.md` has a table: packaging, Calibre version, layer size, image
  size, time and memory per sample and direction, output check.
- Either the Dockerfile uses the tarball, the image is at least 150 MB smaller
  and every sample conversion passes, or the Dockerfile is unchanged and the
  outcome names the part of the bar that failed.
- `npm run check` passes.
- If the Dockerfile changed, the deploy is the owner's step:
  `node cli.ts atrium deploy` from vps-deploy.

## Outcome (2026-11-24)

The cheap check failed the bar, so the spike stopped there and changed nothing in the repo's code. Calibre 9.19.0's Linux tarball is 241 MB packed and unpacks to 912 MB; the libraries its download page names add about 30 MB over bookworm-slim. Today's apt layer measures 767 MB, so the tarball layer is about 175 MB larger, where the bar needs it 150 MB smaller. Deleting the grammar checker, translations and devtools pak projects to about 650 MB, about 110 MB under today's layer: still short, and a hand-trimmed vendor tarball is fragile. No image was built; the conversion half of the bar and the uid 1000 WebEngine sandbox were not reached. The Dockerfile is unchanged and stays on the apt package. Table and the pin that would have been used: [conversion.md](../../wiki/conversion.md).

Correction to this brief: the deploy step for a Dockerfile change would have been `node cli.ts atrium server`, not `deploy` (which ships only the web client). Nothing changed, so there is no deploy.
