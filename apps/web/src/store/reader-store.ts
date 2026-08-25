import { create } from "zustand";
import type { Format, Preferences } from "@ebook-reader/shared";

import { useAuthStore } from "../lib/auth";
import { getBootPreferences, initPreferencesSync, schedulePreferencesWrite } from "../lib/preferences";

/**
 * In-memory reader state (decisions.md D9): resets on refresh — intended, no
 * persistence, EXCEPT the four preference groups below (theme, fontSettings,
 * pageMode, tocSidebarOpen), which brief 35 / D35 moves to the active
 * profile's server-side `preferences` blob (revising D9 for preferences
 * only — reading *position* stays session-only, that's D31's locator, not a
 * preference). Shared by both renderers (PDF/EPUB) behind the common Kindle-
 * style chrome (wiki/reader.md).
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
   * D9), so it lives in the active profile's `preferences` blob (D35) and
   * survives a refresh — and follows the person to another device.
   */
  pageMode: PageMode;
  /**
   * Whether the EPUB contents sidebar is docked open. Unlike reading position
   * (D9: intentionally not persisted), this is a durable UI *preference* — the
   * user asked for it to be remembered — so it's part of the profile's
   * `preferences` blob (D35), same as `pageMode`.
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

/**
 * `profileId` at whatever moment a setter fires — read fresh each time (not
 * cached), since the active profile can change between renders. `null` on a
 * device that hasn't picked a profile yet (still on the lock screen, or the
 * very first paint before login); a setter that fires in that state has
 * nothing to attach the write to, so it's dropped rather than queued — there
 * is no "preferences with no owner" concept.
 */
function activeProfileId(): string | null {
  return useAuthStore.getState().activeProfileId;
}

/** Schedule `patch` to be written to the active profile's preferences, if there is one. */
function persistPreference(patch: Preferences): void {
  const id = activeProfileId();
  if (id) schedulePreferencesWrite(id, patch);
}

// Brief 35 / D35: the four groups below used to be three bare localStorage
// keys (theme/pageMode/tocSidebarOpen) plus fontSettings, which wasn't
// persisted at all. All four now flow through `lib/preferences.ts`, which
// owns the actual boot-cache/localStorage keys and the debounced server
// write — this file only reads the synchronous boot snapshot once at module
// load (below) and calls `persistPreference` from each setter.
//
// `bootProfileId` is captured once here (not re-read) and handed to
// `initPreferencesSync` below so its first reconcile can tell "the store
// already reflects this exact profile's best guess" from "repaint me" — see
// that function's doc comment for why conflating the two would flash.
const bootProfileId = activeProfileId();
const bootPrefs = getBootPreferences(bootProfileId);

const initialState = {
  theme: bootPrefs.theme ?? ("light" as Theme),
  // Seeded from `DEFAULT_FONT_SETTINGS` for a profile with no stored font
  // preference — this is the first time these become durable at all (they
  // used to reset on every reload; see the `FontSettings` doc above).
  fontSettings: { ...DEFAULT_FONT_SETTINGS, ...bootPrefs.fontSettings },
  currentLocation: null as ReaderLocation,
  chromeVisible: true,
  chromeHoldCount: 0,
  pageMode: bootPrefs.pageMode ?? ("paged" as PageMode),
  tocSidebarOpen: bootPrefs.tocSidebarOpen ?? false,
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
      persistPreference({ theme });
      return { theme };
    }),
  setFontSettings: (fontSettings) =>
    set((state) => {
      const merged = { ...state.fontSettings, ...fontSettings };
      // The server merges the `preferences` blob only one level deep, so
      // `fontSettings` is REPLACED WHOLESALE on every PATCH — sending a
      // partial (e.g. just `{ size }`) would silently drop the other three
      // fields server-side. `merged` always carries all four because
      // `state.fontSettings` is seeded complete above and every write goes
      // through this same merge, so it's always safe to send as-is.
      persistPreference({ fontSettings: merged });
      return { fontSettings: merged };
    }),
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
      persistPreference({ pageMode });
      return { pageMode };
    }),
  togglePageMode: () =>
    set((state) => {
      const pageMode: PageMode = state.pageMode === "paged" ? "scroll" : "paged";
      persistPreference({ pageMode });
      return { pageMode };
    }),
  toggleTocSidebar: () =>
    set((state) => {
      const tocSidebarOpen = !state.tocSidebarOpen;
      persistPreference({ tocSidebarOpen });
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

// Wire profile-switch reactivity once, right after the store exists: whenever
// `useAuthStore`'s active profile changes (login, the boot reconcile, an
// explicit switch, or the delete-fallback in `refreshProfiles`), pull that
// profile's preferences (boot cache first for an instant paint, then the
// server fetch) and push them in here. This is the ONLY place that happens —
// no router/header/picker code needs to call anything for a switch to work.
initPreferencesSync(
  {
    applyPreferences: (prefs) =>
      useReaderStore.setState(() => ({
        // Resolve against the hard defaults, NOT the currently-showing state.
        // A profile that has never set a theme must present the app default
        // when switched to, not whatever the PREVIOUS profile had on screen —
        // "keep whatever's already showing" here would leave Bob looking dark
        // forever after switching away from a profile that picked dark, since
        // Bob's `{}` would never actively overwrite it.
        theme: prefs.theme ?? "light",
        fontSettings: { ...DEFAULT_FONT_SETTINGS, ...prefs.fontSettings },
        pageMode: prefs.pageMode ?? "paged",
        tocSidebarOpen: prefs.tocSidebarOpen ?? false,
      })),
  },
  bootProfileId,
);
