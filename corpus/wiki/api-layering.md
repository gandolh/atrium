---
summary: How apps/api is organised since D47 — the six domain modules, what a controller/service/model may and may not do, the tagged-union outcome convention, profile scoping in SQL, and how Knex migrations are registered.
updated: 2026-08-30
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
  common/         config.ts · paths.ts · password.ts
  database/       knex.ts · bootstrap.ts · errors.ts · migrations/
  modules/
    auth/         controller · service · model · guard
    profiles/     controller · service · model · mapper
    library/      controller · service · model · types · mapper
                  + extract · calibre · convert · maintenance services
    catalog/      controller · service · gutendex service
    notes/        controller · service · model · note-folders model
                  + mapper · note-pdf service
    latex/        controller · service · model · compile service
                  + latex-paths · latex-worker · project-tree service
```

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

**Migrations** live in `database/migrations/` and are registered by **static
import** in its `index.ts` (a scanned directory picks a loader by file extension,
which breaks between `.ts` under tsx in dev and `.js` under `dist/` in
production). `20260830000000-baseline.ts` is idempotent because it has to bring
both a fresh database and a pre-Knex one to the same place; **every migration
after it is an ordinary forward migration and must not be.**
