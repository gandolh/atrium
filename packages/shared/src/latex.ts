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
