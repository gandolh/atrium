import { create } from "zustand";
import {
  authStatusSchema,
  loginResponseSchema,
  type LoginRequest,
  type Profile,
} from "@ebook-reader/shared";

import { ApiError, apiFetch, setAuthToken, setOnUnauthorized } from "./api-client";
import { activateProfile, fetchProfiles } from "./profiles-api";
import { queryClient } from "./query-client";

/**
 * Web-side auth gate: per-user accounts (username + password). The library is
 * shared across users. `GET /auth/status` reports whether auth is required
 * (always true now); the app stays behind `LockScreen` until `POST /auth/login`
 * returns a session token.
 *
 * The token is mirrored to localStorage so a refresh doesn't re-lock, and
 * pushed into `api-client`'s in-memory holder (`setAuthToken`) since that
 * module attaches it to every `apiFetch` call and can't import this file back
 * (see api-client.ts's header comment on the circular-import seam).
 *
 * Brief 35 adds the **active profile** to this same store rather than a sibling
 * one. Two reasons it belongs here: the 401 re-lock below has to drop the token
 * AND the profile in one atomic reset (a re-login as a different account that
 * inherited the previous account's profile id would read the wrong person's
 * shelf), and the login response now carries both halves — a separate store
 * would have to be poked from inside this one anyway. An account is the
 * household and the security boundary; a profile is a person in it and an
 * identity boundary only (D35), so nothing here is a permission check.
 */

const TOKEN_KEY = "ebook-reader.token";
const USERNAME_KEY = "ebook-reader.username";
/** The device's remembered profile choice — an id, and only ever a hint. */
const PROFILE_KEY = "ebook-reader.profile";
/** Epoch ms of the last app load, stamped below. See `PROFILE_PICKER_IDLE_MS`. */
const PROFILE_ACTIVITY_KEY = "ebook-reader.profile-activity";

/**
 * How long a remembered profile choice survives an idle device (brief decision
 * 6). Exported so the picker can name the window in its copy without a second
 * definition of it drifting out of step.
 *
 * Measured device-side on purpose: `sessions` has no expiry column, so a
 * household tablet stays logged in indefinitely and the server cannot tell
 * which device a session was last used from. A purely remembered choice would
 * therefore attribute everyone's reading, forever, to whoever last picked on
 * that tablet. Re-asking once a day is the cheapest correct fix; always asking
 * would tax the 90% of loads that are one person on their own phone.
 */
export const PROFILE_PICKER_IDLE_MS = 24 * 60 * 60 * 1000;

function readStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeStoredToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    /* token persistence is best-effort */
  }
}

function readStoredUsername(): string | null {
  try {
    return localStorage.getItem(USERNAME_KEY);
  } catch {
    return null;
  }
}

function writeStoredUsername(username: string | null): void {
  try {
    if (username) {
      localStorage.setItem(USERNAME_KEY, username);
    } else {
      localStorage.removeItem(USERNAME_KEY);
    }
  } catch {
    /* username persistence is best-effort */
  }
}

function readStoredProfileId(): string | null {
  try {
    return localStorage.getItem(PROFILE_KEY);
  } catch {
    return null;
  }
}

function writeStoredProfileId(id: string | null): void {
  try {
    if (id) {
      localStorage.setItem(PROFILE_KEY, id);
    } else {
      localStorage.removeItem(PROFILE_KEY);
    }
  } catch {
    /* profile persistence is best-effort */
  }
}

function readLastActivity(): number | null {
  try {
    const raw = localStorage.getItem(PROFILE_ACTIVITY_KEY);
    if (!raw) return null;
    const at = Number(raw);
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

function stampActivity(): void {
  try {
    localStorage.setItem(PROFILE_ACTIVITY_KEY, String(Date.now()));
  } catch {
    /* activity persistence is best-effort */
  }
}

/**
 * Whether this device has a remembered profile choice that is still fresh —
 * i.e. the device was last used inside `PROFILE_PICKER_IDLE_MS`.
 *
 * Read BEFORE the module-level `stampActivity()` below, and never after: the
 * stamp is what makes "idle" mean *the device sat unused for a day*, so
 * comparing against a timestamp we just wrote would always answer "fresh".
 */
function hasFreshChoice(): boolean {
  if (!readStoredProfileId()) return false;
  const last = readLastActivity();
  if (last === null) return false;
  return Date.now() - last < PROFILE_PICKER_IDLE_MS;
}

/**
 * Snapshot the freshness verdict once, at module load, then stamp this load.
 * Everything downstream reads the snapshot; only an explicit pick clears it.
 */
const FRESH_CHOICE_AT_BOOT = hasFreshChoice();
stampActivity();

export type AuthGateStatus = "checking" | "locked" | "unlocked";

interface AuthState {
  status: AuthGateStatus;
  /** Username of the signed-in user, once known (from login or storage). */
  username: string | null;
  /** Inline login-form error (wrong credentials), cleared on each attempt. */
  error: string | null;
  /**
   * The full active-profile row, once the server has told us (login, boot
   * reconcile, or a switch). Null before that — read `activeProfileId` for
   * cache identity, which is seeded synchronously and so is never null on a
   * device that has been used before.
   */
  activeProfile: Profile | null;
  /**
   * The active profile's id, seeded straight from localStorage at module load.
   *
   * This is the field query keys and preference writes hang off, and the
   * synchronous seed is why: keys built from `activeProfile` would spend the
   * first paint of every load keyed on `null` and then re-key when the fetch
   * lands, refetching the whole library on each boot. A remembered id is a
   * hint, so it can be wrong — the boot reconcile fixes it, and a re-key then
   * is correct behaviour rather than churn.
   */
  activeProfileId: string | null;
  /** Every profile on the account (cap of five), for the picker and switcher. */
  profiles: Profile[];
  /**
   * Whether the "Who's reading?" gate should be shown (brief decision 6). True
   * unless the device has a fresh remembered choice that still names a real
   * profile on this account. Cleared by `switchProfile`.
   */
  pickerRequired: boolean;
  /** Call once on app start: resolves whether the gate should show at all. */
  checkStatus: () => Promise<void>;
  /** Submit username + password; on success unlocks, on 401 sets `error`. */
  login: (username: string, password: string) => Promise<void>;
  /**
   * Make `id` the active profile: activate it server-side, drop every cached
   * row from the previous profile, then flip the store. Throws `ApiError` on
   * failure (404 = not this account's profile) with the store untouched.
   */
  switchProfile: (id: string) => Promise<void>;
  /**
   * Re-read the account's profiles — the manage screen calls this after a
   * create / rename / delete so the switcher and picker stay honest. Falls the
   * active profile back to the account's default if it has just been deleted.
   */
  refreshProfiles: () => Promise<void>;
}

/** The account's fallback profile: `isDefault`, or the first row if absent. */
function defaultProfile(profiles: Profile[]): Profile | undefined {
  return profiles.find((p) => p.isDefault) ?? profiles[0];
}

/** `profiles` with `profile`'s row replaced, so a rename/recolour propagates. */
function mergeProfile(profiles: Profile[], profile: Profile): Profile[] {
  return profiles.some((p) => p.id === profile.id)
    ? profiles.map((p) => (p.id === profile.id ? profile : p))
    : [...profiles, profile];
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: "checking",
  username: readStoredUsername(),
  error: null,
  activeProfile: null,
  activeProfileId: readStoredProfileId(),
  profiles: [],
  pickerRequired: !FRESH_CHOICE_AT_BOOT,

  async checkStatus() {
    try {
      const res = await apiFetch("/auth/status", undefined, { skipAuthRedirect: true });
      const { required } = authStatusSchema.parse(await res.json());

      if (!required) {
        set({ status: "unlocked", error: null });
        return;
      }

      const token = readStoredToken();
      if (token) {
        setAuthToken(token);
        set({ status: "unlocked", error: null });
        // Unlock first, reconcile after: the app paints from the seeded
        // profile id (already correct on a returning device) instead of
        // waiting on two requests.
        void reconcileProfiles();
      } else {
        set({ status: "locked", error: null });
      }
    } catch {
      // API unreachable or errored — don't strand the user on a lock screen
      // they can't resolve (login would fail the same way); render the app
      // and let the existing per-request error states (e.g. home.tsx's
      // "API may be offline") surface the problem instead.
      set({ status: "unlocked", error: null });
    }
  },

  async login(username, password) {
    set({ error: null });
    try {
      const res = await apiFetch(
        "/auth/login",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password } satisfies LoginRequest),
        },
        { skipAuthRedirect: true },
      );
      const {
        token,
        username: resolved,
        profile,
        profiles,
      } = loginResponseSchema.parse(await res.json());
      writeStoredToken(token);
      writeStoredUsername(resolved);
      setAuthToken(token);

      // The login response carries the whole picker, so there is no follow-up
      // `GET /profiles` here. The server activated the account's default; a
      // device with a fresh remembered choice skips the picker, and then the
      // session has to be moved onto that choice or every request would be
      // scoped to Default while the header names someone else.
      const rememberedId = readStoredProfileId();
      const remembered = FRESH_CHOICE_AT_BOOT
        ? profiles.find((p) => p.id === rememberedId)
        : undefined;
      let active = profile;
      if (remembered && remembered.id !== profile.id) {
        try {
          active = await activateProfile(remembered.id);
        } catch {
          // Couldn't move the session — show the picker rather than let the
          // header and the server disagree about who is reading.
          active = profile;
        }
      } else if (remembered) {
        active = remembered;
      }

      // A remembered id from a DIFFERENT account can't match anything in this
      // list, so logging in as someone else always lands on the picker.
      const skipPicker = active.id === remembered?.id;
      writeStoredProfileId(active.id);
      set({
        status: "unlocked",
        username: resolved,
        error: null,
        activeProfile: active,
        activeProfileId: active.id,
        profiles: mergeProfile(profiles, active),
        pickerRequired: !skipPicker,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        set({ error: "Incorrect username or password." });
      } else {
        set({ error: "Something went wrong. Please try again." });
      }
    }
  },

  async switchProfile(id) {
    if (id === get().activeProfileId) {
      // Picking whoever is already active: no session change, and clearing the
      // cache here would refetch the whole library to arrive at what's on
      // screen. Just close the gate.
      stampActivity();
      set({ pickerRequired: false });
      return;
    }

    // Order is load-bearing (brief step 7). Clear BEFORE the session flips so
    // nothing of the previous profile survives the tap — a stale Continue row
    // is the most visible possible failure of this feature.
    queryClient.clear();
    const profile = await activateProfile(id);
    // And clear again on landing, in the same synchronous block as the state
    // flip: between the two lines above the session became the new profile
    // while the query keys still named the old one, so anything that refetched
    // in that window wrote the new profile's rows under the old profile's key.
    // No `await` separates this clear from the `set`, so React cannot render
    // the in-between state.
    queryClient.clear();
    writeStoredProfileId(profile.id);
    stampActivity();
    set((s) => ({
      activeProfile: profile,
      activeProfileId: profile.id,
      profiles: mergeProfile(s.profiles, profile),
      pickerRequired: false,
    }));
  },

  async refreshProfiles() {
    const profiles = await fetchProfiles();
    const current = get().activeProfileId;
    const still = profiles.find((p) => p.id === current);
    if (still) {
      set({ profiles, activeProfile: still });
      return;
    }
    // The active profile was just deleted. The server already falls a session
    // with a dangling `active_profile_id` back to the default (a missing
    // profile is never an auth failure), so follow it there — and clear, since
    // what's cached belongs to a profile that no longer exists.
    const fallback = defaultProfile(profiles);
    queryClient.clear();
    writeStoredProfileId(fallback?.id ?? null);
    set({
      profiles,
      activeProfile: fallback ?? null,
      activeProfileId: fallback?.id ?? null,
    });
  },
}));

/**
 * Boot reconcile: the stored profile id is a hint, the server's session is the
 * truth. `GET /profiles` can't report which profile the session has active, so
 * the only way to make the two provably agree is to assert the device's choice
 * with `activate` and take its answer — which also turns a stale id (a profile
 * deleted from another device) into a 404 we can fall back from, instead of a
 * header naming someone who no longer exists.
 */
async function reconcileProfiles(): Promise<void> {
  try {
    const profiles = await fetchProfiles();
    const stored = readStoredProfileId();
    const target = profiles.find((p) => p.id === stored) ?? defaultProfile(profiles);
    if (!target) return;

    const active = await activateProfile(target.id);
    const previous = useAuthStore.getState().activeProfileId;
    if (previous !== active.id) {
      // The seed was wrong, so everything fetched under it belongs to someone
      // else. The keys change with the state flip below, but clear anyway —
      // belt and braces is the whole point of step 7.
      queryClient.clear();
    }
    writeStoredProfileId(active.id);
    useAuthStore.setState((s) => ({
      activeProfile: active,
      activeProfileId: active.id,
      profiles: mergeProfile(profiles, active),
      // A remembered id that no longer names a real profile is not a
      // remembered choice, however fresh the timestamp is.
      pickerRequired: s.pickerRequired || active.id !== stored,
    }));
  } catch {
    // Offline or the API is down. Keep the seeded id: it's what this device
    // last used, the app already painted with it, and dropping it would only
    // trade a possibly-stale identity for none at all.
  }
}

// Wire the api-client's 401 callback to re-lock: any authenticated call that
// comes back 401 means the stored token is stale/invalid.
setOnUnauthorized(() => {
  writeStoredToken(null);
  writeStoredUsername(null);
  // The profile id goes with the token. Left behind, a re-login as a different
  // account would inherit the previous account's profile id — and since the
  // remembered timestamp is device activity rather than account state, that id
  // would have looked fresh enough to skip the picker.
  writeStoredProfileId(null);
  setAuthToken(null);
  // Whoever logs in next is not necessarily who just got locked out.
  queryClient.clear();
  useAuthStore.setState({
    status: "locked",
    username: null,
    error: null,
    activeProfile: null,
    activeProfileId: null,
    profiles: [],
    pickerRequired: true,
  });
});

// Seed api-client's in-memory token from storage immediately at module load,
// before `checkStatus` (or any other apiFetch call) runs.
setAuthToken(readStoredToken());

/**
 * The active profile's id — the identity every profile-scoped cache key and
 * preference write hangs off. Null only on a device that has never picked one
 * and hasn't reconciled yet.
 */
export function useActiveProfileId(): string | null {
  return useAuthStore((s) => s.activeProfileId);
}

/** The active profile row (name + colour), or null before the server answers. */
export function useActiveProfile(): Profile | null {
  return useAuthStore((s) => s.activeProfile);
}

/**
 * Whether the "Who's reading?" gate should be shown (brief decision 6). The
 * verdict is decided once per load — freshness is compared before this load's
 * own activity stamp, so it means "the device sat idle past
 * `PROFILE_PICKER_IDLE_MS`", not "the choice was made that long ago". Clearing
 * it is `switchProfile`'s job, including when the tap picks whoever is already
 * active.
 */
export function useNeedsPicker(): boolean {
  return useAuthStore((s) => s.pickerRequired);
}
