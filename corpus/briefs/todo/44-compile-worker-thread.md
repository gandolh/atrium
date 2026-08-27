# Task 44 — Host the typesetting engine on a worker thread

**Found during [brief 38](../done/38-latex-editor.md)** (2026-08-27) and
deliberately deferred rather than widened into it. Recorded so it is not
rediscovered as a mystery.

## Context

`compile()` from `packages/typeset` is a **synchronous** function. `apps/api`
calls it in-process (D38 — that purity is the sandbox, and it is the right
design). But synchronous means it **blocks the entire API process** for the
duration of a compile: while the engine holds the thread, Node is not reading
requests.

Two consequences, one cosmetic and one not:

1. **"Cancellable" is weaker than it sounds.** `latex-compile.ts` passes an
   `AbortLike` the engine polls at its step boundary, which works — but only for
   a job still *queued*. A cancel arriving while the engine runs cannot be
   delivered at all, because the handler that would receive it is not running.
   The 409 busy message was reworded in brief 38 to stop promising a cancel that
   cannot happen.
2. **It stalls other devices.** D36's premise is *your stuff, reachable from
   anywhere* — phone and desktop at once. A compile on the laptop freezes the
   reader on the phone for its duration.

**Why it was not fixed in brief 38.** It is bounded today: a small document is
~80 ms and the deterministic step budget stops a runaway in about the same. The
fix needs a second module plus dev (`tsx`) versus prod (`dist`) worker-path
resolution, which was outside the chunk that found it. **Briefs 39 and 40 are
what make it urgent** — figures, tables and especially math make compiles
materially longer.

## Scope

**In:**

- Host `compile()` on a **`worker_thread`**, so the API event loop stays free.
- **The exported contract of `latex-compile.ts` does not change.**
  `startLatexCompile` / `cancelLatexCompile` / `isCompilingLatexProject` and the
  artifact helpers keep their signatures; this brief changes only how that
  module *hosts* the engine. If the contract seems to need changing, stop and
  say so — chunks 4 and 6 of brief 38 are built on it.
- **Cancellation becomes real**: terminating or signalling the worker must stop
  a compile that is already running, not merely one that is queued.
- **A cancel route**, now that one can work. Brief 38 deliberately omitted it
  and reworded the 409 message; restore the honest wording once the capability
  exists.
- Worker path resolution that works in **both** `tsx` dev and built `dist`.
- The slot discipline is unchanged and still absolute: **every** exit path —
  success, failure, timeout, cancel, worker crash, worker exit, process
  shutdown — releases the slot and leaves no job-map entry. Brief 34 and brief
  38 each shipped a wedge here; a worker adds *new* exit paths, so this is the
  part to be paranoid about.

**Out:** changing `packages/typeset` (the engine stays a pure synchronous
function — that is what makes it testable); parallel compiles (still one per
account); moving anything else off the main thread.

## Files you OWN

- `apps/api/src/latex-compile.ts` and a new worker module beside it
- `apps/api/src/latex-routes.ts` — the cancel route and the reworded 409
- `apps/api/package.json` — only if the worker needs a build-step change
- `corpus/wiki/latex.md` — replace the "Known limitation" section with what
  shipped

## Files you must NOT touch

- `packages/typeset/**` — the engine is not the problem and must not change.
- `apps/web/**` — except that a cancel route may want a button; if so, keep it
  to the existing compile-button area and obey `design.md`.

## Acceptance

- A long compile **does not block** other requests: prove it by serving a
  library file, or a second profile's `GET /library`, *while* a compile runs.
- A running compile can be **cancelled**, and the slot is free afterwards —
  demonstrated, not asserted.
- A worker that **crashes or is killed** releases the slot and reports a
  diagnostic; the account is not wedged. Kill it deliberately and show this.
- Every brief 38 behaviour still holds: single-flight per account, the step
  budget, `LATEX_TIMEOUT_MS`, output caps, `stopped` diagnostics, artifacts on
  disk, the last-good PDF surviving a failure.
- Works in `npm run dev` **and** from `dist/`.
- Typecheck + build + tests clean.
