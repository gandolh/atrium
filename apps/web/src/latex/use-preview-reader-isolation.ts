import { useEffect } from "react";

import { useReaderStore } from "../store/reader-store";

/**
 * Keep the LaTeX **preview** out of the real reader's reading-progress state.
 *
 * ## The trap
 * `LatexPreviewPane` mounts a SECOND `<PdfReader>` — the same component the
 * `/read` reader uses, reused byte-for-byte on purpose (brief 38: if
 * `PdfReader` looks like it needs changing, the design is wrong). `PdfReader`
 * does not take its position as a prop: it reads and writes the module-level
 * `useReaderStore` singleton directly (`setCurrentLocation`,
 * `setProgressFraction`, and `initialLocation` on mount). So scrolling a
 * COMPILE PREVIEW writes into exactly the same three fields the real reading
 * session uses — while `loadedBookId` still names whatever book was last open,
 * because nothing on this route ever cleared it (`clearLoadedBook` fires only
 * on a profile switch).
 *
 * The damage lands later, not here. Return to `/read?book=abc`,
 * `useProgressSync` remounts, sees `loadedBookId = "abc"` beside the PREVIEW's
 * `currentLocation`/`progressFraction`, passes its `fraction !== null` guard,
 * and schedules a PATCH 1200ms out. If the real file download takes longer than
 * that debounce — routine for a large PDF on a slow link — the corrupt PATCH
 * lands first and overwrites book `abc`'s stored locator and progress with a
 * page number from a LaTeX draft. This is the same shape as the brief 35 bug
 * where a profile switch left the reader loaded and wrote one profile's page
 * into another's row.
 *
 * ## The fix
 * A preview of a draft is not a reading session, so for as long as one is
 * mounted this route owns no reading-progress state at all:
 *
 * - **On mount** the five progress-bearing fields are snapshotted and
 *   neutralised. With `loadedBookId === null`, `useProgressSync` is a no-op by
 *   its own first guard, so nothing the preview writes can ever reach the
 *   server. With `initialLocation === null`, the preview also opens at page 1
 *   instead of resuming the last book's page inside an unrelated draft.
 * - **On unmount** the snapshot goes back exactly as it was, so leaving the
 *   editor hands the real reader the session it had — same book, same page,
 *   same in-memory `File` (`loadedFile` is deliberately NOT touched: clearing
 *   it would force a full re-download of a book that never went anywhere).
 *
 * Ordering is not load-bearing: React flushes an unmounting subtree's effect
 * cleanups before the newly mounted route's effects, but even if it did not,
 * `useProgressSync` subscribes to this store — a restore that landed a tick
 * late would simply re-run it with the correct values.
 *
 * Written through `setState` rather than a store action on purpose: "snapshot
 * and put back this exact slice" is this route's problem, not a concept the
 * shared reader store should grow an API for. Do not simplify this into
 * `clearLoadedBook()` — that also drops `loadedFile`, `zoom` and the resume
 * position, i.e. it destroys the reading session instead of stepping around it.
 */
export function usePreviewReaderIsolation(): void {
  useEffect(() => {
    // Read at effect time, never from a render-phase closure: this must capture
    // the reading session as it actually is at the moment the editor takes over
    // (and, under StrictMode's mount → cleanup → mount, the values the first
    // cleanup just restored).
    const { loadedBookId, loadedVersionId, initialLocation, currentLocation, progressFraction } =
      useReaderStore.getState();

    useReaderStore.setState({
      loadedBookId: null,
      loadedVersionId: null,
      initialLocation: null,
      currentLocation: null,
      progressFraction: null,
    });

    return () => {
      useReaderStore.setState({
        loadedBookId,
        loadedVersionId,
        initialLocation,
        currentLocation,
        progressFraction,
      });
    };
  }, []);
}
