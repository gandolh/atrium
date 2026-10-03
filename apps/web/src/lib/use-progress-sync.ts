import { useCallback, useEffect, useRef } from "react";
import type { LibraryBook } from "@ebook-reader/shared";

import { useReaderStore, type ReaderLocation } from "../store/reader-store";
import { ApiError } from "./api-client";
import { useAuthStore } from "./auth";
import { updateProgress } from "./library-api";
import {
  deleteLocalProgress,
  listPendingProgress,
  markLocalProgressSynced,
  putLocalProgress,
} from "./offline-store";

/**
 * Persists reading progress back to the library, per-user (D24). Watches the
 * active reader's `progressFraction` (drives the cover bar) AND its exact
 * `currentLocation` (page number / CFI), and PATCHes both to
 * `/library/:id/progress`, debounced so page turns don't hammer the server.
 * No-op when the current book wasn't opened from the library (`loadedBookId ===
 * null`, e.g. dev samples).
 *
 * The saved locator is what lets a refresh / reopen land back on the exact page
 * the user left off at (the reader seeds its start position from it).
 *
 * Offline (brief 20): every debounced tick ALSO writes a local progress record
 * (IndexedDB), so reading position survives offline and a reload. When the PATCH
 * succeeds the local record is marked synced; when it fails (offline) the record
 * stays pending and `flushPendingProgress` / `useReconnectProgressSync` push it
 * once on reconnect — last-write-wins, no queue of intermediate positions.
 *
 * Profiles (brief 35 step 7): the local record is tagged with whoever is
 * active on THIS device at write time, so a flush that lands after a profile
 * switch still attributes the position correctly instead of writing it to
 * whoever happens to be active when the network comes back. The live PATCH
 * below is left untagged on purpose — it fires in real time under the current
 * session, which the server already resolves to the right profile; the
 * explicit `profileId` only matters for a PATCH sent later, by the flush.
 */
const DEBOUNCE_MS = 1200;

/** Match tolerance for the coarse progress fraction when comparing to a server row. */
const FRACTION_EPSILON = 1e-4;

/** Serialize the reader's location to the opaque wire locator (page → string). */
function serializeLocator(location: ReaderLocation): string | null {
  if (location === null) return null;
  return typeof location === "number" ? String(location) : location;
}

/** One position waiting to be written, captured with the ids it belongs to. */
interface PendingWrite {
  bookId: string;
  fraction: number;
  locator: string | null;
  versionId: string | null;
  signature: string;
}

export function useProgressSync() {
  const bookId = useReaderStore((s) => s.loadedBookId);
  const fraction = useReaderStore((s) => s.progressFraction);
  const location = useReaderStore((s) => s.currentLocation);
  // Brief 38 step 7, decision 10: a `locator` inside a published document only
  // means something alongside the version it was measured in, so the version
  // travels in the pending write with the locator it was measured against.
  const versionId = useReaderStore((s) => s.loadedVersionId);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSent = useRef<string | null>(null);
  /**
   * The position not yet written (brief 57). Held in a ref, not a timer
   * closure, so every way out can write it: the debounce timer, leaving the
   * reader, switching to the converted twin or another version, hiding the
   * tab, and closing it. Before this, only the timer could, and a reader who
   * stopped within the debounce resumed a page behind.
   */
  const pending = useRef<PendingWrite | null>(null);

  /**
   * Write the pending position, if any. `exit` marks the page-exit paths: the
   * PATCH then goes out with `keepalive` so the browser finishes it after the
   * page is gone. A no-op when nothing is pending or it was already sent.
   * Reads refs only, so it is stable and safe to register once.
   */
  const flush = useCallback((exit: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const p = pending.current;
    pending.current = null;
    if (!p || p.signature === lastSent.current) return;
    lastSent.current = p.signature;
    const updatedAt = Date.now();
    // Read at write time (not as a hook dependency): we want whoever is
    // active WHEN THE WRITE HAPPENS, after the debounce, not whoever was
    // active when the position was recorded. `getState()` is the documented
    // way to read the auth store from non-React code/timing.
    const profileId = useAuthStore.getState().activeProfileId;
    // Persist locally FIRST so offline reading position survives even when the
    // PATCH can't go out; then attempt the server write (best-effort).
    //
    // `versionId` goes into the local record too, and must: the flush that
    // sends this record later has no other way to know which version the
    // locator was measured in, and the server COALESCEs the two columns
    // separately — an unpaired locator overwrites the page number while
    // leaving the previous version id beside it (decision 10's "page 40 of v3
    // is not page 40 of v4"). Recorded at write time, exactly like
    // `profileId` above and for the same class of reason.
    void putLocalProgress(p.bookId, {
      progress: p.fraction,
      locator: p.locator,
      updatedAt,
      profileId,
      versionId: p.versionId,
    });
    void updateProgress(p.bookId, p.fraction, p.locator, undefined, p.versionId, { keepalive: exit })
      // Mark the record THIS write created — the progress store is keyed per
      // (profile, book) since v4, so the profile has to come along or the
      // lookup misses and the row stays pending forever.
      .then(() => markLocalProgressSynced(p.bookId, profileId, updatedAt))
      .catch(() => {
        // Offline / server down: the local record stays pending and is pushed
        // once on reconnect (last-write-wins).
      });
  }, []);

  useEffect(() => {
    if (!bookId || fraction === null) return;
    const locator = serializeLocator(location);
    // Dedupe: skip when neither the book, the position, the version, nor the
    // (rounded) fraction moved since the last send, so a settled reader doesn't
    // PATCH on a loop. A reader who wandered off and came back to the sent
    // position has nothing pending any more.
    const signature = `${bookId}|${locator ?? ""}|${fraction.toFixed(4)}|${versionId ?? ""}`;
    if (signature === lastSent.current) {
      pending.current = null;
      return;
    }

    pending.current = { bookId, fraction, locator, versionId, signature };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => flush(false), DEBOUNCE_MS);

    // Only the timer is cancelled here. This cleanup runs on every page turn,
    // so flushing in it would write every page and defeat the debounce.
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [bookId, fraction, location, versionId, flush]);

  // Leaving this book or version: write its pending position before the next
  // one starts. The cleanup runs while `pending` still holds the OLD ids, so a
  // twin switch (PDF ⇄ EPUB, one mount, `bookId` changes) writes the previous
  // book's position against the previous book, never against the new one. Also
  // covers unmount: back to the library.
  useEffect(() => {
    return () => flush(true);
  }, [bookId, versionId, flush]);

  // The page itself going away. No React cleanup runs when a tab closes, so
  // listen for it, once. Same `pagehide`/`visibilitychange` pair as
  // `lib/preferences.ts`: `pagehide` is the reliable one on mobile Safari.
  useEffect(() => {
    const onPageHide = () => flush(true);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush(true);
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [flush]);
}

/**
 * Push every pending local progress record once (last-write-wins), skipping any
 * whose value already matches its freshly-fetched server row. `rows` is the live
 * library list (the current server truth) so we don't PATCH a position the
 * server already holds — keeping the reconnect flush idempotent (no PATCH spam).
 *
 * Because the wire `LibraryBook` carries no per-user progress timestamp, "newer
 * than the server" is inferred from the local pending flag (`updatedAt >
 * syncedAt`, tracked in the store) plus value divergence from the fetched row.
 *
 * Profiles (brief 35 step 7): `rows` is fetched under the session's CURRENT
 * active profile, so it is only a valid "already on the server" comparison
 * for pending records that belong to that same profile. A record recorded by
 * a DIFFERENT profile (the whole reason this queue needs `profileId` at all)
 * cannot be judged against `rows` — it is always sent, never skipped by that
 * check — and is sent with ITS OWN profile, not the currently active one, so
 * a switch that happens before reconnect can never re-attribute it.
 */
/**
 * Single-flight latch. `useReconnectProgressSync`'s effect can re-run (renders,
 * the `online` event) while a flush is still awaiting its PATCHes; without a
 * guard, overlapping runs each read the same still-pending rows and PATCH them
 * again (observed: 3× per row). Coalescing overlapping calls onto one in-flight
 * run guarantees one PATCH per pending book per reconnect. A run started AFTER
 * the current one finishes still picks up anything left pending.
 */
let flushInFlight: Promise<void> | null = null;

export function flushPendingProgress(rows: LibraryBook[]): Promise<void> {
  if (flushInFlight) return flushInFlight;
  flushInFlight = doFlushPendingProgress(rows).finally(() => {
    flushInFlight = null;
  });
  return flushInFlight;
}

async function doFlushPendingProgress(rows: LibraryBook[]): Promise<void> {
  const pending = await listPendingProgress();
  if (pending.length === 0) return;
  const byId = new Map(rows.map((r) => [r.id, r]));
  // The profile `rows` was fetched as — see the header comment above for why
  // that scopes the "already on the server" shortcut below.
  const activeProfileId = useAuthStore.getState().activeProfileId;
  for (const p of pending) {
    // `null` = a record with no recorded profile (pre-brief-35, or written
    // before the active profile was known) — attribute it to whoever is
    // active NOW, which is exactly today's single-profile behaviour.
    const targetProfileId = p.profileId ?? activeProfileId;
    const belongsToActiveProfile = targetProfileId === activeProfileId;
    const row = belongsToActiveProfile ? byId.get(p.id) : undefined;
    const alreadyOnServer =
      row != null &&
      (row.locator ?? null) === p.locator &&
      Math.abs(row.progress - p.progress) < FRACTION_EPSILON;
    if (alreadyOnServer) {
      // Server already holds this position — just clear the pending flag. Keyed
      // by the record's OWN profile (`p.profileId`), not `targetProfileId`:
      // that's the row we actually read, and for a profile-less record the two
      // differ.
      await markLocalProgressSynced(p.id, p.profileId, p.updatedAt);
      continue;
    }
    try {
      // Send the record's OWN profile (falling back to active for a `null`
      // record, per the comment above) — never the currently active one.
      //
      // **Never write a locator that is not paired with the version it was
      // measured in** (brief 38 decision 10; `apps/api/src/library-routes.ts`
      // states the same rule from the server side). `upsertProfileProgress`
      // COALESCEs `locator` and `version_id` independently, so a locator sent
      // without a version replaces the page number and leaves the OLD version
      // id sitting next to it — a fresh page filed against a document it was
      // never measured in, which resumes in the wrong place and is strictly
      // worse than resuming at 0.
      //
      // Records written since brief 38 carry their version (`putLocalProgress`),
      // so the pair normally goes out intact. The one case that cannot is a
      // versioned book read while the version list never resolved — reading
      // OFFLINE, where `GET /library/:id/versions` simply never answered and
      // `loadedVersionId` stayed null. There we send the fraction alone: the
      // cover bar advances, and the server's existing (locator, version_id)
      // pair is left undisturbed by the COALESCE rather than half-rewritten.
      // The cost is that the exact page isn't restored; the alternative is a
      // resume position that is quietly wrong, which is not a trade worth making.
      //
      // "Versioned" is read off the book's own row (`source === "latex"` —
      // publishing is the only thing that mints versions). A book that isn't in
      // `rows` at all cannot be a published document (those are always source
      // rows, never excluded from `GET /library`), so an unknown book keeps
      // today's behaviour and sends its locator.
      const versioned = byId.get(p.id)?.source === "latex";
      const locator = p.versionId != null || !versioned ? p.locator : null;
      await updateProgress(
        p.id,
        p.progress,
        locator,
        targetProfileId ?? undefined,
        p.versionId ?? undefined,
      );
      await markLocalProgressSynced(p.id, p.profileId, p.updatedAt);
    } catch (err) {
      // A 404 here means the profile-scoped PATCH couldn't resolve a target:
      // either the profile named by `targetProfileId` was deleted (the server
      // verifies it against the caller's account and 404s if not), or the
      // book itself is gone. Both leave nothing to sync this record to, so
      // drop it — otherwise a deleted profile's stale record would retry on
      // every reconnect forever. Anything else (still offline, 5xx) leaves
      // the record pending for the next reconnect.
      if (err instanceof ApiError && err.status === 404) {
        // Only this profile's row for the book — a housemate's position for the
        // same book is a separate record and stays.
        await deleteLocalProgress(p.id, p.profileId);
      }
    }
  }
}

/**
 * Drive `flushPendingProgress` on app start and on every `online` event, using
 * the live library rows for the value comparison. Mount this once where the
 * library list is known (the library page). Safe no-op with no pending records.
 *
 * `isOffline` (from `useLibraryList`) means those rows are the OFFLINE FALLBACK
 * — downloaded books' cached snapshots — and it MUST suppress the flush. Those
 * rows compose their `progress`/`locator` from this device's own progress
 * records (brief 35 fix), so comparing a pending record against them is
 * comparing it against itself: every record would look "already on the server"
 * and be marked synced without a single PATCH ever going out, silently
 * discarding the offline reading it was queued to deliver. `rows` is only a
 * valid comparison when it is genuinely the server's answer.
 *
 * Nothing is lost by waiting: react-query refetches on reconnect, `isOffline`
 * flips back to false with real rows, and this effect re-runs and flushes then.
 */
export function useReconnectProgressSync(
  rows: LibraryBook[] | undefined,
  isOffline: boolean,
): void {
  useEffect(() => {
    if (!rows || isOffline) return;
    void flushPendingProgress(rows);
    const onOnline = () => void flushPendingProgress(rows);
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [rows, isOffline]);
}
