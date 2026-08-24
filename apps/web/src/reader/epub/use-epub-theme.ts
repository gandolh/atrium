import { useEffect, useRef, useState } from "react";
import type { Rendition } from "epubjs";

import { useReaderStore, type Theme } from "../../store/reader-store";
import { themePalette } from "../../lib/tokens";
import { fontStackFor } from "./EpubSettings";

/**
 * Applies the active theme + font settings to the epub.js `rendition` (brief 07
 * step 2). Unlike the fixed-layout PDF (which can only invert), EPUB is
 * reflowable, so real theming works: we recolor the text via themed CSS rules
 * injected into each rendered section, and re-typeset via `themes.fontSize`,
 * `themes.font`, and line-height/margin overrides.
 *
 * These map the SAME palette the chrome uses (globals.css) so the page and its
 * chrome stay visually consistent across light/sepia/dark.
 */
export function themeRules(
  theme: Theme,
  lineSpacing: number,
  margins: number,
  // Scroll mode (`flow: scrolled-doc`) changes how `vh` behaves for images —
  // see the `img` rule below. Defaults to paged.
  isScroll = false,
  // Narrow viewports (phones): publisher `text-align: justify` opens rivers of
  // whitespace on short lines even with hyphenation enabled — see the
  // left-align override below. Defaults to wide.
  isNarrow = false,
) {
  // Resolved from the `--theme-<name>-*` constants in globals.css rather than
  // inlined here: the rendered page must sit on exactly the ground its chrome
  // does, and CSS custom properties do not cascade into epub.js's section
  // iframes, so the values have to travel as literal strings (lib/tokens.ts).
  const c = themePalette(theme);
  return {
    // iOS Safari auto-inflates text sized against a block's width. epub.js lays
    // every page out as columns inside ONE very wide iframe (thousands of px),
    // so iOS massively inflates the font → lines overflow the visible column
    // and get clipped on the right (only on real iPhones, not desktop/WebKit).
    // Pin text-size-adjust to 100% on the root to disable that inflation.
    "html, body": {
      "-webkit-text-size-adjust": "100% !important",
      "text-size-adjust": "100% !important",
      // Continuous scroll is vertical-only: clip any element that's wider than
      // the column (converted-manga XHTML often wraps the page image in a
      // fixed-width `<div>`/`<svg>` the `img` rule alone doesn't catch) so no
      // horizontal scrollbar can appear inside the section. Paged mode needs
      // epub.js's horizontal column layout, so this is scroll-only.
      ...(isScroll ? { "overflow-x": "hidden !important" } : {}),
    },
    body: {
      background: `${c.bg} !important`,
      color: `${c.fg} !important`,
      "line-height": `${lineSpacing} !important`,
      "padding-left": `${margins}px !important`,
      "padding-right": `${margins}px !important`,
      // Reading Room typesetting: let the browser hyphenate long lines instead
      // of leaving gappy rag/justification holes. Publisher CSS still wins on
      // alignment; we only enable the capability.
      "-webkit-hyphens": "auto",
      hyphens: "auto",
    },
    // Force text colour through common elements EPUBs style directly, so their
    // own stylesheets don't override the theme (esp. for dark).
    "p, div, span, h1, h2, h3, h4, h5, h6, li, blockquote, td, th": {
      color: `${c.fg} !important`,
    },
    // Narrow columns can't absorb publisher justification — with few words per
    // line, `text-align: justify` stretches word gaps into rivers (the classic
    // justification-without-enough-measure failure). Ragged-right is the
    // accessible default at this width; wide viewports keep publisher styling.
    ...(isNarrow
      ? {
          "p, li, blockquote, dd": {
            "text-align": "left !important",
          },
        }
      : {}),
    a: { color: `${c.accent} !important` },
    // Covers and full-page illustrations: fit the viewport column and sit
    // centered instead of rendering at natural size in the top-left.
    //
    // The `max-height: 94vh` cap is PAGED-ONLY. In scroll mode (`scrolled-doc`)
    // `vh` resolves against the section iframe's OWN height, which is driven by
    // its content — a circular dependency for an image page: the iframe starts
    // ~0px tall → 94vh ≈ 0 → the image lays out ~0 → the iframe never grows, so
    // an illustration page collapses to a sliver with nothing to scroll. In
    // scroll mode we cap by width only and let height follow the natural aspect;
    // the tall page simply scrolls.
    img: {
      "max-width": "100% !important",
      ...(isScroll ? {} : { "max-height": "94vh !important" }),
      height: "auto",
      "object-fit": "contain",
      display: "block",
      "margin-left": "auto",
      "margin-right": "auto",
    },
    svg: {
      "max-width": "100% !important",
      ...(isScroll ? {} : { "max-height": "94vh !important" }),
    },
  };
}

/** Below this viewport width, publisher-justified text left-aligns (rivers). */
const NARROW_QUERY = "(max-width: 520px)";

export function useEpubTheme(rendition: Rendition | null) {
  const theme = useReaderStore((s) => s.theme);
  const fontSettings = useReaderStore((s) => s.fontSettings);
  // Scroll vs paged changes the image-height rule (see themeRules). A pageMode
  // flip remounts the rendition anyway, but subscribe + depend on it so the
  // re-registered theme carries the right rule for the new mode.
  const isScroll = useReaderStore((s) => s.pageMode === "scroll");
  // Narrow-viewport flag for the left-align override; live-updates on resize/
  // rotation so the re-registered theme follows the device.
  const [isNarrow, setIsNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia(NARROW_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsNarrow(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  // Tracks which rendition has had its initial settings applied, so the
  // re-render nudge below only runs for *changes*, not the first application.
  const appliedRef = useRef<Rendition | null>(null);

  useEffect(() => {
    if (!rendition) return;

    const themeName = `reader-${theme}${isNarrow ? "-narrow" : ""}`;
    // Register (idempotent) + select the themed rule set. `register` with a
    // rules object injects the CSS into every rendered section iframe. The
    // narrow variant gets its own name — re-registering the SAME name with
    // different rules doesn't reliably restyle already-rendered sections.
    rendition.themes.register(
      themeName,
      themeRules(theme, fontSettings.lineSpacing, fontSettings.margins, isScroll, isNarrow),
    );
    rendition.themes.select(themeName);

    // Size + family via epub.js's dedicated helpers (they set the right root
    // font metrics so reflow re-paginates correctly).
    rendition.themes.fontSize(`${fontSettings.size}px`);
    rendition.themes.font(fontStackFor(fontSettings.family));

    // Chromium keeps a stale raster of LARGE section iframes after styles are
    // injected from the parent — the DOM updates but the screen doesn't
    // (small sections repaint fine; wide column strips don't). Re-render the
    // current section so changed settings actually paint. Debounced so slider
    // drags don't thrash; skipped on first application (fresh iframes bake
    // the theme in at load).
    if (appliedRef.current !== rendition) {
      appliedRef.current = rendition;
      return;
    }
    const nudge = setTimeout(() => {
      try {
        const loc = rendition.currentLocation() as unknown as {
          start?: { cfi?: string };
        };
        const cfi = loc?.start?.cfi;
        if (cfi) {
          (rendition as unknown as { clear(): void }).clear();
          void rendition.display(cfi);
        }
      } catch {
        /* repaint nudge is best-effort */
      }
    }, 180);
    return () => clearTimeout(nudge);
  }, [
    rendition,
    theme,
    isScroll,
    isNarrow,
    fontSettings.size,
    fontSettings.family,
    fontSettings.lineSpacing,
    fontSettings.margins,
  ]);
}
