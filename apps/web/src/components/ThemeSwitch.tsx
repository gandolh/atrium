import type { ReactNode } from "react";

import { useResolvedTheme } from "../reader/chrome/use-apply-theme";
import type { Theme } from "../store/reader-store";
import { useReaderStore } from "../store/reader-store";
import { cn } from "../lib/cn";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/Popover";
import { ToggleGroup, ToggleItem } from "./ui/ToggleGroup";

const THEMES: { value: Theme; label: string; name: string; glyph: ReactNode }[] = [
  { value: "light", label: "Light theme", name: "Light", glyph: <SunGlyph /> },
  { value: "sepia", label: "Warm theme", name: "Warm", glyph: <ContrastGlyph /> },
  { value: "dark", label: "Dark theme", name: "Dark", glyph: <MoonGlyph /> },
  { value: "system", label: "System theme", name: "System", glyph: <SystemGlyph /> },
];

/**
 * Segmented light/sepia/dark/system control (a sun, a half disc, a moon, and a screen for System, which follows the
 * operating system). It drives the shared reader `theme` store so the library, the catalog and the readers stay in
 * sync. The choice is saved to the profile on the server, so this is a guarded `ToggleGroup` (base-ui rule 16): the
 * arrow keys only move focus, and Space, Enter or a click chooses. At 1280 it sits at the rail's foot; on a phone
 * it sits in `ThemePopover`.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useReaderStore((s) => s.theme);
  const setTheme = useReaderStore((s) => s.setTheme);

  return (
    <ToggleGroup
      label="Theme"
      value={theme}
      onValueChange={setTheme}
      className={cn("grid grid-cols-4 gap-0.5 rounded-card border border-line bg-paper-low p-1", className)}
    >
      {THEMES.map((t) => (
        <ToggleItem
          key={t.value}
          value={t.value}
          aria-label={t.label}
          title={t.label}
          className="grid h-9 place-items-center rounded-cover text-ink-variant transition hover:not-data-pressed:text-ink focus-visible:outline-2 focus-visible:outline-accent data-pressed:bg-paper-raised data-pressed:text-accent data-pressed:shadow-l1 data-pressed:ring-1 data-pressed:ring-line"
        >
          {t.glyph}
        </ToggleItem>
      ))}
    </ToggleGroup>
  );
}

/**
 * The phone's way to the same group: a button in the top bar that shows the chosen theme's icon and is named
 * `Theme: <the choice>`, opening a popover that holds the guarded group. The group and its guard don't change.
 */
export function ThemePopover() {
  const theme = useReaderStore((s) => s.theme);
  const resolved = useResolvedTheme();
  const chosen = THEMES.find((t) => t.value === theme) ?? THEMES[0];
  // System shows the icon of the theme it resolves to, so the button reads as what is on screen.
  const shown = THEMES.find((t) => t.value === (theme === "system" ? resolved : theme)) ?? chosen;

  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Theme: ${chosen.name}`}
        className="grid h-11 w-11 place-items-center rounded-card border border-outline bg-paper-raised text-accent focus-visible:outline-2 focus-visible:outline-accent active:bg-paper-low"
      >
        {shown.glyph}
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        aria-label="Theme"
        className="w-64 rounded-card border border-line bg-paper-raised p-2 shadow-float"
      >
        <ThemeToggle />
      </PopoverPopup>
    </Popover>
  );
}

const ICON = "h-[18px] w-[18px]";

function SunGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className={ICON} aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path
        strokeLinecap="round"
        d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"
      />
    </svg>
  );
}

// Neutral "warm tone" glyph for the sepia theme: a half-filled contrast disc (a tonal mark, not a book motif).
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

// A screen: the choice that follows the operating system.
function SystemGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className={ICON} aria-hidden>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path strokeLinecap="round" d="M8 20h8M12 16v4" />
    </svg>
  );
}
