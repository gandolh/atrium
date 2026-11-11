import type { PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";

import type { SearchMatch, SearchProvider } from "../chrome";

/**
 * PDF in-book search provider (D19). Implements the shared
 * `SearchProvider` contract against the PDF.js text layer.
 *
 * STRATEGY — search-on-demand (resolved open question: index-on-load vs
 * on-demand). We do NOT pre-index the whole document on load; instead, when the
 * user searches, we walk pages calling `page.getTextContent()`, join the text
 * items into a per-page string, and scan for the query. Rationale:
 *   - No upfront cost: opening a large PDF stays instant; the (rarer) search
 *     pays its own way. Indexing every page's text on load would add latency
 *     and memory to the common "just read" path for a feature used occasionally.
 *   - PDF.js caches `getTextContent()` per page, so a second search of the same
 *     page is cheap — we get incremental caching for free without owning an index.
 *   - Matches carry the 1-based page number as the opaque `target`, so
 *     `SearchPanel` → `PdfReader` jumps by setting the current page.
 */

// Chars of context to show around a match in the results list.
const EXCERPT_RADIUS = 60;
const MAX_RESULTS = 400;

export function createPdfSearchProvider(doc: PDFDocumentProxy): SearchProvider {
  return {
    async search(query: string): Promise<SearchMatch[]> {
      const needle = query.toLowerCase();
      const results: SearchMatch[] = [];

      for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
        let page;
        try {
          page = await doc.getPage(pageNum);
          const content = await page.getTextContent();
          // Join text items with spaces; PDF text items are word/line fragments.
          const text = content.items.map((item) => ("str" in item ? (item as TextItem).str : "")).join(" ");
          const haystack = text.toLowerCase();

          let from = 0;
          let idx = haystack.indexOf(needle, from);
          while (idx !== -1) {
            const start = Math.max(0, idx - EXCERPT_RADIUS);
            const end = Math.min(text.length, idx + needle.length + EXCERPT_RADIUS);
            const prefix = start > 0 ? "…" : "";
            const suffix = end < text.length ? "…" : "";
            results.push({
              excerpt: `${prefix}${text.slice(start, end).trim()}${suffix}`,
              target: pageNum,
              label: `Page ${pageNum}`,
            });
            if (results.length >= MAX_RESULTS) return results;
            from = idx + needle.length;
            idx = haystack.indexOf(needle, from);
          }
        } catch {
          // Skip unreadable pages, keep scanning the rest.
        } finally {
          // Release the page's rendering resources; text content stays cached.
          page?.cleanup?.();
        }
      }

      return results;
    },
  };
}
