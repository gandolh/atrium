// ward-auth 0.3.1 — built from https://github.com/gandolh/ward-auth (shared-library/).
// MIT licensed; see LICENSE beside this file. Do not edit a vendored copy: copy a newer build in.
import { randomBytes as randomBytes$1, createHash, scrypt as scrypt$1, timingSafeEqual, webcrypto, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { isIP } from 'node:net';

/**
 * Usernames, user ids and session tokens: the three identifiers the library
 * mints or compares.
 */
/**
 * The longest username accepted, in UTF-16 code units. Ward's own limit, so
 * that every migrated Ward account fits (briefs 22 and 24 carry usernames
 * over).
 */
const MAX_USERNAME_LENGTH = 256;
/**
 * Ward's username rule, unchanged: runs of visible characters joined by single
 * spaces. `foldUsername` collapses case and Unicode *form*, so `Alice` and
 * `ａlice` cannot become two accounts; what it does not collapse is whitespace
 * and invisible characters, and two accounts that render identically in a
 * user list are a way to grant the wrong person access by clicking the wrong
 * row. So control characters and unusual space-likes are refused outright.
 */
const USERNAME_PATTERN = /^[^\p{C}\p{Zs}]+(?: [^\p{C}\p{Zs}]+)*$/u;
/** Thrown for a username that must never reach the database. */
class UsernamePolicyError extends Error {
    code = "invalid_username";
    constructor(message) {
        super(message);
        this.name = "UsernamePolicyError";
    }
}
/**
 * Trim and validate a username for **storage**. Returns the trimmed value.
 *
 * Login does not call this: a name that could never have been stored cannot
 * match a row, and refusing it early would add a branch before the dummy hash.
 */
function normaliseUsername(username) {
    const trimmed = username.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_USERNAME_LENGTH) {
        throw new UsernamePolicyError(`username must be 1 to ${MAX_USERNAME_LENGTH} characters after trimming`);
    }
    if (!USERNAME_PATTERN.test(trimmed)) {
        throw new UsernamePolicyError("username contains a control character or unusual whitespace");
    }
    return trimmed;
}
/**
 * The comparison form of a username, and the column the uniqueness constraint
 * sits on. NFKC then lower-case, exactly as Ward folds.
 */
function foldUsername(username) {
    return username.trim().normalize("NFKC").toLowerCase();
}
/**
 * A new user id: 128 bits from the OS CSPRNG, hex-encoded.
 *
 * **Not a counter and not derived from anything about the account.** A
 * sequential id leaks how many accounts exist and invites guessing; a random
 * one is stable, opaque, and never reused, because nothing in the library
 * deletes a user row.
 */
function generateUserId() {
    return randomBytes$1(16).toString("hex");
}
/**
 * The longest id an app may supply when it migrates rows. Ward subjects are 32
 * hex characters; the slack is for an app whose old ids were something else.
 */
const MAX_USER_ID_LENGTH = 128;
/**
 * Validate an id an app supplied (briefs 22 and 24 reuse each migrated user's
 * Ward subject so existing rows keep their keys). Printable ASCII without
 * spaces, so an id can sit in a URL, a log line or a foreign key without
 * escaping.
 */
function isAcceptableUserId(id) {
    return id.length > 0 && id.length <= MAX_USER_ID_LENGTH && /^[\x21-\x7e]+$/.test(id);
}
/** Session token entropy in bytes. 256 bits, so guessing one is not a strategy. */
const SESSION_TOKEN_BYTES = 32;
/**
 * A new session token: 32 random bytes, base64url. This is the cookie value
 * and it is **never stored**; the row holds `hashSessionToken(token)`.
 */
function generateSessionToken() {
    return randomBytes$1(SESSION_TOKEN_BYTES).toString("base64url");
}
/**
 * The stored form of a session token: SHA-256, hex.
 *
 * Why hash at all: a copy of the database (a backup, a support dump) must not
 * be a set of live cookies. Why a fast hash and not scrypt: the token is 256
 * random bits, so there is nothing to brute-force and the hash is on every
 * authenticated request. The lookup is an index hit on the digest, so there is
 * no comparison whose timing could leak a prefix.
 */
function hashSessionToken(token) {
    return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Password hashing and verification — `node:crypto` scrypt, no dependency.
 *
 * Ported from Ward's `api/src/auth/password.ts` unchanged in behaviour, so a
 * hash written by either verifies in the other.
 *
 * **scrypt rather than argon2id is a recorded decision** (Ward's
 * `corpus/wiki/decisions-implementation.md`, "node:crypto scrypt for passwords,
 * not argon2id"). The short version: argon2id is the better primitive and
 * resists GPU attack more strongly, but it is a native build. This file ships
 * inside a bundle every app copies in, and a native addon cannot be bundled at
 * all — it would put an install step back into a copy whose whole point is
 * having none, and a failed compile on a Node upgrade would take that app's
 * login with it. Do not swap this out without reopening that decision.
 *
 * Two hard rules for anything that edits this file:
 *
 *  1. **Every comparison goes through `timingSafeEqual`.** A `===` on two hex
 *     strings leaks the length of the matching prefix, one byte at a time, to
 *     anyone who can measure the response.
 *  2. **Never short-circuit before the KDF runs.** `verifyPassword` derives a
 *     key even when the stored value is unparseable, and `spendDummyHash`
 *     exists so the *unknown username* path costs the same as the wrong
 *     password path. Skipping the work when the answer is already known is
 *     exactly how a login endpoint becomes an account-enumeration oracle.
 */
const scrypt = promisify(scrypt$1);
/**
 * The scrypt work factors.
 *
 * `N = 2^14` at `r = 8` needs `128 * N * r` = 16 MiB of memory per hash and
 * lands around 40–70 ms on the VPS this runs on. That is the useful shape: slow
 * enough to make offline guessing expensive, fast enough that a login does not
 * hold a connection open long enough to become its own denial of service.
 *
 * `maxmem` is passed explicitly rather than left to default. Node's default is
 * 32 MiB, which `128 * N * r` sits *exactly* at for `N = 2^15` — so raising `N`
 * one notch without touching this line fails at runtime with an opaque OpenSSL
 * error rather than simply being slower. Naming a ceiling with headroom means
 * the next person to turn the dial gets a hash that works.
 *
 * **These parameters are not stored in the hash string.** The stored format is
 * `saltHex:hashHex` and nothing else, as Ward stores it. The consequence is that
 * changing any constant below invalidates every existing hash: a stored value
 * derived at the old cost will simply stop matching, and the only migration
 * available is rehash-on-next-login (verify with the old parameters, then
 * `setPasswordHash` with the new ones). If that day comes, add a version prefix
 * to the format first — the parse below already rejects anything that is not
 * exactly two colon-separated fields, so a versioned value cannot be mistaken
 * for a valid one.
 */
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
/** Derived key length in bytes. */
const KEY_BYTES = 64;
/** Per-password salt length in bytes. 128 bits from the OS CSPRNG. */
const SALT_BYTES = 16;
/**
 * The shortest password the library will hash.
 *
 * Enforced at **hash** time, not at verify time — `verifyPassword` deliberately
 * has no length rule at all. A short submitted password cannot match any stored
 * hash anyway, so checking its length on the login path would only buy a
 * different error message while adding a branch that runs before the KDF.
 */
const MIN_PASSWORD_LENGTH = 8;
/**
 * The longest password the library will accept, in UTF-16 code units.
 *
 * scrypt's cost is dominated by `N` rather than by the input length, so this is
 * not about the KDF: it is about not copying a multi-megabyte request body into
 * a Buffer on an unauthenticated endpoint. 1024 is far past any real password
 * and far short of anything that costs measurable memory.
 */
const MAX_PASSWORD_LENGTH = 1024;
/** Thrown by `hashPassword` for input that must never reach the database. */
class PasswordPolicyError extends Error {
    /** A stable machine-readable code, so a route need not match on the message. */
    code;
    constructor(code, message) {
        super(message);
        this.name = "PasswordPolicyError";
        this.code = code;
    }
}
/**
 * The policy error `hashPassword` would throw for `password`, without paying
 * for a hash. A password-change route checks the *new* password with this
 * before it spends a KDF verifying the current one.
 */
function passwordPolicyError(password) {
    if (password.length < MIN_PASSWORD_LENGTH) {
        return new PasswordPolicyError("password_too_short", `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
        return new PasswordPolicyError("password_too_long", `password must be at most ${MAX_PASSWORD_LENGTH} characters`);
    }
    return undefined;
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
async function hashPassword(password) {
    const policy = passwordPolicyError(password);
    if (policy !== undefined)
        throw policy;
    const salt = randomBytes$1(SALT_BYTES);
    const derived = await derive(password, salt);
    return `${salt.toString("hex")}:${derived.toString("hex")}`;
}
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
async function verifyPassword(password, stored) {
    const parsed = parseStored(stored);
    // A parse failure still gets a salt and an expected digest of the right
    // length, so the work below is identical either way. `parsed !== undefined`
    // is re-tested at the end rather than here so that no early `return` can
    // skip the KDF.
    const salt = parsed?.salt ?? randomBytes$1(SALT_BYTES);
    const expected = parsed?.hash ?? Buffer.alloc(KEY_BYTES);
    const actual = await derive(password, salt);
    // `timingSafeEqual` throws on a length mismatch rather than returning false,
    // so the lengths have to agree before it is called. Comparing lengths is not
    // a leak: the digest length is a constant of this module, not a secret.
    if (actual.length !== expected.length) {
        return false;
    }
    return timingSafeEqual(actual, expected) && parsed !== undefined;
}
/**
 * A stored-format value that no password matches, with a fresh random salt.
 *
 * Exported so a test can assert *structurally* that the unknown-username path
 * spends a hash, rather than relying on a wall-clock measurement.
 */
const DUMMY_STORED_HASH = `${randomBytes$1(SALT_BYTES).toString("hex")}:${"00".repeat(KEY_BYTES)}`;
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
async function spendDummyHash(password) {
    await verifyPassword(password, DUMMY_STORED_HASH);
    return false;
}
async function derive(password, salt) {
    // The password is passed as a string and encoded UTF-8 by the binding.
    // Deliberately NOT Unicode-normalised: normalising would change the hash of
    // every password containing a composed character, and Ward never normalised
    // either, so hashes stay portable between the two. `foldUsername`
    // normalises the *username* because two usernames that look identical is a
    // real problem; two byte-different passwords are not.
    return scrypt(password, salt, KEY_BYTES, {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: SCRYPT_MAXMEM,
    });
}
/**
 * Split `saltHex:hashHex` into buffers, or `undefined` if it is not that.
 *
 * Strict on purpose: exactly two fields, both non-empty valid hex, and the
 * digest exactly `KEY_BYTES` long. `Buffer.from(s, "hex")` silently truncates
 * at the first non-hex character — `"zz"` parses as an empty buffer and
 * `"ab!cd"` as a single byte — so the round-trip length check below is what
 * actually rejects junk. Without it a stored value of `"z:z"` would produce two
 * empty buffers, and an empty-vs-empty `timingSafeEqual` returns **true**:
 * every password would match.
 */
function parseStored(stored) {
    const parts = stored.split(":");
    if (parts.length !== 2)
        return undefined;
    const [saltHex, hashHex] = parts;
    const salt = fromHex(saltHex);
    const hash = fromHex(hashHex);
    if (salt === undefined || hash === undefined)
        return undefined;
    if (salt.length === 0 || hash.length !== KEY_BYTES)
        return undefined;
    return { salt, hash };
}
/** `Buffer.from(value, "hex")`, but `undefined` rather than a silent truncation. */
function fromHex(value) {
    const buffer = Buffer.from(value, "hex");
    return buffer.length * 2 === value.length ? buffer : undefined;
}

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
const SESSION_IDLE_SECONDS = 14 * 24 * 60 * 60;
/** No session outlives this, however active. Ward's refresh-family ceiling. */
const SESSION_ABSOLUTE_SECONDS = 30 * 24 * 60 * 60;
/** The sliding expiry is written at most this often per session. */
const SESSION_RENEW_INTERVAL_SECONDS = 60 * 60;
/** Thrown for an app-supplied user id the library will not store. */
class InvalidUserIdError extends Error {
    code = "invalid_user_id";
    constructor() {
        super("user id must be 1 to 128 printable ASCII characters with no spaces");
        this.name = "InvalidUserIdError";
    }
}
function toAuthUser(user) {
    return {
        id: user.id,
        username: user.username,
        role: user.role,
        hasPassword: user.passwordHash !== null,
    };
}
function createAccounts(options) {
    const { store } = options;
    const now = options.now ?? (() => Date.now());
    async function createUser(input) {
        const username = normaliseUsername(input.username);
        if (input.id !== undefined && !isAcceptableUserId(input.id))
            throw new InvalidUserIdError();
        if (typeof input.role !== "string" || input.role.length === 0) {
            throw new TypeError("createUser: role must be a non-empty string");
        }
        const passwordHash = input.password === undefined || input.password === null
            ? null
            : await hashPassword(input.password);
        const created = await store.createUser({
            id: input.id ?? generateUserId(),
            username,
            usernameFolded: foldUsername(username),
            passwordHash,
            role: input.role,
            createdAt: now(),
        });
        return toAuthUser(created);
    }
    async function verifyCredentials(username, password) {
        const user = await store.findUserByFoldedUsername(foldUsername(username));
        // The unknown-username branch and the no-local-password branch both spend
        // a hash. Without it this answers in under a millisecond for a name that
        // does not exist and in ~50 ms for one that does: an account-enumeration
        // oracle that needs no error message and leaves nothing in a log.
        const ok = user === undefined || user.passwordHash === null
            ? await spendDummyHash(password)
            : await verifyPassword(password, user.passwordHash);
        // `user === undefined` is repeated rather than inferred from `ok`, so a
        // future edit that makes the dummy path succeed cannot type-check its way
        // into a sign-in.
        if (user === undefined || !ok)
            return undefined;
        return toAuthUser(user);
    }
    async function changePassword(userId, currentPassword, newPassword, keepSessionIdHash) {
        const policy = passwordPolicyError(newPassword);
        if (policy !== undefined)
            throw policy;
        const user = await store.findUserById(userId);
        const ok = user === undefined || user.passwordHash === null
            ? await spendDummyHash(currentPassword)
            : await verifyPassword(currentPassword, user.passwordHash);
        if (user === undefined || !ok)
            return false;
        await setPassword(userId, newPassword, keepSessionIdHash);
        return true;
    }
    async function setPassword(userId, newPassword, keepSessionIdHash) {
        const hash = await hashPassword(newPassword);
        await store.setPasswordHash(userId, hash, now());
        await store.deleteUserSessions(userId, keepSessionIdHash);
    }
    async function startSession(userId, sessionOptions = {}) {
        const origin = sessionOptions.origin ?? "local";
        const wardSid = sessionOptions.wardSid ?? null;
        if ((origin === "ward") !== (wardSid !== null)) {
            throw new TypeError("startSession: wardSid is required for a Ward session and only for one");
        }
        const token = generateSessionToken();
        const at = now();
        const session = {
            idHash: hashSessionToken(token),
            userId,
            origin,
            wardSid,
            createdAt: at,
            renewedAt: at,
            expiresAt: at + SESSION_IDLE_SECONDS * 1000,
        };
        await store.createSession(session);
        return { token, session };
    }
    async function resolveSession(token) {
        if (token === undefined || token.length === 0)
            return undefined;
        const idHash = hashSessionToken(token);
        const session = await store.findSession(idHash);
        if (session === undefined)
            return undefined;
        const at = now();
        if (session.expiresAt <= at) {
            await store.deleteSession(idHash);
            return undefined;
        }
        const user = await store.findUserById(session.userId);
        if (user === undefined) {
            await store.deleteSession(idHash);
            return undefined;
        }
        if (at - session.renewedAt < SESSION_RENEW_INTERVAL_SECONDS * 1000) {
            return { user: toAuthUser(user), session, renewed: false };
        }
        const ceiling = session.createdAt + SESSION_ABSOLUTE_SECONDS * 1000;
        const expiresAt = Math.min(at + SESSION_IDLE_SECONDS * 1000, ceiling);
        if (expiresAt <= session.expiresAt) {
            // Already at the absolute ceiling: nothing to push out, nothing to write.
            return { user: toAuthUser(user), session, renewed: false };
        }
        await store.renewSession(idHash, at, expiresAt);
        return {
            user: toAuthUser(user),
            session: { ...session, renewedAt: at, expiresAt },
            renewed: true,
        };
    }
    return {
        store,
        createUser,
        async findUserById(id) {
            const user = await store.findUserById(id);
            return user === undefined ? undefined : toAuthUser(user);
        },
        async findUserByUsername(username) {
            const user = await store.findUserByFoldedUsername(foldUsername(username));
            return user === undefined ? undefined : toAuthUser(user);
        },
        async setRole(userId, role) {
            if (role.length === 0)
                throw new TypeError("setRole: role must be a non-empty string");
            await store.setRole(userId, role, now());
        },
        verifyCredentials,
        changePassword,
        setPassword,
        startSession,
        resolveSession,
        async endSession(token) {
            await store.deleteSession(hashSessionToken(token));
        },
        async endSessionByIdHash(idHash) {
            await store.deleteSession(idHash);
        },
        async deleteExpiredSessions() {
            return store.deleteExpiredSessions(now());
        },
    };
}
/**
 * Create each user that does not exist yet; leave every existing one alone.
 *
 * Idempotent, so an app's seed script can run on every deploy. It never
 * resets a password or a role: a seed that overwrote them would undo whatever
 * the person changed since, every time it ran. The passwords come from the
 * app's environment or a prompt, never from a file in the repo.
 */
async function seedUsers(accounts, users) {
    const result = { created: [], existing: [] };
    for (const user of users) {
        if ((await accounts.findUserByUsername(user.username)) !== undefined) {
            result.existing.push(user.username);
            continue;
        }
        await accounts.createUser(user);
        result.created.push(user.username);
    }
    return result;
}

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
/**
 * An RFC 6265 token for the name, and a value free of separators. Session
 * tokens are base64url, so they always pass; this exists so a future value
 * that does not fails loudly here instead of being truncated by a browser.
 */
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_VALUE_PATTERN = /^[!#-+\--:<-[\]-~]*$/;
/** A `Path` attribute: absolute, and nothing that would end the attribute early. */
const COOKIE_PATH_PATTERN = /^\/[^;\s,]*$/;
/** Whether `name` can be a cookie name. The plugin checks its option at boot. */
function isValidCookieName(name) {
    return COOKIE_NAME_PATTERN.test(name);
}
/** Whether `path` can be a cookie `Path`. The plugin checks its option at boot. */
function isValidCookiePath(path) {
    return COOKIE_PATH_PATTERN.test(path);
}
/**
 * Build one `Set-Cookie` value. `HttpOnly` and `SameSite=Lax` have no
 * parameter, because there is no session cookie that should lack them and an
 * option is an invitation to set it wrong.
 */
function serializeCookie(options) {
    if (!isValidCookieName(options.name)) {
        throw new TypeError(`serializeCookie: unsafe cookie name ${JSON.stringify(options.name)}`);
    }
    if (!COOKIE_VALUE_PATTERN.test(options.value)) {
        // The value is deliberately not in the message: it is a session token, and
        // the message ends up in a log.
        throw new TypeError(`serializeCookie: unsafe cookie value for ${options.name}`);
    }
    if (!isValidCookiePath(options.path)) {
        throw new TypeError(`serializeCookie: unsafe cookie path ${JSON.stringify(options.path)}`);
    }
    const parts = [
        `${options.name}=${options.value}`,
        `Path=${options.path}`,
        "HttpOnly",
        "SameSite=Lax",
    ];
    if (options.secure)
        parts.push("Secure");
    if (options.maxAgeSeconds !== undefined) {
        parts.push(`Max-Age=${Math.max(0, Math.trunc(options.maxAgeSeconds))}`);
    }
    return parts.join("; ");
}
/**
 * The `Set-Cookie` value that destroys the cookie.
 *
 * **`Path` and `Secure` must match what was set**, or the browser treats this
 * as a *different* cookie and keeps the original — the classic "logout does not
 * log out" bug. An empty value, `Max-Age=0` and a 1970 `Expires` for anything
 * that ignores `Max-Age`.
 */
function clearedCookie(name, path, secure) {
    return `${serializeCookie({ name, value: "", path, maxAgeSeconds: 0, secure })}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
/**
 * Read one cookie out of a `Cookie` request header.
 *
 * Returns the **first** occurrence. A duplicate name is a client bug or a
 * shadowing attempt (a cookie of the same name set at a broader path to sit in
 * front of the real one); the browser sends the more specific path first, and
 * taking the first match is the safer of the two readings.
 */
function readCookie(header, name) {
    if (header === undefined)
        return undefined;
    const flat = Array.isArray(header) ? header.join("; ") : header;
    for (const pair of flat.split(";")) {
        const eq = pair.indexOf("=");
        if (eq === -1)
            continue;
        if (pair.slice(0, eq).trim() !== name)
            continue;
        const value = pair.slice(eq + 1).trim();
        // A cleared cookie can still be presented by a client that ignored the
        // expiry. An empty value is absent, not a token.
        return value.length > 0 ? value : undefined;
    }
    return undefined;
}
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
function secureCookiesFor(publicOrigin) {
    let url;
    try {
        url = new URL(publicOrigin);
    }
    catch {
        return true;
    }
    if (url.protocol !== "http:")
        return true;
    const host = url.hostname.toLowerCase();
    const isLoopback = host === "localhost" ||
        host === "127.0.0.1" ||
        host === "[::1]" ||
        host === "::1" ||
        host.startsWith("127.");
    return !isLoopback;
}

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
const LOCKOUT_MAX_FAILURES = 5;
/**
 * How long a counter survives, in seconds, and therefore how long a lockout
 * lasts once it trips. Every failure pushes the expiry out again, so the window
 * slides: nobody gets a free attempt every 15 minutes by timing the boundary.
 */
const LOCKOUT_WINDOW_SECONDS = 15 * 60;
/**
 * Hard ceiling on tracked `(surface, address)` pairs. **An uncapped map is the
 * memory-exhaustion DoS this module defends against.** With the cap, flooding
 * addresses only evicts other addresses' counters, which is weaker than the
 * attack the flooder already has. 10 000 entries is roughly a megabyte.
 */
const LOCKOUT_MAX_ENTRIES = 10_000;
/**
 * How many distinct accounts one address's breakdown names before the rest are
 * lumped into an overflow bucket that `clearFailures` can never name — so a
 * wordlist run keeps counting toward the `429` and is never forgiven.
 */
const LOCKOUT_MAX_ACCOUNTS_PER_ADDRESS = 32;
/** The shortest interval between two "no client address" warnings, in seconds. */
const LOCKOUT_AMBIGUOUS_ADDRESS_WARN_INTERVAL_SECONDS = 5 * 60;
/** Reserved breakdown key past `LOCKOUT_MAX_ACCOUNTS_PER_ADDRESS`. */
const OVERFLOW_ACCOUNT_KEY = "+";
/**
 * The bucket key. NUL cannot appear in a surface or an address, so no address
 * can be crafted to land in another surface's bucket.
 */
function bucketKey(target) {
    return `${target.surface}\u0000${target.address}`;
}
/**
 * The breakdown key. Named accounts are prefixed so a username — arbitrary
 * user input — can never collide with the reserved `"*"` (no account named)
 * and `"+"` (overflow) buckets.
 */
function accountKey(target) {
    return target.account === undefined ? "*" : `a:${target.account}`;
}
function createLockout(options = {}) {
    // Wrapped rather than captured, so a test's fake clock is seen.
    const now = options.now ?? (() => Date.now());
    /**
     * Insertion-ordered, which makes eviction an O(1) `next()` on the iterator
     * rather than a scan for the oldest key.
     */
    const entries = new Map();
    function check(target) {
        const at = now();
        const key = bucketKey(target);
        const entry = entries.get(key);
        if (entry === undefined)
            return { allowed: true };
        if (entry.expiresAt <= at) {
            entries.delete(key);
            return { allowed: true };
        }
        if (entry.failures < LOCKOUT_MAX_FAILURES)
            return { allowed: true };
        // `Math.max(1, ...)` because `Retry-After: 0` reads as "retry immediately",
        // and a sub-second remainder floors to zero.
        const retryAfterSeconds = Math.max(1, Math.ceil((entry.expiresAt - at) / 1000));
        return { allowed: false, retryAfterSeconds };
    }
    function recordFailure(target) {
        const at = now();
        const key = bucketKey(target);
        const existing = entries.get(key);
        if (existing !== undefined && existing.expiresAt > at) {
            attribute(existing, accountKey(target));
            existing.failures += 1;
            existing.expiresAt = at + LOCKOUT_WINDOW_SECONDS * 1000;
            // Re-inserted, not merely mutated. A `Map` keeps an existing key's
            // original position and `makeRoom` evicts from the front, so without
            // this the address failing *longest* would be the first counter a flood
            // drops. Delete-then-set makes eviction order least recently failed.
            entries.delete(key);
            entries.set(key, existing);
            return;
        }
        entries.delete(key);
        makeRoom(at);
        entries.set(key, {
            failures: 1,
            expiresAt: at + LOCKOUT_WINDOW_SECONDS * 1000,
            byAccount: new Map([[accountKey(target), 1]]),
        });
    }
    function clearFailures(target) {
        const at = now();
        const key = bucketKey(target);
        const entry = entries.get(key);
        if (entry === undefined)
            return;
        if (entry.expiresAt <= at) {
            entries.delete(key);
            return;
        }
        const account = accountKey(target);
        const attributable = entry.byAccount.get(account) ?? 0;
        entry.byAccount.delete(account);
        entry.failures -= attributable;
        // Zero means the breakdown is empty; drop it rather than leave a live
        // zero-count entry occupying a slot under the cap.
        if (entry.failures <= 0)
            entries.delete(key);
    }
    /** Evict until there is space for one more entry: expired first, then oldest. */
    function makeRoom(at) {
        if (entries.size < LOCKOUT_MAX_ENTRIES)
            return;
        for (const [key, entry] of entries) {
            if (entry.expiresAt <= at)
                entries.delete(key);
        }
        while (entries.size >= LOCKOUT_MAX_ENTRIES) {
            const oldest = entries.keys().next();
            if (oldest.done === true)
                break;
            entries.delete(oldest.value);
        }
    }
    return { check, recordFailure, clearFailures, size: () => entries.size };
}
function attribute(entry, account) {
    const existing = entry.byAccount.get(account);
    if (existing !== undefined) {
        entry.byAccount.set(account, existing + 1);
        return;
    }
    if (entry.byAccount.size >= LOCKOUT_MAX_ACCOUNTS_PER_ADDRESS) {
        // Past the cap the attribution is lost but the count is not.
        entry.byAccount.set(OVERFLOW_ACCOUNT_KEY, (entry.byAccount.get(OVERFLOW_ACCOUNT_KEY) ?? 0) + 1);
        return;
    }
    entry.byAccount.set(account, 1);
}
/**
 * Epoch milliseconds of the last "no client address" and "ignored
 * X-Forwarded-For" warnings. Process-wide, because the misconfigurations they
 * report are too.
 */
let lastAmbiguousWarnAt = 0;
let lastIgnoredForwardedWarnAt = 0;
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
function lockoutKeyFor(socketAddress, forwardedFor, options = {}) {
    const peer = normaliseAddress(socketAddress);
    const forwarded = lastForwardedAddress(forwardedFor);
    if (peer !== undefined && !isTrustedPeer(peer, options.trustedProxies ?? [])) {
        if (forwarded !== undefined)
            warnIgnoredForwarded(options.warn, peer);
        return peer;
    }
    if (forwarded !== undefined) {
        return forwarded;
    }
    // No usable address at all — a trusted caller with no forwarding header, a
    // Unix socket, or a peer the runtime did not report. One shared bucket is the
    // safe fallback: it throttles rather than letting the attempt through
    // uncounted. Say so, once per interval.
    const bucket = peer ?? "unknown";
    warnAmbiguousAddress(options.warn, peer, bucket);
    return bucket;
}
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
function parseTrustedProxies(entries) {
    const list = typeof entries === "string" ? entries.split(",") : entries;
    const ranges = [];
    for (const raw of list) {
        const source = raw.trim();
        if (source.length === 0)
            continue;
        ranges.push(parseRange(source));
    }
    return ranges;
}
function parseRange(source) {
    const refuse = (why) => {
        throw new TypeError(`trusted proxy ${JSON.stringify(source)} ${why}`);
    };
    const parts = source.toLowerCase().split("/");
    if (parts.length > 2)
        refuse("has more than one '/'");
    const [address = "", prefixText] = parts;
    if (address.includes("%"))
        refuse("carries a zone id, which is not part of an address range");
    let bytes = addressBytes(address) ?? refuse("is not an IPv4 or IPv6 address or CIDR range");
    const width = bytes.length * 8;
    let prefix = width;
    if (prefixText !== undefined) {
        if (!/^\d{1,3}$/.test(prefixText) || Number(prefixText) > width) {
            refuse(`has a prefix outside /0–/${width}`);
        }
        prefix = Number(prefixText);
    }
    // Stored the way peers are compared: an IPv4-mapped entry is an IPv4 range.
    const mapped = mappedIpv4(bytes);
    if (mapped !== undefined) {
        if (prefix < 96)
            refuse("is an IPv4-mapped range shorter than /96");
        bytes = mapped;
        prefix -= 96;
    }
    if (prefix === 0) {
        refuse("trusts every address, which would let any client choose its own lockout bucket");
    }
    const network = maskBytes(bytes, prefix);
    if (network.some((byte, index) => byte !== bytes[index])) {
        refuse(`has bits set past /${prefix}; the network is ${formatBytes(network)}/${prefix}`);
    }
    return { source, bytes, prefix };
}
/** Always trusted, listed or not: a loopback peer on the VPS is the proxy. */
const LOOPBACK = parseTrustedProxies(["127.0.0.0/8", "::1"]);
function isTrustedPeer(peer, trusted) {
    const parsed = addressBytes(peer);
    // A peer that is not an address at all (a runtime oddity) is trusted by
    // nobody; it becomes its own bucket, which is the pre-brief-28 behaviour.
    if (parsed === undefined)
        return false;
    // `normaliseAddress` already unwraps the dotted mapped form Node reports;
    // this catches the hex spelling (`::ffff:ac13:3`) of the same address.
    const bytes = mappedIpv4(parsed) ?? parsed;
    return (LOOPBACK.some((range) => inRange(bytes, range)) ||
        trusted.some((range) => inRange(bytes, range)));
}
function inRange(bytes, range) {
    if (bytes.length !== range.bytes.length)
        return false;
    const masked = maskBytes(bytes, range.prefix);
    return masked.every((byte, index) => byte === range.bytes[index]);
}
function maskBytes(bytes, prefix) {
    return bytes.map((byte, index) => {
        const bits = Math.min(8, Math.max(0, prefix - index * 8));
        return byte & ((0xff << (8 - bits)) & 0xff);
    });
}
/**
 * 4 bytes for an IPv4 address, 16 for IPv6, `undefined` for anything else.
 * `isIP` decides what is an address, so leading zeros, short forms like `1.2.3`
 * and stray characters are refused by the same rules Node's sockets use.
 */
function addressBytes(address) {
    const family = isIP(address);
    if (family === 4)
        return address.split(".").map(Number);
    if (family !== 6 || address.includes("%"))
        return undefined;
    // A dotted IPv4 tail (`::ffff:10.1.2.3`) becomes two hex groups first.
    let text = address;
    const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
    if (tail !== null) {
        const [a, b, c, d] = tail.slice(1).map(Number);
        text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    }
    const [head = "", rest] = text.split("::");
    const headGroups = head === "" ? [] : head.split(":");
    const restGroups = rest === undefined || rest === "" ? [] : rest.split(":");
    const zeros = rest === undefined ? 0 : 8 - headGroups.length - restGroups.length;
    const groups = [...headGroups, ...Array(zeros).fill("0"), ...restGroups];
    return groups.flatMap((group) => {
        const value = parseInt(group, 16);
        return [value >> 8, value & 0xff];
    });
}
/** The IPv4 address inside an IPv4-mapped IPv6 one (`::ffff:a.b.c.d`). */
function mappedIpv4(bytes) {
    if (bytes.length !== 16)
        return undefined;
    const isMapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
    return isMapped ? bytes.slice(12) : undefined;
}
function formatBytes(bytes) {
    if (bytes.length === 4)
        return bytes.join(".");
    const groups = [];
    for (let index = 0; index < bytes.length; index += 2) {
        groups.push((((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0)).toString(16));
    }
    return groups.join(":");
}
function warnAmbiguousAddress(warn, peer, bucket) {
    if (warn === undefined)
        return;
    const now = Date.now();
    if (now - lastAmbiguousWarnAt < LOCKOUT_AMBIGUOUS_ADDRESS_WARN_INTERVAL_SECONDS * 1000) {
        return;
    }
    lastAmbiguousWarnAt = now;
    warn({ peer: peer ?? null, bucket }, "no client address available for the login lockout: the peer is loopback or a trusted " +
        "proxy (or unreported) and no X-Forwarded-For arrived, so every caller now shares one " +
        "failure counter and five failures anywhere will answer 429 to everybody. Check that " +
        "the reverse proxy sets X-Forwarded-For and that nothing proxies in front of it.");
}
function warnIgnoredForwarded(warn, peer) {
    if (warn === undefined)
        return;
    const now = Date.now();
    if (now - lastIgnoredForwardedWarnAt < LOCKOUT_AMBIGUOUS_ADDRESS_WARN_INTERVAL_SECONDS * 1000) {
        return;
    }
    lastIgnoredForwardedWarnAt = now;
    warn({ peer }, "X-Forwarded-For ignored for the login lockout: the peer is not loopback and not in " +
        "AUTH_TRUSTED_PROXIES (wardAuth's trustedProxies), so the lockout keys on the peer " +
        "itself. If the peer is the reverse proxy, every caller now shares one failure counter " +
        "and five failures anywhere will answer 429 to everybody; add the proxy's network to " +
        "AUTH_TRUSTED_PROXIES.");
}
function lastForwardedAddress(forwardedFor) {
    if (forwardedFor === undefined)
        return undefined;
    // Node collapses repeated headers into an array for most headers; joining and
    // re-splitting handles both shapes with one code path.
    const flat = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor;
    const parts = flat
        .split(",")
        .map((part) => normaliseAddress(part))
        .filter((part) => part !== undefined);
    return parts.length > 0 ? parts[parts.length - 1] : undefined;
}
/**
 * Trim, strip an IPv6 zone or an IPv4-mapped prefix, lowercase.
 *
 * `::ffff:127.0.0.1` and `127.0.0.1` are the same address and must not be two
 * counters — otherwise an attacker gets 2× the attempts by picking a stack. The
 * same normalisation is why an IPv4-mapped peer matches an IPv4 trusted range.
 */
function normaliseAddress(address) {
    if (address === undefined || address === null)
        return undefined;
    let value = address.trim().toLowerCase();
    if (value.length === 0)
        return undefined;
    // `[::1]:1234` and `[::1]` — some proxies bracket IPv6 in X-Forwarded-For.
    const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
    if (bracketed?.[1] !== undefined)
        value = bracketed[1];
    // Only the dotted spelling is unwrapped here; slicing the prefix off the hex
    // one (`::ffff:ac13:3`) would leave something that is not an address at all.
    if (/^::ffff:\d+\.\d+\.\d+\.\d+$/.test(value))
        value = value.slice("::ffff:".length);
    // An IPv6 scope id (`fe80::1%eth0`) is not part of the address identity.
    const percent = value.indexOf("%");
    if (percent !== -1)
        value = value.slice(0, percent);
    return value.length > 0 ? value : undefined;
}

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
const SQLITE_MIGRATIONS = [
    {
        version: 1,
        name: "local_accounts",
        sql: `
      CREATE TABLE auth_users (
        -- Opaque and never reused. Minted by the library, or a migrated Ward
        -- subject (briefs 22 and 24) so existing rows keep their keys.
        id              TEXT    PRIMARY KEY NOT NULL,
        username        TEXT    NOT NULL,
        username_folded TEXT    NOT NULL UNIQUE,
        -- NULL for a user created by a first Ward sign-in (brief 21): they
        -- have no local password until they set one.
        password_hash   TEXT,
        role            TEXT    NOT NULL,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );

      CREATE TABLE auth_sessions (
        -- SHA-256 of the cookie value. The token itself is never stored.
        id_hash     TEXT    PRIMARY KEY NOT NULL,
        user_id     TEXT    NOT NULL REFERENCES auth_users (id),
        -- 'ward' sessions are checked against Ward every 30 seconds (brief 21).
        origin      TEXT    NOT NULL DEFAULT 'local' CHECK (origin IN ('local', 'ward')),
        -- Ward's refresh family id for a Ward-originated session, else NULL.
        ward_sid    TEXT,
        created_at  INTEGER NOT NULL,
        renewed_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        CHECK ((origin = 'ward') = (ward_sid IS NOT NULL))
      );

      CREATE INDEX auth_sessions_user_id ON auth_sessions (user_id);
      CREATE INDEX auth_sessions_expires_at ON auth_sessions (expires_at);
      CREATE INDEX auth_sessions_ward_sid ON auth_sessions (ward_sid) WHERE ward_sid IS NOT NULL;
    `,
    },
    {
        version: 2,
        name: "ward_links",
        sql: `
      -- One Ward account per local user and one local user per Ward account.
      -- A row exists only because a person signed in with Ward (creating the
      -- user) or linked Ward from their own settings: never by matching a
      -- username (decisions-oidc.md, "linking never guesses").
      CREATE TABLE auth_ward_links (
        -- Ward's subject, the ID token's "sub". Opaque, stable, never reused.
        subject    TEXT    PRIMARY KEY NOT NULL,
        user_id    TEXT    NOT NULL UNIQUE REFERENCES auth_users (id),
        linked_at  INTEGER NOT NULL
      );

      -- The ID token a Ward-originated session began with, kept only to be
      -- the id_token_hint of "sign out of Ward too". Ward accepts an
      -- expired hint, so it outlives the token's own hour. NULL for a local
      -- session.
      ALTER TABLE auth_sessions ADD COLUMN ward_id_token TEXT;
    `,
    },
    {
        version: 3,
        name: "session_reauthenticated_at",
        sql: `
      -- When this session last came back from a Ward round trip that made
      -- the person type their Ward password (prompt=login, auth_time checked).
      -- Epoch milliseconds on the app's clock. Setting a first local password
      -- requires it to be recent; a plain or silent Ward sign-in never sets
      -- it. NULL until then.
      ALTER TABLE auth_sessions ADD COLUMN reauthenticated_at INTEGER;
    `,
    },
];

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
/** Thrown by `createUser` when the folded username is already held. */
class UsernameTakenError extends Error {
    code = "username_taken";
    constructor() {
        super("username is already taken");
        this.name = "UsernameTakenError";
    }
}
/** Thrown by `createUser` when a supplied id is already held. Ids are never reused. */
class UserIdTakenError extends Error {
    code = "user_id_taken";
    constructor() {
        super("user id is already taken");
        this.name = "UserIdTakenError";
    }
}
/** Thrown when a Ward account is already linked to another local user. */
class WardSubjectTakenError extends Error {
    code = "ward_account_in_use";
    constructor() {
        super("that Ward account is already linked to another user");
        this.name = "WardSubjectTakenError";
    }
}
/** Thrown when the local user already has a Ward account linked. */
class AlreadyLinkedError extends Error {
    code = "already_linked";
    constructor() {
        super("this user already has a Ward account linked");
        this.name = "AlreadyLinkedError";
    }
}
/** Whether a store has the Ward methods (a custom `AuthStore` may not). */
function isWardAuthStore(store) {
    const candidate = store;
    return (typeof candidate.findWardLinkBySubject === "function" &&
        typeof candidate.findWardLinkByUserId === "function" &&
        typeof candidate.createWardLink === "function" &&
        typeof candidate.createUserWithWardLink === "function" &&
        typeof candidate.deleteWardLink === "function" &&
        typeof candidate.deleteUserWardSessions === "function" &&
        typeof candidate.setSessionWardIdToken === "function" &&
        typeof candidate.findSessionWardIdToken === "function" &&
        typeof candidate.setSessionReauthenticatedAt === "function" &&
        typeof candidate.findSessionReauthenticatedAt === "function");
}

/** Raised when the database holds a newer schema than this copy knows. */
class SchemaTooNewError extends Error {
    constructor(found, known) {
        super(`auth_migrations is at version ${found} but this copy of the library only knows up to ` +
            `${known}. An older vendored build was copied over a newer one; copy the newer build back.`);
        this.name = "SchemaTooNewError";
    }
}
/**
 * Run `fn` inside a savepoint: released on success, rolled back on a throw.
 * Nests correctly under an app's own `BEGIN`, which a bare `BEGIN` would not.
 */
function inSavepoint(db, fn) {
    db.exec("SAVEPOINT ward_auth");
    try {
        const result = fn();
        db.exec("RELEASE ward_auth");
        return result;
    }
    catch (error) {
        db.exec("ROLLBACK TO ward_auth");
        db.exec("RELEASE ward_auth");
        throw error;
    }
}
/**
 * Apply every migration newer than what `auth_migrations` records, each in its
 * own savepoint, in order. Idempotent: a second call applies nothing.
 *
 * Returns the versions it applied, for a boot log line.
 */
function migrateSqlite(db, migrations = SQLITE_MIGRATIONS) {
    assertOrdered(migrations);
    db.exec(`CREATE TABLE IF NOT EXISTS auth_migrations (
    version    INTEGER PRIMARY KEY NOT NULL,
    name       TEXT    NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
    const row = db.prepare("SELECT MAX(version) AS version FROM auth_migrations").get();
    const current = Number(row?.version ?? 0);
    const known = migrations.length === 0 ? 0 : migrations[migrations.length - 1].version;
    // An older copy over a newer database would run against tables it does not
    // understand. Refuse at boot rather than fail somewhere stranger later.
    if (current > known)
        throw new SchemaTooNewError(current, known);
    const record = db.prepare("INSERT INTO auth_migrations (version, name, applied_at) VALUES (?, ?, ?)");
    const applied = [];
    for (const migration of migrations) {
        if (migration.version <= current)
            continue;
        inSavepoint(db, () => {
            db.exec(migration.sql);
            record.run(migration.version, migration.name, Date.now());
        });
        applied.push(migration.version);
    }
    return applied;
}
function assertOrdered(migrations) {
    migrations.forEach((migration, index) => {
        if (migration.version !== index + 1) {
            throw new Error(`migration "${migration.name}" has version ${migration.version}; versions must run 1, 2, 3… in order`);
        }
    });
}
function toWardLink(row) {
    return { subject: row.subject, userId: row.user_id, linkedAt: Number(row.linked_at) };
}
function toUser(row) {
    return {
        id: row.id,
        username: row.username,
        usernameFolded: row.username_folded,
        passwordHash: row.password_hash,
        role: row.role,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
    };
}
function toSession(row) {
    return {
        idHash: row.id_hash,
        userId: row.user_id,
        // The CHECK constraint keeps anything else out of the column.
        origin: row.origin,
        wardSid: row.ward_sid,
        createdAt: Number(row.created_at),
        renewedAt: Number(row.renewed_at),
        expiresAt: Number(row.expires_at),
    };
}
/**
 * The SQLite `AuthStore`. Runs pending migrations first, so the tables exist
 * by the time this returns; call it once at boot, after the app's own
 * migrations or before them — the two never touch each other's tables.
 */
function createSqliteStore(db, options = {}) {
    migrateSqlite(db, options.migrations ?? SQLITE_MIGRATIONS);
    // Prepared once. Both drivers keep a prepared statement valid for the life
    // of the connection.
    const s = {
        userById: db.prepare("SELECT * FROM auth_users WHERE id = ?"),
        userByFolded: db.prepare("SELECT * FROM auth_users WHERE username_folded = ?"),
        insertUser: db.prepare(`INSERT INTO auth_users (id, username, username_folded, password_hash, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`),
        setPasswordHash: db.prepare("UPDATE auth_users SET password_hash = ?, updated_at = ? WHERE id = ?"),
        setRole: db.prepare("UPDATE auth_users SET role = ?, updated_at = ? WHERE id = ?"),
        insertSession: db.prepare(`INSERT INTO auth_sessions (id_hash, user_id, origin, ward_sid, created_at, renewed_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`),
        sessionById: db.prepare("SELECT * FROM auth_sessions WHERE id_hash = ?"),
        renewSession: db.prepare("UPDATE auth_sessions SET renewed_at = ?, expires_at = ? WHERE id_hash = ?"),
        deleteSession: db.prepare("DELETE FROM auth_sessions WHERE id_hash = ?"),
        deleteUserSessions: db.prepare("DELETE FROM auth_sessions WHERE user_id = ?"),
        deleteUserSessionsExcept: db.prepare("DELETE FROM auth_sessions WHERE user_id = ? AND id_hash <> ?"),
        deleteExpired: db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?"),
        linkBySubject: db.prepare("SELECT * FROM auth_ward_links WHERE subject = ?"),
        linkByUserId: db.prepare("SELECT * FROM auth_ward_links WHERE user_id = ?"),
        insertLink: db.prepare("INSERT INTO auth_ward_links (subject, user_id, linked_at) VALUES (?, ?, ?)"),
        deleteLink: db.prepare("DELETE FROM auth_ward_links WHERE user_id = ?"),
        deleteUserWardSessions: db.prepare("DELETE FROM auth_sessions WHERE user_id = ? AND origin = 'ward'"),
        setSessionIdToken: db.prepare("UPDATE auth_sessions SET ward_id_token = ? WHERE id_hash = ?"),
        sessionIdToken: db.prepare("SELECT ward_id_token FROM auth_sessions WHERE id_hash = ?"),
        setReauthenticatedAt: db.prepare("UPDATE auth_sessions SET reauthenticated_at = ? WHERE id_hash = ?"),
        reauthenticatedAt: db.prepare("SELECT reauthenticated_at FROM auth_sessions WHERE id_hash = ?"),
    };
    function insertUser(user) {
        // Checked inside the caller's savepoint rather than by catching the
        // constraint error: the two drivers report a UNIQUE violation with
        // different error shapes, and an explicit check gives one typed error on
        // both.
        if (s.userById.get(user.id) !== undefined)
            throw new UserIdTakenError();
        if (s.userByFolded.get(user.usernameFolded) !== undefined)
            throw new UsernameTakenError();
        s.insertUser.run(user.id, user.username, user.usernameFolded, user.passwordHash, user.role, user.createdAt, user.createdAt);
        return toUser(s.userById.get(user.id));
    }
    function insertLink(link) {
        if (s.linkBySubject.get(link.subject) !== undefined)
            throw new WardSubjectTakenError();
        if (s.linkByUserId.get(link.userId) !== undefined)
            throw new AlreadyLinkedError();
        s.insertLink.run(link.subject, link.userId, link.linkedAt);
    }
    return {
        createUser(user) {
            return inSavepoint(db, () => insertUser(user));
        },
        findUserById(id) {
            const row = s.userById.get(id);
            return row === undefined ? undefined : toUser(row);
        },
        findUserByFoldedUsername(usernameFolded) {
            const row = s.userByFolded.get(usernameFolded);
            return row === undefined ? undefined : toUser(row);
        },
        setPasswordHash(userId, passwordHash, now) {
            s.setPasswordHash.run(passwordHash, now, userId);
        },
        setRole(userId, role, now) {
            s.setRole.run(role, now, userId);
        },
        createSession(session) {
            s.insertSession.run(session.idHash, session.userId, session.origin, session.wardSid, session.createdAt, session.renewedAt, session.expiresAt);
        },
        findSession(idHash) {
            const row = s.sessionById.get(idHash);
            return row === undefined ? undefined : toSession(row);
        },
        renewSession(idHash, renewedAt, expiresAt) {
            s.renewSession.run(renewedAt, expiresAt, idHash);
        },
        deleteSession(idHash) {
            s.deleteSession.run(idHash);
        },
        deleteUserSessions(userId, exceptIdHash) {
            const result = exceptIdHash === undefined
                ? s.deleteUserSessions.run(userId)
                : s.deleteUserSessionsExcept.run(userId, exceptIdHash);
            return Number(result.changes);
        },
        deleteExpiredSessions(now) {
            return Number(s.deleteExpired.run(now).changes);
        },
        findWardLinkBySubject(subject) {
            const row = s.linkBySubject.get(subject);
            return row === undefined ? undefined : toWardLink(row);
        },
        findWardLinkByUserId(userId) {
            const row = s.linkByUserId.get(userId);
            return row === undefined ? undefined : toWardLink(row);
        },
        createWardLink(link) {
            inSavepoint(db, () => insertLink(link));
        },
        createUserWithWardLink(user, subject) {
            return inSavepoint(db, () => {
                const created = insertUser(user);
                insertLink({ subject, userId: created.id, linkedAt: user.createdAt });
                return created;
            });
        },
        deleteWardLink(userId) {
            return Number(s.deleteLink.run(userId).changes);
        },
        deleteUserWardSessions(userId) {
            return Number(s.deleteUserWardSessions.run(userId).changes);
        },
        setSessionWardIdToken(idHash, idToken) {
            s.setSessionIdToken.run(idToken, idHash);
        },
        findSessionWardIdToken(idHash) {
            const row = s.sessionIdToken.get(idHash);
            return row?.ward_id_token ?? undefined;
        },
        setSessionReauthenticatedAt(idHash, at) {
            s.setReauthenticatedAt.run(at, idHash);
        },
        findSessionReauthenticatedAt(idHash) {
            const row = s.reauthenticatedAt.get(idHash);
            const at = row?.reauthenticated_at;
            return at === undefined || at === null ? undefined : Number(at);
        },
    };
}

let USER_AGENT$1;
if (typeof navigator === 'undefined' || !navigator.userAgent?.startsWith?.('Mozilla/5.0 ')) {
    const NAME = 'oauth4webapi';
    const VERSION = 'v3.8.8';
    USER_AGENT$1 = `${NAME}/${VERSION}`;
}
function looseInstanceOf(input, expected) {
    if (input == null) {
        return false;
    }
    try {
        return (input instanceof expected ||
            Object.getPrototypeOf(input)[Symbol.toStringTag] === expected.prototype[Symbol.toStringTag]);
    }
    catch {
        return false;
    }
}
const ERR_INVALID_ARG_VALUE$1 = 'ERR_INVALID_ARG_VALUE';
const ERR_INVALID_ARG_TYPE$1 = 'ERR_INVALID_ARG_TYPE';
function CodedTypeError$1(message, code, cause) {
    const err = new TypeError(message, { cause });
    Object.assign(err, { code });
    return err;
}
const allowInsecureRequests$1 = Symbol();
const clockSkew = Symbol();
const clockTolerance = Symbol();
const customFetch$1 = Symbol();
const jweDecrypt = Symbol();
const jwksCache = Symbol();
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function buf(input) {
    if (typeof input === 'string') {
        return encoder.encode(input);
    }
    return decoder.decode(input);
}
let encodeBase64Url;
if (Uint8Array.prototype.toBase64) {
    encodeBase64Url = (input) => {
        if (input instanceof ArrayBuffer) {
            input = new Uint8Array(input);
        }
        return input.toBase64({ alphabet: 'base64url', omitPadding: true });
    };
}
else {
    const CHUNK_SIZE = 0x8000;
    encodeBase64Url = (input) => {
        if (input instanceof ArrayBuffer) {
            input = new Uint8Array(input);
        }
        const arr = [];
        for (let i = 0; i < input.byteLength; i += CHUNK_SIZE) {
            arr.push(String.fromCharCode.apply(null, input.subarray(i, i + CHUNK_SIZE)));
        }
        return btoa(arr.join('')).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    };
}
let decodeBase64Url;
if (Uint8Array.fromBase64) {
    decodeBase64Url = (input) => {
        try {
            return Uint8Array.fromBase64(input, { alphabet: 'base64url' });
        }
        catch (cause) {
            throw CodedTypeError$1('The input to be decoded is not correctly encoded.', ERR_INVALID_ARG_VALUE$1, cause);
        }
    };
}
else {
    decodeBase64Url = (input) => {
        try {
            const binary = atob(input.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, ''));
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            return bytes;
        }
        catch (cause) {
            throw CodedTypeError$1('The input to be decoded is not correctly encoded.', ERR_INVALID_ARG_VALUE$1, cause);
        }
    };
}
function b64u(input) {
    if (typeof input === 'string') {
        return decodeBase64Url(input);
    }
    return encodeBase64Url(input);
}
class UnsupportedOperationError extends Error {
    code;
    constructor(message, options) {
        super(message, options);
        this.name = this.constructor.name;
        this.code = UNSUPPORTED_OPERATION;
        Error.captureStackTrace?.(this, this.constructor);
    }
}
class OperationProcessingError extends Error {
    code;
    constructor(message, options) {
        super(message, options);
        this.name = this.constructor.name;
        if (options?.code) {
            this.code = options?.code;
        }
        Error.captureStackTrace?.(this, this.constructor);
    }
}
function OPE(message, code, cause) {
    return new OperationProcessingError(message, { code, cause });
}
function assertCryptoKey(key, it) {
    if (!(key instanceof CryptoKey)) {
        throw CodedTypeError$1(`${it} must be a CryptoKey`, ERR_INVALID_ARG_TYPE$1);
    }
}
function assertPrivateKey(key, it) {
    assertCryptoKey(key, it);
    if (key.type !== 'private') {
        throw CodedTypeError$1(`${it} must be a private CryptoKey`, ERR_INVALID_ARG_VALUE$1);
    }
}
function isJsonObject(input) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return false;
    }
    return true;
}
function prepareHeaders(input) {
    if (looseInstanceOf(input, Headers)) {
        input = Object.fromEntries(input.entries());
    }
    const headers = new Headers(input ?? {});
    if (USER_AGENT$1 && !headers.has('user-agent')) {
        headers.set('user-agent', USER_AGENT$1);
    }
    if (headers.has('authorization')) {
        throw CodedTypeError$1('"options.headers" must not include the "authorization" header name', ERR_INVALID_ARG_VALUE$1);
    }
    return headers;
}
function signal$1(url, value) {
    if (value !== undefined) {
        if (typeof value === 'function') {
            value = value(url.href);
        }
        if (!(value instanceof AbortSignal)) {
            throw CodedTypeError$1('"options.signal" must return or be an instance of AbortSignal', ERR_INVALID_ARG_TYPE$1);
        }
        return value;
    }
    return undefined;
}
function replaceDoubleSlash(pathname) {
    if (pathname.includes('//')) {
        return pathname.replace('//', '/');
    }
    return pathname;
}
function prependWellKnown(url, wellKnown, allowTerminatingSlash = false) {
    if (url.pathname === '/') {
        url.pathname = wellKnown;
    }
    else {
        url.pathname = replaceDoubleSlash(`${wellKnown}/${allowTerminatingSlash ? url.pathname : url.pathname.replace(/(\/)$/, '')}`);
    }
    return url;
}
function appendWellKnown(url, wellKnown) {
    url.pathname = replaceDoubleSlash(`${url.pathname}/${wellKnown}`);
    return url;
}
async function performDiscovery$1(input, urlName, transform, options) {
    if (!(input instanceof URL)) {
        throw CodedTypeError$1(`"${urlName}" must be an instance of URL`, ERR_INVALID_ARG_TYPE$1);
    }
    checkProtocol(input, options?.[allowInsecureRequests$1] !== true);
    const url = transform(new URL(input.href));
    const headers = prepareHeaders(options?.headers);
    headers.set('accept', 'application/json');
    return (options?.[customFetch$1] || fetch)(url.href, {
        body: undefined,
        headers: Object.fromEntries(headers.entries()),
        method: 'GET',
        redirect: 'manual',
        signal: signal$1(url, options?.signal),
    });
}
async function discoveryRequest(issuerIdentifier, options) {
    return performDiscovery$1(issuerIdentifier, 'issuerIdentifier', (url) => {
        switch (options?.algorithm) {
            case undefined:
            case 'oidc':
                appendWellKnown(url, '.well-known/openid-configuration');
                break;
            case 'oauth2':
                prependWellKnown(url, '.well-known/oauth-authorization-server');
                break;
            default:
                throw CodedTypeError$1('"options.algorithm" must be "oidc" (default), or "oauth2"', ERR_INVALID_ARG_VALUE$1);
        }
        return url;
    }, options);
}
function assertNumber(input, allow0, it, code, cause) {
    try {
        if (typeof input !== 'number' || !Number.isFinite(input)) {
            throw CodedTypeError$1(`${it} must be a number`, ERR_INVALID_ARG_TYPE$1, cause);
        }
        if (input > 0)
            return;
        if (allow0) {
            if (input !== 0) {
                throw CodedTypeError$1(`${it} must be a non-negative number`, ERR_INVALID_ARG_VALUE$1, cause);
            }
            return;
        }
        throw CodedTypeError$1(`${it} must be a positive number`, ERR_INVALID_ARG_VALUE$1, cause);
    }
    catch (err) {
        if (code) {
            throw OPE(err.message, code, cause);
        }
        throw err;
    }
}
function assertString$1(input, it, code, cause) {
    try {
        if (typeof input !== 'string') {
            throw CodedTypeError$1(`${it} must be a string`, ERR_INVALID_ARG_TYPE$1, cause);
        }
        if (input.length === 0) {
            throw CodedTypeError$1(`${it} must not be empty`, ERR_INVALID_ARG_VALUE$1, cause);
        }
    }
    catch (err) {
        if (code) {
            throw OPE(err.message, code, cause);
        }
        throw err;
    }
}
async function processDiscoveryResponse(expectedIssuerIdentifier, response) {
    const expected = expectedIssuerIdentifier;
    if (!(expected instanceof URL) && expected !== _nodiscoverycheck) {
        throw CodedTypeError$1('"expectedIssuerIdentifier" must be an instance of URL', ERR_INVALID_ARG_TYPE$1);
    }
    if (!looseInstanceOf(response, Response)) {
        throw CodedTypeError$1('"response" must be an instance of Response', ERR_INVALID_ARG_TYPE$1);
    }
    if (response.status !== 200) {
        throw OPE('"response" is not a conform Authorization Server Metadata response (unexpected HTTP status code)', RESPONSE_IS_NOT_CONFORM, response);
    }
    assertReadableResponse(response);
    const json = await getResponseJsonBody(response);
    assertString$1(json.issuer, '"response" body "issuer" property', INVALID_RESPONSE, { body: json });
    if (expected !== _nodiscoverycheck && new URL(json.issuer).href !== expected.href) {
        throw OPE('"response" body "issuer" property does not match the expected value', JSON_ATTRIBUTE_COMPARISON, { expected: expected.href, body: json, attribute: 'issuer' });
    }
    return json;
}
function assertApplicationJson(response) {
    assertContentType(response, 'application/json');
}
function notJson(response, ...types) {
    let msg = '"response" content-type must be ';
    if (types.length > 2) {
        const last = types.pop();
        msg += `${types.join(', ')}, or ${last}`;
    }
    else if (types.length === 2) {
        msg += `${types[0]} or ${types[1]}`;
    }
    else {
        msg += types[0];
    }
    return OPE(msg, RESPONSE_IS_NOT_JSON, response);
}
function assertContentTypes(response, ...types) {
    if (!types.includes(getContentType(response))) {
        throw notJson(response, ...types);
    }
}
function assertContentType(response, contentType) {
    if (getContentType(response) !== contentType) {
        throw notJson(response, contentType);
    }
}
function randomBytes() {
    return b64u(crypto.getRandomValues(new Uint8Array(32)));
}
function generateRandomCodeVerifier() {
    return randomBytes();
}
function generateRandomState() {
    return randomBytes();
}
function generateRandomNonce() {
    return randomBytes();
}
async function calculatePKCECodeChallenge$1(codeVerifier) {
    assertString$1(codeVerifier, 'codeVerifier');
    return b64u(await crypto.subtle.digest('SHA-256', buf(codeVerifier)));
}
function getKeyAndKid(input) {
    if (input instanceof CryptoKey) {
        return { key: input };
    }
    if (!(input?.key instanceof CryptoKey)) {
        return {};
    }
    if (input.kid !== undefined) {
        assertString$1(input.kid, '"kid"');
    }
    return {
        key: input.key,
        kid: input.kid,
    };
}
function psAlg(key) {
    switch (key.algorithm.hash.name) {
        case 'SHA-256':
            return 'PS256';
        case 'SHA-384':
            return 'PS384';
        case 'SHA-512':
            return 'PS512';
        default:
            throw new UnsupportedOperationError('unsupported RsaHashedKeyAlgorithm hash name', {
                cause: key,
            });
    }
}
function rsAlg(key) {
    switch (key.algorithm.hash.name) {
        case 'SHA-256':
            return 'RS256';
        case 'SHA-384':
            return 'RS384';
        case 'SHA-512':
            return 'RS512';
        default:
            throw new UnsupportedOperationError('unsupported RsaHashedKeyAlgorithm hash name', {
                cause: key,
            });
    }
}
function esAlg(key) {
    switch (key.algorithm.namedCurve) {
        case 'P-256':
            return 'ES256';
        case 'P-384':
            return 'ES384';
        case 'P-521':
            return 'ES512';
        default:
            throw new UnsupportedOperationError('unsupported EcKeyAlgorithm namedCurve', { cause: key });
    }
}
function keyToJws(key) {
    switch (key.algorithm.name) {
        case 'RSA-PSS':
            return psAlg(key);
        case 'RSASSA-PKCS1-v1_5':
            return rsAlg(key);
        case 'ECDSA':
            return esAlg(key);
        case 'Ed25519':
        case 'ML-DSA-44':
        case 'ML-DSA-65':
        case 'ML-DSA-87':
            return key.algorithm.name;
        case 'EdDSA':
            return 'Ed25519';
        default:
            throw new UnsupportedOperationError('unsupported CryptoKey algorithm name', { cause: key });
    }
}
function getClockSkew(client) {
    const skew = client?.[clockSkew];
    return typeof skew === 'number' && Number.isFinite(skew) ? skew : 0;
}
function getClockTolerance(client) {
    const tolerance = client?.[clockTolerance];
    return typeof tolerance === 'number' && Number.isFinite(tolerance) && Math.sign(tolerance) !== -1
        ? tolerance
        : 30;
}
function epochTime() {
    return Math.floor(Date.now() / 1000);
}
function assertAs(as) {
    if (typeof as !== 'object' || as === null) {
        throw CodedTypeError$1('"as" must be an object', ERR_INVALID_ARG_TYPE$1);
    }
    assertString$1(as.issuer, '"as.issuer"');
}
function assertClient(client) {
    if (typeof client !== 'object' || client === null) {
        throw CodedTypeError$1('"client" must be an object', ERR_INVALID_ARG_TYPE$1);
    }
    assertString$1(client.client_id, '"client.client_id"');
}
function ClientSecretPost$1(clientSecret) {
    assertString$1(clientSecret, '"clientSecret"');
    return (_as, client, body, _headers) => {
        body.set('client_id', client.client_id);
        body.set('client_secret', clientSecret);
    };
}
function clientAssertionPayload(as, client) {
    const now = epochTime() + getClockSkew(client);
    return {
        jti: randomBytes(),
        aud: as.issuer,
        exp: now + 60,
        iat: now,
        nbf: now,
        iss: client.client_id,
        sub: client.client_id,
    };
}
function PrivateKeyJwt$1(clientPrivateKey, options) {
    const { key, kid } = getKeyAndKid(clientPrivateKey);
    assertPrivateKey(key, '"clientPrivateKey.key"');
    return async (as, client, body, _headers) => {
        const header = { alg: keyToJws(key), kid };
        const payload = clientAssertionPayload(as, client);
        body.set('client_id', client.client_id);
        body.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
        body.set('client_assertion', await signJwt(header, payload, key));
    };
}
function None$1() {
    return (_as, client, body, _headers) => {
        body.set('client_id', client.client_id);
    };
}
async function signJwt(header, payload, key) {
    if (!key.usages.includes('sign')) {
        throw CodedTypeError$1('CryptoKey instances used for signing assertions must include "sign" in their "usages"', ERR_INVALID_ARG_VALUE$1);
    }
    const input = `${b64u(buf(JSON.stringify(header)))}.${b64u(buf(JSON.stringify(payload)))}`;
    const signature = b64u(await crypto.subtle.sign(keyToSubtle(key), key, buf(input)));
    return `${input}.${signature}`;
}
const URLParse = URL.parse
    ?
        (url, base) => URL.parse(url, base)
    : (url, base) => {
        try {
            return new URL(url, base);
        }
        catch {
            return null;
        }
    };
function checkProtocol(url, enforceHttps) {
    if (enforceHttps && url.protocol !== 'https:') {
        throw OPE('only requests to HTTPS are allowed', HTTP_REQUEST_FORBIDDEN, url);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw OPE('only HTTP and HTTPS requests are allowed', REQUEST_PROTOCOL_FORBIDDEN, url);
    }
}
function validateEndpoint(value, endpoint, useMtlsAlias, enforceHttps) {
    let url;
    if (typeof value !== 'string' || !(url = URLParse(value))) {
        throw OPE(`authorization server metadata does not contain a valid ${useMtlsAlias ? `"as.mtls_endpoint_aliases.${endpoint}"` : `"as.${endpoint}"`}`, value === undefined ? MISSING_SERVER_METADATA : INVALID_SERVER_METADATA, { attribute: useMtlsAlias ? `mtls_endpoint_aliases.${endpoint}` : endpoint });
    }
    checkProtocol(url, enforceHttps);
    return url;
}
function resolveEndpoint(as, endpoint, useMtlsAlias, enforceHttps) {
    if (useMtlsAlias && as.mtls_endpoint_aliases && endpoint in as.mtls_endpoint_aliases) {
        return validateEndpoint(as.mtls_endpoint_aliases[endpoint], endpoint, useMtlsAlias, enforceHttps);
    }
    return validateEndpoint(as[endpoint], endpoint, useMtlsAlias, enforceHttps);
}
function isDPoPNonceError(err) {
    if (err instanceof WWWAuthenticateChallengeError) {
        return err.cause.some((challenge) => challenge.scheme === 'dpop' && challenge.parameters.error === 'use_dpop_nonce');
    }
    if (err instanceof ResponseBodyError) {
        return err.error === 'use_dpop_nonce';
    }
    return false;
}
class ResponseBodyError extends Error {
    cause;
    code;
    error;
    status;
    error_description;
    response;
    constructor(message, options) {
        super(message, options);
        this.name = this.constructor.name;
        this.code = RESPONSE_BODY_ERROR;
        this.cause = options.cause;
        this.error = options.cause.error;
        this.status = options.response.status;
        this.error_description = options.cause.error_description;
        Object.defineProperty(this, 'response', { enumerable: false, value: options.response });
        Error.captureStackTrace?.(this, this.constructor);
    }
}
class AuthorizationResponseError extends Error {
    cause;
    code;
    error;
    error_description;
    constructor(message, options) {
        super(message, options);
        this.name = this.constructor.name;
        this.code = AUTHORIZATION_RESPONSE_ERROR;
        this.cause = options.cause;
        this.error = options.cause.get('error');
        this.error_description = options.cause.get('error_description') ?? undefined;
        Error.captureStackTrace?.(this, this.constructor);
    }
}
class WWWAuthenticateChallengeError extends Error {
    cause;
    code;
    response;
    status;
    constructor(message, options) {
        super(message, options);
        this.name = this.constructor.name;
        this.code = WWW_AUTHENTICATE_CHALLENGE;
        this.cause = options.cause;
        this.status = options.response.status;
        this.response = options.response;
        Object.defineProperty(this, 'response', { enumerable: false });
        Error.captureStackTrace?.(this, this.constructor);
    }
}
const tokenMatch = "[a-zA-Z0-9!#$%&\\'\\*\\+\\-\\.\\^_`\\|~]+";
const token68Match = '[a-zA-Z0-9\\-\\._\\~\\+\\/]+={0,2}';
const quotedMatch = '"((?:[^"\\\\]|\\\\[\\s\\S])*)"';
const quotedParamMatcher = '(' + tokenMatch + ')\\s*=\\s*' + quotedMatch;
const paramMatcher = '(' + tokenMatch + ')\\s*=\\s*(' + tokenMatch + ')';
const schemeRE = new RegExp('^[,\\s]*(' + tokenMatch + ')');
const quotedParamRE = new RegExp('^[,\\s]*' + quotedParamMatcher + '[,\\s]*(.*)');
const unquotedParamRE = new RegExp('^[,\\s]*' + paramMatcher + '[,\\s]*(.*)');
const token68ParamRE = new RegExp('^(' + token68Match + ')(?:$|[,\\s])(.*)');
function parseWwwAuthenticateChallenges(response) {
    if (!looseInstanceOf(response, Response)) {
        throw CodedTypeError$1('"response" must be an instance of Response', ERR_INVALID_ARG_TYPE$1);
    }
    const header = response.headers.get('www-authenticate');
    if (header === null) {
        return undefined;
    }
    const challenges = [];
    let rest = header;
    while (rest) {
        let match = rest.match(schemeRE);
        const scheme = match?.['1'].toLowerCase();
        if (!scheme) {
            return undefined;
        }
        const afterScheme = rest.substring(match[0].length);
        if (afterScheme && !afterScheme.match(/^[\s,]/)) {
            return undefined;
        }
        const spaceMatch = afterScheme.match(/^\s+(.*)$/);
        const hasParameters = !!spaceMatch;
        rest = spaceMatch ? spaceMatch[1] : undefined;
        const parameters = {};
        let token68;
        if (hasParameters) {
            while (rest) {
                let key;
                let value;
                if ((match = rest.match(quotedParamRE))) {
                    [, key, value, rest] = match;
                    if (value.includes('\\')) {
                        value = value.replace(/\\([\s\S])/g, '$1');
                    }
                    parameters[key.toLowerCase()] = value;
                    continue;
                }
                if ((match = rest.match(unquotedParamRE))) {
                    [, key, value, rest] = match;
                    parameters[key.toLowerCase()] = value;
                    continue;
                }
                if ((match = rest.match(token68ParamRE))) {
                    if (Object.keys(parameters).length) {
                        break;
                    }
                    [, token68, rest] = match;
                    break;
                }
                return undefined;
            }
        }
        else {
            rest = afterScheme || undefined;
        }
        const challenge = { scheme, parameters };
        if (token68) {
            challenge.token68 = token68;
        }
        challenges.push(challenge);
    }
    if (!challenges.length) {
        return undefined;
    }
    return challenges;
}
async function parseOAuthResponseErrorBody(response) {
    if (response.status > 399 && response.status < 500) {
        assertReadableResponse(response);
        assertApplicationJson(response);
        try {
            const json = await response.clone().json();
            if (isJsonObject(json) && typeof json.error === 'string' && json.error.length) {
                return json;
            }
        }
        catch { }
    }
    return undefined;
}
async function checkOAuthBodyError(response, expected, label) {
    if (response.status !== expected) {
        checkAuthenticationChallenges(response);
        let err;
        if ((err = await parseOAuthResponseErrorBody(response))) {
            await response.body?.cancel();
            throw new ResponseBodyError('server responded with an error in the response body', {
                cause: err,
                response,
            });
        }
        throw OPE(`"response" is not a conform ${label} response (unexpected HTTP status code)`, RESPONSE_IS_NOT_CONFORM, response);
    }
}
function assertDPoP(option) {
    if (!branded.has(option)) {
        throw CodedTypeError$1('"options.DPoP" is not a valid DPoPHandle', ERR_INVALID_ARG_VALUE$1);
    }
}
let jwksMap;
let jwksRequests;
let jwksKeys;
function setJwksCache(as, jwks, uat, cache) {
    jwksMap ||= new WeakMap();
    jwksMap.set(as, {
        jwks,
        uat,
        get age() {
            return epochTime() - this.uat;
        },
    });
    if (cache) {
        Object.assign(cache, { jwks: structuredClone(jwks), uat });
    }
}
function isFreshJwksCache(input) {
    if (typeof input !== 'object' || input === null) {
        return false;
    }
    if (!('uat' in input) || typeof input.uat !== 'number' || epochTime() - input.uat >= 300) {
        return false;
    }
    if (!('jwks' in input) ||
        !isJsonObject(input.jwks) ||
        !Array.isArray(input.jwks.keys) ||
        !Array.prototype.every.call(input.jwks.keys, isJsonObject)) {
        return false;
    }
    return true;
}
function clearJwksCache(as, cache) {
    jwksMap?.delete(as);
    delete cache?.jwks;
    delete cache?.uat;
}
async function getPublicSigKeyFromIssuerJwksUri(as, options, header) {
    const { alg, kid } = header;
    checkSupportedJwsAlg(header);
    if (!jwksMap?.has(as) && isFreshJwksCache(options?.[jwksCache])) {
        setJwksCache(as, options?.[jwksCache].jwks, options?.[jwksCache].uat);
    }
    let jwks;
    let age;
    if (jwksMap?.has(as)) {
        ({ jwks, age } = jwksMap.get(as));
        if (age >= 300) {
            clearJwksCache(as, options?.[jwksCache]);
            return getPublicSigKeyFromIssuerJwksUri(as, options, header);
        }
    }
    else {
        const downloaded = await jwksRequest(as, options);
        jwks = downloaded.jwks;
        age = epochTime() - downloaded.uat;
        setJwksCache(as, jwks, downloaded.uat, options?.[jwksCache]);
    }
    let kty;
    switch (alg.slice(0, 2)) {
        case 'RS':
        case 'PS':
            kty = 'RSA';
            break;
        case 'ES':
            kty = 'EC';
            break;
        case 'Ed':
            kty = 'OKP';
            break;
        case 'ML':
            kty = 'AKP';
            break;
        default:
            throw new UnsupportedOperationError('unsupported JWS algorithm', { cause: { alg } });
    }
    const candidates = jwks.keys.filter((jwk) => {
        if (jwk.kty !== kty) {
            return false;
        }
        if (kid !== undefined && kid !== jwk.kid) {
            return false;
        }
        if (jwk.alg !== undefined && alg !== jwk.alg) {
            return false;
        }
        if (jwk.use !== undefined && jwk.use !== 'sig') {
            return false;
        }
        if (jwk.key_ops?.includes('verify') === false) {
            return false;
        }
        switch (true) {
            case alg === 'ES256' && jwk.crv !== 'P-256':
            case alg === 'ES384' && jwk.crv !== 'P-384':
            case alg === 'ES512' && jwk.crv !== 'P-521':
            case alg === 'Ed25519' && jwk.crv !== 'Ed25519':
            case alg === 'EdDSA' && jwk.crv !== 'Ed25519':
                return false;
        }
        return true;
    });
    const { 0: jwk, length } = candidates;
    if (!length) {
        if (age >= 60) {
            clearJwksCache(as, options?.[jwksCache]);
            return getPublicSigKeyFromIssuerJwksUri(as, options, header);
        }
        throw OPE('error when selecting a JWT verification key, no applicable keys found', KEY_SELECTION, { header, candidates, jwks_uri: new URL(as.jwks_uri) });
    }
    if (length !== 1) {
        throw OPE('error when selecting a JWT verification key, multiple applicable keys found, a "kid" JWT Header Parameter is required', KEY_SELECTION, { header, candidates, jwks_uri: new URL(as.jwks_uri) });
    }
    jwksKeys ||= new WeakMap();
    let keys = jwksKeys.get(jwk);
    if (!keys) {
        keys = new Map();
        jwksKeys.set(jwk, keys);
    }
    let key = keys.get(alg);
    if (!key) {
        key = importJwk(alg, jwk).catch((cause) => {
            keys.delete(alg);
            throw cause;
        });
        keys.set(alg, key);
    }
    return key;
}
function getContentType(input) {
    return input.headers.get('content-type')?.split(';')[0];
}
async function authenticatedRequest(as, client, clientAuthentication, url, body, headers, options) {
    await clientAuthentication(as, client, body, headers);
    headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
    return (options?.[customFetch$1] || fetch)(url.href, {
        body,
        headers: Object.fromEntries(headers.entries()),
        method: 'POST',
        redirect: 'manual',
        signal: signal$1(url, options?.signal),
    });
}
async function tokenEndpointRequest(as, client, clientAuthentication, grantType, parameters, options) {
    const url = resolveEndpoint(as, 'token_endpoint', client.use_mtls_endpoint_aliases, options?.[allowInsecureRequests$1] !== true);
    parameters.set('grant_type', grantType);
    const headers = prepareHeaders(options?.headers);
    headers.set('accept', 'application/json');
    if (options?.DPoP !== undefined) {
        assertDPoP(options.DPoP);
        await options.DPoP.addProof(url, headers, 'POST');
    }
    const response = await authenticatedRequest(as, client, clientAuthentication, url, parameters, headers, options);
    options?.DPoP?.cacheNonce(response, url);
    return response;
}
const idTokenClaims = new WeakMap();
const jwtRefs = new WeakMap();
function getValidatedIdTokenClaims(ref) {
    if (!ref.id_token) {
        return undefined;
    }
    const claims = idTokenClaims.get(ref);
    if (!claims) {
        throw CodedTypeError$1('"ref" was already garbage collected or did not resolve from the proper sources', ERR_INVALID_ARG_VALUE$1);
    }
    return claims;
}
async function validateApplicationLevelSignature(as, ref, options) {
    assertAs(as);
    if (!jwtRefs.has(ref)) {
        throw CodedTypeError$1('"ref" does not contain a processed JWT Response to verify the signature of', ERR_INVALID_ARG_VALUE$1);
    }
    const { 0: protectedHeader, 1: payload, 2: encodedSignature } = jwtRefs.get(ref).split('.');
    const header = JSON.parse(buf(b64u(protectedHeader)));
    if (header.alg.startsWith('HS')) {
        throw new UnsupportedOperationError('unsupported JWS algorithm', { cause: { alg: header.alg } });
    }
    let key;
    key = await getPublicSigKeyFromIssuerJwksUri(as, options, header);
    await validateJwsSignature(protectedHeader, payload, key, b64u(encodedSignature));
}
async function processGenericAccessTokenResponse(as, client, response, additionalRequiredIdTokenClaims, decryptFn, recognizedTokenTypes) {
    assertAs(as);
    assertClient(client);
    if (!looseInstanceOf(response, Response)) {
        throw CodedTypeError$1('"response" must be an instance of Response', ERR_INVALID_ARG_TYPE$1);
    }
    await checkOAuthBodyError(response, 200, 'Token Endpoint');
    assertReadableResponse(response);
    const json = await getResponseJsonBody(response);
    assertString$1(json.access_token, '"response" body "access_token" property', INVALID_RESPONSE, {
        body: json,
    });
    assertString$1(json.token_type, '"response" body "token_type" property', INVALID_RESPONSE, {
        body: json,
    });
    json.token_type = json.token_type.toLowerCase();
    if (json.expires_in !== undefined) {
        let expiresIn = typeof json.expires_in !== 'number' ? parseFloat(json.expires_in) : json.expires_in;
        assertNumber(expiresIn, true, '"response" body "expires_in" property', INVALID_RESPONSE, {
            body: json,
        });
        json.expires_in = expiresIn;
    }
    if (json.refresh_token !== undefined) {
        assertString$1(json.refresh_token, '"response" body "refresh_token" property', INVALID_RESPONSE, {
            body: json,
        });
    }
    if (json.scope !== undefined && typeof json.scope !== 'string') {
        throw OPE('"response" body "scope" property must be a string', INVALID_RESPONSE, { body: json });
    }
    if (json.id_token !== undefined) {
        assertString$1(json.id_token, '"response" body "id_token" property', INVALID_RESPONSE, {
            body: json,
        });
        const requiredClaims = [];
        if (client.require_auth_time === true) {
            requiredClaims.push('auth_time');
        }
        if (client.default_max_age !== undefined) {
            assertNumber(client.default_max_age, true, '"client.default_max_age"');
            requiredClaims.push('auth_time');
        }
        if (additionalRequiredIdTokenClaims?.length) {
            requiredClaims.push(...additionalRequiredIdTokenClaims);
        }
        const { claims, jwt } = await validateIdTokenClaims(as, client, json.id_token, requiredClaims, decryptFn);
        validateIdTokenAuthorizedParty(client, claims);
        validateIdTokenAuthTimeClaim(claims);
        jwtRefs.set(response, jwt);
        idTokenClaims.set(json, claims);
    }
    if (recognizedTokenTypes?.[json.token_type] !== undefined) {
        recognizedTokenTypes[json.token_type](response, json);
    }
    else if (json.token_type !== 'dpop' && json.token_type !== 'bearer') {
        throw new UnsupportedOperationError('unsupported `token_type` value', { cause: { body: json } });
    }
    return json;
}
function checkAuthenticationChallenges(response) {
    let challenges;
    if ((challenges = parseWwwAuthenticateChallenges(response))) {
        throw new WWWAuthenticateChallengeError('server responded with a challenge in the WWW-Authenticate HTTP Header', { cause: challenges, response });
    }
}
function validateAudience(expected, result) {
    if (Array.isArray(result.claims.aud)) {
        if (!result.claims.aud.includes(expected)) {
            throw OPE('unexpected JWT "aud" (audience) claim value', JWT_CLAIM_COMPARISON, {
                expected,
                claims: result.claims,
                claim: 'aud',
            });
        }
    }
    else if (result.claims.aud !== expected) {
        throw OPE('unexpected JWT "aud" (audience) claim value', JWT_CLAIM_COMPARISON, {
            expected,
            claims: result.claims,
            claim: 'aud',
        });
    }
    return result;
}
function validateIssuer(as, result) {
    const expected = as[_expectedIssuer]?.(result) ?? as.issuer;
    if (result.claims.iss !== expected) {
        throw OPE('unexpected JWT "iss" (issuer) claim value', JWT_CLAIM_COMPARISON, {
            expected,
            claims: result.claims,
            claim: 'iss',
        });
    }
    return result;
}
const branded = new WeakSet();
function brand(searchParams) {
    branded.add(searchParams);
    return searchParams;
}
const nopkce = Symbol();
async function authorizationCodeGrantRequest(as, client, clientAuthentication, callbackParameters, redirectUri, codeVerifier, options) {
    assertAs(as);
    assertClient(client);
    if (!branded.has(callbackParameters)) {
        throw CodedTypeError$1('"callbackParameters" must be an instance of URLSearchParams obtained from "validateAuthResponse()", or "validateJwtAuthResponse()', ERR_INVALID_ARG_VALUE$1);
    }
    assertString$1(redirectUri, '"redirectUri"');
    const code = getURLSearchParameter(callbackParameters, 'code');
    if (!code) {
        throw OPE('no authorization code in "callbackParameters"', INVALID_RESPONSE);
    }
    const parameters = new URLSearchParams(options?.additionalParameters);
    parameters.set('redirect_uri', redirectUri);
    parameters.set('code', code);
    if (codeVerifier !== nopkce) {
        assertString$1(codeVerifier, '"codeVerifier"');
        parameters.set('code_verifier', codeVerifier);
    }
    return tokenEndpointRequest(as, client, clientAuthentication, 'authorization_code', parameters, options);
}
const jwtClaimNames = {
    aud: 'audience',
    c_hash: 'code hash',
    client_id: 'client id',
    exp: 'expiration time',
    iat: 'issued at',
    iss: 'issuer',
    jti: 'jwt id',
    nonce: 'nonce',
    s_hash: 'state hash',
    sub: 'subject',
    ath: 'access token hash',
    htm: 'http method',
    htu: 'http uri',
    cnf: 'confirmation',
    auth_time: 'authentication time',
};
function validatePresence(required, result) {
    for (const claim of required) {
        if (result.claims[claim] === undefined) {
            throw OPE(`JWT "${claim}" (${jwtClaimNames[claim]}) claim missing`, INVALID_RESPONSE, {
                claims: result.claims,
            });
        }
    }
    return result;
}
function validateStringClaim(claim, result) {
    if (typeof result.claims[claim] !== 'string') {
        throw OPE(`unexpected JWT "${claim}" (${jwtClaimNames[claim]}) claim type`, INVALID_RESPONSE, {
            claims: result.claims,
        });
    }
    return result;
}
function validateIdTokenClaims(as, client, idToken, requiredClaims, decryptFn) {
    return validateJwt(idToken, checkSigningAlgorithm.bind(undefined, client.id_token_signed_response_alg, as.id_token_signing_alg_values_supported, 'RS256'), getClockSkew(client), getClockTolerance(client), decryptFn)
        .then(validatePresence.bind(undefined, ['aud', 'exp', 'iat', 'iss', 'sub', ...requiredClaims]))
        .then(validateIssuer.bind(undefined, as))
        .then(validateAudience.bind(undefined, client.client_id))
        .then(validateStringClaim.bind(undefined, 'sub'));
}
function resolveIdTokenMaxAge(client, maxAge) {
    if (maxAge === skipAuthTimeCheck) {
        return maxAge;
    }
    const fromClient = maxAge === undefined;
    if (fromClient) {
        maxAge = client.default_max_age;
    }
    if (maxAge === undefined) {
        return skipAuthTimeCheck;
    }
    assertNumber(maxAge, true, fromClient ? '"client.default_max_age"' : '"maxAge" argument');
    return maxAge;
}
function validateIdTokenAuthTimeClaim(claims) {
    if (claims.auth_time !== undefined) {
        assertNumber(claims.auth_time, true, 'ID Token "auth_time" (authentication time)', INVALID_RESPONSE, { claims });
    }
}
function validateIdTokenAuthTime(client, claims, maxAge) {
    if (maxAge === skipAuthTimeCheck) {
        return;
    }
    const now = epochTime() + getClockSkew(client);
    const tolerance = getClockTolerance(client);
    if (claims.auth_time + maxAge < now - tolerance) {
        throw OPE('too much time has elapsed since the last End-User authentication', JWT_TIMESTAMP_CHECK, { claims, now, tolerance, claim: 'auth_time' });
    }
}
function validateIdTokenNonce(claims, expectedNonce) {
    const expected = expectedNonce === expectNoNonce ? undefined : expectedNonce;
    if (claims.nonce !== expected) {
        throw OPE('unexpected ID Token "nonce" claim value', JWT_CLAIM_COMPARISON, {
            expected,
            claims,
            claim: 'nonce',
        });
    }
}
function validateIdTokenAuthorizedParty(client, claims) {
    if (Array.isArray(claims.aud) && claims.aud.length !== 1) {
        if (claims.azp === undefined) {
            throw OPE('ID Token "aud" (audience) claim includes additional untrusted audiences', JWT_CLAIM_COMPARISON, { claims, claim: 'aud' });
        }
        if (claims.azp !== client.client_id) {
            throw OPE('unexpected ID Token "azp" (authorized party) claim value', JWT_CLAIM_COMPARISON, {
                expected: client.client_id,
                claims,
                claim: 'azp',
            });
        }
    }
}
const expectNoNonce = Symbol();
const skipAuthTimeCheck = Symbol();
async function processAuthorizationCodeResponse(as, client, response, options) {
    if (typeof options?.expectedNonce === 'string' ||
        typeof options?.maxAge === 'number' ||
        options?.requireIdToken) {
        return processAuthorizationCodeOpenIDResponse(as, client, response, options.expectedNonce, options.maxAge, options[jweDecrypt], options.recognizedTokenTypes);
    }
    return processAuthorizationCodeOAuth2Response(as, client, response, options?.maxAge, options?.[jweDecrypt], options?.recognizedTokenTypes);
}
async function processAuthorizationCodeOpenIDResponse(as, client, response, expectedNonce, maxAge, decryptFn, recognizedTokenTypes) {
    const additionalRequiredClaims = [];
    switch (expectedNonce) {
        case undefined:
            expectedNonce = expectNoNonce;
            break;
        case expectNoNonce:
            break;
        default:
            assertString$1(expectedNonce, '"expectedNonce" argument');
            additionalRequiredClaims.push('nonce');
    }
    maxAge = resolveIdTokenMaxAge(client, maxAge);
    if (maxAge !== skipAuthTimeCheck) {
        additionalRequiredClaims.push('auth_time');
    }
    const result = await processGenericAccessTokenResponse(as, client, response, additionalRequiredClaims, decryptFn, recognizedTokenTypes);
    assertString$1(result.id_token, '"response" body "id_token" property', INVALID_RESPONSE, {
        body: result,
    });
    const claims = getValidatedIdTokenClaims(result);
    validateIdTokenAuthTime(client, claims, maxAge);
    validateIdTokenNonce(claims, expectedNonce);
    return result;
}
async function processAuthorizationCodeOAuth2Response(as, client, response, maxAge, decryptFn, recognizedTokenTypes) {
    const result = await processGenericAccessTokenResponse(as, client, response, undefined, decryptFn, recognizedTokenTypes);
    const claims = getValidatedIdTokenClaims(result);
    if (claims) {
        validateIdTokenAuthTime(client, claims, resolveIdTokenMaxAge(client, maxAge));
        validateIdTokenNonce(claims, expectNoNonce);
    }
    return result;
}
const WWW_AUTHENTICATE_CHALLENGE = 'OAUTH_WWW_AUTHENTICATE_CHALLENGE';
const RESPONSE_BODY_ERROR = 'OAUTH_RESPONSE_BODY_ERROR';
const UNSUPPORTED_OPERATION = 'OAUTH_UNSUPPORTED_OPERATION';
const AUTHORIZATION_RESPONSE_ERROR = 'OAUTH_AUTHORIZATION_RESPONSE_ERROR';
const PARSE_ERROR = 'OAUTH_PARSE_ERROR';
const INVALID_RESPONSE = 'OAUTH_INVALID_RESPONSE';
const RESPONSE_IS_NOT_JSON = 'OAUTH_RESPONSE_IS_NOT_JSON';
const RESPONSE_IS_NOT_CONFORM = 'OAUTH_RESPONSE_IS_NOT_CONFORM';
const HTTP_REQUEST_FORBIDDEN = 'OAUTH_HTTP_REQUEST_FORBIDDEN';
const REQUEST_PROTOCOL_FORBIDDEN = 'OAUTH_REQUEST_PROTOCOL_FORBIDDEN';
const JWT_TIMESTAMP_CHECK = 'OAUTH_JWT_TIMESTAMP_CHECK_FAILED';
const JWT_CLAIM_COMPARISON = 'OAUTH_JWT_CLAIM_COMPARISON_FAILED';
const JSON_ATTRIBUTE_COMPARISON = 'OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED';
const KEY_SELECTION = 'OAUTH_KEY_SELECTION_FAILED';
const MISSING_SERVER_METADATA = 'OAUTH_MISSING_SERVER_METADATA';
const INVALID_SERVER_METADATA = 'OAUTH_INVALID_SERVER_METADATA';
function assertReadableResponse(response) {
    if (response.bodyUsed) {
        throw CodedTypeError$1('"response" body has been used already', ERR_INVALID_ARG_VALUE$1);
    }
}
async function jwksRequest(as, options) {
    assertAs(as);
    const url = resolveEndpoint(as, 'jwks_uri', false, options?.[allowInsecureRequests$1] !== true);
    const headers = prepareHeaders(options?.headers);
    headers.set('accept', 'application/json');
    headers.append('accept', 'application/jwk-set+json');
    const requestHeaders = Object.fromEntries(headers.entries());
    const headersKey = JSON.stringify(requestHeaders);
    const fetcher = options?.[customFetch$1] || fetch;
    const requestSignal = signal$1(url, options?.signal);
    jwksRequests ||= new WeakMap();
    const requests = jwksRequests.get(as) ?? new Set();
    for (const pending of requests) {
        if (pending.url === url.href &&
            pending.headers === headersKey &&
            pending.fetch === fetcher &&
            pending.signal === requestSignal) {
            return pending.promise;
        }
    }
    const pending = {
        url: url.href,
        headers: headersKey,
        fetch: fetcher,
        signal: requestSignal,
        promise: Promise.resolve()
            .then(() => fetcher(url.href, {
            body: undefined,
            headers: requestHeaders,
            method: 'GET',
            redirect: 'manual',
            signal: requestSignal,
        }))
            .then(processJwksResponse)
            .then((jwks) => {
            const uat = epochTime();
            setJwksCache(as, jwks, uat);
            return { jwks, uat };
        })
            .finally(() => {
            requests.delete(pending);
            if (!requests.size) {
                jwksRequests.delete(as);
            }
        }),
    };
    requests.add(pending);
    jwksRequests.set(as, requests);
    return pending.promise;
}
async function processJwksResponse(response) {
    if (!looseInstanceOf(response, Response)) {
        throw CodedTypeError$1('"response" must be an instance of Response', ERR_INVALID_ARG_TYPE$1);
    }
    if (response.status !== 200) {
        throw OPE('"response" is not a conform JSON Web Key Set response (unexpected HTTP status code)', RESPONSE_IS_NOT_CONFORM, response);
    }
    assertReadableResponse(response);
    const json = await getResponseJsonBody(response, (response) => assertContentTypes(response, 'application/json', 'application/jwk-set+json'));
    if (!Array.isArray(json.keys)) {
        throw OPE('"response" body "keys" property must be an array', INVALID_RESPONSE, { body: json });
    }
    if (!Array.prototype.every.call(json.keys, isJsonObject)) {
        throw OPE('"response" body "keys" property members must be JWK formatted objects', INVALID_RESPONSE, { body: json });
    }
    return json;
}
function supported(alg) {
    switch (alg) {
        case 'PS256':
        case 'ES256':
        case 'RS256':
        case 'PS384':
        case 'ES384':
        case 'RS384':
        case 'PS512':
        case 'ES512':
        case 'RS512':
        case 'Ed25519':
        case 'EdDSA':
        case 'ML-DSA-44':
        case 'ML-DSA-65':
        case 'ML-DSA-87':
            return true;
        default:
            return false;
    }
}
function checkSupportedJwsAlg(header) {
    if (!supported(header.alg)) {
        throw new UnsupportedOperationError('unsupported JWS "alg" identifier', {
            cause: { alg: header.alg },
        });
    }
}
function checkRsaKeyAlgorithm(key) {
    const { algorithm } = key;
    if (typeof algorithm.modulusLength !== 'number' || algorithm.modulusLength < 2048) {
        throw new UnsupportedOperationError(`unsupported ${algorithm.name} modulusLength`, {
            cause: key,
        });
    }
}
function ecdsaHashName(key) {
    const { algorithm } = key;
    switch (algorithm.namedCurve) {
        case 'P-256':
            return 'SHA-256';
        case 'P-384':
            return 'SHA-384';
        case 'P-521':
            return 'SHA-512';
        default:
            throw new UnsupportedOperationError('unsupported ECDSA namedCurve', { cause: key });
    }
}
function keyToSubtle(key) {
    switch (key.algorithm.name) {
        case 'ECDSA':
            return {
                name: key.algorithm.name,
                hash: ecdsaHashName(key),
            };
        case 'RSA-PSS': {
            checkRsaKeyAlgorithm(key);
            switch (key.algorithm.hash.name) {
                case 'SHA-256':
                case 'SHA-384':
                case 'SHA-512':
                    return {
                        name: key.algorithm.name,
                        saltLength: parseInt(key.algorithm.hash.name.slice(-3), 10) >> 3,
                    };
                default:
                    throw new UnsupportedOperationError('unsupported RSA-PSS hash name', { cause: key });
            }
        }
        case 'RSASSA-PKCS1-v1_5':
            checkRsaKeyAlgorithm(key);
            return key.algorithm.name;
        case 'ML-DSA-44':
        case 'ML-DSA-65':
        case 'ML-DSA-87':
        case 'Ed25519':
            return key.algorithm.name;
    }
    throw new UnsupportedOperationError('unsupported CryptoKey algorithm name', { cause: key });
}
async function validateJwsSignature(protectedHeader, payload, key, signature) {
    const data = buf(`${protectedHeader}.${payload}`);
    const algorithm = keyToSubtle(key);
    const verified = await crypto.subtle.verify(algorithm, key, signature, data);
    if (!verified) {
        throw OPE('JWT signature verification failed', INVALID_RESPONSE, {
            key,
            data,
            signature,
            algorithm,
        });
    }
}
async function validateJwt(jws, checkAlg, clockSkew, clockTolerance, decryptJwt) {
    let { 0: protectedHeader, 1: payload, length } = jws.split('.');
    if (length === 5) {
        if (decryptJwt !== undefined) {
            jws = await decryptJwt(jws);
            ({ 0: protectedHeader, 1: payload, length } = jws.split('.'));
        }
        else {
            throw new UnsupportedOperationError('JWE decryption is not configured', { cause: jws });
        }
    }
    if (length !== 3) {
        throw OPE('Invalid JWT', INVALID_RESPONSE, jws);
    }
    let header;
    try {
        header = JSON.parse(buf(b64u(protectedHeader)));
    }
    catch (cause) {
        throw OPE('failed to parse JWT Header body as base64url encoded JSON', PARSE_ERROR, cause);
    }
    if (!isJsonObject(header)) {
        throw OPE('JWT Header must be a top level object', INVALID_RESPONSE, jws);
    }
    checkAlg(header);
    if (header.crit !== undefined) {
        throw new UnsupportedOperationError('no JWT "crit" header parameter extensions are supported', {
            cause: { header },
        });
    }
    let claims;
    try {
        claims = JSON.parse(buf(b64u(payload)));
    }
    catch (cause) {
        throw OPE('failed to parse JWT Payload body as base64url encoded JSON', PARSE_ERROR, cause);
    }
    if (!isJsonObject(claims)) {
        throw OPE('JWT Payload must be a top level object', INVALID_RESPONSE, jws);
    }
    const now = epochTime() + clockSkew;
    if (claims.exp !== undefined) {
        if (typeof claims.exp !== 'number') {
            throw OPE('unexpected JWT "exp" (expiration time) claim type', INVALID_RESPONSE, { claims });
        }
        if (claims.exp <= now - clockTolerance) {
            throw OPE('unexpected JWT "exp" (expiration time) claim value, expiration is past current timestamp', JWT_TIMESTAMP_CHECK, { claims, now, tolerance: clockTolerance, claim: 'exp' });
        }
    }
    if (claims.iat !== undefined) {
        if (typeof claims.iat !== 'number') {
            throw OPE('unexpected JWT "iat" (issued at) claim type', INVALID_RESPONSE, { claims });
        }
    }
    if (claims.iss !== undefined) {
        if (typeof claims.iss !== 'string') {
            throw OPE('unexpected JWT "iss" (issuer) claim type', INVALID_RESPONSE, { claims });
        }
    }
    if (claims.nbf !== undefined) {
        if (typeof claims.nbf !== 'number') {
            throw OPE('unexpected JWT "nbf" (not before) claim type', INVALID_RESPONSE, { claims });
        }
        if (claims.nbf > now + clockTolerance) {
            throw OPE('unexpected JWT "nbf" (not before) claim value', JWT_TIMESTAMP_CHECK, {
                claims,
                now,
                tolerance: clockTolerance,
                claim: 'nbf',
            });
        }
    }
    if (claims.aud !== undefined) {
        if (typeof claims.aud !== 'string' && !Array.isArray(claims.aud)) {
            throw OPE('unexpected JWT "aud" (audience) claim type', INVALID_RESPONSE, { claims });
        }
    }
    return { header, claims, jwt: jws };
}
async function consumeStream(request) {
    if (request.bodyUsed) {
        throw CodedTypeError$1('form_post Request instances must contain a readable body', ERR_INVALID_ARG_VALUE$1, { cause: request });
    }
    return request.text();
}
async function formPostResponse(request) {
    if (request.method !== 'POST') {
        throw CodedTypeError$1('form_post responses are expected to use the POST method', ERR_INVALID_ARG_VALUE$1, { cause: request });
    }
    if (getContentType(request) !== 'application/x-www-form-urlencoded') {
        throw CodedTypeError$1('form_post responses are expected to use the application/x-www-form-urlencoded content-type', ERR_INVALID_ARG_VALUE$1, { cause: request });
    }
    return consumeStream(request);
}
function checkSigningAlgorithm(client, issuer, fallback, header) {
    if (client !== undefined) {
        if (typeof client === 'string' ? header.alg !== client : !client.includes(header.alg)) {
            throw OPE('unexpected JWT "alg" header parameter', INVALID_RESPONSE, {
                header,
                expected: client,
                reason: 'client configuration',
            });
        }
        return;
    }
    if (Array.isArray(issuer)) {
        if (!issuer.includes(header.alg)) {
            throw OPE('unexpected JWT "alg" header parameter', INVALID_RESPONSE, {
                header,
                expected: issuer,
                reason: 'authorization server metadata',
            });
        }
        return;
    }
    if (fallback !== undefined) {
        if (typeof fallback === 'string'
            ? header.alg !== fallback
            : typeof fallback === 'function'
                ? !fallback(header.alg)
                : !fallback.includes(header.alg)) {
            throw OPE('unexpected JWT "alg" header parameter', INVALID_RESPONSE, {
                header,
                expected: fallback,
                reason: 'default value',
            });
        }
        return;
    }
    throw OPE('missing client or server configuration to verify used JWT "alg" header parameter', undefined, { client, issuer, fallback });
}
function getURLSearchParameter(parameters, name) {
    const { 0: value, length } = parameters.getAll(name);
    if (length > 1) {
        throw OPE(`"${name}" parameter must be provided only once`, INVALID_RESPONSE);
    }
    return value;
}
const skipStateCheck = Symbol();
const expectNoState = Symbol();
function validateAuthResponse(as, client, parameters, expectedState) {
    assertAs(as);
    assertClient(client);
    if (parameters instanceof URL) {
        parameters = parameters.searchParams;
    }
    if (!(parameters instanceof URLSearchParams)) {
        throw CodedTypeError$1('"parameters" must be an instance of URLSearchParams, or URL', ERR_INVALID_ARG_TYPE$1);
    }
    if (getURLSearchParameter(parameters, 'response')) {
        throw OPE('"parameters" contains a JARM response, use validateJwtAuthResponse() instead of validateAuthResponse()', INVALID_RESPONSE, { parameters });
    }
    const iss = getURLSearchParameter(parameters, 'iss');
    const state = getURLSearchParameter(parameters, 'state');
    if (!iss && as.authorization_response_iss_parameter_supported) {
        throw OPE('response parameter "iss" (issuer) missing', INVALID_RESPONSE, { parameters });
    }
    if (iss && iss !== as.issuer) {
        throw OPE('unexpected "iss" (issuer) response parameter value', INVALID_RESPONSE, {
            expected: as.issuer,
            parameters,
        });
    }
    switch (expectedState) {
        case undefined:
        case expectNoState:
            if (state !== undefined) {
                throw OPE('unexpected "state" response parameter encountered', INVALID_RESPONSE, {
                    expected: undefined,
                    parameters,
                });
            }
            break;
        case skipStateCheck:
            break;
        default:
            assertString$1(expectedState, '"expectedState" argument');
            if (state !== expectedState) {
                throw OPE(state === undefined
                    ? 'response parameter "state" missing'
                    : 'unexpected "state" response parameter value', INVALID_RESPONSE, { expected: expectedState, parameters });
            }
    }
    const error = getURLSearchParameter(parameters, 'error');
    if (error) {
        throw new AuthorizationResponseError('authorization response from the server is an error', {
            cause: parameters,
        });
    }
    const id_token = getURLSearchParameter(parameters, 'id_token');
    const token = getURLSearchParameter(parameters, 'token');
    if (id_token !== undefined || token !== undefined) {
        throw new UnsupportedOperationError('implicit and hybrid flows are not supported');
    }
    return brand(new URLSearchParams(parameters));
}
function algToSubtle(alg) {
    switch (alg) {
        case 'PS256':
        case 'PS384':
        case 'PS512':
            return { name: 'RSA-PSS', hash: `SHA-${alg.slice(-3)}` };
        case 'RS256':
        case 'RS384':
        case 'RS512':
            return { name: 'RSASSA-PKCS1-v1_5', hash: `SHA-${alg.slice(-3)}` };
        case 'ES256':
        case 'ES384':
            return { name: 'ECDSA', namedCurve: `P-${alg.slice(-3)}` };
        case 'ES512':
            return { name: 'ECDSA', namedCurve: 'P-521' };
        case 'EdDSA':
            return 'Ed25519';
        case 'Ed25519':
        case 'ML-DSA-44':
        case 'ML-DSA-65':
        case 'ML-DSA-87':
            return alg;
        default:
            throw new UnsupportedOperationError('unsupported JWS algorithm', { cause: { alg } });
    }
}
async function importJwk(alg, jwk) {
    const { ext, key_ops, use, ...key } = jwk;
    return crypto.subtle.importKey('jwk', key, algToSubtle(alg), true, ['verify']);
}
async function getResponseJsonBody(response, check = assertApplicationJson) {
    let json;
    try {
        json = await response.json();
    }
    catch (cause) {
        check(response);
        throw OPE('failed to parse "response" body as JSON', PARSE_ERROR, cause);
    }
    if (!isJsonObject(json)) {
        throw OPE('"response" body must be a top level object', INVALID_RESPONSE, { body: json });
    }
    return json;
}
const _nodiscoverycheck = Symbol();
const _expectedIssuer = Symbol();

let headers;
let USER_AGENT;
if (typeof navigator === 'undefined' || !navigator.userAgent?.startsWith?.('Mozilla/5.0 ')) {
    const NAME = 'openid-client';
    const VERSION = 'v6.8.8';
    USER_AGENT = `${NAME}/${VERSION}`;
    headers = { 'user-agent': USER_AGENT };
}
const int = (config) => {
    return props.get(config);
};
let props;
function ClientSecretPost(clientSecret) {
    if (clientSecret !== undefined) {
        return ClientSecretPost$1(clientSecret);
    }
    const cache = new WeakMap();
    return (as, client, body, headers) => {
        let auth;
        if (!(auth = cache.get(client))) {
            assertString(client.client_secret, '"metadata.client_secret"');
            auth = ClientSecretPost$1(client.client_secret);
            cache.set(client, auth);
        }
        return auth(as, client, body, headers);
    };
}
function assertString(input, it) {
    if (typeof input !== 'string') {
        throw CodedTypeError(`${it} must be a string`, ERR_INVALID_ARG_TYPE);
    }
    if (input.length === 0) {
        throw CodedTypeError(`${it} must not be empty`, ERR_INVALID_ARG_VALUE);
    }
}
function None() {
    return None$1();
}
function PrivateKeyJwt(clientPrivateKey, options) {
    return PrivateKeyJwt$1(clientPrivateKey);
}
const customFetch = customFetch$1;
const ERR_INVALID_ARG_VALUE = 'ERR_INVALID_ARG_VALUE';
const ERR_INVALID_ARG_TYPE = 'ERR_INVALID_ARG_TYPE';
function CodedTypeError(message, code, cause) {
    const err = new TypeError(message, { cause });
    Object.assign(err, { code });
    return err;
}
function calculatePKCECodeChallenge(codeVerifier) {
    return calculatePKCECodeChallenge$1(codeVerifier);
}
function randomPKCECodeVerifier() {
    return generateRandomCodeVerifier();
}
function randomNonce() {
    return generateRandomNonce();
}
function randomState() {
    return generateRandomState();
}
class ClientError extends Error {
    code;
    constructor(message, options) {
        super(message, options);
        this.name = this.constructor.name;
        this.code = options?.code;
        Error.captureStackTrace?.(this, this.constructor);
    }
}
new TextDecoder();
function e(msg, cause, code) {
    return new ClientError(msg, { cause, code });
}
function errorHandler(err) {
    if (err instanceof TypeError ||
        err instanceof ClientError ||
        err instanceof ResponseBodyError ||
        err instanceof AuthorizationResponseError ||
        err instanceof WWWAuthenticateChallengeError) {
        throw err;
    }
    if (err instanceof OperationProcessingError) {
        switch (err.code) {
            case HTTP_REQUEST_FORBIDDEN:
                throw e('only requests to HTTPS are allowed', err, err.code);
            case REQUEST_PROTOCOL_FORBIDDEN:
                throw e('only requests to HTTP or HTTPS are allowed', err, err.code);
            case RESPONSE_IS_NOT_CONFORM:
                throw e('unexpected HTTP response status code', err.cause, err.code);
            case RESPONSE_IS_NOT_JSON:
                throw e('unexpected response content-type', err.cause, err.code);
            case PARSE_ERROR:
                throw e('parsing error occured', err, err.code);
            case INVALID_RESPONSE:
                throw e('invalid response encountered', err, err.code);
            case JWT_CLAIM_COMPARISON:
                throw e('unexpected JWT claim value encountered', err, err.code);
            case JSON_ATTRIBUTE_COMPARISON:
                throw e('unexpected JSON attribute value encountered', err, err.code);
            case JWT_TIMESTAMP_CHECK:
                throw e('JWT timestamp claim value failed validation', err, err.code);
            default:
                throw e(err.message, err, err.code);
        }
    }
    if (err instanceof UnsupportedOperationError) {
        throw e('unsupported operation', err, err.code);
    }
    if (err instanceof DOMException) {
        switch (err.name) {
            case 'OperationError':
                throw e('runtime operation error', err, UNSUPPORTED_OPERATION);
            case 'NotSupportedError':
                throw e('runtime unsupported operation', err, UNSUPPORTED_OPERATION);
            case 'TimeoutError':
                throw e('operation timed out', err, 'OAUTH_TIMEOUT');
            case 'AbortError':
                throw e('operation aborted', err, 'OAUTH_ABORT');
        }
    }
    throw new ClientError('something went wrong', { cause: err });
}
function handleEntraId(server, as, options) {
    if (server.origin === 'https://login.microsoftonline.com' &&
        (!options?.algorithm || options.algorithm === 'oidc')) {
        as[kEntraId] = true;
        return true;
    }
    return false;
}
function handleB2Clogin(server, options) {
    if (server.hostname.endsWith('.b2clogin.com') &&
        (!options?.algorithm || options.algorithm === 'oidc')) {
        return true;
    }
    return false;
}
async function discovery(server, clientId, metadata, clientAuthentication, options) {
    const as = await performDiscovery(server, options);
    const instance = new Configuration(as, clientId, metadata, clientAuthentication);
    let internals = int(instance);
    if (options?.[customFetch]) {
        internals.fetch = options[customFetch];
    }
    if (options?.timeout !== undefined) {
        internals.timeout = options.timeout;
    }
    if (options?.execute) {
        for (const extension of options.execute) {
            extension(instance);
        }
    }
    return instance;
}
async function performDiscovery(server, options) {
    if (!(server instanceof URL)) {
        throw CodedTypeError('"server" must be an instance of URL', ERR_INVALID_ARG_TYPE);
    }
    const resolve = !server.href.includes('/.well-known/');
    const timeout = options?.timeout ?? 30;
    const signal = AbortSignal.timeout(timeout * 1000);
    const as = await (resolve
        ? discoveryRequest(server, {
            algorithm: options?.algorithm,
            [customFetch$1]: options?.[customFetch],
            [allowInsecureRequests$1]: options?.execute?.includes(allowInsecureRequests),
            signal,
            headers: new Headers(headers),
        })
        : (options?.[customFetch] || fetch)((() => {
            checkProtocol(server, options?.execute?.includes(allowInsecureRequests) ? false : true);
            return server.href;
        })(), {
            headers: Object.fromEntries(new Headers({ accept: 'application/json', ...headers }).entries()),
            body: undefined,
            method: 'GET',
            redirect: 'manual',
            signal,
        }))
        .then((response) => processDiscoveryResponse(_nodiscoverycheck, response))
        .catch(errorHandler);
    if (resolve && new URL(as.issuer).href !== server.href) {
        handleEntraId(server, as, options) ||
            handleB2Clogin(server, options) ||
            (() => {
                throw new ClientError('discovered metadata issuer does not match the expected issuer', {
                    code: JSON_ATTRIBUTE_COMPARISON,
                    cause: {
                        expected: server.href,
                        body: as,
                        attribute: 'issuer',
                    },
                });
            })();
    }
    return as;
}
function getServerHelpers(metadata) {
    return {
        supportsPKCE: {
            __proto__: null,
            value(method = 'S256') {
                return (metadata.code_challenge_methods_supported?.includes(method) === true);
            },
        },
    };
}
function addServerHelpers(metadata) {
    Object.defineProperties(metadata, getServerHelpers(metadata));
}
const kEntraId = Symbol();
class Configuration {
    constructor(server, clientId, metadata, clientAuthentication) {
        if (typeof clientId !== 'string' || !clientId.length) {
            throw CodedTypeError('"clientId" must be a non-empty string', ERR_INVALID_ARG_TYPE);
        }
        if (typeof metadata === 'string') {
            metadata = { client_secret: metadata };
        }
        if (metadata?.client_id !== undefined && clientId !== metadata.client_id) {
            throw CodedTypeError('"clientId" and "metadata.client_id" must be the same', ERR_INVALID_ARG_VALUE);
        }
        const client = {
            ...structuredClone(metadata),
            client_id: clientId,
        };
        client[clockSkew] = metadata?.[clockSkew] ?? 0;
        client[clockTolerance] = metadata?.[clockTolerance] ?? 30;
        let auth;
        if (clientAuthentication) {
            auth = clientAuthentication;
        }
        else {
            if (typeof client.client_secret === 'string' &&
                client.client_secret.length) {
                auth = ClientSecretPost(client.client_secret);
            }
            else {
                auth = None();
            }
        }
        let c = Object.freeze(client);
        const clone = structuredClone(server);
        if (kEntraId in server) {
            clone[_expectedIssuer] = ({ claims: { tid } }) => server.issuer.replace('{tenantid}', tid);
        }
        let as = Object.freeze(clone);
        props ||= new WeakMap();
        props.set(this, {
            __proto__: null,
            as,
            c,
            auth,
            tlsOnly: true,
            timeout: 30,
            jwksCache: {},
        });
    }
    serverMetadata() {
        const metadata = structuredClone(int(this).as);
        addServerHelpers(metadata);
        return metadata;
    }
    clientMetadata() {
        const metadata = structuredClone(int(this).c);
        return metadata;
    }
    get timeout() {
        return int(this).timeout;
    }
    set timeout(value) {
        int(this).timeout = value;
    }
    get [customFetch]() {
        return int(this).fetch;
    }
    set [customFetch](value) {
        int(this).fetch = value;
    }
}
Object.freeze(Configuration.prototype);
function getHelpers(response) {
    let exp = undefined;
    if (response.expires_in !== undefined) {
        exp = Date.now() + response.expires_in * 1000;
    }
    return {
        expiresIn: {
            __proto__: null,
            value() {
                if (exp) {
                    const now = Date.now();
                    if (exp > now) {
                        return Math.floor((exp - now) / 1000);
                    }
                    return 0;
                }
                return undefined;
            },
        },
        claims: {
            __proto__: null,
            value() {
                return getValidatedIdTokenClaims(response);
            },
        },
    };
}
function addHelpers(response) {
    Object.defineProperties(response, getHelpers(response));
}
function allowInsecureRequests(config) {
    int(config).tlsOnly = false;
}
function enableNonRepudiationChecks(config) {
    checkConfig(config);
    int(config).nonRepudiation = (response) => {
        const { as, fetch, tlsOnly, timeout, jwksCache: jwksCache$1 } = int(config);
        return validateApplicationLevelSignature(as, response, {
            [customFetch$1]: fetch,
            [allowInsecureRequests$1]: !tlsOnly,
            headers: new Headers(headers),
            signal: signal(timeout),
            [jwksCache]: jwksCache$1,
        })
            .catch(errorHandler);
    };
}
function stripParams(url) {
    url = new URL(url);
    url.search = '';
    url.hash = '';
    return url.href;
}
function webInstanceOf(input, toStringTag) {
    try {
        return Object.getPrototypeOf(input)[Symbol.toStringTag] === toStringTag;
    }
    catch {
        return false;
    }
}
async function authorizationCodeGrant(config, currentUrl, checks, tokenEndpointParameters, options) {
    checkConfig(config);
    if (options?.flag !== retry &&
        !(currentUrl instanceof URL) &&
        !webInstanceOf(currentUrl, 'Request')) {
        throw CodedTypeError('"currentUrl" must be an instance of URL, or Request', ERR_INVALID_ARG_TYPE);
    }
    let authResponse;
    let redirectUri;
    const { as, c, auth, fetch, tlsOnly, jarm, hybrid, nonRepudiation, timeout, decrypt, implicit } = int(config);
    if (options?.flag === retry) {
        authResponse = options.authResponse;
        redirectUri = options.redirectUri;
    }
    else {
        if (!(currentUrl instanceof URL)) {
            const request = currentUrl;
            currentUrl = new URL(currentUrl.url);
            switch (request.method) {
                case 'GET':
                    break;
                case 'POST':
                    const params = new URLSearchParams(await formPostResponse(request));
                    if (hybrid) {
                        currentUrl.hash = params.toString();
                    }
                    else {
                        for (const [k, v] of params.entries()) {
                            currentUrl.searchParams.append(k, v);
                        }
                    }
                    break;
                default:
                    throw CodedTypeError('unexpected Request HTTP method', ERR_INVALID_ARG_VALUE);
            }
        }
        redirectUri = stripParams(currentUrl);
        switch (true) {
            case !!jarm:
                authResponse = await jarm(currentUrl, checks?.expectedState);
                break;
            case !!hybrid:
                authResponse = await hybrid(currentUrl, checks?.expectedNonce, checks?.expectedState, checks?.maxAge);
                break;
            case !!implicit:
                throw new TypeError('authorizationCodeGrant() cannot be used by response_type=id_token clients');
            default:
                try {
                    authResponse = validateAuthResponse(as, c, currentUrl.searchParams, checks?.expectedState);
                }
                catch (err) {
                    errorHandler(err);
                }
        }
    }
    const response = await authorizationCodeGrantRequest(as, c, auth, authResponse, redirectUri, checks?.pkceCodeVerifier || nopkce, {
        additionalParameters: tokenEndpointParameters,
        [customFetch$1]: fetch,
        [allowInsecureRequests$1]: !tlsOnly,
        DPoP: options?.DPoP,
        headers: new Headers(headers),
        signal: signal(timeout),
    })
        .catch(errorHandler);
    if (typeof checks?.expectedNonce === 'string' ||
        typeof checks?.maxAge === 'number') {
        checks.idTokenExpected = true;
    }
    const p = processAuthorizationCodeResponse(as, c, response, {
        expectedNonce: checks?.expectedNonce,
        maxAge: checks?.maxAge,
        requireIdToken: checks?.idTokenExpected,
        [jweDecrypt]: decrypt,
    });
    let result;
    try {
        result = await p;
    }
    catch (err) {
        if (retryable(err, options)) {
            return authorizationCodeGrant(config, undefined, checks, tokenEndpointParameters, {
                ...options,
                flag: retry,
                authResponse: authResponse,
                redirectUri: redirectUri,
            });
        }
        errorHandler(err);
    }
    result.id_token && (await nonRepudiation?.(response));
    addHelpers(result);
    return result;
}
function buildAuthorizationUrl(config, parameters) {
    checkConfig(config);
    const { as, c, tlsOnly, hybrid, jarm, implicit } = int(config);
    const authorizationEndpoint = resolveEndpoint(as, 'authorization_endpoint', false, tlsOnly);
    parameters = new URLSearchParams(parameters);
    if (!parameters.has('client_id')) {
        parameters.set('client_id', c.client_id);
    }
    if (!parameters.has('request_uri') && !parameters.has('request')) {
        if (!parameters.has('response_type')) {
            parameters.set('response_type', hybrid ? 'code id_token' : implicit ? 'id_token' : 'code');
        }
        if (implicit && !parameters.has('nonce')) {
            throw CodedTypeError('response_type=id_token clients must provide a nonce parameter in their authorization request parameters', ERR_INVALID_ARG_VALUE);
        }
        if (jarm) {
            parameters.set('response_mode', 'jwt');
        }
    }
    for (const [k, v] of parameters.entries()) {
        authorizationEndpoint.searchParams.append(k, v);
    }
    return authorizationEndpoint;
}
function buildEndSessionUrl(config, parameters) {
    checkConfig(config);
    const { as, c, tlsOnly } = int(config);
    const endSessionEndpoint = resolveEndpoint(as, 'end_session_endpoint', false, tlsOnly);
    parameters = new URLSearchParams(parameters);
    if (!parameters.has('client_id')) {
        parameters.set('client_id', c.client_id);
    }
    for (const [k, v] of parameters.entries()) {
        endSessionEndpoint.searchParams.append(k, v);
    }
    return endSessionEndpoint;
}
function checkConfig(input) {
    if (!(input instanceof Configuration)) {
        throw CodedTypeError('"config" must be an instance of Configuration', ERR_INVALID_ARG_TYPE);
    }
    if (Object.getPrototypeOf(input) !== Configuration.prototype) {
        throw CodedTypeError('subclassing Configuration is not allowed', ERR_INVALID_ARG_VALUE);
    }
}
function signal(timeout) {
    return timeout ? AbortSignal.timeout(timeout * 1000) : undefined;
}
function retryable(err, options) {
    if (options?.DPoP && options.flag !== retry) {
        return isDPoPNonceError(err);
    }
    return false;
}
const retry = Symbol();

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
class WardUnavailableError extends Error {
    /** Widened so `WardConfigurationError` can name itself. */
    name = "WardUnavailableError";
    statusCode = 503;
    constructor(message, options) {
        super(message, options);
    }
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
class WardConfigurationError extends WardUnavailableError {
    name = "WardConfigurationError";
    constructor(message, options) {
        super(message, options);
    }
}
/**
 * Why a "Sign in with Ward" round trip did not produce a signed-in user. The
 * `code` is what the callback puts in `?ward_error=` and what the React hooks
 * expose; the app writes the message.
 */
class WardSignInError extends Error {
    code;
    name = "WardSignInError";
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
    }
}

/**
 * The app's client credential at Ward: an Ed25519 private key.
 *
 * Ward authenticates apps with `private_key_jwt` (decisions-oidc-build.md,
 * "Apps authenticate as clients"). The app holds the private half in
 * `WARD_OIDC_CLIENT_KEY` — base64url of the JSON private JWK
 * `{ kty: "OKP", crv: "Ed25519", x, d, kid, use: "sig" }`, exactly what Ward's
 * `npm run oidc-client-key` and the local seed write — and Ward holds only the
 * public half. There is no shared secret anywhere.
 *
 * The same key signs three kinds of request:
 *
 * - the token request of the code exchange, through `openid-client`'s
 *   `PrivateKeyJwt` (which names the algorithm `Ed25519`);
 * - `POST /session-status`, the 30-second check;
 * - `POST /notify`.
 *
 * For the last two this file builds the assertion itself, because they are
 * Ward's own endpoints and not OAuth ones `openid-client` knows. The claims
 * are what Ward's `client-auth.ts` checks: `iss` = `sub` = the client id,
 * `aud` = the issuer, a short `exp`, and a fresh `jti` for every call (Ward
 * spends each `jti` once, sharing the markers with its token endpoint).
 */
/** The `client_assertion_type` for `private_key_jwt`. */
const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
/** How long a hand-built assertion is good for. Ward allows 15 s of clock skew. */
const ASSERTION_LIFETIME_SECONDS = 60;
/** Thrown at boot for a `WARD_OIDC_CLIENT_KEY` that is not an Ed25519 private JWK. */
class InvalidClientKeyError extends Error {
    constructor(detail) {
        // Never echo the value: it is the app's private key.
        super(`WARD_OIDC_CLIENT_KEY is not usable: ${detail}`);
        this.name = "InvalidClientKeyError";
    }
}
/**
 * Parse `WARD_OIDC_CLIENT_KEY` and import the private key.
 *
 * Only the members WebCrypto needs are handed to it (`kty`, `crv`, `x`, `d`):
 * `use` and `kid` are ours, and a stray `alg` or `key_ops` would make the
 * import fail for a reason that has nothing to do with the key.
 */
async function importClientKey(encoded) {
    let jwk;
    try {
        const parsed = JSON.parse(Buffer.from(encoded.trim(), "base64url").toString("utf8"));
        if (typeof parsed !== "object" || parsed === null)
            throw new Error("not an object");
        jwk = parsed;
    }
    catch {
        throw new InvalidClientKeyError("expected base64url of a JSON JWK");
    }
    const { kty, crv, x, d, kid } = jwk;
    if (kty !== "OKP" || crv !== "Ed25519") {
        throw new InvalidClientKeyError('expected an Ed25519 key (kty "OKP", crv "Ed25519")');
    }
    if (typeof x !== "string" || typeof d !== "string") {
        throw new InvalidClientKeyError("expected the private key (x and d); this looks like the public half");
    }
    if (typeof kid !== "string" || kid.length === 0) {
        throw new InvalidClientKeyError("expected a kid, which Ward uses to pick the key");
    }
    let privateKey;
    try {
        privateKey = await webcrypto.subtle.importKey("jwk", { kty, crv, x, d }, { name: "Ed25519" }, false, ["sign"]);
    }
    catch {
        throw new InvalidClientKeyError("the key material does not import as Ed25519");
    }
    return { kid, privateKey };
}
/**
 * A compact JWS client assertion for one call to one of Ward's own endpoints.
 * `nowSeconds` is the real clock: Ward checks `exp` against its own.
 */
async function signClientAssertion(key, clientId, audience, nowSeconds = Math.floor(Date.now() / 1000)) {
    const header = { alg: "EdDSA", kid: key.kid };
    const claims = {
        iss: clientId,
        sub: clientId,
        aud: audience,
        iat: nowSeconds,
        exp: nowSeconds + ASSERTION_LIFETIME_SECONDS,
        jti: randomUUID(),
    };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
    const signature = await webcrypto.subtle.sign({ name: "Ed25519" }, key.privateKey, new TextEncoder().encode(signingInput));
    return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
}
function base64url(text) {
    return Buffer.from(text, "utf8").toString("base64url");
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
const SESSION_STATUS_CACHE_SECONDS = 30;
/** Default timeout for discovery, the code exchange and the session check. */
const DEFAULT_WARD_TIMEOUT_MS = 5_000;
/** Default timeout for `/notify`: Ward answers after its mail transport accepts. */
const DEFAULT_NOTIFY_TIMEOUT_MS = 15_000;
/**
 * Build a client. Validates the configuration and imports the key now, so a
 * bad value fails at boot; talks to Ward only on first use.
 */
async function createWardClient(options) {
    const issuer = parseHttpUrl(options.issuer, "issuer");
    if (!issuer.pathname.endsWith("/oidc")) {
        throw new TypeError(`ward: issuer must end in /oidc, got ${JSON.stringify(options.issuer)}`);
    }
    const insecure = issuer.protocol === "http:";
    if (insecure && !isLoopback(issuer.hostname)) {
        throw new TypeError("ward: issuer must be https, except on loopback for local development");
    }
    const redirectUri = parseHttpUrl(options.redirectUri, "redirectUri").href;
    const postLogoutRedirectUri = options.postLogoutRedirectUri === undefined || options.postLogoutRedirectUri === ""
        ? undefined
        : parseHttpUrl(options.postLogoutRedirectUri, "postLogoutRedirectUri").href;
    if (typeof options.clientId !== "string" || options.clientId.length === 0) {
        throw new TypeError("ward: clientId is required");
    }
    const clientId = options.clientId;
    const issuerString = issuer.href.replace(/\/$/, "");
    const wardApi = issuerString.slice(0, -"/oidc".length);
    const sessionStatusUrl = `${wardApi}/session-status`;
    const notifyUrl = `${wardApi}/notify`;
    const key = await importClientKey(options.clientKey);
    const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    const timeoutMs = options.timeoutMs ?? DEFAULT_WARD_TIMEOUT_MS;
    const notifyTimeoutMs = options.notifyTimeoutMs ?? DEFAULT_NOTIFY_TIMEOUT_MS;
    const now = options.now ?? (() => Date.now());
    // -------------------------------------------------------------------------
    // Discovery, once
    // -------------------------------------------------------------------------
    let configuration;
    function discover() {
        if (configuration !== undefined)
            return configuration;
        const attempt = discovery(new URL(issuerString), clientId, { id_token_signed_response_alg: "EdDSA" }, PrivateKeyJwt({ key: key.privateKey, kid: key.kid }), {
            // Plain HTTP is allowed only for a loopback issuer, checked above.
            execute: insecure ? [allowInsecureRequests] : [],
            [customFetch]: fetchImpl,
            timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
        })
            .then((config) => {
            enableNonRepudiationChecks(config);
            return config;
        })
            .catch((error) => {
            // Not cached: the next request tries again.
            if (configuration === attempt)
                configuration = undefined;
            throw discoveryError(error);
        });
        configuration = attempt;
        return attempt;
    }
    // -------------------------------------------------------------------------
    // The 30-second check
    // -------------------------------------------------------------------------
    const statusCache = new Map();
    const statusInflight = new Map();
    async function askSessionStatus(wardSid, subject) {
        const body = JSON.stringify({
            client_assertion_type: CLIENT_ASSERTION_TYPE,
            client_assertion: await signClientAssertion(key, clientId, issuerString),
            wardSid,
            subject,
        });
        const response = await post(sessionStatusUrl, body, timeoutMs, "session-status");
        if (response.status === 401)
            throw configurationError("session-status");
        if (response.status !== 200) {
            throw new WardUnavailableError(`session-status answered ${response.status}`);
        }
        const answer = await readJson(response, "session-status");
        if (answer.active === false)
            return { active: false };
        if (answer.active === true && typeof answer.role === "string") {
            return { active: true, role: answer.role };
        }
        throw new WardUnavailableError("session-status answered a body outside its contract");
    }
    function checkSession(wardSid, subject) {
        const cacheKey = `${wardSid}\u0000${subject}`;
        const cached = statusCache.get(cacheKey);
        if (cached !== undefined && cached.expiresAt > now())
            return Promise.resolve(cached.status);
        const pending = statusInflight.get(cacheKey);
        if (pending !== undefined)
            return pending;
        const request = askSessionStatus(wardSid, subject)
            .then((status) => {
            // Only answers are cached. A failure is not: the next request asks
            // again, so a session resumes as soon as Ward is back.
            statusCache.set(cacheKey, {
                status,
                expiresAt: now() + SESSION_STATUS_CACHE_SECONDS * 1000,
            });
            pruneStatusCache();
            return status;
        })
            .finally(() => statusInflight.delete(cacheKey));
        statusInflight.set(cacheKey, request);
        return request;
    }
    /** Keep the cache bounded on a long-lived server: drop expired entries now and then. */
    function pruneStatusCache() {
        if (statusCache.size < 1_000)
            return;
        const at = now();
        for (const [cacheKey, entry] of statusCache) {
            if (entry.expiresAt <= at)
                statusCache.delete(cacheKey);
        }
    }
    // -------------------------------------------------------------------------
    // HTTP to Ward's own endpoints
    // -------------------------------------------------------------------------
    async function post(url, body, ms, what) {
        try {
            return await fetchImpl(url, {
                method: "POST",
                headers: { "content-type": "application/json", accept: "application/json" },
                body,
                signal: AbortSignal.timeout(ms),
            });
        }
        catch (cause) {
            throw new WardUnavailableError(`${what} request failed`, { cause });
        }
    }
    async function readJson(response, what) {
        let parsed;
        try {
            parsed = await response.json();
        }
        catch (cause) {
            throw new WardUnavailableError(`${what} answered a body that is not JSON`, { cause });
        }
        if (typeof parsed !== "object" || parsed === null) {
            throw new WardUnavailableError(`${what} answered a body outside its contract`);
        }
        return parsed;
    }
    function configurationError(what) {
        return new WardConfigurationError(`Ward refused this app's client credential at ${what} (401 invalid_client). ` +
            `Check WARD_OIDC_CLIENT_ID and WARD_OIDC_CLIENT_KEY, and that the key's public half ` +
            `is registered for this app in Ward's console.`);
    }
    function discoveryError(error) {
        if (error instanceof ClientError &&
            error.code === "OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED") {
            // Ward answered, but its metadata names another issuer: WARD_OIDC_ISSUER
            // is not what Ward was configured with.
            return new WardConfigurationError("Ward's discovery document names a different issuer. Check WARD_OIDC_ISSUER " +
                "against Ward's own WARD_OIDC_ISSUER.", { cause: error });
        }
        return new WardUnavailableError("Ward's discovery document could not be fetched", {
            cause: error,
        });
    }
    // -------------------------------------------------------------------------
    return {
        issuer: issuerString,
        clientId,
        redirectUri,
        async startAuthorization(startOptions = {}) {
            const config = await discover();
            const codeVerifier = randomPKCECodeVerifier();
            const state = randomState();
            const nonce = randomNonce();
            const parameters = {
                redirect_uri: redirectUri,
                scope: "openid",
                code_challenge: await calculatePKCECodeChallenge(codeVerifier),
                code_challenge_method: "S256",
                state,
                nonce,
            };
            if (startOptions.prompt !== undefined)
                parameters["prompt"] = startOptions.prompt;
            const url = buildAuthorizationUrl(config, parameters);
            return { url: url.href, flow: { state, nonce, codeVerifier } };
        },
        async finishAuthorization(search, flow) {
            let config;
            try {
                config = await discover();
            }
            catch (error) {
                throw signInErrorFor(error);
            }
            // The URL the browser was sent to, as the browser saw it: the configured
            // redirect URI plus the query Fastify received. `openid-client` derives
            // the token request's `redirect_uri` from it, which must match the
            // authorization request's exactly.
            const currentUrl = new URL(redirectUri);
            currentUrl.search = search;
            let tokens;
            try {
                tokens = await authorizationCodeGrant(config, currentUrl, {
                    pkceCodeVerifier: flow.codeVerifier,
                    expectedState: flow.state,
                    expectedNonce: flow.nonce,
                    idTokenExpected: true,
                });
            }
            catch (error) {
                throw signInErrorFor(error);
            }
            const claims = tokens.claims();
            const idToken = tokens.id_token;
            const subject = claims?.sub;
            const wardSid = claims?.["ward_sid"];
            const role = claims?.["ward_role"];
            const username = claims?.["preferred_username"];
            const authTime = claims?.auth_time;
            const issuedAt = claims?.iat;
            if (idToken === undefined ||
                typeof subject !== "string" ||
                subject.length === 0 ||
                typeof wardSid !== "string" ||
                wardSid.length === 0 ||
                typeof role !== "string" ||
                role.length === 0) {
                throw new WardSignInError("invalid_callback", "Ward's ID token lacks sub, ward_sid or ward_role");
            }
            return {
                subject,
                wardSid,
                role,
                username: typeof username === "string" ? username : "",
                idToken,
                ...(typeof authTime === "number" && Number.isFinite(authTime) ? { authTime } : {}),
                ...(typeof issuedAt === "number" && Number.isFinite(issuedAt) ? { issuedAt } : {}),
            };
        },
        checkSession,
        async sendNotification(input) {
            const body = JSON.stringify({
                client_assertion_type: CLIENT_ASSERTION_TYPE,
                client_assertion: await signClientAssertion(key, clientId, issuerString),
                // Exactly these three beside the credential: Ward refuses any other key.
                subject: input.subject,
                mailSubject: input.mailSubject,
                text: input.text,
            });
            const response = await post(notifyUrl, body, notifyTimeoutMs, "notify");
            if (response.status === 401)
                throw configurationError("notify");
            if (response.status !== 200) {
                throw new WardUnavailableError(`notify answered ${response.status}`);
            }
            const answer = await readJson(response, "notify");
            if (typeof answer.sent !== "boolean") {
                throw new WardUnavailableError("notify answered a body outside its contract");
            }
            return { sent: answer.sent };
        },
        async endSessionUrl(idTokenHint, state) {
            const config = await discover();
            const parameters = { id_token_hint: idTokenHint };
            if (postLogoutRedirectUri !== undefined) {
                parameters["post_logout_redirect_uri"] = postLogoutRedirectUri;
            }
            if (state !== undefined)
                parameters["state"] = state;
            return buildEndSessionUrl(config, parameters).href;
        },
    };
}
/**
 * Map whatever the round trip threw to the code the browser is told.
 *
 * - The provider's own `error` (`access_denied` for no grant, a disabled
 *   account or "Back to the app"; anything else it may send) passes through,
 *   if it looks like an OAuth error code.
 * - Ward unreachable, or answering outside the protocol: `ward_unavailable`.
 * - Ward refusing the client credential: `ward_misconfigured`.
 * - Everything about the response itself — a `state`, `nonce` or `iss` that
 *   does not match, a code Ward will not redeem, an ID token that does not
 *   verify: `invalid_callback`.
 */
function signInErrorFor(error) {
    if (error instanceof WardSignInError)
        return error;
    if (error instanceof WardConfigurationError) {
        return new WardSignInError("ward_misconfigured", error.message, { cause: error });
    }
    if (error instanceof WardUnavailableError) {
        return new WardSignInError("ward_unavailable", error.message, { cause: error });
    }
    if (error instanceof AuthorizationResponseError) {
        const code = /^[a-z_]{1,64}$/.test(error.error) ? error.error : "ward_error";
        return new WardSignInError(code, `Ward answered ${code}`, { cause: error });
    }
    if (error instanceof ResponseBodyError) {
        if (error.status === 401 || error.error === "invalid_client") {
            return new WardSignInError("ward_misconfigured", "Ward refused this app's client credential at the token endpoint. Check " +
                "WARD_OIDC_CLIENT_ID and WARD_OIDC_CLIENT_KEY.", { cause: error });
        }
        return new WardSignInError("invalid_callback", `token endpoint: ${error.error}`, {
            cause: error,
        });
    }
    if (error instanceof ClientError) {
        const unavailable = new Set([
            "OAUTH_RESPONSE_IS_NOT_CONFORM",
            "OAUTH_RESPONSE_IS_NOT_JSON",
            "OAUTH_PARSE_ERROR",
            "OAUTH_TIMEOUT",
            "OAUTH_ABORT",
        ]);
        if (error.code === undefined || unavailable.has(error.code)) {
            return new WardSignInError("ward_unavailable", error.message, { cause: error });
        }
        return new WardSignInError("invalid_callback", error.message, { cause: error });
    }
    // A failed `fetch` is a bare TypeError ("fetch failed"); an argument error
    // from the library carries an ERR_ code and is a bug, reported as such.
    if (error instanceof TypeError && !("code" in error)) {
        return new WardSignInError("ward_unavailable", error.message, { cause: error });
    }
    if (error instanceof DOMException &&
        (error.name === "TimeoutError" || error.name === "AbortError")) {
        return new WardSignInError("ward_unavailable", error.message, { cause: error });
    }
    return new WardSignInError("ward_error", "the Ward sign-in failed", { cause: error });
}
/**
 * The four (and one optional) env variables the local seed writes and the
 * deploy provides. `undefined` when `WARD_OIDC_ISSUER` is unset — the app runs
 * with local accounts only — and a thrown error naming what is missing when
 * the set is incomplete, which is always a deploy mistake.
 */
function wardClientOptionsFromEnv(env = process.env) {
    const issuer = env["WARD_OIDC_ISSUER"]?.trim();
    if (issuer === undefined || issuer === "")
        return undefined;
    const required = ["WARD_OIDC_CLIENT_ID", "WARD_OIDC_CLIENT_KEY", "WARD_OIDC_REDIRECT_URI"];
    const missing = required.filter((name) => (env[name]?.trim() ?? "") === "");
    if (missing.length > 0) {
        throw new TypeError(`WARD_OIDC_ISSUER is set but ${missing.join(", ")} is not`);
    }
    const postLogout = env["WARD_OIDC_POST_LOGOUT_REDIRECT_URI"]?.trim();
    return {
        issuer,
        clientId: env["WARD_OIDC_CLIENT_ID"].trim(),
        clientKey: env["WARD_OIDC_CLIENT_KEY"].trim(),
        redirectUri: env["WARD_OIDC_REDIRECT_URI"].trim(),
        ...(postLogout === undefined || postLogout === "" ? {} : { postLogoutRedirectUri: postLogout }),
    };
}
function parseHttpUrl(value, name) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new TypeError(`ward: ${name} ${JSON.stringify(value)} is not a URL`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new TypeError(`ward: ${name} must be an http(s) URL`);
    }
    return url;
}
/**
 * `localhost`, `::1`, or an IPv4 literal in 127.0.0.0/8. Never a prefix match
 * on the name: `127.evil.example` is a public host.
 */
function isLoopback(hostname) {
    const host = hostname.toLowerCase();
    if (host === "localhost" || host === "[::1]" || host === "::1")
        return true;
    return isIP(host) === 4 && host.split(".")[0] === "127";
}

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
class NoLocalPasswordError extends Error {
    code = "no_local_password";
    constructor() {
        super("set a local password before unlinking Ward");
        this.name = "NoLocalPasswordError";
    }
}
/** Thrown by `unlink` (and the reauthentication flow) for a user with no Ward link. */
class NotLinkedError extends Error {
    code = "not_linked";
    constructor() {
        super("this user has no Ward account linked");
        this.name = "NotLinkedError";
    }
}
/** The highest numeric suffix tried before falling back to a random one. */
const MAX_NAME_SUFFIX = 99;
function createWardIdentities(options) {
    const { accounts } = options;
    const now = options.now ?? (() => Date.now());
    if (!isWardAuthStore(accounts.store)) {
        throw new TypeError("createWardIdentities: the accounts' store has no Ward link methods. " +
            "createSqliteStore provides them; a custom store must implement WardAuthStore.");
    }
    const store = accounts.store;
    async function findUserBySubject(subject) {
        const link = await store.findWardLinkBySubject(subject);
        return link === undefined ? undefined : accounts.findUserById(link.userId);
    }
    async function createLinkedUser(input) {
        const username = normaliseUsername(input.username);
        if (input.id !== undefined && !isAcceptableUserId(input.id))
            throw new InvalidUserIdError();
        if (typeof input.role !== "string" || input.role.length === 0) {
            throw new TypeError("createLinkedUser: role must be a non-empty string");
        }
        if (typeof input.subject !== "string" || input.subject.length === 0) {
            throw new TypeError("createLinkedUser: subject must be a non-empty string");
        }
        const passwordHash = input.password === undefined || input.password === null
            ? null
            : await hashPassword(input.password);
        const created = await store.createUserWithWardLink({
            id: input.id ?? generateUserId(),
            username,
            usernameFolded: foldUsername(username),
            passwordHash,
            role: input.role,
            createdAt: now(),
        }, input.subject);
        return toAuthUser(created);
    }
    async function userForSignIn(identity, roleFor = (role) => role) {
        const linked = await findUserBySubject(identity.subject);
        if (linked !== undefined)
            return { user: linked, created: false };
        const role = roleFor(identity.role);
        for (const username of candidateUsernames(identity.username)) {
            try {
                const user = await createLinkedUser({ subject: identity.subject, username, role });
                return { user, created: true };
            }
            catch (error) {
                if (error instanceof UsernameTakenError)
                    continue;
                if (error instanceof WardSubjectTakenError) {
                    // Two first sign-ins for one subject raced; the other one won.
                    const winner = await findUserBySubject(identity.subject);
                    if (winner !== undefined)
                        return { user: winner, created: false };
                }
                throw error;
            }
        }
        throw new Error("could not find a free username for a new Ward user");
    }
    return {
        accounts,
        findUserBySubject,
        async subjectOf(userId) {
            return (await store.findWardLinkByUserId(userId))?.subject;
        },
        createLinkedUser,
        userForSignIn,
        async link(userId, subject) {
            const existing = await store.findWardLinkByUserId(userId);
            if (existing !== undefined && existing.subject === subject)
                return;
            await store.createWardLink({ subject, userId, linkedAt: now() });
        },
        async unlink(userId) {
            const user = await accounts.findUserById(userId);
            if (user === undefined || (await store.findWardLinkByUserId(userId)) === undefined) {
                throw new NotLinkedError();
            }
            if (!user.hasPassword)
                throw new NoLocalPasswordError();
            await store.deleteWardLink(userId);
            // A session that began with Ward is tied to the link: without it there
            // is no subject to ask Ward about, and no revoke-everywhere.
            const endedSessions = await store.deleteUserWardSessions(userId);
            return { endedSessions };
        },
        async notifyUser(client, userId, message) {
            const subject = (await store.findWardLinkByUserId(userId))?.subject;
            if (subject === undefined)
                return { sent: false, reason: "not_linked" };
            return client.sendNotification({ subject, ...message });
        },
    };
}
/** The name a Ward user gets when `preferred_username` cannot be used. */
const FALLBACK_USERNAME = "ward-user";
/**
 * Names to try for a new Ward user: `preferred_username` as Ward has it, then
 * `name-2`, `name-3`, …, then a random suffix, then `ward-user-<random>`. A
 * name that fails the local policy (Ward's rules are not this library's)
 * falls back to `ward-user`. Every name yielded passes the policy, so a
 * strange `preferred_username` can cost a person their preferred name, never
 * their sign-in.
 */
function* candidateUsernames(preferred) {
    const seen = new Set();
    for (const name of rawCandidates(preferred)) {
        const valid = validUsername(name);
        if (valid === undefined || seen.has(valid))
            continue;
        seen.add(valid);
        yield valid;
    }
}
function* rawCandidates(preferred) {
    const base = validUsername(preferred) ?? FALLBACK_USERNAME;
    yield base;
    for (let n = 2; n <= MAX_NAME_SUFFIX; n += 1)
        yield withSuffix(base, `-${n}`);
    for (let attempt = 0; attempt < 5; attempt += 1) {
        yield withSuffix(base, `-${generateUserId().slice(0, 8)}`);
    }
    // Whatever the base was, these always fit the policy.
    for (let attempt = 0; attempt < 5; attempt += 1) {
        yield `${FALLBACK_USERNAME}-${generateUserId().slice(0, 8)}`;
    }
}
function validUsername(name) {
    try {
        return normaliseUsername(name);
    }
    catch (error) {
        if (error instanceof UsernamePolicyError)
            return undefined;
        throw error;
    }
}
/**
 * `base` cut to leave room for `suffix` within `MAX_USERNAME_LENGTH` UTF-16
 * units, then the suffix. Cut by code point, never through a surrogate pair,
 * and with any trailing space dropped (a cut can land just after one, and
 * `name -2` is not the name with a suffix).
 */
function withSuffix(base, suffix) {
    const room = MAX_USERNAME_LENGTH - suffix.length;
    let kept = "";
    for (const codePoint of base) {
        if (kept.length + codePoint.length > room)
            break;
        kept += codePoint;
    }
    return `${kept.trimEnd()}${suffix}`;
}

/**
 * Request and reply helpers shared by the plugin's routes and its Ward routes:
 * body shapes, the same-origin check, and the stock error replies.
 */
/** What the browser is told about its session. No ids, no hashes. */
function publicSession(session) {
    return { origin: session.origin, expiresAt: session.expiresAt };
}
function credentialsBody(body) {
    if (typeof body !== "object" || body === null)
        return undefined;
    const { username, password } = body;
    if (typeof username !== "string" || typeof password !== "string")
        return undefined;
    // Trimmed: a trailing space in a username is invisible and never intended.
    const trimmed = username.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_USERNAME_LENGTH)
        return undefined;
    // NOT trimmed: a space is a legitimate password character. Capped so an
    // anonymous endpoint cannot be handed a multi-megabyte string.
    if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH)
        return undefined;
    return { username: trimmed, password };
}
function passwordChangeBody(body) {
    if (typeof body !== "object" || body === null)
        return undefined;
    const { currentPassword, newPassword } = body;
    if (typeof currentPassword !== "string" || typeof newPassword !== "string")
        return undefined;
    if (currentPassword.length === 0 || currentPassword.length > MAX_PASSWORD_LENGTH)
        return undefined;
    // The new password's length rules are the policy's, answered with its codes.
    if (newPassword.length === 0)
        return undefined;
    return { currentPassword, newPassword };
}
/**
 * Whether the request is same-origin enough to act on the session cookie.
 *
 * **Absent headers pass**: a server-side caller or a script sends neither, and
 * refusing them would break every non-browser caller to defend against a
 * browser-only attack. What this catches is a browser that *did* send them and
 * said the request came from elsewhere. `Sec-Fetch-Site` must be exactly
 * `same-origin`; an unparseable `Origin` (including the literal `null`) is a
 * mismatch.
 */
function sameOrigin(request, publicOrigin) {
    const fetchSite = request.headers["sec-fetch-site"];
    if (typeof fetchSite === "string" && fetchSite.length > 0 && fetchSite !== "same-origin") {
        return false;
    }
    const origin = request.headers.origin;
    if (origin !== undefined && origin.length > 0) {
        try {
            if (new URL(origin).origin !== publicOrigin)
                return false;
        }
        catch {
            return false;
        }
    }
    return true;
}
/** Decided on headers alone, before any credential is looked at. No cookie is touched. */
function crossSite(reply) {
    return reply.code(403).send({ error: "cross_site" });
}
/** `429` with `Retry-After`, and no artificial delay before it. */
function tooManyAttempts(reply, retryAfterSeconds) {
    return reply
        .code(429)
        .header("retry-after", String(retryAfterSeconds))
        .send({ error: "too_many_attempts", retryAfterSeconds });
}

/**
 * A user with no local password may set one this long after a verified Ward
 * reauthentication (`POST /ward/reauthenticate`). A plain Ward sign-in does
 * not count.
 */
const FRESH_SIGN_IN_SECONDS = 10 * 60;
/**
 * A reauthentication counts when Ward says the password was typed at most
 * this long before it issued the ID token.
 */
const REAUTHENTICATION_MAX_AGE_SECONDS = 120;
/**
 * Whether the ID token proves a password typed for this round trip: an
 * `auth_time`, and an `iat`, no more than two minutes apart. A token without
 * `auth_time` (Ward sends it only for `prompt=login` or `max_age`) never
 * counts.
 */
function isFreshReauthentication(identity) {
    const { authTime, issuedAt } = identity;
    if (authTime === undefined || issuedAt === undefined)
        return false;
    const age = issuedAt - authTime;
    return age >= -5 && age <= REAUTHENTICATION_MAX_AGE_SECONDS;
}
/** The flow cookie's life: one Ward interaction's span. */
const FLOW_MAX_AGE_SECONDS = 10 * 60;
/** Check the `ward` option at boot. Every path is a browser path on the app's origin. */
function validateWardOptions(ward, cookiePath, routePrefix) {
    for (const name of ["loginPath", "settingsPath", "afterSignInPath"]) {
        if (!isLocalPath(ward[name])) {
            throw new TypeError(`wardAuth: ward.${name} must be a path on the app's origin, like "/myapp/login"`);
        }
    }
    const callback = new URL(ward.client.redirectUri).pathname;
    const expectedTail = `${routePrefix}/ward/callback`;
    const underCookiePath = callback === cookiePath ||
        callback.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`);
    if (!callback.endsWith(expectedTail) || !underCookiePath) {
        // The callback must reach this plugin's route, and the session cookie
        // must be sent to it (a link callback needs the session that started it).
        throw new TypeError(`wardAuth: WARD_OIDC_REDIRECT_URI's path is ${callback}; it must end in ${expectedTail} ` +
            `and sit under the cookie path ${cookiePath}, i.e. be the plugin's callback route ` +
            `as the browser reaches it through the app's API prefix.`);
    }
}
/**
 * The 30-second check, as the guard's first session validator.
 *
 * Local sessions return at once and never call Ward. A Ward-originated one is
 * checked against `POST /session-status` through the client's 30-second
 * cache. **Fails closed**: Ward unreachable, a timeout or a malformed answer
 * refuses the request with `ward_unavailable` (the session row stays, so it
 * works again when Ward is back); a `401` refuses with `ward_misconfigured`
 * and logs which settings to check; a Ward session that has ended ends this
 * one too.
 *
 * `ward` is `undefined` when the app runs without Ward configured. Its
 * Ward-originated sessions are then refused as `ward_unavailable`: nothing can
 * vouch for them, and letting them through would turn "Ward is not
 * configured" into "revocation is off".
 */
function wardSessionValidator(ward) {
    return async (resolved, request) => {
        const { session, user } = resolved;
        if (session.origin !== "ward" || session.wardSid === null)
            return { ok: true };
        if (ward === undefined)
            return { ok: false, reason: "ward_unavailable" };
        const subject = await ward.identities.subjectOf(user.id);
        if (subject === undefined) {
            // Unlinked since: there is no Ward account left to vouch for it.
            return { ok: false, reason: "ward_session_ended", endSession: true };
        }
        try {
            const status = await ward.client.checkSession(session.wardSid, subject);
            return status.active
                ? { ok: true }
                : { ok: false, reason: "ward_session_ended", endSession: true };
        }
        catch (error) {
            if (error instanceof WardConfigurationError) {
                request.log.error({ err: error }, error.message);
                return { ok: false, reason: "ward_misconfigured" };
            }
            if (error instanceof WardUnavailableError) {
                request.log.warn({ err: error }, "Ward session check failed; refusing the session");
                return { ok: false, reason: "ward_unavailable" };
            }
            throw error;
        }
    };
}
/** What `/session` (and the sign-in answers) say about Ward. */
async function wardStatusFor(identities, user) {
    if (identities === undefined)
        return { enabled: false, linked: false };
    if (user === null)
        return { enabled: true, linked: false };
    return { enabled: true, linked: (await identities.subjectOf(user.id)) !== undefined };
}
function registerWardRoutes(routes, context) {
    const { accounts, identities, ward, publicOrigin, now } = context;
    const client = ward.client;
    const store = accounts.store;
    if (!isWardAuthStore(store)) {
        throw new TypeError("wardAuth: the ward option needs a store with the Ward methods");
    }
    const flowCookieName = `${context.cookieName}_ward`;
    const flowCookiePath = new URL(client.redirectUri).pathname;
    function flowCookie(flow) {
        return serializeCookie({
            name: flowCookieName,
            value: Buffer.from(JSON.stringify(flow), "utf8").toString("base64url"),
            path: flowCookiePath,
            maxAgeSeconds: FLOW_MAX_AGE_SECONDS,
            secure: context.secure,
        });
    }
    function readFlow(request) {
        const raw = readCookie(request.headers.cookie, flowCookieName);
        if (raw === undefined)
            return undefined;
        let parsed;
        try {
            parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
        }
        catch {
            return undefined;
        }
        if (typeof parsed !== "object" || parsed === null)
            return undefined;
        const flow = parsed;
        const strings = [flow.state, flow.nonce, flow.codeVerifier];
        if (!strings.every((value) => typeof value === "string" && value.length > 0))
            return undefined;
        if (flow.mode !== "sign_in" && flow.mode !== "link" && flow.mode !== "reauthenticate") {
            return undefined;
        }
        if (typeof flow.startedAt !== "number")
            return undefined;
        // The cookie's Max-Age is the browser's promise; this is the server's.
        if (now() - flow.startedAt > FLOW_MAX_AGE_SECONDS * 1000)
            return undefined;
        if (flow.returnTo !== undefined && !isLocalPath(flow.returnTo))
            return undefined;
        return flow;
    }
    /** Start a round trip: the flow cookie, and the URL for the browser. */
    async function start(reply, mode, extra) {
        let started;
        try {
            started = await client.startAuthorization(mode === "reauthenticate" ? { prompt: "login" } : {});
        }
        catch (error) {
            return wardDown(reply, error);
        }
        const flow = { ...started.flow, mode, startedAt: now(), ...extra };
        reply.header("set-cookie", flowCookie(flow));
        reply.header("cache-control", "no-store");
        return reply.code(200).send({ url: started.url });
    }
    function wardDown(reply, error) {
        if (error instanceof WardConfigurationError) {
            reply.log.error({ err: error }, error.message);
            return reply.code(503).send({ error: "ward_misconfigured" });
        }
        if (error instanceof WardUnavailableError) {
            reply.log.warn({ err: error }, "Ward is unreachable");
            return reply.code(503).send({ error: "ward_unavailable" });
        }
        throw error;
    }
    /** A `303` to an app page, on the app's own origin. */
    function land(reply, path, query) {
        const target = new URL(path, publicOrigin);
        for (const [name, value] of Object.entries(query))
            target.searchParams.set(name, value);
        return (reply
            .code(303)
            .header("location", target.href)
            .header("cache-control", "no-store")
            // The callback URL carried an authorization code; do not hand it on.
            .header("referrer-policy", "no-referrer")
            .send());
    }
    /** Start a Ward-originated session and set its cookie. Returns its id hash. */
    async function startSession(reply, userId, wardSid, idToken) {
        const { token, session } = await accounts.startSession(userId, { origin: "ward", wardSid });
        await store.setSessionWardIdToken(session.idHash, idToken);
        reply.header("set-cookie", context.sessionCookie(token, session.expiresAt));
        return session.idHash;
    }
    /** The live session the request's cookie names, without running the checks. */
    async function currentSession(request) {
        const token = readCookie(request.headers.cookie, context.cookieName);
        if (token === undefined)
            return undefined;
        const resolved = await accounts.resolveSession(token);
        return resolved === undefined ? undefined : { token, ...resolved };
    }
    // ---------------------------------------------------------------------------
    routes.post("/ward/start", async (request, reply) => {
        if (!sameOrigin(request, publicOrigin))
            return crossSite(reply);
        const body = (request.body ?? {});
        if (typeof body !== "object" || body === null) {
            return reply.code(400).send({ error: "invalid_request" });
        }
        const returnTo = body["returnTo"];
        if (returnTo !== undefined && (typeof returnTo !== "string" || !isLocalPath(returnTo))) {
            return reply.code(400).send({ error: "invalid_request" });
        }
        return start(reply, "sign_in", returnTo === undefined ? {} : { returnTo });
    });
    routes.post("/ward/link", async (request, reply) => {
        if (!sameOrigin(request, publicOrigin))
            return crossSite(reply);
        const auth = request.auth;
        if (auth === null)
            return reply.code(401).send({ error: "unauthorized" });
        if ((await identities.subjectOf(auth.user.id)) !== undefined) {
            return reply.code(409).send({ error: "already_linked" });
        }
        return start(reply, "link", { sessionIdHash: auth.session.idHash });
    });
    routes.post("/ward/reauthenticate", async (request, reply) => {
        if (!sameOrigin(request, publicOrigin))
            return crossSite(reply);
        const auth = request.auth;
        if (auth === null)
            return reply.code(401).send({ error: "unauthorized" });
        if ((await identities.subjectOf(auth.user.id)) === undefined) {
            return reply.code(409).send({ error: "not_linked" });
        }
        return start(reply, "reauthenticate", { sessionIdHash: auth.session.idHash });
    });
    /**
     * The redirect URI. Public: on a sign-in there is no session yet. Every
     * outcome is a `303` to one of the app's pages, and the flow cookie is
     * cleared on all of them.
     */
    routes.get("/ward/callback", async (request, reply) => {
        reply.header("set-cookie", clearedCookie(flowCookieName, flowCookiePath, context.secure));
        const flow = readFlow(request);
        if (flow === undefined)
            return land(reply, ward.loginPath, { ward_error: "invalid_callback" });
        const errorPage = flow.mode === "sign_in" ? ward.loginPath : ward.settingsPath;
        const rawUrl = request.raw.url ?? "";
        const search = rawUrl.includes("?") ? rawUrl.slice(rawUrl.indexOf("?")) : "";
        let identity;
        try {
            identity = await client.finishAuthorization(search, flow);
        }
        catch (error) {
            const failure = signInErrorFor(error);
            if (failure.code === "ward_misconfigured")
                request.log.error({ err: failure }, failure.message);
            else if (failure.code === "ward_unavailable" || failure.code === "ward_error") {
                request.log.warn({ err: failure }, failure.message);
            }
            return land(reply, errorPage, { ward_error: failure.code });
        }
        try {
            return await finishCallback(request, reply, flow, identity);
        }
        catch (error) {
            // A top-level navigation: a raw 500 JSON page helps nobody. Log it and
            // send the person back where they can try again.
            request.log.error({ err: error }, "Ward callback failed after the code exchange");
            return land(reply, errorPage, { ward_error: "sign_in_failed" });
        }
    });
    /** The callback after a verified code exchange: act on the flow's mode. */
    async function finishCallback(request, reply, flow, identity) {
        if (flow.mode === "sign_in") {
            const { user } = await identities.userForSignIn(identity, ward.roleFor);
            // Signing in on top of an old session replaces it, as a password sign-in does.
            const previous = readCookie(request.headers.cookie, context.cookieName);
            if (previous !== undefined)
                await accounts.endSession(previous);
            await accounts.deleteExpiredSessions();
            await startSession(reply, user.id, identity.wardSid, identity.idToken);
            return land(reply, flow.returnTo ?? ward.afterSignInPath, {});
        }
        // Link and reauthenticate finish only for the session that started them.
        const current = await currentSession(request);
        if (current === undefined || current.session.idHash !== flow.sessionIdHash) {
            return land(reply, ward.settingsPath, { ward_error: "unauthorized" });
        }
        if (flow.mode === "link") {
            try {
                await identities.link(current.user.id, identity.subject);
            }
            catch (error) {
                if (error instanceof AlreadyLinkedError || error instanceof WardSubjectTakenError) {
                    return land(reply, ward.settingsPath, { ward_error: error.code });
                }
                throw error;
            }
            return land(reply, ward.settingsPath, { ward: "linked" });
        }
        // Reauthenticate: the same Ward account must come back, having typed its
        // password for this round trip. The session is replaced by a fresh
        // Ward-originated one, stamped as reauthenticated: what "set a local
        // password" checks for.
        if ((await identities.subjectOf(current.user.id)) !== identity.subject) {
            return land(reply, ward.settingsPath, { ward_error: "ward_account_mismatch" });
        }
        if (!isFreshReauthentication(identity)) {
            request.log.warn({ authTime: identity.authTime ?? null, issuedAt: identity.issuedAt ?? null }, "Ward reauthentication refused: the ID token does not show a password typed for it");
            return land(reply, ward.settingsPath, { ward_error: "invalid_callback" });
        }
        await accounts.endSession(current.token);
        const idHash = await startSession(reply, current.user.id, identity.wardSid, identity.idToken);
        await store.setSessionReauthenticatedAt(idHash, now());
        return land(reply, ward.settingsPath, { ward: "reauthenticated" });
    }
    /**
     * Unlink Ward. Refused while the user has no local password, which would
     * lock them out. Ends every Ward-originated session the user holds — this
     * one too, if it began with Ward — and says so: `{ signedOut: true }` means
     * the person must now sign in with their password.
     */
    routes.post("/ward/unlink", async (request, reply) => {
        if (!sameOrigin(request, publicOrigin))
            return crossSite(reply);
        const auth = request.auth;
        if (auth === null)
            return reply.code(401).send({ error: "unauthorized" });
        try {
            await identities.unlink(auth.user.id);
        }
        catch (error) {
            if (error instanceof NoLocalPasswordError || error instanceof NotLinkedError) {
                return reply.code(409).send({ error: error.code });
            }
            throw error;
        }
        const signedOut = auth.session.origin === "ward";
        if (signedOut)
            reply.header("set-cookie", context.clearedSessionCookie());
        return reply.code(200).send({ signedOut });
    });
    /**
     * Set a local password. A user who has one must give it (this is then a
     * password change). A user created from Ward has none, and this session
     * must have come back from `POST /ward/reauthenticate` within the last ten
     * minutes, so a session left open on a shared machine cannot be turned
     * into a permanent password — not even by a silent Ward sign-in on top of
     * it. Ends the user's other sessions.
     */
    routes.post("/ward/set-password", async (request, reply) => {
        if (!sameOrigin(request, publicOrigin))
            return crossSite(reply);
        const auth = request.auth;
        if (auth === null)
            return reply.code(401).send({ error: "unauthorized" });
        const address = context.lockoutKey(request);
        const gate = context.lockout.check({ surface: "change_password", address });
        if (!gate.allowed)
            return tooManyAttempts(reply, gate.retryAfterSeconds ?? 1);
        const body = setPasswordBody(request.body);
        if (body === undefined)
            return reply.code(400).send({ error: "invalid_request" });
        try {
            if (auth.user.hasPassword) {
                if (body.currentPassword === undefined) {
                    return reply.code(400).send({ error: "invalid_request" });
                }
                const target = {
                    surface: "change_password",
                    address,
                    account: foldUsername(auth.user.username),
                };
                const changed = await accounts.changePassword(auth.user.id, body.currentPassword, body.newPassword, auth.session.idHash);
                if (!changed) {
                    context.lockout.recordFailure(target);
                    return reply.code(401).send({ error: "invalid_credentials" });
                }
                context.lockout.clearFailures(target);
                return reply.code(204).send();
            }
            const reauthenticatedAt = await store.findSessionReauthenticatedAt(auth.session.idHash);
            const age = reauthenticatedAt === undefined ? undefined : now() - reauthenticatedAt;
            const fresh = age !== undefined && age >= 0 && age <= FRESH_SIGN_IN_SECONDS * 1000;
            if (!fresh)
                return reply.code(403).send({ error: "reauthentication_required" });
            await accounts.setPassword(auth.user.id, body.newPassword, auth.session.idHash);
            return reply.code(204).send();
        }
        catch (error) {
            if (error instanceof PasswordPolicyError)
                return reply.code(400).send({ error: error.code });
            throw error;
        }
    });
    /**
     * "Sign out of Ward too": end this session, and answer the URL of Ward's
     * end-session endpoint with this session's ID token as the hint, which
     * makes Ward revoke the Ward session it began with. `{ url: null }` for a
     * session that did not begin with Ward: it is signed out here, and there is
     * nothing at Ward to name. When Ward's URL cannot be built (discovery
     * failing), nothing is ended and the answer is `503 ward_unavailable`.
     */
    routes.post("/ward/logout", async (request, reply) => {
        if (!sameOrigin(request, publicOrigin))
            return crossSite(reply);
        const auth = request.auth;
        if (auth === null)
            return reply.code(401).send({ error: "unauthorized" });
        const idToken = auth.session.origin === "ward"
            ? await store.findSessionWardIdToken(auth.session.idHash)
            : undefined;
        let url = null;
        if (idToken !== undefined) {
            try {
                url = await client.endSessionUrl(idToken);
            }
            catch (error) {
                return wardDown(reply, error);
            }
        }
        await accounts.endSessionByIdHash(auth.session.idHash);
        reply.header("set-cookie", context.clearedSessionCookie());
        reply.header("cache-control", "no-store");
        return reply.code(200).send({ url });
    });
}
function setPasswordBody(body) {
    if (typeof body !== "object" || body === null)
        return undefined;
    const { newPassword, currentPassword } = body;
    if (typeof newPassword !== "string" || newPassword.length === 0)
        return undefined;
    if (currentPassword === undefined || currentPassword === null)
        return { newPassword };
    if (typeof currentPassword !== "string")
        return undefined;
    if (currentPassword.length === 0 || currentPassword.length > MAX_PASSWORD_LENGTH)
        return undefined;
    return { newPassword, currentPassword };
}
/**
 * A path on the app's own origin: starts with one `/`, no `//` or `/\`
 * (which browsers read as another host), no control characters, short.
 * What `returnTo` and the configured pages must be — never an open redirect.
 */
function isLocalPath(value) {
    return (value.length > 0 &&
        value.length <= 512 &&
        value.startsWith("/") &&
        !value.startsWith("//") &&
        !value.startsWith("/\\") &&
        !value.includes("\\") &&
        // eslint-disable-next-line no-control-regex
        !/[\u0000-\u001f\u007f]/.test(value));
}

const wardAuthPlugin = async (app, options) => {
    const { accounts } = options;
    const now = options.now ?? (() => Date.now());
    const routePrefix = normaliseRoutePrefix(options.routePrefix ?? "/auth");
    const lockout = options.lockout ?? createLockout({ now });
    const trustedProxies = resolveTrustedProxies(options.trustedProxies);
    const appValidators = options.validateSession === undefined
        ? []
        : Array.isArray(options.validateSession)
            ? [...options.validateSession]
            : [options.validateSession];
    if (!isValidCookieName(options.cookieName)) {
        throw new TypeError(`wardAuth: cookieName ${JSON.stringify(options.cookieName)} is not a valid cookie name`);
    }
    if (!isValidCookiePath(options.cookiePath)) {
        throw new TypeError(`wardAuth: cookiePath ${JSON.stringify(options.cookiePath)} must be an absolute path`);
    }
    const publicOrigin = parseOrigin(options.publicOrigin);
    const secure = secureCookiesFor(publicOrigin);
    const { cookieName, cookiePath } = options;
    // The Ward half, when configured. Its session check runs first, before the
    // app's own: it is the one that decides whether the session is live at all.
    let identities;
    if (options.ward !== undefined) {
        validateWardOptions(options.ward, cookiePath, routePrefix);
        identities = options.ward.identities ?? createWardIdentities({ accounts, now });
    }
    const validators = [
        wardSessionValidator(options.ward === undefined || identities === undefined
            ? undefined
            : { client: options.ward.client, identities }),
        ...appValidators,
    ];
    const publicRoutes = new Set();
    for (const entry of options.publicRoutes ?? [])
        publicRoutes.add(normalisePublicRoute(entry));
    for (const path of [
        "/login",
        "/logout",
        "/session",
        ...(options.registration ? ["/register"] : []),
        ...(options.ward ? ["/ward/start", "/ward/callback"] : []),
    ]) {
        publicRoutes.add(`* ${routePrefix}${path}`);
    }
    function isPublic(request) {
        if (request.method === "OPTIONS")
            return true;
        const pattern = request.routeOptions.url;
        if (pattern !== undefined) {
            const method = request.method === "HEAD" ? "GET" : request.method;
            if (publicRoutes.has(`* ${pattern}`) || publicRoutes.has(`${method} ${pattern}`))
                return true;
        }
        return options.isPublic?.(request) ?? false;
    }
    function sessionCookie(token, expiresAt) {
        return serializeCookie({
            name: cookieName,
            value: token,
            path: cookiePath,
            maxAgeSeconds: Math.ceil((expiresAt - now()) / 1000),
            secure,
        });
    }
    function clearCookie(reply) {
        reply.header("set-cookie", clearedCookie(cookieName, cookiePath, secure));
    }
    function lockoutKey(request) {
        return lockoutKeyFor(request.socket.remoteAddress, request.headers["x-forwarded-for"], {
            trustedProxies,
            warn: (detail, message) => request.log.warn(detail, message),
        });
    }
    /**
     * Resolve the request's cookie to a live session, run the session checks,
     * and re-send the cookie when the sliding expiry moved. Clears a cookie that
     * names nothing, so a browser stops presenting a dead token.
     */
    async function authenticate(request, reply) {
        const token = readCookie(request.headers.cookie, cookieName);
        if (token === undefined)
            return { kind: "none" };
        const resolved = await accounts.resolveSession(token);
        if (resolved === undefined) {
            clearCookie(reply);
            return { kind: "rejected" };
        }
        for (const validate of validators) {
            let verdict;
            try {
                verdict = await validate(resolved, request);
            }
            catch (error) {
                request.log.error({ err: error }, "session check threw; failing closed");
                verdict = { ok: false, reason: "session_check_failed" };
            }
            if (!verdict.ok) {
                if (verdict.endSession === true) {
                    await accounts.endSessionByIdHash(resolved.session.idHash);
                    clearCookie(reply);
                }
                return { kind: "rejected", reason: verdict.reason };
            }
        }
        if (resolved.renewed) {
            reply.header("set-cookie", sessionCookie(token, resolved.session.expiresAt));
        }
        return { kind: "ok", context: { user: resolved.user, session: resolved.session } };
    }
    /** The body every route that reports a session answers with. */
    async function sessionBody(user, session, reason) {
        const body = {
            user,
            session: session === null ? null : publicSession(session),
            ward: await wardStatusFor(identities, user),
        };
        if (reason !== undefined)
            body["reason"] = reason;
        return body;
    }
    app.decorateRequest("auth", null);
    app.addHook("onRequest", async (request, reply) => {
        if (isPublic(request))
            return;
        const result = await authenticate(request, reply);
        if (result.kind !== "ok") {
            return reply
                .code(401)
                .send(result.kind === "rejected" && result.reason !== undefined
                ? { error: "unauthorized", reason: result.reason }
                : { error: "unauthorized" });
        }
        request.auth = result.context;
    });
    await app.register(async (routes) => {
        routes.post("/login", async (request, reply) => {
            if (!sameOrigin(request, publicOrigin))
                return crossSite(reply);
            const address = lockoutKey(request);
            const gate = lockout.check({ surface: "login", address });
            if (!gate.allowed)
                return tooManyAttempts(reply, gate.retryAfterSeconds ?? 1);
            const body = credentialsBody(request.body);
            if (body === undefined) {
                // Not a lockout failure: a malformed body is a client bug, not a
                // guess. And terse: echoing the fields back would echo the password.
                return reply.code(400).send({ error: "invalid_request" });
            }
            // Folded from the *submitted* name, so a guess at an account that does
            // not exist still gets its own bucket, which an attacker's success on
            // their own account must not forgive.
            const target = {
                surface: "login",
                address,
                account: foldUsername(body.username),
            };
            const user = await accounts.verifyCredentials(body.username, body.password);
            if (user === undefined) {
                lockout.recordFailure(target);
                // One answer for "no such user" and "wrong password".
                return reply.code(401).send({ error: "invalid_credentials" });
            }
            lockout.clearFailures(target);
            // Signing in on top of an old session replaces it rather than leaving
            // a second live row behind.
            const previous = readCookie(request.headers.cookie, cookieName);
            if (previous !== undefined)
                await accounts.endSession(previous);
            await accounts.deleteExpiredSessions();
            const { token, session } = await accounts.startSession(user.id);
            reply.header("set-cookie", sessionCookie(token, session.expiresAt));
            return reply.code(200).send(await sessionBody(user, session));
        });
        /**
         * Answers `204` whatever was presented. The cookie is cleared **only when
         * one was presented**: a cross-site page that could make the browser
         * clear it would sign the person out in a loop (Ward's finding), and the
         * same-origin check closes the rest.
         */
        routes.post("/logout", async (request, reply) => {
            if (!sameOrigin(request, publicOrigin))
                return crossSite(reply);
            const token = readCookie(request.headers.cookie, cookieName);
            if (token !== undefined) {
                await accounts.endSession(token);
                clearCookie(reply);
            }
            return reply.code(204).send();
        });
        /**
         * "Who am I". Public, so a signed-out browser gets `200 { user: null }`
         * rather than an error to handle — the React hooks rely on that. `reason`
         * is present when a cookie named a session that a check rejected.
         */
        routes.get("/session", async (request, reply) => {
            const result = await authenticate(request, reply);
            if (result.kind === "ok") {
                return sessionBody(result.context.user, result.context.session);
            }
            return sessionBody(null, null, result.kind === "rejected" ? result.reason : undefined);
        });
        /**
         * Change one's own password. Guarded, so `request.auth` is set. Ends every
         * other session the user holds; the one making the change stays.
         */
        routes.post("/password", async (request, reply) => {
            if (!sameOrigin(request, publicOrigin))
                return crossSite(reply);
            const auth = request.auth;
            if (auth === null)
                return reply.code(401).send({ error: "unauthorized" });
            const address = lockoutKey(request);
            const gate = lockout.check({ surface: "change_password", address });
            if (!gate.allowed)
                return tooManyAttempts(reply, gate.retryAfterSeconds ?? 1);
            const body = passwordChangeBody(request.body);
            if (body === undefined)
                return reply.code(400).send({ error: "invalid_request" });
            const target = {
                surface: "change_password",
                address,
                account: foldUsername(auth.user.username),
            };
            let changed;
            try {
                changed = await accounts.changePassword(auth.user.id, body.currentPassword, body.newPassword, auth.session.idHash);
            }
            catch (error) {
                if (error instanceof PasswordPolicyError)
                    return reply.code(400).send({ error: error.code });
                throw error;
            }
            if (!changed) {
                lockout.recordFailure(target);
                return reply.code(401).send({ error: "invalid_credentials" });
            }
            lockout.clearFailures(target);
            return reply.code(204).send();
        });
        if (options.registration !== undefined) {
            const { role } = options.registration;
            /**
             * Create a local account and sign it in. **Every** attempt that parses
             * counts against the address's register budget, successes included: it
             * is the app's only anonymous write, so five accounts per address per
             * window is the ceiling, and a taken-name probe costs the same hash as a
             * real registration (the password is hashed before the uniqueness
             * check) so it is no cheaper an oracle.
             */
            routes.post("/register", async (request, reply) => {
                if (!sameOrigin(request, publicOrigin))
                    return crossSite(reply);
                const address = lockoutKey(request);
                const gate = lockout.check({ surface: "register", address });
                if (!gate.allowed)
                    return tooManyAttempts(reply, gate.retryAfterSeconds ?? 1);
                const body = credentialsBody(request.body);
                if (body === undefined)
                    return reply.code(400).send({ error: "invalid_request" });
                lockout.recordFailure({ surface: "register", address });
                let user;
                try {
                    user = await accounts.createUser({
                        username: body.username,
                        password: body.password,
                        role,
                    });
                }
                catch (error) {
                    if (error instanceof UsernamePolicyError || error instanceof PasswordPolicyError) {
                        return reply.code(400).send({ error: error.code });
                    }
                    if (error instanceof UsernameTakenError) {
                        return reply.code(409).send({ error: "username_taken" });
                    }
                    throw error;
                }
                const { token, session } = await accounts.startSession(user.id);
                reply.header("set-cookie", sessionCookie(token, session.expiresAt));
                return reply.code(201).send(await sessionBody(user, session));
            });
        }
        if (options.ward !== undefined && identities !== undefined) {
            registerWardRoutes(routes, {
                accounts,
                identities,
                ward: options.ward,
                publicOrigin,
                cookieName,
                secure,
                now,
                lockout,
                lockoutKey,
                sessionCookie,
                clearedSessionCookie: () => clearedCookie(cookieName, cookiePath, secure),
            });
        }
    }, { prefix: routePrefix });
};
/**
 * Escape encapsulation, exactly as `fastify-plugin` does, so the guard lands on
 * the instance the app registered this on.
 */
Object.assign(wardAuthPlugin, {
    [Symbol.for("skip-override")]: true,
    [Symbol.for("fastify.display-name")]: "ward-auth",
});
const wardAuth = wardAuthPlugin;
/**
 * A `preHandler` that lets through only the given roles. The guard has already
 * established *who*; this says *what*. `403 { error: "forbidden" }` otherwise.
 *
 * ```ts
 * app.delete("/items/:id", { preHandler: requireRole("admin") }, handler);
 * ```
 */
function requireRole(...roles) {
    return async function requireRoleHandler(request, reply) {
        if (request.auth === null || !roles.includes(request.auth.user.role)) {
            return reply.code(403).send({ error: "forbidden" });
        }
    };
}
function parseOrigin(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new TypeError(`wardAuth: publicOrigin ${JSON.stringify(value)} is not a URL`);
    }
    if (url.origin === "null" || url.origin !== value.replace(/\/$/, "")) {
        throw new TypeError(`wardAuth: publicOrigin must be a bare origin like https://example.com, got ${JSON.stringify(value)}`);
    }
    return url.origin;
}
/**
 * The option if it was given, else `AUTH_TRUSTED_PROXIES`, parsed once. A bad
 * entry throws here, at registration, naming where it came from — so a typo
 * stops the boot instead of quietly trusting the wrong peers.
 */
function resolveTrustedProxies(option) {
    const [entries, source] = option === undefined
        ? [process.env["AUTH_TRUSTED_PROXIES"] ?? "", "AUTH_TRUSTED_PROXIES"]
        : [option, "trustedProxies"];
    try {
        return parseTrustedProxies(entries);
    }
    catch (error) {
        throw new TypeError(`wardAuth: ${source}: ${error.message}`, { cause: error });
    }
}
function normaliseRoutePrefix(prefix) {
    const trimmed = prefix.replace(/\/+$/, "");
    if (trimmed.length > 0 && !trimmed.startsWith("/")) {
        throw new TypeError(`wardAuth: routePrefix ${JSON.stringify(prefix)} must start with "/"`);
    }
    return trimmed;
}
/** `"GET /health"` stays as it is; `"/health"` becomes `"* /health"` (any method). */
function normalisePublicRoute(entry) {
    const match = /^(?:([A-Z]+)\s+)?(\/\S*)$/.exec(entry.trim());
    if (match === null) {
        throw new TypeError(`wardAuth: publicRoutes entry ${JSON.stringify(entry)} is not "METHOD /path" or "/path"`);
    }
    return `${match[1] ?? "*"} ${match[2]}`;
}

export { AlreadyLinkedError, DEFAULT_NOTIFY_TIMEOUT_MS, DEFAULT_WARD_TIMEOUT_MS, FRESH_SIGN_IN_SECONDS, InvalidClientKeyError, InvalidUserIdError, LOCKOUT_MAX_FAILURES, LOCKOUT_WINDOW_SECONDS, MAX_PASSWORD_LENGTH, MAX_USERNAME_LENGTH, MIN_PASSWORD_LENGTH, NoLocalPasswordError, NotLinkedError, PasswordPolicyError, SESSION_ABSOLUTE_SECONDS, SESSION_IDLE_SECONDS, SESSION_RENEW_INTERVAL_SECONDS, SESSION_STATUS_CACHE_SECONDS, SQLITE_MIGRATIONS, SchemaTooNewError, UserIdTakenError, UsernamePolicyError, UsernameTakenError, WardConfigurationError, WardSignInError, WardSubjectTakenError, WardUnavailableError, clearedCookie, createAccounts, createLockout, createSqliteStore, createWardClient, createWardIdentities, foldUsername, generateSessionToken, hashPassword, hashSessionToken, isWardAuthStore, lockoutKeyFor, migrateSqlite, normaliseUsername, parseTrustedProxies, readCookie, requireRole, secureCookiesFor, seedUsers, serializeCookie, spendDummyHash, toAuthUser, verifyPassword, wardAuth, wardClientOptionsFromEnv };
