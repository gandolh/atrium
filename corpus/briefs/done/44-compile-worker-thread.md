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

## Outcome (2026-08-28) — done

**The engine now runs on a `worker_thread`, and cancel is real.**
`latex-compile.ts` spawns [`latex-worker.ts`](../../../apps/api/src/latex-worker.ts)
**per compile** and awaits its result; `compile()` itself is untouched — its
synchronous contract was never the problem, only where it ran.

**Acceptance, on controller-run evidence.** A rig drove
`apps/api/dist/latex-worker.js` directly and measured main-thread heartbeats
during a long compile: a **10.4 s** compile left the spawning thread with **514
heartbeats, worst extra gap 1 ms**. Cancel was demonstrated rather than
asserted — a `DELETE` on a running compile terminates the worker mid-engine
instead of waiting out `LATEX_TIMEOUT_MS`.

**Worker-per-compile, not a reused worker — a ruling, not an implementation
detail.** A reused worker cannot be `terminate()`d without destroying the next
compile's host, so stopping it has to be *cooperative*, which is precisely what
cannot work against a synchronous engine that never yields to a flag. A fresh
worker can simply be killed. Real cancellation is this brief's point, and the
reused-worker design forecloses it.

**`latex-worker.ts` must keep zero relative imports into `apps/api`.** It may be
loaded by plain Node type-stripping rather than tsx, where this package's
`.js`-suffixed specifiers do not resolve — dev would break while `dist/` worked.
Values go through `LatexWorkerRequest` instead. Verified in `npm run dev` and
from `dist/`.

**Review: 3 finders, 3 Important findings, all fixed.** The one worth carrying
forward: a "re-check the flag" fix on a synchronous-resume path **needs an
`await`**. The microtask queue drains fully before any timer or I/O callback, so
a re-check with nothing to yield on cannot observe a flag that an inbound
*request* set. This was proven with a three-way rig after the controller
specified the fix wrongly the first time.

**A cancel is never offered where it cannot be taken.** A sibling profile's
project 404s at the cancel route, so `busyMessage`'s third branch makes no
offer; and the 409 for a slot held only in-process omits `runningProjectId`,
because that id addresses a project that no longer exists.

**Found, deliberately not fixed** (filed as todos, both pre-existing and
byte-identical to the pre-brief-44 code):

- ``DELETE /profiles/:id` never cancels the compiles on the profile it deletes`
  — the **root cause** of one of this brief's findings. Brief 44 fixed only the
  mis-reporting; the slot stays uncancellable until it ends on its own.
- `a swallowed `setLatexCompileStatus` failure can wedge an account until restart`.
