import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { THUMBNAILS_DIR } from "../../common/config.js";
import { coverOwnerId, coverPathFor, filePathFor } from "../../common/paths.js";
import { extractMeta } from "./extract.service.js";
import { listBooks, listBooksNeedingMetadata, updateBookMetadata } from "./library.model.js";

/**
 * Unattended library maintenance, fired and forgotten from `index.ts` after
 * `listen`. Neither of these may ever stop the API serving, so both catch their
 * own failures and both log what they did — including when they did nothing.
 */

/**
 * One-time metadata backfill (brief 21). Rows added before the series/subjects
 * columns existed have `subjects IS NULL`; re-run extraction against each stored
 * file and persist the new fields. Best-effort and idempotent:
 *
 * - A book whose file is missing/unreadable still gets `subjects=[]` (via
 *   `updateBookMetadata`) so it drops out of the "needs metadata" set and the
 *   backfill can't loop forever.
 * - Runs off the request path (fired from server startup, not awaited by any
 *   handler); a single row's failure never aborts the rest.
 */
export async function backfillLibraryMetadata(log: FastifyBaseLogger): Promise<void> {
  const pending = await listBooksNeedingMetadata();
  if (pending.length === 0) return;
  log.info({ count: pending.length }, "library metadata backfill: starting");

  let updated = 0;
  for (const row of pending) {
    try {
      const filePath = filePathFor(row.id, row.format);
      const bytes = await readFile(filePath);
      const meta = await extractMeta(bytes, row.format, filePath);
      await updateBookMetadata(row.id, {
        series: meta.series,
        seriesIndex: meta.seriesIndex,
        subjects: meta.subjects,
        author: meta.author,
      });
      updated += 1;
    } catch (err) {
      // File gone or unreadable — write empty metadata so the sentinel clears
      // and this row isn't re-scanned on every startup.
      log.warn({ err, id: row.id }, "library metadata backfill: file unreadable, storing empty");
      await updateBookMetadata(row.id, {
        series: null,
        seriesIndex: null,
        subjects: [],
        author: null,
      });
    }
  }
  log.info({ updated, total: pending.length }, "library metadata backfill: done");
}

/**
 * The only basenames this sweep will ever delete: `<uuid>.jpg`.
 *
 * Every id that can name a thumbnail is a `randomUUID()` this server minted
 * (`paths.ts` says so, and enforces it for the directory-valued derivations),
 * and every writer of a cover names its output `coverPathFor(<that id>)` —
 * the upload path in `library.service.ts`, the import in
 * `catalog/catalog.service.ts`, and the publish in `latex/latex.service.ts`.
 * So a file whose name is not a UUID plus `.jpg` is not something this module
 * could have produced, and deleting it would be this sweep acting outside its
 * own convention. Anything else in the directory is left alone and logged.
 */
const THUMBNAIL_FILENAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/i;

/**
 * Verification seam for `sweepOrphanThumbnails`. Production passes nothing.
 *
 * `apps/api` has no test harness (no `test` script, no `*.test.ts`), and this
 * function deletes files unattended — the two arms that must never delete (the
 * query throwing, and the query coming back empty) are exactly the ones that
 * cannot be produced by arranging files on disk. This seam is how they are
 * demonstrated; it is deliberately the *only* injectable dependency, so the
 * paths that actually touch the filesystem are the same ones that run at boot.
 */
export interface OrphanThumbnailSweepOverrides {
  /** Stands in for `listBooks("recent")`. */
  listRows?: () => Promise<Array<{ id: string; converted_from: string | null }>>;
}

/**
 * Delete thumbnails in `THUMBNAILS_DIR` that no live `books` row can claim
 * (brief 48), then log what happened. Returns the number of files deleted.
 *
 * This is the file→row direction, and it is the one that survives. D39 deleted
 * `reconcileMissingCovers`, which handled row→file; that state stopped being
 * representable once paths became derived (`coverPathFor(coverOwnerId(row))`),
 * so a row whose thumbnail is simply missing is not a fault and is not this
 * sweep's business — it never appears in the directory listing, so it is
 * untouched here by construction.
 *
 * **The keep-set is the whole safety argument.** A converted book and its
 * source SHARE ONE FILE — `coverOwnerId` is `converted_from ?? id`
 * (`common/paths.ts`) — so a keep-set that misses either half of a pair deletes a
 * live cover. Two things make `listBooks("recent")` sufficient here even
 * though it hides conversions (`NOT_CONVERTED`, `library.model.ts`):
 *
 *  1. every row it *does* return is its own cover owner, and
 *  2. every row it hides is a conversion, whose owner is its source — and a
 *     source is never itself a conversion, because `startConvert` refuses a
 *     row with `converted_from !== null` (`convert.service.ts`), so no chain
 *     can exist whose head is hidden from this list.
 *
 * Both halves are still mapped through `coverOwnerId` rather than assumed, so
 * this stays correct if that list ever stops filtering. **If conversion chains
 * ever become possible, this keep-set becomes incomplete and this sweep will
 * delete a live cover** — that is the invariant to re-check before allowing
 * one.
 *
 * Nothing is deleted on a partial read: not when the row query throws, not
 * when the directory read throws, and not when the keep-set is empty. That
 * last arm is why an empty library is never swept — "no rows" and "the query
 * silently returned nothing" are indistinguishable from here without a second
 * query, and guessing wrong empties the whole thumbnail directory. Refusing
 * costs a few orphan files on a library with no books; guessing costs every
 * cover in a library that has them.
 *
 * Fired and forgotten from `index.ts` after `listen`, like
 * `backfillLibraryMetadata` — a failure must never stop the API serving.
 */
export async function sweepOrphanThumbnails(
  log: FastifyBaseLogger,
  overrides: OrphanThumbnailSweepOverrides = {},
): Promise<number> {
  const listRows = overrides.listRows ?? (() => listBooks("recent"));

  let rows: Array<{ id: string; converted_from: string | null }>;
  try {
    rows = await listRows();
  } catch (err) {
    log.error({ err }, "orphan thumbnail sweep: book query failed, deleted 0");
    return 0;
  }

  // Every row's cover owner, never the row's own id: for a conversion that is
  // its source, which is the file both rows are served from.
  const keep = new Set<string>();
  for (const row of rows) {
    keep.add(coverPathFor(coverOwnerId({ id: row.id, converted_from: row.converted_from })));
  }

  if (keep.size === 0) {
    log.warn(
      { rows: rows.length, deleted: 0 },
      "orphan thumbnail sweep: empty keep-set, refusing to sweep, deleted 0",
    );
    return 0;
  }

  let entries;
  try {
    entries = await readdir(THUMBNAILS_DIR, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      log.info({ deleted: 0 }, "orphan thumbnail sweep: no thumbnail directory yet, deleted 0");
      return 0;
    }
    log.error({ err }, "orphan thumbnail sweep: directory read failed, deleted 0");
    return 0;
  }

  let deleted = 0;
  let foreign = 0;
  let failed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(THUMBNAILS_DIR, entry.name);
    if (keep.has(path)) continue;
    if (!THUMBNAIL_FILENAME.test(entry.name)) {
      foreign += 1;
      log.info(
        { file: entry.name },
        "orphan thumbnail sweep: not a <id>.jpg name, leaving it alone",
      );
      continue;
    }
    try {
      await rm(path, { force: true });
      deleted += 1;
      log.info({ file: entry.name }, "orphan thumbnail sweep: deleted orphan thumbnail");
    } catch (err) {
      failed += 1;
      log.warn({ err, file: entry.name }, "orphan thumbnail sweep: could not delete");
    }
  }

  // Logged unconditionally, zero included: this runs unattended and deletes
  // files, so every boot has to leave a line saying what it did.
  log.info(
    { deleted, kept: keep.size, foreign, failed, scanned: entries.length },
    "orphan thumbnail sweep: done",
  );
  return deleted;
}
