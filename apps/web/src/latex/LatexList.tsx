import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { LatexProject } from "@ebook-reader/shared";

import { useApplyTheme } from "../reader/chrome/use-apply-theme";
import { AppHeader } from "../components/AppHeader";
import { useCreateLatexProject, useDeleteLatexProject, useLatexProjects } from "./use-latex";

/**
 * `/latex` list (brief 38 chunk 7) — the per-profile LaTeX project index.
 * Modelled directly on `notes/NotesList.tsx`: LaTeX is a destination sibling
 * to Notes (D33g generalised by D36 to every authored thing), not a media
 * chip and not a card in the gallery grid, so this renders the same single
 * left-aligned column of rows rather than a tinted tile shelf.
 *
 * "New project" creates one — the server seeds it with a hello-world
 * `main.tex` — and opens it in the editor.
 */
export function LatexList() {
  useApplyTheme();
  const navigate = useNavigate();
  const { data: projects, isLoading, isError, refetch } = useLatexProjects();
  const create = useCreateLatexProject();
  const remove = useDeleteLatexProject();

  function openProject(id: string) {
    void navigate({ to: "/latex", search: { project: id } });
  }

  function newProject() {
    create.mutate("Untitled project", { onSuccess: (project) => openProject(project.id) });
  }

  return (
    <main className="mx-auto flex min-h-[calc(100vh-var(--dock-height,0px))] max-w-6xl flex-col gap-8 px-5 py-8 text-ink md:px-16">
      <AppHeader
        actions={
          <button
            type="button"
            onClick={newProject}
            disabled={create.isPending}
            className="rounded bg-ink-fill px-4 py-2 font-ui text-sm font-semibold text-on-ink-fill transition hover:opacity-90 disabled:opacity-50"
          >
            {create.isPending ? "Creating…" : "+ New project"}
          </button>
        }
      />

      <section aria-label="LaTeX projects" className="flex flex-col gap-5">
        <h2 className="font-display text-3xl font-semibold text-ink">LaTeX</h2>

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
            title="Couldn't load your projects"
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
        ) : !projects || projects.length === 0 ? (
          <EmptyState
            title="No LaTeX projects yet"
            body="Create your first project to start writing — a draft that lives only here until you publish it."
            action={
              <button
                type="button"
                onClick={newProject}
                className="rounded-card border border-line-soft px-4 py-1.5 font-ui text-sm font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
              >
                New project
              </button>
            }
          />
        ) : (
          <div className="flex max-w-2xl flex-col divide-y divide-line-soft/60 rounded-card border border-line-soft/70">
            {projects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                onOpen={() => openProject(project.id)}
                onDelete={() => remove.mutate(project)}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

/**
 * One row in the LaTeX index: a neutral document glyph (no kind tint — LaTeX
 * projects are a draft, not a media kind with a tint slot in design.md's
 * fixed four; `bg-paper-container` is the system's own neutral-well token,
 * not a fabricated colour), title, compile status + relative updated date.
 * Same hover/focus "active state" rule as `NoteRow`: a 2px accent rule on
 * `paper-raised`.
 */
function ProjectRow({
  project,
  onOpen,
  onDelete,
}: {
  project: LatexProject;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group relative flex items-center gap-3 border-l-2 border-l-transparent px-3.5 py-2.5 transition-colors hover:border-l-accent hover:bg-paper-raised focus-within:border-l-accent focus-within:bg-paper-raised">
      <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-cover bg-paper-container text-ink-variant">
        <ProjectGlyph />
      </span>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${project.title}`}
        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-card text-left focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span className="truncate font-ui text-sm font-semibold text-ink">{project.title}</span>
        <span className="font-ui text-xs text-ink-variant">
          {compileStatusLabel(project.compileStatus)} · {formatRelative(project.updatedAt)}
        </span>
      </button>
      <button
        type="button"
        aria-label={`Delete ${project.title}`}
        onClick={onDelete}
        className="rounded-card px-1.5 py-1 text-xs text-ink-variant opacity-0 transition hover:text-danger group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent max-md:opacity-100"
      >
        Delete
      </button>
    </div>
  );
}

function compileStatusLabel(status: LatexProject["compileStatus"]): string {
  switch (status) {
    case "none":
      return "Not compiled";
    case "running":
      return "Compiling…";
    case "ready":
      return "Compiled";
    case "failed":
      return "Compile failed";
  }
}

/** Quiet document glyph for the row's neutral swatch — 1.75 stroke, inline SVG. */
function ProjectGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="h-4.5 w-4.5" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 3.5h9.5L19 7v13.5H6z" />
      <path strokeLinecap="round" d="M9.5 10.5h6M9.5 14h4.5M9.5 17.5h6" />
    </svg>
  );
}

/** Relative date for the list row (design.md wants "relative date", not an absolute
 * one) — falls back to an absolute short date past a week, where "N weeks ago"
 * stops being useful context. Identical to `notes/NotesList.tsx`'s `formatRelative`. */
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
