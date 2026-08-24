import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

/**
 * Reading Room frame shared by the audio and video players (brief 23). Mirrors
 * the readers' "orientation lives at the edges" language (wiki/reader.md) — a
 * quiet running header with the title — but, unlike the decorative
 * `ReaderHeader`, it owns the one interactive affordance the players need: a
 * back-to-library link (the players cover the app shell's nav, like the
 * readers). No custom scrubber; the media element's native controls sit inside.
 *
 * Tokens/type only (design.md): paper surface via `--reader-*` (light theme is
 * tuned to Reading Room), Newsreader for the title, Archivo for the UI label, accent
 * used sparingly (the back link's hover/focus only).
 */
export function MediaFrame({
  title,
  subtitle,
  children,
}: {
  title: string;
  /** Secondary line — artist for audio, or blank. */
  subtitle?: string | null;
  children: ReactNode;
}) {
  return (
    // Height stops short of the player dock (`--dock-height`, published by the
    // shell): a bare `min-h-screen` inside the shell's dock-sized bottom padding
    // makes the page taller than the viewport by exactly the dock.
    <div className="flex min-h-[calc(100vh-var(--dock-height,0px))] flex-col bg-reader-bg text-reader-fg">
      <header className="flex items-center gap-4 border-b border-reader-border/60 px-5 py-3">
        <Link
          to="/"
          aria-label="Back to your library"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-sm px-2 py-1 text-sm font-medium text-reader-fg/70 transition-colors hover:text-reader-accent focus-visible:text-reader-accent focus-visible:outline-none"
        >
          <BackIcon />
          <span className="hidden sm:inline">Library</span>
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-lg leading-tight font-semibold text-reader-fg">
            {title}
          </h1>
          {subtitle ? (
            <p className="truncate text-sm text-reader-fg/60">{subtitle}</p>
          ) : null}
        </div>
      </header>
      <main className="flex flex-1 flex-col items-center justify-center px-5 py-8">
        {children}
      </main>
    </div>
  );
}

function BackIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M15 5l-7 7 7 7"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
