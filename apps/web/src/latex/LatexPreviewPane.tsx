import { Suspense, lazy, type ReactNode } from "react";
import type { LatexCompileResult } from "@ebook-reader/shared";

import { ReaderChunkErrorBoundary } from "../reader/ReaderChunkErrorBoundary";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import type { LatexJumpTarget } from "./LatexEditor";
import { usePreviewReaderIsolation } from "./use-preview-reader-isolation";

/**
 * The `Preview` mount point's contents (brief 38 chunk 9): the compiled PDF on
 * top, the diagnostics panel beneath, inside the `<section aria-label="Preview">`
 * chunk 8 already sized and scoped (`min-h-0`, scrolls inside itself).
 *
 * `PdfReader` (brief 06) is code-split exactly like `SourceEditor` (brief 15's
 * precedent, chunk 8's own choice for the source pane) — nobody who never
 * compiles a LaTeX project should download the PDF.js worker + react-pdf.
 * `ReaderChunkErrorBoundary` is reused unchanged rather than duplicated: it is
 * already generic (wraps chunk 8's lazy source pane the same way).
 */
// Same specifier `routes/read.tsx` dynamic-imports (`../reader/pdf`'s barrel,
// not the file directly) so Rollup resolves both call sites to the SAME lazy
// chunk instead of splitting PdfReader's code across two.
const PdfReader = lazy(() => import("../reader/pdf").then((m) => ({ default: m.PdfReader })));

export function LatexPreviewPane({
  pdfFile,
  pdfLoading,
  compiling,
  result,
  resultLoading,
  onJump,
}: {
  /** The last successfully compiled PDF, or `null` if none exists yet. Never
   * cleared by a failed compile (see `useLatexPdf`) — that is what keeps this
   * pane showing the last good preview beside a fresh set of errors instead
   * of going blank. */
  pdfFile: File | null;
  pdfLoading: boolean;
  compiling: boolean;
  result: LatexCompileResult | null | undefined;
  resultLoading: boolean;
  onJump: (target: LatexJumpTarget) => void;
}) {
  // `PdfReader` reports its page and progress into the SHARED reader store, so
  // a preview scroll would otherwise be written back to whatever book the
  // `/read` reader last had open. Mounted here, at the one component that can
  // put a `PdfReader` on screen outside the reader, and for the whole editor
  // session (this pane is always rendered — the phone hides it with a class,
  // it never unmounts). See the hook for the full failure sequence.
  usePreviewReaderIsolation();

  return (
    <>
      {/*
       * `PdfReader` renders itself `fixed inset-x-0 top-0
       * bottom-[var(--dock-height)]` — every one of its call sites is meant to
       * fill the WHOLE viewport (root-layout.tsx: "the readers are
       * full-screen"), and the brief requires it be reused unmodified here
       * too. `contain: layout` on this wrapper is what reconciles the two: a
       * `contain: layout` box is, per spec, the containing block for its
       * `position: fixed` (and `absolute`) descendants — exactly like
       * `position: relative` would be, but without touching layout the way a
       * transform can. `PdfReader`'s fixed frame therefore fills THIS box
       * instead of the real viewport, with zero changes inside
       * `reader/pdf/PdfReader.tsx`.
       */}
      <div className="relative min-h-0 flex-1 [contain:layout]">
        {pdfFile ? (
          <ReaderChunkErrorBoundary
            fallback={(retry) => (
              <PreviewNotice title="The preview didn't load">
                <button
                  type="button"
                  onClick={retry}
                  className="rounded-card border border-line-soft px-3 py-1.5 font-ui text-sm font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
                >
                  Reload
                </button>
              </PreviewNotice>
            )}
          >
            <Suspense fallback={<PreviewNotice title="Preview">Loading the reader…</PreviewNotice>}>
              <PdfReader file={pdfFile} />
            </Suspense>
          </ReaderChunkErrorBoundary>
        ) : (
          <PreviewNotice title="Preview">
            {pdfLoading
              ? "Loading the last preview…"
              : compiling
                ? "Compiling…"
                : "Compile the project to see the PDF here, with any errors listed beneath it."}
          </PreviewNotice>
        )}
      </div>

      <DiagnosticsPanel result={result} loading={resultLoading} onJump={onJump} />
    </>
  );
}

/** A quiet centred message filling the PDF area — mirrors `LatexEditor`'s own
 * `PaneNotice`, kept local since this pane is chunk 9's rather than
 * restructuring the shell's shared one. */
function PreviewNotice({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <p className="font-display text-xl font-semibold text-ink">{title}</p>
      {children && <p className="max-w-xs font-ui text-sm text-ink-variant">{children}</p>}
    </div>
  );
}
