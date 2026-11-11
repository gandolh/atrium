/**
 * The half the two convention checkers share: reading and validating the repo's
 * conventions.json, finding the roots, walking them, masking comments and strings
 * out of source text, and reporting findings as `file:line rule-N severity: message`.
 *
 * It is not run on its own; check-base-ui.mjs and check-structure.mjs import it.
 * conventions.schema.json describes the same file for editors, and a test keeps the
 * two in step. Zero dependencies: plain Node (>= 22).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/** Where a repo may keep its conventions.json, from its root, in the order they are looked for. */
export const CONVENTIONS_SPOTS = ["conventions.json", "scripts/conventions.json", "tools/conventions.json"];

/** The roots a repo gets when it has no conventions.json, or leaves a key out. A default root that doesn't exist is skipped. */
export const DEFAULT_ROOTS = { web: ["web/src"], server: ["server/src"], shared: ["shared/src"] };

/** The folders, under each web root, where Base UI may be imported (base-ui rule 3). */
export const DEFAULT_UI = ["**/components/ui", "**/features/*/ui"];

/** The one stylesheet, from each web root (base-ui rule 5). */
export const DEFAULT_STYLESHEET = "styles/index.css";

/** The checks an exception can name, with their highest rule number. house-style's are records for review only. */
export const CHECKS = { "base-ui": 17, structure: 11, "house-style": 25 };

export const TOP_LEVEL_KEYS = ["$schema", "web", "server", "shared", "ui", "stylesheet", "exceptions"];
export const EXCEPTION_KEYS = ["check", "rule", "path", "match", "reason"];

/** Folders never walked: dependencies, builds, generated and vendored code, and dot-folders. */
const SKIPPED_DIRS = new Set(["node_modules", "dist", "build", "coverage", "vendor", "out"]);

/** Source files the checkers read; `.d.ts` files are declarations, not code, and are skipped. */
export const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const DECLARATION_FILE = /\.d\.[cm]?ts$/;

/** A malformed conventions.json, a root that isn't there, or a bad flag: the run can't check anything. */
export class ConfigError extends Error {}

// ── the command line ─────────────────────────────────────────────────────────

/**
 * Reads `[--warn-only] [--version <v>] [repo-root]`; `takesVersion` says whether
 * `--version` is one of this checker's flags.
 */
export function parseArgs(argv, { usage, takesVersion = false, defaultVersion }) {
  const out = { warnOnly: false, version: defaultVersion, repo: process.cwd() };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--warn-only") out.warnOnly = true;
    else if (takesVersion && (arg === "--version" || arg.startsWith("--version="))) {
      const value = arg === "--version" ? argv[++i] : arg.slice("--version=".length);
      if (value === undefined || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(value)) {
        throw new ConfigError(`--version takes an exact version, such as 1.9.0\n${usage}`);
      }
      out.version = value;
    } else if (arg === "--help" || arg === "-h") {
      throw new ConfigError(usage);
    } else if (arg.startsWith("-")) {
      throw new ConfigError(`unknown flag ${arg}\n${usage}`);
    } else positional.push(arg);
  }
  if (positional.length > 1) throw new ConfigError(`one repo root at most\n${usage}`);
  if (positional.length === 1) out.repo = positional[0];
  out.repo = resolve(out.repo);
  if (!existsSync(out.repo) || !statSync(out.repo).isDirectory()) {
    throw new ConfigError(`${out.repo} is not a folder\n${usage}`);
  }
  return out;
}

// ── conventions.json ─────────────────────────────────────────────────────────

/**
 * The repo's conventions, with every root resolved to the folders it names.
 * Throws ConfigError when the file is malformed or names a root that isn't there.
 */
export function loadConventions(repo) {
  const found = CONVENTIONS_SPOTS.filter((spot) => existsSync(join(repo, spot)));
  if (found.length > 1) {
    throw new ConfigError(`more than one conventions.json: ${found.join(" and ")}. Keep one.`);
  }
  const file = found[0] ?? null;
  let data = {};
  let exceptionLines = [];
  if (file !== null) {
    const text = readFileSync(join(repo, file), "utf8");
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new ConfigError(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    exceptionLines = exceptionStartLines(text);
    const problems = validateConventions(data, exceptionLines);
    if (problems.length > 0) {
      throw new ConfigError(`${file} is malformed:\n${problems.map((p) => `  ${file}${p}`).join("\n")}`);
    }
  }

  const roots = {};
  const rootSource = {};
  for (const kind of ["web", "server", "shared"]) {
    if (data[kind] === undefined) {
      roots[kind] = DEFAULT_ROOTS[kind].filter((dir) => isDir(join(repo, dir)));
      rootSource[kind] = "default";
    } else {
      roots[kind] = [];
      for (const pattern of data[kind]) {
        const dirs = expandRoot(repo, clean(pattern));
        if (dirs.length === 0) throw new ConfigError(`${file}: ${kind} root "${pattern}" matches no folder`);
        for (const dir of dirs) if (!roots[kind].includes(dir)) roots[kind].push(dir);
      }
      rootSource[kind] = file;
    }
  }

  const exceptions = (data.exceptions ?? []).map((entry, index) => ({
    ...entry,
    path: clean(entry.path),
    index,
    line: exceptionLines[index] ?? 1,
    regex: globRegex(clean(entry.path)),
    used: 0,
  }));

  return {
    file,
    roots,
    rootSource,
    ui: (data.ui ?? DEFAULT_UI).map(clean),
    stylesheet: clean(data.stylesheet ?? DEFAULT_STYLESHEET),
    exceptions,
  };
}

/**
 * Every way the parsed file differs from the format, as `:line problem` strings
 * (the line when it is an exception's). The schema says the same for editors.
 */
export function validateConventions(data, exceptionLines = []) {
  const problems = [];
  const at = (line, text) => problems.push(`${line ? `:${line}` : ""}: ${text}`);
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    at(1, "the file holds one JSON object");
    return problems;
  }
  for (const key of Object.keys(data)) {
    if (!TOP_LEVEL_KEYS.includes(key)) at(null, `unknown key "${key}" (the keys are ${TOP_LEVEL_KEYS.join(", ")})`);
  }
  if (data.$schema !== undefined && typeof data.$schema !== "string") at(null, `"$schema" is a string`);
  for (const key of ["web", "server", "shared", "ui"]) {
    if (data[key] === undefined) continue;
    if (!Array.isArray(data[key])) {
      at(
        null,
        `"${key}" is a list of folders, such as ["${key === "ui" ? "**/components/ui" : (DEFAULT_ROOTS[key]?.[0] ?? "")}"]`,
      );
      continue;
    }
    data[key].forEach((value, i) => {
      const problem = pathProblem(value, { globs: key === "ui" ? "any" : "segment" });
      if (problem) at(null, `${key}[${i}] ${problem}`);
    });
  }
  if (data.stylesheet !== undefined) {
    const problem = pathProblem(data.stylesheet, { globs: "none" });
    if (problem) at(null, `"stylesheet" ${problem}`);
  }
  if (data.exceptions !== undefined) {
    if (!Array.isArray(data.exceptions)) {
      at(null, `"exceptions" is a list of { check, rule, path, reason } objects`);
      return problems;
    }
    data.exceptions.forEach((entry, i) => {
      const line = exceptionLines[i];
      const name = `exceptions[${i}]`;
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        at(line, `${name} is an object: { check, rule, path, reason }`);
        return;
      }
      for (const key of Object.keys(entry)) {
        if (!EXCEPTION_KEYS.includes(key))
          at(line, `${name} has an unknown key "${key}" (the keys are ${EXCEPTION_KEYS.join(", ")})`);
      }
      if (!Object.hasOwn(CHECKS, entry.check)) {
        at(
          line,
          `${name}.check is one of ${Object.keys(CHECKS)
            .map((c) => `"${c}"`)
            .join(", ")}`,
        );
      } else if (!Number.isInteger(entry.rule) || entry.rule < 1 || entry.rule > CHECKS[entry.check]) {
        at(line, `${name}.rule is a ${entry.check} rule number, 1 to ${CHECKS[entry.check]}`);
      }
      const problem = pathProblem(entry.path, { globs: "any" });
      if (problem) at(line, `${name}.path ${problem}`);
      if (entry.match !== undefined && (typeof entry.match !== "string" || entry.match.trim() === "")) {
        at(line, `${name}.match is text the finding's line or message contains`);
      }
      if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
        at(line, `${name} has no reason: every exception says why it exists`);
      }
    });
  }
  return problems;
}

/** What is wrong with a path from conventions.json, or null. */
function pathProblem(value, { globs }) {
  if (typeof value !== "string" || value.trim() === "") return "is a path from the repo root";
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("\\"))
    return `"${value}" is a relative path with forward slashes`;
  if (clean(value).split("/").includes("..")) return `"${value}" stays inside the repo (no "..")`;
  if (globs === "none" && /[*?[\]{}]/.test(value)) return `"${value}" is a plain path, without wildcards`;
  if (globs === "segment" && (/\*\*/.test(value) || /[?[\]{}]/.test(value)))
    return `"${value}" may use * within a folder name, nothing else`;
  if (globs === "any" && /[?[\]{}]/.test(value)) return `"${value}" may use * and **, nothing else`;
  return null;
}

/** "./web/src/" and "web/src" are the same root. */
function clean(path) {
  return path.replace(/^(\.\/)+/, "").replace(/\/+$/, "") || ".";
}

/** The 1-based line where each element of the top-level "exceptions" array starts, from the raw text. */
function exceptionStartLines(text) {
  const lines = [];
  let depth = 0;
  let line = 1;
  let lastKey = null;
  let inExceptions = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") line++;
    else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (depth === 1) lastKey = text.slice(i + 1, j);
      if (inExceptions && depth === 2) lines.push(line);
      i = j;
    } else if (c === "{" || c === "[") {
      if (inExceptions && depth === 2) lines.push(line);
      if (c === "[" && depth === 1 && lastKey === "exceptions") inExceptions = true;
      depth++;
    } else if (c === "}" || c === "]") {
      depth--;
      if (depth === 1) inExceptions = false;
    } else if (inExceptions && depth === 2 && !/[\s,]/.test(c)) {
      // A scalar where an exception object belongs still gets its line.
      lines.push(line);
      while (i + 1 < text.length && !/[\s,\]]/.test(text[i + 1])) i++;
    }
  }
  return lines;
}

// ── roots and walking ────────────────────────────────────────────────────────

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The folders a root names; `*` matches within one folder name. */
function expandRoot(repo, pattern) {
  const segments = pattern === "." ? [] : pattern.split("/");
  let current = [""];
  for (const segment of segments) {
    const next = [];
    for (const prefix of current) {
      if (!segment.includes("*")) {
        const dir = prefix ? `${prefix}/${segment}` : segment;
        if (isDir(join(repo, dir))) next.push(dir);
        continue;
      }
      const regex = new RegExp(`^${segment.split("*").map(escapeRegex).join("[^/]*")}$`);
      let names = [];
      try {
        names = readdirSync(join(repo, prefix), { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIPPED_DIRS.has(entry.name))
          .map((entry) => entry.name)
          .sort();
      } catch {
        // A folder that can't be read matches nothing.
      }
      for (const name of names) if (regex.test(name)) next.push(prefix ? `${prefix}/${name}` : name);
    }
    current = next;
  }
  return current.map((dir) => dir || ".");
}

/** Every file under a root, as repo-relative paths with forward slashes, sorted. */
export function walk(repo, root) {
  const out = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) visit(full);
      } else if (entry.isFile()) {
        out.push(relative(repo, full).split(sep).join("/"));
      }
    }
  };
  visit(join(repo, root));
  return out.sort();
}

/** Code files under the roots, once each, without declaration files. */
export function codeFiles(repo, roots) {
  const files = new Set();
  for (const root of roots) {
    for (const file of walk(repo, root)) if (CODE_FILE.test(file) && !DECLARATION_FILE.test(file)) files.add(file);
  }
  return [...files].sort();
}

/** A test, or a helper only tests load: `*.test.*`, `*.spec.*`, or a file in a test folder. */
export function isTestFile(file) {
  const parts = file.split("/");
  const name = parts.at(-1) ?? "";
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) return true;
  return parts.slice(0, -1).some((part) => ["test", "tests", "__tests__", "testing", "e2e"].includes(part));
}

/** The path inside the root, for root-relative rules. */
export function insideRoot(root, file) {
  return root === "." ? file : file.slice(root.length + 1);
}

/** A glob from conventions.json as a regex: `*` within a folder name, `**` any depth, and a plain path also matches what is under it. */
export function globRegex(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith("**/", i)) {
      source += "(?:.*/)?";
      i += 2;
    } else if (glob.startsWith("**", i)) {
      source += ".*";
      i += 1;
    } else if (glob[i] === "*") source += "[^/]*";
    else source += escapeRegex(glob[i]);
  }
  return new RegExp(glob === "." ? "^.*$" : `^${source}(?:/.*)?$`);
}

function escapeRegex(text) {
  return text.replace(/[.+^${}()|[\]\\*?]/g, "\\$&");
}

// ── source text ──────────────────────────────────────────────────────────────

const REGEX_AFTER = new Set([
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  ";",
  "+",
  "-",
  "*",
  "%",
  "~",
  "^",
  ">",
  "",
]);
const REGEX_AFTER_WORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

/**
 * The source with comments blanked (`code`), and with string, template and regex
 * contents blanked too (`bare`). Both keep every offset and newline, so a match in
 * either is a match at the same line of the file.
 */
export function maskSource(text) {
  // UTF-16 units, so offsets agree with the string's own indexes.
  const code = text.split("");
  const bare = text.split("");
  const n = text.length;
  const blank = (arrays, from, to) => {
    for (const array of arrays) for (let k = from; k < to; k++) if (text[k] !== "\n") array[k] = " ";
  };
  const templates = []; // the brace depth at which each open `${` began
  let depth = 0;
  let prev = ""; // the last significant character outside comments
  let word = ""; // the last identifier or keyword
  let i = 0;

  /** Scans template text from `start` up to its end or a `${`, and returns where code resumes. */
  const template = (start) => {
    let j = start;
    while (j < n) {
      if (text[j] === "\\") j += 2;
      else if (text[j] === "`") {
        blank([bare], start, j);
        return j + 1;
      } else if (text[j] === "$" && text[j + 1] === "{") {
        blank([bare], start, j);
        templates.push(depth);
        depth++;
        return j + 2;
      } else j++;
    }
    blank([bare], start, n);
    return n;
  };

  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === "/" && d === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank([code, bare], i, stop);
      i = stop;
    } else if (c === "/" && d === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      blank([code, bare], i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      // A quoted string ends at its quote, or (JSX text such as "don't") at the line's end.
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      blank([bare], i + 1, Math.min(j, n));
      i = j < n && text[j] === c ? j + 1 : j;
      prev = c;
      word = "";
    } else if (c === "`") {
      i = template(i + 1);
      prev = "`";
      word = "";
    } else if (c === "/" && text[i - 1] !== "<" && (REGEX_AFTER.has(prev) || REGEX_AFTER_WORDS.has(word))) {
      // A regex literal, if it closes on this line; otherwise a plain slash.
      let j = i + 1;
      let inClass = false;
      while (j < n && text[j] !== "\n") {
        if (text[j] === "\\") j++;
        else if (text[j] === "[") inClass = true;
        else if (text[j] === "]") inClass = false;
        else if (text[j] === "/" && !inClass) break;
        j++;
      }
      if (j < n && text[j] === "/") {
        blank([bare], i + 1, j);
        i = j + 1;
        prev = "/";
      } else {
        i++;
        prev = "/";
      }
      word = "";
    } else {
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (templates.length > 0 && templates.at(-1) === depth) {
          templates.pop();
          i = template(i + 1);
          prev = "`";
          word = "";
          continue;
        }
      }
      if (/[\w$]/.test(c)) {
        let j = i;
        while (j < n && /[\w$]/.test(text[j])) j++;
        word = text.slice(i, j);
        prev = "a";
        i = j;
        continue;
      }
      if (!/\s/.test(c)) {
        prev = c;
        word = "";
      }
      i++;
    }
  }
  return { code: code.join(""), bare: bare.join("") };
}

/** Maps an offset in a file's text to its 1-based line. */
export function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** The offset just past the bracket that closes the one at `open`, in masked text, or -1. */
export function closingBracket(text, open) {
  const pairs = { "(": ")", "{": "}", "[": "]" };
  const stack = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ")" || c === "}" || c === "]") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

/** The top-level arguments between the brackets at `open` and `close - 1`, as [start, end) ranges. */
export function splitArguments(text, open, close) {
  const ranges = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close - 1; i++) {
    const c = text[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      ranges.push([start, i]);
      start = i + 1;
    }
  }
  if (text.slice(start, close - 1).trim() !== "") ranges.push([start, close - 1]);
  return ranges;
}

// ── the report ───────────────────────────────────────────────────────────────

/**
 * Collects findings, drops the ones an exception covers, and prints the rest as
 * `file:line rule-N severity: message`, then a summary. An exception whose path
 * names nothing in the repo is a warning of its own.
 */
export function createReport({ name, check, repo, conventions, warnOnly }) {
  const findings = [];
  const lines = new Map();
  const lineText = (file, line) => {
    if (!lines.has(file)) {
      try {
        lines.set(file, readFileSync(join(repo, file), "utf8").split("\n"));
      } catch {
        lines.set(file, []);
      }
    }
    return lines.get(file)[line - 1] ?? "";
  };
  const exceptions = conventions.exceptions.filter((entry) => entry.check === check);
  let exempted = 0;

  return {
    add({ file, line = 1, rule, severity = "error", message }) {
      const text = lineText(file, line);
      const exception = exceptions.find(
        (entry) =>
          entry.rule === rule &&
          entry.regex.test(file) &&
          (entry.match === undefined || text.includes(entry.match) || message.includes(entry.match)),
      );
      if (exception) {
        exception.used++;
        exempted++;
        return;
      }
      const key = `${file}:${line}:${rule}:${message}`;
      if (findings.some((f) => f.key === key)) return;
      findings.push({ key, file, line, rule, severity, message });
    },

    /** Prints everything and returns the exit code: 1 when an error is left, else 0. */
    finish() {
      // An exception may record a case this checker can't see (an inline style, a test
      // helper's name), so one that covered no finding is fine; one whose path names
      // nothing in the repo is stale or a typo.
      let files = null;
      for (const entry of exceptions) {
        if (entry.used > 0) continue;
        if (!entry.path.includes("*")) {
          if (existsSync(join(repo, entry.path))) continue;
        } else {
          files ??= walk(repo, ".");
          if (files.some((file) => entry.regex.test(file))) continue;
        }
        findings.push({
          key: `exception-${entry.index}`,
          file: conventions.file,
          line: entry.line,
          rule: entry.rule,
          severity: "warning",
          message: `exceptions[${entry.index}].path "${entry.path}" names nothing in the repo: fix the path, or delete the exception`,
        });
      }
      let demoted = 0;
      for (const finding of findings) {
        if (warnOnly && finding.severity === "error") {
          finding.severity = "warning";
          demoted++;
        }
      }
      findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.rule - b.rule));
      for (const f of findings) console.log(`${f.file}:${f.line} rule-${f.rule} ${f.severity}: ${f.message}`);

      const errors = findings.filter((f) => f.severity === "error").length;
      const warnings = findings.length - errors;
      const perRule = new Map();
      for (const f of findings) perRule.set(f.rule, (perRule.get(f.rule) ?? 0) + 1);
      const tally = [...perRule.entries()].sort(([a], [b]) => a - b).map(([rule, count]) => `rule-${rule} ${count}`);
      const parts = [
        `${errors} ${errors === 1 ? "error" : "errors"}`,
        `${warnings} ${warnings === 1 ? "warning" : "warnings"}`,
      ];
      let summary = `${name}${warnOnly ? " --warn-only" : ""}: ${parts.join(", ")}`;
      if (tally.length > 0) summary += ` (${tally.join(", ")})`;
      if (demoted > 0) summary += `; ${demoted} of the warnings are errors, shown as warnings by --warn-only`;
      if (exempted > 0) summary += `; ${exempted} excepted by ${conventions.file}`;
      console.log(summary);
      return errors > 0 ? 1 : 0;
    },
  };
}

/** Says where the roots came from, before the findings. */
export function describeRoots(name, conventions, kinds) {
  const where = conventions.file ?? null;
  if (where === null) {
    console.log(
      `${name}: found no conventions.json (looked for ${CONVENTIONS_SPOTS.join(", ")}); using the default roots that exist.`,
    );
  }
  const parts = kinds.map((kind) => {
    const roots = conventions.roots[kind];
    const source = conventions.rootSource[kind] === "default" ? " (default)" : "";
    return `${kind} ${roots.length > 0 ? roots.join(", ") : "none"}${source}`;
  });
  console.log(`${name}: ${parts.join("; ")}${where ? `, from ${where}` : ""}`);
}

/** Runs a checker's main and turns its outcome into the exit code: 2 for a usage or conventions.json error. */
export function run(name, main) {
  try {
    process.exitCode = main();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`${name}: ${err.message}`);
      process.exitCode = 2;
    } else {
      console.error(`${name}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      process.exitCode = 2;
    }
  }
}
