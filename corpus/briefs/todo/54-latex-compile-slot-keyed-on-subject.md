# Task 54 — The LaTeX compile slot is keyed on the Ward subject, not a dropped column

**Filed 2026-09-25** by the improvements sweep. **Critical:** once the Ward
cutover migration has run, no LaTeX document can be compiled, published or
cancelled.

## Context

The per-account compile single-flight has a durable half: a query asking whether
this account already has a project compiling. It still joins through the column
the Ward cutover removed
([`latex.model.ts:181-192`](../../../apps/api/src/modules/latex/latex.model.ts)):

```ts
export async function getRunningLatexCompile(userId: string) {
  return (await knex({ lp: "latex_projects" })
    .join({ p: "profiles" }, "p.id", "lp.profile_id")
    .select("lp.*")
    .where("p.user_id", userId)          // ← profiles has no user_id since D53
    .andWhere("lp.compile_status", "running")
```

[`20260906000000-ward-cutover.ts`](../../../apps/api/src/database/migrations/20260906000000-ward-cutover.ts)
rebuilds `profiles` with `subject` in place of `user_id`. The caller already
passes a subject: `uid(request)` is `request.ward!.subject`
([`latex.service.ts:437`](../../../apps/api/src/modules/latex/latex.service.ts)).
The column name is the only thing wrong.

The query is on the path of all three LaTeX write routes, which all return 500
(`SQLITE_ERROR: no such column: p.user_id`, reproduced against the post-cutover
schema during the sweep):

- `POST /latex/:id/compile` and `POST /latex/:id/publish`, through
  `startLatexCompile` ([`latex-compile.service.ts:642`](../../../apps/api/src/modules/latex/latex-compile.service.ts));
- `POST /latex/:id/cancel` ([`latex.controller.ts:640-642`](../../../apps/api/src/modules/latex/latex.controller.ts)).

The throw happens before the slot is claimed, so nothing gets wedged. The feature
is simply dead.

Typecheck cannot see this, because Knex column names are strings. It is the bug
class brief 40 recorded: an invariant nothing checks, broken in silence. The
cutover log entry says "Nothing has been run against a real browser or a
deployed Ward", which is how it shipped.

## Scope

**In:** the query, plus the `userId` naming that let it look right. The compile
service carries `userId` in `Job`, `runningLatexCompileInProcess(userId)` and
comments that say "joins through `profiles.user_id`". Rename it to `subject`
throughout, so the next reader is not misled the same way.

**Out:** the single-flight design itself, including D47's accepted window at
`releaseCompileRow`; the worker; the engine.

## Files you OWN

- `apps/api/src/modules/latex/latex.model.ts`
- `apps/api/src/modules/latex/latex-compile.service.ts` (the `userId` → `subject`
  rename and its comments only)
- `apps/api/src/modules/latex/latex.controller.ts` (the cancel route's local
  variable only)

## Files you must NOT touch

- `apps/api/src/modules/latex/latex-worker.ts`: brief 44's rule stands (no
  relative imports into `apps/api`).
- `apps/api/src/database/migrations/**`: the schema is correct; the query is
  wrong.
- `packages/typeset/**`.

## What to do

1. `.where("p.subject", subject)`, with the parameter renamed.
2. Rename `userId` to `subject` across the compile service and the cancel route.
   Correct the comments that name `profiles.user_id` (around
   `latex-compile.service.ts:625-626` and `:919-928`).
3. `grep -rn "user_id" apps/api/src` outside `migrations/` must return only
   history-explaining comments. It does today apart from this query; keep it so.

## Acceptance

Against a scratch database that has run every migration, including the cutover,
with all five storage roots set inline to a scratch base and asserted before
start:

- `POST /latex/:id/compile` succeeds, and so do publish and cancel.
- The slot is still **per account**:
  - a second compile from **another profile of the same subject** while the first
    runs gets the existing 409;
  - a compile from a **different subject** is not blocked.
- Typecheck and build are clean.
- If [brief 63](../done/63-api-test-harness.md)'s harness exists, add a test that runs a
  compile request against a post-cutover schema. This bug is exactly what such a
  test catches and typecheck does not.
