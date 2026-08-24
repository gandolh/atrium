import { useState } from "react";
import type { LibraryBook } from "@ebook-reader/shared";

import { CoverArt } from "./CoverCard";
import type { BookGroup } from "./grouping";

/**
 * Stacks index (brief 21 step 5): the gallery becomes an index of fanned cover
 * stacks — each group's **first** cover with offset paper-edge layers behind it
 * (`paper-container-high` + hairline, 2px radius), the group name in Newsreader
 * and a `label-caps` count beneath. Stacks are real `<button>`s; activating one
 * routes to the drilled `GroupDetail` page (via `onOpen`, which sets `?g`).
 */
export function StackIndex({
  groups,
  onOpen,
}: {
  groups: BookGroup[];
  onOpen: (groupKey: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-9 sm:grid-cols-3 lg:grid-cols-5">
      {groups.map((group) => (
        <button
          key={group.key}
          type="button"
          onClick={() => onOpen(group.key)}
          aria-label={`${group.label}, ${group.books.length} books`}
          className="group flex flex-col gap-3 rounded text-left focus-visible:outline-2 focus-visible:outline-accent"
        >
          {/* Fanned stack: paper-edge layers peek out bottom-right behind the
              first cover, so the group reads as a bound stack of books. */}
          <div className="relative aspect-[2/3] w-full transition duration-200 group-hover:-translate-y-1">
            <span
              aria-hidden
              className="absolute inset-0 translate-x-2 translate-y-2 rounded-(--radius-cover) border border-line-soft bg-paper-container-high"
            />
            <span
              aria-hidden
              className="absolute inset-0 translate-x-1 translate-y-1 rounded-(--radius-cover) border border-line-soft bg-paper-container-high"
            />
            <StackCover book={group.books[0]} />
          </div>

          <div className="min-w-0">
            <p
              title={group.label}
              className="line-clamp-2 font-display text-base leading-snug font-semibold text-ink"
            >
              {group.label}
            </p>
            <p className="font-ui text-xs font-semibold tracking-[0.08em] text-ink-variant uppercase">
              {group.books.length} {group.books.length === 1 ? "book" : "books"}
            </p>
          </div>
        </button>
      ))}
    </div>
  );
}

/**
 * The stack's top face — the group's first cover. A non-interactive render of
 * `CoverCard`'s cover art via the shared `CoverArt` (per-kind: full-bleed book
 * cover, audio square art centered on paper, video typographic fallback) so the
 * stack tile matches the gallery instead of cropping media art into 2:3, while
 * the stack button owns the only interactive element. Keeps the bottom-heavy
 * shadow so it sits above the fanned paper edges.
 */
function StackCover({ book }: { book: LibraryBook }) {
  const [imgFailed, setImgFailed] = useState(false);

  return (
    <span className="absolute inset-0 overflow-hidden rounded-(--radius-cover) bg-paper-container shadow-[0_8px_16px_-6px_rgba(28,27,27,0.18)] ring-1 ring-line-soft/40 transition duration-200 group-hover:shadow-[0_14px_24px_-8px_rgba(28,27,27,0.28)]">
      <CoverArt book={book} imgFailed={imgFailed} onImgError={() => setImgFailed(true)} />
    </span>
  );
}
