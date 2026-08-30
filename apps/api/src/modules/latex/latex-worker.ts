import { parentPort, workerData } from "node:worker_threads";
import { compile, createLatinModernProvider, createMathRenderer } from "@ebook-reader/typeset";
import type { AbortLike } from "@ebook-reader/typeset";
import { loadLatinModernBytes } from "@ebook-reader/typeset/fonts/node";
import type { Diagnostic } from "@ebook-reader/shared";

/**
 * The worker thread that runs the typesetting engine (brief 44 chunk 1).
 *
 * `compile()` is a **pure synchronous function** and stays that way — that
 * purity is the sandbox (D38) and the engine is deliberately not being changed.
 * But synchronous means whichever thread calls it is blocked for the whole
 * document, and until now that thread was the API's only one: while a compile
 * ran, Fastify read no requests, so a phone reading a book stalled on a laptop
 * compiling a paper (D36 says both should work at once) and a cancel could not
 * even be *delivered*, let alone honoured.
 *
 * This module is the fix, and it is the whole fix: one thread whose entire life
 * is one compile. `latex-compile.ts` spawns it, hands it the project in
 * `workerData`, and gets one message back. Nothing else changes — the engine is
 * called here exactly as it was called there.
 *
 * ## Two rules about this file specifically
 *
 * **1. Zero relative imports into `apps/api`.** The imports above are the whole
 * list, and the list is a constraint rather than a coincidence. `apps/api` is
 * ESM whose relative specifiers carry a `.js` suffix on files that are `.ts` on
 * disk (`./config.js` → `config.ts`); that resolves only because dev runs under
 * `tsx`, which rewrites it. A worker started from a `file:` URL may be loaded by
 * plain Node's type stripping instead, where `./config.js` is simply a file that
 * does not exist — `ERR_MODULE_NOT_FOUND` in dev while `dist/` works fine,
 * which is a miserable asymmetry to debug. Bare specifiers
 * (`@ebook-reader/typeset` → its built `dist/`) and `node:` builtins resolve
 * identically either way, so those are all this module is allowed.
 *
 * Everything else it needs therefore arrives as a **value** in
 * `LatexWorkerRequest`: the file map, the entrypoint, the output cap, the
 * deadline. If this module ever seems to need something from `config.ts`, the
 * answer is another field on that interface, not an import.
 *
 * **2. Erasable syntax only.** Under plain Node the types here are *stripped*,
 * not compiled: there is no type checker in the loop, so `import type` must be
 * spelled out (a value import of a type-only name is a runtime
 * `SyntaxError` about a missing export) and enums, namespaces and constructor
 * parameter properties do not work at all. `apps/api`'s tsconfig does not set
 * `erasableSyntaxOnly`, so nothing but this comment enforces it — keep the
 * imports above type-annotated as they are.
 */

// --- The protocol ------------------------------------------------------------

/**
 * What the host puts in `workerData`. One compile's entire input, by value.
 *
 * `deadline` is an **absolute epoch millisecond**, not a duration, because the
 * clock the host started is the one that matters: worker startup and the
 * structured clone of `files` both happen after the job was accepted, and a
 * duration restarted here would silently extend the wall-clock limit by however
 * long spawning took.
 */
export interface LatexWorkerRequest {
  /** The project's working tree — POSIX-relative path to raw bytes. */
  files: Record<string, Uint8Array>;
  /** Key of `files` to start from. */
  entrypoint: string;
  /** `LATEX_MAX_OUTPUT_BYTES`, passed as a value (see rule 1 above). */
  maxOutputBytes: number;
  /** `Date.now()` at which the wall-clock backstop fires. */
  deadline: number;
}

/** `CompileStats`, restated so the protocol does not depend on the engine's type. */
export interface LatexWorkerStats {
  pages: number;
  steps: number;
  bytes: number;
}

/**
 * The single message this worker posts, after which it has nothing left to do
 * and its thread exits.
 *
 * **`pages` is deliberately absent.** `compile()` returns the positioned layout
 * beside the PDF, the host has never used it, and structured-cloning a whole
 * document's worth of boxes and glue across a thread boundary would be pure
 * cost. Only what the host actually reads crosses.
 *
 * `ok: false` covers a throw from *this module* — `loadLatinModernBytes()` opens
 * twelve files and can fail, and a malformed `workerData` would too. The engine
 * itself is documented never to throw; if it somehow does, the same branch
 * catches it. Either way the host gets a message rather than only an `error`
 * event, which is what lets it name the failure in a diagnostic.
 */
export type LatexWorkerResponse =
  | {
      ok: true;
      /** `null` whenever the engine produced an error-severity diagnostic. */
      pdf: Uint8Array | null;
      diagnostics: Diagnostic[];
      stats: LatexWorkerStats;
      /** True when the wall clock below, not the host, stopped this compile. */
      timedOut: boolean;
    }
  | { ok: false; message: string };

// --- The wall clock ----------------------------------------------------------

/**
 * Why the deadline still has to travel through the abort signal, even now that
 * the engine has a thread of its own.
 *
 * Moving `compile()` off the main thread frees the *API's* event loop, not this
 * one: the engine still blocks the thread it runs on for the whole document, so
 * a `setTimeout` scheduled in here would be delivered only after the compile it
 * was meant to bound. `CompileOptions.signal` is not a subscription — the engine
 * *polls* `signal.aborted` at every step boundary (`spend()` in
 * `packages/typeset/src/macro/budget.ts`), and `AbortLike` is structural, so a
 * **getter** that reads the clock gets evaluated inside the engine's own loop.
 * That remains the only place during a synchronous compile where anything of
 * ours can run.
 *
 * The host keeps a second, harder backstop — it terminates this thread if the
 * deadline passes and no result has arrived — precisely because a getter can
 * only fire where the engine polls. This one is still worth having: a
 * cooperative stop lets the engine report *where* it stopped, and it costs the
 * host nothing.
 *
 * The two layers of the limit itself are unchanged from brief 34/38. The
 * engine's **step budget** is the real guard — a count, so it stops a runaway
 * `\newcommand` at the same point on every machine, which is what makes "this
 * compile was stopped" reproducible (D38). The **wall clock** covers only what a
 * step count cannot see, and is set generously (two minutes) so that it never
 * arbitrates a legitimate document.
 *
 * The clock is sampled every `CLOCK_POLL_INTERVAL` polls rather than on each
 * one: a runaway spends five million steps, and five million `Date.now()` calls
 * would tax every ordinary compile for the sake of a limit two minutes wide.
 */
const CLOCK_POLL_INTERVAL = 1024;

interface WorkerSignal extends AbortLike {
  /** True when the wall clock fired. The host reports the reason; see `finish`. */
  readonly timedOut: boolean;
}

function createWorkerSignal(deadline: number): WorkerSignal {
  let timedOut = false;
  let polls = 0;

  return {
    get timedOut(): boolean {
      return timedOut;
    },
    get aborted(): boolean {
      if (timedOut) return true;
      // Post-increment, so the very FIRST poll reads the clock: spawning a
      // thread and cloning the file map both take time, and a deadline that
      // had already passed must be seen immediately rather than 1024 steps in.
      if (polls++ % CLOCK_POLL_INTERVAL !== 0) return false;
      timedOut = Date.now() >= deadline;
      return timedOut;
    },
  };
}

// --- One compile -------------------------------------------------------------

/**
 * The fonts, read here rather than in the host.
 *
 * The engine performs no I/O of its own (D38), so somebody has to open the font
 * files, and `@ebook-reader/typeset/fonts/node` is the one module in that
 * package permitted to. **That somebody is this line** — omit `fonts` and the
 * compile stops with a `missing-font` error and an empty result rather than
 * quietly setting the document in some other face.
 *
 * The host used to cache the parsed provider for the life of the process. A
 * thread per compile cannot: the ~1.2 MB across twelve committed `.otf` files is
 * re-read and the faces re-parsed every time. Measured, that is single-digit
 * milliseconds against a compile of tens — the same order as spawning the thread
 * — and it buys a compile that starts from a guaranteed-clean heap and can be
 * killed outright. Reusing one long-lived worker would recover it; see the note
 * on `runEngineInWorker` in `latex-compile.ts` for why that trade was declined.
 */
async function runEngine(request: LatexWorkerRequest): Promise<LatexWorkerResponse> {
  const signal = createWorkerSignal(request.deadline);
  const fonts = createLatinModernProvider(loadLatinModernBytes());
  /*
   * Mathematics (brief 40). `compile()` stays synchronous — the renderer is
   * *injected*, exactly as fonts are, because `createMathRenderer()` has to
   * load MathJax and warm its lazily-split fonts before anything can be set.
   *
   * It is built unconditionally rather than only for documents that look like
   * they contain math. A cheap scan of the source for `$` or `\begin{equation}`
   * would save ~210ms on prose-only compiles, but it would be a *guess* about
   * what expansion produces, and being wrong means a valid document reports
   * "no math renderer was supplied" — a confusing error on correct input. The
   * engine already refuses to fail silently here; paying the cost is how that
   * promise is kept cheaply.
   *
   * The cost lands on this thread, not the API's — which is the whole point of
   * brief 44. A compile got slower; nothing else got less responsive.
   */
  const math = await createMathRenderer();

  const result = compile(request.files, request.entrypoint, {
    signal,
    math,
    // The emitted PDF, not the input: a small document can loop into an
    // enormous one. The engine refuses to allocate above this and reports
    // `limit-exceeded` rather than filling the disk.
    maxOutputBytes: request.maxOutputBytes,
    fonts,
    // `stepBudget` and `maxPages` are deliberately left at the engine's
    // defaults. They are the *deterministic* guard (D38) and belong to the
    // engine's own contract; a second, differently-tuned number here would make
    // "this compile was stopped" depend on which caller ran it, which is the
    // property the budget exists to provide.
  });

  return {
    ok: true,
    pdf: result.pdf,
    diagnostics: result.diagnostics,
    stats: result.stats,
    timedOut: signal.timedOut,
  };
}

// --- Entry -------------------------------------------------------------------

/**
 * Everything happens at module scope, and that is what makes the thread exit.
 *
 * No `parentPort.on("message")` listener is installed, so once the post below
 * returns there is nothing keeping this thread's event loop alive and it ends on
 * its own. The host does not rely on that — it terminates the thread as soon as
 * the message is in hand, and treats an exit with no message as a failure — but
 * a worker that stays alive holding a released slot is the failure mode worth
 * designing out rather than handling.
 */
const port = parentPort;
if (port === null) {
  // Running this file as a program would compile nothing and report nowhere.
  throw new Error("latex-worker.ts is a worker_threads entry point and must be spawned by latex-compile.ts");
}

let response: LatexWorkerResponse;
try {
  // `await` at module scope: `runEngine` became async when the math renderer
  // arrived (brief 40), and this file is ESM in both of the ways it is loaded.
  response = await runEngine(workerData as LatexWorkerRequest);
} catch (cause) {
  response = {
    ok: false,
    message: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
  };
}
port.postMessage(response);
