# Task 57 — The last reading position is written on the way out, not dropped

**Filed 2026-09-25** by the improvements sweep. Resume is routinely one page
behind.

## Context

D31 promises an **exact** resume position, and PRODUCT.md calls reading state
sacred. The hook that persists it drops the most recent position whenever the
reader stops within its debounce window.

[`use-progress-sync.ts`](../../../apps/web/src/lib/use-progress-sync.ts)
debounces every position change by `DEBOUNCE_MS = 1200` (`:40`). Both writes, the
IndexedDB `putLocalProgress` and the server `updateProgress`, live **only inside
the timer callback**, and the effect's cleanup only cancels the timer
(`:108-113`):

```ts
return () => {
  if (timer.current) clearTimeout(timer.current);
};
}, [bookId, fraction, location, versionId]);
```

The position is lost in four ordinary cases, each within 1.2 s of the last page
turn:

- **Back to the library.** The reader unmounts, the timer is cleared, and neither
  write happens.
- **Closing the tab or backgrounding the phone.** No React cleanup runs at all,
  and the timer dies with the page. Nothing listens for `pagehide` or
  `visibilitychange`.
- **Switching to the converted twin (PDF ⇄ EPUB).** `BookReader` in
  [`routes/read.tsx`](../../../apps/web/src/routes/read.tsx) is not keyed by book
  id, so the switch changes `bookId` inside one mount. The cleanup discards the
  **previous** book's pending write.
- **Switching published versions.** The same happens via `versionId`.

Every sibling persistence path already flushes on the way out:

- `lib/preferences.ts:230-236` (`pagehide` + `visibilitychange`, with a comment
  on why `pagehide` is the reliable one on mobile Safari);
- `player/use-media-progress.ts`;
- the notes and LaTeX editors.

This hook is the one exception, and it guards the most-used state in the app.

## Scope

**In:** flushing the pending position on cleanup, on `pagehide`, and on
`visibilitychange` → hidden.

**Out:** the offline reconnect flush (`flushPendingProgress`, below the hook);
the debounce interval; the server route.

## Files you OWN

- `apps/web/src/lib/use-progress-sync.ts`
- `apps/web/src/lib/library-api.ts`, only to let `updateProgress` pass
  `keepalive: true` for the page-exit path

## Files you must NOT touch

- `apps/web/src/lib/offline-store.ts`: its record shape and versioning
  (IndexedDB v5, D39) are correct as they are.
- `apps/web/src/routes/read.tsx`: fix this in the hook, not by re-keying the
  route, which would re-open the reader on every format switch.

## What to do

1. **Hold the pending write in a ref.** Store bookId, fraction, locator,
   versionId and signature. The profile is still read at fire time, per the
   existing comment.
2. **Extract the timer's body into `send(pending)`**, and call it from:
   - the timer, as today;
   - the effect cleanup, when a write is still pending. The ref holds the **old**
     bookId/versionId, so a format switch writes the previous book's position
     against the previous book's id. That property is the point; keep it;
   - `pagehide` and `visibilitychange` → hidden, registered once.
3. **Use `keepalive: true` on the exit-path PATCH** so the browser completes it
   after the page is gone. `putLocalProgress` goes first, as it does today, so the
   position survives offline regardless.
4. **Keep the dedupe.** A settled reader must still not PATCH on a loop, and a
   flush of an already-sent signature is a no-op.

## Acceptance

- **Library:** turn a page, then within one second go back to the library and
  reopen the book. It resumes on the new page. Both the server row and the
  IndexedDB record carry it.
- **Tab close:** turn a page, close the tab within a second, and reopen. It
  resumes on the new page.
- **Twin switch:** turn a page in a PDF, switch to its EPUB twin within a second,
  then go back to the PDF. The PDF resumes where it was left. The EPUB's record
  is untouched by the PDF's locator.
- **Settled reader:** it produces no repeated PATCHes (network log).
- Typecheck and build are clean.
- Verify against a scratch base with all five storage roots set inline and
  asserted before start.
