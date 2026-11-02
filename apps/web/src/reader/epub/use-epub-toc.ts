import { useMemo } from "react";
import type { NavItem } from "epubjs";

import type { TocEntry } from "../chrome";

/**
 * Flattens epub.js navigation (`book.navigation.toc`, delivered by react-reader
 * via `tocChanged`) into the shared `TocEntry[]` the chrome `TocDrawer`
 * consumes (the EPUB reader TOC step). Each entry's opaque `target` is the nav `href`,
 * which the EPUB reader resolves with `rendition.display(href)`.
 *
 * epub.js nests chapters via `subitems`; we flatten depth-first and carry a
 * `depth` for the drawer's indentation, mirroring how the PDF outline hook
 * shapes its entries.
 */
export function useEpubToc(toc: NavItem[]): TocEntry[] {
  return useMemo(() => {
    const flat: TocEntry[] = [];
    let counter = 0;

    const walk = (items: NavItem[], depth: number) => {
      for (const item of items) {
        flat.push({
          id: `epub-toc-${counter++}`,
          label: item.label.trim(),
          depth,
          target: item.href, // resolved via rendition.display(href)
        });
        if (item.subitems && item.subitems.length > 0) {
          walk(item.subitems, depth + 1);
        }
      }
    };

    walk(toc, 0);
    return flat;
  }, [toc]);
}
