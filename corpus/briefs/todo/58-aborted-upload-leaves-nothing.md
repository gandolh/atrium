# Task 58 — An aborted or failed upload leaves no file behind

**Filed 2026-09-25** by the improvements sweep. Each dropped upload leaks up to
`MAX_UPLOAD_MB` of disk, and nothing ever reclaims it.

## Context

[`uploadBook`](../../../apps/api/src/modules/library/library.service.ts)
(`library.service.ts:65-135`) streams the upload **straight to its final name**
and has no cleanup for a failure:

```ts
const id = randomUUID();
const filePath = filePathFor(id, format);
await mkdir(LIBRARY_FILES_DIR, { recursive: true });

await pipeline(file, createWriteStream(filePath));   // ← rejects on abort; nothing removes filePath
```

What each failure leaves behind:

- **A client that drops mid-upload** (tab closed, phone loses signal): the part
  stream is destroyed, `pipeline` rejects with `ERR_STREAM_PREMATURE_CLOSE`, and
  the partial file stays at `library/<uuid>.<ext>`. Reproduced during the sweep
  with `@fastify/multipart` 10.0.0: a 3,000,000-byte partial file remained.
- **A full disk** (ENOSPC mid-write): the same outcome.
- **A throw from `insertBook`** (`:133`): the complete file **and** the cover
  thumbnail written at `:94` stay, with no row.

The Gutenberg import has the same shape
([`catalog.service.ts:91-140`](../../../apps/api/src/modules/catalog/catalog.service.ts)):
`writeFile` to the final path, then the cover, then `insertBook`, with no
cleanup. Its bytes are already in memory, so it cannot abort mid-stream, but a
failed insert or a full disk leaves the same orphans.

Nothing ever finds these files:

- [`sweepInterruptedOutputs`](../../../apps/api/src/modules/library/convert.service.ts)
  (`convert.service.ts:117-129`) matches only `*.converting.*`;
- the D46 orphan sweep covers thumbnails only;
- `hasCover` / `GET /library` read rows, never the directory.

The LaTeX upload route wraps the same `pipeline` in try/rm. This route never got
that treatment.

## Scope

**In:** both write paths (upload and catalog import), from the first byte written
to the row inserted, plus reclaiming an interrupted upload after a crash.

**Out:** the D46 thumbnail sweep and its guards; conversion outputs; the
multipart size limit (D15); a general orphan-file sweep of `LIBRARY_FILES_DIR`.
Deleting files that look live at boot is the risk D46 argued over, and this brief
must not reopen it.

## Files you OWN

- `apps/api/src/modules/library/library.service.ts`
- `apps/api/src/modules/catalog/catalog.service.ts`
- `apps/api/src/modules/library/convert.service.ts`, only to widen
  `sweepInterruptedOutputs` to the new in-progress suffix (step 3)

## Files you must NOT touch

- `apps/api/src/common/paths.ts`: `filePathFor` / `coverPathFor` stay the only
  definition of a final path. The temp name is derived from it; it does not
  replace it.
- `apps/api/src/modules/library/library-maintenance.service.ts` (D46).

## What to do

1. **Write to an in-progress name and rename on success.** Use
   `filePathFor(id, format) + ".uploading"` in the same directory, so the rename
   is atomic. A final-named file then always means a completed write.
2. **Clean up on every failure path** from the first write to `insertBook`:
   remove the in-progress file, the final file if the rename happened, and the
   cover if one was written. Wrap the sequence in `try`/`catch` and rethrow. Keep
   the existing early returns (`TOO_LARGE`) as they are. Do the same in the
   catalog import, which can write the final name directly because its bytes are
   in memory, but must remove file and cover when the insert fails.
3. **Reclaim after a crash.** A process killed mid-upload leaves a
   `*.uploading` file that no request will ever finish. Extend the existing boot
   sweep (`sweepInterruptedOutputs`) to delete names matching
   `^<uuid>\.<ext>\.uploading$` as well as `.converting.`. This is safe where a
   general sweep would not be: the suffix exists only for a write that never
   completed, which is exactly the argument the `.converting.` sweep already
   rests on.

## Acceptance

Against a scratch base with all five storage roots set inline and asserted before
start:

- A 20 MB upload with the client killed halfway (e.g. `curl --limit-rate` then
  `kill`) leaves **no** file in `LIBRARY_FILES_DIR`.
- An upload whose `insertBook` is forced to throw leaves no file and no thumbnail.
- The same holds for the catalog import.
- A planted `<uuid>.pdf.uploading` is removed at boot and logged.
- Final-named files and other names are untouched.
- A normal upload and a normal import behave exactly as before: same row, same
  cover, same response.
- Typecheck and build are clean.
- If [brief 63](63-api-test-harness.md)'s harness exists, the abort case is a test.
