import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { NoteFolder, NoteSummary } from "@ebook-reader/shared";

import { useApplyTheme } from "../reader/chrome/use-apply-theme";
import { AppHeader } from "../components/AppHeader";
import { useActiveProfileId } from "../lib/auth";
import {
  useCreateFolder,
  useCreateNote,
  useDeleteFolder,
  useDeleteNote,
  useMoveNote,
  useNoteFolders,
  useNotesList,
  useUpdateFolder,
} from "./use-notes";

/**
 * `/notes` list (brief 26; restyled onto Reading Room in brief 33; folders in
 * brief 50) — the per-profile notes index. Notes is not a media chip (D33g: a
 * notebook is *authored*, not *collected*), so unlike the library's tinted tile
 * grid this renders as a single left-aligned column of rows — title, page
 * count, relative date — closer to the reader's contents list than to a cover
 * shelf.
 *
 * Folders turn that column into a **collapsible tree**, following the idiom
 * `latex/LatexFileTree.tsx` already set rather than inventing a second one:
 * indentation by depth, a rotating chevron, inline create/rename, a two-step
 * delete confirm in place, and hover-revealed row actions. The rows themselves
 * are unchanged — same 2px `accent` left rule on `paper-raised`, which is the
 * one state a row in this list carries.
 *
 * The tree stays deliberately plain. There are two notes in the real library;
 * folders are here to be correct when they matter, not to become the page.
 */
export function NotesList() {
  useApplyTheme();
  const navigate = useNavigate();
  const { data: notes, isLoading, isError, refetch } = useNotesList();
  const { data: folders } = useNoteFolders();
  const create = useCreateNote();
  const remove = useDeleteNote();
  const createFolder = useCreateFolder();
  const updateFolder = useUpdateFolder();
  const deleteFolder = useDeleteFolder();
  const moveNote = useMoveNote();

  const profileId = useActiveProfileId();
  const [collapsed, toggleCollapsed] = useCollapsedFolders(profileId);
  /** The folder a "+ Folder" click is creating under; `null` = at the root. */
  const [creatingUnder, setCreatingUnder] = useState<string | null | undefined>(undefined);

  const tree = useMemo(() => buildFolderTree(folders ?? [], notes ?? []), [folders, notes]);
  const rows = useMemo(() => flattenTree(tree, collapsed), [tree, collapsed]);
  const options = useMemo(() => folderOptions(tree), [tree]);

  const busy =
    createFolder.isPending ||
    updateFolder.isPending ||
    deleteFolder.isPending ||
    moveNote.isPending ||
    remove.isPending;

  function openNote(id: string) {
    void navigate({ to: "/notes", search: { note: id } });
  }

  function newNote() {
    create.mutate(undefined, { onSuccess: (note) => openNote(note.id) });
  }

  const hasAnything = (notes?.length ?? 0) > 0 || (folders?.length ?? 0) > 0;

  return (
    <main className="mx-auto flex min-h-[calc(100vh-var(--dock-height,0px))] max-w-6xl flex-col gap-8 px-5 py-8 text-ink md:px-16">
      <AppHeader
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCreatingUnder(null)}
              disabled={busy}
              className="rounded-card border border-line-soft px-3 py-2 font-ui text-sm font-medium text-ink-variant transition hover:text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent"
            >
              + New folder
            </button>
            <button
              type="button"
              onClick={newNote}
              disabled={create.isPending}
              className="rounded bg-ink-fill px-4 py-2 font-ui text-sm font-semibold text-on-ink-fill transition hover:opacity-90 disabled:opacity-50"
            >
              {create.isPending ? "Creating…" : "+ New note"}
            </button>
          </div>
        }
      />

      <section aria-label="Notes" className="flex flex-col gap-5">
        <h2 className="font-display text-3xl font-semibold text-ink">Notes</h2>

        {isLoading ? (
          <div
            className="flex max-w-2xl flex-col divide-y divide-line-soft/60 rounded-card border border-line-soft/70"
            aria-hidden
          >
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3">
                <div className="h-9 w-9 shrink-0 motion-safe:animate-pulse rounded-cover bg-paper-container" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <div className="h-3.5 w-1/3 motion-safe:animate-pulse rounded-card bg-paper-container" />
                  <div className="h-3 w-1/4 motion-safe:animate-pulse rounded-card bg-paper-container" />
                </div>
              </div>
            ))}
          </div>
        ) : isError ? (
          <EmptyState
            title="Couldn't load your notes"
            body="The API may be offline. Start it with npm run dev and refresh."
            action={
              <button
                type="button"
                onClick={() => refetch()}
                className="rounded-card border border-line-soft px-4 py-1.5 text-sm font-medium text-ink-variant transition hover:text-ink"
              >
                Try again
              </button>
            }
          />
        ) : !hasAnything && creatingUnder === undefined ? (
          <EmptyState
            title="No notes yet"
            body="Create your first note to draw, sketch, and write — with a pen, highlighter, and text."
            action={
              <button
                type="button"
                onClick={newNote}
                className="rounded-card border border-line-soft px-4 py-1.5 font-ui text-sm font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
              >
                New note
              </button>
            }
          />
        ) : (
          <div className="flex max-w-2xl flex-col divide-y divide-line-soft/60 rounded-card border border-line-soft/70">
            {/* A root-level "new folder" input sits above the tree; a nested one
                is rendered in place under its parent row, below. */}
            {creatingUnder === null && (
              <NameInput
                label="New folder name"
                initial=""
                confirmLabel="Create"
                onCancel={() => setCreatingUnder(undefined)}
                onSubmit={(name) => {
                  setCreatingUnder(undefined);
                  createFolder.mutate({ name, parentId: null });
                }}
              />
            )}

            {rows.map((row) =>
              row.kind === "folder" ? (
                <FolderRow
                  key={`f:${row.folder.id}`}
                  folder={row.folder}
                  depth={row.depth}
                  noteCount={row.noteCount}
                  open={!collapsed.has(row.folder.id)}
                  busy={busy}
                  options={options}
                  creatingHere={creatingUnder === row.folder.id}
                  onToggle={() => toggleCollapsed(row.folder.id)}
                  onStartCreate={() => setCreatingUnder(row.folder.id)}
                  onCancelCreate={() => setCreatingUnder(undefined)}
                  onCreate={(name) => {
                    setCreatingUnder(undefined);
                    createFolder.mutate({ name, parentId: row.folder.id });
                  }}
                  onRename={(name) => updateFolder.mutate({ id: row.folder.id, name })}
                  onMove={(parentId) => updateFolder.mutate({ id: row.folder.id, parentId })}
                  onDelete={() => deleteFolder.mutate(row.folder.id)}
                />
              ) : (
                <NoteRow
                  key={`n:${row.note.id}`}
                  note={row.note}
                  depth={row.depth}
                  busy={busy}
                  options={options}
                  onOpen={() => openNote(row.note.id)}
                  onMove={(folderId) => moveNote.mutate({ id: row.note.id, folderId })}
                  onDelete={() => remove.mutate(row.note)}
                />
              ),
            )}

            {rows.length === 0 && (
              <p className="px-4 py-6 text-center font-ui text-xs text-ink-variant">
                Nothing here yet.
              </p>
            )}
          </div>
        )}
      </section>
    </main>
  );
}

/* -------------------------------------------------------------------------
 * The tree
 * ---------------------------------------------------------------------- */

interface FolderNode {
  folder: NoteFolder;
  children: FolderNode[];
  /** Notes filed directly in this folder, newest-updated first (the API order). */
  notes: NoteSummary[];
  /** Notes in this folder AND everything under it — what a collapsed row hides. */
  noteCount: number;
}

interface Tree {
  roots: FolderNode[];
  /** Notes at the root — `folderId === null`, and the pre-folders behaviour. */
  rootNotes: NoteSummary[];
}

/**
 * How deep the renderer will follow `parentId` before giving up.
 *
 * The server refuses to create a cycle (`wouldCycleNoteFolder`), so this should
 * never bite. It exists because the failure it prevents is the one the brief
 * names: a cycle **hangs the list render**, and a render that trusts the
 * server's invariant has no way back from a database that acquired one anyway —
 * a hand-edited row, a restored backup. A capped walk draws a truncated tree;
 * an uncapped one locks the tab.
 */
const MAX_DEPTH = 64;

/**
 * Assemble the flat folder + note lists into a tree.
 *
 * Deliberately forgiving about bad input, for the same reason as the depth cap:
 * a folder whose `parentId` names something this profile cannot see is drawn at
 * the ROOT rather than dropped, and a note whose `folderId` is likewise unknown
 * is drawn at the root too. Losing sight of a notebook because a parent row went
 * missing would be the worst possible failure mode for this screen.
 */
function buildFolderTree(folders: NoteFolder[], notes: NoteSummary[]): Tree {
  const known = new Set(folders.map((f) => f.id));
  const childrenOf = new Map<string | null, NoteFolder[]>();
  for (const folder of folders) {
    const parent = folder.parentId !== null && known.has(folder.parentId) ? folder.parentId : null;
    const bucket = childrenOf.get(parent);
    if (bucket) bucket.push(folder);
    else childrenOf.set(parent, [folder]);
  }

  const notesOf = new Map<string | null, NoteSummary[]>();
  for (const note of notes) {
    const key = note.folderId !== null && known.has(note.folderId) ? note.folderId : null;
    const bucket = notesOf.get(key);
    if (bucket) bucket.push(note);
    else notesOf.set(key, [note]);
  }

  function build(parentId: string | null, depth: number, seen: ReadonlySet<string>): FolderNode[] {
    if (depth >= MAX_DEPTH) return [];
    return (childrenOf.get(parentId) ?? [])
      .filter((folder) => !seen.has(folder.id))
      .map((folder) => {
        const children = build(folder.id, depth + 1, new Set(seen).add(folder.id));
        const own = notesOf.get(folder.id) ?? [];
        return {
          folder,
          children,
          notes: own,
          noteCount: own.length + children.reduce((sum, c) => sum + c.noteCount, 0),
        };
      });
  }

  return { roots: build(null, 0, new Set()), rootNotes: notesOf.get(null) ?? [] };
}

type Row =
  | { kind: "folder"; depth: number; folder: NoteFolder; noteCount: number }
  | { kind: "note"; depth: number; note: NoteSummary };

/**
 * Flatten the tree into the rows actually rendered, skipping anything under a
 * collapsed folder. One flat list keeps the hairline dividers even across
 * nesting levels — a nested `<ul>` per level would break `divide-y`.
 */
function flattenTree(tree: Tree, collapsed: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  const walk = (nodes: FolderNode[], depth: number) => {
    for (const node of nodes) {
      rows.push({ kind: "folder", depth, folder: node.folder, noteCount: node.noteCount });
      if (collapsed.has(node.folder.id)) continue;
      walk(node.children, depth + 1);
      for (const note of node.notes) rows.push({ kind: "note", depth: depth + 1, note });
    }
  };
  walk(tree.roots, 0);
  // Root-level notes last, under every top-level folder — the same reading
  // order as a file manager, and where a note that has never been filed lives.
  for (const note of tree.rootNotes) rows.push({ kind: "note", depth: 0, note });
  return rows;
}

/** One entry in a "move to…" menu: the root, then every folder in tree order. */
interface FolderOption {
  id: string;
  label: string;
  depth: number;
  /** Every folder on the path from the root to this one, this one included. */
  ancestry: readonly string[];
}

function folderOptions(tree: Tree): FolderOption[] {
  const out: FolderOption[] = [];
  const walk = (nodes: FolderNode[], depth: number, ancestry: readonly string[]) => {
    for (const node of nodes) {
      const path = [...ancestry, node.folder.id];
      out.push({
        id: node.folder.id,
        // Non-breaking spaces: a native <option> collapses ordinary ones, and
        // the indent is the only thing that shows nesting inside a picker.
        label: `${"\u00a0\u00a0".repeat(depth)}${node.folder.name}`,
        depth,
        ancestry: path,
      });
      walk(node.children, depth + 1, path);
    }
  };
  walk(tree.roots, 0, []);
  return out;
}

/* -------------------------------------------------------------------------
 * Rows
 * ---------------------------------------------------------------------- */

/**
 * A folder row: disclosure chevron, a neutral container swatch, the name and
 * how many notes are inside (including subfolders — that is exactly what a
 * collapsed row hides).
 *
 * The swatch is `paper-container`, NOT `tint-note`. Kind tints carry kind
 * (design.md), and a folder is not a kind of thing you can read — keeping the
 * green tint exclusive to notes is what lets the column still read by kind with
 * every label stripped.
 */
function FolderRow({
  folder,
  depth,
  noteCount,
  open,
  busy,
  options,
  creatingHere,
  onToggle,
  onStartCreate,
  onCancelCreate,
  onCreate,
  onRename,
  onMove,
  onDelete,
}: {
  folder: NoteFolder;
  depth: number;
  noteCount: number;
  open: boolean;
  busy: boolean;
  options: FolderOption[];
  creatingHere: boolean;
  onToggle: () => void;
  onStartCreate: () => void;
  onCancelCreate: () => void;
  onCreate: (name: string) => void;
  onRename: (name: string) => void;
  onMove: (parentId: string | null) => void;
  onDelete: () => void;
}) {
  const [mode, setMode] = useState<"idle" | "renaming" | "confirming">("idle");

  if (mode === "renaming") {
    return (
      <NameInput
        label={`Rename ${folder.name}`}
        initial={folder.name}
        confirmLabel="Rename"
        depth={depth}
        onCancel={() => setMode("idle")}
        onSubmit={(name) => {
          setMode("idle");
          if (name !== folder.name) onRename(name);
        }}
      />
    );
  }

  // A folder cannot be moved into itself or into anything beneath it — that is
  // the cycle the server refuses with a 400. Filtering the picker means the UI
  // never even offers the request; the server check is still the authority.
  const destinations = options.filter((o) => !o.ancestry.includes(folder.id));

  return (
    <>
      <div className="group relative flex items-center gap-2 border-l-2 border-l-transparent py-2.5 pr-3 transition-colors focus-within:border-l-accent focus-within:bg-paper-raised hover:border-l-accent hover:bg-paper-raised">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          style={indentFor(depth)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-accent"
        >
          <Chevron open={open} />
          <span
            aria-hidden
            className="grid h-9 w-9 shrink-0 place-items-center rounded-cover bg-paper-container text-ink-variant"
          >
            <FolderGlyph />
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate font-ui text-sm font-semibold text-ink">{folder.name}</span>
            <span className="font-ui text-xs text-ink-variant">
              <span className="tabular-nums">{noteCount}</span> note{noteCount === 1 ? "" : "s"}
            </span>
          </span>
        </button>

        {mode === "confirming" ? (
          <span className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => {
                setMode("idle");
                onDelete();
              }}
              className="rounded-card px-1.5 py-1 font-ui text-[11px] font-semibold text-danger transition hover:opacity-80 focus-visible:outline-2 focus-visible:outline-accent"
            >
              Delete folder?
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
          // Always laid out on touch (there is no hover to reveal them); hidden
          // outright — not merely transparent — until hover/focus on a pointer
          // device, so the cluster never squeezes the name it sits beside.
          <span className="flex shrink-0 items-center gap-0.5 md:hidden md:group-focus-within:flex md:group-hover:flex">
            <MoveSelect
              label={`Move ${folder.name} into another folder`}
              value={folder.parentId}
              rootLabel="Notes"
              options={destinations}
              disabled={busy}
              onChange={onMove}
            />
            <RowAction label={`New folder inside ${folder.name}`} onClick={onStartCreate} disabled={busy}>
              + Folder
            </RowAction>
            <RowAction label={`Rename ${folder.name}`} onClick={() => setMode("renaming")} disabled={busy}>
              Rename
            </RowAction>
            <RowAction label={`Delete ${folder.name}`} onClick={() => setMode("confirming")} disabled={busy}>
              Delete
            </RowAction>
          </span>
        )}
      </div>

      {creatingHere && (
        <NameInput
          label={`New folder inside ${folder.name}`}
          initial=""
          confirmLabel="Create"
          depth={depth + 1}
          onCancel={onCancelCreate}
          onSubmit={onCreate}
        />
      )}
    </>
  );
}

/**
 * One note row: a small `tint-note` glyph (design.md's kind-tint move, extended
 * to notes wherever they're represented outside the editor — the editor's own
 * sheet is document content and keeps its fixed paper tone), title, page count +
 * relative date. Hover/focus is the row's "active" state — a 2px accent rule on
 * `paper-raised`, matching the reader's contents list (`TocSidebar`) rather than
 * a media tile's hover-lift.
 */
function NoteRow({
  note,
  depth,
  busy,
  options,
  onOpen,
  onMove,
  onDelete,
}: {
  note: NoteSummary;
  depth: number;
  busy: boolean;
  options: FolderOption[];
  onOpen: () => void;
  onMove: (folderId: string | null) => void;
  onDelete: () => void;
}) {
  return (
    <div className="group relative flex items-center gap-3 border-l-2 border-l-transparent py-2.5 pr-3 transition-colors focus-within:border-l-accent focus-within:bg-paper-raised hover:border-l-accent hover:bg-paper-raised">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${note.title}`}
        style={indentFor(depth)}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-card text-left focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span
          aria-hidden
          className="grid h-9 w-9 shrink-0 place-items-center rounded-cover bg-tint-note text-ink-variant"
        >
          <NoteGlyph />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-ui text-sm font-semibold text-ink">{note.title}</span>
          <span className="font-ui text-xs text-ink-variant">
            <span className="tabular-nums">{note.pageCount}</span> page
            {note.pageCount === 1 ? "" : "s"} · {formatRelative(note.updatedAt)}
          </span>
        </span>
      </button>

      <span className="flex shrink-0 items-center gap-0.5 md:hidden md:group-focus-within:flex md:group-hover:flex">
        <MoveSelect
          label={`File ${note.title} in a folder`}
          value={note.folderId}
          rootLabel="Notes"
          options={options}
          disabled={busy}
          onChange={onMove}
        />
        <RowAction label={`Delete ${note.title}`} onClick={onDelete} danger>
          Delete
        </RowAction>
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Shared row parts
 * ---------------------------------------------------------------------- */

/** Depth indent, matching `LatexFileTree`'s 12px + 14px-per-level rhythm. */
function indentFor(depth: number): { paddingLeft: string } {
  return { paddingLeft: `${12 + depth * 14}px` };
}

function RowAction({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-card px-1.5 py-1 font-ui text-[11px] transition disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent ${
        danger ? "text-ink-variant hover:text-danger" : "text-ink-variant hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * The "move to…" picker — a native `<select>` wearing `QuietSelect`'s control
 * styling but with a visually hidden label instead of a printed one: on a row
 * that already says what it is, a second "MOVE TO" caption would be noise. The
 * element stays native so keyboard, screen-reader and mobile picker behaviour
 * all come for free.
 *
 * The root is the empty-string option, because `<option value>` is a string and
 * `null` has no representation there; it is mapped back on the way out.
 */
function MoveSelect({
  label,
  value,
  rootLabel,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string | null;
  rootLabel: string;
  options: FolderOption[];
  disabled?: boolean;
  onChange: (folderId: string | null) => void;
}) {
  return (
    <span className="relative inline-flex items-center">
      <select
        aria-label={label}
        title={label}
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
        className="quiet-select max-w-[9rem] appearance-none border-b border-line-soft bg-transparent py-1 pr-5 pl-1 font-ui text-[11px] font-medium text-ink-variant transition outline-none hover:border-line hover:text-ink disabled:opacity-40 focus:border-b-2 focus:border-accent"
      >
        <option value="">{rootLabel}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-0.5 h-3 w-3 text-ink-variant" />
    </span>
  );
}

/**
 * The one inline text input the tree uses, for both "new folder" and "rename" —
 * no modal and no `window.prompt`, which the design system has no say over.
 * Modelled on `LatexFileTree`'s `PathInput`.
 */
function NameInput({
  label,
  initial,
  confirmLabel,
  depth = 0,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial: string;
  confirmLabel: string;
  depth?: number;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const trimmed = value.trim();
  const valid = trimmed.length > 0 && trimmed.length <= 120;

  return (
    <form
      className="flex items-center gap-1.5 py-2 pr-3"
      style={indentFor(depth)}
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onSubmit(trimmed);
      }}
    >
      <input
        ref={ref}
        value={value}
        aria-label={label}
        placeholder="Folder name"
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

/* -------------------------------------------------------------------------
 * Collapsed-folder memory
 * ---------------------------------------------------------------------- */

/** Per-profile, because the tree is per-profile — see `use-notes.ts`'s keys. */
const collapsedKey = (profileId: string | null) => `atrium.notes.collapsed.${profileId ?? "none"}`;

function readCollapsed(profileId: string | null): ReadonlySet<string> {
  try {
    const raw = window.localStorage.getItem(collapsedKey(profileId));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
  } catch {
    // Private mode, blocked site data, or a corrupt value: an empty set means
    // every folder is drawn open, which is the correct default anyway.
    return new Set();
  }
}

/**
 * Which folders the viewer has collapsed, remembered per profile in
 * `localStorage`.
 *
 * Stores only the folders deliberately CLOSED, so a folder that appears later
 * is never hidden behind a stale flag — the same choice `LatexFileTree` makes,
 * kept durable here because a notes tree is navigated across sessions rather
 * than within one editor sitting.
 *
 * `localStorage` and not the server on purpose (brief 50 rule 7): which
 * branches one person has folded shut on one device is a per-viewer
 * convenience, not shared state, and it must never be something a failed write
 * can break the page over — hence the try/catch on both sides.
 */
function useCollapsedFolders(
  profileId: string | null,
): [ReadonlySet<string>, (id: string) => void] {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  // Re-read on a profile switch: the previous profile's folded branches say
  // nothing about this one's tree, and their ids do not even exist in it.
  useEffect(() => {
    setCollapsed(readCollapsed(profileId));
  }, [profileId]);

  const toggle = useCallback(
    (id: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        try {
          window.localStorage.setItem(collapsedKey(profileId), JSON.stringify([...next]));
        } catch {
          // Nothing to do and nothing to say: the fold still applies for this
          // session, it just will not be remembered.
        }
        return next;
      });
    },
    [profileId],
  );

  return [collapsed, toggle];
}

/* -------------------------------------------------------------------------
 * Glyphs + formatting
 * ---------------------------------------------------------------------- */

/** Quiet notebook glyph for the row's `tint-note` swatch — 1.75 stroke, inline SVG. */
function NoteGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="h-4.5 w-4.5" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 3.5h9.5L19 7v13.5H6z" />
      <path strokeLinecap="round" d="M9.5 10h6M9.5 13.5h6M9.5 17h4" />
    </svg>
  );
}

/** Folder glyph — same 1.75 stroke, on the neutral container swatch. */
function FolderGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="h-4.5 w-4.5" aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.5 6.5h6l2 2.5h9v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z"
      />
    </svg>
  );
}

/** Disclosure chevron. Rotates rather than swaps, and holds still under
 *  `prefers-reduced-motion` (design.md: motion always has a degraded path). */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      aria-hidden
      className={`h-3.5 w-3.5 shrink-0 text-ink-variant transition-transform duration-200 ease-paper motion-reduce:transition-none ${
        open ? "rotate-90" : ""
      }`}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
    </svg>
  );
}

function ChevronDown({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className={className} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
    </svg>
  );
}

/** Relative date for the list row (design.md wants "relative date", not an absolute
 * one) — falls back to an absolute short date past a week, where "N weeks ago"
 * stops being useful context. */
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  const minutes = seconds / 60;
  const hours = minutes / 60;
  const days = hours / 24;

  if (seconds < 60) return "Just now";
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  if (days < 7) return `${Math.floor(days)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-card border border-line-soft/50 bg-paper-low/40 px-6 py-16 text-center">
      <p className="font-display text-xl font-semibold text-ink">{title}</p>
      <p className="max-w-md text-ink-variant">{body}</p>
      {action}
    </div>
  );
}
