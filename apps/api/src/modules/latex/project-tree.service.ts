import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { FastifyBaseLogger } from "fastify";

/**
 * Removing a LaTeX project's working tree.
 *
 * Its own module because two unrelated callers need it — `DELETE /latex/:id`
 * and the profile delete, which removes every project of the profile it is
 * about to cascade away — and neither should have to import the other's
 * service to get at it.
 */

/**
 * Remove a project's whole working tree, tolerating a compile writing into it.
 *
 * This is the delete-mid-compile case, and it is a real race rather than a
 * theoretical one: the `cancelAndSettleLatexCompile` in `DELETE /latex/:id`
 * stops the engine at its next step boundary, but the job still finishes by
 * writing its log and diagnostics into `.atrium-build/` — and the delete now
 * WAITS for that to happen before calling this, so the retry loop below is a
 * backstop against a slow filesystem rather than against a job that has not run
 * yet. It could not have been the latter: a job still queued in `setImmediate`
 * recreates the directory after any number of passes have found it gone. A
 * single `rm -r` that walks the directory while those files appear fails with
 * `ENOTEMPTY` — observed, not imagined — which turned a delete that had already
 * removed the row into a 500. So: retry, and re-check afterwards, because a
 * pass that succeeded may still have been outrun by an artifact written a
 * millisecond later.
 *
 * A tree that survives all of that is **logged, not raised**. The row is
 * already gone, so the project is unreachable and the delete really did happen
 * from every client's point of view; orphaned bytes are recoverable, a 500 on a
 * completed delete is not.
 */
export async function removeProjectTree(dir: string, log: FastifyBaseLogger): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // `maxRetries`/`retryDelay` are Node's own backoff for exactly this
      // family of errors (ENOTEMPTY, EBUSY, EPERM, EMFILE).
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Swallowed here; the existence check below is the real verdict.
    }
    if (!existsSync(dir)) return;
  }
  log.warn({ dir }, "latex project tree could not be fully removed");
}
