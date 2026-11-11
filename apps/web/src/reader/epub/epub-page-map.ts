import ePub from "epubjs";
import type { Rendition } from "epubjs";

/**
 * Accurate, book-wide page numbering for reflowable EPUB (research: option 3).
 *
 * A reflowable book has no intrinsic pages — a "page" is `sectionWidth /
 * columnWidth` computed only AFTER a chapter is laid out. epub.js exposes that
 * per-chapter count as `currentLocation().start.displayed.total`, but it resets
 * at every chapter boundary. To get a smooth, book-wide "Page N / M" that ticks
 * by exactly 1 per screen turn, we pre-paginate every spine item and build a
 * prefix sum of per-chapter page counts.
 *
 * The count is width/height-sensitive (epub.js #274: a stage that differs by
 * even 1px can report a different page total for a section). So the walk renders
 * a throwaway Book — parsed from the SAME bytes — into an OFF-SCREEN stage sized
 * to exactly match the visible reader's stage, with the same theme + font
 * settings applied. Because the measuring rendition is fully detached, the walk
 * never moves the page the user is reading: the reader shows the resume position
 * immediately and this runs in the background (see EpubReader).
 */

export interface EpubPageMap {
  /** Book-wide page count before spine item `i`, indexed by spine index. */
  offsets: number[];
  /** Per spine index: that chapter's rendered page count (≥ 1). */
  counts: number[];
  /** Total rendered pages across the whole book at the current layout. */
  total: number;
}

/** Pixel size of a rendition's paginated stage (one column, `spread: none`). */
export interface StageSize {
  width: number;
  height: number;
}

interface DisplayedLoc {
  start?: {
    index?: number;
    cfi?: string;
    displayed?: { page?: number; total?: number };
  };
}

function readLoc(rendition: Rendition): DisplayedLoc | null {
  try {
    // The default (paginated) manager returns this synchronously.
    return rendition.currentLocation() as unknown as DisplayedLoc;
  } catch {
    return null;
  }
}

/** Current stage width/height, read loosely from the manager's layout. */
export function stageSize(rendition: Rendition): StageSize {
  const m = rendition as unknown as {
    manager?: {
      layout?: { width?: number; height?: number; pageWidth?: number };
      stage?: { stageSize?: () => { width?: number; height?: number } };
    };
  };
  const s = m.manager?.stage?.stageSize?.();
  const width = m.manager?.layout?.pageWidth ?? m.manager?.layout?.width ?? s?.width ?? -1;
  const height = m.manager?.layout?.height ?? s?.height ?? -1;
  return { width, height };
}

const raf = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 40)));

/**
 * Wait until the visible reader's stage stops changing, then return its size.
 * On mount the column animates/settles to its final (max-width-capped) size;
 * measuring against a transient stage yields a wrong total that then "jumps"
 * when corrected. Poll until two consecutive frames agree.
 */
export async function settledStageSize(rendition: Rendition): Promise<StageSize> {
  let last: StageSize = { width: -1, height: -1 };
  for (let i = 0; i < 25; i++) {
    const s = stageSize(rendition);
    if (s.width > 0 && s.width === last.width && s.height === last.height) return s;
    last = s;
    await raf();
  }
  return last;
}

/**
 * Pre-paginate the whole book OFF-SCREEN and build the page map. Parses an
 * independent Book from `data` and renders it into a detached, zero-visibility
 * stage sized to `size`, so the walk never touches the visible reader. The
 * throwaway rendition/book are always destroyed before returning.
 *
 * @param data   the EPUB bytes (same buffer the visible reader was given).
 * @param size   the visible reader's settled stage size (must match, or counts
 *               disagree with the on-screen pages — epub.js #274).
 * @param applyStyles applies the active theme + font settings to the measuring
 *               rendition, so it lays out identically to the visible one.
 * @param onProgress reports `(done, total)` sections as the walk proceeds.
 */
export async function buildPageMapDetached(
  data: ArrayBuffer,
  size: StageSize,
  applyStyles: (rendition: Rendition) => void,
  onProgress?: (done: number, total: number) => void,
): Promise<EpubPageMap> {
  // A degenerate stage (≈zero width/height) can't be paginated meaningfully;
  // bail with a single-page map. The caller recomputes once the layout is real.
  if (size.width <= 1 || size.height <= 1) {
    return { offsets: [0], counts: [1], total: 1 };
  }

  const width = Math.round(size.width);
  const height = Math.round(size.height);

  // Off-screen, laid-out-but-invisible container (visibility:hidden keeps
  // layout so epub.js can still measure; display:none would report zero size).
  const container = document.createElement("div");
  container.setAttribute("aria-hidden", "true");
  Object.assign(container.style, {
    position: "fixed",
    left: "-99999px",
    top: "0px",
    width: `${width}px`,
    height: `${height}px`,
    visibility: "hidden",
    pointerEvents: "none",
  });
  document.body.appendChild(container);

  const book = ePub(data);
  let rendition: Rendition | null = null;
  try {
    rendition = book.renderTo(container, {
      flow: "paginated",
      spread: "none",
      width,
      height,
    });
    // Apply theme/font BEFORE the first layout so every measured section is
    // paginated against the same metrics the reader shows.
    applyStyles(rendition);
    await rendition.display();
    await book.ready;

    // `spineItems` exists at runtime but isn't in epub.js's TS types.
    const spine = book.spine as unknown as {
      spineItems?: Array<{ index?: number; href: string }>;
    };
    const items = spine.spineItems ?? [];

    const counts: number[] = [];
    let maxIndex = 0;
    for (let i = 0; i < items.length; i++) {
      const section = items[i];
      const idx = typeof section.index === "number" ? section.index : i;
      maxIndex = Math.max(maxIndex, idx);

      await rendition.display(section.href);
      const total = readLoc(rendition)?.start?.displayed?.total;
      // Guard against a degenerate layout reporting a non-finite/absurd count —
      // clamp to ≥ 1 so the book total can never come out as Infinity/NaN.
      counts[idx] = Number.isFinite(total) && (total as number) > 0 ? (total as number) : 1;

      onProgress?.(i + 1, items.length);
    }

    const offsets: number[] = [];
    let acc = 0;
    for (let i = 0; i <= maxIndex; i++) {
      offsets[i] = acc;
      acc += counts[i] ?? 1;
    }

    return { offsets, counts, total: Math.max(acc, 1) };
  } finally {
    // Tear the throwaway rendition/book down so its iframes + listeners don't
    // leak (this runs on every recompute — font change, resize).
    try {
      rendition?.destroy();
    } catch {
      /* best-effort cleanup */
    }
    try {
      (book as unknown as { destroy(): void }).destroy();
    } catch {
      /* best-effort cleanup */
    }
    container.remove();
  }
}

/** The relevant fields of a `relocated` event payload / current location. */
export interface LocationLike {
  start?: { index?: number; displayed?: { page?: number } };
}

/**
 * Book-wide page number for a location, given the page map (clamped).
 *
 * Takes the location OBJECT (the `relocated` event payload) rather than reading
 * `rendition.currentLocation()` fresh: right after a page turn `currentLocation`
 * can transiently return the previous/intermediate view, which made the counter
 * jump backward then forward (e.g. 33 → 25 → 36). The event payload is the
 * settled position, so the count moves monotonically.
 */
export function bookPageFromLocation(loc: LocationLike | null | undefined, map: EpubPageMap): number | null {
  const idx = loc?.start?.index;
  if (typeof idx !== "number") return null;
  const displayedPage = loc?.start?.displayed?.page ?? 1;
  const offset = map.offsets[idx] ?? 0;
  return Math.min(Math.max(offset + displayedPage, 1), map.total);
}
