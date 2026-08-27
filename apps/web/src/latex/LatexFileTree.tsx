import { useEffect, useMemo, useRef, useState } from "react";
import type { LatexFile } from "@ebook-reader/shared";

import { buildFileTree, dirnameOf, formatBytes, isTextPath, type TreeNode } from "./latex-paths";

/**
 * The project's file tree (brief 38 chunk 8) — the left rail of the editor on
 * desktop, the "Files" tab on a phone.
 *
 * Shape follows `NotesList`/`LatexList`'s rows rather than an IDE explorer: one
 * left-aligned column, hairline dividers, an accent left rule for the row
 * that's open. Accent is state (design.md), and "this is the file you have
 * open" is the only state a tree row carries.
 *
 * Create / rename / delete all happen inline, in the row or at the head of the
 * list — no modal, no context menu. A draft has no undo, so delete is a
 * two-step confirm in place ("Delete" → "Delete <name>?") rather than a
 * `window.confirm` the design system has no say over.
 */

interface LatexFileTreeProps {
  files: LatexFile[];
  /** The file currently in the source pane, if any. */
  openPath: string | null;
  /** The project's `entrypoint` — the file `compile()` starts from. */
  entrypoint: string;
  /** True while a create/rename/delete is in flight; disables the affordances. */
  busy?: boolean;
  onOpen: (path: string) => void;
  onCreate: (path: string) => void;
  onRename: (from: string, to: string) => void;
  onDelete: (path: string) => void;
  onSetEntrypoint: (path: string) => void;
}

export function LatexFileTree({
  files,
  openPath,
  entrypoint,
  busy = false,
  onOpen,
  onCreate,
  onRename,
  onDelete,
  onSetEntrypoint,
}: LatexFileTreeProps) {
  const tree = useMemo(() => buildFileTree(files), [files]);
  const [creating, setCreating] = useState(false);
  // Folders are open by default; this holds only the ones deliberately closed,
  // so a newly-appearing folder is never hidden behind a stale collapsed flag.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  const totalBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <h3 className="font-ui text-[10px] font-semibold uppercase tracking-[0.15em] text-ink-variant">
          Files
        </h3>
        <button
          type="button"
          onClick={() => setCreating(true)}
          disabled={busy || creating}
          className="rounded-card px-2 py-1 font-ui text-xs font-medium text-ink-variant transition hover:text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent"
        >
          + New file
        </button>
      </div>

      {creating && (
        <PathInput
          label="New file path"
          placeholder="chapter-2.tex"
          initial=""
          confirmLabel="Create"
          onCancel={() => setCreating(false)}
          onSubmit={(path) => {
            setCreating(false);
            onCreate(path);
          }}
        />
      )}

      <ul className="min-h-0 flex-1 list-none overflow-y-auto border-y border-line-soft/60 py-1">
        {tree.length === 0 ? (
          <li className="px-3 py-6 text-center font-ui text-xs text-ink-variant">
            This project has no files yet.
          </li>
        ) : (
          tree.map((node) => (
            <TreeRow
              key={node.path}
              node={node}
              depth={0}
              openPath={openPath}
              entrypoint={entrypoint}
              busy={busy}
              collapsed={collapsed}
              onToggleDir={(path) =>
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (!next.delete(path)) next.add(path);
                  return next;
                })
              }
              onOpen={onOpen}
              onRename={onRename}
              onDelete={onDelete}
              onSetEntrypoint={onSetEntrypoint}
            />
          ))
        )}
      </ul>

      <p className="px-3 py-2 font-ui text-[11px] text-ink-variant">
        {files.length} {files.length === 1 ? "file" : "files"} · {formatBytes(totalBytes)}
      </p>
    </div>
  );
}

/** One node — a collapsible directory, or a file row with its inline actions. */
function TreeRow({
  node,
  depth,
  openPath,
  entrypoint,
  busy,
  collapsed,
  onToggleDir,
  onOpen,
  onRename,
  onDelete,
  onSetEntrypoint,
}: {
  node: TreeNode;
  depth: number;
  openPath: string | null;
  entrypoint: string;
  busy: boolean;
  collapsed: ReadonlySet<string>;
  onToggleDir: (path: string) => void;
  onOpen: (path: string) => void;
  onRename: (from: string, to: string) => void;
  onDelete: (path: string) => void;
  onSetEntrypoint: (path: string) => void;
}) {
  const indent = { paddingLeft: `${12 + depth * 14}px` };

  if (node.kind === "dir") {
    const isOpen = !collapsed.has(node.path);
    return (
      <li>
        <button
          type="button"
          onClick={() => onToggleDir(node.path)}
          aria-expanded={isOpen}
          style={indent}
          className="flex w-full items-center gap-1.5 py-1.5 pr-3 text-left font-ui text-xs font-semibold text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        >
          <Chevron open={isOpen} />
          {node.name}
        </button>
        {isOpen && (
          <ul className="list-none">
            {node.children.map((child) => (
              <TreeRow
                key={child.path}
                node={child}
                depth={depth + 1}
                openPath={openPath}
                entrypoint={entrypoint}
                busy={busy}
                collapsed={collapsed}
                onToggleDir={onToggleDir}
                onOpen={onOpen}
                onRename={onRename}
                onDelete={onDelete}
                onSetEntrypoint={onSetEntrypoint}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <FileRow
      node={node}
      style={indent}
      isOpen={openPath === node.path}
      isEntrypoint={entrypoint === node.path}
      busy={busy}
      onOpen={onOpen}
      onRename={onRename}
      onDelete={onDelete}
      onSetEntrypoint={onSetEntrypoint}
    />
  );
}

function FileRow({
  node,
  style,
  isOpen,
  isEntrypoint,
  busy,
  onOpen,
  onRename,
  onDelete,
  onSetEntrypoint,
}: {
  node: Extract<TreeNode, { kind: "file" }>;
  style: { paddingLeft: string };
  isOpen: boolean;
  isEntrypoint: boolean;
  busy: boolean;
  onOpen: (path: string) => void;
  onRename: (from: string, to: string) => void;
  onDelete: (path: string) => void;
  onSetEntrypoint: (path: string) => void;
}) {
  const [mode, setMode] = useState<"idle" | "renaming" | "confirming">("idle");
  const editable = isTextPath(node.path);

  if (mode === "renaming") {
    return (
      <li>
        <PathInput
          label={`Rename ${node.name}`}
          placeholder={node.path}
          initial={node.path}
          confirmLabel="Rename"
          onCancel={() => setMode("idle")}
          onSubmit={(to) => {
            setMode("idle");
            if (to !== node.path) onRename(node.path, to);
          }}
        />
      </li>
    );
  }

  return (
    <li
      className={`group relative flex items-center gap-2 border-l-2 pr-2 transition-colors focus-within:bg-paper-raised hover:bg-paper-raised ${
        isOpen ? "border-l-accent bg-paper-raised" : "border-l-transparent"
      }`}
    >
      <button
        type="button"
        onClick={() => onOpen(node.path)}
        aria-current={isOpen ? "true" : undefined}
        style={style}
        className="flex min-w-0 flex-1 items-baseline gap-2 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span
          title={`${node.path} · ${formatBytes(node.file.sizeBytes)}`}
          className={`min-w-0 flex-1 truncate font-ui text-sm ${
            isOpen ? "font-semibold text-ink" : "font-medium text-ink-variant"
          } ${editable ? "" : "italic"}`}
        >
          {node.name}
        </span>
        {isEntrypoint && (
          <span className="shrink-0 font-ui text-[10px] font-semibold tracking-[0.15em] text-ink-variant uppercase">
            main
          </span>
        )}
      </button>

      {mode === "confirming" ? (
        <span className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => {
              setMode("idle");
              onDelete(node.path);
            }}
            className="rounded-card px-1.5 py-1 font-ui text-[11px] font-semibold text-danger transition hover:opacity-80 focus-visible:outline-2 focus-visible:outline-accent"
          >
            Delete?
          </button>
          <button
            type="button"
            onClick={() => setMode("idle")}
            className="rounded-card px-1.5 py-1 font-ui text-[11px] text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
          >
            No
          </button>
        </span>
      ) : (
        // Always visible on touch (there is no hover to reveal them); on a
        // pointer device they are `hidden` — not merely transparent — until
        // hover or focus, because at 240px an invisible-but-laid-out action
        // cluster silently truncates every filename to one character.
        <span className="flex shrink-0 items-center gap-0.5 md:hidden md:group-focus-within:flex md:group-hover:flex">
          {editable && !isEntrypoint && (
            <RowAction
              label={`Make ${node.name} the main file`}
              onClick={() => onSetEntrypoint(node.path)}
              disabled={busy}
            >
              Main
            </RowAction>
          )}
          <RowAction
            label={`Rename ${node.name}`}
            onClick={() => setMode("renaming")}
            disabled={busy}
          >
            Rename
          </RowAction>
          <RowAction
            label={`Delete ${node.name}`}
            onClick={() => setMode("confirming")}
            disabled={busy}
          >
            Delete
          </RowAction>
        </span>
      )}
    </li>
  );
}

function RowAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="rounded-card px-1.5 py-1 font-ui text-[11px] text-ink-variant transition hover:text-ink disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent"
    >
      {children}
    </button>
  );
}

/**
 * The one inline text input the tree uses, for both "new file" and "rename".
 *
 * Paths are typed whole (`figures/plot.tex`), which is also how a folder is
 * created — there is no separate "new folder", because the server has no
 * concept of an empty one. Validation here is only the obvious client-side
 * shape check; the authority is `POST`/`PUT`, which answers `400 INVALID_PATH`
 * with a message written to be read, and the editor surfaces that verbatim.
 */
function PathInput({
  label,
  placeholder,
  initial,
  confirmLabel,
  onSubmit,
  onCancel,
}: {
  label: string;
  placeholder: string;
  initial: string;
  confirmLabel: string;
  onSubmit: (path: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    // Select the basename only, so renaming `figures/plot.tex` does not mean
    // retyping the folder.
    const dir = dirnameOf(initial);
    if (dir) ref.current?.setSelectionRange(dir.length + 1, initial.length);
    else ref.current?.select();
  }, [initial]);

  const trimmed = value.trim();
  const valid = trimmed.length > 0 && !trimmed.startsWith("/") && !trimmed.endsWith("/");

  return (
    <form
      className="flex items-center gap-1.5 px-3 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onSubmit(trimmed);
      }}
    >
      <input
        ref={ref}
        value={value}
        aria-label={label}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        className="min-w-0 flex-1 rounded-card border border-line bg-paper-raised px-2 py-1 font-ui text-xs text-ink outline-none focus:border-accent"
      />
      <button
        type="submit"
        disabled={!valid}
        className="rounded-card bg-ink-fill px-2 py-1 font-ui text-[11px] font-semibold text-on-ink-fill transition hover:opacity-90 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent"
      >
        {confirmLabel}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="rounded-card px-1.5 py-1 font-ui text-[11px] text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
      >
        Cancel
      </button>
    </form>
  );
}

/** Disclosure chevron for a directory row. 1.75 stroke, inline SVG (design.md). */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      aria-hidden
      className={`h-3.5 w-3.5 shrink-0 transition-transform duration-200 ease-paper motion-reduce:transition-none ${
        open ? "rotate-90" : ""
      }`}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
    </svg>
  );
}
