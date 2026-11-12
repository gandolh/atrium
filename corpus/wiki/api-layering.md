---
summary: How apps/api is organised (the house code structure since 2026-11-12, D62) — server.ts and app.ts, config.ts, plugins/, features/<name>/ used through their index, the stores in db/, zod route schemas through the type provider, what routes/service/store may do, the tagged-union outcome convention, profile scoping in SQL, the error bodies, Knex migrations, and the test harness.
updated: 2026-11-12
---

# API layering (`apps/api/src`)

Split out of [architecture.md](architecture.md) on 2026-08-30, when the Knex layering (2026-08-30)
restructured the API and that page crossed the 200-line limit.

Since 2026-08-30 the API is organised by **domain**, and within a domain by
layer; since 2026-11-12 it follows the estate's code structure (the
code-structure skill, D62). The rule is one sentence: **a route owns HTTP, a
service owns the rules, a store owns the SQL, and the dependencies only ever
point that way.**

```
src/
  server.ts       the entry: database up → Ward client → buildApp → listen → close-with-grace
  app.ts          buildApp: errors plugin, zod compilers, plugins/auth, multipart, then each feature by name
  config.ts       the one reader of process.env: import-time constants, loadSeedConfig, childProcessEnv
  plugins/        errors.ts (the one handler, errorBody, invalidRequestAs) · multipart.ts
                  auth/  the guard: Ward's vendored library + atrium's jukebox and profile hook (D58)
  db/             knex.ts · bootstrap.ts · errors.ts · migrations/ · auth-store.ts · ward-subjects.ts
                  profiles-store · profile-selection-store · library-store (+ library-types) · latex-store
  lib/            paths.ts · present.ts   (no Fastify)
  scripts/        seed-user.ts   (npm run seed:user)
  features/       each: index.ts (the only way in) · routes.ts (a FastifyPluginAsyncZod plugin)
    health/       GET /health
    profiles/     routes · service · mapper
    library/      routes · service · mapper + extract · calibre · convert · maintenance services
    catalog/      routes · service · gutendex service
    notes/        routes · service · store · folders-store · mapper · note-pdf service
    latex/        routes · service · compile service · latex-paths · latex-worker · project-tree service
    jukebox/      routes · service · store · mapper · types
    lookup/       routes · service · musicbrainz · openlibrary services
                  + lookup-http (User-Agent, timeouts, RateGate, TtlCache)
```

**A store another feature reads lives in `db/`**, not in its feature folder:
profiles (the guard and the library read it), profile selection (the guard),
library (catalog, lookup and LaTeX insert and read books) and LaTeX (the library
reads document versions). With them below the features, no feature imports
another's store and no feature index closes a cycle; dependency-cruiser fails
a reach past an index (`feature-through-index`) and any cycle in the API.

**Every route declares its schemas** through `@fastify/type-provider-zod`:
`params`, `querystring` and `body` as it takes them, and a `response` for each
status its handler sends (error statuses use `errorBody`, which passes the
body through in the handler's key order). Validation runs before the handler,
so no handler parses its input or its reply. A response schema **only
encodes**: `.default()` and `.catch()` do not apply on the way out, so stored
data the schemas used to normalise (a notes page without a template) is decoded
in the mapper. Keys go out in the schema's order, which is why
`botCommandSchema` lists its keys as the server writes them. The nine binary
and multipart routes declare their inputs only, each recorded in
`scripts/conventions.json`.

**Outbound calls** go through a module's own client, never from the browser:
`catalog/gutendex.service.ts` (2026-07-16) and `lookup/` (the metadata lookup of 2026-10-28, D59: Look
up on request, MusicBrainz and the Cover Art Archive for music, Open Library
for books). Each sets a timeout and a descriptive `User-Agent`, caches in
memory, and turns an unreachable source into a tagged `UPSTREAM` outcome the
route answers as a 502 naming it. MusicBrainz requests pass one
process-wide `RateGate` (one a second). A cover is fetched by an id the server
builds the URL from, never a URL the client sent.

What each layer may do:

| Layer | May | May not |
|---|---|---|
| **routes** | declare the schemas, choose the status code, stream bytes | contain a rule, build a query |
| **service** | orchestrate, decide, touch the filesystem, call other features through their index | know about `request`/`reply` or status codes |
| **store** | read and write its own tables, nothing else | touch the filesystem, HTTP, or another feature's tables |

Two conventions that carry weight:

- **A service returns a tagged union, not a thrown error**, for every outcome
  that is a normal answer (`{ ok: false, reason: "NAME_TAKEN" }`). Each maps to a
  different status code with a different body, and a route switching on
  `reason` cannot forget a case the way a `catch` can.
- **Profile scoping is in the SQL, not a check after it.** Every notes, folders
  and LaTeX query is keyed on `profile_id` as well as `id`, so a foreign id is
  simply *not found* — which is why those routes answer **404, never 403**. A 403
  would confirm the id exists on somebody else's account. Validation runs first
  (Q52): a malformed body on a foreign id is a 400, a well-formed one a 404.
- **A thrown error is a 500 that says nothing** (2026-10-03). The one handler,
  `plugins/errors.ts` (registered first), answers any 5xx `{ error: "INTERNAL" }`
  and logs the real error; a Knex error's message is its SQL, bound values
  included. A request that fails its schema is a 400 `{ error: "INVALID_REQUEST" }`,
  unless the route names its own code with `invalidRequestAs` (the catalog's
  sentences, lookup's `INVALID_QUERY`, `INVALID_BODY` and `BAD_REF`, progress's
  sentence); a reply its schema refuses is a 500 `INTERNAL`. A 4xx raised by
  Fastify (bad JSON, body too large) keeps its status and its
  `{ statusCode, code, error, message }` body. A route-level `errorHandler`
  passes what it does not handle on with `reply.send(error)`, which reaches it.

**Migrations** live in `db/migrations/` and are registered by **static
import** in its `index.ts` (a scanned directory picks a loader by file extension,
which breaks between `.ts` under tsx in dev and `.js` under `dist/` in
production). `20260830000000-baseline.ts` is idempotent because it has to bring
both a fresh database and a pre-Knex one to the same place; **every migration
after it is an ordinary forward migration and must not be.**

## Tests (2026-10-03)

`npm run test -w @ebook-reader/api` runs `node --import tsx --import ./test/setup.ts --test 'test/**/*.test.ts'`. Each file is its own process and so owns its own database.

- **`test/setup.ts` refuses to be unsafe.** It points all five storage roots at a fresh `mkdtemp` directory, sets the env `src/config.ts` requires, imports `config.ts`, and **throws unless every resolved root is inside that directory**, before anything opens `knex.ts`. Drop one root and the run stops, naming it. The scratch directory is removed on exit.
- **`test/harness.ts`'s `buildTestApp()`** migrates, opens the accounts, builds the app (with no Ward unless a test passes a client), silences its logger, and returns `signIn(id, role)`, which creates a local account and a session and answers its cookie, and `close()`. Close it: the knex pool otherwise keeps the process alive and the run hangs.
- **"Sign in with Ward"** is tested with a real `createWardClient` over a fake `fetch` (`test/ward-routes.test.ts`); `buildApp({ accounts, wardClient })` is the seam. The library's own suite drives the whole flow against a real Ward.
- A fix in `apps/api` should land with a test here. Typecheck covers `test/` (`tsconfig.test.json`); nothing under `test/` is emitted.

