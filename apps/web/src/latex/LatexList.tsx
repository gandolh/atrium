import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { LatexProject } from "@ebook-reader/shared";

import { useApplyTheme } from "../reader/chrome/use-apply-theme";
import { AppHeader } from "../components/AppHeader";
import { BUTTON_SOLID } from "../components/button-styles";
import { PAGE_FRAME, PAGE_TITLE } from "../components/page-frame";
import { PlusIcon } from "../components/places";
import { useCreateLatexProject, useDeleteLatexProject, useLatexProjects } from "./use-latex";

/**
 * `/latex` list — the per-profile LaTeX project index.
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

  // New project: the band's solid button at 1280, a full-width 48 px button under the title on a phone.
  const newProjectButton = (extra: string) => (
    <button type="button" onClick={newProject} disabled={create.isPending} className={`${BUTTON_SOLID} ${extra}`}>
      <PlusIcon />
      {create.isPending ? "Creating…" : "New project"}
    </button>
  );

  return (
    <main className={`${PAGE_FRAME} gap-6 text-ink`}>
      <AppHeader actions={newProjectButton("")} />

      <section aria-label="LaTeX projects" className="flex flex-col gap-5">
        <h1 className={PAGE_TITLE}>LaTeX</h1>
        <div className="min-[821px]:hidden">{newProjectButton("h-12 w-full")}</div>

        {isLoading ? (
          <div
            className="flex max-w-180 flex-col divide-y divide-line overflow-hidden rounded-tile border border-line bg-paper-raised shadow-l1"
            aria-hidden
          >
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3">
                <div className="h-9 w-9 shrink-0 rounded-cover bg-paper-container motion-safe:animate-pulse" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <div className="h-3.5 w-1/3 rounded-card bg-paper-container motion-safe:animate-pulse" />
                  <div className="h-3 w-1/4 rounded-card bg-paper-container motion-safe:animate-pulse" />
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
                onClick={() => void refetch()}
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
          <div className="flex max-w-180 flex-col divide-y divide-line overflow-hidden rounded-tile border border-line bg-paper-raised shadow-l1">
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
    <div className="group relative flex min-h-17 items-center gap-3 px-4 py-3 transition-colors focus-within:bg-paper-low hover:bg-paper-low">
      <span
        aria-hidden
        className="grid h-10 w-10 shrink-0 place-items-center rounded-cover border border-line bg-paper-container text-ink-variant"
      >
        <ProjectGlyph />
      </span>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${project.title}`}
        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-card text-left focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span className="font-ui text-body font-semibold wrap-anywhere text-ink">{project.title}</span>
        <span className="flex flex-wrap gap-x-3 font-ui text-ui font-normal text-ink-variant">
          <span>{compileStatusLabel(project.compileStatus)}</span>
          <span>{formatRelative(project.updatedAt)}</span>
        </span>
      </button>
      <button
        type="button"
        aria-label={`Delete ${project.title}`}
        onClick={onDelete}
        className="h-11 rounded-card px-3 font-ui text-ui font-medium text-ink-variant transition hover:text-danger focus-visible:text-danger focus-visible:outline-2 focus-visible:outline-accent"
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
