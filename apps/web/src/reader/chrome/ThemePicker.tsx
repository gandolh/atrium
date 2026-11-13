import { ToggleGroup, ToggleItem } from "../../components/ui/ToggleGroup";
import { useReaderStore, type Theme } from "../../store/reader-store";

/**
 * Theme swatches, drawn from the `--theme-<name>-*` constants in globals.css so
 * each swatch is a truthful miniature of the page it produces. Those constants
 * are deliberately NOT remapped by `data-theme` — a picker has to paint all
 * three grounds at once, whichever one is currently active, which is exactly
 * why they exist separately from the `--reader-*` layer they feed.
 */
const THEMES: { value: Exclude<Theme, "system">; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "sepia", label: "Sepia" },
  { value: "dark", label: "Dark" },
];

/** Every swatch is a miniature page; this is the one shape. */
const SWATCH =
  "grid h-11 w-full place-items-center overflow-hidden rounded-cover border text-base transition-shadow group-data-pressed:ring-2 group-data-pressed:ring-reader-accent";

/**
 * Shared light/sepia/dark/system theme picker (wiki/reader.md), drawn as miniature
 * pages — an "Aa" set on each theme's actual paper — the pattern a
 * Kindle/Books hand already knows. System is the page cut in two, light and dark, because it follows the
 * operating system. Writes to Zustand's `theme`; `useApplyTheme` reflects it onto `data-theme`.
 *
 * The choice is saved to the profile on the server, so this is a guarded `ToggleGroup` (base-ui rule 16): the
 * arrow keys only move focus, and Space, Enter or a click chooses.
 *
 * Both readers render this in their settings surface. For EPUB the theme fully
 * re-colors the reflowed text; for PDF only the chrome themes and "dark" maps
 * to the invert hack — but the control itself is shared.
 */
export function ThemePicker() {
  const theme = useReaderStore((s) => s.theme);
  const setTheme = useReaderStore((s) => s.setTheme);

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-reader-fg/70">Theme</span>
      <ToggleGroup label="Theme" value={theme} onValueChange={setTheme} className="flex gap-2">
        {THEMES.map((t) => (
          <PickerItem key={t.value} value={t.value} label={t.label}>
            <span
              aria-hidden="true"
              // A theme swatch is a miniature PAGE (design.md "Aa panel"), so
              // it takes the artwork radius (2px), not the general card
              // radius (4px) — the same distinction the library covers draw.
              className={SWATCH}
              style={{
                backgroundColor: `var(--theme-${t.value}-bg)`,
                color: `var(--theme-${t.value}-fg)`,
                borderColor: `var(--theme-${t.value}-border)`,
                fontFamily: "var(--font-reading)",
              }}
            >
              Aa
            </span>
          </PickerItem>
        ))}
        <PickerItem value="system" label="System">
          <span
            aria-hidden="true"
            className={`${SWATCH} grid-cols-2`}
            style={{ borderColor: "var(--theme-light-border)", fontFamily: "var(--font-reading)" }}
          >
            <span
              className="grid size-full place-items-center"
              style={{ backgroundColor: "var(--theme-light-bg)", color: "var(--theme-light-fg)" }}
            >
              A
            </span>
            <span
              className="grid size-full place-items-center"
              style={{ backgroundColor: "var(--theme-dark-bg)", color: "var(--theme-dark-fg)" }}
            >
              a
            </span>
          </span>
        </PickerItem>
      </ToggleGroup>
    </div>
  );
}

function PickerItem({ value, label, children }: { value: Theme; label: string; children: React.ReactNode }) {
  return (
    <ToggleItem
      value={value}
      aria-label={label}
      className="group flex flex-1 flex-col items-center gap-1 rounded-card outline-none focus-visible:ring-2 focus-visible:ring-reader-accent"
    >
      {children}
      <span className="text-micro text-reader-fg/60 group-data-pressed:font-medium group-data-pressed:text-reader-fg">
        {label}
      </span>
    </ToggleItem>
  );
}
