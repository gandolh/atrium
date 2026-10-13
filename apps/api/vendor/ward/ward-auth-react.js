// ward-auth 0.3.1 — built from https://github.com/gandolh/ward-auth (shared-library/).
// MIT licensed; see LICENSE beside this file. Do not edit a vendored copy: copy a newer build in.
import { useState, useCallback, useSyncExternalStore, useEffect } from 'react';

/**
 * The browser half, without React: a small client for the plugin's routes and
 * an observable session state the hooks subscribe to.
 *
 * Kept free of React so it can be tested in Node with a fake `fetch`, and so
 * the hooks stay thin enough to read at a glance. Nothing here imports the
 * server bundle: `ward-auth-react.js` must load in a browser.
 */
const NO_WARD = { enabled: false, linked: false };
/**
 * Read `?ward_error=` / `?ward=` from a URL. Returns the result and the URL
 * without those parameters (or `undefined` when there was nothing to remove).
 */
function readWardResult(href) {
    let url;
    try {
        url = new URL(href);
    }
    catch {
        return { result: {} };
    }
    const error = url.searchParams.get("ward_error");
    const outcome = url.searchParams.get("ward");
    const result = {};
    if (error !== null && /^[a-z_]{1,64}$/.test(error))
        result.error = { code: error };
    if (outcome === "linked" || outcome === "reauthenticated")
        result.result = outcome;
    if (error === null && outcome === null)
        return { result };
    url.searchParams.delete("ward_error");
    url.searchParams.delete("ward");
    return { result, cleaned: url.href };
}
function browser() {
    const candidate = globalThis;
    return candidate.location !== undefined &&
        typeof candidate.location.assign === "function" &&
        candidate.history !== undefined
        ? candidate
        : undefined;
}
function browserLocation() {
    const page = browser();
    if (page === undefined)
        return undefined;
    return {
        href: page.location.href,
        replace: (url) => page.history.replaceState(page.history.state, "", url),
    };
}
function createAuthClient(options) {
    const basePath = options.basePath.replace(/\/+$/, "");
    const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
    const listeners = new Set();
    const navigate = options.navigate ??
        ((url) => {
            const page = browser();
            if (page === undefined)
                throw new Error("ward-auth: no browser to navigate; pass navigate");
            page.location.assign(url);
        });
    let state = { status: "loading" };
    let loaded = false;
    let inflight;
    // A Ward round trip ends with a redirect to one of the app's pages carrying
    // the outcome in the query. Read it once, here, and take it out of the
    // address bar so a reload or a shared link does not replay it.
    const location = options.location ?? browserLocation();
    let wardResult = {};
    if (location !== undefined) {
        const read = readWardResult(location.href);
        wardResult = read.result;
        if (read.cleaned !== undefined)
            location.replace(read.cleaned);
    }
    function setState(next) {
        state = next;
        loaded = true;
        for (const listener of listeners)
            listener();
    }
    function stateFromBody(body) {
        const ward = body.ward ?? NO_WARD;
        if (body.user !== null && body.session !== null) {
            return { status: "signed_in", user: body.user, session: body.session, ward };
        }
        return body.reason === undefined
            ? { status: "signed_out", ward }
            : { status: "signed_out", reason: body.reason, ward };
    }
    /** What signing out here leaves: signed out, and Ward still offered if it was. */
    function signedOut() {
        const enabled = state.status === "signed_in" || state.status === "signed_out" ? state.ward.enabled : false;
        return { status: "signed_out", ward: { enabled, linked: false } };
    }
    /**
     * One request. `credentials: "same-origin"` so the cookie goes with it; a
     * JSON body only when there is one, because Fastify refuses an empty body
     * sent as `application/json`.
     */
    async function request(method, path, body) {
        try {
            return await doFetch(`${basePath}${path}`, {
                method,
                credentials: "same-origin",
                headers: body === undefined
                    ? { accept: "application/json" }
                    : { accept: "application/json", "content-type": "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        }
        catch {
            return { code: "network" };
        }
    }
    async function errorFrom(response) {
        let payload;
        try {
            payload = await response.json();
        }
        catch {
            payload = undefined;
        }
        const record = typeof payload === "object" && payload !== null ? payload : {};
        const error = {
            code: typeof record.error === "string" ? record.error : "unknown",
            status: response.status,
        };
        if (typeof record.retryAfterSeconds === "number")
            error.retryAfterSeconds = record.retryAfterSeconds;
        return error;
    }
    async function refresh() {
        inflight ??= (async () => {
            try {
                const response = await request("GET", "/session");
                if (!(response instanceof Response)) {
                    setState({ status: "error", error: response });
                }
                else if (!response.ok) {
                    setState({ status: "error", error: await errorFrom(response) });
                }
                else {
                    setState(stateFromBody((await response.json())));
                }
                return state;
            }
            finally {
                inflight = undefined;
            }
        })();
        return inflight;
    }
    /** Ask the server for a Ward URL and send the browser there. */
    async function goToWard(path, body) {
        const response = await request("POST", path, body);
        if (!(response instanceof Response))
            return { ok: false, error: response };
        if (!response.ok) {
            const error = await errorFrom(response);
            if (response.status === 401 && error.code === "unauthorized")
                setState(signedOut());
            return { ok: false, error };
        }
        const { url } = (await response.json());
        navigate(url);
        return { ok: true };
    }
    /** A guarded action answered with no session body; refresh to pick up its effect. */
    async function act(path, body) {
        const response = await request("POST", path, body);
        if (!(response instanceof Response))
            return { ok: false, error: response };
        if (!response.ok) {
            const error = await errorFrom(response);
            if (response.status === 401 && error.code === "unauthorized")
                setState(signedOut());
            return { ok: false, error };
        }
        return { ok: true, response };
    }
    /** A credential action that, on success, answers with the new session. */
    async function signIn(path, body) {
        const response = await request("POST", path, body);
        if (!(response instanceof Response))
            return { ok: false, error: response };
        if (!response.ok)
            return { ok: false, error: await errorFrom(response) };
        setState(stateFromBody((await response.json())));
        return { ok: true };
    }
    return {
        basePath,
        getState: () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        refresh,
        ensureLoaded() {
            if (!loaded && inflight === undefined)
                void refresh();
        },
        login: (username, password) => signIn("/login", { username, password }),
        register: (username, password) => signIn("/register", { username, password }),
        async logout() {
            const response = await request("POST", "/logout");
            if (!(response instanceof Response))
                return { ok: false, error: response };
            if (!response.ok)
                return { ok: false, error: await errorFrom(response) };
            setState(signedOut());
            return { ok: true };
        },
        async changePassword(currentPassword, newPassword) {
            const response = await request("POST", "/password", { currentPassword, newPassword });
            if (!(response instanceof Response))
                return { ok: false, error: response };
            if (!response.ok) {
                const error = await errorFrom(response);
                // The session ended under us (expired, or ended elsewhere): say so.
                if (response.status === 401 && error.code === "unauthorized")
                    setState(signedOut());
                return { ok: false, error };
            }
            return { ok: true };
        },
        startWardSignIn: (startOptions = {}) => goToWard("/ward/start", startOptions.returnTo === undefined ? {} : { returnTo: startOptions.returnTo }),
        startWardLink: () => goToWard("/ward/link"),
        startWardReauthentication: () => goToWard("/ward/reauthenticate"),
        async unlinkWard() {
            const result = await act("/ward/unlink");
            if (!result.ok)
                return result;
            const { signedOut: ended } = (await result.response.json());
            if (ended)
                setState(signedOut());
            else
                await refresh();
            return { ok: true };
        },
        async setLocalPassword(newPassword, currentPassword) {
            const result = await act("/ward/set-password", currentPassword === undefined ? { newPassword } : { newPassword, currentPassword });
            if (!result.ok)
                return result;
            // `hasPassword` is now true; ask so every `useSession` sees it.
            await refresh();
            return { ok: true };
        },
        async signOutOfWard() {
            const result = await act("/ward/logout");
            if (!result.ok)
                return result;
            const { url } = (await result.response.json());
            setState(signedOut());
            if (url !== null)
                navigate(url);
            return { ok: true };
        },
        getWardResult: () => wardResult,
        clearWardResult() {
            if (wardResult.error === undefined && wardResult.result === undefined)
                return;
            wardResult = {};
            for (const listener of listeners)
                listener();
        },
    };
}
let defaultClient;
/**
 * Point the hooks at the plugin's routes. Call once, at startup, before the
 * first render:
 *
 * ```ts
 * configureAuth({ basePath: "/atrium/api/auth" });
 * ```
 */
function configureAuth(options) {
    defaultClient = createAuthClient(options);
    return defaultClient;
}
/** The configured client. Throws if `configureAuth` has not run. */
function getAuthClient() {
    if (defaultClient === undefined) {
        throw new Error("ward-auth: call configureAuth({ basePath }) before using the hooks");
    }
    return defaultClient;
}

function useClient(options) {
    return options?.client ?? getAuthClient();
}
/** The session, loaded on first use, plus a way to ask again. */
function useSession(options) {
    const client = useClient(options);
    const state = useSyncExternalStore(client.subscribe, client.getState, client.getState);
    useEffect(() => {
        client.ensureLoaded();
    }, [client]);
    const refresh = useCallback(async () => {
        await client.refresh();
    }, [client]);
    return { ...state, refresh };
}
function useAction(run) {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState(null);
    const perform = useCallback(async (...args) => {
        setPending(true);
        setError(null);
        try {
            const result = await run(...args);
            if (!result.ok)
                setError(result.error);
            return result.ok;
        }
        finally {
            setPending(false);
        }
    }, [run]);
    const reset = useCallback(() => setError(null), []);
    return { pending, error, reset, perform };
}
/**
 * `login(username, password)` resolves `true` on success, when the session
 * state is already signed in. On failure `error.code` is `invalid_credentials`,
 * `too_many_attempts` (with `retryAfterSeconds`), `invalid_request` or
 * `network`; the app writes the message.
 */
function useLogin(options) {
    const client = useClient(options);
    const run = useCallback((username, password) => client.login(username, password), [client]);
    const { perform, ...state } = useAction(run);
    return { ...state, login: perform };
}
/** `logout()` ends the session here; the state becomes signed out. */
function useLogout(options) {
    const client = useClient(options);
    const run = useCallback(() => client.logout(), [client]);
    const { perform, ...state } = useAction(run);
    return { ...state, logout: perform };
}
/**
 * `changePassword(current, next)`. On success every *other* session the user
 * holds has ended and `done` is true. Errors: `invalid_credentials` (wrong
 * current password), `password_too_short`, `password_too_long`,
 * `too_many_attempts`, `unauthorized`.
 */
function useChangePassword(options) {
    const client = useClient(options);
    const [done, setDone] = useState(false);
    const run = useCallback(async (currentPassword, newPassword) => {
        setDone(false);
        const result = await client.changePassword(currentPassword, newPassword);
        if (result.ok)
            setDone(true);
        return result;
    }, [client]);
    const { perform, ...state } = useAction(run);
    return { ...state, changePassword: perform, done };
}
/**
 * `register(username, password)`, for the app that enables registration.
 * Signs the new user in on success. Errors: `username_taken`,
 * `invalid_username`, `password_too_short`, `password_too_long`,
 * `too_many_attempts`.
 */
function useRegister(options) {
    const client = useClient(options);
    const run = useCallback((username, password) => client.register(username, password), [client]);
    const { perform, ...state } = useAction(run);
    return { ...state, register: perform };
}
// ---------------------------------------------------------------------------
// Sign in with Ward
// ---------------------------------------------------------------------------
/** The Ward result the page was loaded with (`?ward_error=` / `?ward=`), and a way to dismiss it. */
function useWardResult(options) {
    const client = useClient(options);
    const result = useSyncExternalStore(client.subscribe, client.getWardResult, client.getWardResult);
    const clear = useCallback(() => client.clearWardResult(), [client]);
    return { ...result, clear };
}
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
function useWardSignIn(options) {
    const client = useClient(options);
    const landed = useWardResult(options);
    const run = useCallback((signInOptions) => client.startWardSignIn(signInOptions), [client]);
    const { perform, error, reset, pending } = useAction(run);
    const { clear } = landed;
    const resetAll = useCallback(() => {
        reset();
        clear();
    }, [reset, clear]);
    return { pending, error: error ?? landed.error ?? null, reset: resetAll, signIn: perform };
}
/**
 * Settings: "Link Ward". `link()` sends the browser to Ward; the settings
 * page then loads with `linked` true, or with `error` set to
 * `already_linked`, `ward_account_in_use`, `access_denied`,
 * `invalid_callback`, `sign_in_failed` or `unauthorized` (the session that
 * started the link had ended). Show it when `useSession().ward.enabled && !ward.linked`.
 */
function useWardLink(options) {
    const client = useClient(options);
    const landed = useWardResult(options);
    const run = useCallback(() => client.startWardLink(), [client]);
    const { perform, error, reset, pending } = useAction(run);
    const { clear } = landed;
    const resetAll = useCallback(() => {
        reset();
        clear();
    }, [reset, clear]);
    return {
        pending,
        error: error ?? landed.error ?? null,
        reset: resetAll,
        link: perform,
        linked: landed.result === "linked",
    };
}
/**
 * Settings: "Unlink Ward". Refused with `no_local_password` while the user
 * has none (offer `useSetLocalPassword` first), `not_linked` when there is
 * nothing to unlink. If the current session began with Ward it ends too, and
 * the session state becomes signed out.
 */
function useWardUnlink(options) {
    const client = useClient(options);
    const [done, setDone] = useState(false);
    const run = useCallback(async () => {
        setDone(false);
        const result = await client.unlinkWard();
        if (result.ok)
            setDone(true);
        return result;
    }, [client]);
    const { perform, ...state } = useAction(run);
    return { ...state, unlink: perform, done };
}
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
function useSetLocalPassword(options) {
    const client = useClient(options);
    const landed = useWardResult(options);
    const [done, setDone] = useState(false);
    const run = useCallback(async (newPassword, currentPassword) => {
        setDone(false);
        const result = await client.setLocalPassword(newPassword, currentPassword);
        if (result.ok)
            setDone(true);
        return result;
    }, [client]);
    const { perform, ...state } = useAction(run);
    const reauthenticateRun = useCallback(() => client.startWardReauthentication(), [client]);
    const reauth = useAction(reauthenticateRun);
    return {
        ...state,
        pending: state.pending || reauth.pending,
        error: state.error ?? reauth.error,
        setPassword: perform,
        reauthenticate: reauth.perform,
        reauthenticated: landed.result === "reauthenticated",
        done,
    };
}
/**
 * "Sign out of Ward too": ends the session here, then sends the browser to
 * Ward, which ends the Ward session this one began with and comes back to
 * the app's registered sign-out page. For a session that did not begin with
 * Ward it is a plain sign-out. Error: `ward_unavailable` (nothing was ended;
 * offer the ordinary `useLogout`).
 */
function useWardSignOut(options) {
    const client = useClient(options);
    const run = useCallback(() => client.signOutOfWard(), [client]);
    const { perform, ...state } = useAction(run);
    return { ...state, signOut: perform };
}

export { configureAuth, createAuthClient, getAuthClient, useChangePassword, useLogin, useLogout, useRegister, useSession, useSetLocalPassword, useWardLink, useWardResult, useWardSignIn, useWardSignOut, useWardUnlink };
