# Task 76 — Reopening a book in the same session refetches it when it changed

**Filed 2026-10-03** while verifying brief 62.

## Context

Brief 62 fixed the HTTP validator. After a re-publish, a browser that
revalidates `GET /library/:id/file` now gets a 200 with the new bytes, not a
304. That holds on a fresh page load.

Within **one SPA session** the reader never asks:

1. Open a published document. The reader store holds the file
   (`loadedFile`, `loadedBookId`).
2. Publish a new version, whether from the LaTeX editor in the same tab or
   anywhere else.
3. Go back to the library and open the document again from its tile.
4. `useHydrateBook`'s `needsHydrate` is `!loadedFile || loadedBookId !== bookId`,
   which is false, so no request goes out. The reader shows the old bytes.

Seen 2026-10-03 on a scratch base: v3 was published, the tile reopened, the
network log showed no `/file` request, and the reader showed v2's text under a
"Version 2" label. Nothing in the reader flow calls `clearLoadedBook()`; it fires
only on a profile switch and a re-lock.

The label and bytes were stale **together**, because the versions query was
cached too, so brief 38 decision 10's pairing held. It is still the wrong
document. The most likely way to hit this is the author's own flow: read the
document, publish an edit, open it again.

## Scope

**In:** deciding when an in-memory loaded file may be reused for a reopen.

**Out:** the HTTP validators (brief 62, done) and offline copies (brief 20).

## Files you OWN

- `apps/web/src/lib/use-hydrate-book.ts`
- `apps/web/src/store/reader-store.ts`, only if the loaded file needs to carry
  what it was fetched as

## What to do

1. Record what the in-memory file was fetched as. That could be the response's
   `ETag`, or the row's `sizeBytes` plus the newest version id.
2. On reopen, compare it with the fresh library row or a conditional request.
   Reuse the file only on a match; otherwise hydrate again. A conditional
   `fetch` with the stored validator costs one 304 when nothing changed.
3. Make sure the versions query refreshes on reopen too, so the label follows
   the bytes.

## Acceptance

- Open a published document, publish a new version in the same tab, reopen it
  from the library: the reader shows the new version's bytes and label.
- Reopening an unchanged book costs at most one 304, with no full download.
- Typecheck and build are clean. Verify against a scratch base with all five
  storage roots set inline and asserted before start.
