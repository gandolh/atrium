import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link } from "@tanstack/react-router";
import type { LatexFile } from "@ebook-reader/shared";

import { AppHeader } from "../components/AppHeader";
import { ReaderChunkErrorBoundary } from "../reader/ReaderChunkErrorBoundary";
import { useApplyTheme } from "../reader/chrome/use-apply-theme";
import { useReaderStore, type Theme } from "../store/reader-store";
import { CompileButton } from "./CompileButton";
import { latexErrorMessage } from "./latex-api";
import { LatexFileTree } from "./LatexFileTree";
import { basename, formatBytes, isTextPath } from "./latex-paths";
import { LatexPreviewPane } from "./LatexPreviewPane";
import { PublishDialog } from "./PublishDialog";
import type { RevealTarget } from "./SourceEditor";
import {
  useCompileLatexProject,
  useDeleteLatexFile,
  useLatexCompileLog,
  useLatexFiles,
  useLatexFileText,
  useLatexPdf,
  useLatexProject,
  useRenameLatexFile,
  useUpdateLatexProject,
  useWriteLatexFile,
} from "./use-latex";

/**
 * The LaTeX editor at `/latex?project=<id>` (brief 38 chunk 8).
 *
 * Three panes: the project's file tree, a CodeMirror 6 source pane, and the
 * PDF preview. **Split on desktop, tabbed on a phone** — decision 5 is light
 * edits on the phone, not full authoring, so the phone gets one pane at a time
 * (workable) rather than three squeezed side by side (equal, and useless).
 *
 * `SourceEditor` is code-split (`React.lazy`, brief 15's precedent): CodeMirror
 * is worth its weight on this one destination and nowhere else, and the library
 * home must not download an editor it will never show.
 *
 * ## What this file does NOT own
 * - **Chunk 9** (landed) — the compile button (`CompileButton`), the PDF
 *   preview and the diagnostics panel (`LatexPreviewPane`, `DiagnosticsPanel`).
 *   `jumpTo` below is the hook a diagnostic click uses to land the caret.
 * - **Chunk 10** — the publish dialog. One marked mount point in the header.
 *
 * ## Saving
 * Debounced autosave at the notes editor's cadence (`AUTOSAVE_MS`), flushed on
 * tab-hide, on unmount and on switching files. **Single-writer,
 * last-write-wins per file** (decision 7): the whole buffer goes up as one
 * `PUT`, the server's copy becomes what was sent, and there is no CRDT, no
 * live cursor and no conflict UI to reason about.
 */

const SourceEditor = lazy(() =>
  import("./SourceEditor").then((m) => ({ default: m.SourceEditor })),
);

/**
 * The autosave debounce, in milliseconds. **Matched to `notes/NoteEditor.tsx`,
 * not invented here** — two sibling authoring surfaces that save at different
 * speeds feel like two different apps, and 900ms is already the number the
 * notes editor settled on (long enough to coalesce a burst of typing, short
 * enough that closing the tab a second after the last keystroke still lands).
 */
const AUTOSAVE_MS = 900;

/** Which single pane a phone is showing. Desktop shows all three at once. */
type Pane = "files" | "source" | "preview";

/**
 * "Open file X and put the caret on line N" — the one thing chunk 9's
 * diagnostics panel needs from the editor. Mirrors the shared `Diagnostic`
 * contract's `file` / `line` / `column`, so a diagnostic can be handed over
 * unchanged.
 */
export interface LatexJumpTarget {
  file: string;
  /** 1-based. `0` (a whole-document diagnostic) opens the file without a caret move. */
  line: number;
  /** 1-based, when the engine pinned one. */
  column?: number;
}

export function LatexEditor({ id }: { id: string }) {
  // Same mechanism as every other page-level component: without it `data-theme`
  // freezes at whatever the list view's cleanup left behind on navigation in.
  useApplyTheme();
  const theme = useReaderStore((s) => s.theme);

  const project = useLatexProject(id);
  const files = useLatexFiles(id);
  const updateProject = useUpdateLatexProject(id);
  const write = useWriteLatexFile(id);
  const renameFile = useRenameLatexFile(id);
  const deleteFile = useDeleteLatexFile(id);
  const compile = useCompileLatexProject(id);
  const compileLog = useLatexCompileLog(id);
  const pdf = useLatexPdf(id);

  const [pane, setPane] = useState<Pane>("source");
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [reveal, setReveal] = useState<RevealTarget | null>(null);
  const revealNonce = useRef(0);

  const editable = openPath !== null && isTextPath(openPath);
  const text = useLatexFileText(id, editable ? openPath : null);

  // --- The open buffer ------------------------------------------------------
  // `draft` is the authority for the open file while it is open; the query that
  // seeded it never re-seeds (staleTime: Infinity + the guard below), exactly
  // as NoteEditor refuses to let a refetch clobber in-flight edits.
  const [draft, setDraft] = useState<{ path: string; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dirtyRef = useRef(false);
  const writeRef = useRef(write);
  writeRef.current = write;

  /**
   * The write queue: the promise for the LAST write this editor put on the
   * wire, resolving to whether the buffer it carried actually reached the
   * server. Every PUT is chained onto it, and it NEVER rejects — a failed write
   * resolves `false` (the red banner below already reports the real error).
   *
   * Two jobs, both load-bearing:
   *
   * 1. **Chaining.** Two PUTs to the same path are two independent HTTP
   *    requests handled by two independent async handlers; nothing on either
   *    side orders them. Left concurrent, an older autosave could land AFTER a
   *    newer one and put stale bytes on disk — last-write-wins is only a
   *    coherent model if "last" means last-sent.
   * 2. **Awaiting.** `flush()` hands this promise back so compile and publish
   *    can wait for the buffer to be genuinely on disk before they run. See
   *    `flush` and `onCompile`.
   */
  const writeQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));
  /**
   * The `{path, text}` of a write that is on the wire right now, or null. Only
   * a de-duplicator: `dirty` is no longer cleared when a PUT is SENT (see
   * `flush`), so without this, Ctrl-S followed by Compile would queue two
   * identical PUTs of the same bytes. Cleared as soon as the write settles,
   * either way, so a failed write can always be retried.
   */
  const queuedRef = useRef<{ path: string; text: string } | null>(null);

  useEffect(() => {
    if (!editable || !openPath || text.data === undefined) return;
    if (draftRef.current?.path === openPath) return;
    setDraft({ path: openPath, text: text.data });
    dirtyRef.current = false;
    setDirty(false);
  }, [editable, openPath, text.data]);

  /**
   * Write the pending buffer now, if there is one, and resolve once **the
   * server has it** — `true` when the buffer on screen is on disk, `false` when
   * the write failed and the server still holds older bytes.
   *
   * The return value is the whole point. This used to call `mutate()` and
   * return synchronously, so `onCompile`/`PublishDialog.onConfirm` fired their
   * POST immediately after — an unordered race against a PUT that had not
   * finished writing to disk, which compiled (and could PUBLISH) the previous
   * autosave instead of what is on screen. Awaiting this promise is what makes
   * the "flush FIRST, always" invariant real rather than hoped for. Callers
   * that cannot await (unmount, tab-hide, a diagnostic jump) may still ignore
   * it; the ones whose correctness depends on the ordering must not.
   *
   * Note `dirty` is cleared on SUCCESS, not on send: a failed write leaves the
   * buffer marked unsaved so the next `flush()` retries it. It does not restart
   * the autosave timer by itself (that effect's dependencies did not change),
   * so a server that is down does not turn into a PUT loop — the retry rides on
   * the next keystroke, or on the next Compile / Publish / Ctrl-S.
   */
  const flush = useCallback((): Promise<boolean> => {
    const pending = draftRef.current;
    // Nothing of our own to send: still hand back the queue, so a caller that
    // is about to compile waits for an autosave that is ALREADY in flight.
    if (!pending || !dirtyRef.current) return writeQueueRef.current;
    const { path, text: content } = pending;
    const inFlight = queuedRef.current;
    if (inFlight && inFlight.path === path && inFlight.text === content) {
      return writeQueueRef.current;
    }
    queuedRef.current = { path, text: content };
    const run = (): Promise<boolean> =>
      writeRef.current.mutateAsync({ path, content }).then(
        () => {
          queuedRef.current = null;
          // Clear "unsaved" only if the buffer has not moved since we sent it.
          // A keystroke (or a file switch) during the round trip means what is
          // on screen is NOT what the server holds, and saying "Saved" there
          // would be a lie that also stops the next autosave from firing.
          const current = draftRef.current;
          if (current && current.path === path && current.text === content) {
            dirtyRef.current = false;
            setDirty(false);
          }
          return true;
        },
        () => {
          queuedRef.current = null;
          return false;
        },
      );
    // `.then(run, run)`: the previous write's outcome does not gate this one —
    // newer bytes are always worth sending — but its COMPLETION does.
    const next = writeQueueRef.current.then(run, run);
    writeQueueRef.current = next;
    return next;
  }, []);

  const onSourceChange = useCallback((next: string) => {
    setDraft((prev) => (prev ? { ...prev, text: next } : prev));
    dirtyRef.current = true;
    setDirty(true);
  }, []);

  // Debounced autosave. Every keystroke restarts the timer, so a burst of
  // typing costs one PUT rather than one per character.
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(flush, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [draft, dirty, flush]);

  // Flush on tab-hide and on unmount — closing the tab mid-debounce must not
  // cost the last 900ms of work. (`flush` is stable, so this mounts once.)
  useEffect(() => {
    const onHide = () => flush();
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      flush();
    };
  }, [flush]);

  // Ctrl/Cmd-S saves now instead of asking the browser to save the page. It
  // changes nothing about the model — the file was going to be written 900ms
  // later anyway — but muscle memory that appears to do nothing reads as an
  // editor that is not saving.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "s" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      flush();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [flush]);

  /** Open a file, flushing whatever the previous one still owed. */
  const openFile = useCallback(
    (path: string) => {
      flush();
      setOpenPath(path);
      setPane("source");
    },
    [flush],
  );

  /**
   * **Chunk 9's entry point.** Open the file a diagnostic points at and put the
   * caret on its line. Safe to call for a file that is not open yet — the
   * reveal is applied once that document is loaded (`SourceEditor` matches the
   * target's `file` against the document it is showing before acting), and a
   * `line` of `0` just opens the file.
   */
  const jumpTo = useCallback(
    (target: LatexJumpTarget) => {
      flush();
      setOpenPath(target.file);
      setPane("source");
      revealNonce.current += 1;
      setReveal({ ...target, nonce: revealNonce.current });
    },
    [flush],
  );
  /**
   * The compile button's action (chunk 9). `flush()` FIRST, always — and now
   * actually AWAITED, because "first" was previously only a hope: `flush()`
   * returned the instant `mutate()` was called, so the PUT and the compile POST
   * went out as two unordered requests to two independent handlers. Whenever
   * the PUT's disk write had not completed by the time the compile handler read
   * the project tree, the compile graded the PREVIOUS autosave — silently, with
   * the correct source on screen the whole time.
   *
   * A write that FAILED does not compile at all: the server holds older bytes,
   * so compiling would grade the wrong document just as surely, only with no
   * race to blame. The failure is already on screen — `write.error` renders in
   * the `role="alert"` banner below — and the buffer stays marked unsaved, so
   * pressing Compile again retries the write and then compiles.
   */
  const onCompile = useCallback(() => {
    void flush().then((saved) => {
      if (saved) compile.mutate();
    });
  }, [flush, compile]);

  // Open the entrypoint on arrival, falling back to the first editable file so
  // the pane is never blank in a project whose entrypoint was deleted.
  const fileList = files.data;
  const entrypoint = project.data?.entrypoint ?? "main.tex";
  const pickDefault = useCallback(
    (candidates: readonly LatexFile[]): string | null =>
      (
        candidates.find((f) => f.path === entrypoint) ??
        candidates.find((f) => isTextPath(f.path)) ??
        candidates[0]
      )?.path ?? null,
    [entrypoint],
  );
  const listRef = useRef(fileList);
  listRef.current = fileList;
  const pickRef = useRef(pickDefault);
  pickRef.current = pickDefault;

  useEffect(() => {
    if (openPath !== null || !fileList || fileList.length === 0) return;
    setOpenPath(pickDefault(fileList));
  }, [openPath, fileList, pickDefault]);

  // --- Project title (same debounce as the file buffer) ---------------------
  const [title, setTitle] = useState("");
  const [titleLoaded, setTitleLoaded] = useState(false);
  useEffect(() => {
    if (project.data && !titleLoaded) {
      setTitle(project.data.title);
      setTitleLoaded(true);
    }
  }, [project.data, titleLoaded]);

  const updateRef = useRef(updateProject);
  updateRef.current = updateProject;
  useEffect(() => {
    if (!titleLoaded || !project.data) return;
    const next = title.trim() || "Untitled project";
    if (next === project.data.title) return;
    const timer = setTimeout(() => updateRef.current.mutate({ title: next }), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [title, titleLoaded, project.data]);

  // --- Tree actions ---------------------------------------------------------
  // Deliberately NOT `write.isPending` or `updateProject.isPending`: those fire
  // on every autosave tick, and disabling the tree's buttons once per 900ms of
  // typing makes the whole rail blink in the corner of the eye. Only the two
  // operations that actually restructure the tree hold it.
  const treeBusy = renameFile.isPending || deleteFile.isPending;

  const onCreate = useCallback(
    (path: string) => {
      flush();
      write.mutate(
        { path, content: "" },
        {
          onSuccess: (file) => {
            setOpenPath(file.path);
            setPane("source");
          },
        },
      );
    },
    [flush, write],
  );

  const onRename = useCallback(
    (from: string, to: string) => {
      // Awaited for the same reason `onDelete` waits below: a PUT still in
      // flight when the rename lands recreates the OLD path, leaving a stale
      // duplicate behind and the renamed file holding older bytes.
      void flush().then(() => {
        renameFile.mutate(
          { from, to },
          {
            onSuccess: (file) => {
              setDraft((prev) => (prev?.path === from ? { ...prev, path: file.path } : prev));
              setOpenPath((prev) => (prev === from ? file.path : prev));
            },
          },
        );
      });
    },
    [flush, renameFile],
  );

  const onDelete = useCallback(
    (path: string) => {
      // **Disarm the pending write BEFORE the DELETE goes out, synchronously.**
      // Edit the open file (arming the 900ms autosave) and delete it inside that
      // window, and the timer used to fire after the DELETE had landed and PUT
      // the buffer straight back — silently RECREATING the file we just removed,
      // with the tree already showing it gone. Clearing `dirtyRef` here (not in
      // `onSuccess`, a round trip later) is what makes that impossible: `flush`
      // reads the ref, not the state, so a timer that fires anyway is a no-op.
      // `queuedRef` goes with it so nothing can be re-sent for this path.
      if (draftRef.current?.path === path) {
        dirtyRef.current = false;
        setDirty(false);
        queuedRef.current = null;
      }
      // A write already ON THE WIRE can resurrect the file just as well, and no
      // amount of local flag-clearing recalls it — so wait for the queue to
      // drain before asking for the delete. Never rejects (see `writeQueueRef`).
      void writeQueueRef.current.then(() => {
        deleteFile.mutate(path, {
          onSuccess: () => {
            if (draftRef.current?.path === path) {
              dirtyRef.current = false;
              setDirty(false);
              setDraft(null);
            }
            // Pick the replacement HERE, from the list minus the file just
            // deleted, rather than clearing `openPath` and letting the
            // open-on-arrival effect choose. That effect would run against the
            // still-invalidating cache and cheerfully re-open the file we just
            // deleted — which is exactly what it did before this line existed.
            setOpenPath((prev) =>
              prev === path
                ? pickRef.current((listRef.current ?? []).filter((f) => f.path !== path))
                : prev,
            );
          },
        });
      });
    },
    [deleteFile],
  );

  const onSetEntrypoint = useCallback(
    (path: string) => updateProject.mutate({ entrypoint: path }),
    [updateProject],
  );

  // The most recent failed action, whichever it was. One banner, real messages
  // (the routes answer with prose for every case reachable from here).
  // `compile.error` is a POST that never landed at all — a busy slot (409,
  // `COMPILE_BUSY`) or a transport failure — as opposed to a compile that ran
  // and *reported* a failure, which shows in the diagnostics panel instead.
  const actionError =
    write.error ??
    renameFile.error ??
    deleteFile.error ??
    updateProject.error ??
    compile.error ??
    null;
  const dismissError = useCallback(() => {
    write.reset();
    renameFile.reset();
    deleteFile.reset();
    updateProject.reset();
    compile.reset();
  }, [write, renameFile, deleteFile, updateProject, compile]);

  const openFileRow = useMemo(
    () => fileList?.find((f) => f.path === openPath) ?? null,
    [fileList, openPath],
  );

  if (project.isLoading) {
    return (
      <Shell>
        <p className="text-ink-variant">Opening project…</p>
      </Shell>
    );
  }
  if (project.isError || !project.data) {
    return (
      <Shell>
        <h1 className="font-display text-2xl font-semibold text-ink">Project not found</h1>
        <p className="max-w-md text-ink-variant">
          It may have been deleted, or it belongs to another profile.
        </p>
        <Link
          to="/latex"
          className="w-fit rounded-card border border-line-soft px-4 py-2 font-ui text-sm font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        >
          All projects
        </Link>
      </Shell>
    );
  }

  return (
    <div className="flex h-[calc(100dvh-var(--dock-height,0px))] flex-col bg-reader-bg text-ink">
      {/* Header block: back, title, save state, and the two later chunks' slots. */}
      <div className="flex shrink-0 flex-col border-b border-line-soft/50 bg-paper/95 backdrop-blur-sm">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-page py-2.5">
          <Link
            to="/latex"
            className="rounded-card px-1 py-1 font-ui text-sm font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
          >
            ← LaTeX
          </Link>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            aria-label="Project title"
            placeholder="Untitled project"
            className="min-w-0 flex-1 rounded-card bg-transparent px-1 font-display text-lg font-semibold text-ink outline-none focus:bg-paper-low"
          />
          <SaveState
            open={draft !== null}
            dirty={dirty}
            saving={write.isPending}
            failed={write.isError}
          />

          <CompileButton pending={compile.isPending} onCompile={onCompile} />

          <PublishDialog
            projectId={id}
            projectTitle={title.trim() || "Untitled project"}
            publishedBookId={project.data.publishedBookId}
            flush={flush}
            onJump={jumpTo}
          />
        </div>

        {/* Tabs are the phone's whole navigation between the three panes; on a
            desktop all three are visible at once, so the row disappears. */}
        <nav aria-label="Editor panes" className="flex gap-1 px-page pb-1 md:hidden">
          <PaneTab active={pane === "files"} onClick={() => setPane("files")}>
            Files
          </PaneTab>
          <PaneTab active={pane === "source"} onClick={() => setPane("source")}>
            Source
          </PaneTab>
          <PaneTab active={pane === "preview"} onClick={() => setPane("preview")}>
            Preview
          </PaneTab>
        </nav>
      </div>

      {actionError && (
        <div
          role="alert"
          className="flex shrink-0 items-start gap-3 border-b border-line-soft/50 bg-danger-soft px-page py-2"
        >
          <p className="flex-1 font-ui text-sm text-ink">{latexErrorMessage(actionError)}</p>
          <button
            type="button"
            onClick={dismissError}
            className="rounded-card px-2 py-0.5 font-ui text-xs font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* --- File tree ---------------------------------------------------- */}
        <aside
          aria-label="Project files"
          className={`min-h-0 w-full shrink-0 bg-paper md:block md:w-60 md:border-r md:border-line-soft/60 ${
            pane === "files" ? "block" : "hidden"
          }`}
        >
          {files.isLoading ? (
            <p className="px-3 py-4 font-ui text-xs text-ink-variant">Loading files…</p>
          ) : files.isError ? (
            <p className="px-3 py-4 font-ui text-xs text-ink-variant">
              {latexErrorMessage(files.error, "Couldn't load this project's files.")}
            </p>
          ) : (
            <LatexFileTree
              files={files.data ?? []}
              openPath={openPath}
              entrypoint={project.data.entrypoint}
              busy={treeBusy}
              onOpen={openFile}
              onCreate={onCreate}
              onRename={onRename}
              onDelete={onDelete}
              onSetEntrypoint={onSetEntrypoint}
            />
          )}
        </aside>

        {/* --- Source pane -------------------------------------------------- */}
        <section
          aria-label="Source"
          className={`min-h-0 min-w-0 w-full flex-col bg-paper-low md:flex md:flex-1 md:border-r md:border-line-soft/60 ${
            pane === "source" ? "flex" : "hidden"
          }`}
        >
          <SourcePane
            docKey={openPath}
            draft={draft}
            editable={editable}
            loading={text.isLoading}
            error={text.error}
            sizeBytes={openFileRow?.sizeBytes ?? 0}
            theme={theme}
            reveal={reveal}
            onChange={onSourceChange}
          />
        </section>

        {/* --- Preview pane ------------------------------------------------- */}
        <section
          aria-label="Preview"
          className={`min-h-0 min-w-0 w-full flex-col bg-paper-low md:flex md:flex-1 ${
            pane === "preview" ? "flex" : "hidden"
          }`}
        >
          <LatexPreviewPane
            pdfFile={pdf.data ?? null}
            pdfLoading={pdf.isLoading}
            compiling={compile.isPending}
            result={compileLog.data}
            resultLoading={compileLog.isLoading}
            onJump={jumpTo}
          />
        </section>
      </div>
    </div>
  );
}

/**
 * The source pane's contents: the lazy CodeMirror editor, or the reason there
 * isn't one (nothing open, still loading, or a file that is bytes rather than
 * text).
 */
function SourcePane({
  docKey,
  draft,
  editable,
  loading,
  error,
  sizeBytes,
  theme,
  reveal,
  onChange,
}: {
  docKey: string | null;
  draft: { path: string; text: string } | null;
  editable: boolean;
  loading: boolean;
  error: unknown;
  sizeBytes: number;
  theme: Theme;
  reveal: RevealTarget | null;
  onChange: (next: string) => void;
}) {
  if (!docKey) {
    return <PaneNotice title="Nothing open">Pick a file from the tree to start editing.</PaneNotice>;
  }
  if (!editable) {
    return (
      <PaneNotice title={basename(docKey)}>
        {formatBytes(sizeBytes)} · figures and other binaries live in the project but are not
        edited here. Rename or delete it from the tree, or reference it from your source.
      </PaneNotice>
    );
  }
  if (error) {
    return (
      <PaneNotice title="Couldn't open that file">
        {latexErrorMessage(error, "The file could not be read.")}
      </PaneNotice>
    );
  }
  if (loading || !draft || draft.path !== docKey) {
    return <PaneNotice title={basename(docKey)}>Loading…</PaneNotice>;
  }

  return (
    <ReaderChunkErrorBoundary
      fallback={(retry) => (
        <PaneNotice title="The editor didn't load">
          <button
            type="button"
            onClick={retry}
            className="rounded-card border border-line-soft px-3 py-1.5 font-ui text-sm font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
          >
            Reload
          </button>
        </PaneNotice>
      )}
    >
      <Suspense fallback={<PaneNotice title={basename(docKey)}>Loading the editor…</PaneNotice>}>
        <SourceEditor
          docKey={docKey}
          value={draft.text}
          onChange={onChange}
          theme={theme}
          reveal={reveal}
          label={`${docKey} source`}
        />
      </Suspense>
    </ReaderChunkErrorBoundary>
  );
}

/** A quiet centred message filling a pane. */
function PaneNotice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <p className="font-display text-lg font-semibold text-ink">{title}</p>
      <p className="max-w-sm font-ui text-sm text-ink-variant">{children}</p>
    </div>
  );
}

/**
 * The save indicator. Words, not a coloured dot: "unsaved" is the one thing in
 * this header a person might actually need to read at a glance, and a 6px
 * accent dot would be decoration doing a label's job.
 *
 * Not a live region, on purpose. It changes on every autosave tick, so
 * announcing it would talk over someone typing once a second; the one state
 * worth interrupting for — a save that failed — is already announced by the
 * `role="alert"` banner above.
 */
function SaveState({
  open,
  dirty,
  saving,
  failed,
}: {
  /** False when no file is open — an editor with nothing in it is not "Saved". */
  open: boolean;
  dirty: boolean;
  saving: boolean;
  failed: boolean;
}) {
  if (!open) return null;
  const label = failed
    ? "Not saved"
    : saving
      ? "Saving…"
      : dirty
        ? "Unsaved changes"
        : "Saved";
  return (
    <span className={`shrink-0 font-ui text-xs ${failed ? "text-danger" : "text-ink-variant"}`}>
      {label}
    </span>
  );
}

/** A phone pane tab. Active state is an accent underline — accent means state. */
function PaneTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={`rounded-t-card border-b-2 px-3 py-1.5 font-ui text-sm transition-colors duration-200 ease-paper motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-accent ${
        active
          ? "border-b-accent font-semibold text-ink"
          : "border-b-transparent font-medium text-ink-variant hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

/** Page shell for the loading / not-found states, matching the other destinations. */
function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-[calc(100vh-var(--dock-height,0px))] max-w-6xl flex-col gap-4 px-5 py-8 text-ink md:px-16">
      <AppHeader />
      {children}
    </main>
  );
}
