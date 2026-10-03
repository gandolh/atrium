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

## Outcome (2026-10-03)

Done. The write side is verified in all four cases. The twin round trip's resume still fails, for a separate reason that predates this brief, filed as brief 75.

**Change** (`use-progress-sync.ts`):
- The pending position lives in a ref holding bookId, fraction, locator, versionId and signature.
- `flush(exit)` holds the old timer body and is called from:
  - the debounce timer;
  - an effect keyed on `[bookId, versionId]`, whose cleanup runs while the ref still holds the **old** ids, which covers a twin switch, a version switch and unmount;
  - `pagehide` and `visibilitychange` → hidden, registered once.
- The per-render effect's cleanup still only cancels the timer. Flushing there would write every page turn.
- The dedupe signature now includes `bookId`.
- `updateProgress` takes an optional `{ keepalive }`, set on every non-timer flush. The body is a few dozen bytes.

**Browser check.** Scratch base with all five roots asserted, scripted Ward, a generated 12-page PDF and its calibre EPUB twin.
- **Library:** four page turns, then "Back to home" in the same tick. The server row and the IndexedDB record both hold `locator "5"`. On reopen, the reader resumed on page 5.
- **Tab close:** three turns (5→8), then the tab closed at once. The server holds `8`.
- **Twin switch:** two turns back (10→8), then "Switch to EPUB" confirmed in the same tick. The PDF row got `8` against its own id, and the EPUB record holds its own CFI, not the PDF's locator.
- **Settled reader:** no PATCH in 8 s, including after synthetic `visibilitychange` and `pagehide` events.
- Typecheck and build are clean.

**Not met: "go back to the PDF, it resumes where it was left".** Switching back opened page 1 every time, then wrote page 1. The same happens with this brief's change stashed and the position written well before the switch, so it is not the write.
- The reopen path resolves the row from the cached library list and computes `initialLocation` from it.
- The twin "touch" PATCH writes that cached row's fraction back.

The evidence and a plan are in [brief 75](../todo/75-twin-switch-back-resumes-from-stale-row.md).

Side effect: leaving for the library within the debounce now sends the position twice. The keepalive PATCH goes out, and the library page's reconnect flush resends the IndexedDB record if it is still marked pending. Both carry the same values.
