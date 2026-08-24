import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import type { Theme } from "../store/reader-store";
import { useReaderStore } from "../store/reader-store";

/**
 * The persistent app header, shared by every non-reader page (`/`, `/discover`,
 * `/notes`) so the wordmark, search, Notes and the theme control never
 * disappear when the page changes.
 *
 * **Brief 28 (D33 move 1) removed `NavTabs`.** Media kind is no longer an
 * address — `/books` `/music` `/videos` collapsed into `/` where kind is a
 * filter chip (see `library/LibraryHeader`'s `KindChips`), so the header carries
 * no per-kind navigation at all. What remains is app-level only, in **two
 * clusters on one row**:
 *
 *   wordmark · [search slot] ‖ Notes · {actions} · theme
 *
 * Notes stays its own destination (D33g) — it is a peer place, not a kind, so it
 * is a link here rather than a chip in the grid.
 */
export function AppHeader({
  caption,
  search,
  actions,
}: {
  /** Optional quiet caption under the wordmark (the home's storage usage). */
  caption?: ReactNode;
  /**
   * SEARCH SLOT — **brief 30 fills this**. Rendered between the two clusters in
   * a `flex-1` box that is `min-w-0` and caps at `sm:max-w-sm`, so whatever goes
   * in can be a full-width input on a phone and a compact field on a desktop.
   * Left empty the box collapses (no reserved gap), so every current caller
   * renders exactly as before.
   */
  search?: ReactNode;
  /** Page-level actions, rendered between the Notes link and the theme toggle. */
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-line-soft/50 pb-4">
      <div className="flex flex-col gap-1">
        <Link
          to="/"
          className="w-fit rounded font-display text-2xl font-semibold tracking-tight text-accent focus-visible:outline-2 focus-visible:outline-accent"
        >
          Atrium
        </Link>
        {caption}
      </div>

      {/* ── SEARCH SLOT (brief 30) ─────────────────────────────────────────── */}
      {search && <div className="min-w-0 flex-1 sm:max-w-sm">{search}</div>}

      <div className="ml-auto flex flex-wrap items-center gap-3">
        <NotesLink />
        {actions}
        <ThemeToggle />
      </div>
    </header>
  );
}

/**
 * The one navigational link left in the header: **Notes** as its own
 * destination (D33g), reached from here rather than from a filter chip.
 *
 * Brief 33 owns its **active state** — accent, not ink, since accent "means
 * state only" (design.md) and being on `/notes` is exactly that: a state, not
 * decoration. The base style is a quiet Archivo `label-ui` link. Kept as a
 * separate component (rather than inlined) so brief 33 has one place to edit.
 */
function NotesLink() {
  return (
    <Link
      to="/notes"
      className="rounded px-1 py-2 font-ui text-sm font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
      activeProps={{ className: "text-accent font-semibold" }}
    >
      Notes
    </Link>
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
