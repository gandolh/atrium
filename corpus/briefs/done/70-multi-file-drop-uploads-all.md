# Task 70 — Dropping several files adds all of them, or says why not

**Filed 2026-09-25** by the improvements sweep. Drop an album of twelve MP3s and
one track is added, silently.

## Context

[`UploadZone.tsx`](../../../apps/web/src/library/UploadZone.tsx) reads exactly
one file from each of its three entry points, and ignores the rest without a
word:

- the window-level drop target (`:130-137`): `e.dataTransfer?.files?.[0]`;
- the hero drop zone (`:150-156`): `event.dataTransfer.files[0]`;
- the picker (`:161-165`): the `<input type="file">` has no `multiple`, and
  reads `e.target.files?.[0]`.

The component's contract is `onFile: (file: File) => void`. The parent,
[`LibraryHome.tsx:268, 353`](../../../apps/web/src/library/LibraryHome.tsx), maps
it to `upload.mutate(file)`, one request per file. The API takes one file per
request (`files: 1` in [`app.ts`](../../../apps/api/src/app.ts)'s multipart
limits, and that is fine).

Since brief 23, the library holds **music**, and music arrives as albums. Adding
one means dropping a dozen files. Dropping several books at once is equally
natural, and so is expecting all of them to arrive. Today the first file uploads
and the rest disappear. Nothing shows an error, a count, or any sign that most of
the drop was discarded.

## Scope

**In:** accepting every dropped or picked file; validating each; uploading them
**one after another**; showing progress through the queue and naming any file
rejected, with its reason.

**Out:**
- parallel uploads (the API has one DB connection and CPU-bound extraction, so a
  queue is kinder);
- folders or directory traversal (`webkitGetAsEntry`);
- server changes;
- deduplication.

## Files you OWN

- `apps/web/src/library/UploadZone.tsx`
- `apps/web/src/library/LibraryHome.tsx`: the upload call sites only
- `apps/web/src/lib/use-library.ts`: `useUploadBook`, only if the queue lives
  there

## Files you must NOT touch

- `apps/api/**`.
- `packages/shared/src/file-validation.ts`: validation stays the shared
  extension/MIME check (D13).

## What to do

1. **Accept every file.** Widen the contract to `onFiles: (files: File[]) =>
   void`. Read every file from both drop targets and from the picker, and add
   `multiple` to the input.
2. **Validate each file on its own.** Rejected files are named in one message,
   e.g. "2 files weren't added: notes.docx, cover.png (unsupported type)"; the
   valid ones proceed. One bad file never blocks the rest.
3. **Upload sequentially.** Run a small client-side queue of N sequential
   `upload.mutate` calls, invalidating the library once at the end (or after each
   file, if that reads better).
4. **Show the queue.** Show "Adding 3 of 12…" using the existing upload busy
   state, with the per-file progress the single upload already shows. On a
   failure mid-queue, continue with the rest and report which failed.
5. **Keep it a utility.** Follow PRODUCT.md principle 5 ("the utility stays a
   utility"): plain and efficient. Run the design conformance checklist in
   [design.md](../../wiki/design.md): theme tokens only, accent for state only,
   all three themes, and a reduced-motion path for any progress animation.

## Acceptance

- Dropping 3 valid files and 1 invalid one: 3 items appear in the library in drop
  order, and the invalid one is named with its reason.
- Picking 3 files through the picker does the same.
- A single-file drop or pick behaves exactly as before.
- Killing the API mid-queue: the failed file is reported, and a restart plus
  retry adds the rest.
- Typecheck and build are clean, and the design checklist passes.
- Verify against a scratch base with all five storage roots set inline and
  asserted before start.

## Outcome (2026-10-03)

Done.

**`UploadZone`:**
- `onFile(file)` became `onFiles(files)`.
- The window drop target, the hero drop zone and the picker hand up every file. The input gained `multiple`.
- Each file is validated on its own (D13's shared check):
  - A **single** invalid file keeps the original message, so a one-file drop reads as before.
  - With several, the rejected ones are named: "1 file wasn't added: notes.docx (unsupported type). …".
  - Valid files proceed regardless.
- An optional `busyLabel` replaces the hero button's fixed "Uploading…". "Upload a file" now reads "Upload files".

**`useUploadQueue`** (in `use-library.ts`):
- It sends files one after another through the existing `useUploadBook` mutation, so the library refreshes and video covers are captured per file, as before.
- Files dropped mid-queue join its end.
- A failed file is recorded by name and the queue continues. The list clears when the next batch starts from idle.

**`LibraryHome`** shows "Adding 3 of 12…" on the header button and the hero button while a queue of several runs, and "Uploading…" for one. The failure alert names the file, or lists several.

**Browser check** (scratch base, all roots asserted, scripted Ward):
- **Window drop of Alpha, Beta, notes.docx and Gamma:**
  - the label went "Adding 1 of 3…", then 2, then 3;
  - three sequential `POST /library` landed, created in drop order (Alpha, Beta, Gamma);
  - notes.docx was named in the alert.
- **The picker with three files:** the same queue.
- **Single files:** a single valid drop showed "Uploading…", and a single `.txt` showed the original unsupported-type message.
- **API killed after the first of three 10 MB uploads:**
  - Theta had already landed;
  - **Iota** was reported, "Upload failed: Iota.pdf. Is the API running?…";
  - after a restart, re-dropping Iota added it and cleared the alert.

**Design checklist.**
- Existing tokens and classes only; the alert reuses the danger styling.
- No accent on anything new, and no new animation, so there is nothing for reduced motion to stop.
- `tabular-nums` added to both buttons, now that they show counts.

Typecheck and build are clean.
