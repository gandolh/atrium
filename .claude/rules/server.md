---
paths:
  - "apps/api/src/**"
  - "packages/shared/src/**"
---

# The API and the shared package (`apps/api/src`, `packages/shared/src`)

The code-structure skill's rules, as they hold here. Read
[corpus/wiki/api-layering.md](../../corpus/wiki/api-layering.md) before you add or move a route.

- `server.ts` is the entry and the only file that listens; `app.ts` exports `buildApp` and registers, in order, the
  errors plugin, the zod compilers, `plugins/auth`, multipart, then each feature by name.
- `config.ts` is the only reader of `process.env` (`n/no-process-env` is an error). Settings are import-time
  constants; a CLI takes its settings from a `config.ts` function (`loadSeedConfig`).
- A feature is `features/<name>/`: `routes.ts` (a `FastifyPluginAsyncZod` plugin), `service.ts`, `store.ts`,
  `mapper.ts`, and an `index.ts` that is the only way in from outside the folder. A store another feature or the
  guard reads lives in `db/` instead. dependency-cruiser fails a reach past an index and any cycle.
- Every route declares `params`, `querystring` and `body` as it takes them and a `response` for each status its
  handler sends; error statuses use `errorBody` from `plugins/errors.ts`. No handler parses request input or its
  own reply. Shared schemas come from `packages/shared` when the web imports them, else they live in the feature.
  A binary or multipart route declares its inputs only and has a `scripts/conventions.json` entry.
- A response schema only encodes: no `.transform()`, and `.default()` or `.catch()` don't apply on the way out, so
  decode stored data in the mapper (the notes pages do). Keys go out in the schema's order, which is why
  `botCommandSchema` lists its keys as the server writes them: just-a-bot reads those bytes.
- Errors are flat, `{ error: CODE, message? }`. A failed schema is 400 `INVALID_REQUEST` unless the route names its
  own code (`invalidRequestAs`); a 5xx is `{ error: "INTERNAL" }`; Fastify's own 4xx keep their status and body.
- A service returns a tagged union for a normal outcome. A thrown error is a 500 that says nothing to the client.
- Every notes, folders and LaTeX query is keyed on `profile_id`. A foreign id is a 404, never a 403; validation runs
  first, so a malformed body on a foreign id is a 400.
- A value the guard or a write guarantees is narrowed with `present()` from `lib/present.ts`, not a `!`.
- `apps/api/vendor/` is Ward's generated library. Never edit it.
- Tests go through `buildTestApp` in `apps/api/test/harness.ts`, on `node:test`, and stay in `apps/api/test/`.
- `npm run check:conventions` runs `check-structure` strict over these folders.
