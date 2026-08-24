import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { NoteSummary } from "@ebook-reader/shared";

import { useApplyTheme } from "../reader/chrome/use-apply-theme";
import { AppHeader } from "../components/AppHeader";
import { useCreateNote, useDeleteNote, useNotesList } from "./use-notes";

/**
 * `/notes` list (brief 26) — the per-user notes gallery. Quiet cards (title +
 * updated date + page count); "New note" creates one and opens the editor.
 * Shares the app shell (`AppHeader`) so the nav + theme control stay put.
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
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-8 px-5 py-8 text-ink md:px-16">
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
          <div className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3 lg:grid-cols-4" aria-hidden>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="aspect-[4/3] w-full animate-pulse rounded-md bg-paper-container" />
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
                className="rounded border border-line-soft px-4 py-1.5 text-sm font-medium text-ink-variant transition hover:text-ink"
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
                className="rounded border border-line-soft px-4 py-1.5 font-ui text-sm font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
              >
                New note
              </button>
            }
          />
        ) : (
          <div className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
            {notes.map((note) => (
              <NoteCard key={note.id} note={note} onOpen={() => openNote(note.id)} onDelete={() => remove.mutate(note)} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function NoteCard({ note, onOpen, onDelete }: { note: NoteSummary; onOpen: () => void; onDelete: () => void }) {
  return (
    <div className="group flex flex-col gap-2">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${note.title}`}
        className="relative flex aspect-[4/3] w-full flex-col justify-end overflow-hidden rounded-md bg-note-sheet p-4 text-left shadow-[0_4px_16px_-6px_rgba(0,0,0,0.2)] ring-1 ring-line-soft/40 transition duration-200 group-hover:-translate-y-1 group-hover:shadow-[0_12px_22px_-8px_rgba(0,0,0,0.3)] focus-visible:outline-2 focus-visible:outline-accent"
      >
        {/* Faint ruling so an empty note still reads as a page. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              "repeating-linear-gradient(var(--note-sheet-rule) 0 1px, transparent 1px 22px)",
            backgroundPositionY: "12px",
          }}
        />
        <span className="relative font-display text-lg leading-snug font-semibold text-note-sheet-ink line-clamp-2">
          {note.title}
        </span>
      </button>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs text-ink-variant">
          {note.pageCount} page{note.pageCount === 1 ? "" : "s"} · {formatDate(note.updatedAt)}
        </p>
        <button
          type="button"
          aria-label={`Delete ${note.title}`}
          onClick={onDelete}
          className="rounded px-1 text-xs text-ink-variant opacity-0 transition hover:text-danger group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent max-md:opacity-100"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-line-soft/50 bg-paper-low/40 px-6 py-16 text-center">
      <p className="font-display text-xl font-semibold text-ink">{title}</p>
      <p className="max-w-md text-ink-variant">{body}</p>
      {action}
    </div>
  );
}
