import type { LibraryBook, LibraryGroup } from "@ebook-reader/shared";

/**
 * Library **metadata accessors** over the backfilled `author` / `series` /
 * `subjects` columns.
 *
 * Brief 28 (D33h) removed the grouping *UI* — Shelves ⇄ Stacks, the fanned
 * stack index and the `?g` drill-in are gone, and the home is one flat grid
 * filtered by kind. This module deliberately **survives** the deletion: the
 * columns stay populated, and brief 30 reuses these accessors to build search
 * facets over the same values the shelves used to bucket by. Nothing renders
 * them today, so treat them as a library, not as dead code.
 *
 * A `BookGroup` is one bucket of the library: a stable case-folded `key`, a
 * display `label`, and the bucket's books in render order.
 *
 * Rules:
 * - Bucket key = the **first** value: `author` (single-valued), `series`, or the
 *   first `subjects[]` entry. A missing/blank value → the "Unknown" bucket.
 * - Bucketing is on a trimmed + case-folded key, so "Science Fiction" and
 *   "science fiction" (or a trailing-space variant) land together; the bucket's
 *   `label` is the first-encountered original spelling.
 * - The "Unknown" bucket always sorts **last**; all other buckets are
 *   alphabetical (case-insensitive, locale-aware).
 * - Within a **series** bucket, books order by `seriesIndex` ascending with
 *   nulls last; every other bucket preserves the incoming order (the list is
 *   already sorted server-side by the active sort).
 *
 * Tolerant of pre-brief-21 cached rows (offline fallback) whose `series` /
 * `subjects` fields predate the contract: absent values read as "Unknown".
 */

export interface BookGroup {
  /** Stable identity: the case-folded group value ("Unknown" for the catch-all). Used as `?g`. */
  key: string;
  /** Display label: the first-encountered original spelling for `key`. */
  label: string;
  /** The group's books, in render order (series → by index; else incoming order). */
  books: LibraryBook[];
}

/** The catch-all bucket's key/label for books missing the value. */
export const UNKNOWN_GROUP = "Unknown";

/**
 * The first non-empty value of one metadata field for a book, or null when it
 * has none. Exported for brief 30: this is the single definition of "what value
 * does this book have for author / series / subject", so search facets and the
 * bucketing below can never disagree.
 */
export function groupValueOf(book: LibraryBook, groupBy: Exclude<LibraryGroup, "none">): string | null {
  if (groupBy === "author") {
    const author = book.author?.trim();
    return author ? author : null;
  }
  if (groupBy === "series") {
    const series = book.series?.trim();
    return series ? series : null;
  }
  // subject: first tag (multi-valued → one appearance per book).
  const first = book.subjects?.find((s) => s.trim().length > 0);
  return first ? first.trim() : null;
}

/**
 * Bucket `books` (already sorted by the active sort) by `groupBy`. Returns the
 * buckets in render order. `groupBy === "none"` yields a single un-labelled
 * bucket of all books — a defensive identity for callers that pass the field
 * through without branching.
 */
export function groupBooks(books: LibraryBook[], groupBy: LibraryGroup): BookGroup[] {
  if (groupBy === "none") {
    return [{ key: "", label: "", books }];
  }

  // Bucket on a trimmed + case-folded key so e.g. "Science Fiction" and
  // "science fiction " land in the same bucket; the bucket keeps the
  // first-encountered original spelling as its display label. `key` is the
  // stable identity a caller can round-trip through a URL or a facet id (it was
  // the `?g` drill-in param before brief 28 removed the grouping UI).
  const byKey = new Map<string, { label: string; books: LibraryBook[] }>();
  for (const book of books) {
    const raw = groupValueOf(book, groupBy);
    const label = raw ?? UNKNOWN_GROUP;
    const key = raw ? raw.toLocaleLowerCase() : UNKNOWN_GROUP;
    const bucket = byKey.get(key);
    if (bucket) bucket.books.push(book);
    else byKey.set(key, { label, books: [book] });
  }

  const groups: BookGroup[] = Array.from(byKey, ([key, { label, books: groupBooksList }]) => ({
    key,
    label,
    books:
      groupBy === "series" ? orderBySeriesIndex(groupBooksList) : groupBooksList,
  }));

  groups.sort((a, b) => {
    // "Unknown" always last.
    if (a.key === UNKNOWN_GROUP) return b.key === UNKNOWN_GROUP ? 0 : 1;
    if (b.key === UNKNOWN_GROUP) return -1;
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  });

  return groups;
}

/** Order a series group by `seriesIndex` ascending, nulls last (stable otherwise). */
function orderBySeriesIndex(books: LibraryBook[]): LibraryBook[] {
  return books
    .map((book, i) => ({ book, i }))
    .sort((a, b) => {
      const ai = a.book.seriesIndex;
      const bi = b.book.seriesIndex;
      if (ai == null && bi == null) return a.i - b.i;
      if (ai == null) return 1;
      if (bi == null) return -1;
      return ai - bi || a.i - b.i;
    })
    .map((entry) => entry.book);
}
