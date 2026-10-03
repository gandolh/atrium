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

## Outcome (2026-10-03)

Done.

**Change** (`extract.service.ts` only). `readEntry(entry, limit)` checks `entry.header.size` before `getData()`, and above the limit it logs `[extract] refused EPUB entry "<name>": declares N bytes, limit L` and throws into the existing extraction `catch`. The limits:

| Constant | Limit | Applies to |
|---|---|---|
| `MAX_CONTAINER_BYTES` | 1 MiB | `container.xml` |
| `MAX_OPF_BYTES` | 8 MiB | the OPF |
| `MAX_COVER_ENTRY_BYTES` | 32 MiB | the cover entry |

- A refused container or OPF falls back to the filename title with no cover, as any extraction failure does.
- A refused cover keeps the OPF's title and author.
- Every `sharp` decode in the file (book, PDF, audio and video covers) passes `limitInputPixels: 40_000_000`, the engine's `MAX_IMAGE_PIXELS`.
- Each constant carries a comment explaining it.

**Tests:**
- `test/zip-builder.ts` is a small zip writer. A `zeros(n)` entry is deflated as a stream, so it truly inflates to `n` and declares it.
- `test/extract-limits.test.ts` covers:
  - an ordinary EPUB, which still yields title, author and cover;
  - a 64 MiB container, refused with the log line, giving the filename title and no cover;
  - a 16 MiB OPF, refused;
  - a 64 MiB cover, refused, with the OPF metadata kept;
  - a PNG whose header declares 30,000²;
  - a real, decodable 8,000² (64 MP) PNG, which sharp's own ~268 MP default would accept and the 40 MP limit refuses;
  - an upload of the container bomb through `POST /library`, giving 201, the filename title and no cover.
- Four of these fail on the old code. The 30,000² header-only case passes either way, since it is over sharp's default too.
- 59 API tests pass, and typecheck and build are clean.

**Scratch-base acceptance** (all roots asserted, scripted Ward), with two 2.09 MB EPUBs whose `container.xml` or cover **truly inflates to 2 GiB − 1**:
- Both uploads answered 201: `Bomb-container` with no author or cover, and `Bomb Title` / `Nobody` with no cover.
- A concurrent `GET /health` loop (183 requests over 4 s each time) peaked at **42 ms** and **37 ms**.
- API RSS stayed at about 358 MB (peak +1.1 MB).
- Both refusals were logged.

**Real books.** `testing_files/`, one PDF and one EPUB, extract identical title, author and cover hash with the old and new code.
