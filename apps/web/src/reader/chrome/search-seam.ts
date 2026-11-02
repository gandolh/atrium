/**
 * ─────────────────────────────────────────────────────────────────────────────
 * IN-BOOK SEARCH SEAM  (stub — the EPUB reader completes this)
 * ─────────────────────────────────────────────────────────────────────────────
 * In-book search IS in v1 (decisions.md D19), but per this brief's scope brief
 * 07 OWNS the shared search UI and implements search for BOTH formats. The PDF reader
 * only guarantees the text layer is available so search is *possible* (the PDF
 * reader renders `<Page renderTextLayer />`, which produces selectable,
 * searchable DOM text; PDF.js `page.getTextContent()` is also available).
 *
 * This file defines the minimal, format-agnostic contract the EPUB reader will build
 * the search box + result navigation against. It is intentionally tiny and
 * unimplemented — do not add search logic here; wire it up in the EPUB reader.
 */

/** A single match, with an opaque jump target the reader knows how to resolve. */
export interface SearchMatch {
  /** The matched snippet (for the results list). */
  excerpt: string;
  /** e.g. page number (PDF) or CFI (EPUB) — resolved by the reader. */
  target: unknown;
  /**
   * Optional short human label giving the match context in the results list
   * (additive): PDF sets `"Page N"`; EPUB sets the chapter/spine
   * label. Purely cosmetic — the reader still jumps via `target`.
   */
  label?: string;
}

/**
 * Search provider each reader supplies to the shared search UI.
 * PDF implements this via PDF.js `getTextContent()` across pages; EPUB via
 * epub.js `book.search()`. Left unimplemented in the PDF reader by design.
 */
export interface SearchProvider {
  search(query: string): Promise<SearchMatch[]>;
}
