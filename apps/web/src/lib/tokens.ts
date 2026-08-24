/**
 * Reads Reading Room design tokens (wiki/design.md, D33) out of the live
 * stylesheet as concrete colour strings.
 *
 * Components style themselves with `var(--token)` and never need this. It
 * exists for the places a CSS custom property genuinely cannot reach:
 *
 *  1. **The EPUB section iframes.** epub.js injects our theme as a rules object
 *     into each rendered section document; custom properties defined on the
 *     parent document do not cascade in there, so the value has to travel as a
 *     literal string (reader/epub/use-epub-theme.ts, EpubReader's search hit).
 *  2. Anywhere a colour must be handed to a non-CSS API.
 *
 * Routing those through `globals.css` keeps the palette single-sourced instead
 * of scattering hex through `src/` — the design system's "tokens only" rule.
 * `globals.css` is imported in `main.tsx` before the first render, so by the
 * time any of this runs the properties are resolved; the empty-string fallback
 * is for a non-DOM context (tests, SSR) only, and callers drop the rule rather
 * than emit a broken one.
 */

/**
 * Resolve one CSS custom property off the document root.
 *
 * @param name the property including its leading dashes, e.g. `"--paper"`
 * @returns the trimmed value, or `""` when unset / outside a DOM
 */
export function cssToken(name: string): string {
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** The three reading themes, matching Zustand's `theme` field. */
export type ThemeName = "light" | "sepia" | "dark";

/** A reading theme's resolved ground/text/accent, as literal colour strings. */
export interface ThemePalette {
  bg: string;
  fg: string;
  surface: string;
  border: string;
  accent: string;
}

/**
 * The fixed palette of a named theme — the `--theme-<name>-*` constants in
 * globals.css, which are NOT remapped by `data-theme`. So this answers for any
 * theme, not just the active one (the theme picker paints all three at once).
 */
export function themePalette(theme: ThemeName): ThemePalette {
  return {
    bg: cssToken(`--theme-${theme}-bg`),
    fg: cssToken(`--theme-${theme}-fg`),
    surface: cssToken(`--theme-${theme}-surface`),
    border: cssToken(`--theme-${theme}-border`),
    accent: cssToken(`--theme-${theme}-accent`),
  };
}
