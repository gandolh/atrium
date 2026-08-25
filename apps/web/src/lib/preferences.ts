import { preferencesSchema, type Preferences, type Profile } from "@ebook-reader/shared";

import { useAuthStore } from "./auth";
import { fetchPreferences, updatePreferences } from "./profiles-api";

/**
 * Owns the preferences blob's shape, the boot cache, and the debounced
 * server write (brief 35, D35 — revises D9 for preferences only). Consumed by
 * `reader-store.ts`, which is the only other file that imports this one;
 * nothing under `reader/**`/`player/**` or any chunk-7 UI needs to know this
 * module exists — a profile switch (`useAuthStore`'s `activeProfile` changing)
 * drives the reload on its own via `initPreferencesSync` below.
 *
 * Three requirements the brief calls out as easy to miss, each with its own
 * section here:
 *  1. **Boot cache** — the active profile's blob mirrored to localStorage and
 *     read SYNCHRONOUSLY, so the very first paint already has the right
 *     theme instead of snapping to it once the fetch lands.
 *  2. **Tolerant parsing** — unknown keys survive on both the read and the
 *     write path (`preferencesSchema`'s `.passthrough()`, matched here).
 *  3. **Debounced writes** (~500ms), flushed on page hide so the last change
 *     of a session isn't lost — same `pagehide`/`visibilitychange` shape as
 *     `player/use-media-progress.ts`'s flush (that file is untouched; this is
 *     just the same idiom, not shared code).
 */

// ---------------------------------------------------------------------------
// Boot cache — keyed PER PROFILE (not one shared key). A single shared key
// would paint the previous person's theme for a moment after a switch, which
// is the exact bug this exists to prevent, just wearing a different hat.
// ---------------------------------------------------------------------------

function bootCacheKey(profileId: string): string {
  return `ebook-reader:preferences:${profileId}`;
}

/**
 * Raw cache read: `null` means "nothing cached for this profile on this
 * device yet" (as opposed to `{}`, a profile that has legitimately synced an
 * empty blob) — callers that need to distinguish "never cached" from "cached
 * empty" (the legacy fallback below, the adoption guard) use this; callers
 * that just want *something to paint* use `getBootPreferences`.
 */
function readCachedPreferences(profileId: string): Preferences | null {
  try {
    const raw = localStorage.getItem(bootCacheKey(profileId));
    if (raw === null) return null;
    // Tolerant parse (requirement 2): `preferencesSchema` is `.passthrough()`,
    // so a key this build doesn't recognise yet (written by a newer client
    // syncing through the same account) survives being read back here.
    return preferencesSchema.parse(JSON.parse(raw));
  } catch {
    // Corrupt JSON, or storage unavailable — treat as uncached rather than
    // throwing; the caller falls back same as a first-ever run.
    return null;
  }
}

function writeCachedPreferences(profileId: string, prefs: Preferences): void {
  try {
    localStorage.setItem(bootCacheKey(profileId), JSON.stringify(prefs));
  } catch {
    /* boot-cache persistence is best-effort, same convention as reader-store's
       existing localStorage helpers */
  }
}

/**
 * The three pre-profiles device-wide keys (`reader-store.ts`'s old
 * `THEME_KEY`/`PAGE_MODE_KEY`/`TOC_SIDEBAR_KEY`). Read only for one-time
 * first-run adoption (below) and — as a synchronous fallback, see
 * `getBootPreferences` — for the exact page load where a device upgrades to
 * profile-scoped preferences and has no profile-scoped cache yet. Never
 * written to again; the profile-scoped keys above are the durable ones now.
 */
const LEGACY_THEME_KEY = "ebook-reader:theme";
const LEGACY_PAGE_MODE_KEY = "ebook-reader:page-mode";
const LEGACY_TOC_SIDEBAR_KEY = "ebook-reader:toc-sidebar-open";

function readLegacyPreferences(): Preferences {
  const legacy: Preferences = {};
  try {
    const theme = localStorage.getItem(LEGACY_THEME_KEY);
    if (theme === "sepia" || theme === "dark" || theme === "light") legacy.theme = theme;
  } catch {
    /* ignore */
  }
  try {
    const pageMode = localStorage.getItem(LEGACY_PAGE_MODE_KEY);
    if (pageMode === "scroll" || pageMode === "paged") legacy.pageMode = pageMode;
  } catch {
    /* ignore */
  }
  try {
    const toc = localStorage.getItem(LEGACY_TOC_SIDEBAR_KEY);
    if (toc !== null) legacy.tocSidebarOpen = toc === "1";
  } catch {
    /* ignore */
  }
  return legacy;
}

/**
 * What `reader-store.ts` seeds its Zustand `initialState` from, synchronously,
 * at module load (requirement 1). `profileId` is `useAuthStore`'s
 * synchronously-seeded `activeProfileId` — a hint, but on a device that's
 * been used before it's the right hint often enough that painting from it is
 * strictly better than painting defaults and snapping.
 *
 * Falls back to the LEGACY device-wide keys only when there is no
 * profile-scoped cache at all: the one page load where a device upgrades to
 * profiles and hasn't cached anything per-profile yet. This is a deliberate
 * best-effort guess for that single load — `initPreferencesSync`'s fetch
 * reconciles it moments later (and, for the account's default profile,
 * formally adopts it server-side; see `loadPreferences`). A profile created
 * and switched to *within* a running session never takes this path — no page
 * reload happens, so the switch flow's own (non-legacy-falling-back) cache
 * read applies instead.
 */
export function getBootPreferences(profileId: string | null): Preferences {
  if (!profileId) return {};
  return readCachedPreferences(profileId) ?? readLegacyPreferences();
}

// ---------------------------------------------------------------------------
// Server round trip, including first-run adoption (brief step 7's third
// bullet / step 8's third bullet).
// ---------------------------------------------------------------------------

/**
 * Fetch a profile's preferences, adopting the device's current legacy values
 * as the DEFAULT profile's preferences on a true first run, and refresh the
 * boot cache either way. `isDefault` must come from the server's `Profile`
 * row (not guessed) — adopting a device's leftover theme into a freshly
 * created SECOND profile would hand Bob whatever Alice last set, which is
 * exactly the bug the "default profile only" restriction exists to avoid.
 */
export async function loadPreferences(profileId: string, isDefault: boolean): Promise<Preferences> {
  const server = await fetchPreferences(profileId);
  const isEmpty = Object.keys(server).length === 0;

  // Adopt only when the server has NEVER been written to (a true first run)
  // AND this device hasn't already cached something for this profile. The
  // second condition matters: if an earlier in-app change is sitting in the
  // boot cache because its PATCH hasn't landed yet (offline), the server can
  // still look empty on this fetch — re-running adoption would clobber that
  // pending, more-recent local change with the OLD legacy value.
  if (isEmpty && isDefault && readCachedPreferences(profileId) === null) {
    const adopted = readLegacyPreferences();
    if (Object.keys(adopted).length > 0) {
      try {
        const merged = await updatePreferences(profileId, adopted);
        writeCachedPreferences(profileId, merged);
        return merged;
      } catch {
        // Couldn't persist the adoption right now (offline) — still cache it
        // locally so this device doesn't fall back to bare defaults; the next
        // successful preference write (or a later boot's retry) carries it
        // forward to the server.
        writeCachedPreferences(profileId, adopted);
        return adopted;
      }
    }
  }

  writeCachedPreferences(profileId, server);
  return server;
}

// ---------------------------------------------------------------------------
// Debounced write-back (requirement 3). ~500ms so dragging the font-size
// slider coalesces into one PATCH instead of one per pixel.
// ---------------------------------------------------------------------------

const WRITE_DEBOUNCE_MS = 500;

let pendingProfileId: string | null = null;
let pendingPatch: Preferences | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function flushPreferencesWrite(): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (!pendingProfileId || !pendingPatch) return;
  const id = pendingProfileId;
  const patch = pendingPatch;
  pendingProfileId = null;
  pendingPatch = null;
  void updatePreferences(id, patch)
    .then((merged) => writeCachedPreferences(id, merged))
    .catch(() => {
      // Offline / server error: the optimistic cache write below already
      // stands, so the change isn't lost on THIS device — it just hasn't
      // reached the server yet. Nothing further to reconcile here; the next
      // successful write (from the next edit, or next session) carries the
      // merged patch forward.
    });
}

/**
 * Schedule (debounced) `patch` to be merged into `profileId`'s preferences
 * server-side. Also mirrors the change into the boot cache immediately
 * (optimistic), so a reload during the debounce window still shows it.
 *
 * A patch already pending for a DIFFERENT profile (a switch that raced the
 * debounce) is flushed first — merging it into the new profile's write would
 * silently attribute one person's preference change to another's row.
 */
export function schedulePreferencesWrite(profileId: string, patch: Preferences): void {
  if (pendingProfileId && pendingProfileId !== profileId) flushPreferencesWrite();

  pendingProfileId = profileId;
  pendingPatch = { ...pendingPatch, ...patch };
  writeCachedPreferences(profileId, { ...(readCachedPreferences(profileId) ?? {}), ...patch });

  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flushPreferencesWrite, WRITE_DEBOUNCE_MS);
}

// Flush on the way out, same idiom as `player/use-media-progress.ts`: `pagehide`
// is the reliable one (mobile Safari can skip a clean unload), `visibilitychange`
// additionally covers backgrounding a tab with no unload at all. Module-level
// (not a hook) because this module has no component lifecycle of its own —
// same convention as `auth.ts`'s `setOnUnauthorized` wiring.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushPreferencesWrite);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPreferencesWrite();
  });
}

// ---------------------------------------------------------------------------
// Reacting to a switch (requirement: pushing a loaded/switched profile's
// preferences into the reader store).
// ---------------------------------------------------------------------------

/** What `reader-store.ts` hands in so this module can push preferences into it
 * without importing the store back (there is no cycle: this file only ever
 * calls the function the store gave it, never imports `reader-store.ts`). */
export interface PreferenceHandlers {
  /**
   * Replace the store's four preference fields with `prefs`, resolved against
   * the store's own hard defaults for anything `prefs` doesn't specify (a
   * profile that never set a theme must show the app default, not whatever
   * the PREVIOUS profile had on screen).
   */
  applyPreferences: (prefs: Preferences) => void;
}

let wired = false;

/**
 * Wire preference loading to profile switches, once. Called by
 * `reader-store.ts` right after it creates the store — nothing else needs to
 * call this, including chunk 7's picker/switcher/manage UI: switching already
 * flips `useAuthStore`'s `activeProfile`, and that alone is what drives the
 * reload below.
 *
 * `bootProfileId` is whatever `reader-store.ts` used to compute its
 * synchronous `initialState` (via `getBootPreferences`, which — unlike the
 * plain cache read this function uses for a later switch — also falls back to
 * the legacy device-wide keys). Passed through so the FIRST reconcile call
 * below can tell "this is the profile the store already reflects" from "the
 * seeded guess was wrong, or this is a real switch": repainting the former
 * from a legacy-fallback-blind cache read would flash the exact case brief
 * step 8 calls out — a cold load right after the upgrade, before any
 * profile-scoped cache exists, briefly overwriting the correct legacy-adopted
 * paint with bare defaults before the fetch resolves and restores it.
 *
 * Subscribes on `activeProfile` (the full row), not `activeProfileId`: the id
 * is seeded synchronously at module load with `activeProfile` still `null`,
 * and `isDefault` (needed for first-run adoption) only becomes available once
 * the row itself arrives. Every place `auth.ts` changes the active profile —
 * login, the boot reconcile, an explicit switch, the delete-fallback in
 * `refreshProfiles` — sets `activeProfile` and `activeProfileId` together in
 * the same `set()`, so watching the row's identity never misses a change the
 * id-only signal would have caught.
 */
export function initPreferencesSync(handlers: PreferenceHandlers, bootProfileId: string | null): void {
  if (wired) return;
  wired = true;

  let lastAppliedId: string | null = null;

  const apply = (profile: Profile): void => {
    if (profile.id === lastAppliedId) return;
    const isFirstCall = lastAppliedId === null;
    lastAppliedId = profile.id;

    if (isFirstCall && profile.id === bootProfileId) {
      // The store already reflects the best available guess for this exact
      // profile (`initialState`'s synchronous read, legacy fallback
      // included) — skip straight to the fetch rather than repainting from a
      // plain cache read that knows nothing of the legacy keys and would
      // momentarily blank it back to defaults.
    } else {
      // Either a real switch, or the seeded guess didn't match the server's
      // idea of the active profile — paint from whatever's cached for THIS
      // profile (often `{}`), never the legacy fallback here: that's a
      // one-time cold-boot guess for the SEEDED profile specifically, not a
      // stand-in for any other profile mid-session.
      handlers.applyPreferences(readCachedPreferences(profile.id) ?? {});
    }

    void loadPreferences(profile.id, profile.isDefault)
      .then((server) => {
        // A second switch can land while this fetch is in flight; only apply
        // if this profile is still the one on screen, or a slow first fetch
        // could overwrite a faster second switch's already-applied result.
        if (lastAppliedId === profile.id) handlers.applyPreferences(server);
      })
      .catch(() => {
        /* offline / server error — the boot-cache paint above stands. */
      });
  };

  const initial = useAuthStore.getState().activeProfile;
  if (initial) apply(initial);

  useAuthStore.subscribe((state, prev) => {
    if (state.activeProfile && state.activeProfile.id !== prev.activeProfile?.id) {
      apply(state.activeProfile);
    }
  });
}
