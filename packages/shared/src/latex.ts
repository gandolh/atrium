import { z } from "zod";

/**
 * LaTeX diagnostic contract (brief 37, D38) — the one shape the typesetting
 * engine, the compile route and the editor UI all agree on. Lives in shared
 * (not in `packages/typeset`) because it crosses the wire: the engine produces
 * these, the API serialises them, apps/web renders them (D11).
 *
 * Everything here is JSON-serialisable by construction — no Dates, no Maps, no
 * classes — so a diagnostic survives `JSON.stringify` on the way out of the
 * compile job and `JSON.parse` on the way into the editor unchanged.
 */

export const DIAGNOSTIC_SEVERITIES = ["error", "warning", "info"] as const;
export const diagnosticSeveritySchema = z.enum(DIAGNOSTIC_SEVERITIES);
export type DiagnosticSeverity = z.infer<typeof diagnosticSeveritySchema>;

/**
 * The closed set of machine-readable diagnostic codes. Closed on purpose: the
 * editor branches on these (an `unsupported` gets a "not in the supported
 * subset" affordance, an `undefined-reference` does not), and an exhaustive
 * union makes a missing branch a typecheck error rather than a silent default.
 * A new engine chunk that needs a new code adds it here, in one line.
 *
 * The distinction that carries D38's loud-failure contract:
 * - `unsupported` — real LaTeX that Atrium's engine deliberately does not
 *   implement. This is the first-class case: it must be *produced*, never
 *   swallowed, so a document never renders quietly wrong.
 * - `undefined-command` — not LaTeX at all (a typo, or a macro never defined).
 */
export const DIAGNOSTIC_CODES = [
  /** Malformed source: the parser could not read it as LaTeX. */
  "syntax",
  /** Valid LaTeX that this engine does not implement (the loud-failure case). */
  "unsupported",
  /** A control sequence that is not defined anywhere — typo or missing \newcommand. */
  "undefined-command",
  /** `\begin{...}` naming an environment that is not defined anywhere. */
  "undefined-environment",
  /** `\ref` / `\pageref` / `\cite` to a key no `\label` or entry produced. */
  "undefined-reference",
  /** Two `\label`s claimed the same key; the second is ignored. */
  "duplicate-label",
  /** `\input` / `\include` / a figure path that is not in the in-memory file map. */
  "missing-file",
  /** A requested font face is not available to the engine. */
  "missing-font",
  /** A line or box could not be shrunk enough to fit; content overflows. */
  "overfull-box",
  /** A line or box had to be stretched past tolerance; spacing is loose. */
  "underfull-box",
  /** The deterministic step budget ran out — runaway macro or pathological input. */
  "budget-exceeded",
  /** An output-size or page-count cap was hit. */
  "limit-exceeded",
  /**
   * The compile was stopped by its host rather than by the engine: the caller's
   * outer wall-clock backstop expired, or a person cancelled it.
   *
   * Deliberately NOT `budget-exceeded`. That code means the engine's own
   * DETERMINISTIC step budget ran out — the same document stops at the same
   * place every time, which is exactly what makes it testable. A wall clock is
   * the opposite: the same document may stop in a different place, or not at
   * all, depending on what else the machine was doing. Conflating them tells a
   * writer to go simplify a document that was never too complex.
   */
  "stopped",
  /** An engine bug, caught at the `compile()` boundary so it becomes output, not a throw. */
  "internal",
] as const;
export const diagnosticCodeSchema = z.enum(DIAGNOSTIC_CODES);
export type DiagnosticCode = z.infer<typeof diagnosticCodeSchema>;

export const diagnosticSchema = z.object({
  /** Path as it appears in the project's file map, e.g. `main.tex`. */
  file: z.string(),
  /** 1-based source line. `0` means the problem has no single line (whole-document). */
  line: z.number().int().nonnegative(),
  /** 1-based source column, when the engine can pin one. */
  column: z.number().int().positive().optional(),
  severity: diagnosticSeveritySchema,
  /** Human-readable, complete on its own — the editor shows it verbatim. */
  message: z.string(),
  code: diagnosticCodeSchema.optional(),
  /**
   * The single LaTeX construct this is about, when there is one: a command
   * including its backslash (`\includegraphics`) or an environment name
   * (`tabular`). Lets the editor group and count without parsing `message`.
   */
  construct: z.string().optional(),
});
export type Diagnostic = z.infer<typeof diagnosticSchema>;

/**
 * LaTeX project, file, compile-result and version contracts (brief 38, D38,
 * D39) — the wire shapes for `/latex`, sibling to the `Diagnostic` contract
 * above. Same rule as everywhere else in this package: these are what the API
 * sends and the client renders, not the SQLite row shape. In particular there
 * are **no path fields anywhere below** — a draft's files live on disk under
 * its project id and a version's PDF/zip are derived from its id via
 * `paths.ts` (D39), so a path is never something the wire needs to carry.
 */

/**
 * Where a project sits in the compile machine. Deliberately the same
 * vocabulary as `CONVERT_STATUSES` (`library-book.ts`) so the two job kinds
 * read consistently: `none` before the first compile, `running` while one is
 * in flight, `ready` once a PDF exists and opens, `failed` with a reason on
 * the project.
 *
 * No `poor` here — that status is specifically about a converted book's OCR
 * quality, which has no compile-side equivalent: a LaTeX compile with
 * warnings is still `ready` (the diagnostics panel is where warnings show),
 * and only an error-severity diagnostic makes it `failed`.
 */
export const COMPILE_STATUSES = ["none", "running", "ready", "failed"] as const;
export const compileStatusSchema = z.enum(COMPILE_STATUSES);
export type CompileStatus = z.infer<typeof compileStatusSchema>;

/** A LaTeX project (the draft) as seen by the client — `/latex` list and detail. */
export const latexProjectSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Project-relative path to the file `compile()` starts from. */
  entrypoint: z.string().default("main.tex"),
  compileStatus: compileStatusSchema,
  /**
   * The library book this project has published to, or null if it never has.
   * Set on first publish and then stable — publishing again adds a version to
   * the same book, it never repoints this (decision 8).
   */
  publishedBookId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LatexProject = z.infer<typeof latexProjectSchema>;

/** One file within a project's tree, as listed in the editor's file tree. */
export const latexFileSchema = z.object({
  /** Project-relative, e.g. `main.tex` or `figures/plot.png`. */
  path: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  updatedAt: z.string(),
});
export type LatexFile = z.infer<typeof latexFileSchema>;

/**
 * The outcome of one compile — what `POST /latex/:id/compile` returns and
 * `GET /latex/:id/log` re-serves. `status` only ever lands on `ready` or
 * `failed` here (a result is by definition of a compile that finished), kept
 * as the full `CompileStatus` union rather than a two-value type so the panel
 * and the project row can share one switch.
 */
export const latexCompileResultSchema = z.object({
  status: compileStatusSchema,
  /** Full plain-text engine log, for the "show raw log" affordance next to
   * the structured panel below. */
  log: z.string(),
  diagnostics: z.array(diagnosticSchema),
});
export type LatexCompileResult = z.infer<typeof latexCompileResultSchema>;

/**
 * One publish of a project (decision 8). Versions accumulate on the
 * **library book** the project publishes to; this is the version-picker row,
 * not the project itself. No path fields (D39) — the PDF and the project zip
 * are derived from `id` via `paths.ts`, fetched through
 * `GET /library/:id/file?version=<id>`.
 */
export const documentVersionSchema = z.object({
  id: z.string(),
  /** 1-based, unique per book, increasing with each publish. */
  versionNo: z.number().int().positive(),
  publishedAt: z.string(),
  /** Size of this version's PDF, in bytes. */
  sizeBytes: z.number().int().nonnegative(),
});
export type DocumentVersion = z.infer<typeof documentVersionSchema>;
