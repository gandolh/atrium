import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactReader, ReactReaderStyle, type IReactReaderStyle } from "react-reader";
import { EpubCFI, type Book, type NavItem, type Rendition } from "epubjs";

import { useReaderStore } from "../../store/reader-store";
import {
  HomeButton,
  PageNav,
  PageJumpInput,
  PageModeToggle,
  ProgressIndicator,
  ProgressRail,
  ReaderHeader,
  ReaderToolbar,
  resolveSwipe,
  resolveTapZone,
  SearchPanel,
  SettingsPopover,
  ToolbarButton,
  TocSidebar,
  type RailTick,
  type SearchMatch,
  type TocEntry,
  useApplyTheme,
  useAutoHideChrome,
  useChromeToggle,
  usePageNavKeys,
} from "../chrome";
import { EpubNavControls, EpubViewControls } from "./EpubControls";
import { EpubSettings, fontStackFor } from "./EpubSettings";
import { useEpubToc } from "./use-epub-toc";
import { cssToken } from "../../lib/tokens";
import { useEpubTheme, themeRules } from "./use-epub-theme";
import { createEpubSearchProvider } from "./epub-search";
import { resolveSpineHref } from "./resolve-spine-href";
import {
  buildPageMapDetached,
  settledStageSize,
  bookPageFromLocation,
  type EpubPageMap,
  type LocationLike,
} from "./epub-page-map";

/**
 * EPUB reader (brief 07 + the redesign that became Reading Room). Wraps
 * `react-reader` (epub.js) inside the SAME shared Kindle-style chrome the PDF
 * reader uses.
 *
 * Design intent (PRODUCT.md): the page is the interface. One centered, measure-
 * capped column (`spread: none`); orientation lives at the edges — a running
 * header (book title / chapter) and a scrubbable progress rail that appear and
 * fade WITH the chrome; the text column itself never moves.
 *
 * Reflowable (the "Kindle magic"): themes + font settings re-typeset the text
 * via `rendition.themes` (see `use-epub-theme`). Location is an epub.js CFI
 * string, stored in Zustand `currentLocation`.
 */

// ── Session caches (chunk 16) ────────────────────────────────────────────────
// Re-opening the SAME book (same identity + layout) re-ran two full-book walks
// every time: the off-screen page-map pagination AND epub.js `locations.generate`
// — measured at ~2.8 s and ~4.7 s of background CPU AFTER the reader was already
// visible (they thrash the main thread while the reader settles). Both outputs
// are deterministic for a given input, so we memoize them for the session.
//
// - Locations are char-based and layout-INDEPENDENT → keyed by book identity
//   only (name+size). Restored via epub.js `locations.load()` (parses the saved
//   CFI list) instead of re-walking every section.
// - The page map IS layout-dependent (font metrics + stage size change the page
//   count — epub.js #274) → keyed by identity + those inputs. Theme is excluded:
//   colors don't affect pagination.
// Bounded so a long session with many books can't grow the caches unboundedly.
const MAX_CACHE_ENTRIES = 6;
const pageMapCache = new Map<string, EpubPageMap>();
const locationsCache = new Map<string, string>();

function cacheSet<V>(cache: Map<string, V>, key: string, value: V) {
  // Refresh recency (delete+set moves the key to the end of insertion order).
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Book identity for the locations cache (content only — layout-independent).
 * name+size alone collide across different books that happen to share both
 * (e.g. two "book.epub" of equal byte length would serve each other's cached
 * locations/page-map), so `lastModified` is folded in as a cheap disambiguator
 * — no content hashing. */
function bookIdentity(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

/** Page-map cache key: identity + every layout input that changes page counts. */
function pageMapKey(
  file: File,
  fontSettings: { size: number; family: string; lineSpacing: number; margins: number },
  size: { width: number; height: number },
): string {
  return [
    bookIdentity(file),
    fontSettings.size,
    fontSettings.family,
    fontSettings.lineSpacing,
    fontSettings.margins,
    // Sub-pixel precision (not Math.round): a 1px stage difference can shift a
    // section's page total (epub.js #274), so rounding to the nearest integer
    // would let two genuinely different stage sizes collide and serve a stale
    // map. `toFixed(1)` still lets the identical layout hit its own entry.
    size.width.toFixed(1),
    size.height.toFixed(1),
  ].join("|");
}

/** Compare a relocated `href` with a TOC target, tolerating anchors and
 * nav-doc-relative paths (see resolve-spine-href.ts). */
function hrefMatches(target: unknown, href: string): boolean {
  if (typeof target !== "string") return false;
  const t = target.split("#")[0];
  const h = href.split("#")[0];
  return t === h || h.endsWith(`/${t}`) || t.endsWith(`/${h}`);
}

export function EpubReader({ file }: { file: File }) {
  const setCurrentLocation = useReaderStore((s) => s.setCurrentLocation);
  const currentLocation = useReaderStore((s) => s.currentLocation);
  const chromeVisible = useReaderStore((s) => s.chromeVisible);
  const tocSidebarOpen = useReaderStore((s) => s.tocSidebarOpen);
  const toggleTocSidebar = useReaderStore((s) => s.toggleTocSidebar);
  // Layout-affecting settings — a change invalidates the page map.
  const fontSettings = useReaderStore((s) => s.fontSettings);
  // Reading mode (chunk 11): "scroll" flips epub.js to `flow: scrolled-doc`.
  const pageMode = useReaderStore((s) => s.pageMode);

  // epub.js reads from an ArrayBuffer (in-memory file → no network, no object
  // URL to revoke). react-reader accepts `string | ArrayBuffer` for `url`.
  const [data, setData] = useState<ArrayBuffer | null>(null);
  const [rendition, setRendition] = useState<Rendition | null>(null);
  const bookRef = useRef<Book | null>(null);
  // The rendition most recently handed to us by react-reader. A pageMode toggle
  // remounts ReactReader (key={flow}), so a slow `locations.generate` walk kicked
  // off for an OLD rendition can resolve AFTER a new one exists; the async chains
  // in onGetRendition check this ref and bail rather than flip `locationsReady`
  // (or cache) for a stale, torn-down rendition.
  const latestRenditionRef = useRef<Rendition | null>(null);
  const [toc, setToc] = useState<NavItem[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  // Book-wide "Page N / total" — accurate rendered pages (research option 3).
  // We pre-paginate every spine item on THIS rendition (behind the loading
  // veil) and build a prefix sum of per-chapter page counts (`pageMap`); the
  // live page is `offset[section] + displayed.page`, which ticks by exactly 1
  // per screen turn and never resets at chapter boundaries. Recomputed when the
  // layout changes (font size/family/spacing/margins, viewport). Distinct from
  // the char-based `locations` below, which still drive the % rail + seeking.
  const [pageMap, setPageMap] = useState<EpubPageMap | null>(null);
  // Mirror of `pageMap` for event handlers, so the single `relocated` handler
  // always reads the LATEST map (a recompute swaps it) without re-subscribing
  // or capturing a stale map in a closure — a stale map was one cause of the
  // page number jumping around.
  const pageMapRef = useRef<EpubPageMap | null>(null);
  const [bookPage, setBookPage] = useState<number | null>(null);
  // "computing" = the background page-map walk is in flight (initial or a
  // layout-change recompute). It no longer gates the reader — the book stays
  // visible and interactive throughout; only the "Page N/M" badge waits on it.
  const [pageMapStatus, setPageMapStatus] =
    useState<"idle" | "computing" | "ready" | "failed">("idle");
  // Bumped to force a page-map recompute (layout-affecting settings changed).
  const [recomputeToken, setRecomputeToken] = useState(0);
  // Skip the debounced recompute on the very first settings render.
  const settingsSettledRef = useRef(false);
  const [bookTitle, setBookTitle] = useState<string | null>(null);
  const [currentTocId, setCurrentTocId] = useState<string | null>(null);
  const [chapterLabel, setChapterLabel] = useState<string | null>(null);
  const [railTicks, setRailTicks] = useState<RailTick[]>([]);
  const [locationsReady, setLocationsReady] = useState(false);
  // True while the "go to page" jump is stepping the rendition through pages, so
  // the interim relocations it fires are ignored (not echoed into react-reader's
  // controlled location, which would fight the walk). Reset when the walk ends.
  const jumpSteppingRef = useRef(false);
  // Fades the column out during TOC/search/rail jumps (a leap shouldn't look
  // like a glitch); sequential page turns stay instant — reading is sacred.
  const [jumping, setJumping] = useState(false);

  // CFI location the ReactReader is controlled by (kept local; mirrored to the
  // store so other chrome can read it).
  const cfi = typeof currentLocation === "string" ? currentLocation : null;

  // Shared chrome behaviors. `revealChrome` resets the auto-hide idle timer;
  // window-level activity is handled by the hook itself, and activity inside
  // the epub iframe (which never reaches window listeners) is forwarded below.
  useApplyTheme();
  const revealChrome = useAutoHideChrome();
  // Theme + font settings applied to the reflowable rendition (real theming).
  // Declared BEFORE the precompute effect so its effect runs first — the page
  // walk must measure with the active font, not the default.
  useEpubTheme(rendition);

  // ── Build the book-wide page map in the BACKGROUND ────────────────────────
  // "Page N / M" needs an accurate per-chapter page count, which epub.js only
  // knows AFTER laying each chapter out. Rather than block the open behind a
  // veil (the old flow walked the VISIBLE rendition through every chapter), we
  // parse a second, throwaway Book from the same bytes and walk it OFF-SCREEN
  // at the exact stage size + font settings of the visible reader. The reader
  // shows the resume page immediately; the badge fills in when the count lands.
  // Re-runs on `recomputeToken` (layout-affecting settings / viewport changed).
  useEffect(() => {
    if (!rendition || !data) return;
    // Scroll mode (chunk 11) uses `flow: scrolled-doc`, which reports no per-
    // screen page — the page field is hidden and the map is unused. Skip the
    // whole off-screen walk (a full second parse of the book) in that mode.
    if (pageMode === "scroll") {
      setPageMapStatus("idle");
      return;
    }
    let cancelled = false;
    setPageMapStatus("computing");

    // Snapshot the live theme/font so the off-screen walk lays out identically
    // to the visible reader — a width/font mismatch would make the counted
    // total disagree with the on-screen pages (epub.js #274).
    const { theme, fontSettings } = useReaderStore.getState();
    const applyStyles = (r: Rendition) => {
      const name = `reader-${theme}`;
      r.themes.register(name, themeRules(theme, fontSettings.lineSpacing, fontSettings.margins));
      r.themes.select(name);
      r.themes.fontSize(`${fontSettings.size}px`);
      r.themes.font(fontStackFor(fontSettings.family));
    };

    const useMap = (map: EpubPageMap) => {
      pageMapRef.current = map;
      setPageMap(map);
      setPageMapStatus("ready");
      // Seed the badge from the reader's current (unmoved) position.
      const loc = rendition.currentLocation() as unknown as LocationLike;
      setBookPage(bookPageFromLocation(loc, map));
      refreshProgress(rendition);
    };

    void (async () => {
      // Wait for the visible column to settle before measuring against it.
      const size = await settledStageSize(rendition);
      if (cancelled) return;
      // Re-opening the same book at the same layout? Reuse the memoized map and
      // skip the fresh 24 MB read + second parse + full-book walk entirely.
      const key = pageMapKey(file, fontSettings, size);
      const cached = pageMapCache.get(key);
      if (cached) {
        cacheSet(pageMapCache, key, cached); // refresh recency
        useMap(cached);
        return;
      }
      // Read a FRESH ArrayBuffer from the File for the off-screen build — never
      // reuse react-reader's `data` buffer: epub.js can detach it while we wait
      // above, which would make the detached parse fail (blank "Page …" badge).
      let bytes: ArrayBuffer;
      try {
        bytes = await file.arrayBuffer();
      } catch {
        if (!cancelled) setPageMapStatus("failed");
        return;
      }
      if (cancelled) return;
      try {
        const map = await buildPageMapDetached(bytes, size, applyStyles);
        if (cancelled) return;
        cacheSet(pageMapCache, key, map);
        useMap(map);
      } catch {
        if (!cancelled) setPageMapStatus("failed");
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendition, data, recomputeToken, pageMode, file]);

  // Recompute the page map when a layout-affecting setting settles (font size /
  // family / line-spacing / margins). Debounced so dragging a slider doesn't
  // re-walk on every tick. Skips the first render (that's the initial compute).
  useEffect(() => {
    if (!settingsSettledRef.current) {
      settingsSettledRef.current = true;
      return;
    }
    const id = setTimeout(() => setRecomputeToken((t) => t + 1), 500);
    return () => clearTimeout(id);
  }, [
    fontSettings.size,
    fontSettings.family,
    fontSettings.lineSpacing,
    fontSettings.margins,
  ]);

  // Recompute on viewport resize too (page counts are width-dependent).
  useEffect(() => {
    if (pageMapStatus === "idle") return;
    let id: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(id);
      id = setTimeout(() => setRecomputeToken((t) => t + 1), 600);
    };
    window.addEventListener("resize", onResize);
    return () => {
      clearTimeout(id);
      window.removeEventListener("resize", onResize);
    };
  }, [pageMapStatus]);


  // Read the File into an ArrayBuffer once per file.
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setRendition(null);
    setToc([]);
    setPercent(null);
    setPageMap(null);
    pageMapRef.current = null;
    setBookPage(null);
    setPageMapStatus("idle");
    setRecomputeToken(0);
    settingsSettledRef.current = false;
    setBookTitle(null);
    setCurrentTocId(null);
    setChapterLabel(null);
    setRailTicks([]);
    setLocationsReady(false);
    jumpSteppingRef.current = false;
    // Resume at the user's saved CFI (per-user, from the library) if there is
    // one, else start at the beginning. react-reader's controlled `location`
    // prop displays it immediately; the background page-map build (off-screen,
    // on a throwaway Book) never disturbs this position.
    const saved = useReaderStore.getState().initialLocation;
    setCurrentLocation(typeof saved === "string" ? saved : null);
    (async () => {
      const buf = await file.arrayBuffer();
      if (!cancelled) setData(buf);
    })();
    return () => {
      cancelled = true;
    };
  }, [file, setCurrentLocation]);

  // Overall percentage (drives the % rail + the library progress sync). Comes
  // from epub.js's char-based `locations` — reflowable, layout-independent, so
  // the rail stays stable across font changes. The book-wide PAGE number is
  // handled separately by the page map (which IS layout-dependent).
  const refreshProgress = useCallback((r: Rendition) => {
    try {
      const current = r.currentLocation() as unknown as {
        start?: { percentage?: number };
      };
      const p = current?.start?.percentage;
      if (typeof p === "number" && p >= 0) {
        setPercent(Math.round(p * 100));
        // Report coarse progress for the library sync hook (D24).
        useReaderStore.getState().setProgressFraction(Math.min(Math.max(p, 0), 1));
      }
    } catch {
      /* progress readout is best-effort */
    }
  }, []);

  const onLocationChanged = useCallback(
    (loc: string) => {
      // Ignore relocations emitted while the page-jump walk is stepping — they
      // aren't the reader's settled position and would fight the walk. The final
      // position is written to the store when the walk ends.
      if (jumpSteppingRef.current) return;
      setCurrentLocation(loc);
      // The book PAGE number is updated by the single `relocated` handler
      // (below) from the authoritative event payload — not here, where we'd
      // have to re-read a possibly-stale currentLocation().
    },
    [setCurrentLocation],
  );

  const onGetRendition = useCallback((r: Rendition) => {
    setRendition(r);
    bookRef.current = r.book;
    latestRenditionRef.current = r;
    // Book title for the running header (best-effort).
    r.book.loaded.metadata
      .then((m) => setBookTitle(m?.title?.trim() || null))
      .catch(() => {
        /* header falls back to nothing */
      });
    // Generate coarse char-based locations in the background — these drive the
    // % rail + seeking + chapter ticks (layout-independent). The book-wide PAGE
    // count is built separately by the precompute walk below. Memoized per book:
    // on a re-open we `load()` the saved CFI list (parse-only) instead of
    // re-walking every section (measured ~4.7 s of background CPU).
    const locKey = bookIdentity(file);
    // The walk below is async; a fast pageMode toggle can remount ReactReader and
    // hand us a fresh rendition before it resolves. Bail whenever `r` is no longer
    // the current rendition so a stale walk can't cache against it or flip
    // `locationsReady` for a torn-down reader.
    const isCurrent = () => latestRenditionRef.current === r;
    r.book.ready
      .then(() => {
        if (!isCurrent()) return;
        const saved = locationsCache.get(locKey);
        if (saved) {
          const locations = r.book.locations as unknown as {
            load(json: string): void;
          };
          locations.load(saved);
          cacheSet(locationsCache, locKey, saved); // refresh recency
          return;
        }
        return r.book.locations.generate(1000).then(() => {
          if (!isCurrent()) return;
          try {
            const save = (r.book.locations as unknown as { save(): string }).save();
            cacheSet(locationsCache, locKey, save);
          } catch {
            /* caching is best-effort */
          }
        });
      })
      .then(() => {
        if (!isCurrent()) return;
        setLocationsReady(true);
        refreshProgress(r);
      })
      .catch(() => {
        /* rail falls back to spine percentage */
      });
  }, [refreshProgress, file]);

  // Belt-and-braces for the badge: whichever finishes last — locations
  // generation or the first render — a `relocated` event re-reads progress, so
  // the page counter can't get stuck on its pre-locations fallback.
  useEffect(() => {
    if (!rendition) return;
    const onRelocated = (loc: LocationLike) => {
      refreshProgress(rendition);
      const map = pageMapRef.current;
      if (map) setBookPage(bookPageFromLocation(loc, map));
    };
    rendition.on("relocated", onRelocated);
    return () => rendition.off("relocated", onRelocated);
  }, [rendition, refreshProgress]);

  const onTocChanged = useCallback((next: NavItem[]) => setToc(next), []);

  const tocEntries = useEpubToc(toc);
  const hasToc = tocEntries.length > 0;

  // Track the current chapter (running header + TOC highlight + footer button):
  // every relocation maps the landed spine href back to its TOC entry.
  useEffect(() => {
    if (!rendition || tocEntries.length === 0) return;
    const onRelocated = (loc: { start?: { href?: string } }) => {
      const href = loc?.start?.href;
      if (!href) return;
      const found = tocEntries.find((e) => hrefMatches(e.target, href)) ?? null;
      setCurrentTocId(found?.id ?? null);
      setChapterLabel(found?.label ?? null);
    };
    rendition.on("relocated", onRelocated);
    return () => rendition.off("relocated", onRelocated);
  }, [rendition, tocEntries]);

  // Chapter tick positions for the progress rail, in locations-space so they
  // line up exactly with the accent fill. Best-effort: any failure just means
  // a tickless rail.
  useEffect(() => {
    if (!rendition || !locationsReady || tocEntries.length === 0) return;
    const book = rendition.book;
    try {
      const locations = book.locations as unknown as {
        length(): number;
        cfiFromLocation(loc: number): string;
      };
      const total = locations.length();
      if (!total) return;

      // First location index per spine position (single ordered pass).
      const firstLocBySpine = new Map<number, number>();
      for (let i = 0; i < total; i++) {
        const parsed = new EpubCFI(locations.cfiFromLocation(i)) as unknown as {
          spinePos: number;
        };
        if (!firstLocBySpine.has(parsed.spinePos)) {
          firstLocBySpine.set(parsed.spinePos, i);
        }
      }

      const spine = book.spine as unknown as {
        get(target: string): { index?: number } | null;
      };
      const seen = new Set<number>();
      const ticks: RailTick[] = [];
      for (const entry of tocEntries) {
        if (entry.depth !== 0 || typeof entry.target !== "string") continue;
        const resolved = resolveSpineHref(book, entry.target);
        if (!resolved) continue;
        const index = spine.get(resolved)?.index;
        if (index == null || seen.has(index)) continue;
        seen.add(index);
        const loc = firstLocBySpine.get(index);
        if (loc == null) continue;
        ticks.push({ pct: (loc / total) * 100, label: entry.label });
      }
      setRailTicks(ticks);
    } catch {
      setRailTicks([]);
    }
  }, [rendition, locationsReady, tocEntries]);

  // Display a target with a 150ms crossfade (TOC/search/rail leaps only).
  const jumpTo = useCallback(
    (target: string, after?: () => void) => {
      if (!rendition) return;
      setJumping(true);
      void rendition
        .display(target)
        .then(() => after?.())
        .catch(() => {
          /* jump is best-effort */
        })
        .finally(() => {
          requestAnimationFrame(() => setJumping(false));
        });
    },
    [rendition],
  );

  const onNavigateToc = useCallback(
    (entry: TocEntry) => {
      if (typeof entry.target === "string" && rendition) {
        // Nav-doc hrefs can be relative to the nav document, which epub.js
        // can't resolve against the spine (see resolve-spine-href.ts).
        const resolved = resolveSpineHref(rendition.book, entry.target);
        if (resolved) jumpTo(resolved);
      }
      // The docked sidebar stays open after a jump (unlike the old overlay
      // drawer) — navigating within contents shouldn't dismiss it.
    },
    [rendition, jumpTo],
  );

  const onPrev = useCallback(() => {
    void rendition?.prev();
  }, [rendition]);
  const onNext = useCallback(() => {
    void rendition?.next();
  }, [rendition]);

  usePageNavKeys({ onPrev, onNext });

  // Arrow keys pressed while focus sits inside the book iframe never reach the
  // window listener above — handle the rendition-forwarded keydown too.
  useEffect(() => {
    if (!rendition) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft" || event.key === "PageUp") onPrev();
      else if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ")
        onNext();
    };
    rendition.on("keydown", onKey);
    return () => rendition.off("keydown", onKey);
  }, [rendition, onPrev, onNext]);

  // The iframe event forwarder for auto-hide: key/click activity INSIDE the
  // book never bubbles to the window, so relay the events epub.js re-emits
  // into `reveal`. Clicks only reveal on FINE pointers — on touch screens a
  // tap is a command (tap zones below), not generic activity.
  useEffect(() => {
    if (!rendition) return;
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    rendition.on("keydown", revealChrome);
    if (!coarse) rendition.on("click", revealChrome);
    return () => {
      rendition.off("keydown", revealChrome);
      if (!coarse) rendition.off("click", revealChrome);
    };
  }, [rendition, revealChrome]);

  // Touch tap zones (option A of the mobile page-turn decision): tap the
  // left/right ~30% of the page to flip, the center to toggle the chrome —
  // the Kindle/Kobo grammar, and the WCAG 2.5.1 single-pointer alternative to
  // the swipe. Uses epub.js's relayed `click` (taps land inside the section
  // iframe) — no overlay elements, so text selection is untouched. Link taps
  // and taps that end a selection are left alone. In scroll mode there are no
  // discrete pages: any tap just toggles the chrome.
  const toggleChrome = useChromeToggle();
  useEffect(() => {
    if (!rendition) return;
    if (!window.matchMedia("(pointer: coarse)").matches) return;
    const onTap = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("a")) return; // footnotes/links keep their meaning
      const view = e.view as (Window & { frameElement: Element | null }) | null;
      if (view?.getSelection?.()?.toString()) return; // selecting, not paging
      if (pageMode === "scroll") {
        toggleChrome();
        return;
      }
      // `clientX` is in the section IFRAME's coordinate space, which in paged
      // mode spans every laid-out column (thousands of px) — useless directly.
      // The iframe's bounding rect is in top-viewport space (its `left` goes
      // negative as the container scrolls through columns), so rect.left +
      // clientX = the tap's real x in the app viewport.
      const frameRect = view?.frameElement?.getBoundingClientRect();
      const width = window.innerWidth;
      const zone =
        frameRect && width > 0
          ? resolveTapZone((frameRect.left + e.clientX) / width)
          : "toggle";
      if (zone === "prev") onPrev();
      else if (zone === "next") onNext();
      else toggleChrome();
    };
    rendition.on("click", onTap);
    return () => rendition.off("click", onTap);
  }, [rendition, pageMode, onPrev, onNext, toggleChrome]);

  // Swipe to turn (paged mode). Touches land inside the section iframe, so
  // listen on epub.js's relayed touchstart/touchend rather than our own DOM;
  // `resolveSwipe` filters out scrolls, slow drags, and diagonal noise. Scroll
  // mode swipes vertically by definition — no horizontal paging there.
  useEffect(() => {
    if (!rendition || pageMode === "scroll") return;
    let startX = 0;
    let startY = 0;
    let startedAt = 0;
    const onTouchStart = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      if (!t) return;
      startX = t.screenX;
      startY = t.screenY;
      startedAt = performance.now();
    };
    const onTouchEnd = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      if (!t || !startedAt) return;
      const action = resolveSwipe(
        t.screenX - startX,
        t.screenY - startY,
        performance.now() - startedAt,
      );
      startedAt = 0;
      if (action === "next") onNext();
      else if (action === "prev") onPrev();
    };
    rendition.on("touchstart", onTouchStart);
    rendition.on("touchend", onTouchEnd);
    return () => {
      rendition.off("touchstart", onTouchStart);
      rendition.off("touchend", onTouchEnd);
    };
  }, [rendition, pageMode, onPrev, onNext]);

  // Search provider bound to the loaded book; recreated when the book changes.
  const searchProvider = useMemo(() => {
    if (!rendition) return null;
    return createEpubSearchProvider(rendition.book);
  }, [rendition]);

  // The CFI range of the last search jump, kept so the previous highlight is
  // removed before adding the next one.
  const searchHighlightRef = useRef<string | null>(null);

  const onJumpToMatch = useCallback(
    (match: SearchMatch) => {
      if (typeof match.target === "string" && rendition) {
        const cfiTarget = match.target;
        if (searchHighlightRef.current) {
          try {
            rendition.annotations.remove(searchHighlightRef.current, "highlight");
          } catch {
            /* stale/never-rendered highlight — nothing to remove */
          }
          searchHighlightRef.current = null;
        }
        jumpTo(cfiTarget, () => {
          try {
            rendition.annotations.highlight(cfiTarget, {}, undefined, "search-highlight", {
              // Literal, not `var(--highlight-search)`: this is an SVG `fill`
              // attribute inside epub.js's section iframe, where the parent
              // document's custom properties don't cascade (lib/tokens.ts).
              fill: cssToken("--highlight-search"),
              "fill-opacity": "0.4",
              "mix-blend-mode": "multiply",
            });
            searchHighlightRef.current = cfiTarget;
          } catch {
            /* highlight is best-effort; the jump already landed */
          }
        });
      }
    },
    [rendition, jumpTo],
  );

  const onSeek = useCallback(
    (pct: number) => {
      const book = bookRef.current;
      if (!book || !rendition) return;
      try {
        const locations = book.locations as unknown as {
          cfiFromPercentage(p: number): string;
        };
        const target = locations.cfiFromPercentage(pct / 100);
        if (target) jumpTo(target);
      } catch {
        /* seek is best-effort */
      }
    },
    [rendition, jumpTo],
  );

  // Jump to a book-wide page number from the footer input. A reflowable book has
  // no CFI per page — char-location interpolation lands many pages off — so the
  // only way to hit the EXACT page is to paginate: display the target's spine
  // section (page 1 of it), then step forward to the page within it. The page
  // map counts pages the same way the live reader does, so `offset + stepped`
  // equals the target exactly.
  //
  // The catch is that each `rendition.next()` emits a relocation, which react-
  // reader would echo into its controlled `location` prop and re-display mid-
  // walk, corrupting the position. `jumpSteppingRef` suppresses those interim
  // relocations; we sync the store once to the settled spot at the end.
  const jumpToBookPage = useCallback(
    (page: number) => {
      const map = pageMapRef.current;
      const book = bookRef.current;
      if (!map || !book || !rendition || jumpSteppingRef.current) return;
      const target = Math.min(Math.max(page, 1), map.total);

      // Spine index whose page range covers the target (offsets are prefix sums).
      let idx = 0;
      for (let i = 0; i < map.offsets.length; i++) {
        const start = map.offsets[i];
        const count = map.counts[i] ?? 0;
        if (count > 0 && target > start && target <= start + count) {
          idx = i;
          break;
        }
      }
      const pageInChapter = target - (map.offsets[idx] ?? 0); // 1-based

      const spine = book.spine as unknown as {
        get(target: number): { href?: string } | null;
      };
      const href = spine.get(idx)?.href;
      if (!href) return;

      setJumping(true);
      jumpSteppingRef.current = true;
      void (async () => {
        try {
          await rendition.display(href); // page 1 of the section
          for (let k = 1; k < pageInChapter; k++) {
            await rendition.next();
          }
        } catch {
          /* jump is best-effort */
        } finally {
          jumpSteppingRef.current = false;
          // Sync the store + badge once to where we actually settled.
          try {
            const settled = rendition.currentLocation() as unknown as LocationLike & {
              start?: { cfi?: string };
            };
            const cfi = settled?.start?.cfi;
            if (cfi) setCurrentLocation(cfi);
            const m = pageMapRef.current;
            if (m) setBookPage(bookPageFromLocation(settled, m));
            refreshProgress(rendition);
          } catch {
            /* settle read is best-effort */
          }
          requestAnimationFrame(() => setJumping(false));
        }
      })();
    },
    [rendition, setCurrentLocation, refreshProgress],
  );

  // react-reader's own arrows + TOC toggle are hidden — we use the shared
  // chrome for those. Keep the reader area transparent so the themed page
  // background (from the rendition) shows through.
  const readerStyles = useMemo<IReactReaderStyle>(
    () => ({
      ...ReactReaderStyle,
      arrow: { ...ReactReaderStyle.arrow, display: "none" },
      prev: { ...ReactReaderStyle.prev, display: "none" },
      next: { ...ReactReaderStyle.next, display: "none" },
      tocButton: { ...ReactReaderStyle.tocButton, display: "none" },
      tocArea: { ...ReactReaderStyle.tocArea, display: "none" },
      tocBackground: { ...ReactReaderStyle.tocBackground, display: "none" },
      container: { ...ReactReaderStyle.container, background: "transparent" },
      readerArea: {
        ...ReactReaderStyle.readerArea,
        background: "transparent",
        boxShadow: "none",
        // The default `transition: all .3s ease` exists for react-reader's
        // built-in TOC slide (hidden here) — without the TOC it only adds
        // laggy easing to resizes.
        transition: "none",
      },
      // react-reader insets the epub view by top:50/left:50/right:50/bottom:20
      // to make room for ITS arrows + title — all of which we hide. Zero the
      // inset so the page fills the column; the readable margin then comes from
      // the column's padding (vertical) + the epub body's own margin (`Aa`
      // setting, horizontal).
      reader: { ...ReactReaderStyle.reader, top: 0, left: 0, right: 0, bottom: 0 },
    }),
    [],
  );

  // epub.js reading-mode config (chunk 11 + 2026-07-13 scroll rework). Scroll
  // mode uses the **continuous manager + `flow: "scrolled"`** — epub.js's own
  // canonical continuous-scroll pairing (see its `continuous-scrolled.html`
  // example; react-reader's README: "scrolled … works best with 'continuous'
  // manager"). It stitches consecutive spine sections into ONE seamless vertical
  // scroll and preloads the next section off-screen, which the old `scrolled-doc`
  // (default manager, one isolated section per iframe) never did. Paged mode
  // stays the default manager + column-per-screen `paginated` flow.
  //
  // The manager CANNOT be swapped on a live rendition (epub.js #995 — swapping
  // default↔continuous throws), and react-reader only re-inits on `url`/`location`
  // change, so the `key={flow}` remount below is REQUIRED (not a hack): it
  // recreates the rendition in the new manager+flow, and `location={cfi}`
  // re-displays the saved position so resume holds across the toggle.
  const isScroll = pageMode === "scroll";
  const flow = isScroll ? "scrolled" : "paginated";
  const manager = isScroll ? "continuous" : "default";

  if (!data) {
    return <SkeletonPage />;
  }

  return (
    // Row layout: the docked contents sidebar sits in-flow on the left and the
    // reading pane fills the rest, so opening the sidebar shifts (not covers)
    // the text. The pane is the positioning context for the chrome overlays
    // (header/nav/rail/toolbar are `absolute` within it), which keeps them
    // clear of the sidebar without any transform on the epub iframe's ancestor.
    // `bottom` stops at the player dock instead of the viewport floor: the shell
    // publishes `--dock-height` (0px when nothing is loaded, see
    // `routes/root-layout.tsx`) and a `fixed` child cannot inherit the shell's
    // bottom padding. Without this the dock painted over the progress rail —
    // the reader's only scrub control — whenever a track was playing.
    <div className="fixed inset-x-0 top-0 bottom-[var(--dock-height,0px)] flex bg-reader-bg">
      <TocSidebar
        open={tocSidebarOpen}
        entries={tocEntries}
        onNavigate={onNavigateToc}
        onClose={toggleTocSidebar}
        currentId={currentTocId}
      />

      {/* Reading pane as a 3-row grid: top bar / content / bottom bar. The bars
          are in-flow rows, so paginated content can never render under them
          (no more overlay + padding hack), and the content row (1fr) simply
          takes the space between. */}
      <div className="relative grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr_auto] overflow-hidden">
        {/* Row 1: top bar — running orientation (title / chapter). Shared with
            the PDF reader (ReaderHeader) so both present the same frame; in-flow
            so it fades with the chrome without shifting the content. */}
        <ReaderHeader title={bookTitle} detail={chapterLabel} visible={chromeVisible} />

        {/* Row 2: content. min-h-0 + min-w-0 let the 1fr row shrink in BOTH
            axes, so the very wide epub iframe (all pages laid out as columns)
            can't blow the grid column out past the viewport — it's clipped
            here instead of widening the pane and the bars. */}
        <div className="relative min-h-0 min-w-0 overflow-hidden">
        {/* One centered, measure-capped column — the page is the interface.
            `relative` is load-bearing: react-reader positions its reader area
            absolutely, and it must anchor to THIS capped box, not the
            full-width container. A wide cap + minimal padding lets the page
            fill the space (epub's own margins still keep the text readable). */}
        <div
          className="relative mx-auto h-full w-full max-w-measure px-2 py-5"
          // Drives the scroll-mode horizontal-clip rule in globals.css (kills the
          // scrollbar-induced stray horizontal scrollbar epub.js leaves in
          // scrolled-doc). Paged mode needs epub.js's horizontal columns, so it
          // is deliberately excluded.
          data-reader-flow={isScroll ? "scroll" : "paged"}
        >
          <ReactReader
            // Remount on flow change so epub.js recreates the rendition in the
            // new mode (react-reader ignores epubOptions changes otherwise).
            key={flow}
            url={data}
            // Before we have a CFI, start at spine index 0. Never let
            // react-reader fall back to `toc[0].href` — nav-doc-relative hrefs
            // don't resolve in the spine for books whose nav lives in a
            // subdirectory ("No Section Found" → blank reader).
            location={cfi ?? 0}
            locationChanged={onLocationChanged}
            getRendition={onGetRendition}
            tocChanged={onTocChanged}
            showToc={false}
            swipeable={false}
            // Passing ANY handleKeyPress disables react-reader's built-in
            // arrow-key paging (a document-level keyup listener). Without
            // this, one arrow press turns the page TWICE — once via our
            // keydown handlers, once via theirs — a visible double-flip.
            handleKeyPress={() => {}}
            readerStyles={readerStyles}
            loadingView={<SkeletonPage />}
            epubOptions={{ flow, manager, spread: "none" }}
          />
          {/* Jump crossfade veil. Deliberately an overlay rather than opacity
              on the column itself: animating opacity on an ancestor of the
              epub iframe promotes it to a compositor layer that can cache
              stale pixels (theme changes stop repainting). */}
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute inset-0 bg-reader-bg transition-opacity duration-150 motion-reduce:transition-none ${
              jumping ? "opacity-100" : "opacity-0"
            }`}
          />
        </div>
          {/* Page-flip edge bars — scoped to the content row so they cover only
              the reading area, not the toolbar. Paged mode only: the discrete
              left/right flip bars are a paginated affordance with no meaning in
              continuous scroll (and would hijack clicks along the margins). */}
          {!isScroll && (
            <PageNav onPrev={onPrev} onNext={onNext} canPrev canNext chromeVisible={chromeVisible} />
          )}
        </div>

        <ProgressRail
          percent={percent ?? 0}
          totalPages={pageMap?.total ?? null}
          ticks={railTicks}
          visible={chromeVisible}
          onSeek={onSeek}
        />

        {searchProvider && (
          <SearchPanel
            open={searchOpen}
            onOpenChange={setSearchOpen}
            provider={searchProvider}
            onJump={onJumpToMatch}
          />
        )}

        <ReaderToolbar
          visible={chromeVisible}
          // Groups (track C): LEFT = navigation (home, contents, search),
          // CENTER = view (typography/theme, reading mode), RIGHT = position.
          leftControls={
            <>
              <HomeButton />
              <EpubNavControls
                hasToc={hasToc}
                onOpenToc={toggleTocSidebar}
                tocActive={tocSidebarOpen}
                onOpenSearch={() => setSearchOpen(true)}
              />
            </>
          }
          // The `formatControls` slot IS the format-adaptive seam — EPUB fills it
          // with the font/theme settings trigger (PDF fills it with zoom/invert).
          // Same shell, different slot contents.
          formatControls={
            <>
              <EpubViewControls
                settingsTrigger={
                  <SettingsPopover
                    title="Reader settings"
                    trigger={
                      <ToolbarButton label="Reader settings">
                        <span className="text-sm font-semibold leading-none tracking-tight">
                          Aa
                        </span>
                      </ToolbarButton>
                    }
                  >
                    <EpubSettings />
                  </SettingsPopover>
                }
              />
              <PageModeToggle />
            </>
          }
          rightControls={
            // Chapter label stays a passive hint (the contents TOGGLE lives in
            // the format controls); the page number is now an editable jump
            // field. Chapter label hides on narrow bars so the input has room.
            <div className="flex min-w-0 items-center gap-2">
              {chapterLabel && (
                <span className="hidden min-w-0 max-w-[9rem] truncate text-xs text-reader-fg/60 md:inline">
                  {chapterLabel}
                </span>
              )}
              {isScroll ? (
                // Scroll mode: a discrete "Page N / M" is meaningless when the
                // whole book is one continuous document (epub.js reports no
                // per-screen page in scrolled-doc). Hide the jump field and keep
                // only the reflowable %-of-book chip (still driven by the char-
                // based locations, so it — and resume — stay accurate).
                <ProgressIndicator
                  current={percent ?? 0}
                  total={100}
                  variant="percent"
                />
              ) : (
                <PageJumpInput
                  current={bookPage}
                  total={pageMap?.total ?? null}
                  onJump={jumpToBookPage}
                  percent={percent}
                />
              )}
            </div>
          }
        />
      </div>
    </div>
  );
}

/** Loading = a page taking shape: faint prose-line bars in the same measure-
 * capped column the text will land in (no spinner, no "Loading…" string). */
function SkeletonPage() {
  const widths = ["w-2/5", "w-full", "w-full", "w-11/12", "w-full", "w-4/5", "", "w-full", "w-full", "w-10/12", "w-full", "w-3/5"];
  return (
    <div
      role="status"
      aria-label="Loading book"
      className="mx-auto flex h-full w-full max-w-measure flex-col gap-3.5 px-10 pt-20"
    >
      {widths.map((w, i) =>
        w === "" ? (
          <div key={i} className="h-3" />
        ) : (
          <div
            key={i}
            className={`h-3.5 rounded-sm bg-reader-fg/10 motion-safe:animate-pulse ${w}`}
          />
        ),
      )}
    </div>
  );
}
