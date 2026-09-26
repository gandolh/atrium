# Task 68 — Close two read-then-write races the Knex move left open

**Filed 2026-09-25** by the improvements sweep. D47's bug class ("an invariant
paid for by the runtime, not by the code") has two more members than D47 found.

## Context

D47 records that moving to Knex put suspension points between statements that
`better-sqlite3` used to run back to back. It fixed the three places that relied
on that. The sweep found two more. Both were reproduced on a scratch database
with the real service functions.

### 1. Moving folders can create a cycle, and the cycle hides the notes

[`updateFolder`](../../../apps/api/src/modules/notes/notes.service.ts)
(`notes.service.ts:158-176`) checks `wouldCycleNoteFolder`, then separately
awaits `setNoteFolderParent`. Two concurrent moves, A under B and B under A (two
devices, or two tabs), both pass the ancestry walk and both write, leaving
`A.parent = B` and `B.parent = A`. The web tree is built from the root, so
**both folders, every subfolder, and every note filed in them vanish from the
Notes screen, with no UI path to move them back.** The rows still exist; they
are just unreachable.

### 2. Concurrent preference writes lose each other's keys

[`writePreferences`](../../../apps/api/src/modules/profiles/profiles.service.ts)
(`profiles.service.ts:270-278`) merges the patch over `profile.preferences`, a
snapshot read before the request's own await chain, then writes. Two PATCHes for
one profile, such as a laptop and a phone, or a first-run adoption write racing
a debounced one, merge over the same snapshot. Reproduced: `{theme:"dark"}` and
`{pageMode:"scroll"}` arriving together stored only `{"pageMode":"scroll"}`.

**The trap in the obvious fix.** The pool has exactly one connection (D47). A
query issued on the **global** `knex` inside a `knex.transaction(async (trx) =>
…)` callback waits for that one connection, which the transaction is holding. It
deadlocks until `acquireConnectionTimeout` (120 s,
[`knex.ts`](../../../apps/api/src/database/knex.ts)) and then fails. Every
statement inside the transaction must use `trx`. The codebase keeps its
transactions **inside model functions** for this reason: see `deleteNoteFolder`
and `reassignNotes` in `note-folders.model.ts:100-149`.

## Scope

**In:** making each check-and-write atomic.

**Out:**
- the preference merge **semantics**: one level deep, and unknown keys survive;
  brief 35 step 8;
- the folder tree UI;
- any other write path.

## Files you OWN

- `apps/api/src/modules/notes/note-folders.model.ts`: an atomic move
- `apps/api/src/modules/notes/notes.service.ts`
- `apps/api/src/modules/profiles/profiles.model.ts`: an atomic preferences update
- `apps/api/src/modules/profiles/profiles.service.ts`

## Files you must NOT touch

- `apps/api/src/database/knex.ts`: the pool size is D47's, and not the fix.
- `apps/web/**`.

## What to do

1. **Folder move.** Add a model function that, in **one** `knex.transaction`,
   runs every statement on `trx`:
   - re-reads the folder and the target parent, scoped to the profile;
   - runs the ancestry walk;
   - writes the parent.

   It returns the same tagged outcomes as today (`NOT_FOUND`, `CYCLE`). The
   service keeps its role and calls it. A rename in the same PATCH may join the
   transaction or stay outside it; say which in the outcome.
2. **Preferences.** Add a model function
   `updateProfilePreferences(id, merge: (stored) => next)` that reads the
   **current** row and writes `merge(stored)` in one transaction on `trx`. The
   service keeps the merge rule and passes it in. Do not use SQLite's
   `json_patch`: it merges **deeply** and would change the documented one-level
   semantics.

## Acceptance

Run each race through `Promise.all`, via `app.inject` if
[brief 63](63-api-test-harness.md) has landed, or via the service functions
otherwise, on a scratch database:

- **Opposite folder moves:** exactly one succeeds, the other answers `CYCLE`, and
  the tree has no cycle.
- **Two concurrent preference PATCHes with different keys:** both keys persist.
- **No hangs:** neither path waits on the pool. Each completes in milliseconds,
  not after a 120 s acquire timeout.
- Existing behaviour is unchanged: rename, move to root, move into a descendant
  refused, preference reads.
- Typecheck and build are clean.
