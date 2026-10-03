# Task 73 — A 500 does not send the error's message to the client

**Filed 2026-10-03** while doing brief 54.

## Context

`apps/api` registers no `setErrorHandler`, so an uncaught error reaches
Fastify's default handler, which answers a 500 with the error's own `message`.
For a Knex/SQLite error that message is **the full SQL statement**. Brief 54's
regression test, run against the unfixed query, received:

```json
{"statusCode":500,"code":"SQLITE_ERROR","error":"Internal Server Error",
 "message":"select `lp`.* from `latex_projects` as `lp` inner join `profiles` as `p` … where `p`.`user_id` = 'subject-owner' … - no such column: p.user_id"}
```

That hands any signed-in caller the table and column names, the query shape and
the bound values (here, a Ward subject). It also makes the web client show
whatever a driver happened to say. The real error belongs in the log, which
already gets it.

## Scope

**In:** one app-wide error handler in `app.ts`. A 5xx answers
`{ error: "INTERNAL" }` and logs the original error with the request id. A 4xx
raised by Fastify itself (validation, body too large, unsupported media type)
keeps its status and its own message, because those describe the request.

**Out:** the per-route `reply.status(…).send(…)` answers, which are deliberate.

## Files you OWN

- `apps/api/src/app.ts`
- `apps/api/test/errors.test.ts` (new)

## Files you must NOT touch

- Route handlers under `apps/api/src/modules/**`.

## What to do

1. `app.setErrorHandler`: for `statusCode >= 500` (or none), log the error and
   send `500 { error: "INTERNAL" }`; otherwise send the error's status with its
   message, as Fastify does today.
2. Test it with a route registered on the test app that throws an error whose
   message contains SQL-looking text: the body must not contain it, and the
   status must be 500. A malformed JSON body still answers 400.

## Acceptance

- The test above passes, and fails without the handler.
- `npm run test`, typecheck and build are clean.

## Outcome (2026-10-03)

Done.

**Change.** `app.ts` gets one `setErrorHandler`, set right after `Fastify()` and before every plugin, hook and route, so all of them inherit it.
- **`statusCode >= 500` (or none):** it logs the error with the request's logger, so with its request id, and answers `500 { error: "INTERNAL" }`.
- **Anything below 500:** it hands the error back with `reply.send(error)`. In Fastify 5.9 that goes to the parent (default) handler, so a Fastify-raised 4xx keeps exactly today's status and body.
- The notes routes' own `errorHandler` (brief 56) already passes non-413 errors on with `reply.send(error)`, and that reaches this handler. No route handler was touched.

**Tests** (`test/errors.test.ts`; the app is built directly so the test can register a throwing route before `ready`):
- a route throwing an error whose message is SQL gets 500 `{ error: "INTERNAL" }`, with no `select` in the body;
- a **real** SQLite failure behind the notes route's own error handler, a `BEFORE UPDATE` trigger raising during `PATCH /notes/:id`, gets the same 500 `INTERNAL`;
- malformed JSON still gets 400 `FST_ERR_CTP_INVALID_JSON_BODY`;
- an over-cap note still gets 413 `NOTE_TOO_LARGE`.

The two 500 cases fail without the handler. 73 API tests pass, and typecheck and build are clean. `api-layering.md` records the convention.
