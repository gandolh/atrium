import type { LibraryBook } from "@ebook-reader/shared";

import { groupValueOf } from "./grouping";

/**
 * Cross-library search (brief 30): a plain, client-side match over the
 * already-loaded library list — closes the fault that search only worked
 * in-book. No new endpoint (client-side over the loaded list, per the grilled
 * decision), so this also works offline against the cached snapshot for free:
 * it never does anything but read fields off `LibraryBook[]`.
 *
 * Fields searched: title, author, series, every subject tag, and format.
 * "Artist" and "album" from the brief aren't separate columns — `extract.ts`
 * already folds ID3 `artist`→`author` and `album`→`series` at import time, so
 * routing author/series through `groupValueOf` (the one accessor for those
 * fields, kept in `grouping.ts`) covers music without a special case.
 */

/**
 * Case- and diacritic-fold one string for matching, e.g. "Rådiohead" and
 * "RADIOHEAD" both fold to "radiohead". NFD splits a base letter from its
 * combining diacritic mark; stripping `\p{Diacritic}` drops the mark and
 * leaves the plain letter.
 */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase();
}

/** Split a folded string into non-empty whitespace-separated tokens. */
function tokenize(value: string): string[] {
  return fold(value).split(/\s+/).filter(Boolean);
}

/** The searchable text fields for one book, unfolded (folding happens in `tokenize`). */
function searchableFields(book: LibraryBook): string[] {
  // `subjects` is defensively optional-chained for the same reason `grouping.ts`
  // does it: the IndexedDB snapshot path is not zod-parsed on read, so a row
  // cached by a pre-brief-21 build can reach here without the field at all —
  // and spreading `undefined` would throw on the first keystroke, offline.
  const fields = [book.title, book.format, ...(book.subjects ?? [])];
  const author = groupValueOf(book, "author");
  const series = groupValueOf(book, "series");
  if (author) fields.push(author);
  if (series) fields.push(series);
  return fields;
}

/**
 * Whether `book` matches `query`. The query is split into whitespace-
 * separated terms; every term must be a **prefix** of some token drawn from
 * title/author/series/subjects/format (so "rad" finds "Radiohead", and a
 * multi-word query like "mist sanderson" ANDs its terms rather than requiring
 * an exact phrase — it finds a "Mistborn" book by "Brandon Sanderson"). Case-
 * and diacritic-insensitive throughout. An empty/blank query matches everything.
 */
export function matchesQuery(book: LibraryBook, query: string): boolean {
  const terms = tokenize(query);
  if (terms.length === 0) return true;
  const tokens = searchableFields(book).flatMap(tokenize);
  return terms.every((term) => tokens.some((token) => token.startsWith(term)));
}
