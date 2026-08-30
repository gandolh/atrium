import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { projectDirFor } from "../../common/paths.js";

/**
 * Path confinement for LaTeX projects (brief 38, step 4).
 *
 * The typesetting engine is a pure function with no I/O (D38): it resolves
 * `\input` against an in-memory file map, so there is no filesystem for a
 * document to escape and nothing to sandbox. **This module is where the
 * sandbox actually lives**, because this brief is the half that accepts
 * uploads and writes them to disk. Create, write, rename, delete and the
 * `entrypoint` field all take a project-relative path from the client, and in
 * the brief's own words: *one unchecked join here is an arbitrary file write*.
 *
 * Why this is a separate module from `paths.ts`: `paths.ts` is a pure function
 * of **trusted, server-generated ids** — it derives where a file lives and
 * cannot say no. This module takes **untrusted text**, touches the filesystem
 * to resolve symlinks, and its entire job is saying no. Those are different
 * contracts (sync/total vs async/fallible) and different review burdens;
 * mixing them would mean a reader of `paths.ts` could no longer assume its
 * inputs were safe.
 *
 * ## The rejections, and what each one defends against
 *
 * - **Absolute paths.** `/etc/passwd` joined onto a root is not "inside the
 *   root" in any sense a `join()` respects — `path.join(root, "/etc/passwd")`
 *   happens to give `<root>/etc/passwd`, but `path.resolve(root, "/etc/passwd")`
 *   gives `/etc/passwd`. Depending on which one a future caller reaches for,
 *   the same input is either harmless or total compromise. Rejecting outright
 *   means that choice can never matter.
 *
 * - **Windows-shaped absolutes** (`C:\Windows\...`, UNC `\\server\share`) and
 *   **any backslash at all**. The API runs on Linux, where `\` is an ordinary
 *   filename character — so `figures\..\..\etc\passwd` would be accepted as one
 *   very strange filename here, and then mean something entirely different to
 *   any Windows client, archive tool, or future port that interprets it as a
 *   separator. The input is untrusted *text arriving over HTTP*, not a local
 *   filename, so it must not depend on which OS is reading it. One rule —
 *   forward slashes only — removes the whole disagreement.
 *
 * - **`..` traversal, including post-normalization.** `figures/../../../etc`
 *   contains no leading `..` and looks tame until it is normalized. So the
 *   check runs *after* `path.normalize`, on the collapsed form: if any `..`
 *   survives normalization, the path escapes. Checking before normalizing (or
 *   only scanning for a leading `../`) is the classic near-miss.
 *
 * - **Symlinks out of the project.** A `.tex` file cannot create a symlink, but
 *   the project tree is real user-writable disk and links can arrive by other
 *   routes (a restored archive, a hand-edited deploy). A symlink is invisible
 *   to every string-level check: `<root>/figures/plot.png` is textually inside
 *   the root no matter where `figures` points. So the final decision is made on
 *   **resolved** paths, after `realpath`.
 *
 * - **Dangling symlinks.** The subtle one. `realpath` on a link whose target
 *   does not exist throws `ENOENT` — indistinguishable, to a naive
 *   implementation, from "this file has not been created yet". Treating it as
 *   the latter accepts the path, and the subsequent `writeFile` *follows the
 *   link* and creates the file at its target. A link named `out.pdf` pointing
 *   at `/etc/cron.d/x` is an arbitrary file write through a check that passed.
 *   Resolving component-by-component with `lstat` (below) is what separates the
 *   two cases, and a dangling link is refused.
 *
 * - **Empty, `.`-only, and NUL-containing paths.** Empty and `.` both resolve
 *   to the project root itself, which is a directory, not a file — a write
 *   there is a bug in the caller, and letting it through means `EISDIR` at some
 *   distant point instead of a 400 here. A NUL byte truncates the path at the
 *   syscall boundary in C, the classic trick for making a validator and the
 *   kernel disagree about what the filename is; Node rejects it too, but this
 *   layer must not rely on a downstream check for a security property.
 *
 * ## What this layer deliberately does NOT do: decoding
 *
 * `%2e%2e%2f` is **accepted here, as a literal filename**, and that is correct.
 * Percent-decoding is the transport layer's job and Fastify has already done it
 * exactly once by the time a route hands a value here. Decoding again would
 * make this a *double* decoder, which is its own vulnerability class: a client
 * sends `%252e%252e%252f`, the transport decodes it to `%2e%2e%2f`, and this
 * layer would helpfully finish the job into `../` — an escape manufactured by
 * the validator itself. So the contract for chunk 4's routes is: **hand this
 * function text that has been decoded exactly once, and never decode it
 * yourself.** A file literally named `%2e%2e%2f` is created inside the project
 * and harms nobody.
 *
 * ## Residual risk
 *
 * The check and the write are two operations, so a sufficiently determined
 * local attacker could swap a component for a symlink in between (TOCTOU).
 * Closing that needs `openat`-style resolution Node does not expose. It is
 * accepted here: Atrium is a single-household server, the project tree is only
 * writable by the API process itself, and an attacker already able to create
 * symlinks in it has the filesystem access this check was protecting.
 */

/** Why a path was refused. Stable strings — routes may map these to messages. */
export type ConfinementReason =
  | "empty"
  | "nul-byte"
  | "backslash"
  | "absolute"
  | "traversal"
  | "too-long"
  | "escapes-root"
  | "dangling-symlink"
  | "bad-project-id"
  | "unresolvable";

/**
 * The outcome of confining one untrusted path.
 *
 * A **result object, not an exception**, deliberately: a rejected path is the
 * expected case for a route (a client sent something bad → 400), not an
 * exceptional one, and a `try`/`catch` around a path check is easy to forget
 * and impossible to see in review. `ok: false` cannot be ignored by accident —
 * TypeScript will not let a caller reach `absolutePath` without narrowing.
 */
export type ConfinedPath =
  | {
      ok: true;
      /** The normalized, POSIX-style project-relative path, e.g. `figures/plot.png`. */
      relativePath: string;
      /** The absolute path safe to open, read, write or unlink. */
      absolutePath: string;
    }
  | { ok: false; reason: ConfinementReason; message: string };

/** Longest accepted normalized path, and longest single segment. */
const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENT_LENGTH = 255; // ext4's NAME_MAX; longer is ENAMETOOLONG anyway.

function reject(reason: ConfinementReason, message: string): ConfinedPath {
  return { ok: false, reason, message };
}

/**
 * Stage 1: the lexical checks, on the text alone.
 *
 * Returns the normalized relative path, or a rejection. Everything here is a
 * pure string operation and cannot be affected by what is on disk, which is
 * why it runs first: nothing untrusted reaches a syscall until it has passed.
 */
function normalizeRelative(untrustedPath: string): ConfinedPath | string {
  if (untrustedPath.includes("\0")) {
    return reject("nul-byte", "Path contains a NUL byte.");
  }
  const trimmed = untrustedPath.trim();
  if (trimmed === "") {
    return reject("empty", "Path is empty.");
  }
  if (trimmed.length > MAX_PATH_LENGTH) {
    return reject("too-long", `Path is longer than ${MAX_PATH_LENGTH} characters.`);
  }
  // Before any separator interpretation: `\` must not appear at all. This one
  // rule covers `C:\Windows\system32`, UNC `\\server\share`, and a Windows
  // client's `figures\plot.png` — see the module doc.
  if (trimmed.includes("\\")) {
    return reject(
      "backslash",
      "Path contains a backslash. Use forward slashes; project paths are POSIX-style.",
    );
  }
  // A drive letter with a forward slash (`C:/Windows`) is not caught by the
  // backslash rule and is not `isAbsolute` on Linux, but it is unmistakably an
  // absolute path from a client that thinks it is on Windows.
  if (/^[A-Za-z]:\//.test(trimmed)) {
    return reject("absolute", "Path is absolute. Project paths must be relative.");
  }
  if (isAbsolute(trimmed)) {
    return reject("absolute", "Path is absolute. Project paths must be relative.");
  }

  // Normalize AFTER the absolute checks and BEFORE the traversal check: this is
  // what collapses `figures/../../../etc/passwd` into `../../etc/passwd`, where
  // the escape is finally visible as a leading `..`.
  const normalized = normalize(trimmed).replace(/\/+$/, "");
  if (normalized === "" || normalized === ".") {
    return reject("empty", "Path resolves to the project root, not a file.");
  }
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) {
    return reject(
      "traversal",
      "Path escapes the project directory. `..` segments are not allowed.",
    );
  }
  // Belt and braces: no `..` may survive anywhere. `normalize` should have left
  // interior ones only in the leading position, but this check does not depend
  // on that being true of every Node version.
  const segments = normalized.split(sep);
  if (segments.includes("..")) {
    return reject(
      "traversal",
      "Path escapes the project directory. `..` segments are not allowed.",
    );
  }
  if (segments.some((s) => s.length > MAX_SEGMENT_LENGTH)) {
    return reject("too-long", `A path segment exceeds ${MAX_SEGMENT_LENGTH} characters.`);
  }
  return normalized;
}

/** True when `candidate` is strictly inside `root` (not `root` itself). */
function isStrictlyInside(root: string, candidate: string): boolean {
  // Compares two ALREADY-RESOLVED absolute paths, and requires the separator:
  // a bare `candidate.startsWith(root)` would consider `/projects/abcdef` to be
  // inside `/projects/abc`, which is the sibling-prefix bypass.
  return candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * `realpath` the deepest part of `dir` that exists, and return it with the
 * segments that did not. Used for the project root, which may legitimately not
 * exist yet (a project whose directory is created lazily) while still sitting
 * under a symlinked ancestor such as `/tmp` on some systems.
 */
async function realpathOfExistingPrefix(dir: string): Promise<string> {
  const missing: string[] = [];
  let cursor = resolve(dir);
  for (;;) {
    try {
      return join(await realpath(cursor), ...missing);
    } catch {
      const parent = resolve(cursor, "..");
      if (parent === cursor) return join(cursor, ...missing); // filesystem root
      missing.unshift(cursor.slice(parent.length).replace(/^[/\\]/, ""));
      cursor = parent;
    }
  }
}

/**
 * Confine an untrusted, project-relative path under an already-trusted root.
 *
 * Stage 2: resolve the path **one component at a time** from the root, using
 * `lstat` to find symlinks and `realpath` to follow them, checking containment
 * after every step.
 *
 * Walking component-by-component rather than calling `realpath` on the whole
 * target is what makes this correct for a file that **does not exist yet** —
 * the create/write case, and exactly where naive implementations fail. When a
 * component is missing, everything below it is missing too, so no symlink can
 * be hiding in the remainder: the tail is appended literally and the resolved
 * prefix is what the containment check runs against. A whole-path `realpath`
 * cannot distinguish that safe case from a dangling symlink (see the module
 * doc); this walk can, and refuses the latter.
 */
export async function confinePathUnder(
  rootDir: string,
  untrustedPath: string,
): Promise<ConfinedPath> {
  const lexical = normalizeRelative(untrustedPath);
  if (typeof lexical !== "string") return lexical;

  const rootReal = await realpathOfExistingPrefix(rootDir);
  const segments = lexical.split(sep);

  let cursor = rootReal;
  for (let i = 0; i < segments.length; i++) {
    const next = join(cursor, segments[i]!);
    let info;
    try {
      info = await lstat(next);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        // Nothing exists from here down, so nothing below can be a symlink.
        // Append the rest verbatim and let the single check below decide.
        cursor = join(next, ...segments.slice(i + 1));
        break;
      }
      // Anything else (EACCES, ELOOP, ENAMETOOLONG, …) means we could not
      // establish where this path really points. Fail closed.
      return reject("unresolvable", `Path could not be resolved (${code ?? "unknown"}).`);
    }

    if (info.isSymbolicLink()) {
      try {
        cursor = await realpath(next);
      } catch {
        // A link whose target does not exist. Refused rather than treated as
        // "not created yet": a write would follow it and create the file at
        // wherever it points, which is the arbitrary-write case.
        return reject(
          "dangling-symlink",
          "Path passes through a symlink whose target cannot be resolved.",
        );
      }
    } else {
      cursor = next;
    }

    if (!isStrictlyInside(rootReal, cursor)) {
      return reject(
        "escapes-root",
        "Path resolves outside the project directory (symlink or traversal).",
      );
    }
  }

  if (!isStrictlyInside(rootReal, cursor)) {
    return reject(
      "escapes-root",
      "Path resolves outside the project directory (symlink or traversal).",
    );
  }

  return { ok: true, relativePath: lexical, absolutePath: cursor };
}

/**
 * Confine an untrusted, project-relative path to one LaTeX project's working
 * tree. **This is the function every path-accepting route in brief 38 calls** —
 * file create, write, rename (both sides), delete, upload, and the `entrypoint`
 * field. There is no other sanctioned way to turn a client string into a path
 * under `LATEX_PROJECTS_DIR`.
 *
 * `projectId` must already be a server-generated id the route resolved from the
 * database, scoped to the requesting profile (brief 35: 404, not 403) —
 * `projectDirFor` asserts its shape, since a malformed id would move the
 * confinement root rather than escape it.
 */
export async function confineProjectPath(
  projectId: string,
  untrustedPath: string,
): Promise<ConfinedPath> {
  // `projectDirFor` THROWS on a non-UUID, by design — it is the trusted-input
  // half of this pair and refusing to build a path from junk is correct there.
  // But this function's whole contract is that a bad input comes back as a
  // result, never as an exception, and a route reaches here with an id taken
  // straight off the URL. Letting the throw escape would turn a hostile id into
  // an unhandled 500, where brief 35's rule requires a plain 404 — a malformed
  // id and a well-formed id belonging to someone else must be indistinguishable
  // to the caller, and two different status codes distinguish them.
  //
  // Caught rather than pre-validated with a second UUID regex, so `paths.ts`
  // stays the single definition of what an id may look like.
  let projectDir: string;
  try {
    projectDir = projectDirFor(projectId);
  } catch {
    return {
      ok: false,
      reason: "bad-project-id",
      message: "That project could not be found.",
    };
  }
  return confinePathUnder(projectDir, untrustedPath);
}
