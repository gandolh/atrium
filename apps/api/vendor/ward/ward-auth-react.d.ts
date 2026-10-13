// ward-auth 0.3.1 — built from https://github.com/gandolh/ward-auth (shared-library/).
// MIT licensed; see LICENSE beside this file. Do not edit a vendored copy: copy a newer build in.
/**
 * The browser half, without React: a small client for the plugin's routes and
 * an observable session state the hooks subscribe to.
 *
 * Kept free of React so it can be tested in Node with a fake `fetch`, and so
 * the hooks stay thin enough to read at a glance. Nothing here imports the
 * server bundle: `ward-auth-react.js` must load in a browser.
 */
/** The user the server reports. Mirrors the server's `AuthUser`. */
interface SessionUser {
    id: string;
    username: string;
    role: string;
    /** False for a user created by a Ward sign-in who has no local password yet. */
    hasPassword: boolean;
}
/** What the browser is told about its session. */
interface SessionInfo {
    origin: "local" | "ward";
    /** Epoch milliseconds. */
    expiresAt: number;
}
/** What the server says about Ward for this app and this user. */
interface WardStatus {
    /** The app offers "Sign in with Ward" (its server has Ward configured). */
    enabled: boolean;
    /** The signed-in user has a Ward account linked. Always false when signed out. */
    linked: boolean;
}
/**
 * The server's stable error codes, plus two of the client's own: `network`
 * (no answer at all) and `unknown` (an answer with no recognisable code).
 * Open-ended, because later versions add codes and an app should fall back to
 * a generic message for one it does not know.
 *
 * The Ward codes, and where they appear:
 *
 * - `access_denied` — Ward said no: no grant for this app, a disabled
 *   account, or the person pressed "Back to the app". (Ward may send other
 *   OAuth error codes; they pass through as they are.)
 * - `ward_unavailable` — Ward could not be reached. Also a session `reason`:
 *   a Ward-originated session is refused while Ward cannot vouch for it.
 *   Suggested words: "Ward is unreachable, sign in with your password".
 * - `ward_misconfigured` — Ward refused this app's client credential. An
 *   operator problem; show it like `ward_unavailable`.
 * - `ward_session_ended` — a session `reason`: the Ward session it began with
 *   was signed out or revoked.
 * - `invalid_callback` — the round trip could not be completed (it expired,
 *   was started in another tab, or was tampered with; for a reauthentication,
 *   also when Ward's answer does not show a password typed for it). Try again.
 * - `sign_in_failed` — Ward's answer was fine but the app failed finishing
 *   the sign-in, link or reauthentication (logged on the server). Try again;
 *   if it persists, it is an operator problem.
 * - `already_linked`, `ward_account_in_use` — linking: this user already has
 *   a Ward account, or that Ward account belongs to another user here.
 * - `ward_account_mismatch` — reauthentication came back as another Ward
 *   account.
 * - `not_linked`, `no_local_password` — unlinking.
 * - `reauthentication_required` — setting a first local password needs a
 *   reauthentication (`reauthenticate()`) from the last ten minutes. A plain
 *   Ward sign-in does not count, however recent.
 */
type AuthErrorCode = "invalid_request" | "invalid_credentials" | "invalid_username" | "password_too_short" | "password_too_long" | "username_taken" | "too_many_attempts" | "unauthorized" | "forbidden" | "cross_site" | "network" | "unknown" | "access_denied" | "ward_unavailable" | "ward_misconfigured" | "ward_session_ended" | "invalid_callback" | "sign_in_failed" | "already_linked" | "ward_account_in_use" | "ward_account_mismatch" | "not_linked" | "no_local_password" | "reauthentication_required" | (string & {});
interface AuthError {
    code: AuthErrorCode;
    /** The HTTP status, when there was a response. */
    status?: number;
    /** Set with `too_many_attempts`: how long until the next attempt is allowed. */
    retryAfterSeconds?: number;
}
type SessionState = {
    status: "loading";
} | {
    status: "signed_in";
    user: SessionUser;
    session: SessionInfo;
    ward: WardStatus;
}
/**
 * `reason` is set when a cookie was presented and a session check refused
 * it — `ward_unavailable` and `ward_session_ended` among them.
 */
 | {
    status: "signed_out";
    reason?: string;
    ward: WardStatus;
} | {
    status: "error";
    error: AuthError;
};
/**
 * What the last Ward round trip came back with, read once from the page's URL
 * (`?ward_error=` or `?ward=`) when the client is created, and removed from
 * the address bar so a reload does not show it again.
 */
interface WardResult {
    /** `linked` after a link, `reauthenticated` after a verified reauthentication. */
    result?: "linked" | "reauthenticated";
    error?: AuthError;
}
type ActionResult = {
    ok: true;
} | {
    ok: false;
    error: AuthError;
};
interface AuthClientOptions {
    /**
     * The browser-visible path of the plugin's routes: the app's API prefix plus
     * the plugin's `routePrefix`, e.g. `/atrium/api/auth`.
     */
    basePath: string;
    /** Injected by tests. The global `fetch` otherwise. */
    fetch?: typeof fetch;
    /**
     * Send the browser to a URL (Ward's pages). Injected by tests;
     * `window.location.assign` otherwise.
     */
    navigate?: (url: string) => void;
    /**
     * The page's current URL, read once for a Ward result, and how to replace
     * it without one. Injected by tests; `window.location` and
     * `history.replaceState` otherwise, and nothing at all outside a browser.
     */
    location?: {
        href: string;
        replace(url: string): void;
    };
}
interface AuthClient {
    readonly basePath: string;
    getState(): SessionState;
    subscribe(listener: () => void): () => void;
    /** Ask the server who is signed in. Concurrent calls share one request. */
    refresh(): Promise<SessionState>;
    /** `refresh()` once, if nothing has loaded the state yet. */
    ensureLoaded(): void;
    login(username: string, password: string): Promise<ActionResult>;
    logout(): Promise<ActionResult>;
    changePassword(currentPassword: string, newPassword: string): Promise<ActionResult>;
    register(username: string, password: string): Promise<ActionResult>;
    /**
     * "Sign in with Ward": ask the server for Ward's URL and go there. On
     * success the page is navigating away. `returnTo` is a path on this origin
     * to land on afterwards.
     */
    startWardSignIn(options?: {
        returnTo?: string;
    }): Promise<ActionResult>;
    /** "Link Ward", from settings while signed in. Navigates to Ward. */
    startWardLink(): Promise<ActionResult>;
    /** Reauthenticate with Ward (Ward asks for the password again). Navigates to Ward. */
    startWardReauthentication(): Promise<ActionResult>;
    /** Unlink Ward. The state becomes signed out if this session began with Ward. */
    unlinkWard(): Promise<ActionResult>;
    /**
     * Set a local password: give the current one if there is one; a user with
     * none needs `startWardReauthentication()` in the last ten minutes
     * (`reauthentication_required` otherwise; a Ward sign-in does not count).
     */
    setLocalPassword(newPassword: string, currentPassword?: string): Promise<ActionResult>;
    /** Sign out here and at Ward. Navigates to Ward's end-session page when there is one. */
    signOutOfWard(): Promise<ActionResult>;
    /** The Ward result the page was loaded with, if any. */
    getWardResult(): WardResult;
    /** Forget it (after the app has shown it). */
    clearWardResult(): void;
}
declare function createAuthClient(options: AuthClientOptions): AuthClient;
/**
 * Point the hooks at the plugin's routes. Call once, at startup, before the
 * first render:
 *
 * ```ts
 * configureAuth({ basePath: "/atrium/api/auth" });
 * ```
 */
declare function configureAuth(options: AuthClientOptions): AuthClient;
/** The configured client. Throws if `configureAuth` has not run. */
declare function getAuthClient(): AuthClient;

/**
 * Unstyled React hooks over the auth client. They return state and handlers
 * and render nothing, so every app keeps its own login, register and settings
 * pages in its own design.
 *
 * They all read one shared session state (an external store, not a context),
 * so a successful `login` from a form flips every `useSession` on the page to
 * signed in without a provider or a reload.
 *
 * Each takes an optional `{ client }`; without one they use the client
 * `configureAuth` set up.
 */
interface HookOptions {
    client?: AuthClient;
}
/** The session, loaded on first use, plus a way to ask again. */
declare function useSession(options?: HookOptions): SessionState & {
    refresh: () => Promise<void>;
};
/** The shared shape of a one-shot action: pending, the last error, and a reset. */
interface ActionState {
    pending: boolean;
    error: AuthError | null;
    reset: () => void;
}
/**
 * `login(username, password)` resolves `true` on success, when the session
 * state is already signed in. On failure `error.code` is `invalid_credentials`,
 * `too_many_attempts` (with `retryAfterSeconds`), `invalid_request` or
 * `network`; the app writes the message.
 */
declare function useLogin(options?: HookOptions): ActionState & {
    login: (username: string, password: string) => Promise<boolean>;
};
/** `logout()` ends the session here; the state becomes signed out. */
declare function useLogout(options?: HookOptions): ActionState & {
    logout: () => Promise<boolean>;
};
/**
 * `changePassword(current, next)`. On success every *other* session the user
 * holds has ended and `done` is true. Errors: `invalid_credentials` (wrong
 * current password), `password_too_short`, `password_too_long`,
 * `too_many_attempts`, `unauthorized`.
 */
declare function useChangePassword(options?: HookOptions): ActionState & {
    changePassword: (currentPassword: string, newPassword: string) => Promise<boolean>;
    done: boolean;
};
/**
 * `register(username, password)`, for the app that enables registration.
 * Signs the new user in on success. Errors: `username_taken`,
 * `invalid_username`, `password_too_short`, `password_too_long`,
 * `too_many_attempts`.
 */
declare function useRegister(options?: HookOptions): ActionState & {
    register: (username: string, password: string) => Promise<boolean>;
};
/** The Ward result the page was loaded with (`?ward_error=` / `?ward=`), and a way to dismiss it. */
declare function useWardResult(options?: HookOptions): WardResult & {
    clear: () => void;
};
/**
 * The login page's "Sign in with Ward" button. `signIn()` (optionally with a
 * `returnTo` path) sends the browser to Ward; it only resolves `false`, with
 * `error` set, when it could not get there — `ward_unavailable`,
 * `ward_misconfigured`, `network`.
 *
 * When Ward sends the person back with a failure, the page loads with
 * `?ward_error=<code>` and `error` starts as that: `access_denied` (no grant,
 * a disabled account, or they pressed "Back to the app"), `invalid_callback`,
 * `ward_unavailable`, `sign_in_failed`. `reset()` dismisses it. Show the button only when
 * `useSession().ward.enabled`.
 */
declare function useWardSignIn(options?: HookOptions): ActionState & {
    signIn: (signInOptions?: {
        returnTo?: string;
    }) => Promise<boolean>;
};
/**
 * Settings: "Link Ward". `link()` sends the browser to Ward; the settings
 * page then loads with `linked` true, or with `error` set to
 * `already_linked`, `ward_account_in_use`, `access_denied`,
 * `invalid_callback`, `sign_in_failed` or `unauthorized` (the session that
 * started the link had ended). Show it when `useSession().ward.enabled && !ward.linked`.
 */
declare function useWardLink(options?: HookOptions): ActionState & {
    link: () => Promise<boolean>;
    linked: boolean;
};
/**
 * Settings: "Unlink Ward". Refused with `no_local_password` while the user
 * has none (offer `useSetLocalPassword` first), `not_linked` when there is
 * nothing to unlink. If the current session began with Ward it ends too, and
 * the session state becomes signed out.
 */
declare function useWardUnlink(options?: HookOptions): ActionState & {
    unlink: () => Promise<boolean>;
    done: boolean;
};
/**
 * Settings: "Set a local password", so a user created from Ward can still
 * get in while Ward is down. For a user who has a password,
 * `setPassword(next, current)` (a password change). For one who has none,
 * `setPassword(next)` works only within ten minutes of `reauthenticate()`,
 * which sends the person through Ward (asking for their Ward password) and
 * back to settings with `reauthenticated` true. A Ward sign-in does not
 * count, however recent, so offer `reauthenticate()` first, or on
 * `reauthentication_required`. A failed reauthentication lands on settings
 * with `?ward_error=` (`invalid_callback`, `ward_account_mismatch`,
 * `access_denied`, `sign_in_failed`), which `useWardResult` reads; this
 * hook's `error` does not. Other errors: `invalid_credentials`,
 * `password_too_short`, `password_too_long`, `too_many_attempts`.
 */
declare function useSetLocalPassword(options?: HookOptions): ActionState & {
    setPassword: (newPassword: string, currentPassword?: string) => Promise<boolean>;
    reauthenticate: () => Promise<boolean>;
    reauthenticated: boolean;
    done: boolean;
};
/**
 * "Sign out of Ward too": ends the session here, then sends the browser to
 * Ward, which ends the Ward session this one began with and comes back to
 * the app's registered sign-out page. For a session that did not begin with
 * Ward it is a plain sign-out. Error: `ward_unavailable` (nothing was ended;
 * offer the ordinary `useLogout`).
 */
declare function useWardSignOut(options?: HookOptions): ActionState & {
    signOut: () => Promise<boolean>;
};

export { configureAuth, createAuthClient, getAuthClient, useChangePassword, useLogin, useLogout, useRegister, useSession, useSetLocalPassword, useWardLink, useWardResult, useWardSignIn, useWardSignOut, useWardUnlink };
export type { ActionResult, AuthClient, AuthClientOptions, AuthError, AuthErrorCode, HookOptions, SessionInfo, SessionState, SessionUser, WardResult, WardStatus };
