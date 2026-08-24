import type { ReactNode } from "react";
import type { LibraryBook } from "@ebook-reader/shared";

import type { BookGroup } from "./grouping";

/**
 * The drilled Stacks page (brief 21 step 5): opening a stack shows only that
 * group — a "← All books" way back (a link, so accent is allowed here), the
 * group name as a Newsreader heading, `label-caps` meta (count + in-progress),
 * and a flat cover grid of just this group, rendered with the same `renderCover`
 * as everywhere else.
 */
export function GroupDetail({
  group,
  onBack,
  renderCover,
}: {
  group: BookGroup;
  onBack: () => void;
  renderCover: (book: LibraryBook) => ReactNode;
}) {
  const inProgress = group.books.filter((b) => b.progress > 0).length;

  return (
    <div className="flex flex-col gap-5">
      <button
        type="button"
        onClick={onBack}
        className="flex w-fit items-center gap-1.5 font-ui text-sm font-medium text-accent transition hover:opacity-80 focus-visible:outline-2 focus-visible:outline-accent"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="h-4 w-4" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 6l-6 6 6 6" />
        </svg>
        All books
      </button>

      <div className="flex flex-col gap-1">
        <h2 className="font-display text-3xl font-semibold text-ink">{group.label}</h2>
        <p className="font-ui text-xs font-semibold tracking-[0.08em] text-ink-variant uppercase">
          {group.books.length} {group.books.length === 1 ? "book" : "books"}
          {inProgress > 0 && <> &middot; {inProgress} in progress</>}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3 lg:grid-cols-5">
        {group.books.map(renderCover)}
      </div>
    </div>
  );
}
