# Task 64 — EPUB metadata extraction refuses to inflate past a ceiling of its own

**Filed 2026-09-25** by the improvements sweep. One crafted upload can stall or
crash the API for the whole household.

## Context

D43 bumped `adm-zip` to 0.6.0 because "an EPUB is a zip, so the crafted-archive
4 GB allocation is reachable from an ordinary upload". So the owner already
counts crafted-archive denial of service through upload as in scope. The bump
closed the variant it was aimed at, and not this one.

adm-zip 0.6.0 inflates an entry with `zlib.inflateRawSync(…, { maxOutputLength:
<declared size> })` (`node_modules/adm-zip/methods/inflater.js`). The ceiling is
the entry's **own declared uncompressed size**, which the uploader writes. That
stops a *lying* header from causing a huge pre-allocation. It does nothing about
a *truthful* zip bomb: an entry that really does inflate to gigabytes, declares
so, and compresses to a few megabytes (DEFLATE reaches about 1000:1).

[`extract.service.ts`](../../../apps/api/src/modules/library/extract.service.ts)
calls `getData()` on three entries of every uploaded EPUB with no ceiling of its
own:

- `META-INF/container.xml` (`:214-218`);
- the OPF (`:317-318`);
- the manifest's cover image (`:328-329`), which then goes to `sharp`.

It runs for every upload (`library.service.ts`, `uploadBook`) and every Gutenberg
import (`catalog.service.ts`). `inflateRawSync` is synchronous, so while it runs
the **event loop is blocked**: every other request, every range read of a
playing song, and the single database connection (D47) all wait. Given a large
enough declared size, the process runs out of memory and the household's API is
down until the container restarts.

Who can do it: anyone with an atrium grant, which today means household members.
So the likely trigger is a pathological file rather than an attack. The fix is
the same either way, and small. The codebase already has the pattern: the
typesetting engine refuses an image whose **header** declares more than
`MAX_IMAGE_PIXELS` before inflating anything
([`packages/typeset/src/image/index.ts:572`](../../../packages/typeset/src/image/index.ts)).

## Scope

**In:** size ceilings on the three EPUB entries extraction reads, checked before
inflation; an explicit pixel limit on the cover decode.

**Out:**
- the conversion quality gate's AdmZip reads (`convert.service.ts:543-548`),
  which read Calibre's **output**, not an upload;
- PDF extraction (`pdf-to-img`, D43);
- the upload size cap (D15);
- magic-byte sniffing (D13 is locked: detection stays extension/MIME only).

## Files you OWN

- `apps/api/src/modules/library/extract.service.ts`

## Files you must NOT touch

- `apps/api/src/modules/library/convert.service.ts`
- `package.json` / the lockfile: no dependency change is needed.

## What to do

1. **Refuse before inflating.** Before each `getData()`, read the entry's declared
   uncompressed size (`entry.header.size`) and refuse above a named constant:
   - `container.xml`: 1 MB;
   - the OPF: 8 MB;
   - the cover image: 32 MB.

   Pick the numbers, put them in named constants, and explain each in a comment.
   Because adm-zip already caps output at the declared size, checking the
   declared size bounds the real inflation.
2. **Treat a refusal like any other extraction failure.** The existing `catch`
   falls back to the filename title with no cover, and it still must. A refused
   book is still a book (the current contract). Log the refusal with the entry
   name and declared size.
3. **Bound the cover decode.** Pass an explicit `limitInputPixels` to `sharp` in
   `toThumbnail`, e.g. the engine's 40,000,000, rather than relying on sharp's
   default of about 268 MP.

## Acceptance

- A crafted EPUB whose `container.xml` declares and really inflates to 2 GB
  finishes upload and appears in the library with the filename title and no
  cover. It must stay under the 50 MB upload cap; generate it in a scratch
  directory.
- During that upload, the event loop is never blocked for more than a few
  hundred ms. Measure with a concurrent `GET /health` loop, which keeps
  answering.
- The API's memory does not climb by gigabytes.
- The same holds for an oversized cover entry, and for a cover image whose header
  declares 30,000 × 30,000 pixels.
- Real books from `testing_files/` still extract the same title, author and cover
  as before.
- Typecheck and build are clean.
- Verify against a scratch base with all five storage roots set inline and
  asserted before start.
