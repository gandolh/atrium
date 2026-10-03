# Task 61 — A Ward outage answers 503, never "signed out"

**Filed 2026-09-25** by the improvements sweep. The code breaks D53's
fail-closed contract, and so does Ward's reference client. **Coordinate
upstream** (see What to do).

## Context

D53 has three outcomes. The 503 is the one that "must never be reported as
signed out": sending someone to a login page when the identity service is down
"produces a loop that looks like a rejected password". The guard implements this
for **introspection** failures
([`ward.guard.ts:126-129`](../../../apps/api/src/modules/ward/ward.guard.ts)).
It does not for **key-fetch** failures.

[`ward.client.ts:137-159`](../../../apps/api/src/modules/ward/ward.client.ts)
turns *every* failure of `jwtVerify` into a 401:

```ts
} catch (cause) {
  throw new WardAuthenticationError("access token is not valid", { cause });
}
```

`jwtVerify` resolves keys through jose's remote key set, created with
`cacheMaxAge: 10 min`. In jose 6.2.10
(`node_modules/jose/dist/webapi/jwks/remote.js:113-116`), once the cache is older
than that, **every** verification awaits a refetch on the request path. A failed
refetch throws, and there is no stale-key fallback. The thrown error is a
`JWKSTimeout`, a fetch `TypeError`, or a `JOSEError` "Expected 200 OK from the
JSON Web Key Set HTTP response".

So in three situations the API answers **401**, and the web client's
`onUnauthorized` navigates to `/ward/login`, the page D53 says must not be
offered:

- **Ward is down or restarting** more than 10 minutes after the last key fetch;
- **atrium boots while Ward is down**;
- **Ward is merely slow**, past the 5 s timeout, at the moment a refetch is due.

Reproduced during the sweep: a correctly signed token against an unreachable
origin produced `WardAuthenticationError` with a `TypeError` cause.

**The reference client has the same catch-all**
(`wzd_auth/client/src/verify.ts:139-140`). Atrium's own rule, at
[`ward.types.ts:16-17`](../../../apps/api/src/modules/ward/ward.types.ts), is
"**Change the contract there before changing behaviour here.**"

## Scope

**In:** classifying verification failures in atrium's Ward client; a test with an
injected failing key fetch.

**Out:**
- the introspection path, which is correct;
- the 30 s introspection cache;
- the unbounded introspection-cache Map (a Watch item, also upstream);
- the web client, which already handles 503 correctly.

## Files you OWN

- `apps/api/src/modules/ward/ward.client.ts`
- `apps/api/src/modules/ward/ward.types.ts`, only if the new mapping needs a
  documented constant

## Files you must NOT touch

- `apps/api/src/modules/ward/ward.guard.ts`: its branches are already right. It
  just never receives a `WardUnavailableError` from `verify`.
- The `wzd_auth` repository: raise the upstream change with its owner. Do not
  edit another repo from this brief.

## What to do

1. **Upstream first.** Before merging, open the matching change against
   `wzd_auth`'s `client/src/verify.ts` and its `corpus/wiki/integrating.md`
   ("fail closed" is one of the five things every integration must get right).
   Link it in your outcome. If the owner prefers atrium to lead, record that
   choice in the outcome.
2. **Classify in `verify`'s catch.**
   - **Key-set retrieval failures → `WardUnavailableError` (503):** jose's
     `JWKSTimeout`, a network `TypeError` from the key fetch, and a `JOSEError`
     raised by the JWKS HTTP/JSON handling, including an invalid key set.
   - **Everything else → `WardAuthenticationError` (401):** signature failure,
     expired or invalid claims, a disallowed algorithm, and no matching key after
     jose's own refresh.
   - Prefer jose's error classes and `code`s to message matching. Where a message
     is the only signal, confine the match to one named helper with a comment.
3. **Test both paths.** jose accepts a custom fetch for the remote key set via its
   `customFetch` option. Test that:
   - a failing key fetch yields 503;
   - a bad signature or expired token still yields 401.

## Acceptance

- With Ward's JWKS endpoint unreachable and the key cache cold, a request carrying
  a well-formed token gets **503 `IDENTITY_UNAVAILABLE`**, not 401.
- A forged or expired token still gets 401.
- A live, granted session still gets through.
- A token signed by an unknown key still gets 401 after jose's cooldown-limited
  refetch.
- Typecheck and build are clean, and the upstream change is linked in the outcome.
- The tests live in [brief 63](../done/63-api-test-harness.md)'s harness if it exists,
  otherwise in a `node --test` file beside `ward.client.ts`.

## Outcome (2026-10-03)

Done in atrium. **The upstream change is not opened.** This brief forbids editing `wzd_auth`, and no PR could be raised from here, so it is owed to the `wzd_auth` owner (details below). prm already led with the identical fix (prm brief 21, commit `022d484`), so atrium is the second integration to diverge from the reference client.

**Change** (`ward.client.ts`):
- The remote key set gets the injected fetch through jose's `customFetch` symbol, the same seam introspection already had.
- `jwtVerify` resolves keys through a `resolveKey` wrapper. jose's `JWKSNoMatchingKey` and `JWKSMultipleMatchingKeys` pass through, because they describe the token. Every other resolver failure becomes `WardUnavailableError`: timeout, network `TypeError`, non-200, non-JSON, invalid set.
- `verify`'s catch rethrows `WardUnavailableError` unchanged and maps everything else to `WardAuthenticationError`, as before.
- Classification is by class, with no message matching.
- `ward.guard.ts` is untouched; its 503 branch now receives these.

**Tests** (`test/ward-client.test.ts`, with the real-crypto helper `test/real-ward.ts`). Real EdDSA keys; Ward is served from an injected fetch.
- **Ward unavailable** when the key set's fetch throws, answers 500, answers HTML, is not a key set, or never answers (20 ms timeout).
- **Still authentication errors:**
  - a forged signature under Ward's own kid;
  - an unknown kid after jose's refetch;
  - an expired token;
  - HS256 keyed with the public key's bytes.
- **A live token** resolves the caller.
- **Through `buildApp` with the real client:**
  - a cold cache with an unreachable key set gives **503 `IDENTITY_UNAVAILABLE`**;
  - once the key set is back, a live granted session gets 200;
  - a forged token gets 401.
- Against the old client, 9 of the 15 fail. The "live" cases fail too, because the key set ignored the injected fetch.
- 47 API tests pass, and typecheck and build are clean.

**Owed upstream**, for the `wzd_auth` owner:
- In `client/src/verify.ts`, the catch at `:139-140` turns every `jwtVerify` failure into an authentication error. It needs the same resolver wrapper, and `customFetch` passed to `createRemoteJWKSet`.
- `corpus/wiki/integrating.md`'s "fail closed" item should name the key-fetch path explicitly, beside introspection.

Until that lands, the next estate app to copy the reference client inherits the bug.
