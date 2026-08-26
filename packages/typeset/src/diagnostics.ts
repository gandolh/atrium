import type { Diagnostic, DiagnosticCode, DiagnosticSeverity } from "@ebook-reader/shared";

/**
 * The loud-failure helpers (D38). Every path in the engine that cannot do the
 * right thing goes through one of these, so "we don't implement that" always
 * leaves a trace with a file and a line and never a silently-dropped node.
 *
 * The `Diagnostic` shape itself lives in `@ebook-reader/shared` because the API
 * and the editor consume it too; it is imported here as a *type only*, which
 * erases at emit and keeps the engine free of runtime dependencies.
 */
export type { Diagnostic, DiagnosticCode, DiagnosticSeverity };

/**
 * Where in the source something happened. Carried through parse, macro
 * expansion and layout — brief 37 treats a wrong line number as a bug, so nodes
 * hold on to this rather than recomputing it at the point of failure.
 */
export interface SourceRef {
  file: string;
  /** 1-based; `0` when the problem belongs to the document rather than a line. */
  line: number;
  /** 1-based, when the engine can pin one. */
  column?: number;
}

/** A source position with no known line — whole-document problems. */
export function wholeFile(file: string): SourceRef {
  return { file, line: 0 };
}

export function diagnostic(
  severity: DiagnosticSeverity,
  code: DiagnosticCode,
  at: SourceRef,
  message: string,
  construct?: string,
): Diagnostic {
  const d: Diagnostic = { file: at.file, line: at.line, severity, message, code };
  if (at.column !== undefined) d.column = at.column;
  if (construct !== undefined) d.construct = construct;
  return d;
}

export function error(code: DiagnosticCode, at: SourceRef, message: string, construct?: string): Diagnostic {
  return diagnostic("error", code, at, message, construct);
}

export function warning(code: DiagnosticCode, at: SourceRef, message: string, construct?: string): Diagnostic {
  return diagnostic("warning", code, at, message, construct);
}

export function info(code: DiagnosticCode, at: SourceRef, message: string, construct?: string): Diagnostic {
  return diagnostic("info", code, at, message, construct);
}

/**
 * The loud-failure case, and the reason the engine is trustworthy at all: real
 * LaTeX that Atrium deliberately does not implement. Reach for this instead of
 * skipping a node — a dropped `\thanks` is a missing footnote in a *published*
 * document, which is worse than a refusal to compile.
 *
 * `construct` is the command including its backslash (`\includegraphics`) or the
 * environment name (`tabular`); it lands in the diagnostic's `construct` field
 * so the editor can group and count without parsing the message.
 */
export function unsupported(at: SourceRef, construct: string, detail?: string): Diagnostic {
  const base = `this engine does not implement ${construct}`;
  return error("unsupported", at, detail ? `${base} — ${detail}` : base, construct);
}

/**
 * An engine bug, converted into output. `compile()` never throws (see its doc
 * comment), so the last thing it does with an unexpected exception is turn it
 * into one of these.
 */
export function internalError(file: string, cause: unknown): Diagnostic {
  const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  return error("internal", wholeFile(file), `internal engine error — ${detail}`);
}

/** Errors stop a compile from producing a PDF; warnings and info never do. */
export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}
