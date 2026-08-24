import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { NoteSummary } from "@ebook-reader/shared";

import { useApplyTheme } from "../reader/chrome/use-apply-theme";
import { AppHeader } from "../components/AppHeader";
import { useCreateNote, useDeleteNote, useNotesList } from "./use-notes";

/**
 * `/notes` list (brief 26; restyled onto Reading Room in brief 33) — the
 * per-user notes index. Notes is not a media chip (D33g: a notebook is
 * *authored*, not *collected*), so unlike the library's tinted tile grid this
 * renders as a single left-aligned column of rows — title, page count,
 * relative date — closer to the reader's contents list than to a cover shelf.
 * "New note" creates one and opens the editor. Shares the app shell
 * (`AppHeader`) so the nav + theme control stay put.
 */
export function NotesList() {
  useApplyTheme();
  const navigate = useNavigate();
  const { data: notes, isLoading, isError, refetch } = useNotesList();
  const create = useCreateNote();
  const remove = useDeleteNote();

  function openNote(id: string) {
    void navigate({ to: "/notes", search: { note: id } });
  }

  function newNote() {
    create.mutate(undefined, { onSuccess: (note) => openNote(note.id) });
  }

  return (
    <main className="mx-auto flex min-h-[calc(100vh-var(--dock-height,0px))] max-w-6xl flex-col gap-8 px-5 py-8 text-ink md:px-16">
      <AppHeader
        actions={
          <button
            type="button"
            onClick={newNote}
            disabled={create.isPending}
            className="rounded bg-ink-fill px-4 py-2 font-ui text-sm font-semibold text-on-ink-fill transition hover:opacity-90 disabled:opacity-50"
          >
            {create.isPending ? "Creating…" : "+ New note"}
          </button>
        }
      />

      <section aria-label="Notes" className="flex flex-col gap-5">
        <h2 className="font-display text-3xl font-semibold text-ink">Notes</h2>

        {isLoading ? (
          <div className="flex max-w-2xl flex-col divide-y divide-line-soft/60 rounded-card border border-line-soft/70" aria-hidden>
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
        ) : !notes || notes.length === 0 ? (
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
            {notes.map((note) => (
              <NoteRow key={note.id} note={note} onOpen={() => openNote(note.id)} onDelete={() => remove.mutate(note)} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

/**
 * One row in the notes index: a small `tint-note` glyph (design.md's kind-tint
 * move, extended to notes wherever they're represented outside the editor —
 * the editor's own sheet is document content and keeps its fixed paper tone),
 * title, page count + relative date. Hover/focus is the row's "active" state —
 * a 2px accent rule on `paper-raised`, matching the reader's contents list
 * (`TocSidebar`) rather than a media tile's hover-lift.
 */
function NoteRow({ note, onOpen, onDelete }: { note: NoteSummary; onOpen: () => void; onDelete: () => void }) {
  return (
    <div className="group relative flex items-center gap-3 border-l-2 border-l-transparent px-3.5 py-2.5 transition-colors hover:border-l-accent hover:bg-paper-raised focus-within:border-l-accent focus-within:bg-paper-raised">
      <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-cover bg-tint-note text-ink-variant">
        <NoteGlyph />
      </span>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${note.title}`}
        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-card text-left focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span className="truncate font-ui text-sm font-semibold text-ink">{note.title}</span>
        <span className="font-ui text-xs text-ink-variant">
          <span className="tabular-nums">{note.pageCount}</span> page{note.pageCount === 1 ? "" : "s"} ·{" "}
          {formatRelative(note.updatedAt)}
        </span>
      </button>
      <button
        type="button"
        aria-label={`Delete ${note.title}`}
        onClick={onDelete}
        className="rounded-card px-1.5 py-1 text-xs text-ink-variant opacity-0 transition hover:text-danger group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent max-md:opacity-100"
      >
        Delete
      </button>
    </div>
  );
}

/** Quiet notebook glyph for the row's `tint-note` swatch — 1.75 stroke, inline SVG. */
function NoteGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="h-4.5 w-4.5" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 3.5h9.5L19 7v13.5H6z" />
      <path strokeLinecap="round" d="M9.5 10h6M9.5 13.5h6M9.5 17h4" />
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
