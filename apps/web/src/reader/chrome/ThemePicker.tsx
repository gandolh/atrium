import { useReaderStore, type Theme } from "../../store/reader-store";

/**
 * Theme swatches, drawn from the `--theme-<name>-*` constants in globals.css so
 * each swatch is a truthful miniature of the page it produces. Those constants
 * are deliberately NOT remapped by `data-theme` — a picker has to paint all
 * three grounds at once, whichever one is currently active, which is exactly
 * why they exist separately from the `--reader-*` layer they feed.
 */
const THEMES: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "sepia", label: "Sepia" },
  { value: "dark", label: "Dark" },
];

/**
 * Shared light/sepia/dark theme picker (wiki/reader.md), drawn as three
 * miniature pages — an "Aa" set on each theme's actual paper — the pattern a
 * Kindle/Books hand already knows. Writes to Zustand's `theme`;
 * `useApplyTheme` reflects it onto `data-theme`.
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
      <div role="radiogroup" aria-label="Theme" className="flex gap-2">
        {THEMES.map((t) => {
          const selected = theme === t.value;
          return (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setTheme(t.value)}
              className={`flex flex-1 flex-col items-center gap-1 rounded-card outline-none focus-visible:ring-2 focus-visible:ring-reader-accent`}
            >
              <span
                aria-hidden="true"
                // A theme swatch is a miniature PAGE (design.md "Aa panel"), so
                // it takes the artwork radius (2px), not the general card
                // radius (4px) — the same distinction the library covers draw.
                className={`grid h-11 w-full place-items-center rounded-cover border text-base transition-shadow ${
                  selected ? "ring-2 ring-reader-accent" : ""
                }`}
                style={{
                  backgroundColor: `var(--theme-${t.value}-bg)`,
                  color: `var(--theme-${t.value}-fg)`,
                  borderColor: `var(--theme-${t.value}-border)`,
                  fontFamily: "var(--font-reading)",
                }}
              >
                Aa
              </span>
              <span
                className={`text-[11px] ${
                  selected ? "font-medium text-reader-fg" : "text-reader-fg/60"
                }`}
              >
                {t.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
