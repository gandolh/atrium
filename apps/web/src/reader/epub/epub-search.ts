import type { Book, NavItem } from "epubjs";

import type { SearchMatch, SearchProvider } from "../chrome";

/**
 * EPUB in-book search provider (D19). Implements the shared
 * `SearchProvider` contract against epub.js.
 *
 * Strategy — spine walk (the epub.js idiom): iterate every spine `Section`,
 * `load()` its document (fetched from the in-memory archive — no network),
 * run the section's built-in `find(query)` (which returns `{cfi, excerpt}`
 * pairs — the runtime shape; epub.js's own `.d.ts` mistypes it as `Element[]`),
 * then `unload()` to release the document. This mirrors epub.js's own
 * `Book.search()` example and keeps memory bounded (one section resident at a
 * time). Matches carry the CFI as the opaque `target` so `SearchPanel` → the
 * reader can `rendition.display(cfi)` to jump.
 */

/** Runtime shape of `Section.find` results (see note above). */
interface EpubFindMatch {
  cfi: string;
  excerpt: string;
}

interface SectionLike {
  load(request?: unknown): Promise<Document> | Document;
  find(query: string): EpubFindMatch[];
  unload(): void;
  href?: string;
}

/**
 * Build a label lookup (spine href → chapter title) from the nav TOC so each
 * result can show which chapter it's in. Best-effort: sections without a TOC
 * entry just get no label.
 */
function buildHrefLabels(toc: NavItem[]): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (items: NavItem[]) => {
    for (const item of items) {
      if (item.href) {
        // Strip any in-page anchor so it matches the spine href. Nav hrefs can
        // be relative to the nav doc while spine hrefs are package-relative,
        // so also index by bare filename for suffix matching in the lookup.
        const base = item.href.split("#")[0];
        if (base && !map.has(base)) map.set(base, item.label.trim());
        const name = base?.split("/").pop();
        if (name && !map.has(name)) map.set(name, item.label.trim());
      }
      if (item.subitems && item.subitems.length > 0) walk(item.subitems);
    }
  };
  walk(toc);
  return map;
}

/** Look up a chapter label for a spine href, tolerating path-relative TOCs. */
function labelForHref(
  hrefLabels: Map<string, string>,
  href: string | undefined,
): string | undefined {
  if (!href) return undefined;
  const base = href.split("#")[0];
  return hrefLabels.get(base) ?? hrefLabels.get(base.split("/").pop() ?? "");
}

export function createEpubSearchProvider(book: Book): SearchProvider {
  return {
    async search(query: string): Promise<SearchMatch[]> {
      // Ensure the book (and thus its spine + navigation) is parsed.
      await book.ready;

      let hrefLabels = new Map<string, string>();
      try {
        const nav = await book.loaded.navigation;
        hrefLabels = buildHrefLabels(nav.toc);
      } catch {
        // No nav / TOC — proceed without chapter labels.
      }

      const results: SearchMatch[] = [];
      // epub.js `spine.each` iterates the Section list synchronously; collect
      // then process so we can await each section's load.
      const sections: SectionLike[] = [];
      // `spine.each` is typed loosely (`...args: any[]`); use it to gather.
      book.spine.each((section: SectionLike) => {
        sections.push(section);
      });

      const MAX_RESULTS = 400; // Guard against pathological single-letter queries.

      for (const section of sections) {
        try {
          await section.load(book.load.bind(book));
          const found = section.find(query);
          if (found.length > 0) {
            const label = labelForHref(hrefLabels, section.href);
            for (const m of found) {
              results.push({ excerpt: m.excerpt, target: m.cfi, label });
              if (results.length >= MAX_RESULTS) break;
            }
          }
        } catch {
          // Skip sections that fail to load/parse — keep searching the rest.
        } finally {
          try {
            section.unload();
          } catch {
            /* ignore */
          }
        }
        if (results.length >= MAX_RESULTS) break;
      }

      return results;
    },
  };
}
