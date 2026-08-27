import { useState, type ReactNode } from "react";
import type { Diagnostic, DiagnosticCode, LatexCompileResult } from "@ebook-reader/shared";

import type { LatexJumpTarget } from "./LatexEditor";

/**
 * The diagnostics panel (brief 38 chunk 9) — errors first and always open,
 * warnings (and the rarer info-severity notices) collapsed behind a summary,
 * a raw-log disclosure at the foot. Lives beneath the PDF preview in the
 * `Preview` pane.
 *
 * This surface is PROSE, not code (design.md): every diagnostic message is a
 * sentence written for a person, so it sets in `font-ui` throughout,
 * including the raw log — `font-code` is the source pane's alone.
 *
 * ## The distinction this exists to carry (D38, brief 37/38 context)
 * Two diagnostic codes both surface at `severity: "error"` (or occasionally
 * `"info"` for a no-op like `\usepackage`) and both stop the reader cold, but
 * they mean opposite things to a writer:
 * - `unsupported` — real LaTeX Atrium's engine deliberately does not
 *   implement yet (figures/tables are brief 39, math is brief 40). The fix is
 *   "wait for a brief" or "avoid the construct," not "fix your document."
 * - `undefined-command` / `undefined-environment` — not a thing at all, i.e.
 *   a typo or a missing `\newcommand`. The fix is in the document.
 * A flat "error" list would erase that distinction, so an `unsupported`
 * diagnostic (any severity) gets a small "Not supported yet" tag; nothing
 * else does — `<DiagnosticRow>`'s `badge`.
 */

interface DiagnosticsPanelProps {
  /** `undefined` while the last-compile fetch is in flight; `null` once
   * settled if the project has never compiled. */
  result: LatexCompileResult | null | undefined;
  loading: boolean;
  onJump: (target: LatexJumpTarget) => void;
}

export function DiagnosticsPanel({ result, loading, onJump }: DiagnosticsPanelProps) {
  const [warningsOpen, setWarningsOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);

  if (loading) {
    return (
      <PanelShell>
        <p className="font-ui text-xs text-ink-variant">Loading the last compile…</p>
      </PanelShell>
    );
  }

  if (!result) {
    return (
      <PanelShell>
        <p className="font-ui text-xs text-ink-variant">
          Compile the project to see errors and warnings here.
        </p>
      </PanelShell>
    );
  }

  const errors = result.diagnostics.filter((d) => d.severity === "error");
  const rest = result.diagnostics.filter((d) => d.severity !== "error");
  const warningCount = rest.filter((d) => d.severity === "warning").length;
  const noteCount = rest.filter((d) => d.severity === "info").length;

  // `status: "ready"` implies zero error-severity diagnostics (the engine
  // never marks a compile ready while `hasErrors()` is true), so the success
  // branch never needs to account for `errors`.
  const statusLine =
    result.status === "failed"
      ? countLabel(errors.length, "error")
      : warningCount + noteCount === 0
        ? "Compiled successfully."
        : `Compiled with ${nonErrorSummary(warningCount, noteCount)}.`;

  return (
    <div className="flex max-h-[38vh] shrink-0 flex-col border-t border-line-soft/60 bg-paper-low">
      <div className="shrink-0 px-page py-2">
        <p aria-live="polite" className="font-ui text-sm font-medium text-ink">
          {statusLine}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-page pb-3">
        {errors.length > 0 && (
          <ul className="flex flex-col gap-1">
            {errors.map((d, i) => (
              <DiagnosticRow key={`e-${i}`} diagnostic={d} onJump={onJump} />
            ))}
          </ul>
        )}

        {rest.length > 0 && (
          <div className={errors.length > 0 ? "mt-2" : undefined}>
            <button
              type="button"
              onClick={() => setWarningsOpen((v) => !v)}
              aria-expanded={warningsOpen}
              className="flex items-center gap-1 rounded-card py-1 font-ui text-xs font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
            >
              <Disclosure open={warningsOpen} />
              {nonErrorSummary(warningCount, noteCount)}
            </button>
            {warningsOpen && (
              <ul className="mt-1 flex flex-col gap-1">
                {rest.map((d, i) => (
                  <DiagnosticRow key={`w-${i}`} diagnostic={d} onJump={onJump} />
                ))}
              </ul>
            )}
          </div>
        )}

        {errors.length === 0 && rest.length === 0 && (
          <p className="font-ui text-xs text-ink-variant">No errors or warnings.</p>
        )}

        <div className="mt-2 border-t border-line-soft/50 pt-2">
          <button
            type="button"
            onClick={() => setLogOpen((v) => !v)}
            aria-expanded={logOpen}
            className="flex items-center gap-1 rounded-card py-1 font-ui text-xs font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
          >
            <Disclosure open={logOpen} />
            Raw log
          </button>
          {logOpen && (
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-card bg-paper p-2 font-ui text-xs text-ink-variant">
              {result.log || "(empty)"}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

/** One diagnostic. Clicking it jumps the editor straight to `file`/`line` —
 * the shared `Diagnostic` shape and `LatexJumpTarget` agree field-for-field
 * on purpose, so it is handed over unchanged. */
function DiagnosticRow({
  diagnostic,
  onJump,
}: {
  diagnostic: Diagnostic;
  onJump: (target: LatexJumpTarget) => void;
}) {
  const isError = diagnostic.severity === "error";
  const badge = diagnosticBadge(diagnostic.code);
  return (
    <li>
      <button
        type="button"
        onClick={() =>
          onJump({ file: diagnostic.file, line: diagnostic.line, column: diagnostic.column })
        }
        className={`flex w-full flex-col items-start gap-0.5 rounded-card border-l-2 py-1 pl-2.5 pr-2 text-left transition hover:bg-paper focus-visible:outline-2 focus-visible:outline-accent ${
          isError ? "border-l-danger" : "border-l-line"
        }`}
      >
        <span className="flex flex-wrap items-center gap-1.5 font-ui text-[11px] text-ink-variant">
          <span className="tabular-nums">
            {diagnostic.file}
            {diagnostic.line > 0 ? `:${diagnostic.line}` : ""}
          </span>
          {badge && (
            <span className="rounded-card bg-paper-container px-1.5 py-0.5 font-ui text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-variant">
              {badge}
            </span>
          )}
        </span>
        <span className={`font-ui text-sm ${isError ? "text-ink" : "text-ink-variant"}`}>
          {diagnostic.message}
        </span>
      </button>
    </li>
  );
}

/**
 * The one branch that carries D38's loud-failure distinction into the UI:
 * `unsupported` means "real LaTeX, not implemented yet" — everything else
 * (a bare `error`/`warning` with no code, `undefined-command`,
 * `undefined-environment`, …) reads as an ordinary problem in the document,
 * with no badge.
 */
function diagnosticBadge(code?: DiagnosticCode): string | null {
  return code === "unsupported" ? "Not supported yet" : null;
}

function countLabel(n: number, singular: string): string {
  return `${n} ${n === 1 ? singular : `${singular}s`}`;
}

/**
 * "N warnings" / "N warnings, N notes" — the collapsible bucket's summary,
 * reused for both its toggle label and the success banner's tail
 * ("Compiled with …"). Info-severity diagnostics (currently only a no-op
 * `\usepackage`) are rare enough that folding them under the same disclosure
 * as warnings, with their own count, reads better than a third bucket.
 */
function nonErrorSummary(warnings: number, notes: number): string {
  const parts: string[] = [];
  if (warnings > 0) parts.push(countLabel(warnings, "warning"));
  if (notes > 0) parts.push(countLabel(notes, "note"));
  return parts.length > 0 ? parts.join(", ") : "0 warnings";
}

/** Shared frame for the panel's loading / empty states. */
function PanelShell({ children }: { children: ReactNode }) {
  return (
    <div className="shrink-0 border-t border-line-soft/60 bg-paper-low px-page py-3">
      {children}
    </div>
  );
}

/** A small rotating chevron for the two disclosures above. Reduced motion
 * drops straight to `motion-reduce:transition-none`, matching `PaneTab`. */
function Disclosure({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      className={`h-3 w-3 shrink-0 transition-transform duration-200 ease-paper motion-reduce:transition-none ${
        open ? "rotate-90" : ""
      }`}
      aria-hidden
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
    </svg>
  );
}
