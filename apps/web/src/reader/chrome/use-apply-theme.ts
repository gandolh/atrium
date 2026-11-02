import { useEffect } from "react";

import { useReaderStore } from "../../store/reader-store";

/**
 * Applies the active reader theme by setting `data-theme` on a target element
 * (wiki/reader.md "Theme application"). The `--reader-*` CSS vars in
 * globals.css switch on that attribute, so both readers get themed chrome for
 * free. Defaults to `document.documentElement` so the whole reader view themes.
 *
 * PDF note: real theming can't recolor a fixed-layout PDF canvas, so
 * PDF uses an "invert colors" hack for its dark mode instead (see the PDF
 * reader). This hook still runs so the *chrome* around the PDF is themed.
 */
export function useApplyTheme(target?: HTMLElement | null) {
  const theme = useReaderStore((s) => s.theme);

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
