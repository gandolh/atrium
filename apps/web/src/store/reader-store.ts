import { create } from "zustand";
import type { Format } from "@ebook-reader/shared";

/**
 * In-memory reader state (decisions.md D9): resets on refresh — intended, no
 * persistence. Shared by both renderers (PDF/EPUB) behind the common Kindle-
 * style chrome (wiki/reader.md). This brief only lays out typed state +
 * setters; the readers (briefs 06/07) wire the actual behavior.
 *
 * `loadedFile`/`loadedFormat` are set by the uploader (brief 05, `/`) once a
 * PDF is picked or an EPUB fork resolves to "Read", and are the handoff seam
 * the `/read` renderers (briefs 06/07) consume — kept in Zustand rather than
 * router state so the `File` object (not serializable into a URL/search
 * param) survives the navigation to `/read`.
 */

export type Theme = "light" | "sepia" | "dark";

/**
 * Reading-mode toggle (chunk 11): one page per view ("paged") vs a continuous
 * vertical scroll ("scroll"). The durable, user-facing preference the bottom-bar
 * toggle flips, wired into both readers (EPUB `flow`, PDF single-vs-multi-page
 * render). Default "paged".
 */
export type PageMode = "paged" | "scroll";

/**
 * The reading pane's type face (brief 32, replacing the old serif/sans/mono
 * family list per design.md's "Newsreader wrote it, Archivo says it" rule):
 * `"reading"` is Newsreader (the system's reading face), `"ui"` is Archivo
 * (the system's interface face, offered as the sans alternative). See
 * `reader/epub/EpubSettings.tsx`'s `FONT_FACES` + `fontStackFor`.
 */
export type FontFace = "reading" | "ui";

export interface FontSettings {
  /** Font size in px. */
  size: number;
  family: FontFace;
  /** Line spacing multiplier, e.g. 1.78. */
  lineSpacing: number;
  /** Horizontal margin in px. */
  margins: number;
}

/**
 * Current reading position. EPUB (epub.js) uses a CFI string; PDF (react-pdf)
 * uses a page number. `null` before a document is loaded.
 */
export type ReaderLocation = string | number | null;

export interface ReaderState {
  theme: Theme;
  fontSettings: FontSettings;
  currentLocation: ReaderLocation;
  chromeVisible: boolean;
  /**
   * While > 0 the auto-hide timer must not hide the chrome — held while the
   * pointer is over the toolbar or a chrome surface (popover/drawer/search)
   * is open, so the toolbar can't fade out from under the user.
   */
  chromeHoldCount: number;
  /**
   * Reading mode: single page per view vs continuous vertical scroll. Like
   * `tocSidebarOpen`, this is a durable UI *preference* (not reading position,
   * D9), so it's mirrored to localStorage and survives a refresh.
   */
  pageMode: PageMode;
  /**
   * Whether the EPUB contents sidebar is docked open. Unlike reading position
   * (D9: intentionally not persisted), this is a durable UI *preference* — the
   * user asked for it to be remembered — so it's mirrored to localStorage.
   */
  tocSidebarOpen: boolean;
  /** The in-memory file handed from the library (`/`) to the reader (`/read`). */
  loadedFile: File | null;
  loadedFormat: Format | null;
  /**
   * The library book id backing `loadedFile`, when opened from the library
   * (D24). Lets the reader PATCH reading progress back to the server. `null`
   * for dev-sample loads (which have no library row).
   */
  loadedBookId: string | null;
  /**
   * The saved resume position for the loaded book (from the server, per-user),
   * for the mounted reader to seed its starting location: a page number for
   * PDF, a CFI string for EPUB. `null` = start from the beginning (fresh book,
   * dev sample, or never opened). Set by hydration alongside `loadedFile`.
   */
  initialLocation: ReaderLocation;
  /**
   * Coarse reading progress, 0..1, reported by whichever reader is mounted
   * (PDF = page/total; EPUB = locations percentage). Consumed by the library
   * progress-sync hook to PATCH the server (D24). `null` before it's known.
   */
  progressFraction: number | null;

  /**
   * PDF-only zoom scale (1 = 100%). Fixed-layout PDFs zoom instead of reflow;
   * the EPUB reader (brief 07) ignores this and uses `fontSettings` instead.
   * Kept here so the shared chrome can wire a zoom control format-agnostically.
   * Additive field (brief 06) — do not rename/remove.
   */
  zoom: number;

  setTheme: (theme: Theme) => void;
  setFontSettings: (fontSettings: Partial<FontSettings>) => void;
  setCurrentLocation: (location: ReaderLocation) => void;
  setChromeVisible: (visible: boolean) => void;
  toggleChrome: () => void;
  acquireChromeHold: () => void;
  releaseChromeHold: () => void;
  /** Set the reading mode (paged/scroll), persisted. */
  setPageMode: (mode: PageMode) => void;
  /** Flip between paged and scroll reading modes, persisted. */
  togglePageMode: () => void;
  /** Toggle the docked contents sidebar (persisted). */
  toggleTocSidebar: () => void;
  /** Stash the picked file + its detected format for `/read` to pick up. */
  setLoadedFile: (file: File | null, format: Format | null) => void;
  /**
   * Like `setLoadedFile`, but also records the library book id (D24) and the
   * user's saved resume position (`initialLocation`) for the reader to restore.
   */
  setLoadedBook: (
    file: File,
    format: Format,
    bookId: string,
    initialLocation?: ReaderLocation,
  ) => void;
  /** Report coarse reading progress (0..1) from the active reader. */
  setProgressFraction: (fraction: number | null) => void;
  /** Set the PDF zoom scale (brief 06). Clamped by the caller. */
  setZoom: (zoom: number) => void;
  reset: () => void;
}

// design.md "Typography": the reading pane defaults to Newsreader at 18/1.78
// (brief 32).
const DEFAULT_FONT_SETTINGS: FontSettings = {
  size: 18,
  family: "reading",
  lineSpacing: 1.78,
  margins: 24,
};

// The contents-sidebar preference is the one bit of durable UI state (the user
// asked for it to be remembered). Persist just this boolean — reading position
// stays session-only (D9). Guarded so SSR/no-storage environments no-op.
const TOC_SIDEBAR_KEY = "ebook-reader:toc-sidebar-open";

function readTocSidebarPref(): boolean {
  try {
    return localStorage.getItem(TOC_SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

function writeTocSidebarPref(open: boolean) {
  try {
    localStorage.setItem(TOC_SIDEBAR_KEY, open ? "1" : "0");
  } catch {
    /* preference persistence is best-effort */
  }
}

// The theme is a durable UI preference too (2026-07-16 UI review): without
// persistence every full page load (deep link, refresh, /discover navigation)
// snapped a dark/sepia user back to light. Same best-effort pattern.
const THEME_KEY = "ebook-reader:theme";

function readThemePref(): Theme {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "sepia" || value === "dark" ? value : "light";
  } catch {
    return "light";
  }
}

function writeThemePref(theme: Theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* preference persistence is best-effort */
  }
}

// Reading mode is the other durable UI preference (chunk 11). Persisted the same
// best-effort way as the sidebar: a single localStorage key, guarded so SSR/no-
// storage environments fall back to the "paged" default.
const PAGE_MODE_KEY = "ebook-reader:page-mode";

function readPageModePref(): PageMode {
  try {
    return localStorage.getItem(PAGE_MODE_KEY) === "scroll" ? "scroll" : "paged";
  } catch {
    return "paged";
  }
}

function writePageModePref(mode: PageMode) {
  try {
    localStorage.setItem(PAGE_MODE_KEY, mode);
  } catch {
    /* preference persistence is best-effort */
  }
}

const initialState = {
  theme: readThemePref(),
  fontSettings: DEFAULT_FONT_SETTINGS,
  currentLocation: null as ReaderLocation,
  chromeVisible: true,
  chromeHoldCount: 0,
  pageMode: readPageModePref(),
  tocSidebarOpen: readTocSidebarPref(),
  loadedFile: null as File | null,
  loadedFormat: null as Format | null,
  loadedBookId: null as string | null,
  initialLocation: null as ReaderLocation,
  progressFraction: null as number | null,
  zoom: 1,
};

export const useReaderStore = create<ReaderState>((set) => ({
  ...initialState,

  setTheme: (theme) =>
    set(() => {
      writeThemePref(theme);
      return { theme };
    }),
  setFontSettings: (fontSettings) =>
    set((state) => ({
      fontSettings: { ...state.fontSettings, ...fontSettings },
    })),
  setCurrentLocation: (currentLocation) => set({ currentLocation }),
  setChromeVisible: (chromeVisible) => set({ chromeVisible }),
  toggleChrome: () => set((state) => ({ chromeVisible: !state.chromeVisible })),
  acquireChromeHold: () =>
    set((state) => ({
      chromeHoldCount: state.chromeHoldCount + 1,
      chromeVisible: true,
    })),
  releaseChromeHold: () =>
    set((state) => ({ chromeHoldCount: Math.max(0, state.chromeHoldCount - 1) })),
  setPageMode: (pageMode) =>
    set(() => {
      writePageModePref(pageMode);
      return { pageMode };
    }),
  togglePageMode: () =>
    set((state) => {
      const pageMode: PageMode = state.pageMode === "paged" ? "scroll" : "paged";
      writePageModePref(pageMode);
      return { pageMode };
    }),
  toggleTocSidebar: () =>
    set((state) => {
      const tocSidebarOpen = !state.tocSidebarOpen;
      writeTocSidebarPref(tocSidebarOpen);
      return { tocSidebarOpen };
    }),
  setLoadedFile: (loadedFile, loadedFormat) =>
    set({ loadedFile, loadedFormat, loadedBookId: null, initialLocation: null }),
  setLoadedBook: (loadedFile, loadedFormat, loadedBookId, initialLocation = null) =>
    set({ loadedFile, loadedFormat, loadedBookId, initialLocation, progressFraction: null }),
  setProgressFraction: (progressFraction) => set({ progressFraction }),
  setZoom: (zoom) => set({ zoom }),
  reset: () => set(initialState),
}));
