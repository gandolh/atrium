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

## Outcome (2026-10-03)

Done as scoped. **The brief's diagnosis was only half the story**, and the other half is filed and fixed as [brief 78](78-publish-releases-positions-on-the-superseded-version.md).

**Change** (`use-hydrate-book.ts`). On mount, a `useLayoutEffect` checks whether the book in memory is the one being opened and a version is tagged (`loadedVersionId !== null`, meaning a published document with two or more versions). If so it calls `clearLoadedBook()`, and the ordinary hydrate runs.

Re-tagging in place is not enough. `VersionPicker`'s default selection only runs while no version is tagged, and it assumes the loaded bytes are the newest, which a reused in-memory file need not be. So the copy is dropped: one download of a small published PDF. Unversioned books are immutable per id and keep the in-memory reuse. ETag revalidation was considered, but `fetchBookFile` does not expose the response, and that file is outside this brief.

**What the scratch run actually showed.** On a **fresh page load**, the reader still opened "Version 2" while v3 existed. `pickDefaultVersion` returns `currentVersionId`, the version the saved position was measured in, whenever it still exists. Reading the newest version records it, so it stayed the default after every later publish. That breaks brief 38's decision 9 ("the latest version, or the version you were last reading if you had explicitly opened an older one") and decision 10 ("…publish v4, you will resume from page 0 of v4"). The brief-62 observation that led to this brief was mostly that, not the in-memory reuse. Brief 78 releases those positions at publish time.

**Browser check** (scratch base, all roots asserted, scripted Ward, the "Versioned" document):
- Back to the library, then reopen from the tile, in the same session: a `GET /library/:id/file` now goes out, where before none did.
- With brief 78, the reader was on v3, v4 was published, and the document was reopened from the tile in the same session. It showed "Fourth edition." under **Version 4**.

Typecheck and build are clean.
