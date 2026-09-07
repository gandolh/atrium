import { create } from "zustand";
import { profileListSchema, type Profile } from "@ebook-reader/shared";

import { ApiError, setOnForbidden, setOnUnauthorized } from "./api-client";
import { activateProfile, fetchProfiles } from "./profiles-api";
import { queryClient } from "./query-client";
import { goToWardLogin } from "./ward";

/**
 * Web-side session state. **Atrium no longer authenticates anybody.**
 *
 * Identity is Ward's: the browser holds a `ward_session` cookie at `Path=/` on
 * the shared origin, atrium's API validates it on every request, and this store
 * never sees a token, a password or a username/password form. What it does is
 * decide which of three things the app is looking at — signed in, not signed
 * in, or signed in without permission — and hold the **profile** half, which is
 * still entirely atrium's (D35: Ward does not know profiles exist).
 *
 * There is no `login` here and there must not be one. Signing in is a
 * navigation to `/ward/login?next=…`, not a request atrium makes.
 *
 * There is also no stored token. The one piece of localStorage left is the
 * remembered *profile choice*, which is a preference and not a credential —
 * losing it costs somebody one tap on the picker.
 *
 * Brief 35 put the **active profile** in this same store rather than a sibling
 * one, and that still holds: the 401 handler below has to drop the session
 * state and the profile in one atomic reset, because a device that signed in as
 * a different account while keeping the previous account's profile id would
 * read the wrong person's shelf. An account is the household and the security
 * boundary; a profile is a person in it and an identity boundary only (D35), so
 * nothing here is a permission check — the permission check is the `atrium`
 * grant, and it happens in the API.
 */

/** The device's remembered profile choice — an id, and only ever a hint. */
const PROFILE_KEY = "ebook-reader.profile";
/** Device cache of the account's profile list — see `readStoredProfiles`. */
const PROFILES_KEY = "ebook-reader.profiles";
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

/**
 * Device cache of the account's profile list.
 *
 * The picker needs names to show, and `GET /profiles` cannot answer when the
 * device is offline — which is exactly when a household tablet is most likely
 * to be opened after sitting idle past the 24h window. Without this the gate
 * had nothing to render and no way to resolve, so an offline boot with the
 * picker due hung forever. Caching the list keeps decision 6 working with no
 * connectivity: the person still gets asked who is reading.
 *
 * It is display data only — reachable by anyone holding the device, which is
 * fine because a profile is an identity boundary and never a security one
 * (D35). It is cleared whenever the session ends, since the next person to sign
 * in on this device is not necessarily the account this list belongs to.
 */
function readStoredProfiles(): Profile[] {
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    if (!raw) return [];
    const parsed = profileListSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function writeStoredProfiles(profiles: Profile[]): void {
  try {
    if (profiles.length > 0) {
      localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
    } else {
      localStorage.removeItem(PROFILES_KEY);
    }
  } catch {
    /* profile-list caching is best-effort */
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

/**
 * What the app is looking at.
 *
 * `forbidden` is the state that did not exist before Ward and is the one worth
 * naming: a valid, live session held by somebody with **no atrium grant**.
 * Collapsing it into `locked` would send them to a login page they are already
 * past, in a loop — only a superuser issuing a grant resolves it, so the app has
 * to say so rather than redirect.
 */
export type AuthGateStatus = "checking" | "locked" | "forbidden" | "unlocked";

interface AuthState {
  status: AuthGateStatus;
  /**
   * Kept for the header, and now only ever set from a server response — atrium
   * has no login form to learn it from and does not persist it.
   */
  username: string | null;
  /** A message for the gate screen. Not a login error; there is no login here. */
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
  /** Call once on app start: asks the API who we are and settles `status`. */
  checkStatus: () => Promise<void>;
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
  username: null,
  error: null,
  activeProfile: null,
  activeProfileId: readStoredProfileId(),
  profiles: readStoredProfiles(),
  pickerRequired: !FRESH_CHOICE_AT_BOOT,

  /**
   * Ask the API who we are, and settle `status` from the answer.
   *
   * `GET /profiles` is the probe rather than a dedicated status endpoint, and
   * that is deliberate: it is a real, guarded, profile-scoped call, so it
   * exercises exactly the path every other request takes. A dedicated
   * `/auth/status` would be a second definition of "am I in", free to disagree
   * with the first — and atrium deleted the one it had for that reason.
   *
   * It also answers the follow-up question in the same round trip. A successful
   * probe *is* the profile list, so there is no separate fetch afterwards.
   */
  async checkStatus() {
    try {
      const profiles = await fetchProfiles();

      const stored = readStoredProfileId();
      const remembered = FRESH_CHOICE_AT_BOOT
        ? profiles.find((p) => p.id === stored)
        : undefined;
      const active = remembered ?? defaultProfile(profiles);

      writeStoredProfiles(profiles);
      set({
        status: "unlocked",
        error: null,
        profiles,
        activeProfile: active ?? null,
        activeProfileId: active?.id ?? null,
        // Same rule as before: the 24-hour window suppresses the picker only
        // for a device whose person has already chosen. A server-assigned
        // default is not a choice.
        pickerRequired: remembered === undefined,
      });

      // The device's remembered profile may not be the one the server has
      // selected for this device session; move it if so, in the background.
      if (remembered) void activateProfile(remembered.id).catch(() => undefined);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // Not signed in. The api-client's 401 handler has already started the
        // navigation to Ward; setting `locked` is what the app paints in the
        // moment before the browser leaves.
        set({ status: "locked", error: null });
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        set({
          status: "forbidden",
          error:
            "You are signed in, but this account has no access to atrium. " +
            "Ask the administrator to grant it.",
        });
        return;
      }

      /*
       * The API is unreachable, or Ward is (a 503 from the guard). Do NOT send
       * anybody to a login page: signing in goes through the same identity
       * service that is currently not answering, so the redirect would be a
       * loop that looks like a broken password.
       *
       * Render the app instead and let the existing per-request error states
       * surface it — the same choice this store made before Ward, for the same
       * reason.
       */
      set({ status: "unlocked", error: null });
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
    writeStoredProfiles(mergeProfile(get().profiles, profile));
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
      writeStoredProfiles(profiles);
      set({ profiles, activeProfile: still });
      return;
    }
    // The active profile was just deleted. The server already falls a session
    // with a dangling `active_profile_id` back to the default (a missing
    // profile is never an auth failure), so follow it there — and clear, since
    // what's cached belongs to a profile that no longer exists.
    const fallback = defaultProfile(profiles);
    queryClient.clear();
    writeStoredProfiles(profiles);
    // Not a choice — the person's profile was deleted out from under them, so
    // the fallback is the server's pick, not theirs. Clearing the remembered
    // id means the next boot asks who is reading instead of silently adopting
    // Default as though it had been chosen.
    writeStoredProfileId(null);
    set({
      profiles,
      activeProfile: fallback ?? null,
      activeProfileId: fallback?.id ?? null,
    });
  },
}));

/**
 * Any 401 means Ward's session is gone — expired, revoked, or signed out from
 * another app. Hand over to Ward's login page.
 *
 * The local state is cleared **before** the navigation, not instead of it. The
 * redirect is not instantaneous, and whatever renders in the meantime must not
 * be the previous person's shelf.
 */
setOnUnauthorized(() => {
  /*
   * The remembered profile id goes too. Left behind, signing in as a different
   * account on this device would inherit the previous account's profile id —
   * and because the remembered timestamp is *device* activity rather than
   * account state, that id would look fresh enough to skip the picker. The
   * result is one household member's reading silently attributed to another.
   */
  writeStoredProfileId(null);
  writeStoredProfiles([]);
  // Whoever signs in next is not necessarily who just got signed out.
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

  goToWardLogin();
});

/**
 * A 403 is a live session with no atrium grant, and it must **not** redirect.
 *
 * Sending somebody to a login page they are already past is a loop: they sign
 * in successfully, come back, and are refused again for a reason signing in
 * cannot address. Only a superuser issuing an `atrium` grant resolves it, so
 * the app stops and says that.
 *
 * The caches are cleared for the same reason as above — whatever is on screen
 * belongs to a session that has just been refused.
 */
setOnForbidden(() => {
  queryClient.clear();
  useAuthStore.setState({
    status: "forbidden",
    activeProfile: null,
    activeProfileId: null,
    profiles: [],
    error:
      "You are signed in, but this account has no access to atrium. " +
      "Ask the administrator to grant it.",
  });
});

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
