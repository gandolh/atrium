# Task 04: The server in the house code structure

**Depends on:**

- In Atrium: brief 02, for the gate, `eslint-plugin-n`'s `no-process-env` (a warning until this brief) and `.claude/rules/server.md`.
- In the owner's skills library:
  - brief 03, *A code-structure skill for the Fastify + React apps*: rules 1-11, the `server-skeleton.md` reference, `zod-type-provider.md`, `migrating-a-server.md`, `check-structure.mjs`, and the dependency-cruiser and knip presets;
  - brief 16, *The Fastify servers adopt the code structure*: Atrium's row and the method;
  - brief 15, *Enforce the base-ui and code-structure skills in every repo*: `check-structure` runs `--warn-only` until this brief is done.
- The owner's grilling of 2026-11-10 and its technical calls: Q1 (the Dockerfile `CMD` is the repo's), Q23 (`features/`), Q24, Q25, Q27 (Atrium stays on `node:test`), Q43 (the error body), Q52, Q53, Q55 and Q56, and config read at import time. The questions left open are in "Decisions".

**Order:** after 02. It touches no web file, and no file brief 03 touches except `package-lock.json`, so it may run before 03, but never at the same time.

**Before you start:** run `brief-board guide` ([CLAUDE.md](../../../CLAUDE.md)).

## Context

The owner asked on 2026-11-09 for one researched code structure, enforced in every repo. Atrium's API (`apps/api`) already follows a layered shape ([wiki/api-layering.md](../../wiki/api-layering.md)):

- `buildApp()` in `apps/api/src/app.ts` never listens, and `apps/api/src/index.ts` owns the database bootstrap, the listen and the shutdown;
- the domain modules under `apps/api/src/modules/` split into controller, service and model;
- one `setErrorHandler` answers any 5xx `{ error: "INTERNAL" }`;
- the tests build the app through `buildTestApp()` and `inject()`.

What is missing:

- the `features/` name, the entry name, and `plugins/`;
- six stray readers of the environment;
- route schemas: no route has a `schema:` (`grep -rn "schema:" apps/api/src` prints nothing);
- `fastify-plugin` on the cross-cutting plugins, `close-with-grace`, and timeouts;
- an import boundary: modules import each other freely (below).

### The versions (read 2026-11-10)

- **zod 3.25.76** in `packages/shared/package.json`, `apps/api/package.json` and `apps/web/package.json`, with a single copy in `package-lock.json:29008`. It must move in all three together: the web app and the API both consume `packages/shared`'s schemas. `@fastify/type-provider-zod` needs zod `>=4.2.0`, so **this brief moves zod to 4.5.4** (the Round 8 note on the provider).
- **fastify 5.12.7** (`apps/api/package.json`); 5.12.8 is later. The provider needs `^5.5.0`. The bump goes with the estate's next one.
- `@fastify/multipart` 10.0.0 stays.
- New dependencies, pinned: `@fastify/type-provider-zod`, `fastify-plugin`, `close-with-grace`. The provider's peers (`@fastify/swagger`, `openapi-types`) install with it and show in the lockfile diff.

### Measured on 2026-11-10: zod 4 on a scratch copy

On a scratch copy with zod 4.5.4 swapped in (shared rebuilt):

- `tsc` on `packages/shared`, `packages/typeset`, `apps/api` (source and tests) and `apps/web`: **0 errors**.
- `apps/api`'s 25 test files, run with `node --import tsx --import ./test/setup.ts --test 'test/**/*.test.ts'`: **147 tests, 147 pass**, 0 fail.
- Still to do in step 2, because a type-clean build does not prove it: read each of these deprecated-in-4 uses and replace them: `.passthrough()` at `packages/shared/src/profile.ts:93, 121` (becomes `z.looseObject`), `.strict()` at `packages/shared/src/lookup.ts:130`, `z.ZodIssueCode.custom` at `packages/shared/src/lookup.ts:79, 135, 142`, and `z.string().url()` at `apps/api/src/common/config.ts:84`. They compile on 4.5.4 but are the old API.
- The `.transform()` trap: the provider's serializer throws on any `.transform()` in a **response** schema. The only transform in `packages/shared/src` is `packages/shared/src/jukebox.ts:139` (`botCommandsQuerySchema`, a query, decoded only), and the `.refine`/`.superRefine` calls (`profile.ts:73`, `notes.ts:358, 406`, `lookup.ts:77, 132`) sit on input schemas. So no response schema needs a transform-free twin. `preferencesSchema` is `.passthrough()` and is a response: it becomes a loose object and must keep unknown keys through the round trip (the web depends on it: `apps/web/src/lib/preferences.ts:20, 48`).

### The cross-module imports (read 2026-11-10)

Command: `grep -rnE "from \"\.\./(auth|catalog|jukebox|latex|library|lookup|notes|profiles)/" apps/api/src/modules`. **24 import lines across modules.** Rule 5 (a feature is reached only through its `index.ts`) fails today in these directions, with cycles in three pairs:

| From | To (and how often) |
|---|---|
| `profiles` | `latex` ×3 (`profiles.service.ts:11-13`), `notes` ×1 (`:14`) |
| `latex` | `library` ×5 (`latex.service.ts:25-26`, `latex.controller.ts:23-25`), `profiles` ×1 (`latex.controller.ts:26`) |
| `library` | `latex` ×2 (`library.controller.ts:16`, `library.service.ts:23`), `profiles` ×2 (`:21`, `:24`), `jukebox` ×1 (`library.service.ts:22`) |
| `catalog` | `library` ×4 (`catalog.controller.ts:3`, `catalog.service.ts:7-9`) |
| `lookup` | `library` ×3 (`lookup.service.ts:13-14`, `lookup.controller.ts:3`) |
| `auth` | `profiles` ×2 (`auth.guard.ts:3-4`) |

**Cycles:** `library` and `latex` import each other; `latex` and `profiles` import each other; `library` and `profiles` import each other. Three files also reach in from outside `modules/`: `apps/api/src/index.ts:16-22` (library and latex services), `apps/api/src/scripts/seed-user.ts:6` (auth constants).

See decision 4: the cycles are the real cost of the structure here.

### The move map: every file under `apps/api/src/` (47 files outside migrations, 8 migration files)

Paths are from `apps/api/src/`. Because `modules/` and `features/` sit at the same depth, **no file's relative import to `common/`, `database/` or `vendor/` changes**: only imports that name `modules/` (in `app.ts`, `index.ts`, `scripts/seed-user.ts`, and 12 import lines in `apps/api/test/`) get a new segment.

| Today | Lines | Target | Note |
|---|---|---|---|
| `index.ts` | 210 | `server.ts` | The entry. Keeps the database bootstrap, the Calibre and trusted-proxy checks, the listen, the three fire-and-forget sweeps and the shutdown. Gains `close-with-grace` in place of the two signal handlers (the shutdown body is kept: it cancels conversions and compiles, then closes the app and the pool). Its four `modules/` imports become `features/`. |
| `app.ts` | 97 | `app.ts` | Keeps `buildApp({ accounts, wardClient })`. Registers in a fixed order (below). The `/health` route moves to `features/health/routes.ts`. |
| `common/config.ts` | 290 | `config.ts` | See "The environment readers". |
| `common/paths.ts` | 157 | `lib/paths.ts` | Pure path helpers. Imports `config`, so check the rule-5 `lib/` direction (see decision 5). |
| `database/knex.ts`, `bootstrap.ts`, `errors.ts`, `auth-store.ts`, `ward-subjects.ts` | 76, 246, 57, 56, 76 | `db/` (same names) | The skill calls the folder `db/`. |
| `database/migrations/*` (8 files) | 603 largest | `db/migrations/` | Registered by static import in `index.ts` (keep: [wiki/api-layering.md](../../wiki/api-layering.md)). |
| `modules/auth/auth.guard.ts` | 195 | `plugins/auth/index.ts` | Wrapped in `fastify-plugin` so the guard stays a root hook. Keeps `JUKEBOX_ROLE`, `MEMBER_ROLE`, `SESSION_COOKIE`, `roleForWardRole`. Imports two profile stores: a recorded exception (decision 4). |
| `modules/profiles/profiles.controller.ts` | 143 | `features/profiles/routes.ts` | 7 routes. |
| `modules/profiles/profiles.service.ts`, `.model.ts`, `.mapper.ts` | 282, 276, 38 | `features/profiles/service.ts`, `store.ts`, `mapper.ts` | |
| `modules/profiles/profile-selection.model.ts` | 78 | `features/profiles/selection-store.ts` | |
| `modules/library/library.controller.ts` | 469 | `features/library/routes.ts` | 10 routes. Over rule 11's 400 lines: a warning, left. |
| `modules/library/library.service.ts`, `.model.ts`, `.mapper.ts`, `.types.ts` | 430, 332, 112, 101 | `features/library/service.ts`, `store.ts`, `mapper.ts`, `types.ts` | `service.ts` is over 400 lines: a warning, left. |
| `modules/library/extract.service.ts`, `convert.service.ts`, `calibre.service.ts`, `library-maintenance.service.ts` | 531, 691, 150, 201 | `features/library/` (same names) | `extract` and `convert` are over 400: warnings, left. |
| `modules/catalog/*` | 66, 151, 228 | `features/catalog/routes.ts`, `service.ts`, `gutendex.service.ts` | 2 routes. |
| `modules/notes/notes.controller.ts` | 181 | `features/notes/routes.ts` | 11 routes. |
| `modules/notes/notes.service.ts`, `.model.ts`, `.mapper.ts`, `note-folders.model.ts`, `note-pdf.service.ts` | 189, 106, 57, 188, 314 | `features/notes/service.ts`, `store.ts`, `mapper.ts`, `folders-store.ts`, `note-pdf.service.ts` | |
| `modules/latex/latex.controller.ts` | 1,027 | `features/latex/routes.ts` | 18 routes (two are `/library/:id/versions`). A move only; see "Files over 400 lines". |
| `modules/latex/latex.service.ts`, `.model.ts` | 715, 249 | `features/latex/service.ts`, `store.ts` | `service.ts` over 400: a warning, left. |
| `modules/latex/latex-compile.service.ts` | **1,722** | `features/latex/compile.service.ts` | **A move only, no split.** Its 16 exports are used by three files (`latex.service.ts:30`, `latex.controller.ts:34`, `profiles.service.ts:11`) and `index.ts:22`. |
| `modules/latex/latex-paths.ts`, `latex-worker.ts`, `project-tree.service.ts` | 347, 259, 48 | `features/latex/` (same names) | `latex-worker.ts` is loaded as a thread entry from a `file:` URL (`latex-compile.service.ts`); the file keeps its name relative to the folder, and a test must prove the worker still starts from `dist/`. |
| `modules/jukebox/jukebox.controller.ts` | 168 | `features/jukebox/routes.ts` | 12 routes. |
| `modules/jukebox/jukebox.service.ts`, `.model.ts`, `.mapper.ts`, `.types.ts` | 849, 122, 83, 73 | `features/jukebox/service.ts`, `store.ts`, `mapper.ts`, `types.ts` | `service.ts` over 400: a warning, left. |
| `modules/lookup/lookup.controller.ts` | 96 | `features/lookup/routes.ts` | 3 routes. |
| `modules/lookup/lookup.service.ts`, `musicbrainz.service.ts`, `openlibrary.service.ts`, `lookup-http.ts` | 186, 213, 82, 141 | `features/lookup/` (same names, `lookup.service.ts` becomes `service.ts`) | |
| (new) | | `features/health/routes.ts` | `GET /health`, from `app.ts:84`. |
| (new) | | `features/<name>/index.ts` for each feature | What the other features may use (decision 4). |
| (new) | | `plugins/errors.ts`, `plugins/multipart.ts` | The error handler from `app.ts:46-52`, and the multipart registration from `app.ts:73-75`. |
| `scripts/seed-user.ts` | 134 | the same | A CLI. Its environment reads move to `config.ts`. |

**Tests stay in `apps/api/test/`** (25 files plus `harness.ts`, `setup.ts`, `zip-builder.ts`, 3,639 lines). That is the layout the repo documents ([wiki/api-layering.md](../../wiki/api-layering.md)) and the one place the skills library's brief 27 names Atrium as the exception. The checker's co-location rule gets an entry in `scripts/conventions.json`. `harness.ts` already exports `buildTestApp`, the skill's name.

### The environment readers

Command: `grep -rn "process\.env" apps/api/src | grep -v "^apps/api/src/common/config.ts"`, 2026-11-10.

| Where | What | Afterwards |
|---|---|---|
| `common/config.ts:87` | `envSchema.safeParse(process.env)` | stays, the one reader |
| `common/config.ts:151-203` | the five storage roots, each with its own `process.env` read and `resolve()` | stay in `config.ts` |
| `common/config.ts:219, 289` | `process.env[name]`, `GUTENDEX_BASE_URL` | stay in `config.ts` |
| `index.ts:97` | `process.env.NODE_ENV` | `config.ts` exports `IS_PRODUCTION` |
| `index.ts:98` | `process.env.AUTH_TRUSTED_PROXIES` | `config.ts` exports it parsed |
| `scripts/seed-user.ts:67, 68, 70` | `SEED_USERNAME`, `SEED_PASSWORD`, `SEED_ROLE` | `loadSeedConfig()` in `config.ts` |
| `modules/library/calibre.service.ts:19` | `{ ...process.env, PYTHONNOUSERSITE: "1" }` for a child process | `childProcessEnv()` in `config.ts` |
| `apps/api/test/*` | 5 sites set the environment | tests, excepted |
| `apps/api/vendor/ward/ward-auth.js` | 2 | vendored, out of scope |
| `apps/web/vite.config.ts` and `apps/web/src` | build config and `import.meta.env` | out of scope |

So **6 sites outside `config.ts`**, which brief 02's `no-process-env` warning reports and this brief clears.

**`config.ts` stays a module of import-time constants (decided 2026-11-10, technical call: config read at import time is allowed).** It exports `PORT`, `PUBLIC_ORIGIN`, `DATA_DIR`, `DB_PATH` and 18 more (`grep -n "^export const" apps/api/src/common/config.ts`), and 14 source files plus 7 test files import them. `apps/api/test/setup.ts` depends on this: it sets the environment, then imports `config.ts` and throws unless every storage root resolved inside its scratch directory. The skills library's `loadConfig(env)` factory would change every one of those, and the rule now allows import-time config, so there is no factory and no exception to record. Keep the constants and add the helpers above (decision 3).

**`.env` loading is deliberately forgiving**, and is not one of the "quiet failure" cases the skills library's Round 8 note warns about. `config.ts:59-62` loads `.env` only if it exists, because in production the container injects the variables, and the schema check at line 87 then fails loudly with the list of missing names. Keep it.

### Every route: 64, by feature

Command: `grep -rnE "app\.(get|post|put|patch|delete)\(" apps/api/src`. The vendored `wardAuth` plugin's `/auth/*` routes are generated code and out of scope.

| Feature | Routes | Shape |
|---|---|---|
| health | 1 | `GET /health` |
| profiles | 7 | JSON: `/profiles`, `/profiles/:id`, `/profiles/:id/activate`, `/profiles/:id/preferences` |
| notes | 11 | JSON, plus `GET /notes/:id/export.pdf` (binary) |
| library | 10 | JSON, plus `POST /library` (multipart), `GET /library/:id/file`, `GET`/`POST /library/:id/cover` (binary, multipart) |
| catalog | 2 | `GET /catalog/gutenberg`, `POST /library/import` |
| lookup | 3 | JSON, plus `GET /lookup/covers/:source/:ref` (binary) |
| latex | 18 | JSON, plus the `files/*` wildcards (`GET`, `PUT`, `POST` multipart, `DELETE`), `GET /latex/:id/pdf`, `GET /latex/:id/log` |
| jukebox | 12 | JSON, including the long poll `GET /jukebox/bot/commands` (up to 20 s, `JUKEBOX_MAX_WAIT_SECONDS`, `packages/shared/src/jukebox.ts:20`) |

**11 routes are streams, binaries or multipart**: `apps/api/src/modules/library/library.controller.ts:94, 145, 250, 313`, `apps/api/src/modules/latex/latex.controller.ts:246, 277, 348, 687, 702`, `apps/api/src/modules/notes/notes.controller.ts:85`, `apps/api/src/modules/lookup/lookup.controller.ts:75`. Default (the skills library's Q53): exempt from a response schema, with an entry in `scripts/conventions.json`; they still get `params`.

**The other 53 JSON routes get `params`, `querystring` where used, `body` and a `response` per status**, from the schemas already in `packages/shared/src/` (the existing `*Schema` exports; `shared` has 10 files). Hand parsing removed:

- **23 sites** parse request input in a controller or service: `grep -rnE "(\.parse|\.safeParse)\((request|req|body|query|params)" apps/api/src`, plus `lookup.service.ts:159`. Spread across `notes.controller.ts`, `profiles.controller.ts`, `jukebox.controller.ts`, `latex.controller.ts`, `library.controller.ts`, `lookup`.
- **At least 14 sites** already `schema.parse(...)` a reply by hand: `profiles.controller.ts:59, 73, 84, 119, 131, 141` and `notes.controller.ts:59, 66, 73, 112, 136, 151, 159, 171`. The response schema replaces them. A field a hand parse kept and a schema would drop is a finding.
- **Helper parsing the regex misses** (the Round 8 note): the jukebox controller reads `request.params` through `guildIdOf` (`jukebox.controller.ts:43`), and `latex.controller.ts` builds its own checks. Step 1 lists them with `rg "request\.(params|query|body)"`.

**The error body.** The 16 `{ error: "INVALID_REQUEST" }` replies (`grep -rn "INVALID_REQUEST" apps/api/src`) and the app-wide `{ error: "INTERNAL" }` are what the web client reads. Atrium's error body is a flat `{ error: CODE, message? }`, not `{ error: { code, message } }`, and it stays (decided 2026-11-10, technical call, Q43). The error plugin maps a provider validation error to 400 `{ error: "INVALID_REQUEST" }` and a response-serialization error to 500 `{ error: "INTERNAL" }`, **passes Fastify's own 4xx through with their own status** (a malformed JSON body, an unsupported media type and an oversized payload answer 4xx, not 500), and never echoes a thrown message to the client.

### The `server.ts` / `app.ts` split, and the entry file

`server.ts`: `loadEnvFile` is already in `config.ts`'s import. Then initialise the database, build the Ward client (`index.ts:48-53`), `buildApp`, the Calibre and proxy checks, `listen`, the sweeps, `close-with-grace`. `buildApp` registers in a fixed order:

1. the errors plugin (replaces `app.setErrorHandler`, `app.ts:46-52`);
2. the provider's compilers (`setValidatorCompiler`, `setSerializerCompiler`);
3. `plugins/auth` (still before everything with routes: Fastify copies hooks into a child context when the child is created, per the comment at `app.ts:55-59`);
4. the multipart plugin;
5. then the features: health, profiles, library, catalog, notes, latex, jukebox, lookup, in the order `app.ts:86-92` uses today.

**Renaming the entry moves the built file** from `apps/api/dist/index.js` to `apps/api/dist/server.js`. These name it:

- `infrastructure/Dockerfile:105`: `CMD ["node", "apps/api/dist/index.js"]`;
- `apps/api/package.json`: `dev` (`tsx watch src/index.ts`) and `start` (`node dist/index.js`).

Nothing imports `@ebook-reader/api`. The root `package.json` `dev` script runs `npm run dev -w @ebook-reader/api`, so it follows. The skills library's Q1 answer (2026-11-10) says the repo owns the Dockerfile and services run from it, so the `CMD` changes in the same commit and nothing else in the deploy does.

## Decisions

Items marked "decided" are final. The rest are defaults this brief builds.

1. **`apps/api/src/features/<name>/`** (decided 2026-11-10, technical call, Q23). As in the move map. The skills library's tree writes `server/src/`; Atrium's is `apps/api/src/`, and `modules/` becomes `features/`.
2. **Typed plugin options and explicit registration** (decided 2026-11-10, technical call, Q24 and Q56). Atrium has no `FeatureContext` today: each feature exports `registerXRoutes(app)` and the handlers import their stores. Keep that: explicit registration in `app.ts` stays, and no context object is invented. Features become `FastifyPluginAsyncZod` plugins that take no options until two need a shared one, and then they take typed plugin options. No decorators as a test seam.
3. **`buildApp(config)` and `loadConfig()`** (decided 2026-11-10, technical call). Config read at import time is allowed, so `config.ts` keeps its constants and no `loadConfig()` factory is added. It is not an exception and needs no entry in `scripts/conventions.json`.
4. **Import boundaries and the three cycles.** Default: add `features/<name>/index.ts` for the symbols other features use (the 24 imports above name them), switch each cross-feature import to it, and **record the three cycles** (`library` and `latex`, `latex` and `profiles`, `library` and `profiles`) and the `auth` and `profiles` import as dependency-cruiser exceptions with their reasons, because breaking them is a design change, not a move. *Repo question:* are the cycles worth breaking (for instance by moving the shared ownership rules into a `lib/` function), or accepted?
5. **`common/paths.ts`.** Default: it becomes `lib/paths.ts`. It imports `config.ts`, which `lib/` should not (a pure helper takes the roots as arguments). Default: leave the import and record it as an exception.
6. **A response schema on every JSON route** (decided 2026-11-10, technical call, Q25 and Q53). As above. Pass-through JSON uses a loose object. The 11 streams, binaries and multipart routes are exempt, each with an entry in `scripts/conventions.json`. A schema lives in `packages/shared` when the web client imports it (Q55), as every existing `*Schema` does, and otherwise in its feature folder.
7. **The error body** (decided 2026-11-10, technical call, Q43). Keep `{ error: CODE, message? }`, pass Fastify's own 4xx through, never echo a thrown message.
8. **The test runner and layout** (decided 2026-11-10, technical call, Q27). `node:test` stays, with `allowForKnownSafeCalls` for it in the lint (brief 02). Tests stay in `apps/api/test/`, and `buildTestApp` keeps its name.
9. **Timeouts and proxy.** Defaults, each checked against the longest request in step 1:
   - `connectionTimeout: 10_000`;
   - `keepAliveTimeout: 125_000`, above Caddy's two-minute idle keep-alive to its upstreams;
   - **`requestTimeout` left at Fastify's default (0)**, because compile and convert requests and 50 MB uploads (`MAX_UPLOAD_MB`) run long, and the jukebox long poll waits up to 20 s. Step 1 measures the longest route and the owner picks a number if there is one that is safe;
   - `trustProxy`: loopback plus `AUTH_TRUSTED_PROXIES`, so `request.ip` is the client. Ward's lockout reads the socket itself (`apps/api/vendor/ward/ward-auth.js`, the comment at line 877), so this does not change it.
10. **Logging.** Default: JSON as today, no `pino-pretty`.
11. **Fastify 5.12.8.** Default: not in this brief.
12. **Files over 400 lines** (rule 11). Nine files: `latex-compile.service.ts` (1,722), `latex.controller.ts` (1,027), `jukebox.service.ts` (849), `latex.service.ts` (715), `convert.service.ts` (691), `extract.service.ts` (531), `library.controller.ts` (469), `library.service.ts` (430), plus the baseline migration (603). Default: warnings, left. A split of `latex-compile.service.ts` is a separate question and not planned here.

## Files you OWN

- `apps/api/src/**`: the moves, the new plugins, the schemas wired in.
- `apps/api/package.json` (scripts, the new dependencies pinned, zod 4.5.4), `packages/shared/package.json`, `apps/web/package.json` (zod only), and `package-lock.json`.
- `packages/shared/src/**`: the zod 4 replacements named above (`profile.ts`, `lookup.ts`), and nothing else. Input schemas keep their behaviour.
- `apps/api/test/**`: only imports that name `modules/` or an old path, and the new tests.
- `infrastructure/Dockerfile`: the `CMD` line (line 105).
- The root `package.json`: `check:conventions` (dependency-cruiser added, `check-structure`'s `--warn-only` dropped).
- `.dependency-cruiser.cjs` (new, from the skill's preset), `scripts/conventions.json`, which also sets the checkers' roots for this monorepo (`apps/*` and `packages/*`, not `server/` and `web/`; decided 2026-11-10, technical call).
- `eslint.config.js`: `no-process-env` from warning to error.
- `.claude/rules/server.md`: the structure lines.
- `apps/web/src`: the zod import sites only if a 4.x API change forces a line (`apps/web/src/router.tsx`, `lib/library-api.ts`, `latex/latex-api.ts`). Expect none.
- Docs and corpus: `CLAUDE.md` (the `apps/api/src/modules/auth/` mention), [wiki/api-layering.md](../../wiki/api-layering.md), [wiki/architecture.md](../../wiki/architecture.md), [wiki/jukebox.md](../../wiki/jukebox.md), [wiki/conversion.md](../../wiki/conversion.md), [wiki/latex.md](../../wiki/latex.md), [wiki/decisions.md](../../wiki/decisions.md), [wiki/status.md](../../wiki/status.md), [log.md](../../log.md). Find the references with `grep -rn "src/modules" corpus CLAUDE.md docs`.

## Files you must NOT touch

- `apps/web` beyond the zod lines above. A response schema that drops a field the web reads is a finding: fix the schema, not the web.
- `apps/api/vendor/`: generated.
- `packages/typeset`: it uses no zod and no Fastify.
- Behaviour: status codes, error codes and bodies, and every route's JSON apart from fields the comparison shows were leaks.
- The deploy beyond the `CMD` line.

## What to do

Follow the skill's `migrating-a-server.md`. One commit per step; after each, `npm run check` and `npm run build` pass and `npm start` serves `GET /health`.

1. **Before.**
   - Run `check-structure` strict and record its counts by rule.
   - Seed a scratch data directory with `npm run seed:user -w @ebook-reader/api` and a few uploaded items.
   - Save the JSON of every one of the 53 JSON routes, signed in as the test user, with a profile, a note, a LaTeX project and a library book (no jukebox bot route needs a Discord guild: save its 400 and 404 replies).
   - Time the slowest request (a compile, a conversion if Calibre is installed, a 50 MB upload) for decision 9.
2. **zod 4.** Move zod to 4.5.4 in the three manifests. Replace the deprecated uses named above. Run `npm run typecheck`, `npm test` and `npm run build`. This is its own commit: the scratch copy measured 0 type errors and 147 passing tests, and the real run confirms it.
3. **`config.ts` and the entry.** Add `IS_PRODUCTION`, the parsed trusted-proxies value, `loadSeedConfig()` and `childProcessEnv()`; `seed-user.ts`, `index.ts` and `calibre.service.ts` use them. `no-process-env` finds nothing outside `config.ts`: make it an error. Rename `index.ts` to `server.ts`, with `close-with-grace`, the timeouts and `trustProxy`, and change the Dockerfile `CMD` and the two scripts in the same commit.
4. **The plugins.** `plugins/errors.ts`, `plugins/multipart.ts`, `plugins/auth/index.ts` (with `fastify-plugin`), and `db/` and `lib/` renames. Every test passes unchanged except for imports.
5. **Feature folders.** `git mv`, feature by feature per the map, so history follows. Add the `index.ts` files, switch the 24 cross-feature imports, add `.dependency-cruiser.cjs` with the recorded exceptions, and check that a deliberate import of `features/library/store.js` from `features/notes/` fails it.
6. **The type provider and the schemas, one feature per commit:** health, profiles, notes, catalog, lookup, library, latex, jukebox. Each commit declares params, querystring, body and response, removes that feature's request parsing, and adds the tests below. The error plugin maps a validation error to 400 `{ error: "INVALID_REQUEST" }` and a serialization error to 500 `{ error: "INTERNAL" }`.
7. **After.** Save the same JSON again and diff it against step 1's. A field that disappeared is a leak (keep it dropped and list it) or a missing schema field (add it). Put the diff's summary in the `log.md` entry.
8. **Strict.** Drop `check-structure`'s `--warn-only` and make dependency-cruiser part of `check:conventions`.
9. **Corpus.** Revise the [wiki/api-layering.md](../../wiki/api-layering.md) layout (it names `modules/`, `index.ts`, `common/`, `database/`), the other pages listed above, and add a [wiki/decisions.md](../../wiki/decisions.md) entry adopting the structure, with what was rejected (autoload, TypeBox, a `loadConfig()` factory, which the import-time rule makes unnecessary) and why. Run `bash corpus/lint.sh` until it is clean.

New tests, all through `buildTestApp()` and `inject()`:

- an extra field on a store row is stripped from a reply;
- a reply that fails its response schema is a 500 `{ error: "INTERNAL" }` with no detail;
- a malformed body, query and param each answer 400 `{ error: "INVALID_REQUEST" }`, and a foreign profile's note id still answers 404, never 403 (the profile-scoping rule in [wiki/api-layering.md](../../wiki/api-layering.md)). Validation runs before the ownership check, which is accepted (decided 2026-11-10, technical call, Q52): a malformed body answers 400 even for a foreign id, and a well-formed foreign id answers 404. Say so in the decision entry;
- `preferencesSchema`'s unknown keys survive a `PATCH` and a `GET`;
- `GET /health`;
- the LaTeX worker thread still starts from the built `dist/` (run the compiled `server.js` once in step 6, or a test that spawns `latex-worker.js` from the `dist/` path).

## Acceptance

- [ ] `check-structure` passes **strict**, with every exception in `scripts/conventions.json` and its reason. Its counts before and after are in the outcome note, for the skills library's brief 16 table.
- [ ] `grep -rnE "(\.parse|\.safeParse)\((request|req)\." apps/api/src` prints nothing, and every JSON route has a `schema` with a `response`.
- [ ] `grep -rn "process\.env" apps/api/src --include=*.ts | grep -v "common/config.ts\|config.ts"` prints nothing, and `no-process-env` is an error.
- [ ] `grep -rn "zod\"" apps/api/package.json apps/web/package.json packages/shared/package.json` shows `4.5.4` three times, and `package-lock.json` resolves one zod copy.
- [ ] The 147 existing tests pass with only import paths changed, and the new tests pass.
- [ ] The before and after JSON comparison is in `log.md`, with every dropped field named.
- [ ] `npm run build` writes `apps/api/dist/server.js`. `docker build -f infrastructure/Dockerfile .` succeeds and the container answers its `/health` check.
- [ ] dependency-cruiser fails on a deliberate cross-feature import and passes clean.
- [ ] `grep -rn "src/modules" CLAUDE.md corpus docs apps/api` prints nothing outside `corpus/log.md`.
- [ ] `npm run check` passes, and `bash corpus/lint.sh` ends clean.

## Interplay

- brief 02 leaves `no-process-env` as a warning for this brief to finish.
- The skills library should hear about three things before the other servers run its brief 16: the three feature cycles (Atrium's modules are layered, so they import across each other freely), `node:test` plus the typed `no-floating-promises` rule (814 false findings without `allowForKnownSafeCalls`), and the flat `{ error: CODE }` body, which differs from Almanac's `{ error: { code, message } }`.
- The web build is unaffected by the folder move. It is affected by zod 4 only through `packages/shared`.
