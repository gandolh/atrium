import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "@tanstack/react-router";

import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { latexErrorMessage, latexPublishCompileFailure } from "./latex-api";
import type { LatexJumpTarget } from "./LatexEditor";
import { usePublishLatexProject } from "./use-latex";

/**
 * The publish dialog (brief 38 chunk 10) — the `CHUNK 10 MOUNT` point in
 * `LatexEditor.tsx`'s header row.
 *
 * Trigger → confirm → publish. **Publishing twice never makes a second
 * card** (decision 8): `LatexProject.publishedBookId` is null only before the
 * first publish, so every dialog after that opens straight into "adds a
 * version to «title»" copy, and the success screen names the exact version
 * number the server minted — that's what makes "this is version N of an
 * existing entry, not a new card" obvious, without a second network call just
 * to predict the number ahead of time.
 *
 * A **failing** compile refuses to publish (the route's own rule, not
 * duplicated here): `latexPublishCompileFailure` pulls the `LatexCompileResult`
 * out of the 422, and the SAME `DiagnosticsPanel` chunk 9 built renders it —
 * "fix these errors before publishing" is the errors-panel a person already
 * knows, not a second one invented for this dialog.
 */
export function PublishDialog({
  projectId,
  projectTitle,
  publishedBookId,
  flush,
  onJump,
}: {
  projectId: string;
  projectTitle: string;
  /** Null until the first publish; stable afterward (decision 8). */
  publishedBookId: string | null;
  /**
   * Flush the pending autosave FIRST, mirroring `LatexEditor.onCompile`'s own
   * ordering exactly: publishing runs a fresh server-side compile, so a stale
   * buffer would publish the last autosave rather than what's on screen.
   *
   * Resolves to whether the buffer actually reached the server — and it MUST be
   * awaited (see `onConfirm`). It used to return synchronously, which made the
   * ordering a coincidence rather than a rule: the PUT and the publish POST
   * went out as two unordered requests, and whenever the publish handler read
   * the tree before the PUT's disk write completed, the stale bytes became a
   * PUBLISHED VERSION — a permanent artifact, not a preview you can recompile.
   */
  flush: () => Promise<boolean>;
  /** Jump the editor to a diagnostic's location and close this dialog. */
  onJump: (target: LatexJumpTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  /**
   * True while the confirm click is waiting for the editor's pending write to
   * land, BEFORE the publish request exists. Without it this window looks idle:
   * `publish.isPending` is still false, so the buttons stay live and a second
   * click would publish twice.
   */
  const [saving, setSaving] = useState(false);
  /**
   * The flush came back "not saved" — the server still holds older bytes, so
   * there was nothing safe to publish. Needs its own line in the dialog: the
   * editor's own error banner is behind this modal and cannot be read from here.
   */
  const [saveFailed, setSaveFailed] = useState(false);
  const publish = usePublishLatexProject(projectId);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const isRepublish = publishedBookId !== null;
  /** Either half of confirm is running: the flush, then the publish itself. */
  const busy = saving || publish.isPending;

  const openDialog = () => {
    publish.reset();
    setSaveFailed(false);
    setOpen(true);
  };
  const closeDialog = () => {
    if (busy) return;
    setOpen(false);
    setSaveFailed(false);
    publish.reset();
  };

  /**
   * Save, THEN publish — never both at once. Awaiting `flush()` is what makes
   * the published version the document that is on screen rather than whichever
   * autosave happened to have finished writing (see the `flush` prop's doc).
   * A write that failed publishes nothing at all: publishing older bytes is the
   * same corruption without the race, and here it would be minted as a version
   * number that can never be taken back.
   */
  const onConfirm = () => {
    if (busy) return;
    setSaveFailed(false);
    setSaving(true);
    void flush().then((saved) => {
      setSaving(false);
      if (saved) publish.mutate();
      else setSaveFailed(true);
    });
  };

  const onDiagnosticJump = (target: LatexJumpTarget) => {
    setOpen(false);
    publish.reset();
    onJump(target);
  };

  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") closeDialog();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, busy]);

  const compileFailure = publish.isError ? latexPublishCompileFailure(publish.error) : null;

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="shrink-0 rounded-card border border-line-soft px-3 py-1.5 font-ui text-sm font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
      >
        Publish
      </button>

      {open &&
        createPortal(
          <div
            role="presentation"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-5 backdrop-blur-md"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) closeDialog();
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="publish-dialog-title"
              className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-card border border-line-soft bg-paper-raised shadow-lift"
            >
              <div className="flex flex-col gap-2 p-6 pb-0">
                <h2 id="publish-dialog-title" className="font-display text-xl font-semibold text-ink">
                  {publish.isSuccess
                    ? "Published"
                    : isRepublish
                      ? `Publish a new version of “${projectTitle}”?`
                      : `Publish “${projectTitle}”?`}
                </h2>

                {!publish.isSuccess && !compileFailure && (
                  <p className="font-ui text-sm text-ink-variant">
                    {isRepublish
                      ? "This adds a new version to the existing library entry — it will not create a second card. Readers who haven't explicitly opened an older version will see this one."
                      : "This compiles the project and adds it to your library as a new entry. You can publish again any time to add another version."}
                  </p>
                )}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-6 pt-4">
                {compileFailure ? (
                  <div className="-mx-6 flex flex-col gap-2">
                    <p className="px-6 font-ui text-sm text-ink-variant">
                      This document doesn't compile, so there's nothing to publish. Fix these
                      first, then publish again.
                    </p>
                    <DiagnosticsPanel result={compileFailure} loading={false} onJump={onDiagnosticJump} />
                  </div>
                ) : publish.isSuccess ? (
                  <div className="flex flex-col gap-3">
                    <p className="font-ui text-sm text-ink-variant">
                      Published as{" "}
                      <span className="font-semibold text-ink tabular-nums">
                        version {publish.data.version.versionNo}
                      </span>{" "}
                      of{" "}
                      <span className="font-semibold text-ink">
                        &ldquo;{publish.data.book.title}&rdquo;
                      </span>{" "}
                      in your library.
                    </p>
                    <Link
                      to="/read"
                      search={{ book: publish.data.book.id, format: "pdf" }}
                      className="w-fit rounded-card border border-line-soft px-3 py-1.5 font-ui text-sm font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      Open in the library
                    </Link>
                  </div>
                ) : publish.isError ? (
                  <p role="alert" className="font-ui text-sm text-danger">
                    {latexErrorMessage(publish.error, "Couldn't publish this project. Try again.")}
                  </p>
                ) : saveFailed ? (
                  <p role="alert" className="font-ui text-sm text-danger">
                    Your latest changes couldn't be saved, so this would publish an older draft.
                    Nothing was published — try again.
                  </p>
                ) : null}
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-line-soft/60 p-4">
                {publish.isSuccess ? (
                  <button
                    type="button"
                    onClick={closeDialog}
                    className="rounded bg-ink-fill px-4 py-1.5 font-ui text-sm font-semibold text-on-ink-fill transition hover:opacity-90"
                  >
                    Done
                  </button>
                ) : compileFailure ? (
                  <button
                    type="button"
                    onClick={closeDialog}
                    className="rounded-card px-3 py-1.5 font-ui text-sm text-ink-variant transition hover:text-ink"
                  >
                    Close
                  </button>
                ) : (
                  <>
                    <button
                      ref={cancelRef}
                      type="button"
                      disabled={busy}
                      onClick={closeDialog}
                      className="rounded-card px-3 py-1.5 font-ui text-sm text-ink-variant transition hover:text-ink disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={onConfirm}
                      className="rounded bg-ink-fill px-4 py-1.5 font-ui text-sm font-semibold text-on-ink-fill transition hover:opacity-90 disabled:opacity-50"
                    >
                      {publish.isPending ? "Publishing…" : saving ? "Saving…" : "Publish"}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
