# Task 46 — A swallowed `setLatexCompileStatus` failure must not wedge an account

**Promoted 2026-08-29** from
the `swallowed-compile-status-write` capture (retired 2026-08-29
with `corpus/todos/`; this brief carries its full content),
filed during brief 44's review. The code is **byte-identical to the pre-brief-44
version**, so it is not that work's defect.

## Context

In [`latex-compile.ts`](../../../apps/api/src/latex-compile.ts), `runCompile`'s
`finally` swallows a failing `setLatexCompileStatus`.

**The swallow is correct for one case and wrong for another.** A zero-row
`UPDATE` — the project was deleted mid-compile — is exactly what should be
ignored, and that case is real (see [brief 45](45-profile-delete-cancels-compiles.md)).
But `SQLITE_BUSY` / `SQLITE_FULL` are swallowed identically, and then the row
stays `running` while the in-process job map is already empty. Nothing
reconciles the two: `reapInterruptedLatexCompiles` runs **at import**, so the
account stays wedged **until the API restarts**.

The bug is inferring "benign" from the *fact* that a write failed, rather than
from *why*.

## Scope

**In:** distinguish "no rows matched" from a genuine write failure, and handle
each on its merits — the first stays silent, the second is at minimum logged
loudly and at best retried.

**Out:** a general retry layer for every write in the API; changing the reaper's
schedule is *in* scope only if that is the chosen fix, and then say so
explicitly rather than adding it alongside.

## Files you OWN

- `apps/api/src/latex-compile.ts`
- a test alongside the existing API tests

## Files you must NOT touch

- `apps/api/src/latex-worker.ts` — brief 44's ruling stands: **zero relative
  imports into `apps/api`**, because plain Node type-stripping must be able to
  load it.
- `packages/typeset/**` — the engine is not involved.

## What to do

1. Have the status write report **which** failure it hit. `better-sqlite3`
   surfaces a `code` (`SQLITE_BUSY`, `SQLITE_FULL`); a zero-row update is
   `changes === 0`, not an exception at all — which is the distinction the
   current code collapses.
2. Keep the zero-row path silent, and make the error path loud.
3. Decide, and **write down in the outcome**, whether a wedged row is recovered
   by a retry, by a periodic reap, or by leaving it to restart. Any of the three
   is defensible; leaving it *undecided* is what produced this bug.

## Acceptance

- A zero-row update (project deleted mid-compile) stays silent and frees the
  slot — the behaviour that exists today, proven not to regress.
- A genuine write failure is **reported**, not swallowed, and the account is not
  left permanently wedged. Demonstrate it by forcing the failure, not by
  reasoning about it.
- Typecheck + build clean.

**Verify against a scratch database with all five storage roots redirected, set
inline and asserted before the server starts** — see the 2026-08-29 incident in
[open-questions.md](../../wiki/open-questions.md).
