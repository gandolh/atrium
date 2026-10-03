# Task 67 — A failed conversion status write cannot wedge conversions install-wide

**Filed 2026-09-25** by the improvements sweep. This is brief 46's bug, on the
conversion side, where brief 46 never reached.

## Context

[Brief 46](../done/46-compile-status-write-failure.md) fixed this failure for
LaTeX compiles: "a swallowed status write can wedge until restart". Its fix was
`pendingStatusWrites`, replayed before the guard is read
(`latex-compile.service.ts:488-542`). The conversion job runner has the same
shape and no such fix.

In [`convert.service.ts`](../../../apps/api/src/modules/library/convert.service.ts),
a job's terminal status write goes through `fail()` (`:461-464`) or through the
last-resort `catch` (`:447-457`):

```ts
} catch {
  try {
    await setConvertStatus(source.id, "failed", "The conversion failed unexpectedly.");
  } catch {
    // The DB itself is gone; there is nowhere left to record anything.
  }
} finally {
  jobs.delete(source.id);
}
```

If `setConvertStatus` throws (`SQLITE_BUSY` past the driver's retry,
`SQLITE_FULL`, an I/O error, or a pool acquire timeout), the in-process job is
removed but the row stays `convert_status = 'running'`. From then on:

- **Every conversion in the install is refused.**
  [`claimConvertSlot`](../../../apps/api/src/modules/library/library.model.ts)
  (`library.model.ts:263-269`) is one atomic
  `UPDATE … WHERE NOT EXISTS (… convert_status = 'running')`, the D47 fix. It
  now sees a running row that nothing is running, and returns 409.
- **Cancel cannot rescue it.** `cancelConvert` (`:319-326`) finds no in-process
  job and returns false, so the route answers 404.
- **Only a restart clears it.** The boot reaper `reapInterruptedConversions` does
  that.

`cancelConvert` has a second path to the same state: if its `resetConvert` write
throws, the caller gets a 500, and the cancelled job exits without writing any
status.

It is rare, because it needs a failing database write. But the owner judged this
exact failure worth a brief on the compile side, and conversions share one
install-wide slot (D34), so the wedge affects every book, not one.

## Scope

**In:** the conversion runner's terminal status writes and cancel's reset.
Recovery without a restart.

**Out:** the D34 one-at-a-time rule; the 24 h reaper; the boot reaper; the
compile side, which brief 46 already fixed.

## Files you OWN

- `apps/api/src/modules/library/convert.service.ts`

## Files you must NOT touch

- `apps/api/src/modules/library/library.model.ts`: `claimConvertSlot` is D47's
  atomic claim and stays exactly as it is.
- `apps/api/src/modules/latex/**`: the pattern to mirror lives there; read it,
  don't change it.

## What to do

1. **Mirror brief 46.** When a terminal write (`ready`/`poor`/`failed`, or the
   cancel reset) throws, log it **loudly**, with the SQLite code and the book id,
   and park the intended write in a module-level `pendingStatusWrites` map.
2. **Replay parked writes at the top of `startConvert`**, before the slot is
   claimed, skipping any book whose job is running again in this process. Also
   replay in the cancel path before it decides there is nothing to cancel.
3. **Write the recovery ruling into the outcome**, as brief 46 did. Its reasons
   (a periodic reap is unsafe outside boot; spinning blocks the event loop) apply
   here too. Say whether they carried over.

## Acceptance

- Force a real `SQLITE_BUSY` during a job's terminal write, using brief 46's
  method (a second connection holding `BEGIN IMMEDIATE`). The failure is logged
  with its code.
- Release the lock, then start a conversion of **another** book. It is accepted:
  no 409, no restart.
- A normal convert, a cancel and a failed convert behave exactly as before.
- Typecheck and build are clean.
- Verify against a scratch base with all five storage roots set inline and
  asserted before start. Calibre may be unavailable on this host (see
  [open-questions.md](../../wiki/open-questions.md)); a job that fails for that
  reason still exercises the terminal write.

## Outcome (2026-10-03)

Done.

**Change** (`convert.service.ts` only):
- Every terminal write on a source row goes through `recordStatusWrite`, which never rejects. That covers `ready`/`poor`, `fail()`'s `failed`, the last-resort `failed`, and cancel's reset to `none`.
- On a throw it parks the write in `pendingStatusWrites`, keyed by book, and logs `[convert] could not … for book <id> — SQLITE_BUSY: …` with what it means and how it clears.
- `flushPendingStatusWrites` replays the map:
  - at the top of `startConvert`, before anything reads the slot;
  - in `cancelConvert` when there is no in-process job.
- A recovery logs `[convert] recovered: …`.
- A cancel whose reset throws now answers 204 with the reset parked, instead of a 500.

**One deliberate difference from brief 46's replay:** an entry whose book is still in `jobs` is **skipped but kept**, not deleted. On the conversion side that book can be a *cancelled* job whose child is still dying, and it writes no status of its own. The first version dropped the entry there, and the test caught the row staying `running` with the reset lost. A new job for the same book replaces or clears the entry through its own terminal write, so a kept entry never goes stale.

**Recovery ruling.** Brief 46's reasons carried over unchanged:
- not a periodic reap (`reapInterruptedConversions` flips every `running` row, safe only at boot);
- not an immediate retry (better-sqlite3 already waited 5 s synchronously, and spinning blocks the event loop);
- deferred to the next convert or cancel, free while the map is empty.

The boot reaper and the 24 h reaper are unchanged, and `claimConvertSlot` is untouched.

**Tests** (`test/convert-status-write.test.ts`). A real `SQLITE_BUSY` is forced by a second better-sqlite3 connection holding `BEGIN IMMEDIATE`, on the harness's scratch roots.
- **A job's terminal `failed` write is blocked:**
  - the source file is removed, so Calibre fails fast;
  - the failure is logged with `SQLITE_BUSY`, and the row is still `running`;
  - after release, converting **another** book answers 202, not 409, with no restart;
  - the wedged row reads `failed`, and the real conversion of the other book finishes `ready`/`poor`.
- **A cancel's reset is blocked:**
  - the cancel answers 204, and the parked reset is logged;
  - the next convert of another book is accepted once the dying job lets go, and the cancelled book reads `none`.
- Both fail on the old runner.
- 65 API tests pass, and typecheck and build are clean.
