import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { compile, createLatinModernProvider } from "@ebook-reader/typeset";
import type { AbortLike, FontProvider } from "@ebook-reader/typeset";
import { loadLatinModernBytes } from "@ebook-reader/typeset/fonts/node";
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
} from "./config.js";
import { projectDirFor } from "./paths.js";
import { getRunningLatexCompile, setLatexCompileStatus, touchLatexProject, type LatexProjectRow } from "./db.js";

/**
 * The LaTeX compile job (brief 38 step 3) — brief 34's job runner with the
 * child process taken out.
 *
 * `packages/typeset` is a **pure synchronous function** (D38): bytes in, PDF
 * and diagnostics out, no filesystem and no subprocess. So this module is the
 * half the engine deliberately does not have — it reads the project's working
 * tree off disk into an in-memory file map, injects the fonts, calls
 * `compile()`, and writes the PDF, the log and the diagnostics back out as
 * artifacts. Everything dangerous that brief 36 needed a sandbox for is simply
 * absent: there is no shell to escape and no path a document can name.
 *
 * Three things here are not obvious and are explained where they happen:
 *
 * 1. **The slot-release discipline** (`runCompile`'s `finally`, and
 *    `cancelLatexCompile`). Brief 34 shipped a Critical exactly here.
 * 2. **The two-layer timeout** (`createCompileSignal`). The engine's step
 *    budget is the real guard; `LATEX_TIMEOUT_MS` is a backstop, and because
 *    the engine is synchronous it can only be enforced *through* the signal.
 * 3. **What the tree walk refuses to read** (`readProjectTree`) — symlinks, in
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

/**
 * The Latin Modern faces, read once per process and shared by every compile.
 *
 * The engine performs no I/O of its own (D38), so somebody has to open the font
 * files, and `@ebook-reader/typeset/fonts/node` is the one module in that
 * package permitted to. **That somebody is this line** — omit `fonts` and the
 * compile stops with a `missing-font` error and an empty result rather than
 * quietly setting the document in some other face.
 *
 * The bytes are ~1.2 MB across twelve `.otf` files committed inside the typeset
 * package (`packages/typeset/assets/fonts/`), and the provider parses each face
 * lazily on first request and caches the handle. Loading is deferred to the
 * first compile rather than done at import so that starting the API does not
 * pay for a feature nobody may use this boot; after that it is free.
 */
let fontProvider: FontProvider | null = null;
function fonts(): FontProvider {
  if (fontProvider === null) fontProvider = createLatinModernProvider(loadLatinModernBytes());
  return fontProvider;
}

// --- Cancellation and the two-layer timeout ----------------------------------

/**
 * Why the wall clock has to travel through the abort signal.
 *
 * `compile()` is **synchronous**. It returns to this module only once the whole
 * document is typeset, so while it runs nothing else in this process runs
 * either — no timer fires, no request is read, no `setTimeout` callback gets a
 * turn. A `setTimeout(kill, LATEX_TIMEOUT_MS)` would therefore be scheduled,
 * never delivered until after the compile it was supposed to bound, and the
 * timeout would be decorative.
 *
 * `CompileOptions.signal` is not a subscription — the engine *polls*
 * `signal.aborted` at every step boundary (see `spend()` in
 * `packages/typeset/src/macro/budget.ts`), and `AbortLike` is structural: any
 * object with an `aborted` boolean satisfies it. So a **getter** that reads the
 * clock is evaluated inside the engine's own loop, which is the one place
 * during a synchronous compile where anything of ours can still run. That is
 * how the outer backstop gets teeth.
 *
 * The two layers, and why both exist:
 *
 * - The **step budget** is the real guard. It is a count, so it stops a runaway
 *   `\newcommand` at the same point on every machine, which makes "this compile
 *   was stopped" reproducible and testable (D38). Measured on this repo's own
 *   fixtures a runaway hits the 5,000,000-step default in about 50 ms.
 * - The **wall clock** covers only what a step count cannot see: work that is
 *   not a step. It is set generously (two minutes) precisely so it never
 *   arbitrates a legitimate document — that would trade the determinism the
 *   budget just bought for a machine-speed lottery.
 *
 * The clock is sampled every `CLOCK_POLL_INTERVAL` polls rather than on each
 * one: a runaway spends five million steps, and five million `Date.now()` calls
 * would be a measurable tax on every ordinary compile for a limit that is two
 * minutes wide. The sampling interval is far finer than the resolution anyone
 * could care about at that scale.
 */
const CLOCK_POLL_INTERVAL = 1024;

interface CompileSignal extends AbortLike {
  /** Set by `cancelLatexCompile`. The engine sees it at its next step. */
  cancel(): void;
  /** True when the *wall clock*, not the user, stopped this compile. */
  readonly timedOut: boolean;
  /** True when `cancel()` was called. */
  readonly cancelled: boolean;
}

function createCompileSignal(deadline: number): CompileSignal {
  let cancelled = false;
  let timedOut = false;
  let polls = 0;

  return {
    cancel(): void {
      cancelled = true;
    },
    get cancelled(): boolean {
      return cancelled;
    },
    get timedOut(): boolean {
      return timedOut;
    },
    get aborted(): boolean {
      if (cancelled || timedOut) return true;
      // Post-increment, so the very FIRST poll reads the clock: this module
      // checks `aborted` itself before handing the thread to the engine, and a
      // check that could not fire until poll 1024 would make that pre-flight
      // check decorative.
      if (polls++ % CLOCK_POLL_INTERVAL !== 0) return false;
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
   * The job's own outcome promise — the same one the route awaits.
   *
   * Held on the job so that `cancelAndSettleLatexCompile` can wait for the work
   * to actually FINISH rather than merely be told to stop. Null for the instant
   * between claiming the slot and scheduling the work (see `startLatexCompile`);
   * nothing outside this module can observe that window, because the job is not
   * reachable until `startLatexCompile` returns.
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
 * The decision is made **synchronously** — no `await` between the single-flight
 * check and `setLatexCompileStatus(id, "running")`, because an await there is
 * precisely what would let two requests both see a free slot and both take it.
 * The work itself starts on a later turn of the event loop (see
 * `scheduleCompile`).
 *
 * `userId` is the account, not the profile: `getRunningLatexCompile` joins
 * through `profiles.user_id` for the same reason (D35).
 */
export function startLatexCompile(project: LatexProjectRow, userId: string): StartLatexCompileResult {
  // Durable half first, because it also covers a compile this process did not
  // start — and, after a crash, is reaped to `failed` at import rather than
  // resumed, so it can never wedge a slot across a restart.
  const running = getRunningLatexCompile(userId);
  if (running) {
    return {
      kind: "busy",
      message: busyMessage(running, project),
      runningProject: running,
    };
  }
  // In-process half, checked account-wide too. This catches the window the row
  // cannot: a project deleted mid-compile takes its `running` row with it, so
  // the durable slot silently disappears while the job is still holding the
  // engine. Without this check a second compile would start against a process
  // that is already busy.
  for (const job of jobs.values()) {
    if (job.userId === userId) {
      return {
        kind: "busy",
        message: busyMessage(job.project, project),
        runningProject: job.project,
      };
    }
  }

  const signal = createCompileSignal(Date.now() + LATEX_TIMEOUT_MS);
  const job: CompileJob = {
    projectId: project.id,
    userId,
    project,
    signal,
    startedAt: Date.now(),
    done: null,
  };

  // ## The claim is all-or-nothing, and this try/catch is what makes it so
  //
  // `jobs.set` is the in-process half of the guard and `runCompile`'s `finally`
  // is the ONLY thing that ever releases it — but that `finally` belongs to a
  // function that has not been scheduled yet. So anything that throws between
  // the two lines below leaves a map entry no code path will ever delete: the
  // exception escapes to the route as a 500, `runCompile` never runs, and every
  // subsequent `startLatexCompile` on this ACCOUNT then matches the
  // `for (const job of jobs.values())` check above and returns 409 — for every
  // project, on every profile, until the process restarts. Compilation is
  // wedged account-wide by a failure that had nothing to do with compiling.
  //
  // `setLatexCompileStatus` is a database write, and `SQLITE_FULL` is entirely
  // plausible for a feature whose whole job is writing PDFs, zips and covers.
  // This is brief 34's Critical in the in-memory half: a claimed slot that is
  // never released. Unclaim, then rethrow.
  jobs.set(project.id, job);
  try {
    setLatexCompileStatus(project.id, "running");
    job.done = scheduleCompile(job);
  } catch (cause) {
    jobs.delete(project.id);
    throw cause;
  }

  return { kind: "started", done: job.done };
}

function busyMessage(running: LatexProjectRow, requested: LatexProjectRow): string {
  const subject = running.id === requested.id ? "This project" : `“${running.title}”`;
  // No "…or cancel it": there is no cancel route, and there cannot usefully be
  // one today. `compile()` is synchronous and holds the event loop for its whole
  // duration, so a cancel request could not even be READ while the engine runs
  // (see `cancelLatexCompile`). Cancelling is reachable only from
  // `DELETE /latex/:id` and from shutdown. Promising the user an action they
  // cannot take is worse than promising nothing; a real cancel needs the engine
  // hosted on a worker thread, which is a later brief. Restore this half of the
  // sentence only alongside a route that actually serves it.
  return `${subject} is already compiling. Only one compile runs at a time — wait for it to finish and try again.`;
}

/**
 * Hand the event loop one turn before the engine takes it away.
 *
 * `compile()` is synchronous and blocks this process for its whole duration, so
 * whatever has not been flushed when it starts waits until it ends. The
 * `setImmediate` lets the route's response go out first — and it is also the
 * only window in which a `cancelLatexCompile` can be *delivered*, since a
 * cancel arriving after the engine has the thread cannot be processed until the
 * engine gives it back. That limitation is inherent to an in-process
 * synchronous engine and is stated plainly on `cancelLatexCompile`.
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
 * **What "cancel" can and cannot do here.** The engine is a synchronous
 * in-process function, so there is no process to kill and no thread to
 * interrupt: cancellation is cooperative, and the engine observes it by polling
 * `signal.aborted` between steps. Setting the flag is therefore instantaneous,
 * but it can only be *observed* while the engine holds the thread — which means
 * a cancel that arrives while `compile()` is running cannot be delivered at
 * all, because this process is not reading requests until it returns. In
 * practice compiles of documents brief 37's engine can render finish in tens of
 * milliseconds and the step budget bounds even a runaway to about the same, so
 * the window a cancel usefully lands in is the queued one before the engine
 * starts. A truly long compile would need the engine moved onto a worker
 * thread; that is a change to how this module *hosts* the engine, not to the
 * engine, and nothing in this contract would change with it.
 *
 * The status is **not** written here. `runCompile`'s `finally` owns every
 * transition off `running`, so there is exactly one place that releases a slot.
 */
export function cancelLatexCompile(projectId: string): boolean {
  const job = jobs.get(projectId);
  if (!job) return false;
  job.signal.cancel();
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
 * promise. That wait is bounded in practice for the same reason a cancel cannot
 * be delivered mid-compile: while `compile()` holds the thread this handler is
 * not running at all, so a job we are able to await is one that is queued or
 * already in an `await`, and a cancelled job aborts at its very next check.
 *
 * `done` never rejects (see `runCompile`), but it is guarded anyway — a delete
 * must not be able to 500 because a compile it was cleaning up misbehaved.
 */
export async function cancelAndSettleLatexCompile(projectId: string): Promise<boolean> {
  const job = jobs.get(projectId);
  if (!job) return false;
  job.signal.cancel();
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
 *  - the DB write is itself wrapped, because `setLatexCompileStatus` on a
 *    project deleted mid-compile is a harmless zero-row UPDATE but a *broken*
 *    database is not, and a throw at that point would escape the `finally`;
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
    const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    const diagnostics: Diagnostic[] = [wholeProject(`the compile failed unexpectedly — ${message}`, "error", "internal")];
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
    try {
      setLatexCompileStatus(job.projectId, status);
      // The files on disk changed (the artifacts), and the project list is
      // ordered by `updated_at`. A compile is the one thing that changes a
      // project without going through a file write.
      touchLatexProject(job.projectId, new Date().toISOString());
    } catch {
      // The row is gone (the project was deleted mid-compile — a zero-row
      // UPDATE, which is the correct outcome and not an error) or the database
      // itself is unavailable. Either way the slot is already released: the map
      // entry above is gone, and a row that no longer exists cannot be
      // `running`.
    }
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
  // the one place in this job where an `await` gives it the chance to. Stopping
  // here saves the engine's work and, more importantly, means a cancelled
  // compile never writes a PDF the person said they did not want.
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

  const result = compile(tree.files, job.project.entrypoint, {
    signal: job.signal,
    // The emitted PDF, not the input: a small document can loop into an
    // enormous one. The engine refuses to allocate above this and reports
    // `limit-exceeded` rather than filling the disk.
    maxOutputBytes: LATEX_MAX_OUTPUT_BYTES,
    fonts: fonts(),
    // `stepBudget` and `maxPages` are deliberately left at the engine's
    // defaults. They are the *deterministic* guard (D38) and belong to the
    // engine's own contract; a second, differently-tuned number here would
    // make "this compile was stopped" depend on which caller ran it, which is
    // the property the budget exists to provide.
  });

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

async function persistOutcome(
  projectId: string,
  outcome: LatexCompileResult,
  pdf: Uint8Array | null,
): Promise<void> {
  const dir = latexBuildDirFor(projectId);
  await mkdir(dir, { recursive: true });

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
