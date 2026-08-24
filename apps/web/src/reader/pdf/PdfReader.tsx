import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page } from "react-pdf";
import type { PDFDocumentProxy } from "pdfjs-dist";

// react-pdf's required layer CSS (text layer = selection/search; annotation
// layer = links). Without these the text layer is mispositioned. Paths per the
// installed package (react-pdf@10.4.1 ships them under dist/Page/).
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";

// Import for side effect: configures the PDF.js worker for Vite (see file).
import "./pdf-worker";

import { useReaderStore } from "../../store/reader-store";
import {
  HomeButton,
  PageNav,
  PageJumpInput,
  PageModeToggle,
  ProgressRail,
  ReaderHeader,
  ReaderToolbar,
  resolveSwipe,
  resolveTapZone,
  SearchPanel,
  SettingsPopover,
  ThemePicker,
  ToolbarButton,
  TocDrawer,
  type RailTick,
  type SearchMatch,
  type TocEntry,
  useApplyTheme,
  useAutoHideChrome,
  useChromeToggle,
  usePageNavKeys,
} from "../chrome";
import { PdfNavControls, PdfViewControls } from "./PdfControls";
import { usePdfOutline } from "./use-pdf-outline";
import { createPdfSearchProvider } from "./pdf-search";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.2;

// Scroll-mode windowing (chunk 11): render real <Page> canvases only for pages
// within this many pages of the one at the top of the viewport; every other
// page is a cheap, correctly-sized placeholder div. This keeps a large PDF from
// mounting every page's canvas at once (memory) while preserving scrollbar
// length + scroll position (placeholders carry the estimated page height).
const PDF_SCROLL_WINDOW_BEFORE = 2;
const PDF_SCROLL_WINDOW_AFTER = 3;
// Fallback slot height (px) before the first page's aspect ratio is known.
const PDF_EST_PAGE_HEIGHT = 800;

// Passed to <Document options>. MUST be a stable reference (react-pdf compares
// by identity and reloads the doc otherwise) — hence module-scope. Leaving it
// empty is fine; react-pdf resolves cmaps/fonts from the bundled pdfjs-dist.
const DOCUMENT_OPTIONS = {} as const;

/**
 * PDF reader (brief 06). Wraps react-pdf (PDF.js) with the shared Kindle-style
 * chrome. Loads the in-memory `File` from Zustand (`loadedFile`, handed over by
 * the uploader — brief 05). Fixed-layout: pages are navigated, zoomed, and (for
 * "dark") colour-inverted rather than reflowed.
 *
 * Wiring to Zustand: `currentLocation` (page number), `zoom`, `theme`,
 * `chromeVisible`.
 */
export function PdfReader({ file }: { file: File }) {
  const containerRef = useRef<HTMLDivElement>(null);

  const currentLocation = useReaderStore((s) => s.currentLocation);
  const setCurrentLocation = useReaderStore((s) => s.setCurrentLocation);
  const zoom = useReaderStore((s) => s.zoom);
  const setZoom = useReaderStore((s) => s.setZoom);
  const theme = useReaderStore((s) => s.theme);
  const setTheme = useReaderStore((s) => s.setTheme);
  const chromeVisible = useReaderStore((s) => s.chromeVisible);
  // Reading mode (chunk 11): "scroll" stacks every page in one vertical scroll.
  const pageMode = useReaderStore((s) => s.pageMode);
  const isScroll = pageMode === "scroll";

  const [numPages, setNumPages] = useState<number | null>(null);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  // First page's height/width ratio, used to size placeholder slots for pages
  // outside the render window so the scrollbar length + offsets stay stable.
  const [pageAspect, setPageAspect] = useState<number | null>(null);

  // Scroll-mode plumbing: element per page slot (for scroll-into-view + the
  // IntersectionObserver), the last-known top of each intersecting slot, and a
  // flag that suppresses the observer while WE are programmatically scrolling
  // (so a jump doesn't get overwritten by the pages flying past the top).
  const slotRefs = useRef<Map<number, HTMLElement>>(new Map());
  const visibleTopsRef = useRef<Map<number, number>>(new Map());
  const suppressObserverRef = useRef(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // Query to highlight on the rendered page after a search jump (D19 follow-up:
  // landing on the right page without marking the match strands the reader).
  const [highlightQuery, setHighlightQuery] = useState<string | null>(null);

  // Fixed-layout PDFs can't be re-themed, so "dark" = invert the canvas.
  const inverted = theme === "dark";

  const currentPage = typeof currentLocation === "number" ? currentLocation : 1;

  // Shared chrome behaviors.
  useApplyTheme();
  useAutoHideChrome();

  // On mount, resume at the user's saved page (from the library, per-user) or
  // page 1 for a fresh/never-opened book. Read from the store at effect time so
  // this doesn't re-run when the saved value changes independently of `file`.
  useEffect(() => {
    const saved = useReaderStore.getState().initialLocation;
    setCurrentLocation(typeof saved === "number" && saved >= 1 ? saved : 1);
  }, [file, setCurrentLocation]);

  // Once the page count is known, clamp a saved page that overshoots the book
  // (e.g. the file changed) so react-pdf never tries to render a missing page.
  useEffect(() => {
    if (numPages && currentPage > numPages) setCurrentLocation(numPages);
  }, [numPages, currentPage, setCurrentLocation]);

  // Report coarse progress (page / total) for the library sync hook (D24).
  useEffect(() => {
    if (numPages && numPages > 0) {
      useReaderStore.getState().setProgressFraction(Math.min(currentPage / numPages, 1));
    }
  }, [currentPage, numPages]);

  // Track available width so fit-width can size the page to the viewport.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onLoadSuccess = useCallback(
    (doc: PDFDocumentProxy) => {
      setNumPages(doc.numPages);
      setPdfDoc(doc);
    },
    [],
  );

  // Read the first page's aspect ratio so scroll-mode placeholder slots (pages
  // outside the render window) get a realistic height. Most PDFs are uniform, so
  // page 1's ratio is a good estimate for all; a mismatch only causes a small
  // scroll drift as real pages replace placeholders.
  useEffect(() => {
    if (!pdfDoc) return;
    let cancelled = false;
    void pdfDoc
      .getPage(1)
      .then((page) => {
        if (cancelled) return;
        const viewport = page.getViewport({ scale: 1 });
        if (viewport.width > 0) setPageAspect(viewport.height / viewport.width);
      })
      .catch(() => {
        /* estimate falls back to PDF_EST_PAGE_HEIGHT */
      });
    return () => {
      cancelled = true;
    };
  }, [pdfDoc]);

  const tocEntries = usePdfOutline(pdfDoc);
  const hasToc = tocEntries.length > 0;

  // Running-header title. A PDF has no reliable in-document title the way an
  // EPUB carries `metadata.title`, so we use what IS available — the file name
  // (extension stripped) — matching the EPUB header's book-title slot. Blank
  // renders gracefully if there's somehow no name.
  const bookTitle = useMemo(
    () => file.name.replace(/\.pdf$/i, "").trim() || null,
    [file.name],
  );

  // Running-header detail = the current section, mirroring EPUB's chapter label.
  // Derived from the outline the same way the rail ticks are: the last top-level
  // entry whose page is at or before the current page. No outline → blank.
  const currentChapter = useMemo(() => {
    let label: string | null = null;
    let best = 0;
    for (const e of tocEntries) {
      if (e.depth !== 0 || typeof e.target !== "number") continue;
      if (e.target <= currentPage && e.target >= best) {
        best = e.target;
        label = e.label;
      }
    }
    return label;
  }, [tocEntries, currentPage]);

  // Chapter ticks for the scrub rail (brief 08): top-level outline entries that
  // resolved to a page. Empty (tickless rail) when the PDF has no outline.
  const railTicks = useMemo<RailTick[]>(() => {
    if (!numPages) return [];
    return tocEntries
      .filter((e) => e.depth === 0 && typeof e.target === "number")
      .map((e) => ({
        pct: (((e.target as number) - 1) / numPages) * 100,
        label: e.label,
      }));
  }, [tocEntries, numPages]);

  // Callback ref that registers/unregisters a scroll-mode page slot element.
  const registerSlot = useCallback(
    (page: number) => (el: HTMLDivElement | null) => {
      if (el) slotRefs.current.set(page, el);
      else slotRefs.current.delete(page);
    },
    [],
  );

  // Bring a page's slot to the top of the scroll viewport. Guards the observer
  // for a beat so the pages scrolling past the top don't overwrite the target.
  const scrollToPage = useCallback((page: number) => {
    const el = slotRefs.current.get(page);
    if (!el) return;
    suppressObserverRef.current = true;
    el.scrollIntoView({ block: "start" });
    window.setTimeout(() => {
      suppressObserverRef.current = false;
    }, 400);
  }, []);

  // Which way the last page change moved, for the paged-mode slide-in
  // animation (forward = new page slides in from the right). A ref, not
  // state: it's read during the re-render `setCurrentLocation` triggers.
  const navDirRef = useRef<"fwd" | "back">("fwd");

  const goToPage = useCallback(
    (page: number) => {
      if (numPages === null) return;
      const clamped = Math.min(Math.max(page, 1), numPages);
      navDirRef.current = clamped >= currentPage ? "fwd" : "back";
      setCurrentLocation(clamped);
      // In scroll mode a page change is a scroll (the observer will re-confirm
      // the landed page); in paged mode it just swaps the single rendered page.
      if (isScroll) requestAnimationFrame(() => scrollToPage(clamped));
    },
    [numPages, setCurrentLocation, isScroll, scrollToPage, currentPage],
  );

  const onPrev = useCallback(() => goToPage(currentPage - 1), [currentPage, goToPage]);
  const onNext = useCallback(() => goToPage(currentPage + 1), [currentPage, goToPage]);

  // Swipe to turn (paged mode). The PDF page is ordinary DOM, so plain touch
  // handlers on the content row suffice; `resolveSwipe` filters scroll/drag
  // noise. Suppressed while the page is zoomed past the column width — a
  // horizontal pan must stay a pan, not a page turn.
  const swipeStartRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const t = e.changedTouches[0];
    if (t) swipeStartRef.current = { x: t.screenX, y: t.screenY, at: performance.now() };
  }, []);
  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const start = swipeStartRef.current;
      swipeStartRef.current = null;
      if (!start || isScroll) return;
      const container = containerRef.current;
      if (container && container.scrollWidth > container.clientWidth + 1) return; // zoomed: pan, don't page
      const t = e.changedTouches[0];
      if (!t) return;
      const action = resolveSwipe(t.screenX - start.x, t.screenY - start.y, performance.now() - start.at);
      if (action === "next") onNext();
      else if (action === "prev") onPrev();
    },
    [isScroll, onNext, onPrev],
  );

  // Touch tap zones (option A, mirrors the EPUB reader): left/right ~30% of
  // the content row flips, the center toggles the chrome. Guards keep links
  // (annotation layer), the flip circles themselves, and text selection
  // working; scroll mode has no discrete pages so any tap just toggles.
  const toggleChrome = useChromeToggle();
  const onContentClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!window.matchMedia("(pointer: coarse)").matches) return;
      const target = e.target as HTMLElement;
      if (target.closest("a, button, input")) return;
      if (window.getSelection()?.toString()) return;
      if (isScroll) {
        toggleChrome();
        return;
      }
      const rect = e.currentTarget.getBoundingClientRect();
      if (rect.width <= 0) return;
      const zone = resolveTapZone((e.clientX - rect.left) / rect.width);
      if (zone === "prev") onPrev();
      else if (zone === "next") onNext();
      else toggleChrome();
    },
    [isScroll, onPrev, onNext, toggleChrome],
  );

  // Scrub-rail seek: 0–100 → 1-based page, matching the rail tooltip's own
  // pct→page mapping so the release lands on the page it previewed.
  const onSeekRail = useCallback(
    (pct: number) => {
      if (!numPages) return;
      goToPage(Math.max(1, Math.round((pct / 100) * numPages)));
    },
    [numPages, goToPage],
  );

  usePageNavKeys({ onPrev, onNext });

  // ── Scroll-mode: track the page nearest the top of the viewport ───────────
  // An IntersectionObserver rooted on the scroll container reports which page
  // slots intersect; we pick the one whose top is closest to the container's
  // top edge and sync it to `currentLocation`, so resume + the progress rail
  // keep tracking as the reader free-scrolls. Skipped entirely in paged mode.
  useEffect(() => {
    if (!isScroll || !numPages) return;
    const root = containerRef.current;
    if (!root) return;
    visibleTopsRef.current.clear();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = Number((entry.target as HTMLElement).dataset.page);
          if (!page) continue;
          if (entry.isIntersecting) {
            visibleTopsRef.current.set(page, entry.boundingClientRect.top);
          } else {
            visibleTopsRef.current.delete(page);
          }
        }
        // Don't fight a programmatic jump (goToPage / resume) mid-scroll.
        if (suppressObserverRef.current) return;
        const rootTop = root.getBoundingClientRect().top;
        let best: number | null = null;
        let bestDist = Infinity;
        for (const [page, top] of visibleTopsRef.current) {
          const dist = Math.abs(top - rootTop);
          if (dist < bestDist) {
            bestDist = dist;
            best = page;
          }
        }
        if (best !== null && best !== useReaderStore.getState().currentLocation) {
          setCurrentLocation(best);
        }
      },
      // A few thresholds so crossing the top edge always fires an update.
      { root, threshold: [0, 0.25, 0.5, 1] },
    );
    slotRefs.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [isScroll, numPages, setCurrentLocation]);

  // On entering scroll mode (or once the pages exist), bring the current/resume
  // page to the top so switching modes never loses the reader's place.
  //
  // The subtlety (why this doesn't just call scrollToPage once): placeholder
  // slot heights depend on `pageAspect`, which resolves asynchronously AFTER
  // this first fires. When it lands, every out-of-window slot jumps from the
  // ~800px fallback to its real height — a reflow that slides a different page
  // under the top edge and, unguarded, lets the IntersectionObserver overwrite
  // the just-restored resume page (error grows with resume depth). So we keep
  // the observer suppressed continuously from mount and only arm the release
  // ONCE `pageAspect` is known; the effect re-runs when it resolves, re-anchors
  // the saved page at the final layout, then releases the observer.
  useEffect(() => {
    if (!isScroll || !numPages) return;
    suppressObserverRef.current = true;
    const raf = requestAnimationFrame(() => {
      const saved = useReaderStore.getState().currentLocation;
      const el = slotRefs.current.get(typeof saved === "number" ? saved : 1);
      el?.scrollIntoView({ block: "start" });
    });
    // Only start the release timer once slot heights are final. While
    // `pageAspect` is still null the observer stays suppressed (no timer), so
    // the pending reflow can't overwrite the resume position.
    let release: number | undefined;
    if (pageAspect !== null) {
      release = window.setTimeout(() => {
        suppressObserverRef.current = false;
      }, 400);
    }
    return () => {
      cancelAnimationFrame(raf);
      if (release !== undefined) window.clearTimeout(release);
    };
  }, [isScroll, numPages, pageAspect]);

  const onZoomIn = useCallback(
    () => setZoom(Math.min(MAX_ZOOM, Math.round((zoom + ZOOM_STEP) * 100) / 100)),
    [zoom, setZoom],
  );
  const onZoomOut = useCallback(
    () => setZoom(Math.max(MIN_ZOOM, Math.round((zoom - ZOOM_STEP) * 100) / 100)),
    [zoom, setZoom],
  );
  // Fit-width resets zoom to 1 and lets the page track the container width.
  const onFitWidth = useCallback(() => setZoom(1), [setZoom]);

  // "Invert colours" dark hack: toggle the theme between dark (inverted canvas)
  // and light. PDF has no sepia/full theming — this is the fixed-layout dark
  // mode (wiki/reader.md: PDF = "invert-only").
  const onToggleInvert = useCallback(
    () => setTheme(inverted ? "light" : "dark"),
    [inverted, setTheme],
  );

  const onNavigateToc = useCallback(
    (entry: TocEntry) => {
      if (typeof entry.target === "number") goToPage(entry.target);
      setTocOpen(false);
    },
    [goToPage],
  );

  // In-book search (brief 07, additive): search-on-demand over the PDF.js text
  // layer. Provider is bound to the loaded document; jumping sets the page.
  const searchProvider = useMemo(
    () => (pdfDoc ? createPdfSearchProvider(pdfDoc) : null),
    [pdfDoc],
  );
  const onJumpToMatch = useCallback(
    (match: SearchMatch, query: string) => {
      if (typeof match.target === "number") {
        goToPage(match.target);
        setHighlightQuery(query);
      }
    },
    [goToPage],
  );

  // react-pdf renders this return value as HTML (dangerouslySetInnerHTML), so
  // escape the text item before wrapping query matches in <mark>.
  const customTextRenderer = useMemo(() => {
    if (!highlightQuery) return undefined;
    const needle = highlightQuery.toLowerCase();
    const escapeHtml = (s: string) =>
      s
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    return ({ str }: { str: string }) => {
      const haystack = str.toLowerCase();
      let idx = haystack.indexOf(needle);
      if (idx === -1) return escapeHtml(str);
      let html = "";
      let from = 0;
      while (idx !== -1) {
        html += escapeHtml(str.slice(from, idx));
        html += `<mark>${escapeHtml(str.slice(idx, idx + needle.length))}</mark>`;
        from = idx + needle.length;
        idx = haystack.indexOf(needle, from);
      }
      return html + escapeHtml(str.slice(from));
    };
  }, [highlightQuery]);

  // Fit-width base: page fills the container; `zoom` multiplies on top of it.
  // In scroll mode zoom is ignored so each page fits the column exactly — a
  // page wider than the column would force horizontal scrolling, which
  // continuous reading must not have (zoom-to-pan is a paged-mode affordance).
  const pageWidth = useMemo(() => {
    if (containerWidth === null) return undefined;
    // Leave a little horizontal breathing room.
    const base = Math.min(containerWidth - 32, 1000);
    return Math.max(base, 200) * (isScroll ? 1 : zoom);
  }, [containerWidth, zoom, isScroll]);

  // Estimated rendered height for scroll-mode placeholder slots (pages outside
  // the render window), from the first page's aspect ratio × the current width.
  const estPageHeight = useMemo(() => {
    if (pageWidth && pageAspect) return pageWidth * pageAspect;
    return PDF_EST_PAGE_HEIGHT;
  }, [pageWidth, pageAspect]);

  return (
    // Same frame as the EPUB reader (chunk 14): a reading pane laid out as a
    // 3-row grid — running header / content / toolbar. Wrapped in the same
    // `flex bg-reader-bg` shell so both formats share background + framing;
    // only the page content differs (fixed-layout canvas vs reflowed column).
    <div className="fixed inset-0 top-0 flex bg-reader-bg">
      <div className="relative grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr_auto] overflow-hidden">
        {/* Row 1: running orientation (title / section). Shared component; fades
            with the chrome exactly like EPUB's, keeping its row so the content
            below never shifts. */}
        <ReaderHeader title={bookTitle} detail={currentChapter} visible={chromeVisible} />

        {/* Row 2: content. min-h-0 + min-w-0 let the 1fr row shrink so a zoomed
            page pans inside the frame instead of blowing the grid out. Touch
            handlers here make a horizontal swipe anywhere over the page turn
            it (paged mode; see onTouchEnd's zoom/pan guard). */}
        <div
          className="relative min-h-0 min-w-0 overflow-hidden"
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          onClick={onContentClick}
        >
          {/* One centered, measure-capped column — identical framing to EPUB
              (max-w-measure, px-2 py-5 — design.md's 620px reading measure).
              The scroll container lives INSIDE the cap so
              zoom/overflow pans within the column rather than widening the pane.
              `containerRef` measures this capped box, so fit-width sizes the page
              to the same column the EPUB text fills. */}
          <div className="relative mx-auto h-full w-full max-w-measure px-2 py-5">
            <div
              ref={containerRef}
              // Scroll mode: only vertical scrolling (pages are fit-to-width, so
              // there is nothing to pan horizontally) — overflow-x is hidden as a
              // belt-and-braces guard. Paged mode keeps both axes so a zoomed
              // page can be panned.
              className={`h-full overflow-y-auto ${isScroll ? "overflow-x-hidden" : "overflow-x-auto"}`}
              // Invert-colours "dark" hack for the fixed-layout PDF. hue-rotate
              // keeps colour images roughly sane while the page goes
              // dark-on-light → light-on-dark. Scoped to the canvas wrapper, so
              // the shared chrome (header/rail/toolbar) stays themed normally.
              style={inverted ? { filter: "invert(1) hue-rotate(180deg)" } : undefined}
            >
              <Document
                file={file}
                onLoadSuccess={onLoadSuccess}
                options={DOCUMENT_OPTIONS}
                loading={<LoadingState />}
                error={<ErrorState />}
                className="min-h-full"
              >
                {isScroll && numPages !== null ? (
                  // Scroll mode: every page has a slot, but only pages within the
                  // window render a real <Page> (canvas); the rest are correctly-
                  // sized placeholders so the scroll length + offsets hold without
                  // mounting every canvas at once.
                  <div className="flex min-h-full flex-col items-center gap-4 py-2">
                    {Array.from({ length: numPages }, (_, i) => i + 1).map((n) => {
                      const active =
                        n >= currentPage - PDF_SCROLL_WINDOW_BEFORE &&
                        n <= currentPage + PDF_SCROLL_WINDOW_AFTER;
                      return (
                        <div
                          key={n}
                          data-page={n}
                          ref={registerSlot(n)}
                          className="w-full max-w-full"
                          style={{
                            width: pageWidth,
                            minHeight: active ? undefined : estPageHeight,
                          }}
                        >
                          {active ? (
                            <Page
                              pageNumber={n}
                              width={pageWidth}
                              renderTextLayer
                              renderAnnotationLayer
                              customTextRenderer={customTextRenderer}
                              className="shadow-lg"
                            />
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  // Keyed by page so each turn remounts the wrapper and replays
                  // a short slide-in from the direction of travel (see
                  // globals.css keyframes; motion-safe only).
                  <div
                    key={currentPage}
                    className={`flex min-h-full justify-center ${
                      navDirRef.current === "fwd"
                        ? "motion-safe:animate-[page-slide-fwd_0.18s_ease-out]"
                        : "motion-safe:animate-[page-slide-back_0.18s_ease-out]"
                    }`}
                  >
                    <Page
                      pageNumber={currentPage}
                      width={pageWidth}
                      renderTextLayer
                      renderAnnotationLayer
                      customTextRenderer={customTextRenderer}
                      className="shadow-lg"
                    />
                  </div>
                )}
              </Document>
            </div>
          </div>

          {/* Page-flip edge bars — scoped to the content row so they cover only
              the reading area, not the toolbar. Paged mode only: the discrete
              left/right flip bars are a paginated affordance with no meaning in
              continuous scroll (and would hijack clicks along the margins). */}
          {!isScroll && (
            <PageNav
              onPrev={onPrev}
              onNext={onNext}
              canPrev={currentPage > 1}
              canNext={numPages !== null && currentPage < numPages}
              chromeVisible={chromeVisible}
            />
          )}
        </div>

        {numPages !== null && numPages > 0 && (
          <ProgressRail
            percent={(currentPage / numPages) * 100}
            totalPages={numPages}
            ticks={railTicks}
            visible={chromeVisible}
            onSeek={onSeekRail}
          />
        )}

        <TocDrawer
          open={tocOpen}
          onOpenChange={setTocOpen}
          entries={tocEntries}
          onNavigate={onNavigateToc}
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
          // Groups (track C): LEFT = navigation (home, outline, search),
          // CENTER = view (zoom/invert/settings, reading mode), RIGHT = position.
          leftControls={
            <>
              <HomeButton />
              <PdfNavControls
                hasToc={hasToc}
                onOpenToc={() => setTocOpen(true)}
                onOpenSearch={() => setSearchOpen(true)}
              />
            </>
          }
          // The `formatControls` slot IS the format-adaptive seam — PDF fills it
          // here; brief 07 fills it with EPUB font/theme controls (same shell).
          formatControls={
            // Append the reading-mode toggle alongside PdfViewControls in the middle
            // cluster (mirrors the EPUB reader) without editing shared PdfControls.
            <>
              <PdfViewControls
                zoom={zoom}
                onZoomIn={onZoomIn}
                onZoomOut={onZoomOut}
                onFitWidth={onFitWidth}
                inverted={inverted}
                onToggleInvert={onToggleInvert}
                settingsTrigger={
                  <SettingsPopover
                    title="Reader settings"
                    trigger={
                      <ToolbarButton label="Reader settings">
                        <SettingsIcon />
                      </ToolbarButton>
                    }
                  >
                    <ThemePicker />
                    <p className="text-xs text-reader-fg/60">
                      PDF is fixed-layout: "Dark" inverts the page colours; font
                      controls are EPUB-only.
                    </p>
                  </SettingsPopover>
                }
              />
              <PageModeToggle />
            </>
          }
          rightControls={
            <PageJumpInput
              current={currentPage}
              total={numPages}
              onJump={goToPage}
              percent={numPages ? Math.round((currentPage / numPages) * 100) : null}
            />
          }
        />
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="grid place-items-center py-20 text-sm text-reader-fg/60">
      Loading PDF…
    </div>
  );
}

function ErrorState() {
  return (
    <div className="grid place-items-center py-20 text-sm text-red-500">
      Failed to load PDF.
    </div>
  );
}

function SettingsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9c.2.61.75 1.05 1.42 1.09H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"
        stroke="currentColor"
        strokeWidth="1.75"
      />
    </svg>
  );
}
