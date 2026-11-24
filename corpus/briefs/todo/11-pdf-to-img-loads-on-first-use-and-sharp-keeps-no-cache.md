# Brief 11: pdf-to-img loads on first use, and sharp keeps no cache

**Depends on:** nothing. **Runs after:** 10.
**Builder:** Sonnet.
**Before you start:** run `brief-board guide` (the repo's `CLAUDE.md` says so).

Filed 2026-11-24 from the estate's infra review. The owner's answer that day: reduce what each app uses on the
box rather than cap its memory (the box has 3.7 GiB and no upgrade). `atrium-api` used 100 MiB on the box on
2026-11-24, the third-largest app.

## Context

- `apps/api/src/features/library/convert.service.ts:6` imports `pdf` from `pdf-to-img` at module load, so pdfjs
  is loaded at every boot. It is used once, at line 630, when a PDF is converted. Nothing at boot needs it.
- sharp is imported in `features/library/extract.service.ts:3` and `features/lookup/service.ts:1`. Nothing calls
  `sharp.cache()` or `sharp.concurrency()`, so libvips keeps its default cache (50 MB and 20 files) and starts one
  thread per core. Atrium processes one cover or thumbnail at a time, on user actions.
- Estimate (not measured): 15-30 MiB of resident memory between the two. The measurement is this brief's.

## Decisions

- `pdf-to-img` is imported with `await import("pdf-to-img")` inside the function that uses it. The type import can
  stay static.
- `sharp.cache(false)` and `sharp.concurrency(1)` run once at startup, in one place both services' sharp import
  goes through (a small module beside them, or the server's start-up), with a comment giving the reason.
- If step 1 shows a saving under 5 MiB for either change, keep the change anyway only if it costs nothing in
  latency (a thumbnail batch or a cover extraction no more than 20% slower); otherwise drop that half and say so.

## Files you OWN

- `apps/api/src/features/library/convert.service.ts`
- `apps/api/src/features/library/extract.service.ts`, `apps/api/src/features/lookup/service.ts`, and a new
  module for the sharp settings if you add one
- Their tests
- The closeout: the outcome note, `corpus/log.md`, `corpus/wiki/status.md`

## Files you must NOT touch

- `infrastructure/Dockerfile` (brief 10 owns it).
- The Calibre call and the conversion's queueing in `calibre.service.ts`.

## What to do

1. **Measure today.** Start the API locally on a scratch data folder (the storage roots point there), wait 30 s,
   and read its resident memory (`ps -o rss= -p <pid>`). Then upload one PDF (cover extraction) and read it
   again. Do it three times and keep the median.
2. Make the two changes.
3. Measure the same way.
4. Time a cover extraction and a thumbnail for the same files before and after.

## Acceptance

- [ ] The outcome has the before and after readings: idle after boot, after one PDF upload, and the timings.
- [ ] PDF upload still gives a cover; PDF to EPUB still converts; a thumbnail still renders.
- [ ] A test covers the conversion path through the lazy import (an existing one may already; say which).
- [ ] `npm run check` exits 0; `bash corpus/lint.sh` passes.
- [ ] End move `ready_for_deploy`.

## Owner steps

- `node cli.ts atrium server` from vps-deploy. It can ship in the same deploy as brief 10.
