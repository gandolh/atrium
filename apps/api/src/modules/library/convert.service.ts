import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { pdf } from "pdf-to-img";
import { convertTargetForFormat, type ConvertStatus, type FileType } from "@ebook-reader/shared";
import { startEbookConvert, type RunningConvert } from "./calibre.service.js";
import { CONVERT_JOB_TIMEOUT_MS, LIBRARY_FILES_DIR } from "../../common/config.js";
import { filePathFor } from "../../common/paths.js";
import {
  getConvertedBook,
  getRunningConvert,
  insertConvertedBook,
  claimConvertSlot,
  resetConvert,
  setConvertStatus,
} from "./library.model.js";
import type { BookRow } from "./library.types.js";

/**
 * The convert job runner (brief 34, D34) — the async half of **Convert**.
 *
 * A job is an `ebook-convert` child that outlives the request that asked for
 * it. The HTTP call decides and returns in microseconds; the child then runs
 * for as long as it runs (up to `CONVERT_JOB_TIMEOUT_MS`, a 24h reaper), and
 * everything the caller ever learns afterwards it learns from the **source
 * book**'s `convert_status`. Nothing here is awaited by a route.
 *
 * Two rules shape the whole file:
 *
 * 1. **Nothing throws into the process.** A conversion failing is a row status,
 *    never an unhandled rejection. The same server is serving somebody's
 *    reading; an `unhandledRejection` from a book Calibre choked on would take
 *    that down too. Same best-effort discipline as `extract.ts`.
 * 2. **The DB row is the truth, the map is the handle.** The in-process map
 *    only exists so a running child can be killed; the durable half of the
 *    single-flight guard is `getRunningConvert()`, and a process restart reaps
 *    `running` rows to `failed` in db.ts (decision 7) rather than resuming.
 */

/**
 * `--enable-heuristics` for PDF→EPUB, nothing for EPUB→PDF.
 *
 * Line unwrapping is what turns a fixed-page format's hard line breaks back
 * into paragraphs, and it is **off by default** — without it the output is
 * markedly worse, which is most of what people mean when they say a Calibre
 * PDF conversion "didn't work". `--unwrap-factor` is deliberately left at its
 * default: it is per-document tuning, and a global guess makes more documents
 * worse than it makes better.
 *
 * EPUB→PDF keeps today's export behaviour exactly — no extra flags.
 */
function flagsFor(sourceFormat: FileType, targetFormat: FileType): readonly string[] {
  return sourceFormat === "pdf" && targetFormat === "epub" ? ["--enable-heuristics"] : [];
}

/**
 * What the server says when `ebook-convert` isn't on PATH. Same sentence the
 * retired stateless route used for its `CALIBRE_MISSING` error, kept verbatim
 * so the operator-facing wording doesn't quietly change with the plumbing.
 * Exported so a route or the status button can recognise this specific failure
 * instead of string-matching a sentence that may be reworded.
 */
export const CALIBRE_MISSING_ERROR =
  "Calibre (ebook-convert) is not installed on the server.";

/**
 * A **converted book**'s file: the same `library/<id>.<ext>` layout as an
 * upload (D25 — files on disk, never in the DB), named by the converted row's
 * own pre-generated id.
 *
 * Deliberately NOT a temp workspace: a conversion output is a permanent library
 * file that the reader opens and the offline store downloads, so it lives where
 * every other library file lives. `DELETE /library/:id/convert` is what removes
 * it — this path is exported so that route can be sure it's deleting the right
 * thing.
 */
export function convertedFilePath(id: string, format: FileType): string {
  // Deliberately `filePathFor` and not a second `join` of its own: a converted
  // book's file is a library file like any other, and there is exactly one
  // definition of where those live (`paths.ts`).
  return filePathFor(id, format);
}

/**
 * Where a conversion writes while it is still running, named from the SOURCE
 * book rather than the converted book's pre-generated id.
 *
 * The distinction matters only when the process dies mid-job. The converted
 * id is a `randomUUID()` that exists solely inside the in-process job — it is
 * never persisted — so a crash used to leave a multi-MB file on disk that
 * nothing could name: no row referenced it, the boot reap only wrote a status,
 * and every retry leaked another. Deriving the in-progress name from the source
 * row makes the leftover addressable, which is what lets `sweepInterruptedOutputs`
 * below delete exactly the right file instead of hunting for unreferenced ones
 * near real library data.
 *
 * The `.converting.` infix is what makes the sweep safe: an uploaded file is
 * always `<uuid>.<ext>`, so nothing else in this directory can ever match.
 */
export function inProgressPath(sourceBookId: string, format: FileType): string {
  return join(LIBRARY_FILES_DIR, `${sourceBookId}.converting.${format}`);
}

/**
 * The suffix an upload streams under until it is complete (brief 58):
 * `<uuid>.<ext>.uploading`, renamed to `filePathFor(id, format)` once the whole
 * body is on disk. A final-named file therefore always means a finished write,
 * and a name with this suffix only ever means one that never finished.
 */
export const UPLOADING_SUFFIX = ".uploading";

/** The two in-progress names this sweep may delete, and nothing else. */
const INTERRUPTED = [
  /\.converting\.[a-z0-9]+$/i,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+\.uploading$/i,
];

/**
 * Delete any in-progress output left behind by a process that died mid-write:
 * a conversion (`inProgressPath`) or an upload (`UPLOADING_SUFFIX`). Call once
 * at boot, alongside the row reap in `db.ts` — that reap flips a conversion's
 * row to `failed`, this reclaims the disk the same job was using.
 *
 * Matches ONLY those two in-progress names. A blanket "delete files with no
 * row" sweep would be far more thorough and far more dangerous: this feature
 * has already destroyed one of the owner's books once, and an over-eager sweep
 * next to real library files is exactly how it would happen again. Each suffix
 * is safe for the same reason: it exists only for a write that never completed.
 */
export async function sweepInterruptedOutputs(): Promise<number> {
  let removed = 0;
  try {
    for (const name of await readdir(LIBRARY_FILES_DIR)) {
      if (!INTERRUPTED.some((pattern) => pattern.test(name))) continue;
      await discard(join(LIBRARY_FILES_DIR, name));
      removed += 1;
    }
  } catch {
    // A missing directory on a fresh install is not a failure.
  }
  return removed;
}

interface ConvertJob {
  /** The **source book** as it stood when the job started — kept so a refusal
   *  can name the book being converted without a second DB read. */
  readonly source: BookRow;
  readonly handle: RunningConvert;
  /** ISO, the same value written to `convert_started_at`. */
  readonly startedAt: string;
  /** Pre-generated id of the converted book, so the output file can be named. */
  readonly convertedBookId: string;
  readonly targetPath: string;
  /** Set by `cancelConvert` BEFORE the kill, so the completion path can tell a
   *  cancellation from a genuine failure without a fifth `ConvertOutcome`. */
  cancelled: boolean;
}

/**
 * Cancel every in-flight conversion, returning how many were stopped. Used on
 * shutdown: the child is not detached, so a SIGTERM that only stops this
 * process would leave `ebook-convert` running with nothing left to record its
 * result. Reuses `cancelConvert`, so each job resets its source row to `none`
 * and discards its output exactly as a user-initiated cancel would.
 */
export async function cancelAllConverts(): Promise<number> {
  let cancelled = 0;
  for (const sourceBookId of [...jobs.keys()]) {
    if (await cancelConvert(sourceBookId)) cancelled += 1;
  }
  return cancelled;
}

/** `sourceBookId → job`. At most one entry (decision 6), but a map keeps the
 *  lookup by book id honest and would survive relaxing that later. */
const jobs = new Map<string, ConvertJob>();

/** A terminal write on a source row: a status, or cancel's reset to `none`. */
type StatusWrite = { kind: "status"; status: ConvertStatus; error: string | null } | { kind: "reset" };

/**
 * Terminal writes that threw, parked for replay (brief 67, brief 46's fix on
 * the conversion side).
 *
 * A job's last act is to move its source row off `running`. If that write
 * throws (`SQLITE_BUSY` past the driver's own retry, a full disk, an I/O
 * error), the in-process job is already gone but the row still says `running`,
 * and `claimConvertSlot` (D47's atomic claim) then refuses **every** conversion
 * in the install, because the slot is install-wide (D34). Cancel cannot rescue
 * it either: it finds no in-process job. Before this, only a restart cleared it.
 *
 * The recovery ruling is brief 46's, and its reasons carry over unchanged:
 * - **Not a periodic reap.** `reapInterruptedConversions` flips every
 *   `running` row to `failed`, which is safe only at boot, before any job can
 *   be live.
 * - **Not an immediate retry loop.** better-sqlite3 runs synchronously on this
 *   thread and has already retried a busy database for 5 s before throwing;
 *   spinning would block the event loop for every other request and add
 *   nothing SQLite had not tried.
 * - **Deferred to the next attempt.** `startConvert` replays this map before it
 *   claims the slot, and cancel replays it before it decides there is nothing
 *   to cancel. The person's natural reaction (press Convert, or Cancel, again)
 *   is what unwedges them. It costs nothing while the map is empty.
 *
 * In-process and bounded by book (one entry each, overwritten): a restart is
 * the one event that makes it unnecessary, because the boot reaper runs then.
 */
const pendingStatusWrites = new Map<string, StatusWrite>();

/** better-sqlite3 hangs a `code` (`SQLITE_BUSY`, `SQLITE_FULL`, …) on what it throws. */
function sqliteErrorCode(cause: unknown): string | null {
  const code: unknown = cause instanceof Error ? (cause as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : null;
}

async function applyStatusWrite(sourceBookId: string, write: StatusWrite): Promise<void> {
  if (write.kind === "reset") await resetConvert(sourceBookId);
  else await setConvertStatus(sourceBookId, write.status, write.error);
}

/**
 * Make a terminal write, or park it and say so loudly. Never rejects: it runs
 * on paths (a job's end, a cancel) that must not be escaped by a database error.
 */
async function recordStatusWrite(sourceBookId: string, write: StatusWrite): Promise<void> {
  try {
    await applyStatusWrite(sourceBookId, write);
    pendingStatusWrites.delete(sourceBookId);
  } catch (cause) {
    pendingStatusWrites.set(sourceBookId, write);
    const code = sqliteErrorCode(cause);
    const what = write.kind === "reset" ? "reset convert_status to 'none'" : `record convert_status='${write.status}'`;
    console.error(
      `[convert] could not ${what} for book ${sourceBookId} — ` +
        `${code ?? "error"}: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        "The row still says 'running' while nothing is running, so every conversion in the install " +
        "is refused until it is cleared. Queued for replay: the next convert or cancel attempt on " +
        "this process clears it, and the boot reaper clears it at the next restart.",
    );
  }
}

/**
 * Replay every parked terminal write, before anything reads the durable half
 * of the slot. Best-effort: a write that fails again stays parked, silently
 * (`recordStatusWrite` already said so once).
 */
async function flushPendingStatusWrites(): Promise<void> {
  for (const [sourceBookId, write] of [...pendingStatusWrites]) {
    // A job for this book is still in the map: either a new conversion, which
    // owns its row and must not have it overwritten, or a cancelled one whose
    // child is still dying, which will write nothing itself. Either way, skip
    // it but KEEP it parked: dropping it here would lose a cancelled job's
    // reset for good. A new job's own terminal write replaces or clears the
    // entry (`recordStatusWrite`), so it never goes stale.
    if (jobs.has(sourceBookId)) continue;
    try {
      await applyStatusWrite(sourceBookId, write);
      pendingStatusWrites.delete(sourceBookId);
      console.warn(
        `[convert] recovered: the parked write for book ${sourceBookId} landed; the conversion slot is free again.`,
      );
    } catch {
      // Still failing. Left parked for the next attempt.
    }
  }
}

/**
 * The decision a `POST /library/:id/convert` needs. The route answers with it
 * immediately; the work continues in the background.
 *
 * The single-flight guarantee does NOT come from the ordering of the statements
 * below — every query is a promise, so requests can interleave anywhere. It
 * comes from `claimConvertSlot`, one atomic UPDATE that either takes the slot or
 * reports that someone else holds it.
 *
 * Every refusal carries a `message` that is fit to show a person as-is.
 */
export type StartConvertResult =
  /** Accepted; the child is running. The route's 202. */
  | { kind: "started"; convertedBookId: string; targetFormat: FileType }
  /** Another conversion is already in flight. The route's 409. */
  | { kind: "busy"; message: string; runningBook: BookRow }
  /** This format has no conversion target (mp3/mp4/webm). The route's 400. */
  | { kind: "unsupported"; message: string }
  /** Asked to convert a **converted book**. The route's 400. */
  | { kind: "derived"; message: string }
  /** A conversion already exists. The route's 200 no-op, or `?force=1` after a
   *  delete. */
  | { kind: "exists"; message: string; converted: BookRow };

/**
 * Start converting `source` into its opposite format, in the background.
 *
 * Returns the decision; the work continues after the return. Refusals are
 * values rather than exceptions because every one of them is a normal HTTP
 * answer, not a bug.
 *
 * The "already exists" refusal is load-bearing for the caller: there is a
 * UNIQUE index on `converted_from`, so a second `insertConvertedBook` for the
 * same source throws. A `?force=1` re-run must DELETE the existing conversion
 * (row and file) first — this runner will not insert over one.
 */
export async function startConvert(source: BookRow): Promise<StartConvertResult> {
  // Before anything reads the slot: a parked terminal write from an earlier
  // job may be all that is holding it (brief 67).
  await flushPendingStatusWrites();

  if (source.converted_from !== null) {
    return {
      kind: "derived",
      message: "This book is already a conversion. Convert the original instead.",
    };
  }

  const targetFormat = convertTargetForFormat(source.format);
  if (targetFormat === null) {
    return {
      kind: "unsupported",
      message: "Only PDF and EPUB books can be converted.",
    };
  }

  const existing = await getConvertedBook(source.id);
  if (existing) {
    return {
      kind: "exists",
      message: `“${source.title}” has already been converted.`,
      converted: existing,
    };
  }

  // Single-flight, in-process half (decision 6): one conversion at a time,
  // refused rather than queued. Checked before the durable claim below because
  // a child whose row was reset out from under it is still occupying the CPU
  // and the output path, and because reading the map needs no await — nothing
  // can interleave between this check and the claim that follows it.
  const [firstActive] = jobs.values();
  if (firstActive) {
    return {
      kind: "busy",
      message: `“${firstActive.source.title}” is still finishing. Only one conversion runs at a time — try again in a moment.`,
      runningBook: firstActive.source,
    };
  }

  const startedAt = new Date().toISOString();
  const convertedBookId = randomUUID();
  // Written under a source-derived name and renamed into place only once the
  // conversion has actually succeeded — see `inProgressPath`.
  const targetPath = inProgressPath(source.id, targetFormat);

  // The source's own file already lives here, so this is all but guaranteed to
  // exist; it costs nothing to be sure before handing a path to a child.
  try {
    mkdirSync(LIBRARY_FILES_DIR, { recursive: true });
  } catch {
    // A real permissions problem will resurface as a Calibre failure below,
    // which is a row status the person can see — better than a throw here.
  }

  // Single-flight, durable half. One atomic UPDATE decides it: the library is
  // shared across accounts with no per-book ownership (D30/D24), so "one per
  // account" and "one at a time" are the same question, and asking SQLite means
  // the answer does not depend on how two concurrent requests interleave. See
  // `claimConvertSlot` for why this is not a read followed by a write.
  if (!(await claimConvertSlot(source.id, startedAt))) {
    // Lost the claim — something else holds the slot. Read it now, purely to
    // name the book in the refusal; if it has finished in the meantime the
    // message falls back to the generic wording rather than inventing a title.
    const running = await getRunningConvert();
    return {
      kind: "busy",
      message: running
        ? `“${running.title}” is being converted right now. Only one conversion runs at a time — try again when it finishes, or cancel it.`
        : "Another conversion is running. Only one conversion runs at a time — try again in a moment.",
      runningBook: running ?? source,
    };
  }

  const handle = startEbookConvert(
    // Derived from the source row, never read off it — see `paths.ts`.
    filePathFor(source.id, source.format),
    targetPath,
    CONVERT_JOB_TIMEOUT_MS,
    flagsFor(source.format, targetFormat),
  );
  const job: ConvertJob = {
    source,
    handle,
    startedAt,
    convertedBookId,
    targetPath,
    cancelled: false,
  };
  jobs.set(source.id, job);

  // Floating on purpose — the route does not wait for this. `finishJob` never
  // rejects; the `.catch` is the belt to its braces, because an unhandled
  // rejection here would kill a server that is also serving someone's reading.
  void finishJob(targetFormat, job).catch(() => {
    jobs.delete(source.id);
  });

  return { kind: "started", convertedBookId, targetFormat };
}

/**
 * Cancel the conversion of `sourceBookId`. True when a live child was told to
 * die, false when nothing was running here.
 *
 * The source row is reset to `none` **synchronously**, before the child has
 * actually gone, so the route can answer and the client can refetch without
 * racing the SIGKILL — and so a cancelled conversion is trivially
 * distinguishable from a failed one: cancelled ends at `none` (the button
 * offers Convert again), failed ends at `failed` with a reason and a retry.
 *
 * A cancel that lands in the microseconds after a successful conversion closed
 * still discards it. That is the right read of the intent — the person pressed
 * Cancel — and the alternative is a book appearing in a format they just said
 * they didn't want.
 *
 * Returns false for a row stuck `running` from a previous process: those are
 * reaped to `failed` at boot (decision 7), never cancellable.
 */
export async function cancelConvert(sourceBookId: string): Promise<boolean> {
  const job = jobs.get(sourceBookId);
  if (!job) {
    // Nothing runs here, but a row may still say `running` because a job's
    // terminal write was parked. Clear that before answering (brief 67).
    await flushPendingStatusWrites();
    return false;
  }
  job.cancelled = true;
  job.handle.cancel();
  // A reset that throws is parked rather than answered as a 500: the child is
  // already told to die, and the cancelled job writes no status of its own.
  await recordStatusWrite(sourceBookId, { kind: "reset" });
  return true;
}

/** Whether THIS process is running a conversion for `sourceBookId`. The
 *  in-process half of the guard; `getRunningConvert()` is the durable half. */
export function isConverting(sourceBookId: string): boolean {
  return jobs.has(sourceBookId);
}

/**
 * True when the job was cancelled, having cleaned up its output.
 *
 * `cancelConvert` awaits the source-row reset before it returns, so by the time
 * this reads the flag the row already says `none` and the user has been told it
 * stopped. All that is left is to make that true: drop the output and commit
 * nothing. Called after every await on the path to the insert.
 */
async function abandonIfCancelled(job: ConvertJob): Promise<boolean> {
  if (!job.cancelled) return false;
  await discard(job.targetPath);
  return true;
}

/**
 * Await the child and record the outcome. Never rejects: every path either
 * writes a status onto the source row or deliberately leaves a cancelled row
 * alone, and the whole body is wrapped so a surprise (a full disk, a corrupt
 * output) still lands as `failed` rather than as a process-level rejection.
 */
async function finishJob(targetFormat: FileType, job: ConvertJob): Promise<void> {
  const source = job.source;
  try {
    const outcome = await job.handle.promise;

    // Cancellation is checked after EVERY await from here to the commit, not
    // just this one. `cancelConvert` can only set the flag — it cannot unwind
    // work already in flight — so a single early check silently loses any
    // cancel that lands during the two awaits below (`stat`, and `gradeEpub`,
    // which parses the whole source PDF and unzips the EPUB: comfortably
    // seconds on a large book). That window ended with the user being told the
    // conversion was cancelled and getting it anyway.
    if (await abandonIfCancelled(job)) return;

    switch (outcome.kind) {
      case "missing":
        await fail(source.id, job.targetPath, CALIBRE_MISSING_ERROR);
        return;
      case "timeout":
        await fail(
          source.id,
          job.targetPath,
          "The conversion hit the time limit and was stopped. You can start it again.",
        );
        return;
      case "failed":
        await fail(source.id, job.targetPath, failureMessage(outcome.stderr));
        return;
      case "ok":
        break;
    }

    let sizeBytes: number;
    try {
      ({ size: sizeBytes } = await stat(job.targetPath));
    } catch {
      // Exit 0 with nothing on disk: rare, but "success" with no file would
      // otherwise insert a row pointing at a path that isn't there.
      await fail(
        source.id,
        job.targetPath,
        "Calibre reported success but produced no file.",
      );
      return;
    }

    if (await abandonIfCancelled(job)) return;

    // The quality gate runs BEFORE the insert so the row and the status land
    // together — a `ready` that turns into `poor` a second later is a worse
    // experience than a slightly later `ready`.
    const status =
      source.format === "pdf" && targetFormat === "epub"
        ? await gradeEpub(filePathFor(source.id, source.format), job.targetPath)
        : "ready";

    // Last gate before the commit: `gradeEpub` above is the longest await in
    // the whole job, so it is the likeliest place for a cancel to land.
    if (await abandonIfCancelled(job)) return;

    // Move the finished output off its in-progress name and onto the converted
    // book's own id, so it stops matching the boot sweep and starts matching
    // the row about to reference it. Renaming AFTER the last cancel check keeps
    // the sweep-able name for the entire window a cancel can still arrive in.
    const finalPath = convertedFilePath(job.convertedBookId, targetFormat);
    try {
      await rename(job.targetPath, finalPath);
    } catch {
      await fail(source.id, job.targetPath, "The conversion finished but couldn't be saved. Try again.");
      return;
    }

    try {
      await insertConvertedBook({
        id: job.convertedBookId,
        sourceBookId: source.id,
        format: targetFormat,
        sizeBytes,
        now: new Date().toISOString(),
      });
    } catch {
      // Unknown source (deleted mid-conversion) or the UNIQUE index on
      // `converted_from` (a conversion appeared while this one ran). Either
      // way the output is orphaned and must not be left on disk.
      await fail(
        source.id,
        finalPath,
        "The conversion finished but couldn't be saved. Try again.",
      );
      return;
    }

    await recordStatusWrite(source.id, { kind: "status", status, error: null });
  } catch {
    // Last resort: something outside every case above went wrong. Say so on
    // the row rather than leaving it `running` forever; if even that write
    // fails, it is parked for replay rather than lost.
    await recordStatusWrite(source.id, {
      kind: "status",
      status: "failed",
      error: "The conversion failed unexpectedly.",
    });
  } finally {
    jobs.delete(source.id);
  }
}

/** Record a failure on the source and remove whatever partial output exists. */
async function fail(sourceId: string, targetPath: string, message: string): Promise<void> {
  await discard(targetPath);
  await recordStatusWrite(sourceId, { kind: "status", status: "failed", error: message });
}

/** Remove a partial/abandoned output. Never throws — a leftover file is a
 *  smaller problem than a rejected promise. */
async function discard(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => {});
}

/**
 * A failure message a person can act on: the plain sentence, plus the last
 * meaningful line Calibre printed. Calibre's fatal line ("Failed to detect
 * input format", "This file is encrypted") is genuinely the useful part, so it
 * is kept — trimmed hard, because the rest of the traceback is not.
 */
function failureMessage(stderr: string): string {
  const detail = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("File \"") && line !== "Traceback (most recent call last):")
    .pop();
  const base = "Calibre couldn't convert this book.";
  if (!detail) return base;
  return `${base} ${detail.length > 160 ? `${detail.slice(0, 157)}…` : detail}`;
}

// --- The quality gate (brief 34 step 5) --------------------------------------

/**
 * Below this many characters of extracted text per source page, a PDF→EPUB
 * result is called `poor`. A scanned or image-only PDF has no text layer at
 * all, and Calibre does no OCR, so it converts to a book of empty pages — the
 * single most disappointing outcome, and one nobody can diagnose from the
 * inside of a blank reader.
 *
 * 200 is deliberately far below any real page (a sparse paperback page is
 * ~1500 characters), because the cost of the two errors is not symmetric: a
 * false `poor` puts a scary note on a book that is fine, while a missed `poor`
 * just leaves the person where they'd have been anyway.
 */
const MIN_CHARS_PER_PAGE = 200;

/**
 * Grade a finished PDF→EPUB: `poor` when the output holds far too little text
 * for the source's page count, `ready` otherwise.
 *
 * A cheap heuristic, not a document analyser — it catches "a scan converted to
 * a blank book" and nothing else. **Warning only** (decision 12): `poor` still
 * opens, never blocks, never prompts.
 *
 * Any failure to measure falls back to `ready`, on purpose. A conversion that
 * worked and got labelled unusable is worse than one that didn't get labelled.
 */
async function gradeEpub(sourcePdfPath: string, epubPath: string): Promise<ConvertStatus> {
  try {
    // Path input, not bytes: this only parses the document structure for a page
    // count, so there is no reason to pull a large PDF into memory (unlike
    // extract.ts, which already has the buffer and renders a page from it).
    const doc = await pdf(sourcePdfPath);
    let pages: number;
    try {
      pages = doc.length;
    } finally {
      await doc.destroy();
    }
    if (!Number.isFinite(pages) || pages <= 0) return "ready";

    const need = pages * MIN_CHARS_PER_PAGE;
    return (await extractedTextLength(epubPath, need)) < need ? "poor" : "ready";
  } catch {
    return "ready";
  }
}

/**
 * Characters of visible text in an EPUB's XHTML, stopping as soon as `stopAt`
 * is reached — the answer is a comparison against that number, so there is no
 * point unzipping the rest of a book that has already passed.
 */
async function extractedTextLength(epubPath: string, stopAt: number): Promise<number> {
  const zip = new AdmZip(epubPath);
  let total = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    if (!/\.(x?html|htm)$/i.test(entry.entryName)) continue;
    total += visibleTextLength(entry.getData().toString("utf8"));
    if (total >= stopAt) break;
  }
  return total;
}

/**
 * Length of the text a reader would actually see in one XHTML document.
 *
 * Head, scripts and styles go first (their contents are text to a regex and
 * invisible to a person), then tags, then entities — each entity stands for one
 * character but is written as several, so leaving them in would let a page of
 * `&nbsp;` masquerade as prose. Whitespace collapses last, which is what makes
 * the pretty-printed markup Calibre emits count as its words rather than its
 * indentation.
 */
function visibleTextLength(xhtml: string): number {
  return xhtml
    .replace(/<head\b[\s\S]*?<\/head>/gi, " ")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/gi, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}
