/**
 * The shared-layout id for the cover → reader transition (design.md "Motion":
 * "Cover expands into the page", 420ms, Motion Primitives shared layout —
 * the reader's Reading Room pass's spec). Both ends of the morph must use the EXACT same string —
 * `library/CoverCard.tsx`'s cover art and this reader route's
 * opening-screen `BookCoverTile` — so it's factored out to one place instead
 * of two hand-typed template literals silently drifting apart.
 */
export function coverLayoutId(bookId: string): string {
  return `book-cover-${bookId}`;
}
