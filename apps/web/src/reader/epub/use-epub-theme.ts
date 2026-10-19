import { useEffect, useRef, useState } from "react";
import type { Rendition } from "epubjs";

import { useReaderStore, type Theme } from "../../store/reader-store";
import { themePalette } from "../../lib/tokens";
import { fontStackFor } from "./EpubSettings";

// The EPUB section iframe is a separate document — @font-face declared on the
// PARENT page (main.tsx's `@fontsource/*` imports) does not cascade into it,
// the same reason `lib/tokens.ts` exists for colour. So the two reading faces
// (design.md "Newsreader wrote it, Archivo says it") are re-declared here as
// literal @font-face rules, sourced from the SAME bundled font files via
// Vite's `?url` (the identical pattern `reader/pdf/pdf-worker.ts` uses for the
// PDF.js worker) — the browser reuses the already-fetched bytes from cache
// rather than downloading a second copy. The roman 400 weight (+ italic, for
// <em>/<i>) plus the bold weights the parent document also loads (main.tsx:
// Newsreader 500/600, Archivo 600/700) are registered for each face — without
// a real bold cut in the iframe, a section's own <b>/<strong> or a bold
// heading requests a weight that doesn't exist and the browser faux-bolds it.
// Same `?url` pattern, same bundled files main.tsx's `@fontsource/*` CSS
// imports already pull in, so Vite resolves these to the SAME emitted assets
// rather than fetching a second copy.
import nrLatin400 from "@fontsource/newsreader/files/newsreader-latin-400-normal.woff2?url";
import nrLatinExt400 from "@fontsource/newsreader/files/newsreader-latin-ext-400-normal.woff2?url";
import nrLatin400Italic from "@fontsource/newsreader/files/newsreader-latin-400-italic.woff2?url";
import nrLatinExt400Italic from "@fontsource/newsreader/files/newsreader-latin-ext-400-italic.woff2?url";
import nrLatin500 from "@fontsource/newsreader/files/newsreader-latin-500-normal.woff2?url";
import nrLatinExt500 from "@fontsource/newsreader/files/newsreader-latin-ext-500-normal.woff2?url";
import nrLatin600 from "@fontsource/newsreader/files/newsreader-latin-600-normal.woff2?url";
import nrLatinExt600 from "@fontsource/newsreader/files/newsreader-latin-ext-600-normal.woff2?url";
import arLatin400 from "@fontsource/archivo/files/archivo-latin-400-normal.woff2?url";
import arLatinExt400 from "@fontsource/archivo/files/archivo-latin-ext-400-normal.woff2?url";
import arLatin400Italic from "@fontsource/archivo/files/archivo-latin-400-italic.woff2?url";
import arLatinExt400Italic from "@fontsource/archivo/files/archivo-latin-ext-400-italic.woff2?url";
import arLatin600 from "@fontsource/archivo/files/archivo-latin-600-normal.woff2?url";
import arLatinExt600 from "@fontsource/archivo/files/archivo-latin-ext-600-normal.woff2?url";
import arLatin700 from "@fontsource/archivo/files/archivo-latin-700-normal.woff2?url";
import arLatinExt700 from "@fontsource/archivo/files/archivo-latin-ext-700-normal.woff2?url";

// `Contents.addStylesheetRules` (epub.js) inserts each key as a CSS rule via
// `CSSStyleSheet.insertRule`, which accepts at-rules — so `"@font-face"` works
// as a rules-object key exactly like any selector, and an array value inserts
// one rule per array entry (the SAME mechanism `themes.registerRules` uses for
// every other selector below). Built once at module scope; merged into every
// theme's rule set (harmless to redeclare — the browser just reuses the cache).
const EPUB_FONT_FACE_RULES = {
  "@font-face": [
    { "font-family": "'Newsreader'", "font-style": "normal", "font-weight": "400", src: `url(${nrLatin400}) format('woff2')` },
    { "font-family": "'Newsreader'", "font-style": "normal", "font-weight": "400", src: `url(${nrLatinExt400}) format('woff2')` },
    { "font-family": "'Newsreader'", "font-style": "italic", "font-weight": "400", src: `url(${nrLatin400Italic}) format('woff2')` },
    { "font-family": "'Newsreader'", "font-style": "italic", "font-weight": "400", src: `url(${nrLatinExt400Italic}) format('woff2')` },
    { "font-family": "'Newsreader'", "font-style": "normal", "font-weight": "500", src: `url(${nrLatin500}) format('woff2')` },
    { "font-family": "'Newsreader'", "font-style": "normal", "font-weight": "500", src: `url(${nrLatinExt500}) format('woff2')` },
    { "font-family": "'Newsreader'", "font-style": "normal", "font-weight": "600", src: `url(${nrLatin600}) format('woff2')` },
    { "font-family": "'Newsreader'", "font-style": "normal", "font-weight": "600", src: `url(${nrLatinExt600}) format('woff2')` },
    { "font-family": "'Archivo'", "font-style": "normal", "font-weight": "400", src: `url(${arLatin400}) format('woff2')` },
    { "font-family": "'Archivo'", "font-style": "normal", "font-weight": "400", src: `url(${arLatinExt400}) format('woff2')` },
    { "font-family": "'Archivo'", "font-style": "italic", "font-weight": "400", src: `url(${arLatin400Italic}) format('woff2')` },
    { "font-family": "'Archivo'", "font-style": "italic", "font-weight": "400", src: `url(${arLatinExt400Italic}) format('woff2')` },
    { "font-family": "'Archivo'", "font-style": "normal", "font-weight": "600", src: `url(${arLatin600}) format('woff2')` },
    { "font-family": "'Archivo'", "font-style": "normal", "font-weight": "600", src: `url(${arLatinExt600}) format('woff2')` },
    { "font-family": "'Archivo'", "font-style": "normal", "font-weight": "700", src: `url(${arLatin700}) format('woff2')` },
    { "font-family": "'Archivo'", "font-style": "normal", "font-weight": "700", src: `url(${arLatinExt700}) format('woff2')` },
  ],
};

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
    ...EPUB_FONT_FACE_RULES,
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
  // The reader's place, kept across setting changes (briefs 83 and 84). Read
  // BEFORE the new settings reach the rendition: once a font size lands,
  // epub.js reflows under the same scroll offset, and the start of "the current
  // page" is then different text (A+ reads earlier text, A- later).
  //
  // It is sticky. A redisplay lands on the page that CONTAINS the anchor, and
  // that page usually starts a little earlier, so re-reading the start after
  // every change walks the reader backwards a few lines per press (A+ twice,
  // A- four times, A+ twice ended a page before Chapter I). The anchor is kept
  // while a redisplay is pending or in flight and while the reader is still on
  // the page it landed on (`landed`); turning a page or jumping replaces it.
  const anchorRef = useRef<{ cfi: string; landed: string | null } | null>(null);
  // True from a change until its redisplay lands.
  const busyRef = useRef(false);
  // Bumped on every change, so a redisplay still in flight from an earlier
  // press stands down instead of fighting the newer one.
  const generationRef = useRef(0);

  useEffect(() => {
    if (!rendition) return;

    const isChange = appliedRef.current === rendition;
    if (!isChange) {
      anchorRef.current = null;
      busyRef.current = false;
    } else {
      anchorRef.current = keepOrTakeAnchor(anchorRef.current, startCfi(rendition), busyRef.current);
      busyRef.current = true;
    }

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
    if (!isChange) {
      appliedRef.current = rendition;
      return;
    }
    const generation = ++generationRef.current;
    const nudge = setTimeout(() => {
      const anchor = anchorRef.current;
      if (!anchor) {
        busyRef.current = false;
        return;
      }
      void redisplayAt(rendition, anchor.cfi, () => generationRef.current !== generation).finally(
        () => {
          if (generationRef.current !== generation) return;
          anchor.landed = startCfi(rendition);
          busyRef.current = false;
        },
      );
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

/**
 * The anchor for a setting change: the previous one while a redisplay is still
 * pending (`busy`) or while the reader has not left the page it landed on,
 * otherwise the start of the current page.
 */
function keepOrTakeAnchor(
  previous: { cfi: string; landed: string | null } | null,
  currentStart: string | null,
  busy: boolean,
): { cfi: string; landed: string | null } | null {
  if (previous && (busy || previous.landed === currentStart)) return previous;
  return currentStart ? { cfi: currentStart, landed: null } : null;
}

/** The CFI of the first text on the reader's current page, or null. */
function startCfi(rendition: Rendition): string | null {
  try {
    const loc = rendition.currentLocation() as unknown as { start?: { cfi?: string } };
    return loc?.start?.cfi ?? null;
  } catch {
    return null;
  }
}

/**
 * Re-render the current section and put the reader back at `cfi` (the repaint
 * nudge above).
 *
 * `clear()` throws the section's iframe away, and epub.js positions `cfi` in
 * the new one before its layout has settled: the web fonts are still arriving
 * and the iframe is still growing to its full column strip (measured on Pride
 * and Prejudice at 390 px: 44,506 px wide when `display()` resolved, 63,954 px
 * about 180 ms later). The anchor word sat at x=20372 in that early layout and
 * at x=19837 in the final one, one 374 px page apart, so every theme change
 * from that page moved the reader from page 55 to 56 (brief 83). So wait for
 * the fonts and for the strip to stop changing, then display `cfi` again. That
 * second call finds the section already rendered and only scrolls, which is
 * exact.
 */
async function redisplayAt(
  rendition: Rendition,
  cfi: string,
  isStale: () => boolean,
): Promise<void> {
  try {
    (rendition as unknown as { clear(): void }).clear();
    await rendition.display(cfi);
    if (isStale()) return;
    await settledLayout(rendition, isStale);
    if (isStale()) return;
    await rendition.display(cfi);
  } catch {
    /* repaint nudge is best-effort */
  }
}

/** Frames a section's size must hold still before it counts as laid out. */
const STABLE_FRAMES = 6;
/** Give up waiting after this long and display anyway. */
const SETTLE_CAP_MS = 2000;

/**
 * Resolves once every rendered section has its fonts and has kept the same
 * width (document and iframe) for `STABLE_FRAMES` frames, or after
 * `SETTLE_CAP_MS`. `document.fonts.status` alone is not enough: it already
 * read "loaded" while the strip was still growing.
 */
async function settledLayout(rendition: Rendition, isStale: () => boolean): Promise<void> {
  const docs = (): Document[] =>
    // epub.js types `getContents()` as one Contents; it returns an array.
    (rendition.getContents() as unknown as { document?: Document }[])
      .map((c) => c.document)
      .filter((d): d is Document => !!d);
  const signature = () =>
    docs()
      .map((d) => {
        const frameEl = d.defaultView?.frameElement as HTMLElement | null | undefined;
        return `${d.documentElement.scrollWidth}x${frameEl?.offsetWidth ?? 0}`;
      })
      .join(",");
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  const started = performance.now();
  await Promise.all(docs().map((d) => d.fonts?.ready));
  let last = signature();
  let still = 0;
  while (still < STABLE_FRAMES && performance.now() - started < SETTLE_CAP_MS) {
    await frame();
    if (isStale()) return;
    const now = signature();
    if (now === last && docs().every((d) => d.fonts?.status !== "loading")) still += 1;
    else {
      still = 0;
      last = now;
    }
  }
}
