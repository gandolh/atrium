import type { Knex } from "knex";
import type { ConvertStatus, FileType, LibrarySort } from "@ebook-reader/shared";
import { kindForFormat } from "@ebook-reader/shared";
import { knex } from "../../database/knex.js";
import type { BookRow, NewBookRow } from "./library.types.js";

/**
 * Data access for `books` — every read and write of the table, and nothing
 * else. No filesystem, no HTTP, no business rules: the service layer decides
 * *whether* to delete a book, this decides *how* the row goes away.
 *
 * Reads go through `selectBooks()` so the `converted_to` projection can never
 * be forgotten; the three listings additionally apply `NOT_CONVERTED`.
 */

/**
 * The projection every read of `books` goes through: the stored columns plus
 * `converted_to`, the reverse of `converted_from`, resolved by a correlated
 * subquery in the same statement.
 *
 * Doing it here rather than per row is the whole point — the wire contract
 * carries both link directions on every book, so a lookup inside
 * `toLibraryBook` would make one library listing N+1 queries. The unique index
 * `books_converted_from` is what lets the subquery be a scalar.
 */
function selectBooks(db: Knex = knex): Knex.QueryBuilder {
  return db({ b: "books" }).select(
    "b.*",
    db.raw("(SELECT c.id FROM books c WHERE c.converted_from = b.id) AS converted_to"),
  );
}

/**
 * The clause that delivers "one card per book" (D34): a **converted book** is a
 * real `books` row, so every query that LISTS books for a person must exclude
 * it or the library shows the same book twice.
 *
 * READ THIS BEFORE ADDING A FOURTH LISTING — it needs this clause too, and
 * nothing else in the codebase will tell you. It is load-bearing far beyond the
 * grid: cross-library search, kind chips, grouping and every count are
 * **client-side over the list `GET /library` returned**
 * (`apps/web/src/library/search.ts`), so they all inherit the hiding from these
 * three queries and from nowhere else. Filter here and derived rows vanish
 * everywhere at once; forget here and they reappear everywhere at once.
 *
 * It is deliberately NOT applied to `getBook` (the reader opens a converted
 * book by id — that is the format switch), nor to the backfill/reconcile reads
 * below, which want every row.
 */
const NOT_CONVERTED = "b.converted_from IS NULL";

export async function insertBook(row: NewBookRow): Promise<void> {
  await knex("books").insert(row);
}

export async function getBook(id: string): Promise<BookRow | undefined> {
  return (await selectBooks().where("b.id", id).first()) as BookRow | undefined;
}

export async function listBooks(sort: LibrarySort): Promise<BookRow[]> {
  const query = selectBooks().whereRaw(NOT_CONVERTED);
  if (sort === "title") {
    return (await query.orderByRaw("b.title COLLATE NOCASE ASC")) as BookRow[];
  }
  if (sort === "author") {
    return (await query.orderByRaw(
      "b.author COLLATE NOCASE ASC, b.title COLLATE NOCASE ASC",
    )) as BookRow[];
  }
  // "Recent" orders by the most recent activity on EITHER half of a convert
  // pair. Opening the converted twin touches only that row, which is hidden
  // from this list, so ordering on `b.last_opened_at` alone would freeze a
  // book's position the moment its reader switched format. The correlated MAX
  // covers the row itself and its conversion, and is indexed by
  // `books_converted_from`.
  return (await query.orderByRaw(`COALESCE(
      (SELECT MAX(x.last_opened_at) FROM books x
        WHERE x.id = b.id OR x.converted_from = b.id),
      b.last_opened_at, b.created_at
    ) DESC`)) as BookRow[];
}

export async function touchOpened(id: string, now: string): Promise<void> {
  await knex("books").where({ id }).update({ last_opened_at: now });
}

export async function deleteBook(id: string): Promise<void> {
  await knex("books").where({ id }).delete();
}

/**
 * Books whose metadata predates the series/subjects columns (`subjects IS
 * NULL`), for the one-time startup backfill (brief 21).
 *
 * Unfiltered by `NOT_CONVERTED` on purpose: a converted book still wants
 * correct metadata, and a backfill is maintenance, not a user-facing list. (In
 * practice one never matches — `insertConvertedBook` copies the source's
 * subjects as JSON, never null — but the exemption is deliberate, not an
 * accident.)
 */
export async function listBooksNeedingMetadata(): Promise<BookRow[]> {
  return (await selectBooks().whereNull("b.subjects")) as BookRow[];
}

/**
 * Persist re-scanned series/subject metadata for one book (backfill or a future
 * re-index). `subjects` is a `string[]` stored as JSON; `author` fills a
 * previously-null author without overwriting an existing one (COALESCE), which
 * lets a re-scan improve a PDF's metadata but never clobber what is there.
 * `subjects` is set to a JSON array (never null) so the row drops out of
 * `listBooksNeedingMetadata` and can't loop.
 */
export async function updateBookMetadata(
  id: string,
  meta: {
    series: string | null;
    seriesIndex: number | null;
    subjects: string[];
    author: string | null;
  },
): Promise<void> {
  await knex("books")
    .where({ id })
    .update({
      series: meta.series,
      series_index: meta.seriesIndex,
      subjects: JSON.stringify(meta.subjects),
      author: knex.raw("COALESCE(author, ?)", [meta.author]),
    });
}

/**
 * Re-point a published document's card at its newest version (brief 38).
 *
 * Unlike `updateBookMetadata` above, `title` is assigned outright rather than
 * COALESCEd: renaming the draft is how a person renames the published thing, so
 * the newest publish is authoritative. Without this the card keeps v1's title
 * and v1's byte size forever, which is a card describing a file it is no longer
 * serving.
 */
export async function updatePublishedBook(
  id: string,
  title: string,
  sizeBytes: number,
): Promise<void> {
  await knex("books").where({ id }).update({ title, size_bytes: sizeBytes });
}

// --- Convert: linked source/converted books (brief 34, D34) ------------------

/**
 * The **converted book** made from `sourceBookId`, or undefined when none
 * exists. The reverse of `getBook(row.converted_from)`. The unique index
 * guarantees at most one row.
 *
 * `DELETE /library/:id` must call this BEFORE deleting a source: the row
 * cascades away inside SQLite, but its file on disk does not, and afterwards
 * there is nothing left to say the file was ever there.
 */
export async function getConvertedBook(sourceBookId: string): Promise<BookRow | undefined> {
  return (await selectBooks().where("b.converted_from", sourceBookId).first()) as
    | BookRow
    | undefined;
}

/**
 * The other half of a converted pair, from either side: given a source book its
 * converted book, given a converted book its source. Undefined when the row
 * stands alone.
 *
 * One call because `GET /library/:id` has to offer the format switch from
 * whichever row the reader happens to have open, and which side that is isn't
 * knowable before the lookup.
 */
export async function getLinkedBook(row: BookRow): Promise<BookRow | undefined> {
  if (row.converted_from !== null) return getBook(row.converted_from);
  return row.converted_to !== null ? getBook(row.converted_to) : undefined;
}

/**
 * Insert the **converted book** for `sourceBookId` and return the stored row.
 *
 * Title, author, series and subjects are copied from the source so the pair
 * reads as one book, and `kind` is derived from the target format like any
 * upload. The source's cover is **reused, not re-extracted** — brief 34 keeps
 * `extract.service.ts` out of this path entirely. That sharing is not recorded
 * by copying a path: `coverPathFor` derives it from `converted_from ?? id`, so
 * the conversion resolves to the source's thumbnail without this row storing
 * anything.
 *
 * Throws if the source id is unknown, or (via `books_converted_from`) if that
 * source already has a conversion — the caller is supposed to have handled the
 * "already exists" case, so a second insert is a bug worth hearing about.
 */
export async function insertConvertedBook(args: {
  /**
   * Pre-generated: the caller needs it to name the output file before
   * converting. It is also the whole of what this function needs to know about
   * where that file went — `filePathFor(id, format)` is the path, so there is
   * no path argument to pass and nothing to keep in sync.
   */
  id: string;
  sourceBookId: string;
  /** The target format — `convertTargetForFormat(source.format)`. */
  format: FileType;
  sizeBytes: number;
  /** ISO timestamp for `created_at`. */
  now: string;
}): Promise<BookRow> {
  const source = await getBook(args.sourceBookId);
  if (!source) throw new Error(`Cannot convert unknown book ${args.sourceBookId}`);

  await knex("books").insert({
    id: args.id,
    title: source.title,
    author: source.author,
    format: args.format,
    size_bytes: args.sizeBytes,
    progress: 0,
    created_at: args.now,
    last_opened_at: null,
    series: source.series,
    series_index: source.series_index,
    // Never null, so the metadata backfill can't mistake a fresh conversion for
    // a pre-column row and re-scan it (see `listBooksNeedingMetadata`).
    subjects: source.subjects ?? "[]",
    // Provenance is where the *book* came from, which a conversion doesn't
    // change; `converted_from` is what records that this row was derived.
    source: source.source,
    source_id: source.source_id,
    kind: kindForFormat(args.format),
    duration_seconds: null,
    converted_from: args.sourceBookId,
  });

  return (await getBook(args.id)) as BookRow;
}

/**
 * **Atomically** claim the one conversion slot for `id`, returning false when
 * another book already holds it. Sets `running`, clears the error and starts
 * the clock on the **source book** — the status describes the conversion, and
 * the converted book may not exist yet. Clearing the error on start is what
 * stops a retry showing the previous run's reason while the new one is in
 * flight.
 *
 * WHY THE CHECK IS INSIDE THE UPDATE and not a `getRunningConvert()` call in
 * front of it. Under the old synchronous `better-sqlite3` layer, read-then-write
 * WAS atomic: nothing could interleave between two statements on Node's single
 * thread, and the job runner's comment said so explicitly. Every query is a
 * promise now, so a plain read-then-write has a real suspension point between
 * the check and the claim, and two `POST /library/:id/convert` requests
 * arriving together would both find no running conversion and both start a
 * child — the exact double-conversion D34 decision 6 refuses.
 *
 * `NOT EXISTS` inside the UPDATE moves that decision into SQLite, where the
 * statement is atomic regardless of how the callers are scheduled. The loser
 * updates zero rows and gets `false`, which is the refusal the route turns into
 * a 409. Restoring the guarantee this way rather than with an in-process lock
 * is deliberate: the guard's durable half was always the row, and a lock would
 * only cover jobs this process started.
 */
export async function claimConvertSlot(id: string, now: string): Promise<boolean> {
  const changed = await knex("books")
    .where({ id })
    .whereNotExists(knex("books as other").select(knex.raw("1")).where("other.convert_status", "running"))
    .update({ convert_status: "running", convert_error: null, convert_started_at: now });
  return changed > 0;
}

/**
 * Record the outcome of a conversion — `ready`, `poor` (produced but probably
 * unusable, a scanned PDF; it still opens and the UI only warns) or `failed`
 * with a reason the reader can act on.
 *
 * `convert_started_at` is left alone: the run it timed did happen, and the next
 * `markConvertRunning` overwrites it.
 */
export async function setConvertStatus(
  id: string,
  status: ConvertStatus,
  error: string | null = null,
): Promise<void> {
  await knex("books").where({ id }).update({ convert_status: status, convert_error: error });
}

/**
 * Return a source book to "never converted" — used when a finished conversion
 * is deleted or a running one is cancelled, so the button offers Convert again
 * rather than a switch to a row that is gone.
 */
export async function resetConvert(id: string): Promise<void> {
  await knex("books")
    .where({ id })
    .update({ convert_status: "none", convert_error: null, convert_started_at: null });
}

/**
 * The conversion currently in flight, or undefined. Backs the single-flight
 * guard (D34 decision 6: one at a time, a refusal rather than a queue) and the
 * 409 the route returns — the returned row is the book to name in the message.
 * Oldest first so the refusal names the job that has been running longest,
 * which is the one a person is actually waiting on.
 *
 * Store-wide, not per account, because the library is shared across accounts by
 * design (there is no per-book ownership), so "one per account" and "one at a
 * time" are the same query here.
 *
 * This is the durable half of the guard: `convert.service.ts`'s in-process map
 * knows about children this process spawned, the DB knows about the row.
 */
export async function getRunningConvert(): Promise<BookRow | undefined> {
  return (await selectBooks()
    .where("b.convert_status", "running")
    .orderBy("b.convert_started_at", "asc")
    .first()) as BookRow | undefined;
}
