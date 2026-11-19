// ward-auth 1.1.0 — built from https://github.com/gandolh/ward-auth (shared-library/).
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
 * that every migrated Ward account fits (atrium's and prm's migrations
 * carried usernames over).
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
 * Validate an id an app supplied (atrium's and prm's migrations reuse each
 * migrated user's Ward subject so existing rows keep their keys). Printable ASCII without
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
 * Unicode's confusables table (UTS #39, Unicode Security Mechanisms), version
 * 17.0.0: the code point each look-alike maps to, which `usernameSkeleton`
 * in `./username-skeleton.ts` uses. 6565 mappings.
 *
 * Generated by `scripts/confusables.mjs`; don't edit it by hand. Source:
 * https://www.unicode.org/Public/17.0.0/security/confusables.txt
 * Date: 2025-07-22, 05:49:37 GMT
 * SHA-256: 091c7f82fc39ef208faf8f94d29c244de99254675e09de163160c810d13ef22a
 *
 * Each line is a code point, `;`, then the code points of its prototype, all
 * in hex: `0430;0061` maps Cyrillic а to Latin a. Only the mappings are kept;
 * the source's comments (the names and glyphs) are most of its size.
 *
 * The data is Unicode's, under this notice:
 *
 * UNICODE LICENSE V3
 *
 * COPYRIGHT AND PERMISSION NOTICE
 *
 * Copyright © 1991-2026 Unicode, Inc.
 *
 * NOTICE TO USER: Carefully read the following legal agreement. BY
 * DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
 * SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
 * TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
 * DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of data files and any associated documentation (the "Data Files") or
 * software and any associated documentation (the "Software") to deal in the
 * Data Files or Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, and/or sell
 * copies of the Data Files or Software, and to permit persons to whom the
 * Data Files or Software are furnished to do so, provided that either (a)
 * this copyright and permission notice appear with all copies of the Data
 * Files or Software, or (b) this copyright and permission notice appear in
 * associated Documentation.
 *
 * THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
 * KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
 * THIRD PARTY RIGHTS.
 *
 * IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
 * BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
 * OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
 * WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
 * ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
 * FILES OR SOFTWARE.
 *
 * Except as contained in this notice, the name of a copyright holder shall
 * not be used in advertising or otherwise to promote the sale, use or other
 * dealings in these Data Files or Software without prior written
 * authorization of the copyright holder.
 */
const CONFUSABLES = `05AD;0596
05AE;0598
05A8;0599
05A4;059A
1AB4;06DB
20DB;06DB
0619;0313
08F3;0313
0343;0313
0315;0313
064F;0313
065D;0314
059C;0301
059D;0301
0618;0301
0747;0301
0341;0301
0954;0301
064E;0301
0340;0300
0953;0300
030C;0306
A67C;0306
0658;0306
065A;0306
036E;0306
0945;0306
11B66;0306
06E8;0306 0307
0310;0306 0307
0901;0306 0307
0981;0306 0307
0A81;0306 0307
0B01;0306 0307
0C00;0306 0307
0C81;0306 0307
0D01;0306 0307
114BF;0306 0307
1CD0;0302
0311;0302
065B;0302
07EE;0302
A6F0;0302
05AF;030A
06DF;030A
17D3;030A
309A;030A
0652;030A
0B82;030A
1036;030A
17C6;030A
11300;030A
0E4D;030A
0ECD;030A
0366;030A
2DEA;030A
08EB;0308
07F3;0308
064B;030B
08F0;030B
0342;0303
0653;0303
05C4;0307
06EC;0307
0740;0307
08EA;0307
0741;0307
0358;0307
05B9;0307
05BA;0307
05C2;0307
05C1;0307
07ED;0307
0902;0307
0A02;0307
0A82;0307
0BCD;0307
0337;0338
1AB7;0328
0322;0328
0345;0328
1CD2;0304
0305;0304
0659;0304
07EB;0304
A6F1;0304
1AE2;0304
1AE8;0304 0304
1CDA;030E
0657;0312
0357;0350
08FF;0350
08F8;0350
0900;0352
1AD9;1AC6
1E6EE;1AC8
1CED;0316
1CDC;0329
0656;0329
1CD5;032B
0347;0333
08F9;0354
08FA;0355
309B;FF9E
309C;FF9F
0336;0335
302C;0309
05C5;0323
08ED;0323
1CDD;0323
05B4;0323
065C;0323
093C;0323
09BC;0323
0A3C;0323
0ABC;0323
0B3C;0323
111CA;0323
114C3;0323
10A3A;0323
08EE;0324
1CDE;0324
0F37;0325
302D;0325
0327;0326
0321;0326
0339;0326
1CD9;032D
1CD8;032E
0952;0331
0320;0331
08F1;064C
08E8;064C
08E5;064C
FC5E;FE72 0651
08F2;064D
FC5F;FE74 0651
FCF2;FE77 0651
FC60;FE76 0651
FCF3;FE79 0651
FC61;FE78 0651
061A;0650
0317;0650
FCF4;FE7B 0651
FC62;FE7A 0651
FC63;FE7C 0670
065F;0655
030D;0670
0742;073C
0A03;0983
0C03;0983
0C83;0983
0D03;0983
0D83;0983
1038;0983
114C1;0983
17CB;0E48
0EC8;0E48
0EC9;0E49
0ECA;0E4A
0ECB;0E4B
A66F;20E9
2028;0020
2029;0020
1680;0020
2000;0020
2001;0020
2002;0020
2003;0020
2004;0020
2005;0020
2006;0020
2008;0020
2009;0020
200A;0020
205F;0020
00A0;0020
2007;0020
202F;0020
07FA;005F
FE4D;005F
FE4E;005F
FE4F;005F
2010;002D
2011;002D
2012;002D
2013;002D
FE58;002D
06D4;002D
2043;002D
02D7;002D
2212;002D
2796;002D
2CBB;002D
2CBA;002D
2A29;002D 0313
2E1A;002D 0308
FB29;002D 0307
2238;002D 0307
2CB3;002D 0307
2CB2;002D 0307
2A2A;002D 0323
A4FE;002D 002E
FF5E;301C
060D;002C
066B;002C
201A;002C
00B8;002C
A4F9;002C
2E32;060C
066C;060C
037E;003B
2E35;061B
0903;003A
0A83;003A
FF1A;003A
0589;003A
0703;003A
0704;003A
16EC;003A
FE30;003A
1803;003A
1809;003A
205A;003A
05C3;003A
02F8;003A
A789;003A
2236;003A
02D0;003A
A4FD;003A
11DD9;003A
2A74;003A 003A 003D
29F4;003A 2192
FF01;0021
01C3;0021
2D51;0021
203C;0021 0021
2049;0021 003F
0294;003F
0241;003F
097D;003F
13AE;003F
A6EB;003F
2048;003F 0021
2047;003F 003F
2E2E;061F
1D16D;002E
2024;002E
0701;002E
0702;002E
A60E;002E
10A50;002E
0660;002E
06F0;002E
A4F8;002E
A4FB;002E 002C
2025;002E 002E
A4FA;002E 002E
2026;002E 002E 002E
A6F4;A6F3 A6F3
30FB;00B7
FF65;00B7
16EB;00B7
0387;00B7
2E31;00B7
10101;00B7
2022;00B7
2027;00B7
2219;00B7
22C5;00B7
A78F;00B7
1427;00B7
22EF;00B7 00B7 00B7
2D48;00B7 00B7 00B7
1444;00B7 003C
22D7;00B7 003E
1437;00B7 003E
1440;00B7 003E
152F;00B7 0034
147E;00B7 0062
1480;00B7 0062 0307
147A;00B7 0064
1498;00B7 004A
14B6;00B7 004C
1476;00B7 0050
1457;00B7 0055
143A;00B7 0056
143C;00B7 0245
14AE;00B7 0393
140E;00B7 0394
1459;00B7 0548
140C;00B7 1401
1410;00B7 1404
1412;00B7 1405
1414;00B7 1406
1417;00B7 140A
1419;00B7 140B
143E;00B7 1432
1442;00B7 1434
1446;00B7 1439
145B;00B7 144F
1454;00B7 1450
145D;00B7 1450
145F;00B7 1451
1461;00B7 1455
1463;00B7 1456
1474;00B7 146B
1478;00B7 146E
147C;00B7 1470
1492;00B7 1489
1494;00B7 148B
1496;00B7 148C
149A;00B7 148E
149C;00B7 1490
149E;00B7 1491
14AC;00B7 14A3
14B0;00B7 14A6
14B2;00B7 14A7
14B4;00B7 14A8
14B8;00B7 14AB
14C9;00B7 14C0
18C6;00B7 14C2
18C8;00B7 14C3
18CA;00B7 14C4
18CC;00B7 14C5
14CB;00B7 14C7
14CD;00B7 14C8
14DC;00B7 14D3
14DE;00B7 14D5
14E0;00B7 14D6
14E2;00B7 14D7
14E4;00B7 14D8
14E6;00B7 14DA
14E8;00B7 14DB
14F6;00B7 14ED
14F8;00B7 14EF
14FA;00B7 14F0
14FC;00B7 14F1
14FE;00B7 14F2
1500;00B7 14F4
1502;00B7 14F5
1517;00B7 1510
1519;00B7 1511
151B;00B7 1512
151D;00B7 1513
151F;00B7 1514
1521;00B7 1515
1523;00B7 1516
1531;00B7 1528
1533;00B7 1529
1535;00B7 152A
1537;00B7 152B
1539;00B7 152D
153B;00B7 152E
18CE;00B7 1543
18CF;00B7 1546
18D0;00B7 1547
18D1;00B7 1548
18D2;00B7 1549
18D3;00B7 154B
154E;00B7 154C
155B;00B7 155A
1568;00B7 1567
18B3;00B7 18B1
18B6;00B7 18B4
18B9;00B7 18B8
18C2;00B7 18C0
A830;0964
0965;0964 0964
1C3C;1C3B 1C3B
104B;104A 104A
1AA9;1AA8 1AA8
1AAB;1AAA 1AA8
1B5F;1B5E 1B5E
10A57;10A56 10A56
1144C;1144B 1144B
11642;11641 11641
11C42;11C41 11C41
1C7F;1C7E 1C7E
055D;0027
FF07;0027
2018;0027
2019;0027
201B;0027
05F3;0027
2032;0027
2035;0027
055A;0027
0060;0027
1FEF;0027
FF40;0027
00B4;0027
0384;0027
1FFD;0027
1FBD;0027
1FBF;0027
1FFE;0027
02B9;0027
0374;0027
02C8;0027
02CA;0027
02CB;0027
02F4;0027
02BB;0027
02BD;0027
02BC;0027
02BE;0027
A78C;0027
05D9;0027
07F4;0027
07F5;0027
144A;0027
16CC;0027
16F51;0027
16F52;0027
1CD3;0027 0027
0022;0027 0027
FF02;0027 0027
201C;0027 0027
201D;0027 0027
201F;0027 0027
05F4;0027 0027
2033;0027 0027
2036;0027 0027
3003;0027 0027
02DD;0027 0027
02BA;0027 0027
02F6;0027 0027
02EE;0027 0027
05F2;0027 0027
2034;0027 0027 0027
2037;0027 0027 0027
2057;0027 0027 0027 0027
0181;0027 0042
018A;0027 0044
0149;0027 006E
01A4;0027 0050
01AC;0027 0054
01B3;0027 0059
FF3B;0028
2768;0028
2772;0028
3014;0028
FD3E;0028
2E28;0028 0028
3220;0028 30FC 0029
2475;0028 0032 0029
2487;0028 0032 004F 0029
2476;0028 0033 0029
2477;0028 0034 0029
2478;0028 0035 0029
2479;0028 0036 0029
247A;0028 0037 0029
247B;0028 0038 0029
247C;0028 0039 0029
249C;0028 0061 0029
1F110;0028 0041 0029
249D;0028 0062 0029
1F111;0028 0042 0029
249E;0028 0063 0029
1F112;0028 0043 0029
249F;0028 0064 0029
1F113;0028 0044 0029
24A0;0028 0065 0029
1F114;0028 0045 0029
24A1;0028 0066 0029
1F115;0028 0046 0029
24A2;0028 0067 0029
1F116;0028 0047 0029
24A3;0028 0068 0029
1F117;0028 0048 0029
24A4;0028 0069 0029
24A5;0028 006A 0029
1F119;0028 004A 0029
24A6;0028 006B 0029
1F11A;0028 004B 0029
2474;0028 006C 0029
1F118;0028 006C 0029
24A7;0028 006C 0029
1F11B;0028 004C 0029
247F;0028 006C 0032 0029
2480;0028 006C 0033 0029
2481;0028 006C 0034 0029
2482;0028 006C 0035 0029
2483;0028 006C 0036 0029
2484;0028 006C 0037 0029
2485;0028 006C 0038 0029
2486;0028 006C 0039 0029
247E;0028 006C 006C 0029
247D;0028 006C 004F 0029
1F11C;0028 004D 0029
24A9;0028 006E 0029
1F11D;0028 004E 0029
24AA;0028 006F 0029
1F11E;0028 004F 0029
24AB;0028 0070 0029
1F11F;0028 0050 0029
24AC;0028 0071 0029
1F120;0028 0051 0029
24AD;0028 0072 0029
1F121;0028 0052 0029
24A8;0028 0072 006E 0029
24AE;0028 0073 0029
1F122;0028 0053 0029
1F12A;0028 0053 0029
24AF;0028 0074 0029
1F123;0028 0054 0029
24B0;0028 0075 0029
1F124;0028 0055 0029
24B1;0028 0076 0029
1F125;0028 0056 0029
24B2;0028 0077 0029
1F126;0028 0057 0029
24B3;0028 0078 0029
1F127;0028 0058 0029
24B4;0028 0079 0029
1F128;0028 0059 0029
24B5;0028 007A 0029
1F129;0028 005A 0029
3200;0028 1100 0029
320E;0028 AC00 0029
3201;0028 1102 0029
320F;0028 B098 0029
3202;0028 1103 0029
3210;0028 B2E4 0029
3203;0028 1105 0029
3211;0028 B77C 0029
3204;0028 1106 0029
3212;0028 B9C8 0029
3205;0028 1107 0029
3213;0028 BC14 0029
3206;0028 1109 0029
3214;0028 C0AC 0029
3207;0028 110B 0029
3215;0028 C544 0029
321D;0028 C624 C804 0029
321E;0028 C624 D6C4 0029
3208;0028 110C 0029
3216;0028 C790 0029
321C;0028 C8FC 0029
3209;0028 110E 0029
3217;0028 CC28 0029
320A;0028 110F 0029
3218;0028 CE74 0029
320B;0028 1110 0029
3219;0028 D0C0 0029
320C;0028 1111 0029
321A;0028 D30C 0029
320D;0028 1112 0029
321B;0028 D558 0029
3226;0028 4E03 0029
3222;0028 4E09 0029
1F241;0028 4E09 0029
3228;0028 4E5D 0029
3221;0028 4E8C 0029
1F242;0028 4E8C 0029
3224;0028 4E94 0029
3239;0028 4EE3 0029
323D;0028 4F01 0029
3241;0028 4F11 0029
3227;0028 516B 0029
3225;0028 516D 0029
3238;0028 52B4 0029
1F247;0028 52DD 0029
3229;0028 5341 0029
323F;0028 5354 0029
3234;0028 540D 0029
323A;0028 547C 0029
3223;0028 56DB 0029
322F;0028 571F 0029
323B;0028 5B66 0029
1F243;0028 5B89 0029
1F245;0028 6253 0029
1F248;0028 6557 0029
3230;0028 65E5 0029
322A;0028 6708 0029
3232;0028 6709 0029
322D;0028 6728 0029
1F240;0028 672C 0029
3231;0028 682A 0029
322C;0028 6C34 0029
322B;0028 706B 0029
1F244;0028 70B9 0029
3235;0028 7279 0029
1F246;0028 76D7 0029
323C;0028 76E3 0029
3233;0028 793E 0029
3237;0028 795D 0029
3240;0028 796D 0029
3242;0028 81EA 0029
3243;0028 81F3 0029
3236;0028 8CA1 0029
323E;0028 8CC7 0029
322E;0028 91D1 0029
FF3D;0029
2769;0029
2773;0029
3015;0029
FD3F;0029
2E29;0029 0029
2774;007B
1D114;007B
2775;007D
301A;27E6
301B;27E7
27E8;276C
2329;276C
3008;276C
31DB;276C
304F;276C
21FE8;276C
27E9;276D
232A;276D
3009;276D
FF3E;FE3F
2E3F;00B6
204E;002A
066D;002A
2217;002A
1031F;002A
1735;002F
2041;002F
2215;002F
2044;002F
2571;002F
27CB;002F
29F8;002F
1D23A;002F
31D3;002F
3033;002F
2CC7;002F
2CC6;002F
30CE;002F
4E3F;002F
2F03;002F
29F6;002F 0304
2AFD;002F 002F
2AFB;002F 002F 002F
FF3C;005C
FE68;005C
2216;005C
27CD;005C
29F5;005C
29F9;005C
1D20F;005C
1D23B;005C
31D4;005C
4E36;005C
2F02;005C
2CF9;005C 005C
244A;005C 005C
27C8;005C 1455
A778;0026
0AF0;0970
110BB;0970
111C7;0970
26AC;0970
111DB;A8FC
17D9;0E4F
17D5;0E5A
17DA;0E5B
0F0C;0F0B
0F0E;0F0D 0F0D
02C4;005E
02C6;005E
A67E;02C7
02D8;02C7
203E;02C9
FE49;02C9
FE4A;02C9
FE4B;02C9
FE4C;02C9
00AF;02C9
FFE3;02C9
2594;02C9
044A;02C9 0062
A651;02C9 0062 0069
0375;02CF
02FB;02EA
A716;02EA
A714;02EB
3002;02F3
2E30;00B0
02DA;00B0
2218;00B0
25CB;00B0
25E6;00B0
235C;00B0 0332
10ED0;00B0 0332
2364;00B0 0308
2103;00B0 0043
2109;00B0 0046
0BF5;0BF3
0F1B;0F1A 0F1A
0F1F;0F1A 0F1D
0FCE;0F1D 0F1A
0F1E;0F1D 0F1D
24B8;00A9
24C7;00AE
24C5;2117
1D21B;2144
2BEC;219E
2BED;219F
2BEE;21A0
2BEF;21A1
21B5;21B2
2965;21C3 21C2
296F;21C3 16DA
1D6DB;2202
1D715;2202
1D74F;2202
1D789;2202
1D7C3;2202
1E8CC;2202
1E8CD;2202 0335
00F0;2202 0335
2300;2205
1D6C1;2207
1D6FB;2207
1D735;2207
1D76F;2207
1D7A9;2207
118A8;2207
2362;2207 0308
236B;2207 0334
2588;220E
25A0;220E
2A3F;2210
16ED;002B
2795;002B
1029B;002B
1E6E9;002B
2A23;002B 0302
2A22;002B 030A
2A24;002B 0303
2214;002B 0307
2A25;002B 0323
2A26;002B 0330
2A27;002B 2082
2797;00F7
2039;003C
276E;003C
02C2;003C
1D236;003C
1438;003C
16B2;003C
22D6;003C 00B7
2CB5;003C 00B7
2CB4;003C 00B7
1445;003C 00B7
226A;003C 003C
22D8;003C 003C 003C
1400;003D
2E40;003D
30A0;003D
A4FF;003D
225A;003D 0306
2259;003D 0302
2257;003D 030A
2250;003D 0307
2251;003D 0307 0323
2B96;003D 1AB2
2A6E;003D 20F0
2A75;003D 003D
2A76;003D 003D 003D
225E;003D 036B
203A;003E
276F;003E
02C3;003E
1D237;003E
1433;003E
16F3F;003E
1441;003E 00B7
2AA5;003E 003C
226B;003E 003E
2A20;003E 003E
22D9;003E 003E 003E
2053;007E
02DC;007E
1FC0;007E
223C;007E
2368;007E 0308
2E1E;007E 0307
2A6A;007E 0307
2E1F;007E 0323
1E8C8;2220
22C0;2227
222F;222E 222E
2230;222E 222E 222E
2E2B;2234
2E2A;2235
2E2C;2237
111DE;2248
264E;224F
1F75E;224F
2263;2261
2CB7;2261
2A03;228D
2A04;228E
1D238;228F
1D239;2290
2A05;2293
2A06;2294
2A02;2297
235F;229B
1F771;22A0
1F755;22A1
25C1;22B2
25B7;22B3
2363;22C6 0308
FE34;2307
25E0;2312
2A3D;2319
2325;2324
29C7;233B
25CE;233E
29BE;233E
29C5;2342
29B0;2349
23C3;234B
23C2;234E
23C1;2355
23C6;236D
2638;2388
FE35;23DC
FE36;23DD
FE37;23DE
FE38;23DF
FE39;23E0
FE3A;23E1
25B1;23E5
23FC;23FB
FE31;2502
FF5C;2502
2503;2502
250F;250C
2523;251C
2590;258C
2597;2596
259D;2598
2610;25A1
FFED;25AA
25B8;25B6
25BA;25B6
2CE9;2627
1F70A;2629
1F312;263D
1F319;263D
23FE;263E
1F318;263E
29D9;299A
1F73A;29DF
2A3E;2A1F
2669;1D158 1D165
266A;1D158 1D165 1D16E
24EA;1F10D
21BA;1F10E
1CCFB;1F6F8
02D9;0971
0D4E;0971
FF0D;30FC
2014;30FC
2015;30FC
2500;30FC
2501;30FC
31D0;30FC
A7F7;30FC
1173;30FC
3161;30FC
4E00;30FC
2F00;30FC
1196;30FC 30FC
D7B9;30FC 1161
D7BA;30FC 1165
D7BB;30FC 1165 4E28
D7BC;30FC 1169
1195;30FC 116E
1174;30FC 4E28
3162;30FC 4E28
1197;30FC 4E28 116E
1F10F;0024 20E0
20A4;00A3
3012;20B8
3036;20B8
1B5C;1B50
A9C6;A9D0
114D1;09E7
0CE7;0C67
1065;1041
2460;2780
2469;2789
23E8;2081 2080
1CCF2;0032
1D7D0;0032
1D7DA;0032
1D7E4;0032
1D7EE;0032
1D7F8;0032
1FBF2;0032
A75A;0032
01A7;0032
03E8;0032
A644;0032
14BF;0032
A6EF;0032
A9CF;0662
06F2;0662
0AE8;0968
0AB0;0968
114D2;09E8
0CE8;0C68
2461;2781
01BB;0032 0335
1F103;0032 002C
2489;0032 002E
33F5;0032 0032 65E5
336E;0032 0032 70B9
33F6;0032 0033 65E5
336F;0032 0033 70B9
33F7;0032 0034 65E5
3370;0032 0034 70B9
33F8;0032 0035 65E5
33F9;0032 0036 65E5
33FA;0032 0037 65E5
33FB;0032 0038 65E5
33FC;0032 0039 65E5
33F4;0032 006C 65E5
336D;0032 006C 70B9
249B;0032 004F 002E
33F3;0032 004F 65E5
336C;0032 004F 70B9
0DE9;0DE8 0DCF
0DEF;0DE8 0DD3
33E1;0032 65E5
32C1;0032 6708
335A;0032 70B9
1D206;0033
0969;0033
0AE9;0033
1CCF3;0033
1D7D1;0033
1D7DB;0033
1D7E5;0033
1D7EF;0033
1D7F9;0033
1FBF3;0033
A7AB;0033
021C;0033
01B7;0033
A76A;0033
2C9C;0033
2CC4;0033
2CCC;0033
0417;0033
04E0;0033
16F3B;0033
118CA;0033
06F3;0663
1E8C9;0663
2462;2782
0498;0033 0326
1F104;0033 002C
248A;0033 002E
33FE;0033 006C 65E5
33FD;0033 004F 65E5
33E2;0033 65E5
32C2;0033 6708
335B;0033 70B9
1CCF4;0034
1D7D2;0034
1D7DC;0034
1D7E6;0034
1D7F0;0034
1D7FA;0034
1FBF4;0034
13CE;0034
118AF;0034
06F4;0664
0AEA;096A
2463;2783
1F105;0034 002C
248B;0034 002E
1530;0034 00B7
33E3;0034 65E5
32C3;0034 6708
335C;0034 70B9
1CCF5;0035
1D7D3;0035
1D7DD;0035
1D7E7;0035
1D7F1;0035
1D7FB;0035
1FBF5;0035
01BC;0035
118BB;0035
2464;2784
1F106;0035 002C
248C;0035 002E
33E4;0035 65E5
32C4;0035 6708
335D;0035 70B9
1CCF6;0036
1D7D4;0036
1D7DE;0036
1D7E8;0036
1D7F2;0036
1D7FC;0036
1FBF6;0036
2CD3;0036
2CD2;0036
03EC;0036
2CDC;0036
0431;0036
13EE;0036
118D5;0036
06F6;0666
114D6;09EC
2465;2785
1F107;0036 002C
248D;0036 002E
33E5;0036 65E5
32C5;0036 6708
335E;0036 70B9
1D212;0037
1CCF7;0037
1D7D5;0037
1D7DF;0037
1D7E9;0037
1D7F3;0037
1D7FD;0037
1FBF7;0037
104D2;0037
118C6;0037
2466;2786
1F108;0037 002C
248E;0037 002E
33E6;0037 65E5
32C6;0037 6708
335F;0037 70B9
0B03;0038
09EA;0038
0A6A;0038
1E8CB;0038
1CCF8;0038
1D7D6;0038
1D7E0;0038
1D7EA;0038
1D7F4;0038
1D7FE;0038
1FBF8;0038
0223;0038
0222;0038
1031A;0038
0AEE;096E
2467;2787
1F109;0038 002C
248F;0038 002E
33E7;0038 65E5
32C7;0038 6708
3360;0038 70B9
0A67;0039
0B68;0039
09ED;0039
0D6D;0039
1CCF9;0039
1D7D7;0039
1D7E1;0039
1D7EB;0039
1D7F5;0039
1D7FF;0039
1FBF9;0039
A76E;0039
2CCB;0039
2CCA;0039
118CC;0039
118AC;0039
118D6;0039
0967;0669
118E4;0669
06F9;0669
0CEF;0C6F
2468;2788
1F10A;0039 002C
2490;0039 002E
33E8;0039 65E5
32C8;0039 6708
3361;0039 70B9
237A;0061
FF41;0061
1D41A;0061
1D44E;0061
1D482;0061
1D4B6;0061
1D4EA;0061
1D51E;0061
1D552;0061
1D586;0061
1D5BA;0061
1D5EE;0061
1D622;0061
1D656;0061
1D68A;0061
0251;0061
03B1;0061
1D6C2;0061
1D6FC;0061
1D736;0061
1D770;0061
1D7AA;0061
0430;0061
2DF6;0363
FF21;0041
1CCD6;0041
1D400;0041
1D434;0041
1D468;0041
1D49C;0041
1D4D0;0041
1D504;0041
1D538;0041
1D56C;0041
1D5A0;0041
1D5D4;0041
1D608;0041
1D63C;0041
1D670;0041
0391;0041
1D6A8;0041
1D6E2;0041
1D71C;0041
1D756;0041
1D790;0041
0410;0041
13AA;0041
15C5;0041
A4EE;0041
16F40;0041
102A0;0041
2376;0061 0332
01CE;0103
01CD;0102
0227;00E5
0226;00C5
1E9A;1EA3
2100;0061 002F 0063
2101;0061 002F 0073
A733;0061 0061
A732;0041 0041
00E6;0061 0065
04D5;0061 0065
00C6;0041 0045
04D4;0041 0045
A735;0061 006F
A734;0041 004F
1F707;0041 0052
A737;0061 0075
A736;0041 0055
A739;0061 0076
A73B;0061 0076
A738;0041 0056
A73A;0041 0056
A73D;0061 0079
A73C;0041 0059
AB7A;1D00
2200;2C6F
1D217;2C6F
15C4;2C6F
A4EF;2C6F
1041F;2C70
1D41B;0062
1D44F;0062
1D483;0062
1D4B7;0062
1D4EB;0062
1D51F;0062
1D553;0062
1D587;0062
1D5BB;0062
1D5EF;0062
1D623;0062
1D657;0062
1D68B;0062
0184;0062
042C;0062
13CF;0062
1472;0062
15AF;0062
16EB6;0062
FF22;0042
212C;0042
1CCD7;0042
1D401;0042
1D435;0042
1D469;0042
1D4D1;0042
1D505;0042
1D539;0042
1D56D;0042
1D5A1;0042
1D5D5;0042
1D609;0042
1D63D;0042
1D671;0042
A7B4;0042
0392;0042
1D6A9;0042
1D6E3;0042
1D71D;0042
1D757;0042
1D791;0042
2C82;0042
0412;0042
13F4;0042
15F7;0042
A4D0;0042
10282;0042
102A1;0042
10301;0042
0253;0062 0314
1473;0062 0307
0183;0062 0304
0182;0062 0304
0411;0062 0304
0180;0062 0335
048D;0062 0335
048C;0062 0335
0463;0062 0335
0462;0062 0335
147F;0062 00B7
1481;0062 0307 00B7
1488;0062 0027
042B;0062 006C
2C83;0299
0432;0299
13FC;0299
FF43;0063
217D;0063
1D41C;0063
1D450;0063
1D484;0063
1D4B8;0063
1D4EC;0063
1D520;0063
1D554;0063
1D588;0063
1D5BC;0063
1D5F0;0063
1D624;0063
1D658;0063
1D68C;0063
1D04;0063
03F2;0063
2CA5;0063
0441;0063
1004;0063
105A;0063
ABAF;0063
1043D;0063
2DED;0368
1F74C;0043
118E9;0043
118F2;0043
FF23;0043
216D;0043
2102;0043
212D;0043
1CCD8;0043
1D402;0043
1D436;0043
1D46A;0043
1D49E;0043
1D4D2;0043
1D56E;0043
1D5A2;0043
1D5D6;0043
1D60A;0043
1D63E;0043
1D672;0043
03F9;0043
2CA4;0043
0421;0043
13DF;0043
A4DA;0043
102A2;0043
10302;0043
10415;0043
1051C;0043
00A2;0063 0338
023C;0063 0338
20A1;0043 20EB
1F16E;0043 20E0
00E7;0063 0326
04AB;0063 0326
00C7;0043 0326
04AA;0043 0326
0187;0043 0027
2105;0063 002F 006F
2106;0063 002F 0075
1F16D;33C4 0009 20DD
22F4;A793
025B;A793
03B5;A793
03F5;A793
1D6C6;A793
1D6DC;A793
1D700;A793
1D716;A793
1D73A;A793
1D750;A793
1D774;A793
1D78A;A793
1D7AE;A793
1D7C4;A793
2C89;A793
0454;A793
0511;A793
AB9B;A793
118CE;A793
10429;A793
20AC;A792
2C88;A792
0404;A792
2377;A793 0332
037D;A73F
03FF;A73E
217E;0064
2146;0064
1D41D;0064
1D451;0064
1D485;0064
1D4B9;0064
1D4ED;0064
1D521;0064
1D555;0064
1D589;0064
1D5BD;0064
1D5F1;0064
1D625;0064
1D659;0064
1D68D;0064
0501;0064
13E7;0064
146F;0064
A4D2;0064
216E;0044
2145;0044
1CCD9;0044
1D403;0044
1D437;0044
1D46B;0044
1D49F;0044
1D4D3;0044
1D507;0044
1D53B;0044
1D56F;0044
1D5A3;0044
1D5D7;0044
1D60B;0044
1D63F;0044
1D673;0044
13A0;0044
15DE;0044
15EA;0044
A4D3;0044
0257;0064 0314
0256;0064 0328
018C;0064 0304
0111;0064 0335
0110;0044 0335
00D0;0044 0335
0189;0044 0335
20AB;0064 0335 0331
A77A;A779
147B;0064 00B7
1487;0064 0027
02A4;0064 021D
01F3;0064 007A
02A3;0064 007A
01F2;0044 007A
01F1;0044 005A
01C6;0064 017E
01C5;0044 017E
01C4;0044 017D
02A5;0064 0291
AB70;1D05
2E39;1E9F
03B4;1E9F
1D6C5;1E9F
1D6FF;1E9F
1D739;1E9F
1D773;1E9F
1D7AD;1E9F
2CDD;1E9F
056E;1E9F
1577;1E9F
212E;0065
FF45;0065
212F;0065
2147;0065
1D41E;0065
1D452;0065
1D486;0065
1D4EE;0065
1D522;0065
1D556;0065
1D58A;0065
1D5BE;0065
1D5F2;0065
1D626;0065
1D65A;0065
1D68E;0065
AB32;0065
0435;0065
04BD;0065
2DF7;0364
22FF;0045
FF25;0045
2130;0045
1CCDA;0045
1D404;0045
1D438;0045
1D46C;0045
1D4D4;0045
1D508;0045
1D53C;0045
1D570;0045
1D5A4;0045
1D5D8;0045
1D60C;0045
1D640;0045
1D674;0045
0395;0045
1D6AC;0045
1D6E6;0045
1D720;0045
1D75A;0045
1D794;0045
0415;0045
2D39;0045
13AC;0045
A4F0;0045
118A6;0045
118AE;0045
10286;0045
011B;0115
011A;0114
0247;0065 0338
0246;0045 0338
04BF;0065 0328
AB7C;1D07
0259;01DD
04D9;01DD
2203;018E
2D3A;018E
A4F1;018E
025A;01DD 02DE
1D14;01DD 006F
AB41;01DD 006F 0338
AB42;01DD 006F 0335
04D8;018F
1D221;0190
2107;0190
0510;0190
13CB;0190
16F2D;0190
10401;0190
1D9F;1D4B
1D08;025C
0437;025C
0499;025C 0326
10442;025E
A79D;029A
1042A;029A
1D41F;0066
1D453;0066
1D487;0066
1D4BB;0066
1D4EF;0066
1D523;0066
1D557;0066
1D58B;0066
1D5BF;0066
1D5F3;0066
1D627;0066
1D65B;0066
1D68F;0066
AB35;0066
A799;0066
0192;0066
017F;0066
1E9D;0066
0584;0066
1D213;0046
2131;0046
1CCDB;0046
1D405;0046
1D439;0046
1D46D;0046
1D4D5;0046
1D509;0046
1D53D;0046
1D571;0046
1D5A5;0046
1D5D9;0046
1D60D;0046
1D641;0046
1D675;0046
A798;0046
03DC;0046
1D7CA;0046
15B4;0046
A4DD;0046
118C2;0046
118A2;0046
10287;0046
102A5;0046
10525;0046
0191;0046 0326
1D6E;0066 0334
213B;0046 0041 0058
FB00;0066 0066
FB03;0066 0066 0069
FB04;0066 0066 006C
FB01;0066 0069
FB02;0066 006C
02A9;0066 006E 0329
15B5;2132
A4DE;2132
1D230;A7FB
15B7;A7FB
FF47;0067
210A;0067
1D420;0067
1D454;0067
1D488;0067
1D4F0;0067
1D524;0067
1D558;0067
1D58C;0067
1D5C0;0067
1D5F4;0067
1D628;0067
1D65C;0067
1D690;0067
0261;0067
1D83;0067
018D;0067
0581;0067
1CCDC;0047
1D406;0047
1D43A;0047
1D46E;0047
1D4A2;0047
1D4D6;0047
1D50A;0047
1D53E;0047
1D572;0047
1D5A6;0047
1D5DA;0047
1D60E;0047
1D642;0047
1D676;0047
050C;0047
13C0;0047
13F3;0047
A4D6;0047
1DA2;1D4D
0260;0067 0314
01E7;011F
01E6;011E
01F5;0123
01E5;0067 0335
01E4;0047 0335
0193;0047 0027
050D;0262
AB90;0262
13FB;0262
FF48;0068
210E;0068
1D421;0068
1D489;0068
1D4BD;0068
1D4F1;0068
1D525;0068
1D559;0068
1D58D;0068
1D5C1;0068
1D5F5;0068
1D629;0068
1D65D;0068
1D691;0068
04BB;0068
0570;0068
13C2;0068
FF28;0048
210B;0048
210C;0048
210D;0048
1CCDD;0048
1D407;0048
1D43B;0048
1D46F;0048
1D4D7;0048
1D573;0048
1D5A7;0048
1D5DB;0048
1D60F;0048
1D643;0048
1D677;0048
0397;0048
1D6AE;0048
1D6E8;0048
1D722;0048
1D75C;0048
1D796;0048
2C8E;0048
041D;0048
13BB;0048
157C;0048
A4E7;0048
102CF;0048
1D78;1D34
0266;0068 0314
A695;0068 0314
13F2;0068 0314
2C67;0048 0329
04A2;0048 0329
0127;0068 0335
210F;0068 0335
045B;0068 0335
0126;0048 0335
04C9;0048 0326
04C7;0048 0326
2C8F;029C
043D;029C
AB8B;029C
04A3;029C 0329
04CA;029C 0326
04C8;029C 0326
050A;01F6
AB80;2C76
0370;2C75
13A8;2C75
13B0;2C75
A6B1;2C75
A795;A727
02DB;0069
2373;0069
FF49;0069
2170;0069
2139;0069
2148;0069
1D422;0069
1D456;0069
1D48A;0069
1D4BE;0069
1D4F2;0069
1D526;0069
1D55A;0069
1D58E;0069
1D5C2;0069
1D5F6;0069
1D62A;0069
1D65E;0069
1D692;0069
0131;0069
1D6A4;0069
026A;0069
0269;0069
03B9;0069
1FBE;0069
037A;0069
1D6CA;0069
1D704;0069
1D73E;0069
1D778;0069
1D7B2;0069
2C93;0069
0456;0069
A647;0069
0582;0069
AB75;0069
13A5;0069
118C3;0069
24DB;24BE
2378;0069 0332
01D0;012D
01CF;012C
0268;0069 0335
1D7B;0069 0335
1D7C;0069 0335
2171;0069 0069
2172;0069 0069 0069
0133;0069 006A
2173;0069 0076
2178;0069 0078
FF4A;006A
2149;006A
1D423;006A
1D457;006A
1D48B;006A
1D4BF;006A
1D4F3;006A
1D527;006A
1D55B;006A
1D58F;006A
1D5C3;006A
1D5F7;006A
1D62B;006A
1D65F;006A
1D693;006A
03F3;006A
0458;006A
FF2A;004A
1CCDF;004A
1D409;004A
1D43D;004A
1D471;004A
1D4A5;004A
1D4D9;004A
1D50D;004A
1D541;004A
1D575;004A
1D5A9;004A
1D5DD;004A
1D611;004A
1D645;004A
1D679;004A
A7B2;004A
037F;004A
0408;004A
13AB;004A
148D;004A
A4D9;004A
0249;006A 0335
0248;004A 0335
1499;004A 00B7
1D6A5;0237
0575;0237
AB7B;1D0A
1D424;006B
1D458;006B
1D48C;006B
1D4C0;006B
1D4F4;006B
1D528;006B
1D55C;006B
1D590;006B
1D5C4;006B
1D5F8;006B
1D62C;006B
1D660;006B
1D694;006B
212A;004B
FF2B;004B
1CCE0;004B
1D40A;004B
1D43E;004B
1D472;004B
1D4A6;004B
1D4DA;004B
1D50E;004B
1D542;004B
1D576;004B
1D5AA;004B
1D5DE;004B
1D612;004B
1D646;004B
1D67A;004B
039A;004B
1D6B1;004B
1D6EB;004B
1D725;004B
1D75F;004B
1D799;004B
2C94;004B
041A;004B
13E6;004B
16D5;004B
A4D7;004B
10518;004B
0199;006B 0314
2C69;004B 0329
049A;004B 0329
20AD;004B 0335
A740;004B 0335
049E;004B 0335
0198;004B 0027
05C0;006C
007C;006C
2223;006C
23FD;006C
FFE8;006C
0031;006C
0661;006C
06F1;006C
10320;006C
1E8C7;006C
1CCF1;006C
1D7CF;006C
1D7D9;006C
1D7E3;006C
1D7ED;006C
1D7F7;006C
1FBF1;006C
0049;006C
FF29;006C
2160;006C
2110;006C
2111;006C
1CCDE;006C
1D408;006C
1D43C;006C
1D470;006C
1D4D8;006C
1D540;006C
1D574;006C
1D5A8;006C
1D5DC;006C
1D610;006C
1D644;006C
1D678;006C
0196;006C
FF4C;006C
217C;006C
2113;006C
1D425;006C
1D459;006C
1D48D;006C
1D4C1;006C
1D4F5;006C
1D529;006C
1D55D;006C
1D591;006C
1D5C5;006C
1D5F9;006C
1D62D;006C
1D661;006C
1D695;006C
01C0;006C
0399;006C
1D6B0;006C
1D6EA;006C
1D724;006C
1D75E;006C
1D798;006C
2C92;006C
0406;006C
04CF;006C
04C0;006C
05D5;006C
05DF;006C
0627;006C
1EE00;006C
1EE80;006C
FE8E;006C
FE8D;006C
07CA;006C
2D4F;006C
16C1;006C
A4F2;006C
16F28;006C
1028A;006C
10309;006C
11DDA;006C
11DE1;006C
16EAA;006C
1D22A;004C
216C;004C
2112;004C
1CCE1;004C
1D40B;004C
1D43F;004C
1D473;004C
1D4DB;004C
1D50F;004C
1D543;004C
1D577;004C
1D5AB;004C
1D5DF;004C
1D613;004C
1D647;004C
1D67B;004C
2CD0;004C
13DE;004C
14AA;004C
A4E1;004C
16F16;004C
118A3;004C
118B2;004C
1041B;004C
10526;004C
FD3C;006C 030B
FD3D;006C 030B
0142;006C 0338
0141;004C 0338
026D;006C 0328
0197;006C 0335
019A;006C 0335
026B;006C 0334
0625;006C 0655
FE88;006C 0655
FE87;006C 0655
0673;006C 0655
0140;006C 00B7
013F;006C 00B7
14B7;006C 00B7
1F102;006C 002C
2488;006C 002E
05F1;006C 0027
2493;006C 0032 002E
33EB;006C 0032 65E5
32CB;006C 0032 6708
3364;006C 0032 70B9
2494;006C 0033 002E
33EC;006C 0033 65E5
3365;006C 0033 70B9
2495;006C 0034 002E
33ED;006C 0034 65E5
3366;006C 0034 70B9
2496;006C 0035 002E
33EE;006C 0035 65E5
3367;006C 0035 70B9
2497;006C 0036 002E
33EF;006C 0036 65E5
3368;006C 0036 70B9
2498;006C 0037 002E
33F0;006C 0037 65E5
3369;006C 0037 70B9
2499;006C 0038 002E
33F1;006C 0038 65E5
336A;006C 0038 70B9
249A;006C 0039 002E
33F2;006C 0039 65E5
336B;006C 0039 70B9
01C9;006C 006A
0132;006C 004A
01C8;004C 006A
01C7;004C 004A
2016;006C 006C
2225;006C 006C
2161;006C 006C
01C1;006C 006C
05F0;006C 006C
10199;006C 0335 006C 0335
2492;006C 006C 002E
2162;006C 006C 006C
10198;006C 0335 006C 0335 0053 0335
33EA;006C 006C 65E5
32CA;006C 006C 6708
3363;006C 006C 70B9
042E;006C 004F
2491;006C 004F 002E
33E9;006C 004F 65E5
32C9;006C 004F 6708
3362;006C 004F 70B9
02AA;006C 0073
20B6;006C 0074
2163;006C 0056
2168;006C 0058
026E;006C 021D
02AB;006C 007A
0675;006C 0674
0623;006C 0674
FE84;006C 0674
FE83;006C 0674
0672;006C 0674
FDF3;006C 0643 0628 0631
FDF2;006C 0644 0644 0651 0670 006F
33E0;006C 65E5
32C0;006C 6708
3359;006C 70B9
2CD1;029F
ABAE;029F
10443;029F
FF2D;004D
216F;004D
2133;004D
1CCE2;004D
1D40C;004D
1D440;004D
1D474;004D
1D4DC;004D
1D510;004D
1D544;004D
1D578;004D
1D5AC;004D
1D5E0;004D
1D614;004D
1D648;004D
1D67C;004D
039C;004D
1D6B3;004D
1D6ED;004D
1D727;004D
1D761;004D
1D79B;004D
03FA;004D
2C98;004D
041C;004D
13B7;004D
15F0;004D
16D6;004D
A4DF;004D
102B0;004D
10311;004D
04CD;004D 0326
1F76B;004D 0042
2DE8;1DDF
1D427;006E
1D45B;006E
1D48F;006E
1D4C3;006E
1D4F7;006E
1D52B;006E
1D55F;006E
1D593;006E
1D5C7;006E
1D5FB;006E
1D62F;006E
1D663;006E
1D697;006E
0578;006E
057C;006E
FF2E;004E
2115;004E
1CCE3;004E
1D40D;004E
1D441;004E
1D475;004E
1D4A9;004E
1D4DD;004E
1D511;004E
1D579;004E
1D5AD;004E
1D5E1;004E
1D615;004E
1D649;004E
1D67D;004E
039D;004E
1D6B4;004E
1D6EE;004E
1D728;004E
1D762;004E
1D79C;004E
2C9A;004E
A4E0;004E
10513;004E
1018E;004E 030A
0273;006E 0328
019E;006E 0329
014B;006E 0329
03B7;006E 0329
1D6C8;006E 0329
1D702;006E 0329
1D73C;006E 0329
1D776;006E 0329
1D7B0;006E 0329
0572;006E 0329
019D;004E 0326
1D70;006E 0334
01CC;006E 006A
01CB;004E 006A
01CA;004E 004A
2116;004E 006F
2C9B;0274
0377;1D0E
0438;1D0E
1044D;1D0E
0146;0272
0C02;006F
0C82;006F
0D02;006F
0D82;006F
0966;006F
09E6;006F
0A66;006F
0AE6;006F
0B66;006F
0BE6;006F
0C66;006F
0D66;006F
0E50;006F
0ED0;006F
1040;006F
17E0;006F
114D0;006F
0665;006F
06F5;006F
FF4F;006F
2134;006F
1D428;006F
1D45C;006F
1D490;006F
1D4F8;006F
1D52C;006F
1D560;006F
1D594;006F
1D5C8;006F
1D5FC;006F
1D630;006F
1D664;006F
1D698;006F
1D0F;006F
1D11;006F
AB3D;006F
03BF;006F
1D6D0;006F
1D70A;006F
1D744;006F
1D77E;006F
1D7B8;006F
03C3;006F
1D6D4;006F
1D70E;006F
1D748;006F
1D782;006F
1D7BC;006F
2C9F;006F
03ED;006F
043E;006F
10FF;006F
0585;006F
05E1;006F
0647;006F
1EE24;006F
1EE64;006F
1EE84;006F
FEEB;006F
FEEC;006F
FEEA;006F
FEE9;006F
06BE;006F
FBAC;006F
FBAD;006F
FBAB;006F
FBAA;006F
06C1;006F
FBA8;006F
FBA9;006F
FBA7;006F
FBA6;006F
06D5;006F
0D20;006F
101D;006F
104EA;006F
118C8;006F
118D7;006F
1042C;006F
0030;004F
07C0;004F
0CE6;004F
3007;004F
118E0;004F
1CCF0;004F
1D7CE;004F
1D7D8;004F
1D7E2;004F
1D7EC;004F
1D7F6;004F
1FBF0;004F
FF2F;004F
1CCE4;004F
1D40E;004F
1D442;004F
1D476;004F
1D4AA;004F
1D4DE;004F
1D512;004F
1D546;004F
1D57A;004F
1D5AE;004F
1D5E2;004F
1D616;004F
1D64A;004F
1D67E;004F
039F;004F
1D6B6;004F
1D6F0;004F
1D72A;004F
1D764;004F
1D79E;004F
2C9E;004F
041E;004F
0555;004F
2D54;004F
12D0;004F
0B20;004F
104C2;004F
A4F3;004F
118B5;004F
10292;004F
102AB;004F
10404;004F
10516;004F
11DE0;004F
2070;00BA
1D52;00BA
01D2;014F
01D1;014E
06FF;006F 0302
0150;00D6
00F8;006F 0338
AB3E;006F 0338
00D8;004F 0338
2D41;004F 0338
01FE;004F 0338 0301
0275;006F 0335
A74B;006F 0335
2C91;006F 0335
04E9;006F 0335
0473;006F 0335
AB8E;006F 0335
ABBB;006F 0335
2296;004F 0335
229D;004F 0335
236C;004F 0335
1D21A;004F 0335
1F714;004F 0335
019F;004F 0335
A74A;004F 0335
03B8;004F 0335
03D1;004F 0335
1D6C9;004F 0335
1D6DD;004F 0335
1D703;004F 0335
1D717;004F 0335
1D73D;004F 0335
1D751;004F 0335
1D777;004F 0335
1D78B;004F 0335
1D7B1;004F 0335
1D7C5;004F 0335
0398;004F 0335
03F4;004F 0335
1D6AF;004F 0335
1D6B9;004F 0335
1D6E9;004F 0335
1D6F3;004F 0335
1D723;004F 0335
1D72D;004F 0335
1D75D;004F 0335
1D767;004F 0335
1D797;004F 0335
1D7A1;004F 0335
2C90;004F 0335
04E8;004F 0335
0472;004F 0335
2D31;004F 0335
13BE;004F 0335
13EB;004F 0335
AB74;006F 031B
FCD9;006F 0670
1F101;004F 002C
1F100;004F 002E
01A1;006F 0027
01A0;004F 0027
13A4;004F 0027
0025;00BA 002F 2080
066A;00BA 002F 2080
2052;00BA 002F 2080
2030;00BA 002F 2080 2080
0609;00BA 002F 2080 2080
2031;00BA 002F 2080 2080 2080
060A;00BA 002F 2080 2080 2080
0153;006F 0065
0152;004F 0045
0276;006F 1D07
221E;006F 006F
A74F;006F 006F
A699;006F 006F
A74E;004F 004F
A698;004F 004F
FCD7;006F 062C
FC51;006F 062C
FCD8;006F 0645
FC52;006F 0645
FD93;006F 0645 062C
FD94;006F 0645 0645
FC53;006F 0649
FC54;006F 0649
0D5F;006F 0D30 006F
10D7;006F 102C
1010;006F 102C
3358;004F 70B9
2184;0254
1D10;0254
037B;0254
1044B;0254
2183;0186
03FD;0186
A4DB;0186
10423;0186
AB3F;0254 0338
AB62;0254 0065
1043F;0277
2374;0070
FF50;0070
1D429;0070
1D45D;0070
1D491;0070
1D4C5;0070
1D4F9;0070
1D52D;0070
1D561;0070
1D595;0070
1D5C9;0070
1D5FD;0070
1D631;0070
1D665;0070
1D699;0070
00FE;0070
01BF;0070
03C1;0070
03F1;0070
1D6D2;0070
1D6E0;0070
1D70C;0070
1D71A;0070
1D746;0070
1D754;0070
1D780;0070
1D78E;0070
1D7BA;0070
1D7C8;0070
03F8;0070
2CA3;0070
2CCF;0070
0440;0070
FF30;0050
2119;0050
1CCE5;0050
1D40F;0050
1D443;0050
1D477;0050
1D4AB;0050
1D4DF;0050
1D513;0050
1D57B;0050
1D5AF;0050
1D5E3;0050
1D617;0050
1D64B;0050
1D67F;0050
03A1;0050
1D6B8;0050
1D6F2;0050
1D72C;0050
1D766;0050
1D7A0;0050
2CA2;0050
2CCE;0050
0420;0050
13E2;0050
146D;0050
A4D1;0050
10295;0050
01A5;0070 0314
1D7D;0070 0335
1477;0070 00B7
1486;0050 0027
1D29;1D18
ABB2;1D18
03C6;0278
03D5;0278
1D6D7;0278
1D6DF;0278
1D711;0278
1D719;0278
1D74B;0278
1D753;0278
1D785;0278
1D78D;0278
1D7BF;0278
1D7C7;0278
2CAB;0278
2CE1;0278
2CE0;0278
0444;0278
1D42A;0071
1D45E;0071
1D492;0071
1D4C6;0071
1D4FA;0071
1D52E;0071
1D562;0071
1D596;0071
1D5CA;0071
1D5FE;0071
1D632;0071
1D666;0071
1D69A;0071
051B;0071
0563;0071
0566;0071
211A;0051
1CCE6;0051
1D410;0051
1D444;0051
1D478;0051
1D4AC;0051
1D4E0;0051
1D514;0051
1D57C;0051
1D5B0;0051
1D5E4;0051
1D618;0051
1D64C;0051
1D680;0051
2D55;0051
02A0;0071 0314
1F700;0051 0045
1D90;024B
1D0B;0138
03BA;0138
03F0;0138
1D6CB;0138
1D6DE;0138
1D705;0138
1D718;0138
1D73F;0138
1D752;0138
1D779;0138
1D78C;0138
1D7B3;0138
1D7C6;0138
2C95;0138
043A;0138
ABB6;0138
049B;0138 0329
049F;0138 0335
1D42B;0072
1D45F;0072
1D493;0072
1D4C7;0072
1D4FB;0072
1D52F;0072
1D563;0072
1D597;0072
1D5CB;0072
1D5FF;0072
1D633;0072
1D667;0072
1D69B;0072
AB47;0072
AB48;0072
1D26;0072
2C85;0072
0433;0072
AB81;0072
1D216;0052
211B;0052
211C;0052
211D;0052
1CCE7;0052
1D411;0052
1D445;0052
1D479;0052
1D4E1;0052
1D57D;0052
1D5B1;0052
1D5E5;0052
1D619;0052
1D64D;0052
1D681;0052
01A6;0052
13A1;0052
13D2;0052
104B4;0052
1587;0052
A4E3;0052
16F35;0052
027D;0072 0328
027C;0072 0329
024D;0072 0335
0493;0072 0335
1D72;0072 0334
0491;0072 0027
118E3;0072 006E
006D;0072 006E
217F;0072 006E
1D426;0072 006E
1D45A;0072 006E
1D48E;0072 006E
1D4C2;0072 006E
1D4F6;0072 006E
1D52A;0072 006E
1D55E;0072 006E
1D592;0072 006E
1D5C6;0072 006E
1D5FA;0072 006E
1D62E;0072 006E
1D662;0072 006E
1D696;0072 006E
11700;0072 006E
20A5;0072 006E 0338
0271;0072 006E 0326
1D6F;0072 006E 0334
20A8;0052 0073
AB71;0280
ABA2;0280
044F;1D19
1D73;027E 0334
2129;027F
FF53;0073
1D42C;0073
1D460;0073
1D494;0073
1D4C8;0073
1D4FC;0073
1D530;0073
1D564;0073
1D598;0073
1D5CC;0073
1D600;0073
1D634;0073
1D668;0073
1D69C;0073
A731;0073
01BD;0073
0455;0073
0D1F;0073
ABAA;0073
118C1;0073
10448;0073
FF33;0053
1CCE8;0053
1D412;0053
1D446;0053
1D47A;0053
1D4AE;0053
1D4E2;0053
1D516;0053
1D54A;0053
1D57E;0053
1D5B2;0053
1D5E6;0053
1D61A;0053
1D64E;0053
1D682;0053
0405;0053
054F;0053
13D5;0053
13DA;0053
A4E2;0053
16F3A;0053
10296;0053
10420;0053
0282;0073 0328
1D74;0073 0334
A7B5;00DF
1E9E;00DF
A7D6;00DF
03B2;00DF
03D0;00DF
1D6C3;00DF
1D6FD;00DF
1D737;00DF
1D771;00DF
1D7AB;00DF
13F0;00DF
1F75C;0073 0073 0073
FB06;0073 0074
222B;0283
AB4D;0283
2211;01A9
2140;01A9
03A3;01A9
1D6BA;01A9
1D6F4;01A9
1D72E;01A9
1D768;01A9
1D7A2;01A9
2D49;01A9
222C;0283 0283
222D;0283 0283 0283
2A0C;0283 0283 0283 0283
1D42D;0074
1D461;0074
1D495;0074
1D4C9;0074
1D4FD;0074
1D531;0074
1D565;0074
1D599;0074
1D5CD;0074
1D601;0074
1D635;0074
1D669;0074
1D69D;0074
22A4;0054
27D9;0054
1F768;0054
FF34;0054
1CCE9;0054
1D413;0054
1D447;0054
1D47B;0054
1D4AF;0054
1D4E3;0054
1D517;0054
1D54B;0054
1D57F;0054
1D5B3;0054
1D5E7;0054
1D61B;0054
1D64F;0054
1D683;0054
03A4;0054
1D6BB;0054
1D6F5;0054
1D72F;0054
1D769;0054
1D7A3;0054
2CA6;0054
0422;0054
13A2;0054
A4D4;0054
16F0A;0054
118BC;0054
10297;0054
102B1;0054
10315;0054
01AD;0074 0314
2361;0054 0308
023E;0054 0338
021A;0162
01AE;0054 0328
04AC;0054 0329
20AE;0054 20EB
0167;0074 0335
0166;0054 0335
1D75;0074 0334
10A0;A786
A728;0054 0033
02A8;0074 0255
2121;0054 0045 004C
A777;0074 0066
02A6;0074 0073
02A7;0074 0283
A729;0074 021D
03C4;1D1B
1D6D5;1D1B
1D70F;1D1B
1D749;1D1B
1D783;1D1B
1D7BD;1D1B
2CA7;1D1B
0442;1D1B
AB72;1D1B
04AD;1D1B 0329
0163;01AB
021B;01AB
13BF;01AB
1D42E;0075
1D462;0075
1D496;0075
1D4CA;0075
1D4FE;0075
1D532;0075
1D566;0075
1D59A;0075
1D5CE;0075
1D602;0075
1D636;0075
1D66A;0075
1D69E;0075
A79F;0075
1D1C;0075
AB4E;0075
AB52;0075
028B;0075
03C5;0075
1D6D6;0075
1D710;0075
1D74A;0075
1D784;0075
1D7BE;0075
057D;0075
104F6;0075
118D8;0075
222A;0055
22C3;0055
1CCEA;0055
1D414;0055
1D448;0055
1D47C;0055
1D4B0;0055
1D4E4;0055
1D518;0055
1D54C;0055
1D580;0055
1D5B4;0055
1D5E8;0055
1D61C;0055
1D650;0055
1D684;0055
054D;0055
1200;0055
104CE;0055
144C;0055
A4F4;0055
16F42;0055
118B8;0055
01D4;016D
01D3;016C
045F;0075 0329
1D7E;0075 0335
AB9C;0075 0335
0244;0055 0335
13CC;0055 0335
1458;0055 00B7
1467;0055 0027
1D6B;0075 0065
AB63;0075 006F
1E43;AB51
057A;0270
1223;0270
2127;01B1
162E;01B1
1634;01B1
1D7F;028A 0335
2228;0076
22C1;0076
FF56;0076
2174;0076
1D42F;0076
1D463;0076
1D497;0076
1D4CB;0076
1D4FF;0076
1D533;0076
1D567;0076
1D59B;0076
1D5CF;0076
1D603;0076
1D637;0076
1D66B;0076
1D69F;0076
1D20;0076
03BD;0076
1D6CE;0076
1D708;0076
1D742;0076
1D77C;0076
1D7B6;0076
0475;0076
05D8;0076
11706;0076
ABA9;0076
118C0;0076
1D20D;0056
0667;0056
06F7;0056
2164;0056
1CCEB;0056
1D415;0056
1D449;0056
1D47D;0056
1D4B1;0056
1D4E5;0056
1D519;0056
1D54D;0056
1D581;0056
1D5B5;0056
1D5E9;0056
1D61D;0056
1D651;0056
1D685;0056
0474;0056
2D38;0056
13D9;0056
142F;0056
A6DF;0056
A4E6;0056
16F08;0056
118A0;0056
1051D;0056
10197;0056 0335
143B;0056 00B7
1F76C;0056 0042
2175;0076 0069
2176;0076 0069 0069
2177;0076 0069 0069 0069
2165;0056 006C
2166;0056 006C 006C
2167;0056 006C 006C 006C
1F708;0056 1DE4
1D27;028C
2C97;028C
104D8;028C
0668;0245
06F8;0245
A7DA;0245
039B;0245
1D6B2;0245
1D6EC;0245
1D726;0245
1D760;0245
1D79A;0245
041B;0245
2D37;0245
104B0;0245
1431;0245
A6CE;0245
A4E5;0245
16F3D;0245
1028D;0245
A7DC;0245 0338
04C5;0245 0326
143D;0245 00B7
026F;0077
1D430;0077
1D464;0077
1D498;0077
1D4CC;0077
1D500;0077
1D534;0077
1D568;0077
1D59C;0077
1D5D0;0077
1D604;0077
1D638;0077
1D66C;0077
1D6A0;0077
1D21;0077
2CBD;0077
0461;0077
0448;0077
051D;0077
0561;0077
1170A;0077
1170E;0077
1170F;0077
AB83;0077
118E6;0057
118EF;0057
1CCEC;0057
1D416;0057
1D44A;0057
1D47E;0057
1D4B2;0057
1D4E6;0057
1D51A;0057
1D54E;0057
1D582;0057
1D5B6;0057
1D5EA;0057
1D61E;0057
1D652;0057
1D686;0057
051C;0057
13B3;0057
13D4;0057
A4EA;0057
047D;0077 0486 0487
114C5;0077 0307
20A9;0057 0335
A761;0077 0326
1D0D;028D
2C99;028D
043C;028D
AB87;028D
04CE;028D 0326
166E;0078
00D7;0078
292B;0078
292C;0078
2A2F;0078
FF58;0078
2179;0078
1D431;0078
1D465;0078
1D499;0078
1D4CD;0078
1D501;0078
1D535;0078
1D569;0078
1D59D;0078
1D5D1;0078
1D605;0078
1D639;0078
1D66D;0078
1D6A1;0078
0445;0078
1541;0078
157D;0078
2DEF;036F
166D;0058
2573;0058
10322;0058
118EC;0058
FF38;0058
2169;0058
1CCED;0058
1D417;0058
1D44B;0058
1D47F;0058
1D4B3;0058
1D4E7;0058
1D51B;0058
1D54F;0058
1D583;0058
1D5B7;0058
1D5EB;0058
1D61F;0058
1D653;0058
1D687;0058
A7B3;0058
03A7;0058
1D6BE;0058
1D6F8;0058
1D732;0058
1D76C;0058
1D7A6;0058
2CAC;0058
0425;0058
2D5D;0058
16B7;0058
A4EB;0058
10290;0058
102B4;0058
10317;0058
10527;0058
2A30;0078 0307
04B2;0058 0329
10196;0058 0335
217A;0078 0069
217B;0078 0069 0069
216A;0058 006C
216B;0058 006C 006C
0263;0079
1D8C;0079
FF59;0079
1D432;0079
1D466;0079
1D49A;0079
1D4CE;0079
1D502;0079
1D536;0079
1D56A;0079
1D59E;0079
1D5D2;0079
1D606;0079
1D63A;0079
1D66E;0079
1D6A2;0079
028F;0079
1EFF;0079
AB5A;0079
03B3;0079
213D;0079
1D6C4;0079
1D6FE;0079
1D738;0079
1D772;0079
1D7AC;0079
2CA9;0079
0443;0079
04AF;0079
10E7;0079
118DC;0079
FF39;0059
1CCEE;0059
1D418;0059
1D44C;0059
1D480;0059
1D4B4;0059
1D4E8;0059
1D51C;0059
1D550;0059
1D584;0059
1D5B8;0059
1D5EC;0059
1D620;0059
1D654;0059
1D688;0059
03A5;0059
03D2;0059
1D6BC;0059
1D6F6;0059
1D730;0059
1D76A;0059
1D7A4;0059
2CA8;0059
0423;0059
04AE;0059
13A9;0059
13BD;0059
A4EC;0059
16F43;0059
118A4;0059
102B2;0059
01B4;0079 0314
024F;0079 0335
04B1;0079 0335
00A5;0059 0335
024E;0059 0335
04B0;0059 0335
0292;021D
A76B;021D
2CC5;021D
2CCD;021D
04E1;021D
10F3;021D
1D433;007A
1D467;007A
1D49B;007A
1D4CF;007A
1D503;007A
1D537;007A
1D56B;007A
1D59F;007A
1D5D3;007A
1D607;007A
1D63B;007A
1D66F;007A
1D6A3;007A
1D22;007A
AB93;007A
118C4;007A
118E5;005A
102F5;005A
FF3A;005A
2124;005A
2128;005A
1CCEF;005A
1D419;005A
1D44D;005A
1D481;005A
1D4B5;005A
1D4E9;005A
1D585;005A
1D5B9;005A
1D5ED;005A
1D621;005A
1D655;005A
1D689;005A
0396;005A
1D6AD;005A
1D6E7;005A
1D721;005A
1D75B;005A
1D795;005A
13C3;005A
A4DC;005A
118A9;005A
0290;007A 0328
01B6;007A 0335
01B5;005A 0335
0225;007A 0326
0224;005A 0326
1D76;007A 0334
2C8D;2C6C
2C8C;2C6B
2C9D;0293
03F7;00DE
104C4;00DE
A7D2;A7D3
A7D4;A7D5
2079;A770
1D24;01A8
03E9;01A8
A645;01A8
044C;0185
AB9F;0185
16ED1;0185
044B;0185 0069
AB7E;0242
02E4;02C1
A6CD;02A1
256A;01C2
2299;0298
2609;0298
2A00;0298
A668;0298
2D59;0298
104C3;0298
213E;0393
1D6AA;0393
1D6E4;0393
1D71E;0393
1D758;0393
1D792;0393
2C84;0393
0413;0393
13B1;0393
14A5;0393
16F07;0393
0492;0393 0335
14AF;0393 00B7
0490;0393 0027
2206;0394
25B3;0394
1F702;0394
1D6AB;0394
1D6E5;0394
1D71F;0394
1D759;0394
1D793;0394
2C86;0394
2D60;0394
1403;0394
16F1A;0394
10285;0394
102A3;0394
2359;0394 0332
140F;0394 00B7
142C;0394 1420
1D7CB;03DD
1D6C7;03B6
1D701;03B6
1D73B;03B6
1D775;03B6
1D7AF;03B6
2CE4;03D7
A7DB;03BB
1D6CC;03BB
1D706;03BB
1D740;03BB
1D77A;03BB
1D7B4;03BB
2C96;03BB
104DB;03BB
019B;03BB 0338
00B5;03BC
1D6CD;03BC
1D707;03BC
1D741;03BC
1D77B;03BC
1D7B5;03BC
1D6CF;03BE
1D709;03BE
1D743;03BE
1D77D;03BE
1D7B7;03BE
2630;039E
1D6B5;039E
1D6EF;039E
1D729;039E
1D763;039E
1D79D;039E
2CB6;039E
03D6;03C0
213C;03C0
1D6D1;03C0
1D6E1;03C0
1D70B;03C0
1D71B;03C0
1D745;03C0
1D755;03C0
1D77F;03C0
1D78F;03C0
1D7B9;03C0
1D7C9;03C0
1D28;03C0
2CA1;03C0
043F;03C0
16EC1;03C0
220F;03A0
213F;03A0
1D6B7;03A0
1D6F1;03A0
1D72B;03A0
1D765;03A0
1D79F;03A0
2CA0;03A0
041F;03A0
A6DB;03A0
16EA6;03A0
102AD;03D8
10312;03D8
2CC1;03FC
03DB;03C2
1D6D3;03C2
1D70D;03C2
1D747;03C2
1D781;03C2
1D7BB;03C2
2C8B;03C2
1D6BD;03A6
1D6F7;03A6
1D731;03A6
1D76B;03A6
1D7A5;03A6
2CAA;03A6
0424;03A6
0553;03A6
1240;03A6
16F0;03A6
102B3;03A6
AB53;03C7
AB55;03C7
1D6D8;03C7
1D712;03C7
1D74C;03C7
1D786;03C7
1D7C0;03C7
2CAD;03C7
1D6D9;03C8
1D713;03C8
1D74D;03C8
1D787;03C8
1D7C1;03C8
2CAF;03C8
0471;03C8
104F9;03C8
1D6BF;03A8
1D6F9;03A8
1D733;03A8
1D76D;03A8
1D7A7;03A8
2CAE;03A8
0470;03A8
104D1;03A8
16D8;03A8
102B5;03A8
2375;03C9
A7B7;03C9
1D6DA;03C9
1D714;03C9
1D74E;03C9
1D788;03C9
1D7C2;03C9
2CB1;03C9
A64D;03C9
2126;03A9
1D6C0;03A9
1D6FA;03A9
1D734;03A9
1D76E;03A9
1D7A8;03A9
162F;03A9
1635;03A9
102B6;03A9
2379;03C9 0332
1F7D;1FF4
0497;0436 0329
0496;0416 0329
1D20B;0418
0376;0418
A6A1;0418
10425;0418
0419;040D
048A;040D 0326
045D;0439
048B;0439 0326
104BC;04C3
1D2B;043B
04C6;043B 0326
AB60;0459
104EB;A669
1DEE;2DEC
104CD;040B
1D202;04FE
1D222;0460
13C7;0460
15EF;0460
047C;0460 0486 0487
18ED;0460 00B7
A7B6;A64C
2CB0;A64C
0AEB;0447
03E5;0447
0AAA;0447
03E4;0427
04CC;04B7
04CB;04B6
04BE;04BC 0328
2CBC;0428
A650;042A 006C
2108;042D
1F701;A658
16F1C;A658
A992;2C3F
0587;0565 0069
1294;0571
FB14;0574 0565
FB15;0574 056B
FB17;0574 056D
FB13;0574 0576
2229;0548
22C2;0548
1D245;0548
1260;0548
144E;0548
A4F5;0548
145A;0548 00B7
1468;0548 0027
FB16;057E 0576
2CE8;0554
101A0;0554
20BD;0554
2CC0;0554
02D3;0559
02BF;0559
2135;05D0
FB21;05D0
FB2F;FB2E
FB30;FB2E
FB4F;05D0 05DC
2136;05D1
2137;05D2
2138;05D3
FB22;05D3
FB23;05D4
FB39;FB1D
FB24;05DB
FB25;05DC
FB26;05DD
FB20;05E2
FB27;05E8
FB2B;FB2A
FB49;FB2A
FB2D;FB2C
FB28;05EA
FE80;0621
06FD;0621 10EFA
FE82;0622
FE81;0622
FB51;0671
FB50;0671
1EE01;0628
1EE21;0628
1EE61;0628
1EE81;0628
1EEA1;0628
FE91;0628
FE92;0628
FE90;0628
FE8F;0628
0751;0628 06DB
08B6;0628 06E2
08A1;0628 0654
FCA0;0628 006F
FCE2;0628 006F
FC9C;0628 062C
FC05;0628 062C
FC9D;0628 062D
FC06;0628 062D
FDC2;0628 062D 0649
FC9E;0628 062E
FC07;0628 062E
FCD2;0628 062E
FC4B;0628 062E
FD9E;0628 062E 0649
FC6A;0628 0631
FC6B;0628 0632
FC9F;0628 0645
FCE1;0628 0645
FC6C;0628 0645
FC08;0628 0645
FC6D;0628 0646
FC6E;0628 0649
FC09;0628 0649
FC6F;0628 0649
FC0A;0628 0649
FB54;067B
FB55;067B
FB53;067B
FB52;067B
06D0;067B
FBE6;067B
FBE7;067B
FBE5;067B
FBE4;067B
FB5C;0680
FB5D;0680
FB5B;0680
FB5A;0680
10EC7;0680
08A9;0754
0767;0754
2365;0629
00F6;0629
FE94;0629
FE93;0629
06C3;0629
1EE15;062A
1EE35;062A
1EE75;062A
1EE95;062A
1EEB5;062A
FE97;062A
FE98;062A
FE96;062A
FE95;062A
067A;062A
FB60;062A
FB61;062A
FB5F;062A
FB5E;062A
08BF;062A 0306
FCA5;062A 006F
FCE4;062A 006F
FCA1;062A 062C
FC0B;062A 062C
FD50;062A 062C 0645
FDA0;062A 062C 0649
FD9F;062A 062C 0649
FCA2;062A 062D
FC0C;062A 062D
FD52;062A 062D 062C
FD51;062A 062D 062C
FD53;062A 062D 0645
FCA3;062A 062E
FC0D;062A 062E
FD54;062A 062E 0645
FDA2;062A 062E 0649
FDA1;062A 062E 0649
FC70;062A 0631
FC71;062A 0632
FCA4;062A 0645
FCE3;062A 0645
FC72;062A 0645
FC0E;062A 0645
FD55;062A 0645 062C
FD56;062A 0645 062D
FD57;062A 0645 062E
FDA4;062A 0645 0649
FDA3;062A 0645 0649
FC73;062A 0646
FC74;062A 0649
FC0F;062A 0649
FC75;062A 0649
FC10;062A 0649
FB64;067F
FB65;067F
FB63;067F
FB62;067F
1EE02;062C
1EE22;062C
1EE42;062C
1EE62;062C
1EE82;062C
1EEA2;062C
FE9F;062C
FEA0;062C
FE9E;062C
FE9D;062C
FCA7;062C 062D
FC15;062C 062D
FDA6;062C 062D 0649
FDBE;062C 062D 0649
FDFB;062C 0644 0020 062C 0644 006C 0644 006F
FCA8;062C 0645
FC16;062C 0645
FD59;062C 0645 062D
FD58;062C 0645 062D
FDA7;062C 0645 0649
FDA5;062C 0645 0649
FD1D;062C 0649
FD01;062C 0649
FD1E;062C 0649
FD02;062C 0649
FB78;0683
FB79;0683
FB77;0683
FB76;0683
FB74;0684
FB75;0684
FB73;0684
FB72;0684
FB7C;0686
FB7D;0686
FB7B;0686
FB7A;0686
08C1;0686 0306
FB80;0687
FB81;0687
FB7F;0687
FB7E;0687
1EE07;062D
1EE27;062D
1EE47;062D
1EE67;062D
1EE87;062D
1EEA7;062D
FEA3;062D
FEA4;062D
FEA2;062D
FEA1;062D
0685;062D 06DB
0681;062D 0654
0772;062D 0654
FCA9;062D 062C
FC17;062D 062C
FDBF;062D 062C 0649
FCAA;062D 0645
FC18;062D 0645
FD5B;062D 0645 0649
FD5A;062D 0645 0649
FD1B;062D 0649
FCFF;062D 0649
FD1C;062D 0649
FD00;062D 0649
1EE17;062E
1EE37;062E
1EE57;062E
1EE77;062E
1EE97;062E
1EEB7;062E
FEA7;062E
FEA8;062E
FEA6;062E
FEA5;062E
FCAB;062E 062C
FC19;062E 062C
FC1A;062E 062D
FCAC;062E 0645
FC1B;062E 0645
FD1F;062E 0649
FD03;062E 0649
FD20;062E 0649
FD04;062E 0649
102E1;062F
1EE03;062F
1EE83;062F
1EEA3;062F
FEAA;062F
FEA9;062F
0688;062F 0615
FB89;062F 0615
FB88;062F 0615
068E;062F 06DB
FB87;062F 06DB
FB86;062F 06DB
068F;062F 06DB
06EE;062F 0302
08AE;062F 0324 0323
1EE18;0630
1EE98;0630
1EEB8;0630
FEAC;0630
FEAB;0630
FC5B;0630 0670
068B;068A 0615
FB85;068C
FB84;068C
FB83;068D
FB82;068D
1EE13;0631
1EE93;0631
1EEB3;0631
FEAE;0631
FEAD;0631
0691;0631 0615
FB8D;0631 0615
FB8C;0631 0615
0698;0631 06DB
FB8B;0631 06DB
FB8A;0631 06DB
0692;0631 0306
08B9;0631 0306 0307
06EF;0631 0302
076C;0631 0654
FC5C;0631 0670
FDF6;0631 0633 0648 0644
FDFC;0631 0649 006C 0644
20C1;0631 0649 006C 0644
1EE06;0632
1EE86;0632
1EEA6;0632
FEB0;0632
FEAF;0632
08B2;0632 0302
0771;0697 0615
1EE0E;0633
1EE2E;0633
1EE4E;0633
1EE6E;0633
1EE8E;0633
1EEAE;0633
FEB3;0633
FEB4;0633
FEB2;0633
FEB1;0633
0634;0633 06DB
1EE14;0633 06DB
1EE34;0633 06DB
1EE54;0633 06DB
1EE74;0633 06DB
1EE94;0633 06DB
1EEB4;0633 06DB
FEB7;0633 06DB
FEB8;0633 06DB
FEB6;0633 06DB
FEB5;0633 06DB
077E;0633 0302
FD31;0633 006F
FCE8;0633 006F
FD32;0633 06DB 006F
FCEA;0633 06DB 006F
FCAD;0633 062C
FD34;0633 062C
FC1C;0633 062C
FD2D;0633 06DB 062C
FD37;0633 06DB 062C
FD25;0633 06DB 062C
FD09;0633 06DB 062C
FD5D;0633 062C 062D
FD5E;0633 062C 0649
FD69;0633 06DB 062C 0649
FCAE;0633 062D
FD35;0633 062D
FC1D;0633 062D
FD2E;0633 06DB 062D
FD38;0633 06DB 062D
FD26;0633 06DB 062D
FD0A;0633 06DB 062D
FD5C;0633 062D 062C
FD68;0633 06DB 062D 0645
FD67;0633 06DB 062D 0645
FDAA;0633 06DB 062D 0649
FCAF;0633 062E
FD36;0633 062E
FC1E;0633 062E
FD2F;0633 06DB 062E
FD39;0633 06DB 062E
FD27;0633 06DB 062E
FD0B;0633 06DB 062E
FDA8;0633 062E 0649
FDC6;0633 062E 0649
FD2A;0633 0631
FD0E;0633 0631
FD29;0633 06DB 0631
FD0D;0633 06DB 0631
FCB0;0633 0645
FCE7;0633 0645
FC1F;0633 0645
FD30;0633 06DB 0645
FCE9;0633 06DB 0645
FD28;0633 06DB 0645
FD0C;0633 06DB 0645
FD61;0633 0645 062C
FD60;0633 0645 062D
FD5F;0633 0645 062D
FD6B;0633 06DB 0645 062E
FD6A;0633 06DB 0645 062E
FD63;0633 0645 0645
FD62;0633 0645 0645
FD6D;0633 06DB 0645 0645
FD6C;0633 06DB 0645 0645
FD17;0633 0649
FCFB;0633 0649
FD18;0633 0649
FCFC;0633 0649
FD19;0633 06DB 0649
FCFD;0633 06DB 0649
FD1A;0633 06DB 0649
FCFE;0633 06DB 0649
102F2;0635
1EE11;0635
1EE31;0635
1EE51;0635
1EE71;0635
1EE91;0635
1EEB1;0635
FEBB;0635
FEBC;0635
FEBA;0635
FEB9;0635
069E;0635 06DB
08AF;0635 0324 0323
FCB1;0635 062D
FC20;0635 062D
FD65;0635 062D 062D
FD64;0635 062D 062D
FDA9;0635 062D 0649
FCB2;0635 062E
FD2B;0635 0631
FD0F;0635 0631
FDF5;0635 0644 0639 0645
FDF9;0635 0644 0649
FDF0;0635 0644 0649
FDFA;0635 0644 0649 0020 006C 0644 0644 006F 0020 0639 0644 0649 006F 0020 0648 0633 0644 0645
FCB3;0635 0645
FC21;0635 0645
FDC5;0635 0645 0645
FD66;0635 0645 0645
FD21;0635 0649
FD05;0635 0649
FD22;0635 0649
FD06;0635 0649
1EE19;0636
1EE39;0636
1EE59;0636
1EE79;0636
1EE99;0636
1EEB9;0636
FEBF;0636
FEC0;0636
FEBE;0636
FEBD;0636
FCB4;0636 062C
FC22;0636 062C
FCB5;0636 062D
FC23;0636 062D
FD6E;0636 062D 0649
FDAB;0636 062D 0649
FCB6;0636 062E
FC24;0636 062E
FD70;0636 062E 0645
FD6F;0636 062E 0645
FD2C;0636 0631
FD10;0636 0631
FCB7;0636 0645
FC25;0636 0645
FD23;0636 0649
FD07;0636 0649
FD24;0636 0649
FD08;0636 0649
102E8;0637
1EE08;0637
1EE68;0637
1EE88;0637
1EEA8;0637
FEC3;0637
FEC4;0637
FEC2;0637
FEC1;0637
069F;0637 06DB
FCB8;0637 062D
FC26;0637 062D
FD33;0637 0645
FD3A;0637 0645
FC27;0637 0645
FD72;0637 0645 062D
FD71;0637 0645 062D
FD73;0637 0645 0645
FD74;0637 0645 0649
FD11;0637 0649
FCF5;0637 0649
FD12;0637 0649
FCF6;0637 0649
1EE1A;0638
1EE7A;0638
1EE9A;0638
1EEBA;0638
FEC7;0638
FEC8;0638
FEC6;0638
FEC5;0638
FCB9;0638 0645
FD3B;0638 0645
FC28;0638 0645
060F;0639
1EE0F;0639
1EE2F;0639
1EE4F;0639
1EE6F;0639
1EE8F;0639
1EEAF;0639
FECB;0639
FECC;0639
FECA;0639
FEC9;0639
FCBA;0639 062C
FC29;0639 062C
FDC4;0639 062C 0645
FD75;0639 062C 0645
FDF7;0639 0644 0649 006F
FCBB;0639 0645
FC2A;0639 0645
FD77;0639 0645 0645
FD76;0639 0645 0645
FD78;0639 0645 0649
FDB6;0639 0645 0649
FD13;0639 0649
FCF7;0639 0649
FD14;0639 0649
FCF8;0639 0649
1EE1B;063A
1EE3B;063A
1EE5B;063A
1EE7B;063A
1EE9B;063A
1EEBB;063A
FECF;063A
FED0;063A
FECE;063A
FECD;063A
FCBC;063A 062C
FC2B;063A 062C
FCBD;063A 0645
FC2C;063A 0645
FD79;063A 0645 0645
FD7B;063A 0645 0649
FD7A;063A 0645 0649
FD15;063A 0649
FCF9;063A 0649
FD16;063A 0649
FCFA;063A 0649
1EE10;0641
1EE30;0641
1EE70;0641
1EE90;0641
1EEB0;0641
FED3;0641
FED4;0641
FED2;0641
FED1;0641
06A7;0641
FCBE;0641 062C
FC2D;0641 062C
FCBF;0641 062D
FC2E;0641 062D
FCC0;0641 062E
FC2F;0641 062E
FD7D;0641 062E 0645
FD7C;0641 062E 0645
FCC1;0641 0645
FC30;0641 0645
FDC1;0641 0645 0649
FC7C;0641 0649
FC31;0641 0649
FC7D;0641 0649
FC32;0641 0649
1EE1E;06A1
1EE7E;06A1
08BB;06A1
066F;06A1
1EE1F;06A1
1EE5F;06A1
08BC;06A1
06A4;06A1 06DB
FB6C;06A1 06DB
FB6D;06A1 06DB
FB6B;06A1 06DB
FB6A;06A1 06DB
06A8;06A1 06DB
08A4;06A2 06DB
FB70;06A6
FB71;06A6
FB6F;06A6
FB6E;06A6
1EE12;0642
1EE32;0642
1EE52;0642
1EE72;0642
1EE92;0642
1EEB2;0642
FED7;0642
FED8;0642
FED6;0642
FED5;0642
FCC2;0642 062D
FC33;0642 062D
FDF1;0642 0644 0649
FCC3;0642 0645
FC34;0642 0645
FDB4;0642 0645 062D
FD7E;0642 0645 062D
FD7F;0642 0645 0645
FDB2;0642 0645 0649
FC7E;0642 0649
FC35;0642 0649
FC7F;0642 0649
FC36;0642 0649
1EE0A;0643
1EE2A;0643
1EE6A;0643
FEDB;0643
FEDC;0643
FEDA;0643
FED9;0643
06A9;0643
FB90;0643
FB91;0643
FB8F;0643
FB8E;0643
06AA;0643
06AD;0643 06DB
FBD5;0643 06DB
FBD6;0643 06DB
FBD4;0643 06DB
FBD3;0643 06DB
0763;0643 06DB
08C2;0643 0306
FC80;0643 006C
FC37;0643 006C
FCC4;0643 062C
FC38;0643 062C
FCC5;0643 062D
FC39;0643 062D
FCC6;0643 062E
FC3A;0643 062E
FCC7;0643 0644
FCEB;0643 0644
FC81;0643 0644
FC3B;0643 0644
FCC8;0643 0645
FCEC;0643 0645
FC82;0643 0645
FC3C;0643 0645
FDC3;0643 0645 0645
FDBB;0643 0645 0645
FDB7;0643 0645 0649
FC83;0643 0649
FC3D;0643 0649
FC84;0643 0649
FC3E;0643 0649
0762;06AC
FB94;06AF
FB95;06AF
FB93;06AF
FB92;06AF
08B0;06AF
06B4;06AF 06DB
FB9C;06B1
FB9D;06B1
FB9B;06B1
FB9A;06B1
FB98;06B3
FB99;06B3
FB97;06B3
FB96;06B3
1EE0B;0644
1EE2B;0644
1EE4B;0644
1EE8B;0644
1EEAB;0644
FEDF;0644
FEE0;0644
FEDE;0644
FEDD;0644
06B7;0644 06DB
06B5;0644 0306
FEFC;0644 006C
FEFB;0644 006C
FEFA;0644 006C 0655
FEF9;0644 006C 0655
FEF8;0644 006C 0674
FEF7;0644 006C 0674
FCCD;0644 006F
FEF6;0644 0622
FEF5;0644 0622
FCC9;0644 062C
FC3F;0644 062C
FD83;0644 062C 062C
FD84;0644 062C 062C
FDBA;0644 062C 0645
FDBC;0644 062C 0645
FDAC;0644 062C 0649
FCCA;0644 062D
FC40;0644 062D
FDB5;0644 062D 0645
FD80;0644 062D 0645
FD82;0644 062D 0649
FD81;0644 062D 0649
FCCB;0644 062E
FC41;0644 062E
FD86;0644 062E 0645
FD85;0644 062E 0645
FCCC;0644 0645
FCED;0644 0645
FC85;0644 0645
FC42;0644 0645
FD88;0644 0645 062D
FD87;0644 0645 062D
FDAD;0644 0645 0649
FC86;0644 0649
FC43;0644 0649
FC87;0644 0649
FC44;0644 0649
1EE0C;0645
1EE2C;0645
1EE6C;0645
1EE8C;0645
1EEAC;0645
FEE3;0645
FEE4;0645
FEE2;0645
FEE1;0645
08A7;0645 06DB
FC88;0645 006C
FCCE;0645 062C
FC45;0645 062C
FD8C;0645 062C 062D
FD92;0645 062C 062E
FD8D;0645 062C 0645
FDC0;0645 062C 0649
FCCF;0645 062D
FC46;0645 062D
FD89;0645 062D 062C
FD8A;0645 062D 0645
FDF4;0645 062D 0645 062F
FD8B;0645 062D 0649
FCD0;0645 062E
FC47;0645 062E
FD8E;0645 062E 062C
FD8F;0645 062E 0645
FDB9;0645 062E 0649
FCD1;0645 0645
FC89;0645 0645
FC48;0645 0645
FDB1;0645 0645 0649
FC49;0645 0649
FC4A;0645 0649
06FE;0645 10EFA
1EE0D;0646
1EE2D;0646
1EE4D;0646
1EE6D;0646
1EE8D;0646
1EEAD;0646
FEE7;0646
FEE8;0646
FEE6;0646
FEE5;0646
10EC6;0646
0768;0646 0615
0769;0646 0306
FCD6;0646 006F
FCEF;0646 006F
FDB8;0646 062C 062D
FDBD;0646 062C 062D
FD98;0646 062C 0645
FD97;0646 062C 0645
FD99;0646 062C 0649
FDC7;0646 062C 0649
FCD3;0646 062D
FC4C;0646 062D
FD95;0646 062D 0645
FD96;0646 062D 0649
FDB3;0646 062D 0649
FCD4;0646 062E
FC4D;0646 062E
FC8A;0646 0631
FC8B;0646 0632
FCD5;0646 0645
FCEE;0646 0645
FC8C;0646 0645
FC4E;0646 0645
FD9B;0646 0645 0649
FD9A;0646 0645 0649
FC8D;0646 0646
FC8E;0646 0649
FC4F;0646 0649
FC8F;0646 0649
FC50;0646 0649
06C2;06C0
FBA5;06C0
FBA4;06C0
102E4;0648
1EE05;0648
1EE85;0648
1EEA5;0648
FEEE;0648
FEED;0648
08B1;0648
06CB;0648 06DB
FBDF;0648 06DB
FBDE;0648 06DB
06C7;0648 0313
FBD8;0648 0313
FBD7;0648 0313
06C6;0648 0306
FBDA;0648 0306
FBD9;0648 0306
06C9;0648 0302
FBE3;0648 0302
FBE2;0648 0302
06C8;0648 0670
FBDC;0648 0670
FBDB;0648 0670
0676;0648 0674
0624;0648 0674
FE86;0648 0674
FE85;0648 0674
0677;0648 0313 0674
FBDD;0648 0313 0674
FDF8;0648 0633 0644 0645
FBE1;06C5
FBE0;06C5
066E;0649
1EE1C;0649
1EE7C;0649
06BA;0649
1EE1D;0649
1EE5D;0649
FB9F;0649
FB9E;0649
08BD;0649
FBE8;0649
FBE9;0649
FEF0;0649
FEEF;0649
064A;0649
1EE09;0649
1EE29;0649
1EE49;0649
1EE69;0649
1EE89;0649
1EEA9;0649
FEF3;0649
FEF4;0649
FEF2;0649
FEF1;0649
06CC;0649
FBFE;0649
FBFF;0649
FBFD;0649
FBFC;0649
06D2;0649
FBAF;0649
FBAE;0649
0679;0649 0615
FB68;0649 0615
FB69;0649 0615
FB67;0649 0615
FB66;0649 0615
06BB;0649 0615
FBA2;0649 0615
FBA3;0649 0615
FBA1;0649 0615
FBA0;0649 0615
067E;0649 06DB
FB58;0649 06DB
FB59;0649 06DB
FB57;0649 06DB
FB56;0649 06DB
0752;0649 06DB
062B;0649 06DB
1EE16;0649 06DB
1EE36;0649 06DB
1EE76;0649 06DB
1EE96;0649 06DB
1EEB6;0649 06DB
FE9B;0649 06DB
FE9C;0649 06DB
FE9A;0649 06DB
FE99;0649 06DB
06BD;0649 06DB
06D1;0649 06DB
063F;0649 06DB
08B7;0649 06DB 06E2
0756;0649 0306
06CE;0649 0306
08C0;0649 0615 0306
08BE;0649 06DB 0306
08BA;0649 0306 0307
063D;0649 0302
088F;0649 030A
08A8;0649 0654
FC90;0649 0670
FC5D;0649 0670
FCDE;0649 006F
FCF1;0649 006F
FCE6;0649 06DB 006F
0678;0649 0674
0626;0649 0674
FE8B;0649 0674
FE8C;0649 0674
FE8A;0649 0674
FE89;0649 0674
FBEB;0649 0674 006C
FBEA;0649 0674 006C
FC9B;0649 0674 006F
FCE0;0649 0674 006F
FBED;0649 0674 006F
FBEC;0649 0674 006F
FBF8;0649 0674 067B
FBF7;0649 0674 067B
FBF6;0649 0674 067B
FC97;0649 0674 062C
FC00;0649 0674 062C
FC98;0649 0674 062D
FC01;0649 0674 062D
FC99;0649 0674 062E
FC64;0649 0674 0631
FC65;0649 0674 0632
FC9A;0649 0674 0645
FCDF;0649 0674 0645
FC66;0649 0674 0645
FC02;0649 0674 0645
FC67;0649 0674 0646
FBEF;0649 0674 0648
FBEE;0649 0674 0648
FBF1;0649 0674 0648 0313
FBF0;0649 0674 0648 0313
FBF3;0649 0674 0648 0306
FBF2;0649 0674 0648 0306
FBF5;0649 0674 0648 0670
FBF4;0649 0674 0648 0670
FBFB;0649 0674 0649
FBFA;0649 0674 0649
FC68;0649 0674 0649
FBF9;0649 0674 0649
FC03;0649 0674 0649
FC69;0649 0674 0649
FC04;0649 0674 0649
FCDA;0649 062C
FC55;0649 062C
FC11;0649 06DB 062C
FDAF;0649 062C 0649
FCDB;0649 062D
FC56;0649 062D
FDAE;0649 062D 0649
FCDC;0649 062E
FC57;0649 062E
FC91;0649 0631
FC76;0649 06DB 0631
FC92;0649 0632
FC77;0649 06DB 0632
FCDD;0649 0645
FCF0;0649 0645
FC93;0649 0645
FC58;0649 0645
FCA6;0649 06DB 0645
FCE5;0649 06DB 0645
FC78;0649 06DB 0645
FC12;0649 06DB 0645
FD9D;0649 0645 0645
FD9C;0649 0645 0645
FDB0;0649 0645 0649
FC94;0649 0646
FC79;0649 06DB 0646
FC95;0649 0649
FC59;0649 0649
FC96;0649 0649
FC5A;0649 0649
FC7A;0649 06DB 0649
FC13;0649 06DB 0649
FC7B;0649 06DB 0649
FC14;0649 06DB 0649
FBB1;06D3
FBB0;06D3
102B8;2D40
205E;2D42
2E3D;2D42
2999;2D42
1CEEF;2D42
FE19;2D57
205D;2D57
22EE;2D57
0544;1206
054C;1261
053B;12AE
054A;1323
0972;0905 0306
0906;0905 093E
0911;0905 093E 0306
0974;0905 093E 093A
0912;0905 093E 0946
0914;0905 093E 0948
0913;0905 093E 11B64
0973;0905 093A
0975;0905 094F
0904;0905 0946
0A24;0909
090D;090F 0306
090E;090F 0946
0910;090F 11B64
0A1F;091F
0A20;0920
0A2B;0922
0A1C;0924 094D 0924
0A27;092A
0A72;092A 094D 091F
0A07;092A 094D 091F 09BF
0A08;092A 094D 091F 0A40
0A0F;092A 094D 091F 11B64
0A2E;092D
0A38;092E
0908;0930 094D 0907
0A15;0935
0A35;0939
0ABD;093D
111DC;A8FB
0949;093E 0306
093B;093E 093A
111CB;093A
11B60;093A
0AC1;0941
0AC2;0942
0A4B;0946
0A48;0948
0A4D;094D
0ACD;094D
0986;0985 09BE
09E0;098B 09C3
09E1;098B 09C3
11492;0998
11494;099A
11496;099C
11498;099E
11499;099F
1149B;09A1
114AA;09A3
1149E;09A4
1149F;09A5
114A0;09A6
114A1;09A7
114A2;09A8
114A3;09AA
114A9;09AC
114A7;09AE
114A8;09AF
09F0;09B0
114AB;09B0
1149D;09B2
114AD;09B7
114AE;09B8
114C4;09BD
114B0;09BE
093F;09BF
0A3F;09BF
114B1;09BF
114B9;09C7
114BC;09CB
114BE;09CC
114C2;09CD
114BD;09D7
0A09;0A73 11B62
0A0A;0A73 11B63
0A10;0A05 0948
0A06;0A05 0A3E
0A14;0A05 0A4C
0A86;0A85 0ABE
0A91;0A85 0ABE 0AC5
0A93;0A85 0ABE 0AC7
0A94;0A85 0ABE 0AC8
0A8D;0A85 0AC5
0A8F;0A85 0AC7
0A90;0A85 0AC8
0B06;0B05 0B3E
1031;0B47
0BEE;0B85
0BB0;0B88
0BBE;0B88
0BEB;0B88 0BC1
0BE8;0B89
0D09;0B89
0B8A;0B89 0BB3
0D0A;0B89 0D57
0BED;0B8E
0BF7;0B8E 0BB5
0B9C;0B90
0D1C;0B90
0B94;0B92 0BB3
0BE7;0B95
0BEA;0B9A
0BEC;0B9A 0BC1
0BF2;0B9A 0BC2
0D3A;0B9F 0BBF
0D23;0BA3
0D7A;0BA3 0D4D
0BFA;0BA8 0BC0
0D25;0BAE
0BF4;0BAE 0BC0
0BF0;0BAF
0D16;0BB5
0D34;0BB4
0BD7;0BB3
0BC8;0BA9
0BB8;0BB6
0D36;0BB6
0BF8;0BB7
0D3F;0BBF
0D40;0BBF
0D46;0BC6
0BCA;0BC6 0B88
0BCC;0BC6 0BB3
0D48;0BC6 0BC6
0D10;0BC6 0D0E
0D47;0BC7
0BCB;0BC7 0B88
0C85;0C05
0C86;0C06
0C87;0C07
0C60;0C0B 0C3E
0C61;0C0C 0C3E
0C90;0C10
0C92;0C12
0C14;0C12 0C4C
0C94;0C12 0C4C
0C13;0C12 0C55
0C93;0C12 0C55
0C97;0C17
0C9C;0C1C
0C9D;0C1D
0C9E;0C1E
0C9F;0C1F
0C22;0C21 0323
0CA3;0C23
0CA6;0C26
0C25;0C27 05BC
0CA8;0C28
0C2D;0C2C 0323
0CAF;0C2F
0CB0;0C30
0C20;0C30 05BC
0CB1;0C31
0CB2;0C32
0C37;0C35 0323
0C39;0C35 0C3E
0C2E;0C35 0C41
0CB3;0C33
0CBF;0C3F
0CC1;0C41
0C42;0C41 0C3E
0CC3;0C43
0C44;0C43 0C3E
0CE1;0C8C 0CBE
0C16;0C96 0323
0D08;0D07 0D57
0D13;0D12 0D3E
0D14;0D12 0D57
0D61;0D1E
0D6B;0D26 0D4D 0D30
0D79;0D28 0D41
0D0C;0D28 0D41
0D19;0D28 0D41
0D6F;0D28 0D4D
0D7B;0D28 0D4D
0D6C;0D28 0D4D 0D28
0D5A;0D28 0D4D 0D2E
10D8;0D30
0D31;0D30
1002;0D30
0D6A;0D30 0D4D
0D7C;0D30 0D4D
1081;0D30 103E
1000;0D30 102C
1023;0D30 102C 1039 0D30 102C
0D7D;0D32 0D4D
0D6E;0D35 0D4D 0D30
0D76;0D39 0D4D 0D2E
0D7E;0D33 0D4D
0D42;0D41
0D43;0D41
0DB5;0D91
0D93;0D91 0DD9
0D92;0D91 0DCA
0DB9;0D94
0DB6;0D9B
0DC0;0DA0
0DEA;0DA2
0DEB;0DAF
0DC4;0DB7
0D8D;0DC3 0DD8
11413;11434 11442 11412
11419;11434 11442 11418
11424;11434 11442 11423
1142A;11434 11442 11429
1142D;11434 11442 1142C
1142F;11434 11442 1142E
115D8;11582
115D9;11582
115DA;11583
115DB;11584
115DC;115B2
115DD;115B3
0E03;0E02
0E14;0E04
0E15;0E04
0E21;0E06
0E88;0E08
0E0B;0E0A
0E0F;0E0E
0E17;0E11
0E9A;0E1A
0E9B;0E1B
0E9D;0E1D
0E9E;0E1E
0E9F;0E1F
0E26;0E20
0E8D;0E22
17D4;0E2F
0E45;0E32
0E33;030A 0E32
17B7;0E34
17B8;0E35
17B9;0E36
17BA;0E37
0EB8;0E38
0EB9;0E39
0E41;0E40 0E40
0EDC;0EAB 0E99
0EDD;0EAB 0EA1
0EB3;030A 0EB2
0F02;0F60 0F74 0F82 0F7F
0F03;0F60 0F74 0F82 0F14
0F6A;0F62
0F00;0F68 0F7C 0F7E
0F77;0FB2 0F71 0F80
0F79;0FB3 0F71 0F80
0F7B;0F7A 0F7A
0F7D;0F7C 0F7C
11CB2;11CAA
1734;1715
1070;1003 103E
1066;1015 103E
101F;1015 102C
106F;1015 102C 103E
107E;107D 103E
1061;101B 103E
1029;101E 103C
102A;101E 103C 0B47 102C 103A
109E;1083 030A
178F;178A
17A3;17A2
19D0;199E
19D1;19B1
1A80;1A45
1A90;1A45
AA53;AA01
AA56;AA23
1B52;1B0D
1B53;1B11
1B58;1B28
A9A3;A99D
1896;185C
1855;1835
1FF6;13EF
140D;1401 00B7
142B;1401 1420
1411;1404 00B7
1413;1405 00B7
142D;1405 1420
1415;1406 00B7
1418;140A 00B7
142E;140A 1420
141A;140B 00B7
18DD;141E 18DF
14D1;1421
1540;1429
143F;1432 00B7
1443;1434 00B7
2369;1435
1447;1439 00B7
145C;144F 00B7
2E27;1450
2283;1450
145E;1450 00B7
1469;1450 0027
27C9;1450 002F
2AD7;1450 1455
1460;1451 00B7
2E26;1455
2282;1455
1462;1455 00B7
146A;1455 0027
1464;1456 00B7
1475;146B 00B7
1485;146B 0027
1479;146E 00B7
147D;1470 00B7
1603;1489
1493;1489 00B7
1495;148B 00B7
1497;148C 00B7
149B;148E 00B7
1602;1490
149D;1490 00B7
149F;1491 00B7
14AD;14A3 00B7
14B1;14A6 00B7
14B3;14A7 00B7
14B5;14A8 00B7
14B9;14AB 00B7
14CA;14C0 00B7
18C7;14C2 00B7
18C9;14C3 00B7
18CB;14C4 00B7
18CD;14C5 00B7
14CC;14C7 00B7
14CE;14C8 00B7
1604;14D3
14DD;14D3 00B7
14DF;14D5 00B7
14E1;14D6 00B7
14E3;14D7 00B7
14E5;14D8 00B7
1607;14DA
14E7;14DA 00B7
14E9;14DB 00B7
14F7;14ED 00B7
14F9;14EF 00B7
14FB;14F0 00B7
14FD;14F1 00B7
14FF;14F2 00B7
1501;14F4 00B7
1503;14F5 00B7
150C;150B 003C
150E;150B 0062
150D;150B 1455
150F;150B 1490
1518;1510 00B7
151A;1511 00B7
151C;1512 00B7
151E;1513 00B7
1520;1514 00B7
1522;1515 00B7
1524;1516 00B7
1532;1528 00B7
1534;1529 00B7
1536;152A 00B7
1538;152B 00B7
153A;152D 00B7
153C;152E 00B7
1622;1543
18E0;1543 00B7
1623;1546
1624;154A
154F;154C 00B7
1583;1550 0062
1584;1550 0062 0307
1581;1550 0064
157F;1550 0050
166F;1550 146B
157E;1550 146C
1580;1550 146E
1582;1550 1470
1585;1550 1483
155C;155A 00B7
18E3;155E 00B7
18E4;1566 00B7
1569;1567 00B7
18E5;156B 00B7
18E8;1586 00B7
1591;1595 004A
1670;1595 1489
158E;1595 148A
158F;1595 148B
1590;1595 148C
1592;1595 148E
1593;1595 1490
1594;1595 1491
1673;1596 004A
1671;1596 148B
1672;1596 148C
1674;1596 148E
1675;1596 1490
1676;1596 1491
18EA;1597 00B7
1677;15A7 00B7
1678;15A8 00B7
1679;15A9 00B7
167A;15AA 00B7
167B;15AB 00B7
167C;15AC 00B7
167D;15AD 00B7
2AAB;15D2
2AAA;15D5
A4F7;15E1
18F0;15F4 00B7
18F2;161B 00B7
1DBB;1646
A4ED;1660
1DBA;18D4
1D3E;18D6
18DC;18DF 141E
02E1;18F3
02B3;18F4
02E2;18F5
18DB;18F5
A7F1;18F5
A6B0;16B9
16E1;16BC
237F;16BD
16C2;16BD
1D23F;16CB
2191;16CF
21BF;16D0
296E;16D0 21C2
2963;16D0 16DA
2D63;16EF
21BE;16DA
2A21;16DA
22C4;16DC
25C7;16DC
25CA;16DC
2662;16DC
1F754;16DC
118B7;16DC
10294;16DC
235A;16DC 0332
22C8;16DE
2A1D;16DE
104D0;16E6
2195;16E8
10CFC;10C82
10CFA;10CA5
3131;1100
11A8;1100
1101;1100 1100
3132;1100 1100
11A9;1100 1100
11FA;1100 1102
115A;1100 1103
11C3;1100 1105
11FB;1100 1107
11AA;1100 1109
3133;1100 1109
11C4;1100 1109 1100
11FC;1100 110E
11FD;1100 110F
11FE;1100 1112
3134;1102
11AB;1102
1113;1102 1100
11C5;1102 1100
1114;1102 1102
3165;1102 1102
11FF;1102 1102
1115;1102 1103
3166;1102 1103
11C6;1102 1103
D7CB;1102 1105
1116;1102 1107
115B;1102 1109
11C7;1102 1109
3167;1102 1109
115C;1102 110C
11AC;1102 110C
3135;1102 110C
D7CC;1102 110E
11C9;1102 1110
115D;1102 1112
11AD;1102 1112
3136;1102 1112
11C8;1102 1140
3168;1102 1140
723F;1102 116E 4E28
2F59;1102 116E 4E28
3137;1103
11AE;1103
1117;1103 1100
11CA;1103 1100
1104;1103 1103
3138;1103 1103
D7CD;1103 1103
D7CE;1103 1103 1107
115E;1103 1105
11CB;1103 1105
A960;1103 1106
A961;1103 1107
D7CF;1103 1107
A962;1103 1109
D7D0;1103 1109
D7D1;1103 1109 1100
A963;1103 110C
D7D2;1103 110C
D7D3;1103 110E
D7D4;1103 1110
3139;1105
11AF;1105
A964;1105 1100
11B0;1105 1100
313A;1105 1100
A965;1105 1100 1100
D7D5;1105 1100 1100
11CC;1105 1100 1109
3169;1105 1100 1109
D7D6;1105 1100 1112
1118;1105 1102
11CD;1105 1102
A966;1105 1103
11CE;1105 1103
316A;1105 1103
A967;1105 1103 1103
11CF;1105 1103 1112
1119;1105 1105
11D0;1105 1105
D7D7;1105 1105 110F
A968;1105 1106
11B1;1105 1106
313B;1105 1106
11D1;1105 1106 1100
11D2;1105 1106 1109
D7D8;1105 1106 1112
A969;1105 1107
11B2;1105 1107
313C;1105 1107
D7D9;1105 1107 1103
A96A;1105 1107 1107
11D3;1105 1107 1109
316B;1105 1107 1109
A96B;1105 1107 110B
11D5;1105 1107 110B
D7DA;1105 1107 1111
11D4;1105 1107 1112
A96C;1105 1109
11B3;1105 1109
313D;1105 1109
11D6;1105 1109 1109
111B;1105 110B
D7DD;1105 110B
A96D;1105 110C
A96E;1105 110F
11D8;1105 110F
11B4;1105 1110
313E;1105 1110
11B5;1105 1111
313F;1105 1111
111A;1105 1112
3140;1105 1112
113B;1105 1112
11B6;1105 1112
D7F2;1105 1112
11D7;1105 1140
316C;1105 1140
D7DB;1105 114C
11D9;1105 1159
316D;1105 1159
D7DC;1105 1159 1112
3141;1106
11B7;1106
A96F;1106 1100
11DA;1106 1100
D7DE;1106 1102
D7DF;1106 1102 1102
A970;1106 1103
11DB;1106 1105
D7E0;1106 1106
111C;1106 1107
316E;1106 1107
11DC;1106 1107
D7E1;1106 1107 1109
A971;1106 1109
11DD;1106 1109
316F;1106 1109
11DE;1106 1109 1109
111D;1106 110B
3171;1106 110B
11E2;1106 110B
D7E2;1106 110C
11E0;1106 110E
11E1;1106 1112
11DF;1106 1140
3170;1106 1140
535F;1106 1161
3142;1107
11B8;1107
111E;1107 1100
3172;1107 1100
111F;1107 1102
1120;1107 1103
3173;1107 1103
D7E3;1107 1103
11E3;1107 1105
D7E4;1107 1105 1111
D7E5;1107 1106
1108;1107 1107
3143;1107 1107
D7E6;1107 1107
112C;1107 1107 110B
3179;1107 1107 110B
1121;1107 1109
3144;1107 1109
11B9;1107 1109
1122;1107 1109 1100
3174;1107 1109 1100
1123;1107 1109 1103
3175;1107 1109 1103
D7E7;1107 1109 1103
1124;1107 1109 1107
1125;1107 1109 1109
1126;1107 1109 110C
A972;1107 1109 1110
112B;1107 110B
3178;1107 110B
11E6;1107 110B
1127;1107 110C
3176;1107 110C
D7E8;1107 110C
1128;1107 110E
D7E9;1107 110E
A973;1107 110F
1129;1107 1110
3177;1107 1110
112A;1107 1111
11E4;1107 1111
A974;1107 1112
11E5;1107 1112
3145;1109
11BA;1109
4ECA;1109 30FC 1100
5408;1109 30FC 1106
112D;1109 1100
317A;1109 1100
11E7;1109 1100
112E;1109 1102
317B;1109 1102
112F;1109 1103
317C;1109 1103
11E8;1109 1103
1130;1109 1105
11E9;1109 1105
1131;1109 1106
D7EA;1109 1106
1132;1109 1107
317D;1109 1107
11EA;1109 1107
1133;1109 1107 1100
D7EB;1109 1107 110B
110A;1109 1109
3146;1109 1109
11BB;1109 1109
4E1B;1109 1109 30FC
D7EC;1109 1109 1100
D7ED;1109 1109 1103
A975;1109 1109 1107
1134;1109 1109 1109
1135;1109 110B
1136;1109 110C
317E;1109 110C
D7EF;1109 110C
1137;1109 110E
D7F0;1109 110E
1138;1109 110F
1139;1109 1110
D7F1;1109 1110
113A;1109 1111
D7EE;1109 1140
3147;110B
11BC;110B
1141;110B 1100
11EC;110B 1100
11ED;110B 1100 1100
1142;110B 1103
A976;110B 1105
1143;110B 1106
1144;110B 1107
1145;110B 1109
11F1;110B 1109
3182;110B 1109
1147;110B 110B
3180;110B 110B
11EE;110B 110B
1148;110B 110C
1149;110B 110E
11EF;110B 110F
114A;110B 1110
114B;110B 1111
A977;110B 1112
1146;110B 1140
11F2;110B 1140
3183;110B 1140
3148;110C
11BD;110C
D7F7;110C 1107
D7F8;110C 1107 1107
114D;110C 110B
110D;110C 110C
3149;110C 110C
D7F9;110C 110C
A978;110C 110C 1112
4E15;110C 1169
314A;110E
11BE;110E
1152;110E 110F
1153;110E 1112
314B;110F
11BF;110F
314C;1110
11C0;1110
9577;1110 30FC 1102 110C
2ED1;1110 30FC 1102 110C
2FA7;1110 30FC 1102 110C
A979;1110 1110
314D;1111
11C1;1111
1156;1111 1107
11F3;1111 1107
D7FA;1111 1109
1157;1111 110B
3184;1111 110B
11F4;1111 110B
D7FB;1111 1110
A97A;1111 1112
314E;1112
11C2;1112
11F5;1112 1102
11F6;1112 1105
11F7;1112 1106
11F8;1112 1107
A97B;1112 1109
1158;1112 1112
3185;1112 1112
113D;113C 113C
113F;113E 113E
317F;1140
11EB;1140
D7F3;1140 1107
D7F4;1140 1107 110B
3181;114C
11F0;114C
D7F5;114C 1106
D7F6;114C 1112
114F;114E 114E
1151;1150 1150
3186;1159
11F9;1159
A97C;1159 1159
3164;1160
314F;1161
11A3;1161 30FC
1176;1161 1169
1177;1161 116E
1162;1161 4E28
3150;1161 4E28
3151;1163
1178;1163 1169
1179;1163 116D
11A4;1163 116E
1164;1163 4E28
3152;1163 4E28
3153;1165
117C;1165 30FC
117A;1165 1169
117B;1165 116E
1166;1165 4E28
3154;1165 4E28
3155;1167
11A5;1167 1163
117D;1167 1169
117E;1167 116E
1168;1167 4E28
3156;1167 4E28
3157;1169
116A;1169 1161
3158;1169 1161
116B;1169 1161 4E28
3159;1169 1161 4E28
11A6;1169 1163
11A7;1169 1163 4E28
117F;1169 1165
1180;1169 1165 4E28
D7B0;1169 1167
1181;1169 1167 4E28
1182;1169 1169
D7B1;1169 1169 4E28
1183;1169 116E
116C;1169 4E28
315A;1169 4E28
315B;116D
D7B2;116D 1161
D7B3;116D 1161 4E28
1184;116D 1163
3187;116D 1163
1186;116D 1163
1185;116D 1163 4E28
3188;116D 1163 4E28
D7B4;116D 1165
1187;116D 1169
1188;116D 4E28
3189;116D 4E28
315C;116E
1189;116E 1161
118A;116E 1161 4E28
116F;116E 1165
315D;116E 1165
118B;116E 1165 30FC
1170;116E 1165 4E28
315E;116E 1165 4E28
D7B5;116E 1167
118C;116E 1167 4E28
118D;116E 116E
1171;116E 4E28
315F;116E 4E28
D7B6;116E 4E28 4E28
3160;1172
118E;1172 1161
D7B7;1172 1161 4E28
118F;1172 1165
1190;1172 1165 4E28
1191;1172 1167
318A;1172 1167
1192;1172 1167 4E28
318B;1172 1167 4E28
D7B8;1172 1169
1193;1172 116E
1194;1172 4E28
318C;1172 4E28
318D;119E
D7C5;119E 1161
119F;119E 1165
D7C6;119E 1165 4E28
11A0;119E 116E
11A2;119E 119E
11A1;119E 4E28
318E;119E 4E28
30D8;3078
2341;303C
29C4;303C
4E8E;1B122
A49E;A04A
A4AC;A050
A49C;A0C0
A4A8;A132
A4BF;A259
A4BE;A2B1
A494;A2CD
A4C0;A3AB
A4C2;A3B5
A4BA;A3BF
A4B0;A3C2
A4A7;A458
22A5;A4D5
27C2;A4D5
1D21C;A4D5
A7B1;A4D5
A79E;A4E4
2141;A4E8
2142;A4F6
1D215;A4F6
1D22B;A4F6
16F26;A4F6
10411;A4F6
2143;16F00
11AE6;11AE5 11AEF
11AE8;11AE5 11AE5
11AE9;11AE5 11AE5 11AEF
11AEA;11AE5 11AE5 11AF0
11AE7;11AE5 11AF0
11AF4;11AF3 11AEF
11AF6;11AF3 11AF3
11AF7;11AF3 11AF3 11AEF
11AF8;11AF3 11AF3 11AF0
11AF5;11AF3 11AF0
11AEC;11AEB 11AEF
11AED;11AEB 11AEB
11AEE;11AEB 11AEB 11AEF
2295;102A8
2A01;102A8
1F728;102A8
A69A;102A8
25BD;102BC
1D214;102BC
1F704;102BC
29D6;102C0
A79B;1043A
A79A;10412
104A0;10486
103D1;10382
103D3;10393
12038;1039A
2625;1099E
132F9;1099E
3039;5344
F967;4E0D
2F800;4E3D
FA70;4E26
239C;4E28
239F;4E28
23A2;4E28
23A5;4E28
23AA;4E28
23AE;4E28
31D1;4E28
1175;4E28
3163;4E28
2F01;4E28
119C;4E28 30FC
1198;4E28 1161
1199;4E28 1163
D7BD;4E28 1163 1169
D7BE;4E28 1163 4E28
D7BF;4E28 1167
D7C0;4E28 1167 4E28
119A;4E28 1169
D7C1;4E28 1169 4E28
D7C2;4E28 116D
119B;4E28 116E
D7C3;4E28 1172
119D;4E28 119E
D7C4;4E28 4E28
F905;4E32
2F801;4E38
F95E;4E39
2F802;4E41
31E0;4E59
2F04;4E59
31DF;4E5A
2E83;4E5A
31D6;4E5B
2E82;4E5B
2EF2;4E80
F91B;4E82
31DA;4E85
2F05;4E85
F9BA;4E86
30CB;4E8C
2F06;4E8C
2F803;20122
2F07;4EA0
F977;4EAE
2F08;4EBA
30A4;4EBB
2E85;4EBB
F9FD;4EC0
2F819;4ECC
F9A8;4EE4
2F804;4F60
5002;4F75
2F807;4F75
FA73;4F80
F92D;4F86
F9B5;4F8B
FA30;4FAE
2F805;4FAE
2F806;4FBB
F965;4FBF
503C;5024
F9D4;502B
2F808;507A
2F809;5099
2F80B;50CF
F9BB;50DA
FA31;50E7
2F80A;50E7
2F80C;349E
3126;513F
2F09;513F
16FF2;513F
FA0C;5140
2E8E;5140
FA74;5145
FA32;514D
2F80E;514D
2F80F;5154
2F810;5164
2F0A;5165
2F814;5167
FA72;5168
F978;5169
30CF;516B
2F0B;516B
F9D1;516D
2F811;5177
2F812;2051C
2F91B;20525
FA75;5180
2F813;34B9
2F0C;5182
2F815;518D
2F816;2054B
2F8D2;5192
2F8D3;5195
2F9CA;34BB
2F8D4;6700
2F0D;5196
2F817;5197
2F818;51A4
2F0E;51AB
2F81A;51AC
FA71;51B5
2F81B;51B5
F92E;51B7
F979;51C9
F955;51CC
F954;51DC
FA15;51DE
2F0F;51E0
2F80D;2063A
2F81D;51F5
2F10;51F5
20674;51F5
2F11;5200
2E89;5202
2F81E;5203
FA00;5207
2F850;5207
F99C;5217
F9DD;5229
2F81F;34DF
F9FF;523A
2F820;523B
2F821;5246
2F822;5272
2F823;5277
F9C7;5289
2F9D9;20804
30AB;529B
F98A;529B
2F12;529B
F99D;52A3
2F824;3515
2F992;52B3
FA76;52C7
2F825;52C7
FA33;52C9
2F826;52C9
F952;52D2
F92F;52DE
FA34;52E4
2F827;52E4
F97F;52F5
2F13;52F9
FA77;52FA
2F828;52FA
2F829;5305
2F82A;5306
2F9DD;208DE
2F14;5315
F963;5317
2F82B;5317
2F15;531A
2F16;5338
F9EB;533F
2F17;5341
3038;5341
303A;5345
2F82C;5349
0FD6;534D
0FD5;5350
FA35;5351
2F82D;5351
2D161;5351
2F82E;535A
30C8;535C
2F18;535C
2F19;5369
2E8B;353E
2F82F;5373
F91C;5375
2F830;537D
2F831;537F
2F832;537F
2F833;537F
2F1A;5382
2F834;20A2C
2F1B;53B6
F96B;53C3
2F1C;53C8
2F836;53CA
2F837;53DF
2F838;20B63
30ED;53E3
2F1D;53E3
56D7;53E3
2F1E;53E3
F906;53E5
2F839;53EB
2F83A;53F1
2F83B;5406
F9DE;540F
F9ED;541D
2F83D;5438
F980;5442
2F83E;5448
2F83F;5468
2F83C;549E
2F840;54A2
F99E;54BD
439B;3588
2F841;54F6
2F842;5510
2F843;5553
555F;5553
FA79;5555
2F844;5563
2F845;5584
2F846;5584
F90B;5587
FA7A;5599
2F847;5599
FA36;559D
FA78;559D
2F848;55AB
2F849;55B3
FA0D;55C0
2F84A;55C2
FA7B;55E2
FA37;5606
2F84C;5606
2F84E;5651
2F84F;5674
FA38;5668
F9A9;56F9
2F84B;5716
2F84D;5717
2F1F;571F
58EB;571F
2F20;571F
2F855;578B
2F852;57CE
39B3;363D
2F853;57F4
2F854;580D
2F857;5831
2F856;5832
FA39;5840
FA10;585A
FA7C;585A
F96C;585E
586B;5861
58FF;58AB
2F858;58AC
FA7D;58B3
F94A;58D8
F942;58DF
2F859;214E4
2F851;58EE
2F85A;58F2
2F85B;58F7
21533;58F7
2F21;5902
2F85C;5906
2F22;590A
30BF;5915
2F23;5915
2F85D;591A
21587;591A
2F85E;5922
2F24;5927
FA7E;5944
F90C;5948
FA7F;5954
F909;5951
2F85F;5962
F981;5973
2F25;5973
216A7;216A8
2F860;216A8
2F861;216EA
2F865;59D8
2F862;59EC
2F863;5A1B
2F864;5A27
FA80;5A62
2F866;5A66
5B00;5AAF
2F867;36EE
2F868;36FC
2F986;5AB5
2F869;5B08
FA81;5B28
2F86A;5B3E
2F86B;5B3E
2F26;5B50
2F27;5B80
FA04;5B85
2F86C;219C8
2F86D;5BC3
2F86E;5BD8
F95F;5BE7
F9AA;5BE7
2F86F;5BE7
F9BC;5BEE
2F870;5BF3
2F871;21B18
2F28;5BF8
2F872;5BFF
2F873;5C06
2F29;5C0F
2F875;5C22
2E90;5C22
2F2A;5C22
2E8F;5C23
2F876;3781
2F2B;5C38
F9BD;5C3F
2F877;5C60
F94B;5C62
FA3B;5C64
F9DF;5C65
FA3C;5C6E
2F878;5C6E
2F2C;5C6E
2F8F8;21D0B
2F2D;5C71
2F879;5CC0
2B73A;5CC0
2F87A;5C8D
2F87B;21DE4
2F87D;21DE6
F9D5;5D19
2F87C;5D43
F921;5D50
2F87F;5D6B
2F87E;5D6E
2F880;5D7C
2F9F4;5DB2
F9AB;5DBA
2F2E;5DDB
2F882;5DE2
30A8;5DE5
2F2F;5DE5
2F30;5DF1
2E92;5DF3
2F883;382F
2F884;5DFD
2F31;5DFE
5E32;5E21
2F885;5E28
2F886;5E3D
2F887;5E69
2F888;3862
2F889;22183
2F32;5E72
F98E;5E74
2F939;2219F
2E93;5E7A
2F33;5E7A
2F34;5E7F
FA01;5EA6
2F88A;387C
2F88B;5EB0
2F88C;5EB3
2F88D;5EB6
F928;5ECA
2F88E;5ECA
F9A2;5EC9
FA82;5ED2
FA0B;5ED3
FA83;5ED9
F982;5EEC
2F35;5EF4
2F890;5EFE
2F36;5EFE
2F891;22331
2F892;22331
F943;5F04
2F37;5F0B
2F38;5F13
2F894;5F22
2F895;5F22
2F39;5F50
2E94;5F51
2F874;5F53
2F896;38C7
2F3A;5F61
2F899;5F62
FA84;5F69
2F89A;5F6B
2F3B;5F73
F9D8;5F8B
2F89B;38E3
22505;5F9A
2F89C;5F9A
F966;5FA9
FA85;5FAD
2F3C;5FC3
2E96;5FC4
2E97;38FA
2F89D;5FCD
2F89E;5FD7
F9A3;5FF5
2F89F;5FF9
F960;6012
F9AC;601C
FA6B;6075
2F8A2;391C
2F8A1;393A
2F8A0;6081
FA3D;6094
2F8A3;6094
2F8A5;60C7
FA86;60D8
F9B9;60E1
2F8A4;226D4
FA88;6108
FA3E;6168
F9D9;6144
2F8A6;6148
2F8A7;614C
2F8A9;614C
FA87;614E
2F8A8;614E
FA8A;6160
2F8AA;617A
FA3F;618E
FA89;618E
2F8AB;618E
F98F;6190
2F8AD;61A4
2F8AE;61AF
2F8AC;61B2
FAD0;22844
FACF;2284A
2F8AF;61DE
FA40;61F2
FA8B;61F2
2F8B0;61F2
F90D;61F6
2F8B1;61F6
F990;6200
2F3D;6208
2F8B2;6210
2F8B3;621B
F9D2;622E
FA8C;6234
2F3E;6236
6238;6236
2F3F;624B
2E98;624C
2F8B4;625D
2F8B5;62B1
F925;62C9
F95B;62CF
FA02;62D3
2F8B6;62D4
2F8BA;62FC
F973;62FE
2F8B8;22B0C
2F8B9;633D
2F8B7;6350
2F8BB;6368
F9A4;637B
2F8BC;6383
F975;63A0
2F8C1;63A9
FA8D;63C4
2F8BD;63E4
FA8E;641C
2F8BE;22BF1
2F8BF;6422
2F8C0;63C5
FA8F;6452
2F8C3;6469
2F8C6;6477
2F8C4;647E
2F8C2;3A2E
6409;3A41
F991;649A
2F8C5;649D
F930;64C4
2F8C7;3A6C
2F40;652F
2F41;6534
2E99;6535
FA41;654F
2F8C8;654F
FA90;6556
2F8C9;656C
F969;6578
2F8CA;2300A
2F42;6587
2EEB;6589
2F43;6597
F9BE;6599
2F44;65A4
2F45;65B9
F983;65C5
2F46;65E0
2E9B;65E1
FA42;65E2
2F8CB;65E3
2F47;65E5
F9E0;6613
66F6;3ADA
2F8D1;3AE4
2F8CD;6649
6669;665A
FA12;6674
FA91;6674
FA43;6691
2F8CF;6691
F9C5;6688
2F8D0;3B08
2F8D5;669C
FA06;66B4
F98B;66C6
2F8CE;3B19
2F897;232B8
2F48;66F0
F901;66F4
2F8CC;66F8
2F49;6708
2F980;2335F
2B73E;2335F
80A6;670C
80D0;670F
80CA;6710
8101;6713
80F6;3B35
F929;6717
FA92;6717
2F8D8;6717
8127;6718
FA93;671B
2F8D9;671B
5E50;3B3A
4420;3B3B
2F989;23393
81A7;6723
2F98A;2339C
2F4A;6728
F9E1;674E
2F8DC;6753
FA94;6756
2F8DB;675E
2F8DD;233C3
67FF;676E
F9C8;677B
2F8E0;6785
F9F4;6797
2F8DE;3B49
FAD1;233D5
F9C9;67F3
2F8DF;67FA
F9DA;6817
2F8E5;681F
2F8E1;6852
2F8E3;2346D
F97A;6881
FA44;6885
2F8E2;6885
2F8E4;688E
F9E2;68A8
2F8E6;6914
2F8E8;6942
FAD2;3B9D
2F8E7;3B9D
69E9;3BA3
6A27;699D
2F8E9;69A3
2F8EA;69EA
F914;6A02
F95C;6A02
F9BF;6A02
F94C;6A13
2F8EC;236A3
2F8EB;6AA8
F931;6AD3
2F8ED;6ADB
F91D;6B04
2F8EE;3C18
2F4B;6B20
2F8EF;6B21
2F8F0;238A7
2F8F1;6B54
2F8F2;3C4E
2F4C;6B62
2EED;6B6F
2F8F3;6B72
F98C;6B77
FA95;6B79
2F4D;6B79
2E9E;6B7A
2F8F4;6B9F
F9A5;6BAE
2F4E;6BB3
F970;6BBA
FA96;6BBA
2F8F5;6BBA
2F8F6;6BBB
2F8F7;23A8D
2F4F;6BCB
2E9F;6BCD
2F8F9;23AFA
2F50;6BD4
2F51;6BDB
2F52;6C0F
2EA0;6C11
2F53;6C14
2F54;6C34
2EA1;6C35
2EA2;6C3A
2F8FA;6C4E
2F8FE;6C67
F972;6C88
2F8FC;6CBF
F968;6CCC
2F8FD;6CCD
F9E3;6CE5
2F8FB;23CBC
F915;6D1B
FA05;6D1E
2F907;6D34
2F900;6D3E
F9CA;6D41
FA97;6D41
2F902;6D41
2F8FF;6D16
2F903;6D69
F92A;6D6A
FA45;6D77
2F901;6D77
2F904;6D78
2F905;6D85
23D40;6D85
2F906;23D1E
F9F5;6DCB
F94D;6DDA
F9D6;6DEA
2F90E;6DF9
FA46;6E1A
2F908;6E2F
2F909;6E6E
6F59;6E88
FA99;6ECB
2F90B;6ECB
F9CB;6E9C
F9EC;6EBA
2F90C;6EC7
F904;6ED1
FA98;6EDB
2F90A;3D33
F94E;6F0F
FA47;6F22
FA9A;6F22
F992;6F23
2F90D;23ED1
2F90F;6F6E
2F910;23F5E
2F911;23F8E
2F912;6FC6
F922;6FEB
F984;6FFE
2F915;701B
FA9B;701E
2F914;701E
2F913;7039
2F917;704A
2F916;3D96
2F55;706B
2EA3;706C
2F835;7070
2F919;7077
2F918;707D
F9FB;7099
2F91A;70AD
F99F;70C8
F916;70D9
FA48;716E
FA9C;716E
2F91D;24263
2F91C;7145
F993;7149
FA6C;242EE
2F91E;719C
F9C0;71CE
F9EE;71D0
2F91F;243AB
F932;7210
F91E;721B
2F920;7228
2F56;722A
FA49;722B
2EA4;722B
FA9E;7235
2F921;7235
2F57;7236
2F58;723B
2EA6;4E2C
2F5A;7247
2F922;7250
2F5B;7259
2F923;24608
2F5C;725B
F946;7262
2F924;7280
2F925;7295
2F5D;72AC
2EA8;72AD
FA9F;72AF
F9FA;72C0
2F926;24735
F92B;72FC
FA16;732A
FAA0;732A
2AEC5;24814
2F927;24814
F9A7;7375
2F928;737A
2F5E;7384
F961;7387
F9DB;7387
2F5F;7389
2F929;738B
2F92A;3EAC
2F92B;73A5
248FD;73A5
F9AD;73B2
2F92C;3EB8
2F92D;3EB8
F917;73DE
F9CC;7409
F9E4;7406
FA4A;7422
2F92E;7447
2F92F;745C
F9AE;7469
FAA1;7471
2F930;7471
2F931;7485
F994;7489
F9EF;7498
2F932;74CA
2F60;74DC
2F61;74E6
2F933;3F1B
FAA2;7506
2F62;7518
2F63;751F
2F934;7524
2F64;7528
2F65;7530
FAA3;753B
2F936;753E
2F935;24C36
F9CD;7559
F976;7565
F962;7570
2F938;7570
2F937;24C92
2F66;758B
2F67;7592
F9E5;75E2
2F93A;7610
FAA5;761F
FAA4;761D
F9C1;7642
F90E;7669
2F68;7676
2F69;767D
2F93B;24FA1
2F93C;24FB8
2F6A;76AE
2F6B;76BF
2F93D;25044
2F93E;3FFC
FA17;76CA
FAA6;76CA
FAA7;76DB
F933;76E7
2F93F;4008
2F6C;76EE
FAA8;76F4
2F940;76F4
2F942;250F2
2F941;250F3
F96D;7701
FAD3;4018
2F943;25119
2511A;25119
2F945;771E
2F946;771F
2F947;771F
2F944;25133
FAAA;7740
FAA9;774A
2F948;774A
9FC3;4039
FAD4;4039
2F949;4039
6663;403F
2F94B;4046
2F94A;778B
FAD5;25249
FA9D;77A7
2F6D;77DB
2F6E;77E2
2F6F;77F3
2F94C;4096
2F94D;2541D
784F;7814
2F94E;784E
F9CE;786B
F93B;788C
2F94F;788C
FA4B;7891
F947;78CA
FAAB;78CC
2F950;78CC
F964;78FB
2F951;40E3
F985;792A
2F70;793A
2EAD;793B
FA18;793C
FA4C;793E
FA4E;7948
FA4D;7949
2F952;25626
FA4F;7950
FA50;7956
2F953;7956
FA51;795D
FA19;795E
FA1A;7965
FA61;8996
FAB8;8996
F93C;797F
2F954;2569A
FA52;798D
FA53;798E
FA1B;798F
2F956;798F
2F955;256C5
F9B6;79AE
2F71;79B8
2F72;79BE
F995;79CA
2F958;412F
2F957;79EB
F956;7A1C
2F95A;7A4A
FA54;7A40
2F959;7A40
2F95B;7A4F
2F73;7A74
FA55;7A81
2F95C;2597C
FAAC;7AB1
F9F7;7ACB
2F74;7ACB
2EEF;7ADC
2F95D;25AA7
2F95E;25AA7
2F95F;7AEE
2F75;7AF9
F9F8;7B20
FA56;7BC0
FAAD;7BC0
2F960;4202
2F961;25BAB
2F962;7BC6
2F964;4227
2F963;7BC9
2F965;25C80
FAD6;25CD0
F9A6;7C3E
F944;7C60
2F76;7C73
FAAE;7C7B
F9F9;7C92
FA1D;7CBE
2F966;7CD2
FA03;7CD6
2F968;7CE8
2F967;42A0
2F969;7CE3
F97B;7CE7
2F77;7CF8
2EAF;7CF9
2F96B;25F86
2F96A;7D00
F9CF;7D10
F96A;7D22
F94F;7D2F
7D76;7D55
2F96C;7D63
FAAF;7D5B
F93D;7DA0
F957;7DBE
2F96E;7DC7
31E7C;7DC7
F996;7DF4
FA57;7DF4
FAB0;7DF4
2F96F;7E02
2F96D;4301
FA58;7E09
F950;7E37
FA59;7E41
2F970;7E45
2F898;261DA
2F971;4334
2F78;7F36
2F972;26228
FAB1;7F3E
2F973;26247
2F79;7F51
2EAB;7F52
2EB2;7F52
2EB1;7F53
2F974;4359
FA5A;7F72
2F975;262D9
F9E6;7F79
2F976;7F7A
F90F;7F85
2F977;2633E
2F7A;7F8A
2F978;7F95
F9AF;7F9A
FA1E;7FBD
2F7B;7FBD
2F979;7FFA
F934;8001
2F7C;8001
2EB9;8002
FA5B;8005
FAB2;8005
2F97A;8005
2F7D;800C
2F97B;264DA
2F7E;8012
2F97C;26523
2F7F;8033
F9B0;8046
2F97D;8060
2659D;265A8
2F97E;265A8
F997;806F
2F97F;8070
F945;807E
2F80;807F
2EBA;8080
2F81;8089
F953;808B
2F8D6;80AD
2F982;80B2
2F981;43D5
2F8D7;43D9
8141;80FC
2F983;8103
2F985;813E
2F984;440B
2F8DA;6721
2F987;267A7
2F988;267B5
6726;4443
F926;81D8
2F82;81E3
F9F6;81E8
2F83;81EA
FA5C;81ED
2F84;81F3
2F85;81FC
2F893;8201
2F98B;8201
2F98C;8204
2F86;820C
FA6D;8218
2F87;821B
2F88;821F
2F98E;446B
2F89;826E
F97C;826F
2F8A;8272
2F8B;8278
FA5D;8279
FA5E;8279
2EBE;8279
2EBF;8279
2EC0;8279
2F990;828B
2F98F;8291
2F991;829D
2F993;82B1
2F994;82B3
2F995;82BD
F974;82E5
2F998;82E5
2F996;82E6
2F997;26B3C
F9FE;8336
FAB3;8352
2F99A;8363
2F999;831D
2F99C;8323
2F99D;83BD
2F9A0;8353
F93E;83C9
2F9A1;83CA
2F9A2;83CC
2F9A3;83DC
2F99E;83E7
FAB4;83EF
F958;83F1
FA5F;8457
2F99F;8457
2F9A4;26C36
26D06;26C36
2F99B;83AD
F918;843D
F96E;8449
853F;848D
2F9A6;26CD5
2F9A5;26D6B
F999;84EE
2F9A8;84F1
2F9A9;84F3
F9C2;84FC
2F9AA;8516
2F9A7;452B
2F9AC;8564
2F9AD;26F2C
F923;85CD
2F9AE;455D
2F9B0;26FB1
2F9AF;4561
F9F0;85FA
F935;8606
2F9B2;456B
FA20;8612
F91F;862D
2F9B1;270D2
8641;8637
F910;863F
2F8C;864D
2EC1;864E
2F9B3;8650
F936;865C
2F9B4;865C
2F9B5;8667
2F9B6;8669
2F8D;866B
2F9B7;86A9
2F9B8;8688
2F9BA;86E2
2F9B9;870E
2F9BC;8728
2F9BD;876B
2F9C0;87E1
FAB5;8779
2F9BB;8779
2F9BE;8786
2F9BF;45D7
2F9AB;273CA
F911;87BA
2F9C1;8801
2F9C2;45F9
F927;881F
2F8E;8840
FA08;884C
2F8F;884C
2F9C3;8860
2F9C4;8863
2F90;8863
2EC2;8864
F9A0;88C2
2F9C5;27667
F9E7;88CF
2F9C6;88D7
2F9C7;88DE
F9E8;88E1
F912;88F8
2F9C9;88FA
2F9C8;4635
FA60;8910
FAB6;8941
F924;8964
2F91;897E
2EC4;897F
2EC3;8980
FAB7;8986
FA0A;898B
2F92;898B
2EC5;89C1
4695;278AE
2F9CB;278AE
2F93;89D2
2F94;8A00
2EC8;8BA0
2F9CC;27966
8A7D;8A2E
8A1E;46B6
2F9CD;46BE
2F9CE;46C7
2F9CF;8AA0
F96F;8AAA
F9A1;8AAA
FAB9;8ABF
FABB;8ACB
F97D;8AD2
F941;8AD6
FABE;8AED
2F9D0;8AED
FA22;8AF8
FABA;8AF8
F95D;8AFE
FABD;8AFE
FA62;8B01
FABC;8B01
FA63;8B39
FABF;8B39
F9FC;8B58
F95A;8B80
8B8F;8B86
FAC0;8B8A
2F9D1;8B8A
2F95;8C37
2F96;8C46
F900;8C48
2F9D2;8C55
2F97;8C55
8C63;8C5C
2F98;8C78
2F9D3;27CA8
2F99;8C9D
2EC9;8D1D
2F9D4;8CAB
2F9D5;8CC1
F948;8CC2
F903;8CC8
FA64;8CD3
FA65;8D08
FAC1;8D08
25AD4;8D1B
2F9D6;8D1B
2F9A;8D64
2F9B;8D70
2F9D7;8D77
8D86;8D7F
FAD7;27ED3
2F9D8;27F2F
2F9C;8DB3
2F9DA;8DCB
2F9DB;8DBC
8DFA;8DE5
F937;8DEF
2F9DC;8DF0
8E9B;8E97
2F9D;8EAB
F902;8ECA
2F9E;8ECA
2ECB;8F66
2F9DE;8ED4
8F27;8EFF
F998;8F26
F9D7;8F2A
FAC2;8F38
2F9DF;8F38
FA07;8F3B
F98D;8F62
2F9F;8F9B
2F98D;8F9E
F971;8FB0
2FA0;8FB0
2FA1;8FB5
FA66;8FB6
2ECC;8FB6
2ECD;8FB6
2F881;5DE1
F99A;9023
FA25;9038
FA67;9038
FAC3;9072
F9C3;907C
2F9E0;285D2
2F9E1;285ED
F913;908F
2FA2;9091
2F9E2;9094
F92C;90CE
90DE;90CE
FA2E;90CE
2F9E3;90F1
FA26;90FD
2F9E5;2872E
2F9E4;9111
2F9E6;911B
2FA3;9149
F919;916A
FAC4;9199
F9B7;91B4
2FA4;91C6
F9E9;91CC
2FA5;91CC
F97E;91CF
F90A;91D1
2FA6;91D1
2ED0;9485
F9B1;9234
2F9E7;9238
FAC5;9276
2F9E8;92D7
2F9E9;92D8
2F9EA;927C
F93F;9304
F99B;934A
93AE;93AD
2F9EB;93F9
2F9EC;9415
2F9ED;28BFA
2ED2;9578
2ED3;957F
2FA8;9580
2ED4;95E8
2F9EE;958B
2F9EF;4995
F986;95AD
2F9F0;95B7
2F9F1;28D77
2FA9;961C
2ECF;961D
2ED6;961D
F9C6;962E
F951;964B
FA09;964D
F959;9675
F9D3;9678
FAC6;967C
F9DC;9686
F9F1;96A3
2F9F2;49E6
2FAA;96B6
FA2F;96B7
96B8;96B7
F9B8;96B7
2FAB;96B9
2F9F3;96C3
F9EA;96E2
FA68;96E3
FAC7;96E3
2FAC;96E8
F9B2;96F6
F949;96F7
2F9F5;9723
2F9F6;29145
F938;9732
F9B3;9748
2FAD;9751
2ED8;9752
FA1C;9756
FAC8;9756
2F81C;291DF
2FAE;975E
2FAF;9762
2F9F7;2921A
2FB0;9769
2F9F8;4A6E
2F9F9;4A76
2FB1;97CB
2ED9;97E6
FAC9;97DB
2F9FA;97E0
2FB2;97ED
2F9FB;2940A
2FB3;97F3
FA69;97FF
FACA;97FF
2FB4;9801
2EDA;9875
2F9FC;4AB2
FACB;980B
2F9FE;980B
2F9FF;980B
F9B4;9818
2FA00;9829
2F9FD;29496
FA6A;983B
FACC;983B
F9D0;985E
2FB5;98A8
2EDB;98CE
2FA01;295B6
2FB6;98DB
2EDC;98DE
2EDD;98DF
2FB7;98DF
2EDF;98E0
2EE0;9963
2FA02;98E2
FA2A;98EF
FA2B;98FC
2FA03;4B33
FA2C;9928
2FA04;9929
2FB8;9996
2FB9;9999
2FA05;99A7
2FBA;99AC
2EE2;9A6C
2FA06;99C2
F91A;99F1
2FA07;99FE
F987;9A6A
2FBB;9AA8
2FA08;4BCE
2FBC;9AD8
2FBD;9ADF
2FA09;29B30
FACD;9B12
2FA0A;9B12
2FBE;9B25
2FBF;9B2F
2FC0;9B32
2FC1;9B3C
2EE4;9B3C
2FC2;9B5A
2EE5;9C7C
F939;9B6F
2FA0B;9C40
F9F2;9C57
2FC3;9CE5
2FA0C;9CFD
2FA0D;4CCE
9E43;9E42
2FA0F;9D67
2FA0E;4CED
2FA10;2A0CE
FA2D;9DB4
2FA12;2A105
2FA11;4CF8
F93A;9DFA
2FA13;2A20E
F920;9E1E
2FC4;9E75
F940;9E7F
2FC5;9E7F
2FA14;2A291
F988;9E97
F9F3;9E9F
2FC6;9EA5
2EE8;9EA6
2FA15;9EBB
2FC7;9EBB
2F88F;2A392
2FC8;9EC3
2EE9;9EC4
2FC9;9ECD
F989;9ECE
2FA16;4D56
2FCA;9ED1
9ED2;9ED1
FA3A;58A8
2FA17;9EF9
2FCB;9EF9
2FCC;9EFD
2FA18;9EFE
2FA19;9F05
2FCD;9F0E
2FA1A;9F0F
2FCE;9F13
2FA1B;9F16
2FCF;9F20
2FA1C;9F3B
2FD0;9F3B
FAD8;9F43
2FD1;9F4A
2EEC;9F50
2FD2;9F52
2EEE;9F7F
2FA1D;2A600
F9C4;9F8D
2FD3;9F8D
2EF0;9F99
FAD9;9F8E
F907;9F9C
F908;9F9C
FACE;9F9C
2FD4;9F9C
2EF3;9F9F
2FD5;9FA0
0CDC;0C5C
1DE8;1ADA
2DEE;1ADB
1AE7;1AE5
031A;1AE9
0295;A7CE
A7CF;A7CE
0348;10EFA
0956;11B62
0A41;11B62
0957;11B63
0A42;11B63
0947;11B64
0A47;11B64
5152;16FF3
1F40D;1CCFA
1F443;1CCFC
1F377;1CEBA
1F3E2;1CEBB
1F333;1CEBC
1F34E;1CEBD
1F34F;1CEBD
1F352;1CEBE
1F353;1CEBF
28FF;1CEE0
29B5;1CEF0
21C4;1F8D0
21CC;1F8D1
2657;1FA55
265D;1FA57
1F514;1FBFA
6138;2B73F`;

/**
 * What a username looks like, as a key: the rule that two names which read the
 * same can't belong to two accounts. Ward keys its own accounts the same way
 * (its `usernameSkeleton`), from the same Unicode table.
 */
/** Each confusable character and the prototype it reads as, from `./confusables.ts`. */
const PROTOTYPES = new Map(CONFUSABLES.split("\n").map((line) => {
    const [from = "", to = ""] = line.split(";");
    const codePoints = (hex) => hex.split(" ").map((point) => Number.parseInt(point, 16));
    return [String.fromCodePoint(...codePoints(from)), String.fromCodePoint(...codePoints(to))];
}));
/**
 * Characters that render as nothing, or as a blank, and so drop out of a
 * skeleton: Unicode's default-ignorable code points (a combining grapheme
 * joiner, a variation selector, the Hangul fillers), plus U+2800 BRAILLE
 * PATTERN BLANK, which renders as a blank and which Unicode lists as neither
 * ignorable nor confusable.
 */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}⠀]/gu;
/**
 * The key `auth_users.username_skeleton` holds: two names with the same key
 * read the same in an app's list of users, so a new name or a rename onto
 * another account's key is taken (`AuthStore.createUser`, `setUsername`).
 *
 * Three steps, each on the output of the one before:
 *
 *  1. Unicode's skeleton (UTS #39) of the name **as typed**, because apps show
 *     the name as typed: a capital `I` reads as `l`, and a digit `0` as `O`,
 *     so `AIice` reads as `alice` and `b0b` as `bOb`.
 *  2. The fold (`foldUsername`), because case alone never makes two names:
 *     `bOb` becomes `bob`, so `b0b` and `bob` meet.
 *  3. The skeleton again, because lower-casing can make a new look-alike: a
 *     capital `M` becomes `m`, which reads as `rn`, so `MODERN` and `rnodern`
 *     meet.
 *
 * A skeleton is NFD, the invisible characters above removed, each character
 * replaced by its prototype from Unicode's confusables table, then NFD again.
 * A Cyrillic `аlice`, an `alice` with a combining grapheme joiner after it and
 * a full-width `ａlice` all come out as `alice`. In plain ASCII, `I`, `l`, `1`
 * and `|` read the same, `0` reads as `o`, `m` as `rn`, a backtick as `'` and
 * `"` as `''`.
 *
 * Because step 1 sees the capitals, the same name in two cases can have two
 * keys: `Ivan` has `lvan`, and `ivan` has `ivan`. A new `lvan` is taken while
 * `Ivan` exists and not while `ivan` does, which is what each list shows. The
 * two cases themselves are one name either way, through `username_folded`.
 *
 * Pass the stored form of the name (`normaliseUsername`'s answer). The key is
 * never shown to anyone and never compared with anything but another key. The
 * table's version decides some keys, so a new version ships with a migration
 * that recomputes the column.
 */
function usernameSkeleton(username) {
    return skeleton(foldUsername(skeleton(username)));
}
/** UTS #39's skeleton of `text`, with the invisible characters above dropped. */
function skeleton(text) {
    let mapped = "";
    for (const char of text.normalize("NFD").replace(INVISIBLE, "")) {
        mapped += PROTOTYPES.get(char) ?? char;
    }
    return mapped.normalize("NFD");
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
/**
 * Thrown by `startSession` for a disabled user, and by a Ward sign-in for a
 * linked subject whose user is disabled (0.6.0). The HTTP layer answers it as
 * it answers any refusal; it never names the reason to the browser.
 */
class UserDisabledError extends Error {
    code = "user_disabled";
    constructor() {
        super("this user is disabled");
        this.name = "UserDisabledError";
    }
}
function toAuthUser(user) {
    return {
        id: user.id,
        username: user.username,
        role: user.role,
        hasPassword: user.passwordHash !== null,
        disabled: user.disabledAt !== null,
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
        const passwordHash = input.password === undefined || input.password === null ? null : await hashPassword(input.password);
        const created = await store.createUser({
            id: input.id ?? generateUserId(),
            username,
            usernameFolded: foldUsername(username),
            usernameSkeleton: usernameSkeleton(username),
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
        // into a sign-in. A disabled user is refused only here, after the hash
        // ran: a right and a wrong password cost the same, and both answer as an
        // unknown name does.
        if (user === undefined || !ok || user.disabledAt !== null)
            return undefined;
        return toAuthUser(user);
    }
    async function checkPassword(userId, password) {
        const user = await store.findUserById(userId);
        // The same one cost on every path as `verifyCredentials`, and the same
        // repeated `user === undefined` before a true can come out.
        const ok = user === undefined || user.passwordHash === null
            ? await spendDummyHash(password)
            : await verifyPassword(password, user.passwordHash);
        return user !== undefined && ok && user.disabledAt === null;
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
        const user = await store.findUserById(userId);
        if (user !== undefined && user.disabledAt !== null)
            throw new UserDisabledError();
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
        // A disabled user's sessions were ended by `disableUser`; one minted in a
        // race with it is refused and removed here.
        const user = await store.findUserById(session.userId);
        if (user === undefined || user.disabledAt !== null) {
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
        async renameUser(userId, username) {
            const name = normaliseUsername(username);
            const user = await store.findUserById(userId);
            if (user === undefined)
                return undefined;
            await store.setUsername(userId, name, foldUsername(name), usernameSkeleton(name), now());
            return toAuthUser({ ...user, username: name });
        },
        async disableUser(userId) {
            const user = await store.findUserById(userId);
            if (user === undefined)
                return undefined;
            const disabledAt = user.disabledAt ?? now();
            if (user.disabledAt === null)
                await store.setDisabled(userId, disabledAt, now());
            // Every time, not only the first: a session minted in a race with an
            // earlier call ends here too.
            await store.deleteUserSessions(userId);
            return toAuthUser({ ...user, disabledAt });
        },
        async enableUser(userId) {
            const user = await store.findUserById(userId);
            if (user === undefined)
                return undefined;
            if (user.disabledAt !== null)
                await store.setDisabled(userId, null, now());
            return toAuthUser({ ...user, disabledAt: null });
        },
        verifyCredentials,
        checkPassword,
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
 *   top-level navigation back from Ward's login page, which breaks
 *   the return hop.
 * - **`Secure`** unless the app's public origin is plain HTTP on loopback —
 *   see `secureCookiesFor`.
 * - **`Path=` the app's API prefix, as the browser sees it.** Scoped, so the
 *   cookie is not sent to every other app on the shared origin. Every request
 *   that needs the session — WebSocket upgrades and `<img>` fetches included —
 *   must live under that path. It is the *browser's* path: when the reverse
 *   proxy strips a prefix before Fastify sees the request, the cookie must
 *   still carry the public one, or the browser never sends it.
 *
 * ## One value per name, or the library acts on none
 *
 * The library sets each of its cookies once, at one path, so it expects one
 * value per name. When a request carries the session cookie, or the Ward flow
 * cookie, more than once, the browser's order says nothing about which value
 * is the library's (RFC 6265 only recommends an order), so the request is
 * acted on as if it carried none, as Ward does with its own cookies:
 *
 * - the guard and `GET <prefix>/session` treat it as signed out, and clear
 *   nothing: the library cannot tell which copy is its own;
 * - a sign-in (`POST <prefix>/login`, a Ward sign-in) finds no earlier session
 *   to replace, and a link or reauthentication callback finds no session to
 *   finish for;
 * - the Ward callback finds no flow, and lands as `invalid_callback`;
 * - `POST <prefix>/logout` ends the session of **every** value it carries,
 *   then clears the cookie, so signing out ends the person's own session
 *   whichever copy is theirs.
 *
 * `readCookie` is the one reader of that rule; `readCookies` returns every
 * value, for logout.
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
    const parts = [`${options.name}=${options.value}`, `Path=${options.path}`, "HttpOnly", "SameSite=Lax"];
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
 * Every non-empty value a `Cookie` request header carries for `name`, in
 * header order.
 *
 * A browser sends every stored cookie whose path and domain match, so the same
 * name can appear more than once. Nothing picks one of them by position: a
 * reader that acts on one value goes through `readCookie`, which takes none
 * when there are several, and `POST <prefix>/logout` uses this list to end
 * every session it names (see the header).
 *
 * A cleared cookie can still be presented by a client that ignored the
 * expiry; an empty value is treated as absent rather than as a token.
 */
function readCookies(header, name) {
    if (header === undefined)
        return [];
    const values = [];
    const flat = Array.isArray(header) ? header.join("; ") : header;
    for (const pair of flat.split(";")) {
        const eq = pair.indexOf("=");
        if (eq === -1)
            continue;
        if (pair.slice(0, eq).trim() !== name)
            continue;
        const value = pair.slice(eq + 1).trim();
        if (value.length > 0)
            values.push(value);
    }
    return values;
}
/**
 * The value a `Cookie` request header carries for `name` when it carries
 * exactly one, otherwise `undefined`.
 *
 * The library sets each of its cookies once, at one path, so it expects one
 * value; with more than one, the header's order says nothing about which is
 * the library's. Taking none is the rule every reader of the session and flow
 * cookies follows (see the header). A caller that has to tell "none" from
 * "several" apart reads `readCookies`.
 */
function readCookie(header, name) {
    const values = readCookies(header, name);
    return values.length === 1 ? values[0] : undefined;
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
    const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1" || host.startsWith("127.");
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
 * ## Attempts still in flight count
 *
 * The budget is recorded failures **plus attempts still running**. A route
 * whose verdict waits on a password hash or a store call takes one of the
 * address's five slots at the gate (`reserveAttempt`) and holds it until the
 * attempt ends, so twenty requests sent at once from one address get five
 * verdicts and fifteen `429`s, not twenty verdicts.
 *
 * ## Per-surface budgets
 *
 * Login, registration, password change and rename hold **independent**
 * budgets. Spending the password-change budget (which needs a session first)
 * must never lock the same address out of login, which is how the person would
 * recover, and a registration flood must not stop existing users signing in.
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
 *
 * Its two imports, `node:net`'s `isIP` and `node:crypto`'s `createHash`, have
 * no side effects.
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
 * addresses only evicts other addresses' counters, which gains the flooder
 * nothing over the attempts they already have.
 *
 * Every key is ASCII and bounded, so the cap bounds bytes too: a counter's key
 * is at most 40 characters for any address `lockoutKeyFor` derives
 * (`bucketKey`), an account's exactly 24 (`accountKey`), however long the
 * submitted name. With the five named accounts the gate lets one counter hold
 * at a time, 10 000 entries carry at most 10 000 × (40 + 5 × 24) = 1.6 MB of
 * key text; even at `LOCKOUT_MAX_ACCOUNTS_PER_ADDRESS` it is
 * 10 000 × (40 + 32 × 24) ≈ 8.1 MB, before the maps' own overhead.
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
/**
 * Each lockout's failure map, read by `lockoutStoredKeyLengthForTests` alone.
 * Weak, so a dropped lockout is collected as before.
 */
const storedEntries = new WeakMap();
/** Reserved breakdown key past `LOCKOUT_MAX_ACCOUNTS_PER_ADDRESS`. */
const OVERFLOW_ACCOUNT_KEY = "+";
/**
 * The bucket key. NUL cannot appear in a surface or an address, so no address
 * can be crafted to land in another surface's bucket.
 */
function bucketKey(target) {
    return `${target.surface}\u0000${addressGroup(target.address)}`;
}
/**
 * The part of an address its budget belongs to: an IPv4 address whole, an
 * IPv6 address by its /64.
 *
 * One IPv6 host is routinely handed a whole /64 and picks its own address
 * inside it (privacy addresses rotate on their own), so keyed on all 128 bits
 * one machine could give every request a fresh address and never meet the
 * fifth failure. A /64 is the smallest subnet address autoconfiguration
 * works in, so a home or a server that has IPv6 at all holds at least one.
 * Every address in it shares one budget, in whatever spelling it arrives
 * (`2001:db8:1:2::a` and `2001:0db8:1:2:0:0:0:a` are one key).
 *
 * Only the counter is grouped. `lockoutKeyFor` still returns the full address,
 * which is what the trusted-peer check compares and what an app logs. An
 * IPv4-mapped address is the IPv4 address it carries, never the mapped
 * prefix's /64: grouped by that, every IPv4 client would share one budget. A
 * string that is not an address is its own key, unchanged.
 */
function addressGroup(address) {
    const bytes = addressBytes(address);
    if (bytes === undefined)
        return address;
    const ipv4 = bytes.length === 4 ? bytes : mappedIpv4(bytes);
    if (ipv4 !== undefined)
        return ipv4.join(".");
    return `${formatBytes(bytes.slice(0, 8))}::/64`;
}
/**
 * The breakdown key. Named accounts are prefixed so a username — arbitrary
 * user input — can never collide with the reserved `"*"` (no account named)
 * and `"+"` (overflow) buckets.
 *
 * The name is stored as a digest, never as text: the first 128 bits of its
 * SHA-256, 22 base64url characters, so every named key is 24 characters.
 * A submitted username is capped before folding, and NFKC can lengthen it
 * eighteenfold (U+FDFA folds to 18 characters), so stored as text one failed
 * login could pin kilobytes per name. Cut to a fixed length instead, two long
 * names sharing their first characters would become one account, and a success
 * as one would forgive the failures aimed at the other; at 128 bits two names
 * never meet by accident. `recordFailure` and `clearFailures` both come here,
 * so the digest a failure is filed under is the one a success subtracts.
 */
function accountKey(target) {
    if (target.account === undefined)
        return "*";
    const digest = createHash("sha256").update(target.account).digest().subarray(0, 16);
    return `a:${digest.toString("base64url")}`;
}
function createLockout(options = {}) {
    // Wrapped rather than captured, so a test's fake clock is seen.
    const now = options.now ?? (() => Date.now());
    /**
     * Insertion-ordered, which makes eviction an O(1) `next()` on the iterator
     * rather than a scan for the oldest key.
     */
    const entries = new Map();
    /**
     * Attempts let through by `reserveAttempt` that have not ended yet, by the
     * same key as `entries`.
     *
     * Kept apart from `entries` on purpose: a slot is not a failure, so it never
     * slides a window, never takes a place under `LOCKOUT_MAX_ENTRIES`, and
     * evicting or expiring a failure entry cannot lose one. A key is here only
     * while a request holding it is running, so the map is never larger than the
     * number of requests in flight.
     */
    const inFlight = new Map();
    function check(target) {
        const at = now();
        const key = bucketKey(target);
        let entry = entries.get(key);
        if (entry !== undefined && entry.expiresAt <= at) {
            entries.delete(key);
            entry = undefined;
        }
        const failures = entry?.failures ?? 0;
        if (failures + (inFlight.get(key) ?? 0) < LOCKOUT_MAX_FAILURES)
            return { allowed: true };
        // Refused only because of attempts still running: they end in tens of
        // milliseconds, and if they fail the next request meets the full window
        // anyway, so a second is the honest wait.
        if (entry === undefined || failures < LOCKOUT_MAX_FAILURES)
            return { allowed: false, retryAfterSeconds: 1 };
        // `Math.max(1, ...)` because `Retry-After: 0` reads as "retry immediately",
        // and a sub-second remainder floors to zero.
        const retryAfterSeconds = Math.max(1, Math.ceil((entry.expiresAt - at) / 1000));
        return { allowed: false, retryAfterSeconds };
    }
    function reserveAttempt(target) {
        const decision = check(target);
        if (!decision.allowed)
            return { allowed: false, retryAfterSeconds: decision.retryAfterSeconds ?? 1 };
        const key = bucketKey(target);
        inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
        const { surface, address } = target;
        const withAccount = (account) => account === undefined ? { surface, address } : { surface, address, account };
        let open = true;
        // Gives the slot back, once. The bookkeeping lives here so `fail` and
        // `succeed` cannot double-count it either.
        const end = () => {
            if (!open)
                return false;
            open = false;
            const remaining = (inFlight.get(key) ?? 0) - 1;
            if (remaining > 0)
                inFlight.set(key, remaining);
            else
                inFlight.delete(key);
            return true;
        };
        return {
            allowed: true,
            attempt: {
                fail: (account) => {
                    // Slot out, failure in, in one synchronous step: the budget the next
                    // check reads never dips in between.
                    if (end())
                        recordFailure(withAccount(account));
                },
                succeed: (account) => {
                    if (end())
                        clearFailures(withAccount(account));
                },
                release: () => {
                    end();
                },
            },
        };
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
    const lockout = { check, reserveAttempt, recordFailure, clearFailures, size: () => entries.size };
    storedEntries.set(lockout, entries);
    return lockout;
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
 * request and the whole internet shared one counter — Ward's outage of 2026-10-13.
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
    const forwarded = lastForwardedElement(forwardedFor);
    if (peer !== undefined && !isTrustedPeer(peer, options.trustedProxies ?? [])) {
        if (forwarded !== undefined)
            warnIgnoredForwarded(options.warn, peer);
        return peer;
    }
    // Only an address is a client. The proxy appends the address it saw, so a
    // last element that is anything else (a name, `unknown`, a port glued on)
    // did not come from it, and keying on it would let whoever wrote it name the
    // counter and the address an app logs. Such a request is keyed as if nothing
    // was forwarded. Never an earlier element instead: those are the client's
    // own.
    if (forwarded !== undefined && isIP(forwarded) !== 0) {
        return forwarded;
    }
    // No usable address at all — a trusted caller with no forwarding header or
    // one whose last element is not an address, a Unix socket, or a peer the
    // runtime did not report. One shared bucket is the safe fallback: it
    // throttles rather than letting the attempt through uncounted. Say so, once
    // per interval.
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
    // nobody; it becomes its own bucket, which is the behaviour from before trusted proxies.
    if (parsed === undefined)
        return false;
    // `normaliseAddress` already unwraps both mapped spellings; this keeps the
    // check right for a peer that did not come through it.
    const bytes = mappedIpv4(parsed) ?? parsed;
    return LOOPBACK.some((range) => inRange(bytes, range)) || trusted.some((range) => inRange(bytes, range));
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
        "proxy (or unreported) and no X-Forwarded-For address arrived, so every caller now shares one " +
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
/**
 * The last non-blank `X-Forwarded-For` element, normalised. Not yet known to
 * be an address: `lockoutKeyFor` checks that, so an untrusted peer that sent
 * any header at all is still warned about.
 */
function lastForwardedElement(forwardedFor) {
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
 * Trim, lowercase, strip brackets and an IPv6 zone, and unwrap an IPv4-mapped
 * address in either spelling.
 *
 * `::ffff:127.0.0.1`, `::ffff:7f00:1` and `127.0.0.1` are the same address and
 * must not be three counters, or one client gets three budgets by choosing how
 * to write its address. The same normalisation is why an IPv4-mapped peer
 * matches an IPv4 trusted range. Anything else keeps its full text: an IPv6
 * address is grouped into its /64 only where the counter is keyed
 * (`addressGroup`), never here.
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
    // An IPv6 scope id (`fe80::1%eth0`) is not part of the address identity.
    // Stripped before the mapped check, so a mapped address with a zone unwraps.
    const percent = value.indexOf("%");
    if (percent !== -1)
        value = value.slice(0, percent);
    // Read as bytes, so the dotted (`::ffff:203.0.113.9`) and the hex
    // (`::ffff:cb00:7109`) spellings unwrap alike.
    const bytes = addressBytes(value);
    const mapped = bytes === undefined ? undefined : mappedIpv4(bytes);
    if (mapped !== undefined)
        value = mapped.join(".");
    return value.length > 0 ? value : undefined;
}

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
    {
        version: 4,
        name: "user_disabled_at",
        sql: `
      -- When the app switched this user off (0.6.0, Accounts.disableUser).
      -- Epoch milliseconds on the app's clock; NULL for an active user, so
      -- every existing row migrates active. A disabled user is refused
      -- wherever a user gets in, with the answer an unknown one gets.
      ALTER TABLE auth_users ADD COLUMN disabled_at INTEGER;
    `,
    },
    {
        version: 5,
        name: "username_skeleton",
        sql: `
      -- usernameSkeleton(username) (1.1.0): what the name looks like, as a
      -- key. A new name or a rename whose key another user already has is
      -- taken. Indexed, not UNIQUE: users that already share a key when
      -- this runs all stay. NULL only for a row written outside the
      -- library; every library write sets it, and the run step below fills
      -- every existing row.
      ALTER TABLE auth_users ADD COLUMN username_skeleton TEXT;
      CREATE INDEX auth_users_username_skeleton ON auth_users (username_skeleton);
    `,
        run: fillUsernameSkeletons,
    },
];
/**
 * Migration 5's step: give every existing user its username key. It changes
 * nothing else on the row, `updated_at` included: the user did not change.
 *
 * Users that share a key when this runs (an `alice` and a Cyrillic `аlice`)
 * all stay as they are, and each such group gets one warning, naming the
 * users' ids, on the boot that runs this. Whether they are
 * one person is the app owner's call; from then on no new user or rename can
 * take that key, so a group never grows. To list the groups later:
 *
 *     SELECT username_skeleton, group_concat(id, ' ')
 *       FROM auth_users GROUP BY username_skeleton HAVING count(*) > 1;
 */
function fillUsernameSkeletons(db) {
    const rows = db.prepare("SELECT id, username FROM auth_users ORDER BY created_at, id").all();
    const fill = db.prepare("UPDATE auth_users SET username_skeleton = ? WHERE id = ?");
    const holders = new Map();
    for (const row of rows) {
        const key = usernameSkeleton(row.username);
        fill.run(key, row.id);
        holders.set(key, [...(holders.get(key) ?? []), row.id]);
    }
    for (const ids of holders.values()) {
        if (ids.length < 2)
            continue;
        console.warn(`ward-auth: ${ids.length} users have usernames that read the same (ids ${ids.join(", ")}). ` +
            `They stay as they are, and no new user or rename can take that name. ` +
            `If they are not one person, rename one of them.`);
    }
}

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
/**
 * Thrown by `createUser` and `setUsername` when another user holds the folded
 * username, or a name that reads the same (the same `usernameSkeleton`, 1.1.0).
 */
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
 * own savepoint, in order: its SQL, then its `run` step if it has one.
 * Idempotent: a second call applies nothing.
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
    const known = migrations.at(-1)?.version ?? 0;
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
            migration.run?.(db);
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
        disabledAt: row.disabled_at === null ? null : Number(row.disabled_at),
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
        usersBySkeleton: db.prepare("SELECT * FROM auth_users WHERE username_skeleton = ? ORDER BY created_at, id"),
        otherWithSkeleton: db.prepare("SELECT 1 FROM auth_users WHERE username_skeleton = ? AND id <> ? LIMIT 1"),
        insertUser: db.prepare(`INSERT INTO auth_users (id, username, username_folded, username_skeleton, password_hash, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
        setPasswordHash: db.prepare("UPDATE auth_users SET password_hash = ?, updated_at = ? WHERE id = ?"),
        setRole: db.prepare("UPDATE auth_users SET role = ?, updated_at = ? WHERE id = ?"),
        setUsername: db.prepare("UPDATE auth_users SET username = ?, username_folded = ?, username_skeleton = ?, updated_at = ? WHERE id = ?"),
        setDisabled: db.prepare("UPDATE auth_users SET disabled_at = ?, updated_at = ? WHERE id = ?"),
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
        s.insertUser.run(user.id, user.username, user.usernameFolded, user.usernameSkeleton, user.passwordHash, user.role, user.createdAt, user.createdAt);
        refuseSkeletonHeldByAnother(user.usernameSkeleton, user.id);
        return toUser(s.userById.get(user.id));
    }
    /**
     * The look-alike rule: throws `UsernameTakenError` when a user other than
     * `userId` has this key. Called after the write, inside the caller's
     * savepoint, so the write has taken SQLite's write lock and no other
     * connection's write lands between the two; a throw rolls the write back.
     * The column is not UNIQUE, because users that shared a key when migration
     * 5 ran all stay, so this is a lookup rather than a constraint.
     */
    function refuseSkeletonHeldByAnother(usernameSkeleton, userId) {
        if (s.otherWithSkeleton.get(usernameSkeleton, userId) !== undefined)
            throw new UsernameTakenError();
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
        findUsersByUsernameSkeleton(usernameSkeleton) {
            return s.usersBySkeleton.all(usernameSkeleton).map(toUser);
        },
        setPasswordHash(userId, passwordHash, now) {
            s.setPasswordHash.run(passwordHash, now, userId);
        },
        setRole(userId, role, now) {
            s.setRole.run(role, now, userId);
        },
        setUsername(userId, username, usernameFolded, usernameSkeleton, now) {
            inSavepoint(db, () => {
                // Checked rather than caught, for the reason `insertUser` gives.
                const holder = s.userByFolded.get(usernameFolded);
                if (holder !== undefined && holder.id !== userId)
                    throw new UsernameTakenError();
                s.setUsername.run(username, usernameFolded, usernameSkeleton, now, userId);
                refuseSkeletonHeldByAnother(usernameSkeleton, userId);
            });
        },
        setDisabled(userId, disabledAt, now) {
            s.setDisabled.run(disabledAt, now, userId);
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
        if (error instanceof ClientError && error.code === "OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED") {
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
    if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
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
    const clientId = env["WARD_OIDC_CLIENT_ID"]?.trim() ?? "";
    const clientKey = env["WARD_OIDC_CLIENT_KEY"]?.trim() ?? "";
    const redirectUri = env["WARD_OIDC_REDIRECT_URI"]?.trim() ?? "";
    const missing = Object.entries({
        WARD_OIDC_CLIENT_ID: clientId,
        WARD_OIDC_CLIENT_KEY: clientKey,
        WARD_OIDC_REDIRECT_URI: redirectUri,
    })
        .filter(([, value]) => value === "")
        .map(([name]) => name);
    if (missing.length > 0) {
        throw new TypeError(`WARD_OIDC_ISSUER is set but ${missing.join(", ")} is not`);
    }
    const postLogout = env["WARD_OIDC_POST_LOGOUT_REDIRECT_URI"]?.trim();
    return {
        issuer,
        clientId,
        clientKey,
        redirectUri,
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
 *    from `preferred_username` (shaped by the app's `usernameFor`, suffixed if
 *    the name is taken) and holding the role the grant names.
 *
 * **Never by username.** A local `alice` and a Ward `alice` are strangers
 * until alice links them herself. On a shared origin anything else is account
 * takeover: whoever controls the Ward account named `alice` would walk into
 * the local one.
 *
 * After creation the local row owns the role. Ward's grant decides whether a
 * Ward account may get in at all; what it may do inside is the app's.
 *
 * A linked user the app has disabled (0.6.0) is refused at rule 1, and the
 * sign-in stops there: it never falls through to rule 3, which would hand the
 * same Ward account a fresh user the app never switched off.
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
/**
 * The shortest `usernameMaxLength` accepted. The last-resort name is a letter,
 * `-` and eight hex digits, so this is the least that still starts with a
 * letter.
 */
const MIN_USERNAME_MAX_LENGTH = 10;
/** Whether `value` can be a `usernameMaxLength`: a whole number from 10 to 256. */
function isUsernameMaxLength(value) {
    return (typeof value === "number" &&
        Number.isInteger(value) &&
        value >= MIN_USERNAME_MAX_LENGTH &&
        value <= MAX_USERNAME_LENGTH);
}
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
        const passwordHash = input.password === undefined || input.password === null ? null : await hashPassword(input.password);
        const created = await store.createUserWithWardLink({
            id: input.id ?? generateUserId(),
            username,
            usernameFolded: foldUsername(username),
            usernameSkeleton: usernameSkeleton(username),
            passwordHash,
            role: input.role,
            createdAt: now(),
        }, input.subject);
        return toAuthUser(created);
    }
    async function userForSignIn(identity, roleFor = (role) => role, usernameFor, usernameMaxLength = MAX_USERNAME_LENGTH) {
        if (!isUsernameMaxLength(usernameMaxLength)) {
            throw new TypeError(`userForSignIn: usernameMaxLength must be a whole number from ${MIN_USERNAME_MAX_LENGTH} to ${MAX_USERNAME_LENGTH}`);
        }
        const linked = await findUserBySubject(identity.subject);
        if (linked !== undefined) {
            if (linked.disabled)
                throw new UserDisabledError();
            return { user: linked, created: false };
        }
        const role = roleFor(identity.role);
        const preferred = usernameFor === undefined
            ? identity.username
            : usernameFor({ username: identity.username, subject: identity.subject });
        if (typeof preferred !== "string") {
            throw new TypeError("userForSignIn: usernameFor must return a string");
        }
        for (const username of candidateUsernames(preferred, usernameMaxLength)) {
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
                    if (winner?.disabled === true)
                        throw new UserDisabledError();
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
 * Names to try for a new Ward user: `preferred_username` as Ward has it (or
 * as the app's `usernameFor` shaped it), then `name-2`, `name-3`, …, then a
 * random suffix, then `ward-user-<random>`. A name that fails the local policy
 * (Ward's rules are not this library's) falls back to `ward-user`. Every name
 * yielded passes the policy, so a strange `preferred_username` can cost a
 * person their preferred name, never their sign-in.
 *
 * ## `maxLength`, and why the hook is not run again on each candidate
 *
 * Every name yielded is at most `maxLength` UTF-16 units: the base is cut to
 * it, and a suffix takes its room from the base, so an app that stores 16
 * characters gets `alice.smith-wi-2`, not `alice.smith-with-2`. The
 * alternative, running `usernameFor` again on each suffixed name, fails for
 * the hook most apps write: one that cuts to a length cuts the suffix off
 * again, every `-2` folds back into the taken base, and the person ends up as
 * `ward-user-…`. A hook can't tell the base from the suffix; the library can.
 * The suffixes are `-`, digits and lowercase hex, which survive a hook that
 * lowercases, so they keep that shape too.
 */
function* candidateUsernames(preferred, maxLength) {
    const seen = new Set();
    for (const name of rawCandidates(preferred, maxLength)) {
        const valid = validUsername(name);
        if (valid === undefined || seen.has(valid))
            continue;
        seen.add(valid);
        yield valid;
    }
}
function* rawCandidates(preferred, maxLength) {
    const valid = validUsername(preferred);
    const base = valid === undefined ? FALLBACK_USERNAME : withSuffix(valid, "", maxLength);
    yield base;
    for (let n = 2; n <= MAX_NAME_SUFFIX; n += 1)
        yield withSuffix(base, `-${n}`, maxLength);
    for (let attempt = 0; attempt < 5; attempt += 1) {
        yield withSuffix(base, `-${generateUserId().slice(0, 8)}`, maxLength);
    }
    // Whatever the base was, these always fit the policy.
    for (let attempt = 0; attempt < 5; attempt += 1) {
        yield withSuffix(FALLBACK_USERNAME, `-${generateUserId().slice(0, 8)}`, maxLength);
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
 * `base` cut to leave room for `suffix` within `maxLength` UTF-16 units, then
 * the suffix. Cut by code point, never through a surrogate pair, and with any
 * trailing space dropped (a cut can land just after one, and `name -2` is not
 * the name with a suffix).
 */
function withSuffix(base, suffix, maxLength) {
    const room = maxLength - suffix.length;
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
/** A Ward link's or unlink's body: the account's current password, and nothing else read. */
function currentPasswordBody(body) {
    if (typeof body !== "object" || body === null)
        return undefined;
    const { currentPassword } = body;
    if (typeof currentPassword !== "string")
        return undefined;
    if (currentPassword.length === 0 || currentPassword.length > MAX_PASSWORD_LENGTH)
        return undefined;
    return { currentPassword };
}
/** A rename's body. The name's rules are the policy's, answered with its code. */
function usernameBody(body) {
    if (typeof body !== "object" || body === null)
        return undefined;
    const { username } = body;
    if (typeof username !== "string")
        return undefined;
    return { username };
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
 * The one rule for a path the library sends a browser to: the configured
 * pages, `returnTo`, and since 0.7.0 the `ward_return_to` a refused sign-in
 * carries back. Framework-free, so the browser bundle checks a path from the
 * address bar with the same rule the server checked it with.
 */
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
/**
 * The most link starts held for their callback at once. Each one needed the
 * account's password, so an app holds a handful; the cap keeps the map
 * bounded whatever happens. The oldest goes first.
 */
const MAX_PENDING_LINKS = 1000;
/** Check the `ward` option at boot. Every path is a browser path on the app's origin. */
function validateWardOptions(ward, cookiePath, routePrefix) {
    for (const name of ["loginPath", "settingsPath", "afterSignInPath"]) {
        if (!isLocalPath(ward[name])) {
            throw new TypeError(`wardAuth: ward.${name} must be a path on the app's origin, like "/myapp/login"`);
        }
    }
    if (ward.usernameFor !== undefined && typeof ward.usernameFor !== "function") {
        throw new TypeError("wardAuth: ward.usernameFor must be a function");
    }
    if (ward.usernameMaxLength !== undefined && !isUsernameMaxLength(ward.usernameMaxLength)) {
        throw new TypeError(`wardAuth: ward.usernameMaxLength must be a whole number from ${MIN_USERNAME_MAX_LENGTH} to ${MAX_USERNAME_LENGTH}`);
    }
    const callback = new URL(ward.client.redirectUri).pathname;
    const expectedTail = `${routePrefix}/ward/callback`;
    const underCookiePath = callback === cookiePath || callback.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`);
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
            return status.active ? { ok: true } : { ok: false, reason: "ward_session_ended", endSession: true };
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
    /**
     * The link starts that carried the account's password (`POST /ward/link`),
     * by their flow's `state`: the session that started each one, and when it
     * lapses. The callback finishes a link only for a start held here, and
     * takes it. In memory, like the lockout: a link still waiting for its
     * callback when the app restarts lands as `invalid_callback`, and the
     * person starts it again.
     */
    const pendingLinks = new Map();
    function holdLink(state, sessionIdHash) {
        const at = now();
        for (const [held, pending] of pendingLinks) {
            if (pending.expiresAt <= at)
                pendingLinks.delete(held);
        }
        if (pendingLinks.size >= MAX_PENDING_LINKS) {
            const oldest = pendingLinks.keys().next();
            if (oldest.done !== true)
                pendingLinks.delete(oldest.value);
        }
        pendingLinks.set(state, { sessionIdHash, expiresAt: at + FLOW_MAX_AGE_SECONDS * 1000 });
    }
    /** Whether the flow's start is held, for its session, and not lapsed. Takes it either way. */
    function takeLink(flow) {
        const pending = pendingLinks.get(flow.state);
        if (pending === undefined)
            return false;
        pendingLinks.delete(flow.state);
        return pending.expiresAt > now() && pending.sessionIdHash === flow.sessionIdHash;
    }
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
        // Only `POST /ward/link` starts a link, and only after the password.
        if (mode === "link" && extra.sessionIdHash !== undefined)
            holdLink(flow.state, extra.sessionIdHash);
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
    /**
     * Where a failed round trip lands: a sign-in on the login page, carrying
     * the start's `returnTo` as `ward_return_to`; a link or reauthentication on
     * settings.
     */
    function landFailure(reply, flow, code) {
        if (flow.mode !== "sign_in")
            return land(reply, ward.settingsPath, { ward_error: code });
        const query = { ward_error: code };
        if (flow.returnTo !== undefined && isLocalPath(flow.returnTo)) {
            query["ward_return_to"] = flow.returnTo;
        }
        return land(reply, ward.loginPath, query);
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
    /**
     * The live session the request's cookie names, without running the checks.
     * None when the request carries the cookie more than once (`core/cookie.ts`).
     */
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
    /**
     * Hear the account's current password again, from the body's
     * `currentPassword`, as `POST <prefix>/password` does. `undefined` when it is
     * right; otherwise the refusal for the route to send: `400 invalid_request`
     * without one, `401 invalid_credentials` for a wrong one, which fails the
     * attempt. It answers data, not a sent reply: a reply is a thenable, so an
     * async function that returns one resolves to `undefined`.
     */
    async function passwordRefusal(request, user, attempt) {
        const body = currentPasswordBody(request.body);
        if (body === undefined)
            return { status: 400, error: "invalid_request" };
        const account = foldUsername(user.username);
        if (!(await accounts.checkPassword(user.id, body.currentPassword))) {
            attempt.fail(account);
            return { status: 401, error: "invalid_credentials" };
        }
        attempt.succeed(account);
        return undefined;
    }
    /**
     * Link Ward: `{ currentPassword }`, the account's local password. Checked
     * under the password-change budget, with a slot held until the attempt
     * ends, as `POST <prefix>/password` holds one. A `409` judges no credential,
     * so it, like a missing password, ends through `release`.
     */
    routes.post("/ward/link", async (request, reply) => {
        if (!sameOrigin(request, publicOrigin))
            return crossSite(reply);
        const auth = request.auth;
        if (auth === null)
            return reply.code(401).send({ error: "unauthorized" });
        const gate = context.lockout.reserveAttempt({ surface: "change_password", address: context.lockoutKey(request) });
        if (!gate.allowed)
            return tooManyAttempts(reply, gate.retryAfterSeconds);
        const { attempt } = gate;
        try {
            if ((await identities.subjectOf(auth.user.id)) !== undefined) {
                return reply.code(409).send({ error: "already_linked" });
            }
            // No password to ask for. A user created from Ward is linked, and
            // answered above; this is one the app created without a password.
            if (!auth.user.hasPassword)
                return reply.code(409).send({ error: "no_local_password" });
            const refusal = await passwordRefusal(request, auth.user, attempt);
            if (refusal !== undefined)
                return reply.code(refusal.status).send({ error: refusal.error });
            return await start(reply, "link", { sessionIdHash: auth.session.idHash });
        }
        finally {
            attempt.release();
        }
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
            return landFailure(reply, flow, failure.code);
        }
        try {
            return await finishCallback(request, reply, flow, identity);
        }
        catch (error) {
            // A top-level navigation: a raw 500 JSON page helps nobody. Log it and
            // send the person back where they can try again.
            request.log.error({ err: error }, "Ward callback failed after the code exchange");
            return landFailure(reply, flow, "sign_in_failed");
        }
    });
    /** The callback after a verified code exchange: act on the flow's mode. */
    async function finishCallback(request, reply, flow, identity) {
        if (flow.mode === "sign_in") {
            let user;
            try {
                ({ user } = await identities.userForSignIn(identity, ward.roleFor, ward.usernameFor, ward.usernameMaxLength));
            }
            catch (error) {
                // The app disabled the linked user (0.6.0). The answer Ward gives when
                // it refuses a sign-in itself, so a switched-off user and one with no
                // grant look the same, and no error is logged for a deliberate no.
                if (error instanceof UserDisabledError)
                    return landFailure(reply, flow, "access_denied");
                throw error;
            }
            // Signing in on top of an old session replaces it, as a password sign-in
            // does; with the cookie there more than once, there is none to replace.
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
            if (!takeLink(flow)) {
                request.log.warn("Ward link refused: no link start that carried the password is waiting for this callback");
                return land(reply, ward.settingsPath, { ward_error: "invalid_callback" });
            }
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
     * Unlink Ward: `{ currentPassword }`, checked as a link checks it. Refused
     * while the user has no local password, which would lock them out, and
     * then whatever the body says. Ends every Ward-originated session the user
     * holds — this one too, if it began with Ward — and says so:
     * `{ signedOut: true }` means the person must now sign in with their
     * password.
     */
    routes.post("/ward/unlink", async (request, reply) => {
        if (!sameOrigin(request, publicOrigin))
            return crossSite(reply);
        const auth = request.auth;
        if (auth === null)
            return reply.code(401).send({ error: "unauthorized" });
        const gate = context.lockout.reserveAttempt({ surface: "change_password", address: context.lockoutKey(request) });
        if (!gate.allowed)
            return tooManyAttempts(reply, gate.retryAfterSeconds);
        const { attempt } = gate;
        try {
            // The two `409`s first, in the order `identities.unlink` answers them,
            // so nothing is asked of a user who could not unlink anyway.
            if ((await identities.subjectOf(auth.user.id)) === undefined) {
                return reply.code(409).send({ error: "not_linked" });
            }
            if (!auth.user.hasPassword)
                return reply.code(409).send({ error: "no_local_password" });
            const refusal = await passwordRefusal(request, auth.user, attempt);
            if (refusal !== undefined)
                return reply.code(refusal.status).send({ error: refusal.error });
            try {
                await identities.unlink(auth.user.id);
            }
            catch (error) {
                // Unlinked, or the password gone, since the checks above.
                if (error instanceof NoLocalPasswordError || error instanceof NotLinkedError) {
                    return reply.code(409).send({ error: error.code });
                }
                throw error;
            }
            const signedOut = auth.session.origin === "ward";
            if (signedOut)
                reply.header("set-cookie", context.clearedSessionCookie());
            return reply.code(200).send({ signedOut });
        }
        finally {
            attempt.release();
        }
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
        // The password-change budget, with a slot held until the attempt ends, as
        // `POST <prefix>/password` holds one. Only a wrong current password fails
        // it; a first password set after a reauthentication judges no credential,
        // so that branch, like a malformed body, ends through `release`.
        const address = context.lockoutKey(request);
        const gate = context.lockout.reserveAttempt({ surface: "change_password", address });
        if (!gate.allowed)
            return tooManyAttempts(reply, gate.retryAfterSeconds);
        const { attempt } = gate;
        try {
            const body = setPasswordBody(request.body);
            if (body === undefined)
                return reply.code(400).send({ error: "invalid_request" });
            if (auth.user.hasPassword) {
                if (body.currentPassword === undefined) {
                    return reply.code(400).send({ error: "invalid_request" });
                }
                const account = foldUsername(auth.user.username);
                const changed = await accounts.changePassword(auth.user.id, body.currentPassword, body.newPassword, auth.session.idHash);
                if (!changed) {
                    attempt.fail(account);
                    return reply.code(401).send({ error: "invalid_credentials" });
                }
                attempt.succeed(account);
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
        finally {
            attempt.release();
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
        const idToken = auth.session.origin === "ward" ? await store.findSessionWardIdToken(auth.session.idHash) : undefined;
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
        wardSessionValidator(options.ward === undefined || identities === undefined ? undefined : { client: options.ward.client, identities }),
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
     *
     * A request carrying the cookie more than once is signed out, whichever
     * value would resolve, and nothing is cleared (`readCookie`,
     * `core/cookie.ts`).
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
            // Takes one of the address's five slots until this attempt ends, so
            // requests sent together cannot all reach the hash before the first
            // failure is recorded (`Lockout.reserveAttempt`).
            const address = lockoutKey(request);
            const gate = lockout.reserveAttempt({ surface: "login", address });
            if (!gate.allowed)
                return tooManyAttempts(reply, gate.retryAfterSeconds);
            const { attempt } = gate;
            // Every way out below ends the attempt; this frees the slot of the ones
            // that end without a verdict (a malformed body, a thrown error).
            try {
                const body = credentialsBody(request.body);
                if (body === undefined) {
                    // Not a lockout failure: a malformed body is a client bug, not a
                    // guess. And terse: echoing the fields back would echo the password.
                    return reply.code(400).send({ error: "invalid_request" });
                }
                // Folded from the *submitted* name, so a guess at an account that
                // does not exist still gets its own bucket, which a success as some
                // other account must not forgive.
                const account = foldUsername(body.username);
                const user = await accounts.verifyCredentials(body.username, body.password);
                if (user === undefined) {
                    attempt.fail(account);
                    // One answer for "no such user" and "wrong password".
                    return reply.code(401).send({ error: "invalid_credentials" });
                }
                attempt.succeed(account);
                // Signing in on top of an old session replaces it rather than leaving
                // a second live row behind. A request carrying the cookie more than
                // once has no earlier session to replace (`core/cookie.ts`).
                const previous = readCookie(request.headers.cookie, cookieName);
                if (previous !== undefined)
                    await accounts.endSession(previous);
                await accounts.deleteExpiredSessions();
                const { token, session } = await accounts.startSession(user.id);
                reply.header("set-cookie", sessionCookie(token, session.expiresAt));
                return reply.code(200).send(await sessionBody(user, session));
            }
            finally {
                attempt.release();
            }
        });
        /**
         * Answers `204` whatever was presented. The cookie is cleared **only when
         * one was presented**: a cross-site page that could make the browser
         * clear it would sign the person out in a loop (Ward's finding), and the
         * same-origin check closes the rest.
         *
         * Ends the session of **every** value the request carries. With more than
         * one, the browser's order cannot say which is the library's
         * (`core/cookie.ts`), and signing out has to end the person's own session
         * whichever it is.
         */
        routes.post("/logout", async (request, reply) => {
            if (!sameOrigin(request, publicOrigin))
                return crossSite(reply);
            const tokens = new Set(readCookies(request.headers.cookie, cookieName));
            if (tokens.size > 0) {
                for (const token of tokens)
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
            const gate = lockout.reserveAttempt({ surface: "change_password", address });
            if (!gate.allowed)
                return tooManyAttempts(reply, gate.retryAfterSeconds);
            const { attempt } = gate;
            // A malformed body, a policy refusal (checked before the current
            // password is) and a thrown error end here without a verdict.
            try {
                const body = passwordChangeBody(request.body);
                if (body === undefined)
                    return reply.code(400).send({ error: "invalid_request" });
                const account = foldUsername(auth.user.username);
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
                    attempt.fail(account);
                    return reply.code(401).send({ error: "invalid_credentials" });
                }
                attempt.succeed(account);
                return reply.code(204).send();
            }
            finally {
                attempt.release();
            }
        });
        if (options.allowRename !== false) {
            /**
             * Rename oneself. Guarded, so `request.auth` is set. The id and every
             * session stay. A taken name is the one answer that says something
             * about other accounts, so each `409` counts against the address's
             * rename budget; a policy failure or a success does not.
             */
            routes.post("/username", async (request, reply) => {
                if (!sameOrigin(request, publicOrigin))
                    return crossSite(reply);
                const auth = request.auth;
                if (auth === null)
                    return reply.code(401).send({ error: "unauthorized" });
                // The rename waits on the store, so the gate holds a slot until it
                // ends. Only a taken name fails it; a success forgives nothing, so
                // it ends through `release` alone, never `succeed`.
                const address = lockoutKey(request);
                const gate = lockout.reserveAttempt({ surface: "rename", address });
                if (!gate.allowed)
                    return tooManyAttempts(reply, gate.retryAfterSeconds);
                const { attempt } = gate;
                try {
                    const body = usernameBody(request.body);
                    if (body === undefined)
                        return reply.code(400).send({ error: "invalid_request" });
                    let user;
                    try {
                        user = await accounts.renameUser(auth.user.id, body.username);
                    }
                    catch (error) {
                        if (error instanceof UsernamePolicyError) {
                            return reply.code(400).send({ error: error.code });
                        }
                        if (error instanceof UsernameTakenError) {
                            attempt.fail();
                            return reply.code(409).send({ error: "username_taken" });
                        }
                        throw error;
                    }
                    // The guard found the user a moment ago; gone now means signed out.
                    if (user === undefined)
                        return reply.code(401).send({ error: "unauthorized" });
                    return reply.code(200).send(await sessionBody(user, auth.session));
                }
                finally {
                    attempt.release();
                }
            });
        }
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
                // `check`, not `reserveAttempt`: the attempt is recorded below
                // before the first `await`, so no other request runs in between.
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

export { AlreadyLinkedError, DEFAULT_NOTIFY_TIMEOUT_MS, DEFAULT_WARD_TIMEOUT_MS, FRESH_SIGN_IN_SECONDS, InvalidClientKeyError, InvalidUserIdError, LOCKOUT_MAX_FAILURES, LOCKOUT_WINDOW_SECONDS, MAX_PASSWORD_LENGTH, MAX_USERNAME_LENGTH, MIN_PASSWORD_LENGTH, NoLocalPasswordError, NotLinkedError, PasswordPolicyError, SESSION_ABSOLUTE_SECONDS, SESSION_IDLE_SECONDS, SESSION_RENEW_INTERVAL_SECONDS, SESSION_STATUS_CACHE_SECONDS, SQLITE_MIGRATIONS, SchemaTooNewError, UserDisabledError, UserIdTakenError, UsernamePolicyError, UsernameTakenError, WardConfigurationError, WardSignInError, WardSubjectTakenError, WardUnavailableError, clearedCookie, createAccounts, createLockout, createSqliteStore, createWardClient, createWardIdentities, foldUsername, generateSessionToken, hashPassword, hashSessionToken, isUsernameMaxLength, isWardAuthStore, lockoutKeyFor, migrateSqlite, normaliseUsername, parseTrustedProxies, readCookie, requireRole, secureCookiesFor, seedUsers, serializeCookie, spendDummyHash, toAuthUser, usernameSkeleton, verifyPassword, wardAuth, wardClientOptionsFromEnv };
