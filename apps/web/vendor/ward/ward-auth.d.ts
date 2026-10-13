// ward-auth 0.3.1 — built from https://github.com/gandolh/ward-auth (shared-library/).
// MIT licensed; see LICENSE beside this file. Do not edit a vendored copy: copy a newer build in.
import { FastifyRequest, preHandlerAsyncHookHandler, FastifyPluginAsync } from 'fastify';

/**
 * The storage interface the core talks to.
 *
 * Small on purpose: the core owns every rule (hashing, expiry, which sessions
 * a password change ends), and a store only reads and writes rows. One
 * implementation ships, `createSqliteStore`, over the app's own synchronous
 * SQLite handle. Every method may return a promise, so a store over an async
 * driver (a later NestJS or Postgres adapter) satisfies the same interface;
 * the core always awaits.
 *
 * ## Extending it
 *
 * Ward identities (0.2.0) extend this interface rather than editing it —
 * `WardAuthStore` below — and appended migration 2 for their table. Existing
 * methods kept their signatures, so an app that only uses local accounts is
 * not affected by the upgrade.
 */
type Awaitable<T> = T | Promise<T>;
/**
 * Where a session began. `"local"` is a password sign-in in the app;
 * `"ward"` is a "Sign in with Ward" flow (brief 21), the only kind that is
 * checked against Ward every 30 seconds.
 */
type SessionOrigin = "local" | "ward";
/** A user row as the core sees it. All times are epoch milliseconds. */
interface UserRecord {
    /** Opaque, stable, never reused. Minted by the library unless an app migrated it in. */
    id: string;
    /** As entered, trimmed. Shown to people. */
    username: string;
    /** `foldUsername(username)`. Carries the uniqueness constraint. */
    usernameFolded: string;
    /**
     * scrypt `saltHex:hashHex`, or `null` for a user with no local password —
     * one created by a first Ward sign-in (brief 21). Login against a `null`
     * hash spends the dummy hash and fails, exactly like an unknown username.
     */
    passwordHash: string | null;
    /** Defined by the app. The library never interprets it. */
    role: string;
    createdAt: number;
    updatedAt: number;
}
/** A session row. The token itself is never stored, only its hash. */
interface SessionRecord {
    /** `hashSessionToken(token)`. The primary key. */
    idHash: string;
    userId: string;
    origin: SessionOrigin;
    /**
     * Ward's session id (the refresh family `sid`) for a Ward-originated
     * session; `null` for a local one. Written by brief 21.
     */
    wardSid: string | null;
    createdAt: number;
    /** When the sliding expiry was last pushed out. Throttles the write. */
    renewedAt: number;
    /** When the session ends unless renewed first. Never past the absolute cap. */
    expiresAt: number;
}
interface NewUserRecord {
    id: string;
    username: string;
    usernameFolded: string;
    passwordHash: string | null;
    role: string;
    createdAt: number;
}
/** Thrown by `createUser` when the folded username is already held. */
declare class UsernameTakenError extends Error {
    readonly code: "username_taken";
    constructor();
}
/** Thrown by `createUser` when a supplied id is already held. Ids are never reused. */
declare class UserIdTakenError extends Error {
    readonly code: "user_id_taken";
    constructor();
}
interface AuthStore {
    /** Insert a user. Throws `UsernameTakenError` or `UserIdTakenError`. */
    createUser(user: NewUserRecord): Awaitable<UserRecord>;
    findUserById(id: string): Awaitable<UserRecord | undefined>;
    /** Looks up by the **folded** name; the core folds before calling. */
    findUserByFoldedUsername(usernameFolded: string): Awaitable<UserRecord | undefined>;
    /** `null` removes the local password (brief 21 never does; it is here for symmetry). */
    setPasswordHash(userId: string, passwordHash: string | null, now: number): Awaitable<void>;
    setRole(userId: string, role: string, now: number): Awaitable<void>;
    createSession(session: SessionRecord): Awaitable<void>;
    findSession(idHash: string): Awaitable<SessionRecord | undefined>;
    /** Push the sliding expiry out. */
    renewSession(idHash: string, renewedAt: number, expiresAt: number): Awaitable<void>;
    deleteSession(idHash: string): Awaitable<void>;
    /**
     * End every session the user holds except `exceptIdHash`. Returns how many
     * ended. A password change is the caller.
     */
    deleteUserSessions(userId: string, exceptIdHash?: string): Awaitable<number>;
    /** Housekeeping: drop rows whose `expiresAt` has passed. Returns how many. */
    deleteExpiredSessions(now: number): Awaitable<number>;
}
/**
 * A link between a local user and a Ward account. Created by a first "Sign in
 * with Ward" (which also creates the user) or by "Link Ward" in the user's own
 * settings; never by matching a username.
 */
interface WardLinkRecord {
    /** Ward's subject: the ID token's `sub`. */
    subject: string;
    userId: string;
    linkedAt: number;
}
/** Thrown when a Ward account is already linked to another local user. */
declare class WardSubjectTakenError extends Error {
    readonly code: "ward_account_in_use";
    constructor();
}
/** Thrown when the local user already has a Ward account linked. */
declare class AlreadyLinkedError extends Error {
    readonly code: "already_linked";
    constructor();
}
/**
 * The store the Ward half needs: `AuthStore` plus the link table and the ID
 * token a Ward-originated session keeps for "sign out of Ward too". The
 * built-in SQLite store implements all of it.
 */
interface WardAuthStore extends AuthStore {
    findWardLinkBySubject(subject: string): Awaitable<WardLinkRecord | undefined>;
    findWardLinkByUserId(userId: string): Awaitable<WardLinkRecord | undefined>;
    /** Throws `WardSubjectTakenError` or `AlreadyLinkedError`. */
    createWardLink(link: WardLinkRecord): Awaitable<void>;
    /**
     * Insert a user and its link in one transaction, so a failed link never
     * leaves a user nobody can sign in as. Throws what `createUser` and
     * `createWardLink` throw.
     */
    createUserWithWardLink(user: NewUserRecord, subject: string): Awaitable<UserRecord>;
    /** Returns how many links were removed (0 or 1). */
    deleteWardLink(userId: string): Awaitable<number>;
    /** End every Ward-originated session the user holds. Returns how many. */
    deleteUserWardSessions(userId: string): Awaitable<number>;
    setSessionWardIdToken(idHash: string, idToken: string): Awaitable<void>;
    findSessionWardIdToken(idHash: string): Awaitable<string | undefined>;
    /**
     * Record that this session just came back from a verified Ward
     * reauthentication (epoch ms). What setting a first local password checks.
     */
    setSessionReauthenticatedAt(idHash: string, at: number): Awaitable<void>;
    /** `undefined` for a session that never reauthenticated, or no such session. */
    findSessionReauthenticatedAt(idHash: string): Awaitable<number | undefined>;
}
/** Whether a store has the Ward methods (a custom `AuthStore` may not). */
declare function isWardAuthStore(store: AuthStore): store is WardAuthStore;

/**
 * Local accounts and sessions, framework-free.
 *
 * Everything with a rule in it lives here — who may sign in, how long a
 * session lasts, which sessions a password change ends — so the Fastify plugin
 * is only HTTP plumbing, and a later NestJS adapter (imbatranimOS was kept
 * possible, see decisions-oidc.md) would reuse all of it.
 *
 * ## Session lifetimes
 *
 * - **Idle: 14 days.** A session nobody uses for two weeks ends. Long enough
 *   that a personal app opened every weekend never asks for a password; short
 *   enough that a forgotten device stops being signed in on its own.
 * - **Absolute: 30 days.** No session outlives this, however active. It is the
 *   same ceiling as Ward's refresh family (decisions-tokens.md), so a
 *   Ward-originated session and a local one age out on the same clock.
 * - **Renewal at most once an hour.** The sliding expiry is pushed out — and
 *   the cookie re-sent — only when the last renewal is an hour old. A write on
 *   every authenticated request would turn page loads into database writes for
 *   nothing; an hour of slack on a 14-day idle timeout is invisible.
 */
/** A session ends after this long without a request. */
declare const SESSION_IDLE_SECONDS: number;
/** No session outlives this, however active. Ward's refresh-family ceiling. */
declare const SESSION_ABSOLUTE_SECONDS: number;
/** The sliding expiry is written at most this often per session. */
declare const SESSION_RENEW_INTERVAL_SECONDS: number;
/** A user as the app and the browser see it. Never carries the hash. */
interface AuthUser {
    id: string;
    username: string;
    role: string;
    /** False for a user created by a Ward sign-in who has not set a local password. */
    hasPassword: boolean;
}
/** A live, resolved session. */
interface ResolvedSession {
    user: AuthUser;
    session: SessionRecord;
    /**
     * True when this resolution pushed the expiry out. The HTTP layer re-sends
     * the cookie with the new `Max-Age` exactly then.
     */
    renewed: boolean;
}
interface NewUserInput {
    username: string;
    /** Omit or `null` for a user with no local password (a Ward-created user). */
    password?: string | null;
    role: string;
    /**
     * Only when migrating rows that already have keys — briefs 22 and 24 pass
     * each user's Ward subject. Ordinary creation omits it.
     */
    id?: string;
}
interface StartSessionOptions {
    /** Defaults to `"local"`. */
    origin?: SessionOrigin;
    /** Required exactly when `origin` is `"ward"`. Brief 21 passes it. */
    wardSid?: string | null;
}
interface Accounts {
    readonly store: AuthStore;
    /**
     * Create a user. Throws `UsernamePolicyError`, `PasswordPolicyError`,
     * `UsernameTakenError`, `UserIdTakenError`, or `InvalidUserIdError`.
     */
    createUser(input: NewUserInput): Promise<AuthUser>;
    findUserById(id: string): Promise<AuthUser | undefined>;
    findUserByUsername(username: string): Promise<AuthUser | undefined>;
    setRole(userId: string, role: string): Promise<void>;
    /**
     * The password check. `undefined` for an unknown username, a user with no
     * local password, or a wrong password — **one answer, one cost**: every path
     * runs scrypt once, so timing does not reveal which accounts exist.
     */
    verifyCredentials(username: string, password: string): Promise<AuthUser | undefined>;
    /**
     * Change a password given the current one. Returns `false` for a wrong
     * current password (including a user with none). On success **ends every
     * other session the user holds** — the point of changing a password after a
     * leak — and keeps `keepSessionIdHash`, the one the change came from.
     * Throws `PasswordPolicyError` for a bad new password, before any hashing.
     */
    changePassword(userId: string, currentPassword: string, newPassword: string, keepSessionIdHash?: string): Promise<boolean>;
    /**
     * Set a password with no current-password check, ending every other
     * session. For the seed script and brief 21's "set a local password"; a
     * route must establish who is asking before calling it.
     */
    setPassword(userId: string, newPassword: string, keepSessionIdHash?: string): Promise<void>;
    /** Mint a session. The token is the cookie value and is not stored. */
    startSession(userId: string, options?: StartSessionOptions): Promise<{
        token: string;
        session: SessionRecord;
    }>;
    /**
     * The session a cookie value names, renewing its sliding expiry when due.
     * `undefined` when there is none, it expired, or its user is gone. An
     * expired row is deleted on sight.
     */
    resolveSession(token: string | undefined): Promise<ResolvedSession | undefined>;
    /** End one session by its cookie value. Unknown tokens are a no-op. */
    endSession(token: string): Promise<void>;
    /** End one session by its stored hash (the guard's extension hook uses this). */
    endSessionByIdHash(idHash: string): Promise<void>;
    /** Housekeeping. The plugin calls it on each successful login. */
    deleteExpiredSessions(): Promise<number>;
}
interface AccountsOptions {
    store: AuthStore;
    /** Epoch milliseconds. Injected by tests; `Date.now` otherwise. */
    now?: () => number;
}
/** Thrown for an app-supplied user id the library will not store. */
declare class InvalidUserIdError extends Error {
    readonly code: "invalid_user_id";
    constructor();
}
declare function toAuthUser(user: UserRecord): AuthUser;
declare function createAccounts(options: AccountsOptions): Accounts;
/** One user for `seedUsers`. */
interface SeedUser {
    username: string;
    password: string;
    role: string;
    id?: string;
}
interface SeedResult {
    /** Usernames created by this run. */
    created: string[];
    /** Usernames that already existed and were left exactly as they were. */
    existing: string[];
}
/**
 * Create each user that does not exist yet; leave every existing one alone.
 *
 * Idempotent, so an app's seed script can run on every deploy. It never
 * resets a password or a role: a seed that overwrote them would undo whatever
 * the person changed since, every time it ran. The passwords come from the
 * app's environment or a prompt, never from a file in the repo.
 */
declare function seedUsers(accounts: Accounts, users: readonly SeedUser[]): Promise<SeedResult>;

/**
 * The app's session cookie: serialisation, reading, and the `Secure` rule.
 *
 * Ported from Ward's `api/src/auth/cookie.ts`. No `@fastify/cookie`: one
 * cookie with fixed attributes is a few lines of `Set-Cookie` assembly, and
 * the attributes are the security boundary — better written out where they
 * can be read than spread across a plugin's option bag.
 *
 * ## The attributes, and why each is fixed
 *
 * - **Name `<app>_session`**, unique per app. The estate shares one origin, so
 *   two apps using one name would overwrite each other's cookie.
 * - **`HttpOnly`**, unconditional: no script on the page ever reads it.
 * - **`SameSite=Lax`**, unconditional, and it is also the CSRF defence. The
 *   browser withholds the cookie from any cross-site `POST`, so a form on
 *   another site cannot act with it. `Strict` would also withhold it on the
 *   top-level navigation back from Ward's login page (brief 21), which breaks
 *   the return hop.
 * - **`Secure`** unless the app's public origin is plain HTTP on loopback —
 *   see `secureCookiesFor`.
 * - **`Path=` the app's API prefix, as the browser sees it.** Scoped, so the
 *   cookie is not sent to every other app on the shared origin. Every request
 *   that needs the session — WebSocket upgrades and `<img>` fetches included —
 *   must live under that path. It is the *browser's* path: when the reverse
 *   proxy strips a prefix before Fastify sees the request, the cookie must
 *   still carry the public one, or the browser never sends it.
 */
/** What `serializeCookie` emits. Not general-purpose; this library's set only. */
interface CookieOptions {
    name: string;
    value: string;
    path: string;
    /** Omitted entirely for a browser-session cookie; `0` to expire immediately. */
    maxAgeSeconds?: number;
    /** From `secureCookiesFor` — never hard-code it. */
    secure: boolean;
}
/**
 * Build one `Set-Cookie` value. `HttpOnly` and `SameSite=Lax` have no
 * parameter, because there is no session cookie that should lack them and an
 * option is an invitation to set it wrong.
 */
declare function serializeCookie(options: CookieOptions): string;
/**
 * The `Set-Cookie` value that destroys the cookie.
 *
 * **`Path` and `Secure` must match what was set**, or the browser treats this
 * as a *different* cookie and keeps the original — the classic "logout does not
 * log out" bug. An empty value, `Max-Age=0` and a 1970 `Expires` for anything
 * that ignores `Max-Age`.
 */
declare function clearedCookie(name: string, path: string, secure: boolean): string;
/**
 * Read one cookie out of a `Cookie` request header.
 *
 * Returns the **first** occurrence. A duplicate name is a client bug or a
 * shadowing attempt (a cookie of the same name set at a broader path to sit in
 * front of the real one); the browser sends the more specific path first, and
 * taking the first match is the safer of the two readings.
 */
declare function readCookie(header: string | string[] | undefined, name: string): string | undefined;
/**
 * Whether the cookie carries `Secure`, derived from the app's public origin.
 *
 * `Secure` **unless** the origin is plain HTTP on loopback, because a `Secure`
 * cookie is not stored at all over `http://localhost`, and the workaround
 * people reach for instead is dropping `Secure` everywhere. The condition is
 * `http:` **and** loopback, so plain HTTP on a real hostname — a session
 * cookie crossing a network in the clear — still gets `Secure` and simply does
 * not work. That is the correct direction to fail in. An unparseable origin
 * also fails closed.
 */
declare function secureCookiesFor(publicOrigin: string): boolean;

/**
 * Usernames, user ids and session tokens: the three identifiers the library
 * mints or compares.
 */
/**
 * The longest username accepted, in UTF-16 code units. Ward's own limit, so
 * that every migrated Ward account fits (briefs 22 and 24 carry usernames
 * over).
 */
declare const MAX_USERNAME_LENGTH = 256;
/** Thrown for a username that must never reach the database. */
declare class UsernamePolicyError extends Error {
    readonly code: "invalid_username";
    constructor(message: string);
}
/**
 * Trim and validate a username for **storage**. Returns the trimmed value.
 *
 * Login does not call this: a name that could never have been stored cannot
 * match a row, and refusing it early would add a branch before the dummy hash.
 */
declare function normaliseUsername(username: string): string;
/**
 * The comparison form of a username, and the column the uniqueness constraint
 * sits on. NFKC then lower-case, exactly as Ward folds.
 */
declare function foldUsername(username: string): string;
/**
 * A new session token: 32 random bytes, base64url. This is the cookie value
 * and it is **never stored**; the row holds `hashSessionToken(token)`.
 */
declare function generateSessionToken(): string;
/**
 * The stored form of a session token: SHA-256, hex.
 *
 * Why hash at all: a copy of the database (a backup, a support dump) must not
 * be a set of live cookies. Why a fast hash and not scrypt: the token is 256
 * random bits, so there is nothing to brute-force and the hash is on every
 * authenticated request. The lookup is an index hit on the digest, so there is
 * no comparison whose timing could leak a prefix.
 */
declare function hashSessionToken(token: string): string;

/**
 * Failed-attempt lockout, keyed on the client address.
 *
 * Ported from Ward's `api/src/auth/lockout.ts`. The rules are Ward's and each
 * one was paid for by a finding there; the only structural change is that the
 * state lives in an **instance** (`createLockout()`) rather than in module
 * scope, so a test needs no reset function and two plugins in one process do
 * not share counters by accident.
 *
 * ## Keyed on the address, never on the username
 *
 * A username-keyed lockout hands any stranger a way to lock a real person out
 * of their own account, for free, by submitting wrong passwords for a name they
 * read off the page. The measure that was supposed to protect the account
 * becomes the attack. An address-keyed counter costs the attacker their own
 * connectivity instead, and the people using these apps are the owner plus a
 * few known people, so a shared address being throttled together is a cost
 * worth paying.
 *
 * ## The decision is on the address; the *forgiveness* is on the account
 *
 * The counter that trips a `429` is keyed on `(surface, address)` and nothing
 * else. But `clearFailures` may only forgive the failures **attributable to
 * the account that just authenticated**, which is why an entry carries a
 * per-account breakdown. Without that split one valid account buys unlimited
 * guessing: interleave four wrong guesses at somebody else with one correct
 * login as yourself and the address never reaches the limit. Ward measured
 * that at ~35 guesses a second before fixing it.
 *
 * ## Per-surface budgets
 *
 * Login, registration and password change hold **independent** budgets.
 * Spending the password-change budget (which needs a session first) must never
 * lock the same address out of login, which is how the person would recover,
 * and a registration flood must not stop existing users signing in.
 *
 * ## No artificial delay
 *
 * There is no `sleep` anywhere here or in the callers. Holding a connection
 * open per failed attempt **is** the denial of service the lockout exists to
 * prevent. Refuse immediately with a `429` and a `Retry-After`.
 *
 * ## In-memory, and it resets on restart
 *
 * A restart forgives every counter, which is fine: the window is 15 minutes
 * and a restart is not something an attacker can cause. Do not grow this into
 * a table without thinking — a write per failed login on an app's only
 * anonymous endpoint is a better amplification target than a bounded map.
 */
/**
 * Failures tolerated before the next attempt is refused. Attempts 1–5 get a
 * `401`; the **sixth** request earns the `429`, because the check runs before
 * the attempt rather than after it.
 */
declare const LOCKOUT_MAX_FAILURES = 5;
/**
 * How long a counter survives, in seconds, and therefore how long a lockout
 * lasts once it trips. Every failure pushes the expiry out again, so the window
 * slides: nobody gets a free attempt every 15 minutes by timing the boundary.
 */
declare const LOCKOUT_WINDOW_SECONDS: number;
/**
 * Which credential surface a counter belongs to. Each member is an independent
 * budget.
 *
 * **Adding a surface means adding a member here**, not borrowing an existing
 * one. The union is closed so that borrowing is a compile error rather than a
 * quiet coupling nobody notices until the two interfere.
 */
type LockoutSurface = "login" | "register" | "change_password";
/** Who is attempting what, from where. */
interface LockoutTarget {
    surface: LockoutSurface;
    /** From `lockoutKeyFor(...)`. The counter the `429` decision is keyed on. */
    address: string;
    /**
     * The account the attempt was aimed at, **folded** (`foldUsername`), so
     * `Alice` and `alice` are one bucket. Only `recordFailure` and
     * `clearFailures` read it; `check` ignores it, because the decision must stay
     * address-wide.
     */
    account?: string;
}
/** The answer to "may this address attempt this right now?". */
interface LockoutDecision {
    allowed: boolean;
    /** Whole seconds, at least 1, and set **only** when `allowed === false`. */
    retryAfterSeconds?: number;
}
/** A lockout counter. One per app process is the expected shape. */
interface Lockout {
    /** Whether `target`'s address may attempt now. Records nothing. */
    check(target: LockoutTarget): LockoutDecision;
    /**
     * Count one failed attempt. Call it for **any** credential rejection, and not
     * for a malformed body: that is a client bug, not a guess. Pass `account`
     * even when the name resolved to no row — that bucket must survive somebody
     * else's success.
     */
    recordFailure(target: LockoutTarget): void;
    /** Forget the failures attributable to `target.account`. Call on success. */
    clearFailures(target: LockoutTarget): void;
    /** The number of tracked `(surface, address)` pairs. For tests; not a metric. */
    size(): number;
}
interface LockoutOptions {
    /** Epoch milliseconds. Injected by tests; `Date.now` otherwise. */
    now?: () => number;
}
declare function createLockout(options?: LockoutOptions): Lockout;
/**
 * One trusted-proxy entry, parsed: an address range a socket peer can fall in.
 *
 * Built only by `parseTrustedProxies`, which is what guarantees the invariants
 * the matcher relies on — `bytes` is 4 or 16 long, `prefix` is in range, and no
 * bit past `prefix` is set.
 */
interface TrustedProxyRange {
    /** The entry as configured, trimmed. For messages; never matched against. */
    readonly source: string;
    /**
     * The network address: 4 bytes for IPv4, 16 for IPv6. An IPv4-mapped IPv6
     * entry (`::ffff:10.0.0.0/104`) is stored as the IPv4 range it means, because
     * peers are compared in the same normalised form.
     */
    readonly bytes: readonly number[];
    /** How many leading bits of a peer must equal `bytes`. */
    readonly prefix: number;
}
/**
 * The parsed trusted-proxy list `lockoutKeyFor` takes. Parse it **once** — the
 * plugin does it at registration, from its `trustedProxies` option or
 * `AUTH_TRUSTED_PROXIES` — never per request, so a malformed entry is a
 * refusal to start rather than a `500` on every login.
 */
type TrustedProxies = readonly TrustedProxyRange[];
/** How `lockoutKeyFor` reports a misconfiguration it cannot fix. */
interface LockoutKeyOptions {
    /**
     * Called — at most once per `LOCKOUT_AMBIGUOUS_ADDRESS_WARN_INTERVAL_SECONDS`
     * per process for each of two conditions — when the derived key is probably
     * not the client:
     *
     * - no client address could be derived, so every caller shares one bucket;
     * - an `X-Forwarded-For` arrived from a peer that is not trusted and was
     *   ignored, which is what a proxy missing from `trustedProxies` looks like.
     *
     * Shaped `(detail, message)` so a pino logger can be passed straight through.
     */
    warn?: (detail: Record<string, unknown>, message: string) => void;
    /**
     * Peers, beyond loopback, whose `X-Forwarded-For` is believed. From
     * `parseTrustedProxies`. Absent or empty means loopback only, which is the
     * pre-container behaviour: nothing loosens unless it is configured.
     */
    trustedProxies?: TrustedProxies;
}
/**
 * The lockout key for an HTTP request, given the socket peer and whatever
 * `X-Forwarded-For` arrived.
 *
 * ## Why this is not just `request.ip`
 *
 * Every app sits behind Caddy, so **every** request's socket peer is the proxy,
 * not the client. Fastify's `request.ip` is the socket peer unless `trustProxy`
 * is configured — so keying on it gives the entire internet one shared
 * counter, and the sixth failed login anywhere locks out everybody. That is a
 * self-inflicted outage dressed as a security control.
 *
 * ## Why trusting the header here is safe, and only here
 *
 * The header is honoured **only when the peer is loopback or inside a trusted
 * range**, which means the request came through the app's own proxy, and Caddy
 * *appends* the peer it saw. So the **last** element is the address Caddy
 * observed, and a client that sends `X-Forwarded-For: 1.2.3.4` only prepends a
 * value nobody reads. Taking the first element — the usual convention — would
 * be the spoofable choice. It does not walk leftwards past trusted elements
 * either: a trusted range is a Docker bridge network, and anything on it could
 * then pick its bucket by prepending. If the peer is neither, the app is
 * reachable directly and the header is ignored in favour of the socket address.
 *
 * ## Why loopback alone stopped being enough
 *
 * In a container that publishes `127.0.0.1:<port>`, host Caddy reaches the app
 * through Docker's proxy and the peer is a bridge address, never loopback.
 * Loopback-only trust (0.1.0 and 0.2.0) then ignored the header for every
 * request and the whole internet shared one counter — Ward's brief 28.
 * `trustedProxies` names the bridge ranges; loopback is trusted without being
 * listed.
 *
 * ## Both misconfigurations are loud, not silent
 *
 * A trusted peer with no forwarded address still **fails closed** into one
 * shared bucket (a per-request bucket would disable the lockout outright), and
 * says so through `options.warn`. So does a header from an untrusted peer, which
 * is what a proxy missing from `trustedProxies` looks like.
 */
declare function lockoutKeyFor(socketAddress: string | undefined | null, forwardedFor: string | string[] | undefined, options?: LockoutKeyOptions): string;
/**
 * Parse a trusted-proxy list: addresses or CIDR ranges, IPv4 or IPv6, given as
 * an array or as one comma-separated string (`AUTH_TRUSTED_PROXIES`). Blank
 * entries are skipped, so an empty string is an empty list.
 *
 * **Throws** a `TypeError` naming the entry on anything it cannot read exactly.
 * Each refusal is a typo that would otherwise widen or narrow trust silently:
 *
 * - not an address, a prefix out of range, or a zone id;
 * - host bits set past the prefix (`172.19.0.3/16`) — most tools mask that
 *   quietly, but it is as likely a mistyped prefix as a mistyped address;
 * - a `/0`, which trusts every peer and so lets any client that reaches the
 *   service directly pick its own lockout bucket.
 */
declare function parseTrustedProxies(entries: string | readonly string[]): TrustedProxies;

/**
 * The shortest password the library will hash.
 *
 * Enforced at **hash** time, not at verify time — `verifyPassword` deliberately
 * has no length rule at all. A short submitted password cannot match any stored
 * hash anyway, so checking its length on the login path would only buy a
 * different error message while adding a branch that runs before the KDF.
 */
declare const MIN_PASSWORD_LENGTH = 8;
/**
 * The longest password the library will accept, in UTF-16 code units.
 *
 * scrypt's cost is dominated by `N` rather than by the input length, so this is
 * not about the KDF: it is about not copying a multi-megabyte request body into
 * a Buffer on an unauthenticated endpoint. 1024 is far past any real password
 * and far short of anything that costs measurable memory.
 */
declare const MAX_PASSWORD_LENGTH = 1024;
/** Thrown by `hashPassword` for input that must never reach the database. */
declare class PasswordPolicyError extends Error {
    /** A stable machine-readable code, so a route need not match on the message. */
    readonly code: "password_too_short" | "password_too_long";
    constructor(code: "password_too_short" | "password_too_long", message: string);
}
/**
 * Hash a password for storage. Returns `saltHex:hashHex`.
 *
 * Throws `PasswordPolicyError` outside `MIN_PASSWORD_LENGTH ..
 * MAX_PASSWORD_LENGTH`. Registration, password change and the seed helper are
 * the callers; each surfaces `error.code` rather than the message.
 *
 * The salt is fresh per call, which is why the same password hashed twice gives
 * two different values — and why a stolen app database cannot be attacked with one
 * precomputed table across every account at once.
 */
declare function hashPassword(password: string): Promise<string>;
/**
 * Verify a password against a stored `saltHex:hashHex` value.
 *
 * **Always runs scrypt**, including when `stored` is not a value this module
 * produced — a fixture hash, a hand-edited row, a value from some future
 * versioned format. An unparseable stored value returns `false` after paying
 * the same cost as a real comparison, so "this account's hash is malformed" is
 * not something an attacker can time.
 *
 * Never throws for bad input. A login route wants an answer, not an exception
 * whose stack trace it then has to keep out of the log.
 */
declare function verifyPassword(password: string, stored: string): Promise<boolean>;
/**
 * Spend a hash on a password that has no account to compare it against, and
 * return `false`.
 *
 * This is the whole defence against account enumeration by timing, and Ward
 * does the same thing. Without it, `POST /login` answers in under a millisecond
 * for a username that does not exist and in ~50 ms for one that does — which
 * means anyone with a wordlist can enumerate an app's accounts from the
 * response time alone, with no error message to go on and nothing in the logs
 * that looks unusual.
 *
 * It derives a key over the *submitted* password with a random salt and then
 * fails a `timingSafeEqual` against a digest of the correct length, so the work
 * is byte-for-byte the work a real verification does.
 *
 * The return type is the literal `false` so a call site cannot accidentally
 * treat it as a credential check that might succeed.
 */
declare function spendDummyHash(password: string): Promise<false>;

/**
 * The library's own schema, as an ordered list of migrations.
 *
 * The tables are the library's, not the app's: every name carries the `auth_`
 * prefix and the applied versions live in `auth_migrations`, so they sit
 * beside an app's own Knex, Drizzle or hand-rolled migrations without either
 * system seeing the other's rows.
 *
 * ## Appending a migration
 *
 * Add an entry at the **end** with the next `version`. Never edit or reorder
 * one that has shipped: a vendored copy in some app has already applied it,
 * and the runner records versions, not contents. Version 2 (0.2.0) added the
 * Ward link table this way, and version 3 (0.3.1) a session column.
 *
 * ## The SQL is the intersection of two drivers
 *
 * Apps hand over either a better-sqlite3 handle or a `node:sqlite`
 * `DatabaseSync`. Both are SQLite underneath, so plain DDL is portable; what
 * differs is the driver surface, and that is handled in `sqlite.ts`.
 */
interface Migration {
    /** Strictly increasing, starting at 1. Recorded in `auth_migrations`. */
    version: number;
    /** For the migrations table and for error messages. */
    name: string;
    /** One or more statements, run with `exec` inside one transaction. */
    sql: string;
}
declare const SQLITE_MIGRATIONS: readonly Migration[];

/**
 * The built-in store, over a **synchronous** SQLite handle the app already has.
 *
 * ## One handle type for two drivers
 *
 * `SqliteHandle` is the intersection of better-sqlite3's `Database` and
 * `node:sqlite`'s `DatabaseSync`, written structurally so this file imports
 * neither driver and the bundle carries no native code. Both pass as-is:
 *
 * ```ts
 * createSqliteStore(new Database("app.db"));     // better-sqlite3
 * createSqliteStore(new DatabaseSync("app.db")); // node:sqlite
 * ```
 *
 * An app on Knex or Drizzle hands over the better-sqlite3 handle underneath.
 *
 * Living in the intersection means a few rules, each of which one of the two
 * drivers enforces:
 *
 * - **Positional `?` parameters only.** The two disagree about named-parameter
 *   prefixes.
 * - **`null`, never `undefined`,** for a missing value; better-sqlite3 throws on
 *   `undefined`.
 * - **No booleans** — numbers only. Neither driver binds a JS boolean the same
 *   way.
 * - **Transactions by SQL**, not `db.transaction()`, which only better-sqlite3
 *   has. A `SAVEPOINT` rather than `BEGIN`, so the store also works when the
 *   app calls it from inside a transaction of its own.
 * - **No reliance on `lastInsertRowid`.** Every key is chosen before the insert.
 */
/** A value either driver binds. */
type SqlValue = string | number | bigint | null;
/** The statement surface both drivers share. Results are read as `unknown` and mapped. */
interface SqliteStatement {
    run(...params: SqlValue[]): {
        changes: number | bigint;
    };
    get(...params: SqlValue[]): unknown;
    all(...params: SqlValue[]): unknown[];
}
/** The database surface both drivers share. */
interface SqliteHandle {
    prepare(sql: string): SqliteStatement;
    exec(sql: string): unknown;
}
/**
 * A store whose methods answer synchronously — what the SQLite store is,
 * since both drivers are synchronous. Still assignable to `AuthStore`.
 */
type SyncStore<S> = {
    [K in keyof S]: S[K] extends (...args: infer A) => infer R ? (...args: A) => Awaited<R> : S[K];
};
/**
 * The SQLite store's own type: `WardAuthStore` (and so `AuthStore`), answered
 * synchronously.
 */
type SqliteAuthStore = SyncStore<WardAuthStore>;
interface SqliteStoreOptions {
    /**
     * The migration list. Defaults to `SQLITE_MIGRATIONS`, and an app should
     * never pass anything else; tests pass a longer list to prove an appended
     * migration applies.
     */
    migrations?: readonly Migration[];
}
/** Raised when the database holds a newer schema than this copy knows. */
declare class SchemaTooNewError extends Error {
    constructor(found: number, known: number);
}
/**
 * Apply every migration newer than what `auth_migrations` records, each in its
 * own savepoint, in order. Idempotent: a second call applies nothing.
 *
 * Returns the versions it applied, for a boot log line.
 */
declare function migrateSqlite(db: SqliteHandle, migrations?: readonly Migration[]): number[];
/**
 * The SQLite `AuthStore`. Runs pending migrations first, so the tables exist
 * by the time this returns; call it once at boot, after the app's own
 * migrations or before them — the two never touch each other's tables.
 */
declare function createSqliteStore(db: SqliteHandle, options?: SqliteStoreOptions): SqliteAuthStore;

/**
 * The errors the Ward half throws, shaped like `client/`'s so an app moving
 * off that package keeps its `instanceof` checks.
 */
/**
 * Ward could not be reached, or answered outside its documented contract: a
 * network error, a timeout, an unexpected status, a body that does not parse.
 *
 * **Not** the same as "this session is not active". Every caller fails closed
 * on it: a Ward-originated session is refused while Ward cannot answer, and
 * the person is told to sign in with their local password instead
 * (decisions-oidc.md, "Failing closed still holds"). `statusCode` 503, so a
 * Fastify error handler that does nothing special still answers sensibly.
 */
declare class WardUnavailableError extends Error {
    /** Widened so `WardConfigurationError` can name itself. */
    readonly name: string;
    readonly statusCode: number;
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
/**
 * Ward refused this app's client credential: a `401 invalid_client`.
 *
 * A subclass of `WardUnavailableError`, so every call site that fails closed
 * on that keeps doing so. What it adds is the diagnosis: everything else that
 * goes wrong talking to Ward is transient and about Ward, while this is
 * permanent and about **this app's configuration** — `WARD_OIDC_CLIENT_ID` or
 * `WARD_OIDC_CLIENT_KEY` is wrong, or the public half is not registered in
 * Ward's console. Retrying will not help.
 */
declare class WardConfigurationError extends WardUnavailableError {
    readonly name = "WardConfigurationError";
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
/**
 * Why a "Sign in with Ward" round trip did not produce a signed-in user. The
 * `code` is what the callback puts in `?ward_error=` and what the React hooks
 * expose; the app writes the message.
 */
declare class WardSignInError extends Error {
    readonly code: string;
    readonly name = "WardSignInError";
    constructor(code: string, message: string, options?: {
        cause?: unknown;
    });
}

/**
 * Talking to Ward: "Sign in with Ward", the 30-second check, mail, and
 * "sign out of Ward too". Framework-free; the Fastify plugin is the only
 * caller in the library, and an app calls `sendNotification` itself.
 *
 * ## Configuration, and nothing assumed about where Ward lives
 *
 * Four values, all from the app's environment (`wardClientOptionsFromEnv`
 * reads them): the issuer, the client id, the client's private key and the
 * redirect URI. Every Ward URL is derived from the issuer — discovery for the
 * OAuth endpoints, and `<issuer minus /oidc>/session-status` and `/notify` for
 * Ward's own — so nothing here assumes Ward shares the app's origin. Locally
 * it does not: Ward runs on its own port, which exercises the cross-origin
 * case on every dev run (decisions-oidc.md).
 *
 * ## Discovery happens once, lazily
 *
 * The provider's metadata is fetched on first use and cached for the life of
 * the process. **Not at boot**: an app must start, and its local sign-in must
 * work, while Ward is down. A failed discovery is not cached, so the next
 * attempt tries again.
 *
 * ## `openid-client`, bundled
 *
 * The code flow is `openid-client` (panva), not hand-written: PKCE, `state`,
 * `nonce`, the `iss` response parameter, client authentication and ID token
 * validation are exactly the code that should come from a certified library.
 * Two settings matter and both are fixed here, not options:
 *
 * - `id_token_signed_response_alg: "EdDSA"` pins the ID token's algorithm.
 *   Without it `openid-client` expects RS256 and rejects every token Ward
 *   signs; with it, a token in any other algorithm is refused.
 * - Non-repudiation checks are on, so the ID token's signature is verified
 *   against Ward's published keys and not only trusted because it arrived over
 *   the authenticated token request.
 */
/** Answers are cached this long per Ward session: the revoke-everywhere bound. */
declare const SESSION_STATUS_CACHE_SECONDS = 30;
/** Default timeout for discovery, the code exchange and the session check. */
declare const DEFAULT_WARD_TIMEOUT_MS = 5000;
/** Default timeout for `/notify`: Ward answers after its mail transport accepts. */
declare const DEFAULT_NOTIFY_TIMEOUT_MS = 15000;
interface WardClientOptions {
    /**
     * `WARD_OIDC_ISSUER`: Ward's issuer, external, ending in `/oidc`, e.g.
     * `https://example.com/ward-api/oidc`. `http:` only on loopback.
     */
    issuer: string;
    /** `WARD_OIDC_CLIENT_ID`: the app's slug at Ward. */
    clientId: string;
    /** `WARD_OIDC_CLIENT_KEY`: base64url of the private JWK. A secret. */
    clientKey: string;
    /**
     * `WARD_OIDC_REDIRECT_URI`: the callback **as the browser sees it**,
     * registered at Ward exactly. It must be the plugin's
     * `<routePrefix>/ward/callback`, served under the app's API prefix (see the
     * adoption guide), e.g. `https://example.com/myapp-api/auth/ward/callback`.
     */
    redirectUri: string;
    /**
     * `WARD_OIDC_POST_LOGOUT_REDIRECT_URI`: where Ward sends the browser after
     * "sign out of Ward too". Must be registered at Ward. Omitted, Ward shows
     * its own signed-out page.
     */
    postLogoutRedirectUri?: string;
    /** For tests; the global `fetch` otherwise. Used for every request to Ward. */
    fetch?: typeof fetch;
    /** Discovery, code exchange and session check. Default 5 s. */
    timeoutMs?: number;
    /** `/notify`. Default 15 s. */
    notifyTimeoutMs?: number;
    /** Epoch milliseconds, for the session-check cache only. Injected by tests. */
    now?: () => number;
}
/** Who Ward says signed in, from a verified ID token. */
interface WardIdentity {
    /** `sub`: Ward's stable subject. The only thing a local user is linked by. */
    subject: string;
    /** `preferred_username`: a suggestion for a new user's name, never a key. */
    username: string;
    /** `ward_role`: the role the grant names, for a user created by this sign-in. */
    role: string;
    /** `ward_sid`: Ward's refresh family, what the 30-second check asks about. */
    wardSid: string;
    /** The raw ID token, kept as the `id_token_hint` for "sign out of Ward too". */
    idToken: string;
    /**
     * `auth_time`, epoch seconds: when the person last typed their Ward
     * password. Ward sends it only when the request asked (`prompt=login` or
     * `max_age`), so a plain sign-in usually has none.
     */
    authTime?: number;
    /** `iat`, epoch seconds: when Ward issued the ID token, on Ward's clock. */
    issuedAt?: number;
}
/** The secrets one authorization round trip carries in the flow cookie. */
interface WardFlowSecrets {
    state: string;
    nonce: string;
    codeVerifier: string;
}
type WardSessionStatus = {
    active: true;
    role: string;
} | {
    active: false;
};
interface WardNotification {
    /** The recipient's **Ward subject**. Only linked users have one. */
    subject: string;
    /** One line, at most 200 characters. Ward prefixes the app's name. */
    mailSubject: string;
    /** Plain text, at most 20,000 characters. Ward appends a footer. */
    text: string;
}
interface WardClient {
    readonly issuer: string;
    readonly clientId: string;
    readonly redirectUri: string;
    /**
     * The authorization URL to send the browser to, and the secrets to keep
     * for the callback. `prompt: "login"` makes Ward ask for the password even
     * with a live Ward session, and makes the ID token carry `auth_time`.
     * Throws `WardUnavailableError`.
     */
    startAuthorization(options?: {
        prompt?: "login";
    }): Promise<{
        url: string;
        flow: WardFlowSecrets;
    }>;
    /**
     * Finish the round trip: check the response against the flow, exchange the
     * code with client authentication, verify the ID token. `search` is the
     * callback's query string. Throws `WardSignInError` with a stable `code`.
     */
    finishAuthorization(search: string, flow: WardFlowSecrets): Promise<WardIdentity>;
    /**
     * Is this Ward session live, and the grant still held? Cached 30 s per
     * session, concurrent calls collapsed into one request. Throws
     * `WardUnavailableError` (or its `WardConfigurationError`) for anything but
     * a well-formed `200`: the caller fails closed.
     */
    checkSession(wardSid: string, subject: string): Promise<WardSessionStatus>;
    /**
     * Ask Ward to mail a linked user. `{ sent: false }` is Ward's refusal, which
     * does not say why. Throws `WardUnavailableError` on a transport failure or
     * Ward's `503 mail_unavailable`, `WardConfigurationError` on a `401`.
     */
    sendNotification(input: WardNotification): Promise<{
        sent: boolean;
    }>;
    /**
     * Ward's end-session URL for "sign out of Ward too". Ward revokes the
     * session the hint's `ward_sid` names. Throws `WardUnavailableError` when
     * discovery fails.
     */
    endSessionUrl(idTokenHint: string, state?: string): Promise<string>;
}
/**
 * Build a client. Validates the configuration and imports the key now, so a
 * bad value fails at boot; talks to Ward only on first use.
 */
declare function createWardClient(options: WardClientOptions): Promise<WardClient>;
/**
 * The four (and one optional) env variables the local seed writes and the
 * deploy provides. `undefined` when `WARD_OIDC_ISSUER` is unset — the app runs
 * with local accounts only — and a thrown error naming what is missing when
 * the set is incomplete, which is always a deploy mistake.
 */
declare function wardClientOptionsFromEnv(env?: Record<string, string | undefined>): WardClientOptions | undefined;

/**
 * Local users and Ward accounts: who a Ward sign-in is, and the links.
 *
 * ## The rules (decisions-oidc.md)
 *
 * A Ward sign-in resolves to a local user in exactly one way:
 *
 * 1. a user **linked** to that Ward subject signs in;
 * 2. otherwise, in link mode, the signed-in user who started the flow from
 *    their settings gets linked (the plugin does this, with `link`);
 * 3. otherwise a **new** local user is created, linked to the subject, named
 *    from `preferred_username` (suffixed if the name is taken) and holding the
 *    role the grant names.
 *
 * **Never by username.** A local `alice` and a Ward `alice` are strangers
 * until alice links them herself. On a shared origin anything else is account
 * takeover: whoever controls the Ward account named `alice` would walk into
 * the local one.
 *
 * After creation the local row owns the role. Ward's grant decides whether a
 * Ward account may get in at all; what it may do inside is the app's.
 */
/** Thrown by `unlink` for a user with no local password: unlinking would lock them out. */
declare class NoLocalPasswordError extends Error {
    readonly code: "no_local_password";
    constructor();
}
/** Thrown by `unlink` (and the reauthentication flow) for a user with no Ward link. */
declare class NotLinkedError extends Error {
    readonly code: "not_linked";
    constructor();
}
interface NewLinkedUserInput {
    /** The Ward subject to link. */
    subject: string;
    username: string;
    role: string;
    /** Omit for a user who signs in with Ward only (until they set a password). */
    password?: string | null;
    /**
     * The local id. **Pass the subject itself when migrating** an app whose own
     * rows are keyed by Ward subjects, so every existing row keeps pointing at
     * the right person. Minted otherwise.
     */
    id?: string;
}
interface WardIdentities {
    readonly accounts: Accounts;
    findUserBySubject(subject: string): Promise<AuthUser | undefined>;
    /** The Ward subject linked to a local user, if any. */
    subjectOf(userId: string): Promise<string | undefined>;
    /**
     * Create a local user already linked to a Ward subject, in one transaction.
     * The migration path and the seed's tool; the sign-in creates its users
     * through `userForSignIn`. Throws `UsernameTakenError`, `UserIdTakenError`,
     * `WardSubjectTakenError`, and the policy errors `createUser` throws.
     */
    createLinkedUser(input: NewLinkedUserInput): Promise<AuthUser>;
    /**
     * The user a verified Ward sign-in is: the linked one, or a new one (rule
     * 3). Never matches by username.
     */
    userForSignIn(identity: WardIdentity, roleFor?: (wardRole: string) => string): Promise<{
        user: AuthUser;
        created: boolean;
    }>;
    /**
     * Link a Ward subject to an existing user. Only ever called for the user
     * who is signed in and started the link from their own settings. Linking
     * the same pair twice is a no-op. Throws `AlreadyLinkedError` (the user has
     * another Ward account linked) or `WardSubjectTakenError` (that Ward account
     * belongs to someone else here).
     */
    link(userId: string, subject: string): Promise<void>;
    /**
     * Remove the user's link and end every Ward-originated session they hold.
     * Refused (`NoLocalPasswordError`) while the user has no local password;
     * `NotLinkedError` when there is nothing to unlink.
     */
    unlink(userId: string): Promise<{
        endedSessions: number;
    }>;
    /**
     * Mail a user through Ward. Only linked users have an address Ward knows;
     * an unlinked one gets `{ sent: false, reason: "not_linked" }` without a
     * call. Throws what `WardClient.sendNotification` throws.
     */
    notifyUser(client: WardClient, userId: string, message: {
        mailSubject: string;
        text: string;
    }): Promise<{
        sent: boolean;
        reason?: "not_linked";
    }>;
}
interface WardIdentitiesOptions {
    accounts: Accounts;
    /** Epoch milliseconds. Must match the one `accounts` uses. */
    now?: () => number;
}
declare function createWardIdentities(options: WardIdentitiesOptions): WardIdentities;

/** Thrown at boot for a `WARD_OIDC_CLIENT_KEY` that is not an Ed25519 private JWK. */
declare class InvalidClientKeyError extends Error {
    constructor(detail: string);
}

/**
 * "Sign in with Ward", linking, and the 30-second check, as Fastify routes.
 *
 * Registered by the `wardAuth` plugin when its `ward` option is set; nothing
 * here is used on its own. The routes, under the plugin's `routePrefix`:
 *
 * | route | guard | what |
 * |---|---|---|
 * | `POST /ward/start` | public | sign-in: answers `{ url }` to send the browser to |
 * | `GET /ward/callback` | public | the redirect URI; ends in a `303` to an app page |
 * | `POST /ward/link` | session | link Ward from settings: `{ url }` |
 * | `POST /ward/reauthenticate` | session | Ward asks for the password again (`prompt=login`): `{ url }` |
 * | `POST /ward/unlink` | session | `{ signedOut }`; `409 no_local_password` / `not_linked` |
 * | `POST /ward/set-password` | session | `204`; `403 reauthentication_required` |
 * | `POST /ward/logout` | session | ends the session here: `{ url }` of Ward's end-session, or `null` |
 *
 * ## Why the starts are POSTs that answer a URL
 *
 * A link changes the account, so it must not be reachable by a cross-site
 * `GET`. A `POST` under the plugin's same-origin check is not, and answering
 * the URL (rather than redirecting a `fetch`) lets the hook show an error —
 * `ward_unavailable` — without the person leaving the page.
 *
 * ## The flow cookie
 *
 * `<cookieName>_ward`: `state`, `nonce`, the PKCE verifier, the mode, and for
 * a link the hash of the session that asked. `HttpOnly`, `SameSite=Lax` (it
 * must survive the top-level navigation back from Ward), `Path=` the callback
 * path so no other request carries it, ten minutes, and cleared by the
 * callback whatever the outcome. One flow at a time per browser: starting a
 * second overwrites the first, whose callback then fails as
 * `invalid_callback`.
 *
 * A link callback must arrive with **the same session** that started it.
 * Without that, an attacker could start a link on their own account and get
 * the victim's browser to finish it, linking the victim's Ward account to the
 * attacker's local user.
 *
 * ## Where the callback sends the browser
 *
 * - sign-in: `returnTo` (a same-origin path the start named) or
 *   `afterSignInPath`; on failure `loginPath?ward_error=<code>`;
 * - link: `settingsPath?ward=linked`, or `settingsPath?ward_error=<code>`;
 * - reauthenticate: `settingsPath?ward=reauthenticated`, or the error.
 *
 * Anything unexpected after the code exchange (the store failing, an app's
 * `roleFor` throwing) is logged and lands on the same error page with
 * `ward_error=sign_in_failed`, never a raw `500` on a top-level navigation.
 *
 * The codes are stable and the React hooks expose them; the app writes the
 * words.
 *
 * ## Setting a first local password
 *
 * A user created from Ward has no local password. Setting one needs a
 * **reauthentication** in the last ten minutes, recorded on the session, and
 * nothing else counts: not a Ward sign-in, however recent. `POST /ward/start`
 * is public, and with a live Ward session Ward answers it without asking for
 * anything, so "signed in with Ward a minute ago" proves nothing about who is
 * at the keyboard.
 *
 * A reauthentication is the `reauthenticate` round trip, which asks Ward for
 * `prompt=login`. Ward then makes the person type their password even with a
 * live Ward session. The callback does not take that on trust: the ID token
 * must carry `auth_time` no more than two minutes before its own `iat` (both
 * Ward's clock), or the round trip fails as `invalid_callback`. Only then is
 * the session stamped.
 */
/** The `ward` option of `wardAuth`. */
interface WardSignInOptions {
    /** From `createWardClient(wardClientOptionsFromEnv())`. */
    client: WardClient;
    /**
     * The app's login page, as the browser sees it (e.g. `/myapp/login`). A
     * failed sign-in lands here with `?ward_error=<code>`.
     */
    loginPath: string;
    /**
     * The account settings page, as the browser sees it. Link and
     * reauthentication results land here with `?ward=` or `?ward_error=`.
     */
    settingsPath: string;
    /** Where a successful sign-in lands when the start named no `returnTo`. */
    afterSignInPath: string;
    /**
     * The role a user created by a first Ward sign-in starts with, from the
     * grant's role (`ward_role`). Identity by default. After creation the app's
     * row is the only truth; Ward's role is never written back.
     */
    roleFor?: (wardRole: string) => string;
    /** Defaults to `createWardIdentities({ accounts })`. */
    identities?: WardIdentities;
}
/**
 * A user with no local password may set one this long after a verified Ward
 * reauthentication (`POST /ward/reauthenticate`). A plain Ward sign-in does
 * not count.
 */
declare const FRESH_SIGN_IN_SECONDS: number;

/**
 * The Fastify plugin: the auth routes, and the app-wide guard.
 *
 * ```ts
 * await app.register(wardAuth, {
 *   accounts,                         // createAccounts({ store })
 *   cookieName: "atrium_session",
 *   cookiePath: "/atrium/api",        // the browser-visible API prefix
 *   publicOrigin: "https://example.com",
 *   routePrefix: "/auth",             // Fastify-side; routes are /auth/login …
 *   publicRoutes: ["GET /health"],
 *   // trustedProxies: omitted, so AUTH_TRUSTED_PROXIES from the environment
 *   ward: {                           // optional: "Sign in with Ward"
 *     client: wardClient,             // await createWardClient(...)
 *     loginPath: "/atrium/login",
 *     settingsPath: "/atrium/settings",
 *     afterSignInPath: "/atrium/",
 *   },
 * });
 * // …then every other route. Each one now has `request.auth`.
 * ```
 *
 * ## One guard, registered first, and no route authenticates itself
 *
 * Atrium's rule: an `onRequest` hook on the root instance, so a handler that
 * exists at all has an authenticated caller, and the failure mode of per-route
 * auth — the one route somebody forgot — cannot happen. The plugin escapes
 * Fastify's encapsulation (the same `skip-override` marker `fastify-plugin`
 * sets, without the dependency) so the hook lands on the instance it was
 * registered on. **Register it before any route or plugin of the app's own**:
 * Fastify copies hooks into a child context when the child is created, so a
 * plugin registered earlier would not inherit the guard.
 *
 * Because it escapes encapsulation, a `prefix` passed to `register` is ignored.
 * Use `routePrefix` for where the auth routes live.
 *
 * ## Responses
 *
 * Every error body is `{ error: <code> }`, and the codes are stable — the React
 * hooks expose them and each app writes its own message:
 *
 * | status | `error` | when |
 * |---|---|---|
 * | 400 | `invalid_request` | the body is not the expected shape |
 * | 400 | `invalid_username`, `password_too_short`, `password_too_long` | registration or a new password fails the policy |
 * | 401 | `unauthorized` (+ `reason` when a session check rejected it) | the guard found no live session |
 * | 401 | `invalid_credentials` | wrong username or password, or wrong current password |
 * | 403 | `cross_site` | a browser said the request came from another origin |
 * | 409 | `username_taken` | registration |
 * | 429 | `too_many_attempts` (+ `retryAfterSeconds`, and `Retry-After`) | lockout |
 *
 * The session `reason`s the library itself sets: `ward_unavailable` (Ward
 * could not vouch for a Ward-originated session, or the app has no Ward
 * configured), `ward_misconfigured` (Ward refused this app's credential),
 * `ward_session_ended` (the Ward session it began with ended), and
 * `session_check_failed` (a validator threw). The Ward routes and their codes
 * are in `ward.ts`.
 *
 * ## "Sign in with Ward"
 *
 * The `ward` option turns on the Ward routes under `routePrefix` and the
 * 30-second check, which always runs first among the session checks. Without
 * it a Ward-originated session is refused outright: nothing could check it.
 *
 * ## Nothing sensitive travels in a URL
 *
 * Fastify's default request log line includes the URL, so credentials live in
 * the body on every route and there is no `GET` variant of any of them.
 */
/** What the guard attaches to `request.auth` on an authenticated request. */
interface AuthContext {
    user: AuthUser;
    session: SessionRecord;
}
declare module "fastify" {
    interface FastifyRequest {
        /**
         * The signed-in user and their session. Set by the guard on every route it
         * guards; `null` on an allowlisted route, which has no caller.
         */
        auth: AuthContext | null;
    }
}
/** A session check's answer. */
type SessionVerdict = {
    ok: true;
} | {
    ok: false;
    /** A stable code, sent to the browser as `reason` (brief 21: `ward_unavailable`). */
    reason: string;
    /** Delete the session row and clear the cookie, rather than refusing only this request. */
    endSession?: boolean;
};
/**
 * **The guard's extension hook.** Runs on every request that carries a live
 * session — guarded routes and `GET <routePrefix>/session` alike — after the
 * row is found and before the request proceeds. Brief 21 hooks the 30-second
 * Ward check in here for Ward-originated sessions; a local session should
 * return `{ ok: true }` without doing any I/O.
 *
 * A validator that **throws** is treated as `{ ok: false, reason:
 * "session_check_failed" }`: failing closed is the rule.
 */
type SessionValidator = (resolved: ResolvedSession, request: FastifyRequest) => SessionVerdict | Promise<SessionVerdict>;
interface WardAuthOptions {
    /** From `createAccounts({ store })`. */
    accounts: Accounts;
    /** `<app>_session`. Unique per app, because the estate shares one origin. */
    cookieName: string;
    /**
     * The cookie's `Path`: the app's API prefix **as the browser sees it**,
     * e.g. `/atrium/api`. Every request that needs the session must live under
     * it — WebSocket upgrades and `<img>` sources included.
     */
    cookiePath: string;
    /**
     * The app's public origin, e.g. `https://example.com`. Decides `Secure`
     * (off only for plain HTTP on loopback) and is what a browser's `Origin`
     * header must match on the plugin's `POST` routes.
     */
    publicOrigin: string;
    /** Where the auth routes are mounted, Fastify-side. Default `/auth`. */
    routePrefix?: string;
    /**
     * Turns on `POST <routePrefix>/register`, creating users with this role.
     * Off by default: most apps create their users with the seed helper.
     */
    registration?: {
        role: string;
    };
    /**
     * Routes reachable with no session, as `"METHOD /pattern"` or `"/pattern"`
     * (any method), matched against the **route pattern** Fastify resolved —
     * never the raw URL, so a query string or an encoding cannot reach a handler
     * the pattern would not. `GET` entries also cover `HEAD`. The plugin's own
     * public routes and every `OPTIONS` preflight are added automatically.
     */
    publicRoutes?: readonly string[];
    /** For anything `publicRoutes` cannot say, such as a static-file wildcard. */
    isPublic?: (request: FastifyRequest) => boolean;
    /**
     * Session checks, run in order, after the library's own Ward check. See
     * `SessionValidator`.
     */
    validateSession?: SessionValidator | readonly SessionValidator[];
    /**
     * Turns on "Sign in with Ward", linking and the 30-second check. See
     * `WardSignInOptions` and the adoption guide. Without it, the app has local
     * accounts only and any Ward-originated session is refused.
     */
    ward?: WardSignInOptions;
    /** Shared counter, if the app wants one across plugins. A fresh one otherwise. */
    lockout?: Lockout;
    /**
     * Socket peers, beyond loopback, whose `X-Forwarded-For` the lockout
     * believes: addresses or CIDR ranges, IPv4 or IPv6, e.g. `["172.16.0.0/12"]`.
     *
     * **Absent, the plugin reads `AUTH_TRUSTED_PROXIES`** (comma-separated) from
     * the environment, so a deploy can fix a containerised app without a code
     * change. Present — even `[]` — it is used as given and the environment is
     * not read. Neither set means loopback only.
     *
     * An app in a container needs it: host Caddy reaches the container through
     * Docker's proxy, the peer is a bridge address, and without it every request
     * keys on that one address. A malformed entry, or a `/0`, throws at
     * registration. See `lockoutKeyFor`.
     */
    trustedProxies?: readonly string[];
    /** Epoch milliseconds, for cookie `Max-Age`. Must match the one `accounts` uses. */
    now?: () => number;
}
declare const wardAuth: FastifyPluginAsync<WardAuthOptions>;
/**
 * A `preHandler` that lets through only the given roles. The guard has already
 * established *who*; this says *what*. `403 { error: "forbidden" }` otherwise.
 *
 * ```ts
 * app.delete("/items/:id", { preHandler: requireRole("admin") }, handler);
 * ```
 */
declare function requireRole(...roles: string[]): preHandlerAsyncHookHandler;

export { AlreadyLinkedError, DEFAULT_NOTIFY_TIMEOUT_MS, DEFAULT_WARD_TIMEOUT_MS, FRESH_SIGN_IN_SECONDS, InvalidClientKeyError, InvalidUserIdError, LOCKOUT_MAX_FAILURES, LOCKOUT_WINDOW_SECONDS, MAX_PASSWORD_LENGTH, MAX_USERNAME_LENGTH, MIN_PASSWORD_LENGTH, NoLocalPasswordError, NotLinkedError, PasswordPolicyError, SESSION_ABSOLUTE_SECONDS, SESSION_IDLE_SECONDS, SESSION_RENEW_INTERVAL_SECONDS, SESSION_STATUS_CACHE_SECONDS, SQLITE_MIGRATIONS, SchemaTooNewError, UserIdTakenError, UsernamePolicyError, UsernameTakenError, WardConfigurationError, WardSignInError, WardSubjectTakenError, WardUnavailableError, clearedCookie, createAccounts, createLockout, createSqliteStore, createWardClient, createWardIdentities, foldUsername, generateSessionToken, hashPassword, hashSessionToken, isWardAuthStore, lockoutKeyFor, migrateSqlite, normaliseUsername, parseTrustedProxies, readCookie, requireRole, secureCookiesFor, seedUsers, serializeCookie, spendDummyHash, toAuthUser, verifyPassword, wardAuth, wardClientOptionsFromEnv };
export type { Accounts, AccountsOptions, AuthContext, AuthStore, AuthUser, Awaitable, CookieOptions, Lockout, LockoutDecision, LockoutKeyOptions, LockoutOptions, LockoutSurface, LockoutTarget, Migration, NewLinkedUserInput, NewUserInput, NewUserRecord, ResolvedSession, SeedResult, SeedUser, SessionOrigin, SessionRecord, SessionValidator, SessionVerdict, SqlValue, SqliteAuthStore, SqliteHandle, SqliteStatement, SqliteStoreOptions, StartSessionOptions, SyncStore, TrustedProxies, TrustedProxyRange, UserRecord, WardAuthOptions, WardAuthStore, WardClient, WardClientOptions, WardFlowSecrets, WardIdentities, WardIdentitiesOptions, WardIdentity, WardLinkRecord, WardNotification, WardSessionStatus, WardSignInOptions };
