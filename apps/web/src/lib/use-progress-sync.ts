import { useEffect, useRef } from "react";
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

export function useProgressSync() {
  const bookId = useReaderStore((s) => s.loadedBookId);
  const fraction = useReaderStore((s) => s.progressFraction);
  const location = useReaderStore((s) => s.currentLocation);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSent = useRef<string | null>(null);

  useEffect(() => {
    if (!bookId || fraction === null) return;
    const locator = serializeLocator(location);
    // Dedupe: skip when neither the position nor the (rounded) fraction moved
    // since the last send, so a settled reader doesn't PATCH on a loop.
    const signature = `${locator ?? ""}|${fraction.toFixed(4)}`;
    if (signature === lastSent.current) return;

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      lastSent.current = signature;
      const updatedAt = Date.now();
      // Read at fire time (not as a hook dependency): we want whoever is
      // active WHEN THE WRITE HAPPENS, after the debounce, not whoever was
      // active when the effect was scheduled. `getState()` is the documented
      // way to read the auth store from non-React code/timing.
      const profileId = useAuthStore.getState().activeProfileId;
      // Persist locally FIRST so offline reading position survives even when the
      // PATCH can't go out; then attempt the server write (best-effort).
      void putLocalProgress(bookId, { progress: fraction, locator, updatedAt, profileId });
      void updateProgress(bookId, fraction, locator)
        // Mark the record THIS write created — the progress store is keyed per
        // (profile, book) since v4, so the profile has to come along or the
        // lookup misses and the row stays pending forever.
        .then(() => markLocalProgressSynced(bookId, profileId, updatedAt))
        .catch(() => {
          // Offline / server down: the local record stays pending and is pushed
          // once on reconnect (last-write-wins).
        });
    }, DEBOUNCE_MS);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [bookId, fraction, location]);
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
      await updateProgress(p.id, p.progress, p.locator, targetProfileId ?? undefined);
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
