import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import type { Theme } from "../store/reader-store";
import { useReaderStore } from "../store/reader-store";

/**
 * The persistent app header, shared by every non-reader page (`/`, `/discover`)
 * so navigation and the theme control never disappear when the page changes
 * (previously /discover dropped the shell entirely — no brand, no theme
 * toggle). Wordmark in Newsreader on the left (a link home), page-supplied
 * `actions` + the segmented light/sepia/dark toggle on the right.
 *
 * Content-scoped controls (the All/Books/Music/Videos filter, Shelves⇄Stacks)
 * deliberately do NOT live here anymore — they scope the library shelf, so
 * they sit next to it (see routes/home.tsx), leaving the header with app-level
 * concerns only. That also fixes the mobile wrap: two clusters instead of five.
 */
export function AppHeader({
  caption,
  actions,
}: {
  /** Optional quiet caption under the wordmark (home's storage usage). */
  caption?: ReactNode;
  /** Page-level actions, rendered before the theme toggle. */
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 border-b border-line-soft/50 pb-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex flex-col gap-1">
          <Link
            to="/books"
            className="w-fit rounded font-display text-2xl font-bold tracking-tight text-accent focus-visible:outline-2 focus-visible:outline-accent"
          >
            Atrium
          </Link>
          {caption}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {actions}
          <ThemeToggle />
        </div>
      </div>

      <NavTabs />
    </header>
  );
}

const NAV_TABS = [
  { to: "/books", label: "Books" },
  { to: "/music", label: "Music" },
  { to: "/videos", label: "Videos" },
  { to: "/notes", label: "Notes" },
] as const;

/**
 * Primary area navigation (Atrium IA, brief 25) — Books · Music · Videos as
 * peer destinations. The old in-header All/Books/Music/Videos *filter* is now
 * these tabs. Quiet: Archivo label, accent reserved for the active tab's text +
 * underline; horizontally scrollable if it ever overflows on a narrow phone.
 */
function NavTabs() {
  return (
    <nav aria-label="Library" className="-mb-4 flex items-center gap-1 overflow-x-auto">
      {NAV_TABS.map((tab) => (
        <Link
          key={tab.to}
          to={tab.to}
          className="rounded-t border-b-2 border-transparent px-3 py-2 font-ui text-sm font-medium whitespace-nowrap text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
          activeProps={{ className: "border-accent text-ink font-semibold" }}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

const THEMES: { value: Theme; label: string; glyph: ReactNode }[] = [
  { value: "light", label: "Light theme", glyph: <SunGlyph /> },
  { value: "sepia", label: "Warm theme", glyph: <ContrastGlyph /> },
  { value: "dark", label: "Dark theme", glyph: <MoonGlyph /> },
];

/**
 * Segmented light/sepia/dark control (design.md mockup's sun/book/moon).
 * Drives the shared reader `theme` store so the library, catalog, and readers
 * stay in sync.
 */
function ThemeToggle() {
  const theme = useReaderStore((s) => s.theme);
  const setTheme = useReaderStore((s) => s.setTheme);

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="flex items-center gap-0.5 rounded-full border border-line-soft/60 bg-paper-low p-0.5"
    >
      {THEMES.map((t) => {
        const active = theme === t.value;
        return (
          <button
            key={t.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={t.label}
            title={t.label}
            onClick={() => setTheme(t.value)}
            className={`grid h-9 w-11 place-items-center rounded-full transition ${
              active ? "bg-paper-raised text-accent shadow-sm" : "text-ink-variant hover:text-ink"
            }`}
          >
            {t.glyph}
          </button>
        );
      })}
    </div>
  );
}

const ICON = "h-4 w-4";

function SunGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className={ICON} aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path strokeLinecap="round" d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

// Neutral "warm tone" glyph for the sepia theme — a half-filled contrast disc
// (a tonal mark, not the old book motif) so the theme control carries no
// book-specific metaphor in the media gallery.
function ContrastGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className={ICON} aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 0 0 18Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function MoonGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className={ICON} aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" />
    </svg>
  );
}
