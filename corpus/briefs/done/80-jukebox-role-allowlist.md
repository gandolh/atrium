# Task 80: The bot account's `jukebox` role is an allowlist

**Filed 2026-10-08** from the Jukebox grilling with the owner. Decision D55;
vocabulary in [glossary-jukebox.md](../../wiki/glossary-jukebox.md). First of
three atrium briefs (80, 81, 82). just-a-bot briefs 25 to 27 depend on it.

## Context

The Discord bot will sign in to atrium as its own Ward account, the **Bot
account**, whose `atrium` grant carries the role `jukebox` (D55). The owner asked
that the bot "can only use its own profile". A profile is not a security
boundary (D35), so the guard has to enforce it.

Today any role is full access:
- `ward.guard.ts:146` reads `session.grants.atrium ?? []`, and the only check is
  that the list is not empty (:149, 403 `NO_ATRIUM_GRANT`).
- `requireAtriumRole()` (:192-199) has no caller. If it threw, the app error
  handler (`app.ts:51-56`) would send Fastify's default
  `{statusCode, error, message}`, not the guard's `{error: "CODE"}`. So don't
  build this check on it.
- The library has no owners. `DELETE /library/:id` (`library.controller.ts:451`)
  deletes any item for any caller, so a leaked bot password with a full grant
  could wipe the library.

Ward never interprets a role string. Grants are `(subject, app, role)` rows, and
an account may hold several roles for one app. FakeWard's default grant in tests
is `{atrium: ["user"]}` (`test/fake-ward.ts:19`).

## Scope

**In:**
1. Define **jukebox-only**: the caller's `atrium` roles are not empty and every
   one of them is `jukebox`. An account holding `jukebox` alongside any other
   role keeps full access, so the owner's account is never limited by
   accident. Set `request.jukeboxOnly: boolean` in the hook, next to
   `request.ward` (:186), and add it to the `declare module "fastify"` block
   (:64-74).
2. In the same `onRequest` hook, a jukebox-only caller may reach only:
   - any route whose path starts with `/jukebox/` (brief 81 adds them; until
     then they 404);
   - `GET /library/:id/file` and `GET /library/:id/cover`;
   - whatever `isAllowlisted()` (:85-89) already passes.

   Everything else gets `reply.code(403).send({error: "JUKEBOX_ROLE_FORBIDDEN"})`,
   on the same path as `NO_ATRIUM_GRANT`. Match on the route pattern
   (`request.routeOptions.url`), not the raw URL, so a query string or encoding
   trick can't slip past. An unmatched route is also a 403 for this caller.
3. In the file (:145) and cover (:242) handlers, once the row is loaded: if the
   caller is jukebox-only and the item's kind is not `audio`, answer 403
   `JUKEBOX_ROLE_FORBIDDEN`. The bot streams music and nothing else.
4. Keep the guard's lazy `Default` profile (:168) for this account. The bot then
   has exactly one profile, and it can neither switch nor create one, because
   profile routes are outside the allowlist. That is the owner's "only its own
   profile", enforced.
5. One paragraph in [architecture.md](../../wiki/architecture.md) where it
   describes the guard: the `jukebox` role, what it allows, and a pointer to D55.

**Out:**
- the Jukebox routes themselves (brief 81);
- what the web app shows a jukebox-only account (the bot never opens it);
- any other role semantics. `jukebox` is the only role atrium reads.

## Files you OWN

- `apps/api/src/modules/ward/ward.guard.ts`: the hook and the type augmentation
- `apps/api/src/modules/library/library.controller.ts`: the file and cover handlers only
- `apps/api/test/jukebox-role.test.ts` (new)
- `corpus/wiki/architecture.md`: the one paragraph

## Owner steps

These are manual. Nothing in the repo holds a credential.
1. **Production Ward**: in the console at `https://gandolh.ro/ward/`, signed in
   as superuser, create the account `discord-bot` with a long generated
   password. Grant it `atrium` with role `jukebox`, and nothing else. Put the
   username and password only in just-a-bot's `bots/discord/.env`, which
   just-a-bot brief 25 defines.
2. **Local Ward container** (`localhost:8792`): the same with `discord-bot-dev`,
   for the local dev bot. Two processes must never share one refresh token,
   which is why dev gets its own account.
3. Deploy once brief 81 has landed too: `node cli.ts atrium deploy` from
   `~/projects/vps-deploy`.

## Acceptance

Tests in `apps/api/test/jukebox-role.test.ts`, signed in with
`{atrium: ["jukebox"]}` unless a line says otherwise:
- `GET /library` returns 403 `JUKEBOX_ROLE_FORBIDDEN`. So do `POST /library`,
  `PATCH /library/:id/progress` and `DELETE /library/:id`, and after the delete
  attempt the row still exists.
- `GET /profiles` and `POST /profiles/:id/activate` return 403.
- `GET /notes` and a LaTeX route return 403.
- `GET /library/:id/file` for an `audio` item returns 200, and with a `Range`
  header it returns 206. For a `book` item it returns 403.
- `GET /library/:id/cover` for an `audio` item returns 200, or 404 when it has
  no cover. For a `video` item it returns 403.
- `GET /jukebox/anything` is not 403. It is 404 until brief 81.
- With `{atrium: ["user"]}` and with `{atrium: ["user", "jukebox"]}`, every one
  of those routes behaves exactly as before.
- `GET /health` without a session is still 200.
- The existing suite still passes. `npm test -w apps/api`, typecheck and build
  are clean.

## Outcome (2026-10-08)

Done. The owner steps above are still owed: the two Ward accounts, and the
deploy once brief 81 lands.

**Change:**
- `ward.guard.ts`: `isJukeboxOnly()` (roles not empty, every one `jukebox`) and
  `jukeboxMayReach()`, checked right after `NO_ATRIUM_GRANT`. A refused request
  is 403 `JUKEBOX_ROLE_FORBIDDEN` before any profile is touched. The allowlist
  matches `request.routeOptions.url`: any pattern under `/jukebox/`, and `GET`
  on `/library/:id/file` and `/library/:id/cover`.
- `request.jukeboxOnly` is a real boolean on every request
  (`app.decorateRequest("jukeboxOnly", false)`), not an optional field, so a
  handler can test it without a guard for `undefined`.
- File and cover handlers: 403 for a jukebox-only caller when `row.kind` is not
  `audio`. The file check runs before `touchOpened`, so a refused request
  records no open.
- `architecture.md`: one paragraph under the guard diagram.

**One reading of the brief to note.** "An unmatched route is also a 403" and
"`GET /jukebox/anything` is 404 until brief 81" meet on a request that matches
no route, where `routeOptions.url` is undefined. For that case only, the guard
looks at the raw path: under `/jukebox/` it passes on to Fastify's 404, and
anything else is 403. No handler runs for an unmatched request either way, so
the raw path cannot open anything.

**Verified:** `test/jukebox-role.test.ts` (18 tests) covers every acceptance
line, plus a query-string attempt and an unmatched path. The full API suite (93)
passes, and typecheck and build are clean.
