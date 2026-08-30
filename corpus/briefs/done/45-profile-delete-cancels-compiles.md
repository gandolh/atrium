# Task 45 — `DELETE /profiles/:id` must cancel the compiles it orphans

**Promoted 2026-08-29** from
the `profile-delete-orphans-compiles` capture (retired 2026-08-29
with `corpus/todos/`; this brief carries its full content),
which was filed during brief 44's review. Pre-existing — brief 44 did not
introduce it and deliberately did not fix it.

## Context

[`profile-routes.ts:206-256`](../../../apps/api/src/profile-routes.ts) deletes a
profile without cancelling any compile running on it, and leaves the projects'
working trees on disk. `latex_projects.profile_id` is `ON DELETE CASCADE`
([`db.ts:427`](../../../apps/api/src/db.ts)), so the row vanishes **while the
job still holds the account's single-flight slot**.

**This is the root cause of one of brief 44's Important findings.** That brief
fixed only the *mis-reporting* — the 409 no longer hands back a
`runningProjectId` addressing a project that no longer exists — so the slot is
still uncancellable until the compile ends on its own, bounded by
`LATEX_TIMEOUT_MS`. Under D35 the limit is **per account**, so one person
deleting a profile can wedge compiles for everyone on that account.

## Scope

**In:** cancel every running compile on a profile before deleting it, and clean
up the orphaned project trees.

**Out:** any change to the single-flight model itself (D35), the worker
lifecycle (brief 44), or the cancel route's own semantics.

## Files you OWN

- `apps/api/src/profile-routes.ts`
- a test alongside the existing API tests, if the shape allows one

## Files you must NOT touch

- `apps/api/src/latex-compile.ts` — the cancel primitive already exists and is
  correct; this brief *calls* it. If it seems to need changing, stop and say so.
- `apps/web/**`, `packages/**`.

## What to do

**The shape already exists** — `DELETE /latex/:id` does exactly this. Iterate
`listLatexProjects` for the profile and `await cancelAndSettleLatexCompile(p.id)`
before the delete, then remove the trees.

Mind the ordering: cancel **before** the cascade, or the rows naming the
projects are already gone.

## Acceptance

- Deleting a profile with a compile running on it frees the account's slot
  **immediately**, demonstrated rather than asserted — start a long compile,
  delete the profile, and show a second compile starts at once.
- The projects' trees are gone from disk afterwards.
- Deleting a profile with nothing running is unchanged.
- A compile running on a *different* profile of the same account is untouched.
- Typecheck + build clean.

**Verify against a scratch database with all five storage roots redirected, set
inline and asserted before the server starts** — see the 2026-08-29 incident in
[open-questions.md](../../wiki/open-questions.md).

---

## Outcome (2026-08-30) — shipped, `ef166fd`

`DELETE /profiles/:id` reads `listLatexProjects` **before** the cascade, awaits
`cancelAndSettleLatexCompile` per project, then removes the trees with the same
helper and ordering `DELETE /latex/:id` uses.

**Demonstrated, not asserted.** With a 20.5 s compile running: the account was
refused with 409 at t+3.02 s; the delete returned at t+3.44 s having cancelled
and settled; the next compile on a *different profile of the same account* was
accepted immediately and finished by t+4.33 s. Before the change it would have
waited to ~t+20.5 s, or to `LATEX_TIMEOUT_MS`.

Two things worth carrying: the route now takes ~340 ms when a compile is running
(it was always ~3 ms) and nothing in `apps/web` was checked against that; and it
gained an import edge `profile-routes → latex-routes` for `removeProjectTree`,
verified acyclic, chosen over duplicating the ENOTEMPTY retry logic.
