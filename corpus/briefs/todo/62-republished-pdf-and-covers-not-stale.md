# Task 62 — A re-published document and a replaced cover are never served stale

**Filed 2026-09-25** by the improvements sweep. After a re-publish, the reader
can show the old PDF labelled as the newest version.

## Context

**The file route's validator assumes something publishing breaks.**
[`library.controller.ts:170-185`](../../../apps/api/src/modules/library/library.controller.ts)
answers `GET /library/:id/file` with `ETag: "<bookId>"` (or `"<versionId>"` when
`?version=` is given) and `Cache-Control: private, no-cache`. It 304s when
`If-None-Match` matches. The comment's premise is "The stored bytes for an id
never change — a re-upload gets a fresh id".

A published document breaks that premise. Its newest version's bytes are copied
**over** `library/<bookId>.pdf` on every publish, and again when the newest
version is deleted:

- [`paths.ts`](../../../apps/api/src/common/paths.ts) on `versionPdfPathFor`;
- `writeLibraryArtifacts`, [`latex.service.ts:678-710`](../../../apps/api/src/modules/latex/latex.service.ts),
  whose own comment (`:689`) says: "The library ETag is `"${id}"`, which does NOT
  change across publishes".

The web client fetches "the newest" without `?version=`
([`fetchBookFile`, `library-api.ts:206-218`](../../../apps/web/src/lib/library-api.ts)).
So after publishing v2:

1. The browser revalidates with `If-None-Match: "<bookId>"` and gets 304.
2. `fetch` hands back the cached **v1** bytes.
3. The reader shows v1 under v2's label.
4. Progress is saved against v2's id with v1's page numbers. That is the
   version/locator pairing brief 38 decision 10 exists to prevent.

**Covers are cached as immutable, and they are not immutable.**
`GET /library/:id/cover` sends `public, max-age=31536000, immutable`
(`library.controller.ts:258`), and `coverUrl(id)` carries no version
([`library-api.ts:170`](../../../apps/web/src/lib/library-api.ts)). Two paths
rewrite a cover:

- a re-publish regenerates it (`latex.service.ts:710`);
- `POST /library/:id/cover` is D40's **last-write-wins** setter, built so a
  "pick a different frame" affordance needs nothing more.

Any browser that has seen the old cover keeps it **for a year**. `public` is also
wrong on a cookie-gated response: it permits a shared cache to store it.

## Scope

**In:** validators and cache headers on the file and cover routes, plus a cover
version in the list payload so the grid can cache-bust.

**Out:**
- the per-version route (`?version=`), whose version-id ETag is correct because
  version artifacts are immutable;
- offline downloads in IndexedDB, which are explicit per-book copies (brief 20)
  and a separate question;
- Range handling.

## Files you OWN

- `apps/api/src/modules/library/library.controller.ts`
- `apps/api/src/modules/library/library.mapper.ts`
- `packages/shared/src/library-book.ts`: add the cover version to `LibraryBook`
- `apps/web/src/lib/library-api.ts`: `coverUrl` takes the version
- `apps/web/src/library/CoverCard.tsx` and any other `coverUrl` call site, only to
  pass the version

## Files you must NOT touch

- `apps/api/src/common/paths.ts` and `writeLibraryArtifacts`. The overwrite is
  deliberate: it keeps `GET /library/:id/file` free of a special case, as the
  `paths.ts` comment explains. Fix the validator, not the storage.

## What to do

1. **File route, without `?version=`:** derive the ETag from the file actually
   on disk. The route already `stat`s it for `Content-Length`, so use a weak
   validator such as `W/"<size>-<mtimeMs>"`. That covers every rewrite path,
   present and future, with no knowledge of versions. Keep the version-id ETag
   for `?version=`. Move the 304 check after the `stat`.
2. **Cover route:** `private`, never `public`. Either:
   - (a) keep `immutable` but require a cache-busting `?v=` that changes when the
     file does, or
   - (b) drop `immutable` and revalidate against an mtime validator.

   Prefer (a): a grid of a hundred covers should not revalidate a hundred times
   per library open.
3. **Put the version on the wire.** `toLibraryBook` already `stat`s the cover
   (D39: `hasCover` is a stat). Take `mtimeMs` from the **same** stat and send it
   as `coverVersion: number | null`. Keep `hasCover` derived from it for
   compatibility. `coverUrl(id, coverVersion)` appends `?v=`.

## Acceptance

Against a scratch base with all five storage roots set inline and asserted before
start:

- **Re-publish:** publish v1 and open it. Change page 1 and publish v2, then
  reopen without `?version=`. The reader shows v2's bytes: no 304 for the old
  validator, and the network log shows a 200 with v2's size.
- **Delete newest:** deleting v2 then reopening shows v1's bytes again.
- **Replace a cover:** replace a video's cover through `POST /library/:id/cover`,
  then return to the grid. The new cover shows without a hard reload.
- **Headers:** the cover response is `private`, and an unchanged book still gets
  a 304 on reopen.
- Typecheck and build are clean. For the web card changes, run the design
  conformance checklist in [design.md](../../wiki/design.md).
- Note that [brief 54](54-latex-compile-slot-keyed-on-subject.md) must land first
  for publishing to work at all.
