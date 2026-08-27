import type { Diagnostic } from "@ebook-reader/shared";
import type { FontProvider } from "./font/handle.ts";
import type { Page } from "./layout/page.ts";
import { buildPages } from "./layout/page.ts";
import type { PageDesign } from "./layout/design.ts";
import { documentDesign } from "./layout/design.ts";
import { buildVerticalList, createLayoutContext } from "./layout/vlist.ts";
import type { Shaper } from "./layout/hlist.ts";
import { createShaper } from "./layout/hlist.ts";
import type { BuildResult } from "./doc/index.ts";
import { buildDocument } from "./doc/index.ts";
import type { Budget } from "./macro/budget.ts";
import { budgetDiagnostic, createBudget } from "./macro/budget.ts";
import { renderPdf } from "./pdf/index.ts";
import { error, hasErrors, internalError, warning, wholeFile } from "./diagnostics.ts";

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
   * fetched.
   *
   * **Effectively required.** There is no built-in fallback and there cannot be
   * one — a fallback would mean reading a file, which is the thing this engine
   * does not do. Omit it and the compile stops with a `missing-font` error and
   * an empty result, deliberately: silently setting a document in some other
   * face would be wrong output presented as success. It stays optional in the
   * type only so `CompileOptions` has one uniform shape.
   *
   * ```ts
   * import { createLatinModernProvider } from "@ebook-reader/typeset";
   * import { loadLatinModernBytes } from "@ebook-reader/typeset/fonts/node";
   * compile(files, "main.tex", { fonts: createLatinModernProvider(loadLatinModernBytes()) });
   * ```
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
 * 2. **It performs no I/O of its own, and nothing the document says can cause
 *    any.** No file, no socket, no child process, no `eval` is opened by code
 *    under `src/`: every byte the engine reads arrives as an argument to this
 *    function, and `tsconfig.json` withholds the Node types so `fs`, `process`
 *    and `Buffer` cannot even be *named* there — the guarantee is enforced by
 *    the compiler rather than by review. This is the engine's entire security
 *    design (D38) rather than a style preference: `\write18` cannot execute
 *    because no shell escape exists, and `\input{/etc/passwd}` cannot read
 *    anything because there is nothing to read from — `\input` resolves
 *    against `files` or it is a diagnostic. No path, name or byte a document
 *    controls reaches a host API, so path traversal and sandbox escape stop
 *    being engine concerns.
 *
 *    Stated precisely, because the weaker claim is the true one: this is a
 *    guarantee about *first-party* code and about *reachability from the
 *    document*, not a claim that `node:fs` is absent from the module graph.
 *    It is not — `fontkit`, the third-party font parser, imports it. See the
 *    known limitation in `font/fontkit-handle.ts`, which also explains why no
 *    input can reach it.
 *
 * Unsupported LaTeX is never silently skipped: it produces a diagnostic naming
 * the construct, with a file and a line (the loud-failure contract, D38).
 */
export function compile(
  files: Record<string, Uint8Array>,
  entrypoint: string,
  opts: CompileOptions = {},
): CompileResult {
  try {
    // Inside the try, not above it: TypeScript's `= {}` default only fires on
    // `undefined`, so a JS caller — or a deserialised job payload whose options
    // field came back `null` rather than absent — reaches this line with a
    // non-object and throws straight past the never-throws guarantee.
    const resolved = resolveCompileOptions(opts);
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
 * The pipeline, in the order it runs: decode, build the document model, lay it
 * out, break it into pages, emit a PDF. Everything that can go wrong becomes a
 * diagnostic; `compile()`'s `catch` above exists only for engine bugs.
 */
function compileProject(
  files: Record<string, Uint8Array>,
  entrypoint: string,
  opts: ResolvedCompileOptions,
): CompileResult {
  if (!Object.prototype.hasOwnProperty.call(files, entrypoint)) {
    return {
      pdf: null,
      pages: [],
      diagnostics: [
        error("missing-file", wholeFile(entrypoint), `entrypoint \`${entrypoint}\` is not in the project`),
      ],
      stats: { pages: 0, steps: 0, bytes: 0 },
    };
  }

  const diagnostics: Diagnostic[] = [];
  const build = buildDocument(decodeFiles(files), entrypoint, {
    stepBudget: opts.stepBudget,
    signal: opts.signal,
  });
  for (const d of build.diagnostics) diagnostics.push(d);

  const fonts = opts.fonts;
  if (fonts === null) {
    // The engine performs no I/O (D38), so it cannot go and find a face: a
    // caller that wants type must hand one over. Substituting something built
    // in would produce a document set in the wrong font with nothing to say so.
    diagnostics.push(
      error(
        "missing-font",
        wholeFile(entrypoint),
        "no font provider was supplied — pass `fonts` to compile(); the engine reads no files of its own",
      ),
    );
    return { pdf: null, pages: [], diagnostics, stats: { pages: 0, steps: build.steps, bytes: 0 } };
  }

  // Layout gets whatever the document layer left of the budget, so the ceiling
  // is on the compile as a whole rather than per stage.
  const budget = createBudget(Math.max(0, opts.stepBudget - build.steps), opts.signal);
  // `Budget.reported` is documented as latched across stages so that one runaway
  // produces one diagnostic — but this is a *new* Budget, so the latch resets
  // here. When the document layer is what exhausted the budget it has already
  // reported, and this stage then starts with ~0 steps and trips on its very
  // first `spend()`, reporting the same stop twice. Carry the latch across.
  //
  // Derived from the counters, NOT by looking for an existing `budget-exceeded`
  // diagnostic. Sniffing the code was the first attempt and it was wrong: other
  // failures carry that code too, and any of them would have latched the flag
  // and swallowed a *genuine* layout exhaustion entirely — a silently truncated
  // document with nothing saying why, which is the exact opposite of D38.
  // `steps` and `aborted` say what actually happened and cannot collide.
  budget.reported =
    build.steps >= opts.stepBudget || (opts.signal !== null && opts.signal.aborted);
  const design = documentDesign(build.document, entrypoint, diagnostics);
  // One shaper for the whole compile, reused across every layout pass: line
  // breaking re-measures constantly, the font layer has no cache, and a second
  // pass re-shapes almost exactly the same words as the first.
  const shaper = createShaper();

  const laid = layoutDocument(build, design, fonts, shaper, budget, entrypoint, opts, files);
  for (const d of laid.diagnostics) diagnostics.push(d);

  if (budget.stopped && !budget.reported) {
    budget.reported = true;
    diagnostics.push(
      budgetDiagnostic(
        budget,
        wholeFile(entrypoint),
        `while laying out pages; building the document model had already spent ${build.steps} of the ${opts.stepBudget}-step budget`,
      ),
    );
  }

  const steps = build.steps + budget.spent;
  const stats: CompileStats = { pages: laid.pages.length, steps, bytes: 0 };

  if (hasErrors(diagnostics)) {
    return { pdf: null, pages: laid.pages, diagnostics, stats };
  }

  const rendered = renderPdf(laid.pages, {
    file: entrypoint,
    maxOutputBytes: opts.maxOutputBytes,
    // No `creationDate`: a clock read here would make the bytes differ between
    // two compiles of the same source, and the tests assert on those bytes.
  });
  for (const d of rendered.diagnostics) diagnostics.push(d);
  stats.bytes = rendered.pdf?.length ?? 0;

  return {
    pdf: hasErrors(diagnostics) ? null : rendered.pdf,
    pages: laid.pages,
    diagnostics,
    stats,
  };
}

/**
 * How many times the document may be laid out. Two is the normal answer and the
 * cycle LaTeX documents with its `.aux` file; the third exists because filling
 * a `\pageref` in changes how wide that reference prints, which can move the
 * line it sits on to another page and therefore change the very number that was
 * filled in. A run that is still moving after three passes is reported rather
 * than iterated on — TeX itself just tells you to re-run.
 */
const MAX_LAYOUT_PASSES = 3;

interface LaidOutDocument {
  pages: Page[];
  diagnostics: Diagnostic[];
}

/**
 * The two-pass cycle.
 *
 * 1. Lay the whole document out. Every `\pageref` and every table-of-contents
 *    entry prints `??`, because no page numbers exist yet.
 * 2. Collect `marker name → page` from where the layout's `Marker` nodes landed.
 * 3. Hand that to `resolvePageNumbers`, which rewrites `ReferenceInline.text`
 *    in place.
 * 4. Lay out again, now reading the rewritten text.
 *
 * The loop stops as soon as a pass produces the same page numbers it was given,
 * which is the fixed point that makes the output self-consistent. A document
 * with no markers at all reaches it after one pass and is never laid out twice.
 *
 * Diagnostics are taken from the **final** pass only. Every pass produces the
 * same overfull boxes, and reporting each one two or three times would say
 * something false about the document.
 */
function layoutDocument(
  build: BuildResult,
  design: PageDesign,
  fonts: FontProvider,
  shaper: Shaper,
  budget: Budget,
  entrypoint: string,
  opts: ResolvedCompileOptions,
  /** The project's bytes, undecoded — `\includegraphics` resolves against these. */
  files: Record<string, Uint8Array>,
): LaidOutDocument {
  let known: ReadonlyMap<string, number> = new Map();
  let referenceDiagnostics: Diagnostic[] = [];
  let final: LaidOutDocument = { pages: [], diagnostics: [] };
  let stable = false;

  for (let pass = 1; pass <= MAX_LAYOUT_PASSES; pass++) {
    const passDiagnostics: Diagnostic[] = [];
    // `files` reaches layout because an image is an input like any other (D38):
    // `\includegraphics` resolves its name against this map and nothing else.
    const ctx = createLayoutContext(design, fonts, shaper, budget, passDiagnostics, entrypoint, known, files);
    const list = buildVerticalList(build.document, ctx);
    const built = buildPages(list, {
      design,
      footnotes: ctx.footnotes,
      // The float queue's input (brief 39, chunk 39.4). Keyed by the marker
      // `vlist.ts` left where each float was written, in document order.
      floats: ctx.floats,
      fonts,
      shaper,
      budget,
      diagnostics: passDiagnostics,
      file: entrypoint,
      maxPages: opts.maxPages,
    });
    final = { pages: built.pages, diagnostics: passDiagnostics };

    if (samePages(built.markerPages, known)) {
      stable = true;
      break;
    }
    known = built.markerPages;
    // Bail BEFORE resolving references. A stopped budget means layout never
    // reached the end of the document, so `markerPages` is truncated — and
    // resolving against it reports every label in the unreached tail as "never
    // placed on a page", which is an invented error about a perfectly good
    // label. The compile has already failed; inventing extra causes makes the
    // diagnostic list actively misleading about why.
    if (budget.stopped) break;
    referenceDiagnostics = build.resolvePageNumbers(known);
  }

  for (const d of referenceDiagnostics) final.diagnostics.push(d);
  if (!stable && !budget.stopped) {
    final.diagnostics.push(
      warning(
        "undefined-reference",
        wholeFile(entrypoint),
        `page numbers were still moving after ${MAX_LAYOUT_PASSES} layout passes; a \\pageref or a table-of-contents entry may name the wrong page`,
      ),
    );
  }
  return final;
}

function samePages(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

// --- decoding ---------------------------------------------------------------

/**
 * Project bytes as text.
 *
 * `buildDocument` wants `Record<string, string>`; `compile()` is handed
 * `Record<string, Uint8Array>`. Bridging the two needs a UTF-8 decoder, and
 * `src/` has none: it compiles with `"types": []` and the ES2022 lib alone, so
 * `TextDecoder` — a DOM/Node global, not an ECMAScript one — is not in scope,
 * which is the same wall that keeps `node:fs` out (D38).
 *
 * Threading a decoder in through `CompileOptions` was the alternative. It is
 * rejected because it would make *decoding* a caller's responsibility: two
 * callers could hand over decoders that disagree about malformed input, and the
 * engine's output would then depend on its embedding rather than on its input.
 * Thirty lines of UTF-8 is a small price for a compile that is a pure function
 * of `files` on every host.
 *
 * Malformed input is not an error. A stray byte becomes U+FFFD and the rest of
 * the file still compiles, which is what `TextDecoder` does in its default
 * non-fatal mode and what a person editing a file in the wrong encoding needs.
 */
function decodeFiles(files: Record<string, Uint8Array>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of Object.keys(files)) out[path] = decodeUtf8(files[path] as Uint8Array);
  return out;
}

const REPLACEMENT = 0xfffd;
/** Emitted in blocks so a large file does not build one enormous argument list. */
const DECODE_CHUNK = 4096;

export function decodeUtf8(bytes: Uint8Array): string {
  const units: number[] = [];
  const parts: string[] = [];
  const emit = (code: number): void => {
    if (code > 0xffff) {
      const v = code - 0x10000;
      units.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    } else {
      units.push(code);
    }
    if (units.length >= DECODE_CHUNK) {
      parts.push(String.fromCharCode(...units));
      units.length = 0;
    }
  };

  // A byte-order mark is metadata, not text: leaving it in would put an
  // invisible character in front of `\documentclass`.
  let i = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;

  while (i < bytes.length) {
    const b0 = bytes[i] as number;
    if (b0 < 0x80) {
      emit(b0);
      i += 1;
      continue;
    }
    // Length and the smallest value the sequence is allowed to encode, so an
    // overlong form (the classic `\xC0\xAF` "/" smuggle) is rejected rather
    // than decoded.
    let length: number;
    let code: number;
    let lowest: number;
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      length = 2;
      code = b0 & 0x1f;
      lowest = 0x80;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      length = 3;
      code = b0 & 0x0f;
      lowest = 0x800;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      length = 4;
      code = b0 & 0x07;
      lowest = 0x10000;
    } else {
      emit(REPLACEMENT);
      i += 1;
      continue;
    }

    let valid = true;
    for (let k = 1; k < length; k++) {
      const b = bytes[i + k];
      if (b === undefined || (b & 0xc0) !== 0x80) {
        valid = false;
        // Resynchronise at the offending byte rather than past it, so a
        // truncated sequence followed by valid text loses only the sequence.
        i += k;
        break;
      }
      code = (code << 6) | (b & 0x3f);
    }
    if (!valid) {
      emit(REPLACEMENT);
      continue;
    }
    // Surrogates are not scalar values, and nothing above U+10FFFF exists.
    if (code < lowest || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      emit(REPLACEMENT);
      i += length;
      continue;
    }
    emit(code);
    i += length;
  }

  if (units.length > 0) parts.push(String.fromCharCode(...units));
  return parts.join("");
}
