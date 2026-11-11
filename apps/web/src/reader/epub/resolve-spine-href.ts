import type { Book } from "epubjs";

/**
 * Resolve a TOC/nav href against the book's spine.
 *
 * EPUB3 nav-doc hrefs are relative to the nav document itself (e.g.
 * `cover.xhtml` inside `Text/toc.xhtml`), while epub.js spine items are keyed
 * by their canonical, package-relative href (`Text/cover.xhtml`). epub.js does
 * NOT normalise this, so `rendition.display(navHref)` throws "No Section
 * Found" for books whose nav doc lives in a subdirectory. Resolve by exact
 * spine lookup first, then by filename suffix match.
 */
export function resolveSpineHref(book: Book, href: string): string | null {
  const [file, anchor] = href.split("#");

  const spine = book.spine as unknown as {
    get(target: string): unknown;
    spineItems?: Array<{ href?: string }>;
  };

  try {
    if (file && spine.get(file)) return href;
  } catch {
    /* fall through to suffix matching */
  }

  const items = spine.spineItems ?? [];
  const match = items.find((item) => item.href === file || (item.href?.endsWith(`/${file}`) ?? false));
  if (match?.href) return anchor ? `${match.href}#${anchor}` : match.href;

  return null;
}
