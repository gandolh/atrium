import { spawn } from "node:child_process";

/**
 * Thin wrapper around Calibre's `ebook-convert` binary (decisions.md D5).
 * Stateless: every call spawns a fresh child process, enforces its own
 * timeout (independent of Fastify), and reports a discriminated result so the
 * route can map failures onto the shared error codes.
 */

const EBOOK_CONVERT = "ebook-convert";

/**
 * Calibre's official builds isolate themselves from user site-packages; distro
 * builds run the system Python, where a pip-installed `~/.local` lxml can
 * shadow the distro one and crash `ebook-convert` with a libxml2 version
 * mismatch. Spawn with PYTHONNOUSERSITE=1 so conversions are immune to the
 * user's Python environment.
 */
const CALIBRE_ENV = { ...process.env, PYTHONNOUSERSITE: "1" };

export type ConvertOutcome =
  /** Conversion produced the output PDF. */
  | { kind: "ok" }
  /** `ebook-convert` exited non-zero. */
  | { kind: "failed"; code: number | null; stderr: string }
  /** Wall-clock timeout hit; the child was killed. */
  | { kind: "timeout" }
  /** Binary not found on PATH (ENOENT). */
  | { kind: "missing" };

/**
 * A conversion in flight. `promise` is the same never-rejecting outcome
 * `runEbookConvert` returns; `cancel` kills the child now.
 *
 * There is deliberately **no `cancelled` outcome**. The outcome type is what
 * db.ts, the routes and the existing narration all read, and a fifth kind would
 * ripple through all of them for no information gain: only the caller that
 * called `cancel` can distinguish a cancellation from a failure, and it already
 * knows. A killed child resolves `{ kind: "failed", code: null }` — SIGKILL
 * closes with a null exit code — and the job runner ignores that outcome
 * entirely when it was the one that asked for the kill.
 */
export interface RunningConvert {
  /** Resolves an outcome; never rejects. */
  readonly promise: Promise<ConvertOutcome>;
  /** SIGKILL the child. False when it had already settled (nothing to kill). */
  cancel(): boolean;
}

/**
 * Spawn `ebook-convert <input> <output> [...args]` with a hard timeout and
 * return a handle, so a long job can be killed by whoever is holding it.
 * `args` are Calibre's own conversion options (e.g. `--enable-heuristics`) and
 * go AFTER the positionals, which is where `ebook-convert` expects them.
 *
 * On timeout the child is killed and `{ kind: "timeout" }` is returned. The
 * promise never rejects — all failure modes are values.
 */
export function startEbookConvert(
  input: string,
  output: string,
  timeoutMs: number,
  args: readonly string[] = [],
): RunningConvert {
  let kill: () => boolean = () => false;

  const promise = new Promise<ConvertOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: ConvertOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const child = spawn(EBOOK_CONVERT, [input, output, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
      env: CALIBRE_ENV,
    });

    // A kill on an already-settled run is a no-op, so a cancel racing the
    // child's own exit can't fabricate a second outcome.
    kill = () => (settled ? false : child.kill("SIGKILL"));

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      // Cap retained stderr so a chatty failure can't balloon memory.
      if (stderr.length < 8_192) stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ kind: "timeout" });
    }, timeoutMs);

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        finish({ kind: "missing" });
        return;
      }
      finish({ kind: "failed", code: null, stderr: err.message });
    });

    child.on("close", (code) => {
      if (code === 0) {
        finish({ kind: "ok" });
        return;
      }
      finish({ kind: "failed", code, stderr });
    });
  });

  return { promise, cancel: () => kill() };
}

/**
 * Run `ebook-convert <input> <output> [...args]` to completion. The
 * fire-and-forget shape for callers that have no reason to cancel; the promise
 * never rejects.
 */
export function runEbookConvert(
  input: string,
  output: string,
  timeoutMs: number,
  args: readonly string[] = [],
): Promise<ConvertOutcome> {
  return startEbookConvert(input, output, timeoutMs, args).promise;
}

/**
 * Startup probe: resolve true iff `ebook-convert --version` runs and exits 0.
 * Never throws; a missing binary (ENOENT) or any error resolves false.
 */
export function isCalibreAvailable(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (available: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(available);
    };

    const child = spawn(EBOOK_CONVERT, ["--version"], {
      stdio: "ignore",
      env: CALIBRE_ENV,
    });
    child.on("error", () => done(false));
    child.on("close", (code) => done(code === 0));
  });
}
