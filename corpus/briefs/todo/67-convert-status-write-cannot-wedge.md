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
