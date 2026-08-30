import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import {
  compileStatusSchema,
  diagnosticSchema,
  type CompileStatus,
  type Diagnostic,
  type LatexCompileResult,
} from "@ebook-reader/shared";
import {
  LATEX_MAX_OUTPUT_BYTES,
  LATEX_MAX_PROJECT_BYTES,
  LATEX_TIMEOUT_MS,
} from "../../common/config.js";
import { projectDirFor } from "../../common/paths.js";
import { getRunningLatexCompile, setLatexCompileStatus, touchLatexProject, type LatexProjectRow } from "./latex.model.js";
// Types only. `latex-worker.ts` is loaded as a *thread entry point* from a
// `file:` URL and is never imported as a module — see `runEngineInWorker`.
import type { LatexWorkerRequest, LatexWorkerResponse } from "./latex-worker.js";

/**
 * The LaTeX compile job (brief 38 step 3, rehosted by brief 44) — brief 34's
 * job runner with the child process taken out and a worker thread put back.
 *
 * `packages/typeset` is a **pure synchronous function** (D38): bytes in, PDF
 * and diagnostics out, no filesystem and no subprocess. So this module is the
 * half the engine deliberately does not have — it reads the project's working
 * tree off disk into an in-memory file map, runs `compile()` **on a worker
 * thread** (`latex-worker.ts`), and writes the PDF, the log and the diagnostics
 * back out as artifacts. Everything dangerous that brief 36 needed a sandbox
 * for is simply absent: there is no shell to escape and no path a document can
 * name.
 *
 * The worker is what brief 44 added, and it changes how this module *hosts* the
 * engine — not the engine, and not one line of this module's exported contract.
 * It buys two things brief 38 could not have: the API's event loop stays free
 * while a document is typeset (D36 — a compile on the laptop no longer freezes
 * the reader on the phone), and a cancel arriving *while the engine runs* can
 * now be both delivered and honoured.
 *
 * Four things here are not obvious and are explained where they happen:
 *
 * 1. **The slot-release discipline** (`runCompile`'s `finally`,
 *    `runEngineInWorker`'s exit handling, and `cancelLatexCompile`). Brief 34
 *    and brief 38 each shipped a Critical exactly here, and a thread adds five
 *    new ways for a job to end.
 * 2. **The two-layer timeout**, now stated in three places from one number:
 *    `createCompileSignal` covers the queued window, `createWorkerSignal` in
 *    the worker is what the engine polls, and `TERMINATE_GRACE_MS` past the
 *    deadline this module kills the thread. The engine's step budget is still
 *    the real guard; `LATEX_TIMEOUT_MS` is the backstop.
 * 3. **How a stop reports its reason** (`stopWorker`, and the diagnostics
 *    beside `abortDiagnostic`). A wall clock must never claim a person pressed
 *    Cancel — and once a stop is a `terminate()` the engine cannot say anything
 *    about it at all, so this module has to.
 * 4. **What the tree walk refuses to read** (`readProjectTree`) — symlinks, in
 *    particular, which no string-level path check can see.
 */

// --- Where the artifacts live ------------------------------------------------

/**
 * The build directory inside a project's working tree, holding the compiled
 * PDF, the log and the structured diagnostics.
 *
 * A **dot-directory inside the project**, rather than a sibling root, because
 * the brief puts a draft's artifacts under the project directory and because
 * deleting the project's tree then deletes its artifacts with it — one `rm -r`,
 * no second cleanup path to forget. The name is what keeps that from being
 * circular: `readProjectTree` skips this directory, so a compile never feeds
 * its own output back in as source, and `isBuildArtifactPath` lets the file
 * routes keep it out of the editor's file tree.
 *
 * The leading dot is not the mechanism — the exact-name match is. A user file
 * called `.gitignore` is still a project file and still compiles.
 */
export const LATEX_BUILD_DIR_NAME = ".atrium-build";

/** `latex/<projectId>/.atrium-build/` — created lazily by the first compile. */
export function latexBuildDirFor(projectId: string): string {
  // `projectDirFor` asserts the id is a server-generated UUID and throws
  // otherwise; that assertion is the reason this is safe to `join` onto.
  return join(projectDirFor(projectId), LATEX_BUILD_DIR_NAME);
}

/**
 * The draft's compiled PDF — what `GET /latex/:id/pdf` streams.
 *
 * Written **only on a successful compile**, and deliberately never deleted on a
 * failing one: brief 38 step 10 requires the editor to keep showing the last
 * good PDF beside the new errors rather than blanking the preview pane. A
 * failed compile therefore leaves a PDF that is *stale but readable*, which is
 * the useful state; `diagnostics.json` next to it is what says the last attempt
 * failed, so nothing has to infer freshness from the PDF itself.
 */
export function draftPdfPathFor(projectId: string): string {
  return join(latexBuildDirFor(projectId), "out.pdf");
}

/** The plain-text engine log — what `GET /latex/:id/log` serves as `log`. */
export function compileLogPathFor(projectId: string): string {
  return join(latexBuildDirFor(projectId), "compile.log");
}

/** The structured diagnostics plus the outcome status. See `StoredOutcome`. */
export function compileDiagnosticsPathFor(projectId: string): string {
  return join(latexBuildDirFor(projectId), "diagnostics.json");
}

/**
 * Whether a project-relative path belongs to the build directory rather than to
 * the project. The file routes must hide these: the artifacts are output, and
 * an editor that lists `out.pdf` as a source file invites someone to delete or
 * edit it.
 *
 * Takes the path in the same POSIX-relative form the file map and the file
 * routes use (`.atrium-build/out.pdf`, never an absolute path).
 */
export function isBuildArtifactPath(relativePath: string): boolean {
  return relativePath === LATEX_BUILD_DIR_NAME || relativePath.startsWith(`${LATEX_BUILD_DIR_NAME}/`);
}

// --- Fonts -------------------------------------------------------------------
//
// They are not here any more, and neither is `@ebook-reader/typeset`: this
// module no longer imports the engine at all. The engine performs no I/O of its
// own (D38), so somebody must open the twelve committed `.otf` files, and that
// somebody is now `latex-worker.ts` — the thread that calls `compile()` is the
// thread that injects the faces, which keeps the entire engine-facing surface in
// one module and this one free of it.
//
// The price of the move is that the parsed provider can no longer be cached for
// the life of the process. It is a few milliseconds per compile; see the note
// above `runEngine` in the worker for the measurement and the trade.

// --- Cancellation and the two-layer timeout ----------------------------------

/**
 * The **host's** half of cancellation: the window before the engine has a
 * thread of its own, plus the flag `cancelLatexCompile` sets.
 *
 * A job can be stopped in three places, and no single mechanism reaches all
 * three:
 *
 * - **Queued** — between `startLatexCompile` and the `setImmediate`, or during
 *   the `await` in `readProjectTree`. This signal, read once by
 *   `compileAndPersist` before it spawns anything. The engine never starts, so
 *   no PDF is written and nothing has to be undone.
 * - **Inside the engine, on the clock.** The signal itself cannot go: it is a
 *   live object with getters, polled *synchronously* by the engine, and a live
 *   object does not survive a structured clone. What crosses is the **deadline**
 *   as a number, and the worker rebuilds an equivalent signal around it
 *   (`createWorkerSignal`) — so an ordinary timeout still stops cooperatively
 *   and the engine still gets to report where it stopped.
 * - **Inside the engine, because someone said stop.** Nothing cooperative can
 *   work: `compile()` is synchronous, so the worker is not reading messages
 *   either, and a shared flag would still only be seen where the engine polls.
 *   `stopWorker` terminates the thread. That is the capability the whole move to
 *   a worker bought.
 *
 * The deadline is computed **once**, in `startLatexCompile`, and handed to this
 * signal, to the worker and to the terminate timer, so the three cannot come to
 * different conclusions about when the limit falls.
 *
 * `cancelled` and `timedOut` stay separate for the same reason they always did:
 * `abortDiagnostic` and the log distinguish them, and a wall-clock stop that
 * claimed a person pressed Cancel would be a lie in a file somebody reads
 * precisely to find out what happened.
 *
 * Unlike the worker's copy, this signal reads the clock on **every** access. The
 * `CLOCK_POLL_INTERVAL` sampling that lives in the worker exists because the
 * engine polls millions of times per compile; here it is read once or twice, and
 * sampling would only add a way to miss the deadline.
 */
interface CompileSignal {
  /** Set by `cancelLatexCompile`, and checked before a thread is spawned. */
  cancel(): void;
  /**
   * Record that the *clock* stopped this compile, when the clock in question
   * was the worker's rather than this one.
   *
   * The two signals read the same `deadline` but are separate objects — a live
   * object with getters cannot cross a thread boundary — so a timeout the
   * engine observed is, on this side, a fact that arrived in a message.
   * Folding it back in here rather than threading it through the call sites
   * keeps `timedOut` the single answer to "was this a clock or a person?", which
   * is what `abortDiagnostic` and `compileAndPersist` both branch on.
   *
   * Idempotent and one-way: nothing ever un-times-out a compile.
   */
  timeOut(): void;
  /** True when the *wall clock*, not the user, stopped this compile. */
  readonly timedOut: boolean;
  /** True when `cancel()` was called. */
  readonly cancelled: boolean;
  /** Either of the above — reading it evaluates the clock. */
  readonly aborted: boolean;
}

function createCompileSignal(deadline: number): CompileSignal {
  let cancelled = false;
  let timedOut = false;

  return {
    cancel(): void {
      cancelled = true;
    },
    timeOut(): void {
      timedOut = true;
    },
    get cancelled(): boolean {
      return cancelled;
    },
    get timedOut(): boolean {
      return timedOut;
    },
    get aborted(): boolean {
      if (cancelled || timedOut) return true;
      timedOut = Date.now() >= deadline;
      return timedOut;
    },
  };
}

// --- Reading the project's working tree --------------------------------------

/** Depth and count ceilings on the walk, so a pathological tree cannot hang it. */
const MAX_TREE_DEPTH = 32;
const MAX_TREE_FILES = 5_000;

interface ProjectTree {
  files: Record<string, Uint8Array>;
  /** Problems found while reading — skipped symlinks, ceilings hit. */
  diagnostics: Diagnostic[];
  bytes: number;
}

/**
 * Read a project's working tree into the in-memory map `compile()` takes: keys
 * are POSIX project-relative paths (`main.tex`, `chapters/one.tex`), values are
 * the raw bytes.
 *
 * **Symlinks are skipped, not followed, and the skip is reported.**
 * `latex-paths.ts` confines the paths a *client* supplies, but this walk starts
 * from a trusted id and then follows whatever is on disk, which is a different
 * question: a symlink named `notes.tex` pointing at `/etc/passwd` is textually
 * inside the project no matter what any path check says, and following it would
 * read the target into the file map — where `\input{notes.tex}` would set it
 * into a PDF the owner can then publish. That is an exfiltration path with no
 * traversal in it. The engine cannot be the one to stop it (it never sees a
 * filesystem), so the refusal belongs here, at the only place that opens a
 * file. Skipping silently would be the same class of mistake the engine's
 * loud-failure contract exists to prevent, so each skip becomes a diagnostic
 * naming the path.
 *
 * The whole read is **best-effort per entry**: an unreadable file becomes a
 * diagnostic and the rest of the project still compiles, because a project that
 * will not compile at all because of one bad figure is worse than one that
 * compiles with a `missing-file` error pointing at it.
 */
async function readProjectTree(projectDir: string): Promise<ProjectTree> {
  const files: Record<string, Uint8Array> = {};
  const diagnostics: Diagnostic[] = [];
  let bytes = 0;
  let count = 0;
  let truncated = false;

  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (truncated) return;
    if (depth > MAX_TREE_DEPTH) {
      diagnostics.push(
        wholeProject(
          `directory nesting deeper than ${MAX_TREE_DEPTH} levels was not read (at \`${prefix}\`)`,
          "warning",
          "limit-exceeded",
        ),
      );
      return;
    }

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // A project whose directory has not been created yet is the normal state
      // of a brand-new project, not an error: the compile then fails on a
      // missing entrypoint, which is the accurate thing to say.
      return;
    }

    // Sorted so the file map is built in a stable order. The engine's output
    // does not depend on it, but a log and a diagnostics list that change order
    // between two identical compiles make a real change impossible to spot.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (truncated) return;
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      // The compile's own output. Skipped before anything else so a compile can
      // never read its previous PDF back in as a source file.
      if (depth === 0 && entry.name === LATEX_BUILD_DIR_NAME) continue;

      if (entry.isSymbolicLink()) {
        // `unsupported`, passed explicitly rather than falling through to
        // `wholeProject`'s `missing-file` default. The distinction is the one
        // the diagnostic codes exist to make: `missing-file` means a path the
        // document referenced is not in the tree, and an editor branching on it
        // could reasonably offer "add this file?". This file IS in the tree —
        // it is deliberately refused, because following it would read bytes
        // from outside the project into a document that may be published.
        // Offering to "add" it would be nonsense. Nothing is missing; something
        // is not supported.
        diagnostics.push(
          wholeProject(
            `\`${relativePath}\` is a symbolic link and was not read — project files must be real files inside the project`,
            "warning",
            "unsupported",
          ),
        );
        continue;
      }

      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), relativePath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue; // sockets, fifos, devices: not project files

      if (count >= MAX_TREE_FILES) {
        truncated = true;
        diagnostics.push(
          wholeProject(`the project has more than ${MAX_TREE_FILES} files; the rest were not read`, "error", "limit-exceeded"),
        );
        return;
      }

      let data: Buffer;
      try {
        data = await readFile(join(dir, entry.name));
      } catch {
        diagnostics.push(wholeProject(`\`${relativePath}\` could not be read`, "warning", "missing-file"));
        continue;
      }

      bytes += data.byteLength;
      if (bytes > LATEX_MAX_PROJECT_BYTES) {
        truncated = true;
        diagnostics.push(
          wholeProject(
            `the project's files exceed the ${LATEX_MAX_PROJECT_BYTES}-byte limit; it was not compiled`,
            "error",
            "limit-exceeded",
          ),
        );
        return;
      }

      // A copy, not a view: `readFile` may hand back a Buffer pointing into a
      // pooled allocation, and the engine holds these for the whole compile.
      files[relativePath] = new Uint8Array(data);
      count += 1;
    }
  };

  await walk(projectDir, "", 0);
  return { files, diagnostics, bytes };
}

/**
 * A diagnostic about the project as a whole rather than a line of LaTeX.
 *
 * `file` is the empty string and `line` is `0` — the contract's own encoding
 * for "no single line" — so the editor's panel renders it without pretending to
 * a source position it could jump to.
 */
function wholeProject(
  message: string,
  severity: "error" | "warning",
  code: Diagnostic["code"] = "missing-file",
): Diagnostic {
  return { file: "", line: 0, severity, message, code };
}

// --- The job map -------------------------------------------------------------

interface CompileJob {
  readonly projectId: string;
  /** The account the slot is claimed against — the guard is per account, not
   *  per profile (D35: switching profiles is free, so a per-profile limit is
   *  no limit at all). */
  readonly userId: string;
  readonly project: LatexProjectRow;
  readonly signal: CompileSignal;
  readonly startedAt: number;
  /**
   * `Date.now()` at which the wall-clock backstop falls.
   *
   * Held on the job rather than recomputed because three separate things need
   * to agree about it: this job's `signal`, the worker's own signal, and the
   * terminate timer in `runEngineInWorker`.
   */
  readonly deadline: number;
  /**
   * The thread running the engine, or `null` — before it is spawned, after it
   * has exited, and, importantly, from the moment anything decides to stop it.
   *
   * Clearing it is how "stop this worker" is made **idempotent**. A cancel
   * racing the result message, the shutdown sweep racing a cancel, and
   * `runCompile`'s defensive sweep racing both must not between them call
   * `terminate()` twice or reach a thread that a later compile owns. Only
   * `stopWorker` and `runEngineInWorker`'s `exit` handler write it.
   */
  worker: Worker | null;
  /**
   * Why this job's thread was killed, if it was. `null` means it was not, and
   * whatever the worker reported stands.
   *
   * Written *before* the `terminate()` it explains, because the exit handler is
   * what reads it and the exit can be delivered on the very next turn.
   */
  stopReason: StopReason | null;
  /**
   * The job's own outcome promise — the same one the route awaits.
   *
   * Held on the job so that `cancelAndSettleLatexCompile` can wait for the work
   * to actually FINISH rather than merely be told to stop.
   *
   * Typed nullable only because the job object is constructed a few lines before
   * the promise exists. **Every job reachable through `jobs` has a non-null
   * `done`**: `startLatexCompile` assigns it in the same synchronous region as
   * the `jobs.set`, specifically so that a `job.done?.` on the delete path can
   * never short-circuit into "I waited" when it did not. See the long note at
   * that assignment for the orphaned-artifacts failure this prevents.
   */
  done: Promise<LatexCompileResult> | null;
}

/**
 * `projectId → job`, the **in-process half** of the single-flight guard and the
 * only handle a cancel has. The durable half is `compile_status = 'running'`
 * on the row, which is what survives a restart and what
 * `getRunningLatexCompile` reads.
 *
 * Both halves are needed and neither is redundant:
 *  - the row alone cannot be cancelled (there is no object to set a flag on);
 *  - the map alone forgets everything when the process restarts, which is
 *    exactly when a `running` row would otherwise poll forever
 *    (`reapInterruptedLatexCompiles` in `db.ts` is that backstop).
 */
const jobs = new Map<string, CompileJob>();

// --- When the durable half cannot be written (brief 46) ----------------------

/**
 * `projectId → the terminal status that could not be written`.
 *
 * The narrow, real hole in the slot-release discipline. `runCompile`'s `finally`
 * frees the in-process half unconditionally (`jobs.delete`) and then writes the
 * durable half. If that write *fails* — `SQLITE_BUSY` because something else
 * holds the write lock past the driver's own timeout, `SQLITE_FULL` because the
 * disk the PDFs just filled is the disk the database is on — the row is left on
 * `running` with nothing running. From then on `getRunningLatexCompile` refuses
 * every compile on the ACCOUNT with a 409 naming a project that finished
 * minutes ago, and because `reapInterruptedLatexCompiles` runs **at import**,
 * only a restart clears it.
 *
 * The old code could not even see this case: it caught the throw and the
 * zero-row UPDATE in one `catch {}` and treated both as benign, inferring
 * "nothing to worry about" from the *fact* that a write did not take rather
 * than from *why*. `setLatexCompileStatus` now returns `false` for the benign
 * one and throws for the real one, and this map is where the real one is parked.
 *
 * **The recovery ruling (brief 46 item 3) is: retry, deferred.** Not a periodic
 * reap — `reapInterruptedLatexCompiles` flips *every* `running` row to `failed`,
 * which is safe only at import, when nothing is running; on a timer it would
 * shoot live compiles in the head. Not "leave it to restart", because that is
 * the bug. And not an immediate retry loop either: Knex's driver here is still
 * `better-sqlite3`, whose calls run **synchronously on this thread** inside the
 * promise, and which already retries a busy database for its own 5 s timeout
 * before throwing. Spinning would therefore still block the API's event loop for
 * another five seconds per attempt — punishing every other request in the
 * process for one project's failed write, having added nothing SQLite had not
 * already tried. Wrapping it in a promise changed none of that.
 *
 * So the retry is **deferred to the next `startLatexCompile`**, which replays
 * this map before it reads the guard (`flushPendingStatusWrites`). It costs
 * nothing while the map is empty, it happens exactly where a wedged account is
 * noticed, and it makes the person's natural reaction — press Compile again —
 * the thing that unwedges them. No timer, and no change to the reaper's schedule.
 *
 * Deliberately in-process, and bounded in size (one entry per project,
 * overwritten) rather than in time: it is not a durable queue and does not need
 * to be, because a restart is the one event that makes it unnecessary.
 */
const pendingStatusWrites = new Map<string, CompileStatus>();

/** `better-sqlite3` hangs a `code` (`SQLITE_BUSY`, `SQLITE_FULL`, …) on the
 *  errors it throws. That string is the difference between "the database was
 *  busy" and "there is a bug in the SQL", so it is reported by name. */
function sqliteErrorCode(cause: unknown): string | null {
  const code: unknown = cause instanceof Error ? (cause as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : null;
}

/**
 * Move the row off `running`, telling apart the two failures the old `catch {}`
 * collapsed. Never rejects — it is called from a `finally` that must not be
 * escaped.
 *
 * ## The window this opens, named rather than hidden (2026-08-30, the Knex move)
 *
 * This used to contain no `await` at all, so `jobs.delete` in the caller's
 * `finally` and this write were one indivisible step and a compile could not
 * start between them. Every query is a promise now, so there IS a window: the
 * in-process half is already free while the row still says `running`.
 *
 * That window is **safe but visible**. It cannot wedge anything — the write
 * lands a moment later, or fails and is queued in `pendingStatusWrites` for the
 * next attempt to replay, exactly as before. What it can do is make a compile
 * request arriving inside it read the stale row and answer 409 "wait for it to
 * finish" about a compile that finished microseconds ago. The next attempt
 * succeeds.
 *
 * It is left as a transient 409 rather than closed with a third "releasing"
 * state because the alternative — deleting the map entry only after the write —
 * reopens the far worse failure the ordering exists to prevent: a database
 * write that throws would then leave the in-process slot claimed forever, which
 * is brief 34's Critical and wedges the account until a restart. A spurious
 * retry-able refusal is the cheaper end of that trade.
 *
 * - **Zero rows matched** → silent, and correct. The project was deleted
 *   mid-compile (brief 45); a row that does not exist cannot hold a slot.
 * - **The write threw** → reported loudly and parked in `pendingStatusWrites`
 *   for the next `startLatexCompile` to replay. See that map for why the retry
 *   is deferred rather than immediate.
 */
async function releaseCompileRow(projectId: string, status: CompileStatus): Promise<void> {
  try {
    const matched = await setLatexCompileStatus(projectId, status);
    pendingStatusWrites.delete(projectId);
    if (!matched) return;
    // The files on disk changed (the artifacts), and the project list is
    // ordered by `updated_at`. A compile is the one thing that changes a project
    // without going through a file write. Inside the same `try` because it is
    // the same database — if it fails, the whole (idempotent) pair is requeued.
    await touchLatexProject(projectId, new Date().toISOString());
  } catch (cause) {
    pendingStatusWrites.set(projectId, status);
    const code = sqliteErrorCode(cause);
    console.error(
      `[latex] could not record compile_status='${status}' for project ${projectId} — ` +
        `${code === null ? describeCause(cause) : `${code}: ${describeCause(cause)}`}. ` +
        "The row still says 'running' while nothing is running, so this account's compile slot is " +
        "held in the DATABASE (the in-process slot is already free). Queued for replay: the next " +
        "compile attempt on this process will clear it, and reapInterruptedLatexCompiles clears it " +
        "at the next restart.",
    );
  }
}

/**
 * Replay every status write that failed, before anything READS the durable half
 * of the guard. Called at the top of `startLatexCompile` — the one place that is
 * both a write path and where a wedged account is actually felt, so the repair
 * happens exactly where the damage shows.
 *
 * Best-effort by construction: a write that fails again stays queued for the
 * attempt after this one. Silent on failure — `releaseCompileRow` already shouted
 * once, and a fresh copy of that paragraph per retry is noise, not information.
 */
async function flushPendingStatusWrites(): Promise<void> {
  for (const [projectId, status] of [...pendingStatusWrites]) {
    // A project that is compiling again owns its own row; our terminal status is
    // stale and must not be written over its `running`.
    if (jobs.has(projectId)) {
      pendingStatusWrites.delete(projectId);
      continue;
    }
    try {
      await setLatexCompileStatus(projectId, status);
      pendingStatusWrites.delete(projectId);
      console.warn(
        `[latex] recovered: compile_status='${status}' finally recorded for project ${projectId}; ` +
          "the compile slot it was holding is free again.",
      );
    } catch {
      // Still broken. Leave it queued — the next compile attempt tries again.
    }
  }
}

/** The refusal or the acceptance. Refusals are values, not exceptions: a second
 *  concurrent compile is an ordinary 409, not a bug. */
export type StartLatexCompileResult =
  /** Accepted. `done` resolves with the outcome and **never rejects**. */
  | { kind: "started"; done: Promise<LatexCompileResult> }
  /** Another compile is already running on this account. The route's 409. */
  | { kind: "busy"; message: string; runningProject: LatexProjectRow };

/**
 * Start compiling `project`, in the background, on behalf of `userId`.
 *
 * ## Where the single-flight guarantee actually comes from
 *
 * It used to come from the whole function being synchronous: no `await` could
 * fall between the check and the claim, so two requests could not both see a
 * free slot. Every query is a promise now, and the durable read below is one —
 * so that reasoning no longer covers it and something else has to.
 *
 * What covers it is the **in-process half, claimed synchronously**. The
 * `runningLatexCompileInProcess` check and the `jobs.set` that follows it have
 * **no `await` between them** (the region is marked below, and the job object is
 * built inside it precisely so nothing async can creep in). Two concurrent
 * requests therefore serialise on the map: whichever resumes first walks that
 * whole region in one uninterrupted turn and takes the slot, and the other
 * finds the entry and is refused. The map is what makes this a guard; the
 * durable read in front of it is an earlier, cheaper refusal that also covers
 * compiles this process did not start.
 *
 * The work itself starts on a later turn of the event loop (see
 * `scheduleCompile`).
 *
 * `userId` is the account, not the profile: `getRunningLatexCompile` joins
 * through `profiles.user_id` for the same reason (D35).
 */
export async function startLatexCompile(
  project: LatexProjectRow,
  userId: string,
): Promise<StartLatexCompileResult> {
  // Before anything READS the durable half, finish writing it (brief 46). A
  // status write that failed earlier left some row on `running` with nothing
  // running, and the guard below cannot tell that row from a live compile — so
  // it would answer 409 for a compile that ended long ago. A no-op in the
  // overwhelming case where the map is empty.
  await flushPendingStatusWrites();

  // Durable half first, because it also covers a compile this process did not
  // start — and, after a crash, is reaped to `failed` at import rather than
  // resumed, so it can never wedge a slot across a restart.
  const running = await getRunningLatexCompile(userId);
  if (running) {
    return {
      kind: "busy",
      message: busyMessage(running, project),
      runningProject: running,
    };
  }
  // ### BEGIN the atomic region — NO `await` from here down to `jobs.set`
  //
  // This is the whole single-flight guarantee (see the header). Everything
  // between this comment and `jobs.set` runs in one uninterrupted turn of the
  // event loop, so two concurrent callers cannot both pass it. Adding an
  // `await` anywhere inside — a lookup, a stat, a log flush — silently removes
  // the guard and lets two compiles start on one account.
  //
  // In-process half, checked account-wide. It catches the window the row
  // cannot: a project deleted mid-compile takes its `running` row with it, so
  // the durable slot silently disappears while the job is still holding the
  // engine. Without this check a second compile would start against a process
  // that is already busy.
  const inProcess = runningLatexCompileInProcess(userId);
  if (inProcess) {
    return {
      kind: "busy",
      message: busyMessage(inProcess, project),
      runningProject: inProcess,
    };
  }

  const startedAt = Date.now();
  // One clock reading for both, so the log's "started" and the deadline the
  // worker polls describe the same instant.
  const deadline = startedAt + LATEX_TIMEOUT_MS;
  const job: CompileJob = {
    projectId: project.id,
    userId,
    project,
    signal: createCompileSignal(deadline),
    startedAt,
    deadline,
    worker: null,
    stopReason: null,
    done: null,
  };

  // ## The claim is all-or-nothing, and this try/catch is what makes it so
  //
  // `jobs.set` is the in-process half of the guard and `runCompile`'s `finally`
  // is the ONLY thing that ever releases it. So the claim and the thing that
  // will release it have to be established together, which is why both lines
  // below are here rather than after the status write.
  //
  // ### WHY `scheduleCompile` IS CALLED HERE AND NOT AFTER THE `await`
  //
  // It used to sit inside the `try` below, which was correct while this whole
  // function was synchronous — nothing could observe the job between `jobs.set`
  // and the assignment. With an `await` in between, `job.done` is null for a
  // real window, and `cancelAndSettleLatexCompile` — the delete path — reads
  // exactly that field: it does `await job.done?.catch(...)`, so a null `done`
  // makes it return *immediately*, reporting that it waited when it did not.
  // `DELETE /latex/:id` would then `rm -r` the tree, the compile would start
  // afterwards and recreate `.atrium-build/`, and those bytes would be orphaned
  // for the life of the installation with no row pointing at them — the precise
  // failure `cancelAndSettleLatexCompile` was written to prevent.
  //
  // Scheduling inside the atomic region closes it: any job reachable through
  // `jobs` always has a `done` to wait on. Nothing runs yet — `scheduleCompile`
  // only builds a promise around a `setImmediate` — so this stays synchronous.
  jobs.set(project.id, job);
  job.done = scheduleCompile(job);
  // ### END the atomic region — the slot is claimed; awaiting is safe again.

  try {
    await setLatexCompileStatus(project.id, "running");
    // Belt and braces: `flushPendingStatusWrites` above will normally have
    // cleared this already, but if the flush failed and *this* write somehow
    // did not, a queued terminal status from a previous run must not be
    // replayed over the `running` we just wrote.
    pendingStatusWrites.delete(project.id);
  } catch (cause) {
    // `setLatexCompileStatus` is a database write, and `SQLITE_FULL` is
    // entirely plausible for a feature whose whole job is writing PDFs, zips
    // and covers. This is brief 34's Critical in the in-memory half: a claimed
    // slot that is never released.
    //
    // The job is already scheduled, so the slot is NOT released by deleting the
    // map entry here — that would free the in-process half while a job is still
    // about to run against it, letting a second compile start alongside this
    // one. Cancel it and wait for its own `finally` to do the releasing, which
    // is the single writer of that transition. Then rethrow: the route answers
    // 500 and the account is left with a free slot either way.
    cancelLatexCompile(project.id);
    await job.done.catch(() => undefined);
    throw cause;
  }

  return { kind: "started", done: job.done };
}

/**
 * The prose a 409 carries. Brief 38 wrote it without "…or cancel it" because a
 * cancel could not then be delivered at all: `compile()` held the event loop, so
 * the request could not even be READ while the engine ran, and offering an
 * action the user cannot reach is worse than offering nothing.
 *
 * Brief 44 supplied both missing halves — the engine runs on a worker thread and
 * `cancelLatexCompile` really terminates it, and `POST /latex/:id/cancel` is the
 * route that reaches it — so the offer is honest again and is restored here.
 * Brief 38's rule is not repealed, only satisfied; the two branches below exist
 * because it still binds.
 *
 * ## What the wording has to keep straight
 *
 * **1. Cancelling does not free a *per-project* slot.** The limit is one compile
 * per ACCOUNT, across every profile on it (D35), and brief 44 did not touch it —
 * only *one* compile can run whatever the user cancels. Hence "on your account",
 * never "for this project": a sentence that implied a per-project slot would
 * make the next 409 look like a bug.
 *
 * **2. The cancel is on whichever project is actually compiling**, which is not
 * necessarily the one that was just refused. A bare "…or cancel it" after a
 * sentence naming another project reads as "cancel this one" — technically true,
 * practically misleading, and the resulting click would cancel nothing. So the
 * other-project branch names its target explicitly.
 *
 * **3. A compile on a sibling profile cannot be cancelled from here at all.**
 * `POST /latex/:id/cancel` resolves `:id` against the caller's OWN profile and
 * answers 404 otherwise (brief 35), so for that case there is no reachable
 * cancel and the last branch offers none. That is brief 38's rule doing its job
 * rather than being overruled.
 */
function busyMessage(running: LatexProjectRow, requested: LatexProjectRow): string {
  if (running.id === requested.id) {
    return "This project is already compiling. Only one compile runs at a time on your account — wait for it to finish, or cancel it and try again.";
  }
  if (running.profile_id === requested.profile_id) {
    return `“${running.title}” is already compiling, and only one compile runs at a time on your account — wait for it to finish, or cancel the compile on “${running.title}”, then try again.`;
  }
  return `Another profile on your account is compiling “${running.title}”. Only one compile runs at a time on the account — wait for it to finish and try again.`;
}

/**
 * Hand the event loop one turn before the job starts reading the disk.
 *
 * The `setImmediate` lets the route's response go out before this module begins
 * `readdir`ing a project tree, which is worth a turn on its own.
 *
 * It used to carry more weight than that: `compile()` ran on this thread, so
 * this was the *only* window in which a `cancelLatexCompile` could be delivered
 * at all. Since brief 44 the engine runs elsewhere and this thread stays free
 * for the whole compile, so a cancel is deliverable throughout — see
 * `cancelLatexCompile`.
 */
function scheduleCompile(job: CompileJob): Promise<LatexCompileResult> {
  return new Promise<LatexCompileResult>((resolve) => {
    setImmediate(() => {
      void runCompile(job).then(resolve);
    });
  });
}

/**
 * Cancel the compile running for `projectId`. True when a live job was told to
 * stop, false when nothing was running here.
 *
 * **Export this and call it from the delete path.** Brief 34 shipped a Critical
 * exactly here: deleting a book never cancelled its running conversion, so a
 * slot stayed held for a row that no longer existed and wedged conversion
 * app-wide. Deleting a LaTeX project must call this *before* removing the row
 * and the tree, or the same shape returns — the row's `running` disappears with
 * it (so the durable slot vanishes silently) while this module's job map keeps
 * refusing every other compile on the account.
 *
 * **What "cancel" does, and what it did before brief 44.** It used to be
 * cooperative only: the engine ran on this thread and observed the flag by
 * polling `signal.aborted` between steps, so a cancel arriving *while*
 * `compile()` ran could not even be delivered — the process was not reading
 * requests until the engine returned. The flag was instantaneous and useless;
 * the only window it landed in was the queued one.
 *
 * Now the engine runs on a thread of its own and this function reaches both
 * windows, with two mechanisms because no single one covers both:
 *
 *  - **Still queued** (before `readProjectTree` finishes, or between turns):
 *    `job.worker` is `null`, so only the flag is set. `compileAndPersist`
 *    checks it before spawning anything, so the engine never starts and no PDF
 *    is written.
 *  - **Already typesetting**: `stopWorker` kills the thread. Nothing
 *    cooperative would do — `compile()` is synchronous, so the worker is not
 *    reading messages either, and a shared flag would still only be seen where
 *    the engine polls. Killing it outright is the capability the whole move to
 *    a worker bought, and it is why this function can now be offered to a user
 *    as a button rather than only to the delete path as hygiene.
 *
 * `signal.cancel()` comes **first** and the kill second, in that order: the
 * flag is what `finish` and the diagnostics read to say *why* the compile
 * stopped, and it must already be true by the time the thread's `exit` event
 * can be delivered.
 *
 * Returning true means "a live job was told to stop", not "it has stopped" —
 * see `cancelAndSettleLatexCompile` for the caller that needs the stronger
 * guarantee.
 *
 * The status is **not** written here. `runCompile`'s `finally` owns every
 * transition off `running`, so there is exactly one place that releases a slot.
 */
export function cancelLatexCompile(projectId: string): boolean {
  const job = jobs.get(projectId);
  if (!job) return false;
  job.signal.cancel();
  stopWorker(job, "cancelled");
  return true;
}

/**
 * Cancel the compile for `projectId` **and wait until it has actually stopped
 * writing**. True when a live job was cancelled, false when nothing was running
 * here.
 *
 * ## Why waiting is the fix and a retry loop is not
 *
 * A cancelled job does not stop dead — it unwinds through `finish()` and
 * `persistOutcome`, which `mkdir`s `latex/<id>/.atrium-build/` and writes
 * `compile.log` and `diagnostics.json` into it. `DELETE /latex/:id` can easily
 * outrun that: while the job is still queued in `setImmediate`, the delete
 * cancels it, removes the row, `rm -r`s the tree and sees the directory gone on
 * its first pass — and only THEN does the job resume and **recreate** the build
 * directory. The row is already deleted, so nothing will ever come back for
 * that tree: it is orphaned bytes on disk for the life of the installation.
 *
 * More retry passes cannot close that, because the job may not have been
 * scheduled yet when the last pass runs — the race has no upper bound in
 * attempts, only in "has the job finished". So the delete waits for the
 * promise.
 *
 * That wait is bounded, and since brief 44 it is bounded by something better
 * than luck. A queued job aborts at its very next check. A job whose engine is
 * already running has its thread **terminated** by `cancelLatexCompile`, and
 * `runEngineInWorker` settles on the resulting `exit` event — which the event
 * loop can now actually deliver, because the engine is no longer holding this
 * thread. Either way what remains is `finish` and `persistOutcome`: two
 * artifact writes, and then `done` resolves.
 *
 * `done` never rejects (see `runCompile`), but it is guarded anyway — a delete
 * must not be able to 500 because a compile it was cleaning up misbehaved.
 */
export async function cancelAndSettleLatexCompile(projectId: string): Promise<boolean> {
  const job = jobs.get(projectId);
  if (!job) return false;
  // **Delegated, not re-implemented.** This used to set `job.signal.cancel()`
  // itself, which was harmless while cancellation was only a flag and became a
  // silent bug the moment it was also a `terminate()`: this function stopped
  // reaching the thread, so `DELETE /latex/:id` would set the flag, wait for a
  // compile that ran happily to completion, and delete the project underneath a
  // PDF it had just written. There is one cancel mechanism and it lives in
  // `cancelLatexCompile`; this function adds the wait and nothing else.
  cancelLatexCompile(projectId);
  await job.done?.catch(() => undefined);
  return true;
}

/**
 * Cancel every in-flight compile, returning how many were stopped. For
 * shutdown, alongside `cancelAllConverts` — nothing here outlives the process,
 * and `reapInterruptedLatexCompiles` at import will flip anything still
 * `running` to `failed` on the way back up.
 */
export function cancelAllLatexCompiles(): number {
  let cancelled = 0;
  for (const projectId of [...jobs.keys()]) {
    if (cancelLatexCompile(projectId)) cancelled += 1;
  }
  return cancelled;
}

/** Whether THIS process is compiling `projectId`. The in-process half of the
 *  guard; `getRunningLatexCompile(userId)` is the durable half. */
export function isCompilingLatexProject(projectId: string): boolean {
  return jobs.has(projectId);
}

/**
 * The project whose job is holding `userId`'s single-flight slot **in this
 * process**, or `null`. The **account-scoped** in-process half of the guard —
 * `isCompilingLatexProject` answers the per-project question, and
 * `getRunningLatexCompile(userId)` in `db.ts` is the durable half.
 *
 * `startLatexCompile` has always consulted this, inline; it is a named export
 * because the two halves can disagree in one direction that matters, and any
 * route that answers "is anything compiling on this account?" has to see both.
 * `latex_projects.profile_id` cascades on profile delete, so deleting a profile
 * mid-compile removes the project row — and with it the `running` flag — while
 * the job carries on holding the engine. From then on `getRunningLatexCompile`
 * says `null` and the compile route still refuses every project on the account
 * with a 409 naming the vanished one. A cancel route reading only the row would
 * answer "nothing is running" to somebody who can plainly see otherwise.
 *
 * The row returned is the **snapshot the job was started with**. It may no
 * longer exist in the database, which is exactly the case this exists for, so
 * callers must not assume `:id`-style routes can reach it.
 */
export function runningLatexCompileInProcess(userId: string): LatexProjectRow | null {
  for (const job of jobs.values()) {
    if (job.userId === userId) return job.project;
  }
  return null;
}

// --- Running one compile -----------------------------------------------------

/**
 * Compile the project and record the outcome. **Never rejects** — every path
 * either resolves with a `LatexCompileResult` or, in the last resort, with one
 * describing an unexpected failure. An unhandled rejection here would take down
 * a server that is also serving somebody's reading.
 *
 * ## The slot-release discipline
 *
 * A claimed slot that is never released does not fail one compile, it wedges
 * compilation for the whole account until the process restarts — and because
 * the guard is account-scoped, for every profile on it. So the release is
 * structured so that no exit path can skip it:
 *
 *  - the **row** moves off `running` on the single `finally` below, which runs
 *    for success, for engine-reported failure, for the wall clock, for a
 *    cancellation, and for a throw from anywhere in this function including the
 *    artifact writes;
 *  - the **map entry** is deleted in the same `finally`, first, so that even a
 *    failing DB write cannot leave the in-process half claimed;
 *  - the DB write goes through `releaseCompileRow`, which cannot throw out of
 *    the `finally` and which splits the two cases the one-line `catch {}` here
 *    used to conflate: `setLatexCompileStatus` on a project deleted mid-compile
 *    is a harmless zero-row UPDATE and stays silent, while a database that
 *    refuses the write is retried, reported, and queued for the next compile
 *    attempt to replay (brief 46; see `pendingStatusWrites`);
 *  - and the one path code cannot cover — the process dying — is covered by
 *    `reapInterruptedLatexCompiles()` in `db.ts`, which runs at import.
 *
 * Nothing above `finally` is allowed to `return` a status of its own. There is
 * one writer of `compile_status` in this file and it is here.
 */
async function runCompile(job: CompileJob): Promise<LatexCompileResult> {
  let outcome: LatexCompileResult;
  let status: CompileStatus = "failed";

  try {
    outcome = await compileAndPersist(job);
    status = outcome.status;
  } catch (cause) {
    // `compile()` itself is documented never to throw, so reaching here means
    // the filesystem did: a full disk, a permissions change, a tree deleted out
    // from under the walk. Reported as a failure on the project rather than
    // swallowed, and never as a rejection.
    const diagnostics: Diagnostic[] = [
      wholeProject(`the compile failed unexpectedly — ${describeCause(cause)}`, "error", "internal"),
    ];
    outcome = {
      status: "failed",
      log: renderLog(job, diagnostics, null, Date.now() - job.startedAt),
      diagnostics,
    };
    status = "failed";
    // Best-effort: the artifacts are how the editor learns what happened, but
    // if the disk is the thing that just failed there is nothing to be done.
    await persistOutcome(job.projectId, outcome, null).catch(() => {});
  } finally {
    // The map first — see the discipline above. Everything below may fail; this
    // may not, and it is what a subsequent `startLatexCompile` checks.
    jobs.delete(job.projectId);
    // No thread outlives its job. Every ordinary path has already cleared
    // `job.worker` (the `message`, `error` and `exit` handlers all do, and so
    // does `stopWorker`), so this is a sweep rather than a mechanism — but the
    // job is now unreachable through `jobs`, which means this is the last
    // moment anything *can* reach a stray thread. A worker left running here
    // would hold the engine's whole heap for the life of the process while the
    // slot it was compiling against is already free.
    stopWorker(job, "abandoned");
    // The durable half. Two failures used to be swallowed by one `catch {}`
    // here, and only one of them deserved it: a zero-row UPDATE (the project was
    // deleted mid-compile) is the correct outcome, while a database that refuses
    // the write leaves the row on `running` with nothing running and wedges the
    // whole account until a restart. `releaseCompileRow` tells them apart, keeps
    // the first silent, and reports the second then queues it for the next
    // compile attempt to replay — see `pendingStatusWrites`. It never rejects,
    // so awaiting it here cannot escape the `finally`. The map entry above is
    // already gone by this point, which is the ordering that matters; see
    // `releaseCompileRow` for the small window that opens between the two.
    await releaseCompileRow(job.projectId, status);
  }

  return outcome;
}

/**
 * Read the tree, run the engine, write the artifacts. Split out from
 * `runCompile` so that the slot release above is a `finally` around a single
 * expression and cannot be reasoned about wrongly.
 */
async function compileAndPersist(job: CompileJob): Promise<LatexCompileResult> {
  const projectDir = projectDirFor(job.projectId);
  const tree = await readProjectTree(projectDir);
  const diagnostics: Diagnostic[] = [...tree.diagnostics];

  // A cancel or the deadline may have landed while the tree was being read —
  // the one place before the engine where an `await` gives it the chance to.
  // Stopping here saves the engine's work and, more importantly, is the first
  // of the **three** checks that together mean a cancelled compile never writes
  // a PDF the person said they did not want. The other two are
  // `runEngineInWorker`'s `message` handler (a cancel racing the engine's
  // result) and the `signal.cancelled` re-check taken after the build
  // directory exists (a cancel racing the artifact writes); no one of them
  // covers another's window.
  if (job.signal.aborted) {
    diagnostics.push(abortDiagnostic(job));
    return finish(job, diagnostics, null, null);
  }

  // If reading the tree already failed hard (over the size cap, too many
  // files), do not hand a deliberately truncated project to the engine: it
  // would report a cascade of `missing-file` diagnostics about perfectly good
  // `\input`s, which says something false about the document.
  if (diagnostics.some((d) => d.severity === "error")) {
    return finish(job, diagnostics, null, null);
  }

  // The engine, on a thread of its own. Everything about *how* that thread is
  // supervised — the spawn, the terminate timer, and the five ways it can end —
  // is in `runEngineInWorker`; from here it is still one call that returns a
  // PDF, diagnostics and stats, which is why nothing below this line changed
  // when the engine moved.
  const result = await runEngineInWorker(job, tree.files);

  for (const d of result.diagnostics) diagnostics.push(d);

  // The engine reports a stop through `signal.aborted` and cannot know *why* it
  // was set — it says "compilation was cancelled" for the wall clock too. Its
  // diagnostic is left verbatim (it is the engine's own account of where it
  // stopped) and the reason is added beside it, so the log never claims a
  // person pressed Cancel when a timer fired.
  if (job.signal.timedOut) {
    diagnostics.push(
      wholeProject(
        `the compile hit the ${LATEX_TIMEOUT_MS}ms wall-clock limit and was stopped — this is the outer backstop, not the step budget`,
        "error",
        "stopped",
      ),
    );
  }

  // ## A cancel that lands while the artifacts are being written
  //
  // `runEngineInWorker`'s `message` handler covers the window up to `settle` —
  // a stop that got in first wins there, and the good PDF is dropped. The
  // window straight after it was covered by nothing: `finish` →
  // `persistOutcome` is a `mkdir` plus up to three `writeAtomic` calls, several
  // turns of the loop and, for a multi-MB PDF, several milliseconds of real
  // I/O. A cancel arriving on one of those turns sets the flag, finds
  // `job.worker` already `null` so `stopWorker` correctly no-ops and still
  // reports `true`, and the job then wrote `out.pdf`, graded the compile
  // `ready`, and left a `diagnostics.json` with no mention of a cancel — while
  // the route that delivered it answered `{ cancelled: true }`. The person
  // pressed Cancel, was told it worked, and the preview refreshed with the PDF
  // they had just cancelled.
  //
  // ### Why the `mkdir` is on this side of the check
  //
  // Taking that turn HERE, rather than leaving it to `persistOutcome`, is the
  // load-bearing half of this and not an optimisation. Everything between the
  // engine's result arriving and the line below is **microtasks**: `settle`
  // resolves, two `await`s resume, and the microtask queue drains to completion
  // before any timer or I/O callback can run. A check with no `await` in front
  // of it therefore cannot observe a flag that a *request* set, because the
  // request cannot run — it would be a guard on an empty window. `mkdir` is the
  // first real turn on this path, so the check has to sit on the far side of
  // it. What is left after that is the interior of `writeAtomic` itself, and a
  // cancel that lands there genuinely arrived after the compile was finished
  // and its output committed; un-writing it would destroy the last good PDF,
  // which brief 38 step 10 exists to preserve.
  //
  // ### Why `stopReason` is in the condition
  //
  // It narrows this to the *late* window. Anything that actually killed the
  // thread recorded a reason and `stopDiagnostic` has already put that account
  // into `result.diagnostics`; a second sentence beside it would assert one
  // stop for two reasons, which is exactly what `StopReason`'s doc comment
  // forbids.
  await ensureBuildDir(job.projectId);
  if (job.signal.cancelled && job.stopReason === null) {
    diagnostics.push(
      wholeProject(
        "the compile was cancelled just as it finished typesetting, so its output was discarded",
        "error",
        "stopped",
      ),
    );
    // Graded exactly as the pre-engine abort above is: no PDF, `stopped`,
    // `failed`. The stats go with the PDF — they describe bytes deliberately
    // not on disk, and a log line counting the pages of a discarded document
    // would be the same class of untruth as the wording this module works to
    // keep straight.
    return finish(job, diagnostics, null, null);
  }

  return finish(job, diagnostics, result.pdf, result.stats);
}

/** The engine was stopped before it ran at all. */
function abortDiagnostic(job: CompileJob): Diagnostic {
  return job.signal.timedOut
    ? wholeProject(`the compile hit the ${LATEX_TIMEOUT_MS}ms wall-clock limit before it started`, "error", "stopped")
    : wholeProject("the compile was cancelled", "error", "stopped");
}

interface EngineStats {
  pages: number;
  steps: number;
  bytes: number;
}

// --- Hosting the engine on a thread ------------------------------------------

/**
 * Why a job's thread was **killed**, as opposed to having finished.
 *
 * The distinction between the first two is not cosmetic. `compile.log` and
 * `diagnostics.json` are read precisely to find out what happened, and a wall
 * clock that claimed a person pressed Cancel would be a lie in the one file
 * somebody consults to check. Brief 38 kept `cancelled` and `timedOut` apart on
 * the signal for exactly this reason, and a kill has to preserve it — more so,
 * in fact: once a stop is a `terminate()` the engine is not running any more and
 * cannot report anything at all, so this value is the *only* surviving account
 * of the stop.
 */
type StopReason =
  /** `cancelLatexCompile` — a person, the delete path, or shutdown. */
  | "cancelled"
  /** The deadline passed and the thread did not stop on its own. */
  | "timed-out"
  /**
   * `runCompile` is unwinding and no thread may outlive its job. Deliberately
   * never rendered into a diagnostic: by the time this can fire the outcome has
   * already been decided (usually by a throw, which builds its own `internal`
   * diagnostic), and this is only about not leaking a thread.
   */
  | "abandoned";

/**
 * How long past `deadline` this module waits for the worker to stop on its own
 * before killing the thread.
 *
 * The worker's clock only fires where the engine polls, and it samples once per
 * `CLOCK_POLL_INTERVAL` polls, so an honest compile notices the deadline
 * slightly late and then still has to unwind, render its diagnostics and post
 * them. This grace is that slack, generously rounded.
 *
 * It is worth waiting at all because a cooperative stop is strictly better than
 * a kill — the engine gets to say *where* it stopped, which is the difference
 * between "your `\newcommand` on line 40 recursed" and "the compile was
 * stopped". It is worth being finite because a step that never returns is
 * precisely the case the wall clock exists for, and that step will not poll
 * again.
 */
const TERMINATE_GRACE_MS = 5_000;

/**
 * The worker's entry point, resolved next to this module.
 *
 * The extension is taken from **this file's own URL** rather than written down,
 * because the two ways `apps/api` runs disagree about it: under `npm run dev`
 * tsx loads `src/latex-compile.ts` and the only file beside it on disk is
 * `latex-worker.ts`, while from `dist/` it is `latex-worker.js` and the `.ts` is
 * not deployed at all. A literal `./latex-worker.js` — which is what every
 * *import* in this module writes, because tsx rewrites those — would be
 * `ERR_MODULE_NOT_FOUND` in dev, and the reverse would break production.
 *
 * `new Worker()` takes a `file:` URL rather than a module specifier, so no
 * loader rewrites this one on our behalf — and which loader ends up *reading*
 * `latex-worker.ts` in dev is not a thing this module should have to know.
 * Measured on Node 24 under tsx: tsx's hooks do reach the thread — syntax that
 * plain type stripping refuses (an `enum`) loads there — yet the thread also
 * reports `process.features.typescript === "strip"`, so Node's own stripper is
 * armed behind it. Which of the two wins is one release away from changing in
 * either direction. Hence rules 1 and 2 in
 * `latex-worker.ts`, no relative imports and erasable syntax only: they make
 * the question moot instead of betting on the answer.
 */
const WORKER_ENTRY = ((): URL => {
  const here = new URL(import.meta.url);
  return new URL(here.pathname.endsWith(".ts") ? "./latex-worker.ts" : "./latex-worker.js", here);
})();

/** What one run of the engine produced, in the shape `finish` consumes. */
interface EngineOutcome {
  pdf: Uint8Array | null;
  diagnostics: Diagnostic[];
  stats: EngineStats | null;
}

/**
 * Run `compile()` on a thread of its own, and return what it produced.
 *
 * **Never rejects.** Every failure — including the ones that are not failures
 * of the document at all, like a thread that could not be started — comes back
 * as an error-severity `Diagnostic` in the resolved value. `runCompile` would
 * catch a rejection, but it would catch it as "the compile failed unexpectedly"
 * with no idea what happened, and the editor's diagnostics panel is where a
 * person actually looks.
 *
 * ## One thread per compile, and why not one thread reused
 *
 * A long-lived worker that compiled job after job would keep the parsed font
 * provider warm — the cache this module used to hold, now paid again per compile
 * as ~1.2 MB across twelve `.otf` files re-read and re-parsed. Measured, that is
 * single-digit milliseconds against a compile of tens, the same order as
 * spawning the thread. The trade was declined anyway, for two reasons that both
 * matter more than the milliseconds:
 *
 *  1. **A reused thread cannot be killed.** `terminate()` on a shared worker
 *     destroys the *next* compile's host as well as this one's, so a reused
 *     design has to fall back to a cooperative stop — which is exactly the
 *     mechanism that does not work here, because the engine is synchronous and
 *     a killed-mid-step compile is the case the kill exists for. Cancellation
 *     being *real* is the whole point of brief 44; a design that gives it up to
 *     save 5ms has bought nothing.
 *  2. **A fresh thread starts from a clean heap.** The engine holds a whole
 *     document's boxes and glue while it works. One compile per heap means a
 *     runaway document's peak allocation is returned to the OS the moment its
 *     thread exits, and it means no compile can be affected by what the
 *     previous one left behind — which is the same property, at the process
 *     level, that makes `compile()`'s purity worth having (D38).
 *
 * ## Every way a thread can end
 *
 * All five settle this promise exactly once, and all five then run through
 * `runCompile`'s `finally`, which is the single owner of the slot release. The
 * `settled` guard is load-bearing rather than defensive: Node delivers `error`
 * *and* `exit` for a crash, and `message` *and* `exit` for a success, so more
 * than one handler firing is the normal case, not an edge one.
 *
 *  - **A result arrives** (`message`). The ordinary path. The handle is released
 *    and the thread killed immediately rather than waited on: it would exit by
 *    itself (nothing keeps its loop alive — see the worker's `Entry` comment),
 *    but not depending on that is what keeps a thread's life equal to a
 *    compile's.
 *  - **The thread throws** (`error`). Reported as `internal`. `latex-worker.ts`
 *    catches its own throws and posts `ok: false`, so reaching here means
 *    something it could not catch: a failed module load (this is where a broken
 *    `WORKER_ENTRY` or a stale `packages/typeset` build surfaces), or the V8
 *    heap.
 *  - **The thread is killed** (`exit` with `job.stopReason` set). A cancel, the
 *    wall clock, or shutdown. This module writes the diagnostic because the
 *    engine no longer exists to write one.
 *  - **The thread dies with nothing to say** (`exit`, no message, no
 *    `stopReason`). An `OOM`, a `process.exit` from deep inside a dependency, a
 *    SIGKILL to the thread. Reported as `internal` and *named as such* rather
 *    than being allowed to look like a document error.
 *  - **The thread never starts.** The `Worker` constructor can throw
 *    synchronously — a `file:` URL Node will not accept at all — so that one is
 *    not an event and is handled before the promise exists. A *missing* entry
 *    point is not that case, checked: Node accepts the URL and reports
 *    `ERR_MODULE_NOT_FOUND` through `error` instead. Both are covered; the
 *    synchronous branch is the one that would otherwise reject.
 */
async function runEngineInWorker(job: CompileJob, files: Record<string, Uint8Array>): Promise<EngineOutcome> {
  const request: LatexWorkerRequest = {
    files,
    entrypoint: job.project.entrypoint,
    // The emitted PDF, not the input: a small document can loop into an
    // enormous one. The engine refuses to allocate above this and reports
    // `limit-exceeded` rather than filling the disk. Passed by value because
    // the worker may not import `config.ts` (rule 1 in its module comment).
    maxOutputBytes: LATEX_MAX_OUTPUT_BYTES,
    // The deadline as an absolute instant, not a duration: the worker rebuilds
    // an equivalent signal around it, and the clock that matters is the one
    // `startLatexCompile` started — spawning the thread and cloning `files` both
    // happen inside the limit, not before it.
    deadline: job.deadline,
    // `stepBudget` and `maxPages` are deliberately not in this protocol. They
    // are the *deterministic* guard (D38) and belong to the engine's own
    // contract; a second, differently-tuned number chosen by whichever host
    // spawned the thread would make "this compile was stopped" depend on the
    // caller, which is the property the budget exists to provide.
  };

  let worker: Worker;
  try {
    worker = new Worker(WORKER_ENTRY, { workerData: request });
  } catch (cause) {
    // Not a failure of the document, and it must not read like one. In practice
    // this is a deployment problem — `dist/latex-worker.js` missing from a
    // partial build — so it names the path it tried.
    return internalOutcome(
      `the typesetting worker could not be started (${WORKER_ENTRY.pathname}) — ${describeCause(cause)}`,
    );
  }

  // Published before the first `await` so that a cancel arriving on the very
  // next turn has something to terminate. (There is no turn between
  // `compileAndPersist`'s abort check and this line, so no cancel can fall
  // between the two and be lost.)
  job.worker = worker;

  return await new Promise<EngineOutcome>((resolve) => {
    // The hard half of the two-layer timeout. The worker's own clock is the
    // cooperative half and is preferred; this fires only if that one did not,
    // which means the engine stopped polling — a single step that never
    // returns, the one case a step budget cannot see either.
    //
    // `unref` so a compile in flight cannot hold the process open for two
    // minutes on shutdown. Shutdown cancels every job anyway
    // (`cancelAllLatexCompiles`), which terminates the thread and clears this
    // timer through `settle`; the `unref` is for the paths that do not.
    const terminateTimer = setTimeout(
      () => {
        // **Nothing to kill means nothing to report.** `stopWorker`'s
        // idempotence protects `stopReason`, but it does not protect the
        // signal, and this timer is cleared only in `settle` — which cannot run
        // until the terminate-induced `exit` arrives. So a cancel at
        // `deadline + 4998` and this timer at `deadline + 5000` used to both
        // land: `stopReason` stayed `"cancelled"` (right), while `timedOut`
        // also went true and `compileAndPersist` added the wall-clock sentence
        // beside the cancellation — one stop asserted for two different
        // reasons, the exact thing `StopReason`'s doc comment says must not
        // happen. A cleared handle is the same "already stopping" signal
        // `stopWorker` reads, so the timer reads it too, and first.
        if (job.worker === null) return;
        // Recorded on the signal, not only on `stopReason`, so that
        // `compileAndPersist`'s existing wall-clock diagnostic still fires:
        // there is one sentence about the limit and it has one writer.
        job.signal.timeOut();
        stopWorker(job, "timed-out");
      },
      Math.max(0, job.deadline + TERMINATE_GRACE_MS - Date.now()),
    );
    terminateTimer.unref();

    // Declared after the timer so that clearing it is not a
    // used-before-declared closure. `settled` is not defensive: Node delivers
    // `message` *and* `exit` for a success and `error` *and* `exit` for a crash,
    // so a second handler firing is the normal case.
    let settled = false;
    const settle = (outcome: EngineOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(terminateTimer);
      resolve(outcome);
    };

    worker.on("message", (message: LatexWorkerResponse) => {
      // Release the handle FIRST, then kill. A cancel landing in this same turn
      // then finds `job.worker === null` and does nothing, rather than
      // recording a `stopReason` for a compile that had already finished.
      const stoppedBy = job.stopReason;
      job.worker = null;
      void worker.terminate();

      // **A stop that got in first wins, even though the result arrived.** The
      // window is real: `postMessage` is delivered on a later turn, so a cancel
      // can be issued after the worker posted and before this handler runs. The
      // result is perfectly good — and it is not wanted. Honouring it would mean
      // `DELETE /latex/:id` writes `out.pdf` into a tree it is about to remove,
      // and a person who pressed Cancel gets the PDF they cancelled. So the
      // outcome is the stop, and the PDF is dropped.
      if (stoppedBy !== null) {
        settle({ pdf: null, diagnostics: [stopDiagnostic(stoppedBy)], stats: null });
        return;
      }

      if (!message.ok) {
        // The worker caught its own throw — a font file that would not open, a
        // malformed request. It knows what happened; pass the sentence through.
        settle(internalOutcome(`the typesetting worker failed — ${message.message}`));
        return;
      }

      // The engine reports a stop through `signal.aborted` and cannot know *why*
      // the flag was set. Folding its answer back into this side's signal is
      // what lets `compileAndPersist` say "wall clock" rather than "cancelled";
      // see `CompileSignal.timeOut`.
      if (message.timedOut) job.signal.timeOut();

      settle({ pdf: message.pdf, diagnostics: message.diagnostics, stats: message.stats });
    });

    worker.on("error", (cause) => {
      job.worker = null;
      settle(internalOutcome(`the typesetting worker crashed — ${describeCause(cause)}`));
    });

    worker.on("exit", (code) => {
      // Whatever else happens, the thread is gone: clear the handle so nothing
      // can terminate a dead worker (or, worse, one a later compile owns).
      job.worker = null;
      // The ordinary path already settled on `message`; this is just the
      // thread's own confirmation that it ended.
      if (settled) return;

      const reason = job.stopReason;
      if (reason !== null) {
        settle({ pdf: null, diagnostics: [stopDiagnostic(reason)], stats: null });
        return;
      }
      // No result, no kill: the thread died on its own terms and said nothing.
      settle(
        internalOutcome(
          `the typesetting worker exited without producing a result (exit code ${code}) — the document was not compiled`,
        ),
      );
    });
  });
}

/**
 * Ask a job's thread to stop, and record why. **Idempotent** — call it from as
 * many racing places as you like.
 *
 * A cancel racing the result message, the shutdown sweep racing a cancel, and
 * `runCompile`'s unwind racing both must not between them call `terminate()`
 * twice or reach a thread that a later compile owns. Clearing `job.worker` is
 * the whole mechanism: it is the only handle, every writer nulls it, and a
 * second caller therefore finds nothing to do. That is cheaper and harder to
 * get wrong than a separate `stopping` flag, which would be a second piece of
 * state that could disagree with the first.
 *
 * `stopReason` is written **before** the `terminate()` it explains, and the
 * order is not stylistic: `exit` can be delivered on the very next turn, the
 * exit handler is what reads `stopReason` to decide whether this was a stop or
 * a crash, and a kill that arrived looking like a crash would report `internal`
 * about a compile somebody cancelled on purpose.
 *
 * The status is not written here either. `runCompile`'s `finally` remains the
 * single owner of every transition off `running`.
 */
function stopWorker(job: CompileJob, reason: StopReason): void {
  const worker = job.worker;
  if (worker === null) return; // never spawned, already exited, or already stopping
  job.stopReason = reason;
  job.worker = null;
  // `terminate()` resolves with the exit code; the `exit` handler is what acts
  // on the stop, so there is nothing to await here and nothing to do if the
  // thread was already dead.
  void worker.terminate();
}

/** The account of a stop that only this module can give — see `StopReason`. */
function stopDiagnostic(reason: StopReason): Diagnostic {
  switch (reason) {
    case "cancelled":
      return wholeProject("the compile was cancelled while the document was being typeset", "error", "stopped");
    case "timed-out":
      // Deliberately *not* a restatement of the limit: `compileAndPersist` adds
      // that sentence, from `job.signal.timedOut`, which the terminate timer
      // sets. This one says the part that sentence cannot — that the thread was
      // killed, so no account from the engine survives.
      //
      // It says "none was kept", not "the engine could not report one", and the
      // difference is not pedantry. The engine's own clock may well have fired
      // first: it unwinds, renders its diagnostics and posts them at, say,
      // `deadline + 4990`, the host is briefly busy so the timers phase runs
      // before the message queue, and the `terminate()` lands on a thread that
      // had already said exactly where it stopped. The `message` handler then
      // drops that report — deliberately, because a stop that got in first
      // wins — and the graded outcome is right either way. Only the sentence
      // was wrong, claiming the engine could not report something it may have
      // just reported.
      return wholeProject(
        `the typesetting thread was killed ${TERMINATE_GRACE_MS}ms past the limit, so no engine report of where it stopped was kept`,
        "error",
        "stopped",
      );
    case "abandoned":
      return wholeProject("the compile was abandoned and its typesetting thread stopped", "error", "stopped");
  }
}

/**
 * A failure of the *host*, not of the document. `internal` is the code the
 * editor's panel renders without pointing at a line of LaTeX, which is right:
 * nothing the author wrote caused this and no edit will fix it.
 */
function internalOutcome(message: string): EngineOutcome {
  return { pdf: null, diagnostics: [wholeProject(message, "error", "internal")], stats: null };
}

/** `Error` if it is one, and something readable if it is not — `throw "nope"`
 *  is legal JavaScript and a log that said `[object Object]` would waste an
 *  hour of somebody's evening. */
function describeCause(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}

/** Grade the outcome, render the log, write the artifacts. */
async function finish(
  job: CompileJob,
  diagnostics: Diagnostic[],
  pdf: Uint8Array | null,
  stats: EngineStats | null,
): Promise<LatexCompileResult> {
  // `ready` requires BOTH a PDF and no error-severity diagnostic. The engine
  // already withholds the PDF whenever it produced an error, so the two agree;
  // requiring both means a diagnostic this module added (a symlink skip that
  // was fatal, the wall clock) cannot be outvoted by an engine that had already
  // finished emitting. Warnings do not fail a compile — that is what the
  // diagnostics panel is for (see `COMPILE_STATUSES` in shared).
  const failed = pdf === null || diagnostics.some((d) => d.severity === "error");
  const status: CompileStatus = failed ? "failed" : "ready";
  const log = renderLog(job, diagnostics, stats, Date.now() - job.startedAt);
  const outcome: LatexCompileResult = { status, log, diagnostics };

  // The PDF is written only on success — a failed compile must leave the last
  // good one in place. See `draftPdfPathFor`.
  await persistOutcome(job.projectId, outcome, status === "ready" ? pdf : null);
  return outcome;
}

// --- Artifacts ---------------------------------------------------------------

/** What `diagnostics.json` holds. The log is its own file; the PDF is its own
 *  file. `compile_status` on the row is the durable half only — there is no
 *  error column in the schema, so this is where the *why* lives. */
const storedOutcomeSchema = z.object({
  status: compileStatusSchema,
  compiledAt: z.string(),
  diagnostics: z.array(diagnosticSchema),
});

/**
 * `mkdir -p` the project's build directory.
 *
 * Called from **two** places on the ordinary path — `compileAndPersist`, before
 * it takes its last look at the cancel flag, and `persistOutcome`, which must
 * still work for the `runCompile` catch path that never went through
 * `compileAndPersist` at all. Idempotent, so the second call is one cheap
 * syscall; see `compileAndPersist` for why the first one is not optional.
 */
async function ensureBuildDir(projectId: string): Promise<void> {
  await mkdir(latexBuildDirFor(projectId), { recursive: true });
}

async function persistOutcome(
  projectId: string,
  outcome: LatexCompileResult,
  pdf: Uint8Array | null,
): Promise<void> {
  await ensureBuildDir(projectId);

  const stored: z.infer<typeof storedOutcomeSchema> = {
    status: outcome.status,
    compiledAt: new Date().toISOString(),
    diagnostics: outcome.diagnostics,
  };

  // The PDF first, then the log, then the diagnostics — so that the file the
  // editor treats as the statement of record (`diagnostics.json`, which carries
  // the status) is the last to appear. A reader that catches a compile
  // mid-write sees the *previous* status alongside the previous PDF, which is
  // consistent, rather than a new status pointing at a PDF not yet written.
  if (pdf !== null) await writeAtomic(draftPdfPathFor(projectId), pdf);
  await writeAtomic(compileLogPathFor(projectId), outcome.log);
  await writeAtomic(compileDiagnosticsPathFor(projectId), `${JSON.stringify(stored, null, 2)}\n`);
}

/**
 * Write via a temporary file in the same directory and rename into place.
 *
 * `GET /latex/:id/pdf` and `GET /latex/:id/log` can be served at any moment,
 * including while a compile is writing — the editor polls. A plain `writeFile`
 * truncates first, so a reader landing in that window gets a half-written PDF
 * and a viewer error. `rename` within one directory is atomic on every
 * filesystem this runs on, so a reader sees either the old file or the new one.
 *
 * **Exported** because the publish path has the identical hazard on a different
 * file: `GET /library/:id/file` stats the library PDF, sends a `Content-Length`
 * and streams it, while a re-publish rewrites that same path — and the library
 * ETag is the book id, unchanged across publishes, so a browser can cache the
 * spliced result. One helper, not two: see `writeLibraryArtifacts`.
 */
export async function writeAtomic(path: string, data: Uint8Array | string): Promise<void> {
  const temp = `${path}.tmp`;
  try {
    await writeFile(temp, data);
    await rename(temp, path);
  } catch (cause) {
    await rm(temp, { force: true }).catch(() => {});
    throw cause;
  }
}

/**
 * Re-serve the last compile's result — what `GET /latex/:id/log` returns, and
 * what the editor reads on load so a reopened project still shows the errors
 * from the compile before it.
 *
 * `null` when the project has never been compiled (or its artifacts were
 * removed). The stored JSON is **validated**, not trusted: it is a file on
 * disk that survives deploys, so a shape from an older build must be reported
 * as "no result" rather than crash a route or reach the client as a diagnostic
 * the panel cannot render.
 */
export async function readLatexCompileResult(projectId: string): Promise<LatexCompileResult | null> {
  let raw: string;
  try {
    raw = await readFile(compileDiagnosticsPathFor(projectId), "utf8");
  } catch {
    return null;
  }

  let stored: z.infer<typeof storedOutcomeSchema>;
  try {
    const parsed = storedOutcomeSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    stored = parsed.data;
  } catch {
    return null;
  }

  // The log is a convenience, not the record: a missing one still leaves a
  // perfectly usable structured result.
  const log = await readFile(compileLogPathFor(projectId), "utf8").catch(() => "");
  return { status: stored.status, log, diagnostics: stored.diagnostics };
}

/**
 * Delete a project's build artifacts. For the delete path (which then removes
 * the whole tree anyway) and for anything that wants a project back to
 * never-compiled. Never throws — a leftover artifact is a smaller problem than
 * a failed delete.
 */
export async function removeLatexBuildArtifacts(projectId: string): Promise<void> {
  await rm(latexBuildDirFor(projectId), { recursive: true, force: true }).catch(() => {});
}

// --- The log -----------------------------------------------------------------

/**
 * The plain-text log, behind the editor's "show raw log" affordance.
 *
 * The engine has no log of its own — it returns structured diagnostics, which
 * is the better thing — so this renders one in the shape a LaTeX writer expects
 * (`file:line:column: severity: message`), plus what only the job knows: which
 * entrypoint was compiled, how long it took, and what it cost against the step
 * budget. The structured diagnostics remain the record; this is for reading.
 */
function renderLog(
  job: CompileJob,
  diagnostics: Diagnostic[],
  stats: EngineStats | null,
  elapsedMs: number,
): string {
  const lines: string[] = [
    "Atrium typesetting engine",
    `project:    ${job.project.title}`,
    `entrypoint: ${job.project.entrypoint}`,
    `started:    ${new Date(job.startedAt).toISOString()}`,
    "",
  ];

  if (diagnostics.length === 0) {
    lines.push("No diagnostics.");
  } else {
    for (const d of diagnostics) lines.push(formatDiagnostic(d));
  }

  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.filter((d) => d.severity === "warning").length;
  lines.push("");
  if (stats !== null) {
    lines.push(`${stats.pages} page(s), ${stats.steps} step(s), ${stats.bytes} byte(s) of PDF`);
  }
  lines.push(`${errors} error(s), ${warnings} warning(s), ${elapsedMs}ms`);
  return `${lines.join("\n")}\n`;
}

function formatDiagnostic(d: Diagnostic): string {
  // `line: 0` is the contract's "no single line". Printing `file:0:` would look
  // like a real position and send a click to the top of the wrong file.
  const where = d.file === "" ? "<project>" : d.line === 0 ? d.file : `${d.file}:${d.line}${d.column === undefined ? "" : `:${d.column}`}`;
  const code = d.code === undefined ? "" : ` [${d.code}]`;
  return `${where}: ${d.severity}: ${d.message}${code}`;
}
