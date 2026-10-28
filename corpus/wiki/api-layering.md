---
summary: How apps/api is organised since D47 — the domain modules (lookup's outbound clients included), what a controller/service/model may and may not do, the tagged-union outcome convention, profile scoping in SQL, how Knex migrations are registered, and how the API test harness keeps tests off the real library.
updated: 2026-10-28
---

# API layering (`apps/api/src`)

Split out of [architecture.md](architecture.md) on 2026-08-30, when brief 52
restructured the API and that page crossed the 200-line limit.

Since 2026-08-30 the API is organised by **domain module**, and within a module
by layer. The rule is one sentence: **a controller owns HTTP, a service owns the
rules, a model owns the SQL, and the dependencies only ever point that way.**

```
src/
  index.ts        bring the database up → listen → shut down
  app.ts          build the Fastify instance: plugins, guard, module routes
  common/         config.ts · paths.ts
  database/       knex.ts · bootstrap.ts · errors.ts · migrations/
                  auth-store.ts · ward-subjects.ts   (D58: accounts on Knex's connection)
  scripts/        seed-user.ts   (npm run seed:user)
  modules/
    auth/         guard: Ward's vendored library + atrium's jukebox and profile hook (D58)
    profiles/     controller · service · model · mapper · profile-selection model
    library/      controller · service · model · types · mapper
                  + extract · calibre · convert · maintenance services
    catalog/      controller · service · gutendex service
    notes/        controller · service · model · note-folders model
                  + mapper · note-pdf service
    latex/        controller · service · model · compile service
                  + latex-paths · latex-worker · project-tree service
    jukebox/      controller · service · model · mapper · types
    lookup/       controller · service · musicbrainz · openlibrary services
                  + lookup-http (User-Agent, timeouts, RateGate, TtlCache)
```

**Outbound calls** go through a module's own client, never from the browser:
`catalog/gutendex.service.ts` (brief 22) and `lookup/` (brief 100, D59: Look
up on request, MusicBrainz and the Cover Art Archive for music, Open Library
for books). Each sets a timeout and a descriptive `User-Agent`, caches in
memory, and turns an unreachable source into a tagged `UPSTREAM` outcome the
controller answers as a 502 naming it. MusicBrainz requests pass one
process-wide `RateGate` (one a second). A cover is fetched by an id the server
builds the URL from, never a URL the client sent.

What each layer may do:

| Layer | May | May not |
|---|---|---|
| **controller** | parse and validate the request, choose the status code, stream bytes | contain a rule, build a query |
| **service** | orchestrate, decide, touch the filesystem, call other modules' services | know about `request`/`reply` or status codes |
| **model** | read and write its own tables, nothing else | touch the filesystem, HTTP, or another module's tables |

Two conventions that carry weight:

- **A service returns a tagged union, not a thrown error**, for every outcome
  that is a normal answer (`{ ok: false, reason: "NAME_TAKEN" }`). Each maps to a
  different status code with a different body, and a controller switching on
  `reason` cannot forget a case the way a `catch` can.
- **Profile scoping is in the SQL, not a check after it.** Every notes, folders
  and LaTeX query is keyed on `profile_id` as well as `id`, so a foreign id is
  simply *not found* — which is why those routes answer **404, never 403**. A 403
  would confirm the id exists on somebody else's account.
- **A thrown error is a 500 that says nothing** (brief 73). One `setErrorHandler`
  in `app.ts` answers any 5xx `{ error: "INTERNAL" }` and logs the real error; a
  Knex error's message is its SQL, bound values included. A 4xx raised by Fastify
  (bad JSON, body too large) keeps its message. A route-level `errorHandler`
  passes what it does not handle on with `reply.send(error)`, which reaches it.

**Migrations** live in `database/migrations/` and are registered by **static
import** in its `index.ts` (a scanned directory picks a loader by file extension,
which breaks between `.ts` under tsx in dev and `.js` under `dist/` in
production). `20260830000000-baseline.ts` is idempotent because it has to bring
both a fresh database and a pre-Knex one to the same place; **every migration
after it is an ordinary forward migration and must not be.**

## Tests (brief 63)

`npm run test -w @ebook-reader/api` runs `node --import tsx --import ./test/setup.ts --test 'test/**/*.test.ts'`. Each file is its own process and so owns its own database.

- **`test/setup.ts` refuses to be unsafe.** It points all five storage roots at a fresh `mkdtemp` directory, sets the env `config.ts` requires, imports `config.ts`, and **throws unless every resolved root is inside that directory**, before anything opens `knex.ts`. Drop one root and the run stops, naming it. The scratch directory is removed on exit.
- **`test/harness.ts`'s `buildTestApp()`** migrates, opens the accounts, builds the app (with no Ward unless a test passes a client), silences its logger, and returns `signIn(id, role)`, which creates a local account and a session and answers its cookie, and `close()`. Close it: the knex pool otherwise keeps the process alive and the run hangs.
- **"Sign in with Ward"** is tested with a real `createWardClient` over a fake `fetch` (`test/ward-routes.test.ts`); `buildApp({ accounts, wardClient })` is the seam. The library's own suite drives the whole flow against a real Ward.
- A fix in `apps/api` should land with a test here. Typecheck covers `test/` (`tsconfig.test.json`); nothing under `test/` is emitted.

