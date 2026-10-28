import { useState, type FormEvent, type RefObject } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LOOKUP_FIELDS,
  LOOKUP_SOURCE_NAMES,
  lookupFieldValue,
  type LibraryBook,
  type LookupCandidate,
  type LookupField,
  type LookupSource,
} from "@ebook-reader/shared";

import { coverUrl } from "../lib/library-api";
import { applyLookup, lookupCoverUrl, lookupErrorMessage, searchLookup } from "../lib/lookup-api";

/**
 * The Look up dialog (brief 100, D59): one item's metadata, looked up on
 * request. Opened from the tile menu (`CoverCard`) for music and books only.
 *
 * Two steps. **Search**: the title and the artist or author, filled from the
 * item, and the candidates the item's source found, each with its cover. The
 * first search runs as the dialog opens — the person asked for it by choosing
 * Look up. Further searches run on Enter or the Search button, never as you
 * type: the API holds MusicBrainz to a request a second, so keystrokes would
 * queue up and answer late. **Compare**: on picking a candidate, every field it
 * has a value for, with the item's current value beside the new one and a
 * tick (all ticked), then Apply. A field the candidate has nothing for is not
 * offered, so Apply never clears what the file gave.
 *
 * A failure says which source it could not reach, and nothing changes.
 */

/** Field names in the words of each kind: an mp3's author is its artist. */
const FIELD_LABELS: Record<"audio" | "book", Record<LookupField, string>> = {
  audio: { title: "Title", author: "Artist", series: "Album", seriesIndex: "Track", cover: "Cover" },
  book: { title: "Title", author: "Author", series: "Series", seriesIndex: "Number in series", cover: "Cover" },
};

const CAPS = "font-ui text-[10px] leading-[1.6] font-semibold tracking-[0.15em] text-ink-variant uppercase";
const INPUT =
  "h-9 w-full min-w-0 rounded-card border border-line bg-paper px-3 font-ui text-sm text-ink outline-none transition-colors placeholder:text-ink-variant/70 focus:border-accent";
const SECONDARY =
  "h-9 shrink-0 rounded-card border border-line px-3 font-ui text-sm font-medium text-ink transition-colors hover:bg-paper-low focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";
const PRIMARY =
  "h-9 shrink-0 rounded-card bg-ink-fill px-4 font-ui text-sm font-semibold text-on-ink-fill transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";

export function LookupDialog({
  book,
  source,
  open,
  onOpenChange,
  onClosed,
  returnFocus,
}: {
  book: LibraryBook;
  source: LookupSource;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After the close transition: the caller unmounts the dialog. */
  onClosed: () => void;
  /** Where focus lands on close: the tile's menu button. */
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const qc = useQueryClient();
  const kind = book.kind === "audio" ? "audio" : "book";
  const labels = FIELD_LABELS[kind];
  const sourceName = LOOKUP_SOURCE_NAMES[source];

  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author ?? "");
  const [picked, setPicked] = useState<LookupCandidate | null>(null);
  const [ticked, setTicked] = useState<Record<LookupField, boolean>>(noneTicked());
  /** Cover refs whose thumbnail would not load: no cover to show, or to offer. */
  const [noCover, setNoCover] = useState<ReadonlySet<string>>(new Set());

  // The search is a query keyed on what was last submitted: the first one,
  // from the item, runs as the dialog mounts. (A mutation fired from a mount
  // effect loses its observer under StrictMode's remount and never settles.)
  const [submitted, setSubmitted] = useState({ title: book.title, author: book.author ?? "" });
  const search = useQuery({
    queryKey: ["lookup-search", book.id, submitted.title, submitted.author],
    queryFn: ({ signal }) => searchLookup(book.id, submitted, signal),
    retry: false,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const searching = search.isFetching;
  const apply = useMutation({
    mutationFn: (candidate: LookupCandidate) =>
      applyLookup(book.id, {
        candidate,
        fields: Object.fromEntries(LOOKUP_FIELDS.filter((f) => ticked[f]).map((f) => [f, true])),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["library"] });
      onOpenChange(false);
    },
  });

  const onSearch = (event: FormEvent) => {
    event.preventDefault();
    if (searching || (!title.trim() && !author.trim())) return;
    if (title === submitted.title && author === submitted.author) void search.refetch();
    else setSubmitted({ title, author });
  };

  const pick = (candidate: LookupCandidate) => {
    apply.reset();
    setPicked(candidate);
    setTicked(
      Object.fromEntries(
        LOOKUP_FIELDS.map((field) => [field, offered(candidate, field, noCover)]),
      ) as Record<LookupField, boolean>,
    );
  };

  const markNoCover = (ref: string) => {
    setNoCover((prev) => new Set(prev).add(ref));
    if (picked?.coverRef === ref) setTicked((prev) => ({ ...prev, cover: false }));
  };

  const anyTicked = LOOKUP_FIELDS.some((field) => ticked[field]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        // A write in flight finishes before the dialog can go.
        if (!next && apply.isPending) return;
        onOpenChange(next);
      }}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) onClosed();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-md motion-safe:transition-opacity motion-safe:duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          finalFocus={returnFocus}
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[min(88vh,46rem)] w-[min(calc(100vw-2rem),36rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-card border border-line-soft bg-paper-raised text-ink shadow-lift outline-none motion-safe:transition-[opacity,scale] motion-safe:duration-200 motion-safe:ease-paper data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0"
        >
          <header className="flex flex-col gap-1 px-5 pt-5 pb-3">
            <p className={CAPS}>Look up on {sourceName}</p>
            <Dialog.Title className="line-clamp-2 font-display text-[27px] leading-[1.2] font-medium tracking-[-0.02em] text-ink">
              {book.title}
            </Dialog.Title>
            <Dialog.Description className="font-ui text-sm text-ink-variant">
              Atrium&rsquo;s server asks {sourceName} for you. Nothing changes until you apply.
            </Dialog.Description>
          </header>

          {picked === null ? (
            <>
              <form onSubmit={onSearch} className="flex flex-col gap-2 px-5 pb-3 sm:flex-row sm:items-end">
                <label className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className={CAPS}>{labels.title}</span>
                  <input value={title} onChange={(e) => setTitle(e.target.value)} className={INPUT} />
                </label>
                <label className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className={CAPS}>{labels.author}</span>
                  <input value={author} onChange={(e) => setAuthor(e.target.value)} className={INPUT} />
                </label>
                <button type="submit" disabled={searching} className={SECONDARY}>
                  Search
                </button>
              </form>

              <div
                aria-busy={searching}
                className="min-h-0 flex-1 overflow-y-auto border-t border-line-soft px-3 py-3"
              >
                <SearchState
                  searching={searching}
                  error={search.isError ? search.error : null}
                  empty={search.isSuccess && search.data.candidates.length === 0}
                  sourceName={sourceName}
                  source={source}
                />
                {!searching && search.isSuccess && search.data.candidates.length > 0 && (
                  <ul aria-label={`Matches on ${sourceName}`} className="flex flex-col">
                    {search.data.candidates.map((candidate, i) => (
                      <li key={`${candidate.sourceId}-${i}`}>
                        <button
                          type="button"
                          onClick={() => pick(candidate)}
                          className="flex w-full items-center gap-3 rounded-card px-2 py-2 text-left transition-colors hover:bg-paper-low focus-visible:outline-2 focus-visible:outline-accent"
                        >
                          <Thumb
                            kind={kind}
                            src={candidate.coverRef && !noCover.has(candidate.coverRef) ? lookupCoverUrl(source, candidate.coverRef) : null}
                            onError={() => candidate.coverRef && markNoCover(candidate.coverRef)}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-ui text-sm leading-snug font-semibold tracking-[-0.01em] text-ink">
                              {candidate.title}
                            </span>
                            <span className="block truncate text-sm text-ink-variant tabular-nums">
                              {describe(candidate, kind)}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <footer className="flex justify-end border-t border-line-soft px-5 py-3">
                <Dialog.Close className={SECONDARY}>Cancel</Dialog.Close>
              </footer>
            </>
          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto border-t border-line-soft px-5 py-4">
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-2 font-ui text-sm text-ink-variant">
                    Tick what to take from {sourceName}. Unticked fields stay as they are.
                  </legend>
                  <div aria-hidden className="grid grid-cols-[1rem_minmax(0,1fr)_minmax(0,1fr)] gap-x-3 px-3">
                    <span />
                    <span className={CAPS}>Now</span>
                    <span className={CAPS}>New</span>
                  </div>
                  {LOOKUP_FIELDS.filter((field) => offered(picked, field, noCover)).map((field) => (
                    <label
                      key={field}
                      className="grid cursor-pointer grid-cols-[1rem_minmax(0,1fr)_minmax(0,1fr)] items-start gap-x-3 rounded-card border border-line-soft px-3 py-2.5 transition-colors has-[:checked]:border-line has-[:checked]:bg-paper-low/60"
                    >
                      <input
                        type="checkbox"
                        checked={ticked[field]}
                        onChange={(e) => setTicked((prev) => ({ ...prev, [field]: e.target.checked }))}
                        aria-label={`Use the new ${labels[field].toLowerCase()}`}
                        className="mt-[3px] h-4 w-4 accent-accent"
                      />
                      <span className="col-span-2 flex flex-col gap-1">
                        <span className={CAPS}>{labels[field]}</span>
                        <span className="grid grid-cols-2 gap-x-3">
                          <FieldValue
                            field={field}
                            kind={kind}
                            tone="now"
                            text={currentText(book, field)}
                            image={field === "cover" && book.hasCover ? coverUrl(book.id, book.coverVersion) : null}
                          />
                          <FieldValue
                            field={field}
                            kind={kind}
                            tone="new"
                            text={newText(picked, field)}
                            image={field === "cover" && picked.coverRef ? lookupCoverUrl(source, picked.coverRef) : null}
                            onImageError={() => picked.coverRef && markNoCover(picked.coverRef)}
                          />
                        </span>
                      </span>
                    </label>
                  ))}
                </fieldset>
                {apply.isError && (
                  <p role="alert" className="mt-3 font-ui text-sm text-danger">
                    {lookupErrorMessage(apply.error, source)}
                  </p>
                )}
              </div>

              <footer className="flex items-center justify-between gap-2 border-t border-line-soft px-5 py-3">
                <button
                  type="button"
                  disabled={apply.isPending}
                  onClick={() => {
                    apply.reset();
                    setPicked(null);
                  }}
                  className={SECONDARY}
                >
                  Back to results
                </button>
                <button
                  type="button"
                  disabled={!anyTicked || apply.isPending}
                  onClick={() => apply.mutate(picked)}
                  className={PRIMARY}
                >
                  {apply.isPending ? "Applying…" : "Apply"}
                </button>
              </footer>
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function noneTicked(): Record<LookupField, boolean> {
  return { title: false, author: false, series: false, seriesIndex: false, cover: false };
}

/** Whether the compare step offers `field`: the candidate has a value (and, for a cover, one that loads). */
function offered(candidate: LookupCandidate, field: LookupField, noCover: ReadonlySet<string>): boolean {
  const value = lookupFieldValue(candidate, field);
  if (value === null) return false;
  return field !== "cover" || !noCover.has(String(value));
}

/** The candidate's second line: who, which album or series, which track, which year. */
function describe(candidate: LookupCandidate, kind: "audio" | "book"): string {
  const parts: string[] = [];
  if (candidate.author) parts.push(candidate.author);
  if (candidate.series) parts.push(candidate.series);
  if (candidate.seriesIndex !== null) parts.push(kind === "audio" ? `track ${candidate.seriesIndex}` : `#${candidate.seriesIndex}`);
  if (candidate.year !== null) parts.push(String(candidate.year));
  return parts.join(" · ") || "No details";
}

function currentText(book: LibraryBook, field: LookupField): string | null {
  switch (field) {
    case "title":
      return book.title;
    case "author":
      return book.author;
    case "series":
      return book.series;
    case "seriesIndex":
      return book.seriesIndex === null ? null : String(book.seriesIndex);
    case "cover":
      return book.hasCover ? null : "None";
  }
}

function newText(candidate: LookupCandidate, field: LookupField): string | null {
  if (field === "cover") return null;
  const value = lookupFieldValue(candidate, field);
  return value === null ? null : String(value);
}

function FieldValue({
  field,
  kind,
  tone,
  text,
  image,
  onImageError,
}: {
  field: LookupField;
  kind: "audio" | "book";
  tone: "now" | "new";
  text: string | null;
  image: string | null;
  onImageError?: () => void;
}) {
  const color = tone === "new" ? "text-ink font-medium" : "text-ink-variant";
  return (
    <span className={`min-w-0 font-ui text-sm break-words ${color} ${field === "seriesIndex" ? "tabular-nums" : ""}`}>
      <span className="sr-only">{tone === "now" ? "Now: " : "New: "}</span>
      {image ? (
        <Thumb kind={kind} src={image} onError={onImageError} large />
      ) : (
        (text ?? <span className="text-ink-variant/70">Empty</span>)
      )}
    </span>
  );
}

/**
 * A cover thumbnail in the kind's own shape (music 1:1, books 2:3) at the
 * artwork radius, on the kind's tint when there is no image, so the dialog's
 * list reads by kind the way the grid does.
 */
function Thumb({
  kind,
  src,
  onError,
  large = false,
}: {
  kind: "audio" | "book";
  src: string | null;
  onError?: () => void;
  large?: boolean;
}) {
  const box =
    kind === "audio"
      ? large
        ? "h-20 w-20"
        : "h-14 w-14"
      : large
        ? "h-[90px] w-[60px]"
        : "h-[60px] w-10";
  const tint = kind === "audio" ? "bg-tint-music" : "bg-tint-book";
  return (
    <span aria-hidden className={`block shrink-0 overflow-hidden rounded-cover border border-line-soft ${tint} ${box}`}>
      {src && <img src={src} alt="" loading="lazy" onError={onError} className="h-full w-full object-cover" />}
    </span>
  );
}

/** What the result area says while searching, on failure, and on no results. */
function SearchState({
  searching,
  error,
  empty,
  sourceName,
  source,
}: {
  searching: boolean;
  error: unknown;
  empty: boolean;
  sourceName: string;
  source: LookupSource;
}) {
  if (searching) {
    return (
      <p role="status" className="px-2 py-6 text-center font-ui text-sm text-ink-variant">
        Searching {sourceName}…
      </p>
    );
  }
  if (error) {
    return (
      <p role="alert" className="px-2 py-6 text-center font-ui text-sm text-danger">
        {lookupErrorMessage(error, source)}
      </p>
    );
  }
  if (empty) {
    return (
      <p role="status" className="px-2 py-6 text-center font-ui text-sm text-ink-variant">
        No matches on {sourceName}. Try fewer words, or check the spelling.
      </p>
    );
  }
  return null;
}
