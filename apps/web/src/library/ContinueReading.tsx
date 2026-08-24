import { useState } from "react";
import type { LibraryBook } from "@ebook-reader/shared";

import { CoverArt } from "./CoverCard";

/** How many resume candidates the strip shows at once (design.md: "Continue is the hero"). */
const RESUME_LIMIT = 3;

/**
 * Rough reading-speed constants for the book time-remaining estimate (see
 * {@link estimateBookMinutesRemaining}) — there is no page count on the wire
 * (`LibraryBook` carries `sizeBytes`, not pages; adding one is a shared-schema
 * + backend change out of this brief's scope), so size stands in for it.
 */
const ASSUMED_BYTES_PER_PAGE = 2000; // a text-dominant EPUB/PDF page, roughly
const ASSUMED_MINUTES_PER_PAGE = 1.2; // ~250 wpm at ~300 words/page
/** Ceiling so an image-heavy PDF (size wildly overstating page count) still
 *  reports something plausible rather than "38 hours left". */
const MAX_ESTIMATED_MINUTES = 20 * 60;

/**
 * The "Continue" resume strip — the first thing a returning user sees
 * (library home hierarchy fix: for an established library the primary job is
 * *resume the last thing you were in*, not upload). Brief 29 reworks the
 * former single hero card into a **three-up strip**: up to
 * {@link RESUME_LIMIT} most-recently-opened, unfinished items, each showing
 * artwork, title, source, **time remaining** (not percent — D33 grilled
 * decision) and a 3px progress bar. The whole card is a single button (no
 * nested interactive elements).
 *
 * Renders nothing when no candidate exists (empty library, nothing started,
 * or everything finished) — the shelf grid is the hero in that case.
 */
export function ContinueReading({
  books,
  onOpen,
}: {
  books: LibraryBook[];
  onOpen: (book: LibraryBook) => void;
}) {
  if (books.length === 0) return null;

  return (
    <section aria-label="Continue" className="flex flex-col gap-3">
      <h2 className="font-ui text-xs font-semibold tracking-[0.15em] text-ink-variant uppercase">
        Continue
      </h2>
      <div className="grid grid-cols-1 gap-gutter sm:grid-cols-3">
        {books.map((book) => (
          <ResumeCard key={book.id} book={book} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

function ResumeCard({
  book,
  onOpen,
}: {
  book: LibraryBook;
  onOpen: (book: LibraryBook) => void;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const kind = book.kind ?? "book";
  const pct = Math.round(book.progress * 100);
  const remaining = formatTimeRemaining(book);
  // Thumb matches the item's card shape (brief 25): square art for music,
  // 16:9 for video, 2:3 for a book.
  const thumbAspect = kind === "audio" ? "aspect-square" : kind === "video" ? "aspect-video" : "aspect-[2/3]";

  return (
    <button
      type="button"
      onClick={() => onOpen(book)}
      aria-label={`Resume ${book.title}${remaining ? `, ${remaining}` : ""}`}
      className="group flex w-full items-center gap-4 rounded-card border border-line-soft bg-paper-raised p-3 text-left shadow-l1 transition-[transform,box-shadow] duration-300 ease-paper motion-safe:hover:-translate-y-1 motion-safe:hover:shadow-lift focus-visible:outline-2 focus-visible:outline-accent"
    >
      <span className={`relative block ${thumbAspect} w-16 shrink-0 overflow-hidden rounded-cover bg-paper-container shadow-[0_8px_16px_-6px_rgba(28,27,27,0.18)] ring-1 ring-line-soft/40`}>
        <CoverArt book={book} imgFailed={imgFailed} onImgError={() => setImgFailed(true)} />
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-1">
        {/* Card title role (design.md "Typography"): Archivo 600 — see
            CoverCard for why the reading-pane Newsreader doesn't apply here. */}
        <span className="line-clamp-1 font-ui text-base leading-snug font-semibold tracking-[-0.01em] text-ink">
          {book.title}
        </span>
        {book.author && (
          <span className="truncate text-sm text-ink-variant">{book.author}</span>
        )}

        <span className="mt-1 flex items-center gap-2.5">
          <span className="h-[3px] max-w-40 flex-1 overflow-hidden rounded-full bg-ink/10">
            <span className="block h-full bg-accent" style={{ width: `${pct}%` }} />
          </span>
          {/* Time remaining, not percent (D33 grilled decision) — `tabular-nums`
              is already on `body`, so the figure lines up with no extra work. */}
          <span className="shrink-0 font-ui text-xs text-ink-variant">{remaining}</span>
        </span>
      </span>
    </button>
  );
}

/**
 * Pick up to {@link RESUME_LIMIT} resume candidates: items that are actually
 * in progress (0 < progress < 1) and have been opened at least once, most
 * recently opened first. Finished and never-opened items don't qualify.
 * Independent of the gallery's sort order on purpose — sorting the shelf by
 * title shouldn't change what you were last in.
 */
export function pickResumeBooks(books: LibraryBook[], limit: number = RESUME_LIMIT): LibraryBook[] {
  return books
    .filter((b) => b.lastOpenedAt && b.progress > 0 && b.progress < 1)
    .sort((a, b) => (b.lastOpenedAt ?? "").localeCompare(a.lastOpenedAt ?? ""))
    .slice(0, limit);
}

/**
 * Time remaining for a resume card, or `null` for "not started" (the caller
 * only renders started, unfinished items, but a `durationSeconds`-less
 * audio/video row can still land here with an unknowable remaining time).
 *
 * - Music/video: `durationSeconds * (1 - progress)` — exact, since both
 *   inputs come straight off the wire.
 * - Books: there is no page count on the wire (see the module-level
 *   constants above for why), so total reading time is ESTIMATED from
 *   `sizeBytes` — assume ~2000 bytes of text per page and ~1.2 minutes of
 *   reading per page (≈250 wpm at ≈300 words/page), then take the
 *   `(1 - progress)` slice of that. This is a rough order-of-magnitude
 *   estimate, not a real page count — clamped so an image-heavy PDF can't
 *   report something absurd.
 */
export function formatTimeRemaining(book: LibraryBook): string {
  if (book.progress <= 0) return "Not started";

  const totalMinutes =
    book.kind === "audio" || book.kind === "video"
      ? book.durationSeconds != null
        ? book.durationSeconds / 60
        : null
      : Math.min(
          MAX_ESTIMATED_MINUTES,
          (book.sizeBytes / ASSUMED_BYTES_PER_PAGE) * ASSUMED_MINUTES_PER_PAGE,
        );

  if (totalMinutes == null) return "In progress";

  const remainingMinutes = Math.max(1, Math.round(totalMinutes * (1 - book.progress)));
  return `${formatMinutes(remainingMinutes)} left`;
}

function formatMinutes(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 1) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}
