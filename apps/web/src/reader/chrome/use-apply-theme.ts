import { useEffect, useSyncExternalStore } from "react";

import { useReaderStore, type Theme } from "../../store/reader-store";

/** What is on screen: the pick, with System resolved to light or dark. */
export type ResolvedTheme = Exclude<Theme, "system">;

const DARK_QUERY = "(prefers-color-scheme: dark)";

function subscribeToSystem(onChange: () => void): () => void {
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const systemPrefersDark = () => window.matchMedia(DARK_QUERY).matches;

/** `resolveTheme` for code outside React (a snapshot taken in an effect or a callback). */
export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme !== "system") return theme;
  return systemPrefersDark() ? "dark" : "light";
}

/**
 * The theme on screen. `light`, `sepia` and `dark` are themselves; `system` is light or dark by the operating
 * system's setting, and follows it live. A first visit has no pick and is light (base-ui rule 14), whatever the
 * system prefers. Everything that needs to know which theme is showing (the PDF's invert, the EPUB iframe's
 * rules, the LaTeX source theme) reads this, never the raw pick.
 */
export function useResolvedTheme(): ResolvedTheme {
  const theme = useReaderStore((s) => s.theme);
  const systemDark = useSyncExternalStore(subscribeToSystem, systemPrefersDark, () => false);
  if (theme === "system") return systemDark ? "dark" : "light";
  return theme;
}

/**
 * Applies the active reader theme by setting `data-theme` on a target element
 * (wiki/reader.md "Theme application"). The `--reader-*` CSS vars in
 * globals.css switch on that attribute, so both readers get themed chrome for
 * free. Defaults to `document.documentElement` so the whole reader view themes.
 *
 * The attribute is the resolved theme, so it is only ever light, sepia or dark: a System pick writes the one the
 * operating system asks for, and the `dark:` variant (keyed on `data-theme="dark"`) needs no media query.
 *
 * PDF note: real theming can't recolor a fixed-layout PDF canvas, so
 * PDF uses an "invert colors" hack for its dark mode instead (see the PDF
 * reader). This hook still runs so the *chrome* around the PDF is themed.
 */
export function useApplyTheme(target?: HTMLElement | null) {
  const theme = useResolvedTheme();

  useEffect(() => {
    const el = target ?? document.documentElement;
    const previous = el.getAttribute("data-theme");
    el.setAttribute("data-theme", theme);
    return () => {
      if (previous === null) el.removeAttribute("data-theme");
      else el.setAttribute("data-theme", previous);
    };
  }, [theme, target]);
}
