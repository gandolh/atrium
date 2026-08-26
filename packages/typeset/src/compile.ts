import type { Diagnostic } from "@ebook-reader/shared";
import type { FontProvider } from "./font/handle.ts";
import type { Page } from "./layout/page.ts";
import { error, internalError, wholeFile } from "./diagnostics.ts";

/**
 * `AbortSignal` without the DOM or Node type libraries. The engine is
 * synchronous, so it only ever *polls* `aborted` between steps — it never
 * subscribes, and it never needs `addEventListener`. A real `AbortSignal`
 * satisfies this structurally.
 */
export interface AbortLike {
  readonly aborted: boolean;
}

export interface CompileOptions {
  /**
   * Maximum number of engine steps — one macro expansion, one node visited,
   * one line-break candidate weighed. A *deterministic* budget rather than a
   * wall clock, because a budget gives the same answer on every machine and a
   * timer does not (D38). Runaway `\newcommand` recursion dies here.
   */
  stepBudget?: number;
  /** Cap on the emitted PDF, so a runaway document cannot fill a disk. */
  maxOutputBytes?: number;
  /** Cap on page count — the other way a runaway loop shows up. */
  maxPages?: number;
  /**
   * Cooperative cancellation, polled at step boundaries. The outer wall-clock
   * backstop lives in the caller's job runner, not in here.
   */
  signal?: AbortLike;
  /**
   * Where faces come from. Injected because the engine performs no I/O: in Node
   * the caller passes the committed Latin Modern set, in a browser whatever it
   * fetched. Omitted, the engine falls back to whatever it has built in.
   */
  fonts?: FontProvider;
}

/** `CompileOptions` with every default filled in. Later stages take this. */
export interface ResolvedCompileOptions {
  stepBudget: number;
  maxOutputBytes: number;
  maxPages: number;
  signal: AbortLike | null;
  fonts: FontProvider | null;
}

/**
 * Chosen to be generous for any document a person writes and still fatal for a
 * loop: a 40-page report costs low millions of steps, a runaway macro reaches
 * the budget in under a second.
 */
export const DEFAULT_COMPILE_OPTIONS = {
  stepBudget: 5_000_000,
  maxOutputBytes: 64 * 1024 * 1024,
  maxPages: 2000,
} as const;

export function resolveCompileOptions(opts: CompileOptions = {}): ResolvedCompileOptions {
  return {
    stepBudget: opts.stepBudget ?? DEFAULT_COMPILE_OPTIONS.stepBudget,
    maxOutputBytes: opts.maxOutputBytes ?? DEFAULT_COMPILE_OPTIONS.maxOutputBytes,
    maxPages: opts.maxPages ?? DEFAULT_COMPILE_OPTIONS.maxPages,
    signal: opts.signal ?? null,
    fonts: opts.fonts ?? null,
  };
}

export interface CompileStats {
  /** Pages in the finished document. */
  pages: number;
  /** Steps actually consumed, against `stepBudget`. */
  steps: number;
  /** Size of `pdf`, or `0` when none was produced. */
  bytes: number;
}

export interface CompileResult {
  /** `null` whenever an error-severity diagnostic was produced. */
  pdf: Uint8Array | null;
  /**
   * The positioned layout `pdf` was emitted from. Golden tests dump this — PDF
   * bytes are not reproducible across runs, and a layout dump is the only thing
   * a human can read a line-breaking change out of. Callers that just want a
   * document ignore it.
   */
  pages: Page[];
  diagnostics: Diagnostic[];
  stats: CompileStats;
}

/** The shape of `compile`. Test harnesses and later stages take one of these. */
export type CompileFn = (
  files: Record<string, Uint8Array>,
  entrypoint: string,
  opts?: CompileOptions,
) => CompileResult;

/**
 * Turn a LaTeX project into a PDF.
 *
 * `files` is the whole project as an in-memory map — keys are project-relative
 * paths (`main.tex`, `chapters/one.tex`), values are the raw bytes.
 * `entrypoint` names the file to start from and must be a key of `files`.
 *
 * **Two guarantees, both load-bearing, both relied on by callers:**
 *
 * 1. **It never throws.** Every failure — malformed source, an unimplemented
 *    command, an exhausted budget, an outright bug in the engine — comes back
 *    as a `Diagnostic` in the result. A caller may write `const r = compile(…)`
 *    with no `try`. Bugs are caught at this boundary and reported with code
 *    `internal`; that is the only thing the `catch` below is for.
 *
 * 2. **It performs no I/O.** No filesystem, no network, no child process, no
 *    `eval`. This is the engine's entire security design (D38) rather than a
 *    style preference: `\write18` cannot execute because no shell escape exists,
 *    and `\input{/etc/passwd}` cannot read anything because there is nothing to
 *    read from — `\input` resolves against `files` or it is a diagnostic. Path
 *    traversal and sandbox escape stop being engine concerns. Anything added
 *    under `src/` that reaches outside this function's arguments breaks the
 *    contract, and `tsconfig.json` withholds the Node types so it cannot be
 *    added by accident.
 *
 * Unsupported LaTeX is never silently skipped: it produces a diagnostic naming
 * the construct, with a file and a line (the loud-failure contract, D38).
 */
export function compile(
  files: Record<string, Uint8Array>,
  entrypoint: string,
  opts: CompileOptions = {},
): CompileResult {
  const resolved = resolveCompileOptions(opts);
  try {
    return compileProject(files, entrypoint, resolved);
  } catch (cause) {
    return {
      pdf: null,
      pages: [],
      diagnostics: [internalError(entrypoint, cause)],
      stats: { pages: 0, steps: 0, bytes: 0 },
    };
  }
}

/**
 * Scaffold (brief 37, chunk 1). The pipeline — parse, macro expansion, document
 * model, line breaking, page building, PDF emission — arrives in later chunks.
 * Until then it does the one thing it can do honestly: refuse, loudly.
 */
function compileProject(
  files: Record<string, Uint8Array>,
  entrypoint: string,
  _opts: ResolvedCompileOptions,
): CompileResult {
  const empty: CompileStats = { pages: 0, steps: 0, bytes: 0 };

  if (!Object.prototype.hasOwnProperty.call(files, entrypoint)) {
    return {
      pdf: null,
      pages: [],
      diagnostics: [
        error("missing-file", wholeFile(entrypoint), `entrypoint \`${entrypoint}\` is not in the project`),
      ],
      stats: empty,
    };
  }

  return {
    pdf: null,
    pages: [],
    diagnostics: [
      // Not via `unsupported()`: there is no single construct to name yet.
      // Still severity error with code `unsupported`, because right now every
      // construct is outside the implemented subset.
      error(
        "unsupported",
        wholeFile(entrypoint),
        "the typesetting engine is a scaffold and sets nothing yet (brief 37, chunk 1)",
      ),
    ],
    stats: empty,
  };
}
