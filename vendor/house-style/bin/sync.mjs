#!/usr/bin/env node
/**
 * house-style:sync: copies house-style into this repo's vendor/house-style/.
 *
 *   npm run house-style:sync -- <ref>           copy house-style at <ref>
 *   npm run house-style:sync -- <ref> --check   compare only, write nothing
 *   npm run house-style:sync -- --check         compare against the commit in the header
 *
 * It copies into the folder of the nearest package.json at or above the working
 * directory, without going above the git toplevel (so an app in a subfolder of a
 * multi-project repo takes the copy in its own folder), and the first sync can run
 * the library checkout's copy of this script before vendor/house-style/ exists. <ref> is a tag
 * (`house-style-v1.0.0`) or a commit of the checkout named CHECKOUT, which is
 * looked up in the projects folder (PROJECTS_DIR, else ~/projects), directly or
 * one group folder down. Only that checkout's git objects are read, never its
 * working tree, so the copy is exactly what the commit holds.
 *
 * The files that ship are the `files` list of house-style's package.json at
 * <ref>, plus that package.json. The copy's README.md is a generated header.
 * Exit codes: 0 done or matching, 1 a difference or an error, 2 a usage error.
 *
 * Zero dependencies: plain Node (>= 22.6) and git.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The checkout that holds house-style, found by name in the projects folder. */
const CHECKOUT = "my-personal-skills";
/** The folder of that checkout that is house-style. */
const SUBTREE = "house-style";
/** Where the copy lives in the repo being synced, from its root. */
const VENDOR_DIR = "vendor/house-style";
/** The generated header, which takes the place of house-style's own README. */
const HEADER = "README.md";
/** Set in the hand-over run, so a sync never hands over twice. */
const HANDOVER_ENV = "HOUSE_STYLE_SYNC_HANDOVER";

/** What each shipped file is, for the header's table. */
const DESCRIPTIONS = {
  "package.json": 'house-style\'s version, its pinned dependencies, and `"type": "module"` for the configs',
  "eslint.config.js": "`houseStyle(options)`, the ESLint flat config as a function of the repo's folders",
  "prettier.config.js": "The Prettier config: width 120, trailing commas, Prettier's defaults otherwise",
  "tsconfig.base.json": "The compiler flags every package's tsconfig extends",
  "knip.json": "The knip preset: unused files and dependencies are errors, unused exports warnings",
  ".dependency-cruiser.cjs": "The dependency-cruiser preset: cycles, unresolvable imports, feature boundaries",
  "bin/sync.mjs": "This sync (`npm run house-style:sync`)",
  "bin/check-base-ui.mjs": "The Base UI and Tailwind checker, run by `check:conventions`",
  "bin/check-structure.mjs": "The code-structure checker, run by `check:conventions`",
  "bin/conventions.mjs": "What the two checkers share: reading `conventions.json`, walking the roots, the report",
  "conventions.schema.json": "The JSON Schema of `conventions.json`, for editors",
  "CHANGELOG.md": "The upgrade notes, one section per version",
  LICENSE: "MIT",
};

const USAGE = "usage: npm run house-style:sync -- <ref> [--check]   (or: -- --check)";

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const positional = args.filter((arg) => arg !== "--check");
  if (positional.some((arg) => arg.startsWith("-")) || positional.length > 1 || (!check && positional.length === 0)) {
    console.error(USAGE);
    return 2;
  }

  const repo = findRepoRoot(process.cwd());
  const vendor = join(repo, VENDOR_DIR);

  let ref = positional[0];
  if (ref === undefined) {
    ref = headerCommit(vendor);
    if (ref === null) {
      console.log(
        `house-style:sync --check: ${VENDOR_DIR}/${HEADER} is missing or names no commit; sync a <ref> first.`,
      );
      return 1;
    }
  }

  const checkout = findCheckout();
  if (repo === resolve(checkout) || repo.startsWith(resolve(checkout) + sep))
    throw new Error(`this is the ${CHECKOUT} checkout itself: run the sync from the repo that takes the copy`);
  const commit = resolveCommit(checkout, ref);

  // The version being installed writes its own copy and header, so a newer header
  // format never shows up as a difference against an older sync script.
  const ownScript = readFileSync(fileURLToPath(import.meta.url));
  const targetScript = readBlob(checkout, `${commit}:${SUBTREE}/bin/sync.mjs`);
  if (!ownScript.equals(targetScript) && process.env[HANDOVER_ENV] !== "1") {
    return handOver(targetScript, args);
  }

  const files = readShipped(checkout, commit);
  const pkg = JSON.parse(files.get("package.json").bytes.toString("utf8"));
  const header = Buffer.from(formatHeader({ version: pkg.version, commit, paths: [...files.keys()] }));
  const differences = compare(vendor, files, header, ref);

  if (check) {
    if (differences.length === 0) {
      console.log(`house-style:sync --check: ${VENDOR_DIR} is house-style ${pkg.version} at ${commit}, byte for byte.`);
    } else {
      console.log(`house-style:sync --check: ${VENDOR_DIR} differs from house-style ${pkg.version} at ${commit}:`);
      for (const line of differences) console.log(`  ${line}`);
    }
    reportPins(repo, pkg);
    return differences.length === 0 ? 0 : 1;
  }

  write(vendor, files, header);
  console.log(
    differences.length === 0
      ? `house-style:sync: ${VENDOR_DIR} was already house-style ${pkg.version} at ${commit}.`
      : `house-style:sync: wrote house-style ${pkg.version} at ${commit} (${files.size} files, ${differences.length} paths changed).`,
  );
  reportPins(repo, pkg);
  return 0;
}

// ── the repo and the checkout ────────────────────────────────────────────────

/**
 * The project taking the copy: the folder of the nearest package.json at or above
 * the working directory, without going above the git toplevel. A repo with its
 * package.json at the root gets the copy at its root; an app in a subfolder of a
 * multi-project repo gets it in that folder. With no package.json on the way (the
 * first sync of a bare repo) it is the git toplevel, and outside git it is the
 * nearest package.json at any height.
 */
function findRepoRoot(cwd) {
  const run = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  const top = run.status === 0 && run.stdout.trim() !== "" ? resolve(run.stdout.trim()) : null;
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) return dir;
    if (dir === top || dirname(dir) === dir) break;
  }
  if (top !== null) return top;
  throw new Error("no git work tree and no package.json up from the working directory: run the sync inside the repo");
}

/** The folder holding the project checkouts: PROJECTS_DIR, else ~/projects. */
function projectsDir() {
  const raw = process.env.PROJECTS_DIR?.trim() || "~/projects";
  if (raw === "~") return homedir();
  return resolve(raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw);
}

/** The one CHECKOUT at <projects>/<name> or <projects>/<group>/<name>. */
function findCheckout() {
  const root = projectsDir();
  const spots = [join(root, CHECKOUT)];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== CHECKOUT) spots.push(join(root, entry.name, CHECKOUT));
    }
  } catch {
    // No projects folder: reported below as no checkout.
  }
  const found = spots.filter((dir) => existsSync(join(dir, ".git")));
  if (found.length === 0) {
    throw new Error(
      `no ${CHECKOUT} checkout in ${root}, directly or one group folder down: clone it there, or set PROJECTS_DIR`,
    );
  }
  if (found.length > 1) {
    throw new Error(
      `more than one ${CHECKOUT} checkout: ${found.join(", ")}. Keep one, or point PROJECTS_DIR at the folder holding the one to use`,
    );
  }
  return found[0];
}

// ── git, objects only ────────────────────────────────────────────────────────

function git(checkout, args) {
  const run = spawnSync("git", ["-C", checkout, ...args], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  if (run.error) throw run.error;
  if (run.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${checkout}: ${run.stderr.toString("utf8").trim()}`);
  }
  return run.stdout;
}

function resolveCommit(checkout, ref) {
  try {
    return git(checkout, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])
      .toString("utf8")
      .trim();
  } catch {
    throw new Error(`"${ref}" is not a tag or commit of the ${CHECKOUT} checkout`);
  }
}

function readBlob(checkout, spec) {
  try {
    return git(checkout, ["cat-file", "blob", spec]);
  } catch {
    throw new Error(`${spec.slice(spec.indexOf(":") + 1)} is missing at ${spec.slice(0, spec.indexOf(":"))}`);
  }
}

/** The id git gives these bytes as a blob (what `git hash-object` prints). */
function blobId(bytes, idLength) {
  return createHash(idLength === 64 ? "sha256" : "sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

/**
 * The shipped files at the commit, keyed by their path inside house-style: the
 * `files` list of house-style's package.json, plus that package.json.
 */
function readShipped(checkout, commit) {
  const pkgBytes = readBlob(checkout, `${commit}:${SUBTREE}/package.json`);
  const pkg = JSON.parse(pkgBytes.toString("utf8"));
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    throw new Error(`${SUBTREE}/package.json at ${commit} has no "files" list`);
  }
  if (typeof pkg.version !== "string") throw new Error(`${SUBTREE}/package.json at ${commit} has no version`);

  const files = new Map();
  for (const entry of pkg.files) {
    const path = String(entry).replace(/\/+$/, "");
    if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(path) || path.split("/").includes("..")) {
      throw new Error(`"files" entry "${entry}" is not a plain path inside ${SUBTREE}/`);
    }
    if (path === HEADER) throw new Error(`"files" lists ${HEADER}, which the sync writes as the header`);
    const listing = git(checkout, ["ls-tree", "-r", "-z", "--full-tree", commit, "--", `${SUBTREE}/${path}`])
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    if (listing.length === 0) throw new Error(`"files" lists ${path}, which ${SUBTREE}/ at ${commit} does not have`);
    for (const line of listing) {
      const tab = line.indexOf("\t");
      const [mode, type, oid] = line.slice(0, tab).split(" ");
      const full = line.slice(tab + 1);
      const inside = full.slice(SUBTREE.length + 1);
      if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
        throw new Error(`${full} at ${commit} is a ${type} (mode ${mode}); only plain files ship`);
      }
      const bytes = git(checkout, ["cat-file", "blob", oid]);
      if (blobId(bytes, oid.length) !== oid) throw new Error(`${full}: blob ${oid} read back with other bytes`);
      files.set(inside, { mode, oid, bytes });
    }
  }
  const pkgOid = git(checkout, ["rev-parse", `${commit}:${SUBTREE}/package.json`])
    .toString("utf8")
    .trim();
  files.set("package.json", { mode: "100644", oid: pkgOid, bytes: pkgBytes });
  return new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// ── the header ───────────────────────────────────────────────────────────────

function formatHeader({ version, commit, paths }) {
  return [
    `# house-style ${version} (vendored)`,
    "",
    "This directory is a copy of house-style, the shared ESLint, Prettier, TypeScript,",
    "knip and dependency-cruiser configs of the house repos. It is generated: do not",
    "edit these files. To upgrade, run `npm run house-style:sync -- <tag>`, then follow",
    "the upgrade notes. `npm run house-style:sync -- --check` says whether the copy",
    "still matches its commit.",
    "",
    `- **Version:** ${version}`,
    `- **Source:** the \`${CHECKOUT}\` repository, folder \`${SUBTREE}/\``,
    `- **Commit:** \`${commit}\``,
    `- **Upgrade notes:** \`${SUBTREE}/CHANGELOG.md\` in the same repository (copied here as \`CHANGELOG.md\`)`,
    "",
    "| File | What it is |",
    "|---|---|",
    ...paths.map((path) => `| \`${path}\` | ${DESCRIPTIONS[path] ?? "Shipped with house-style"} |`),
    "",
    "The repo's own configs import or extend these files by relative path.",
    "",
  ].join("\n");
}

/** The commit the header names, or null when there is no header or no commit in it. */
function headerCommit(vendor) {
  const path = join(vendor, HEADER);
  if (!existsSync(path)) return null;
  const match = /^- \*\*Commit:\*\* `([0-9a-f]{40}(?:[0-9a-f]{24})?)`$/m.exec(readFileSync(path, "utf8"));
  return match ? match[1] : null;
}

// ── the copy ─────────────────────────────────────────────────────────────────

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** Every way the copy on disk differs from the commit. */
function compare(vendor, files, header, ref) {
  const differences = [];
  for (const path of listFiles(vendor)) {
    if (path !== HEADER && !files.has(path)) differences.push(`${path}: not in ${ref}`);
  }
  for (const [path, file] of files) {
    const onDisk = join(vendor, path);
    if (!existsSync(onDisk)) differences.push(`${path}: missing`);
    else if (!readFileSync(onDisk).equals(file.bytes)) differences.push(`${path}: differs`);
  }
  const headerPath = join(vendor, HEADER);
  if (!existsSync(headerPath)) differences.push(`${HEADER}: missing (the header)`);
  else if (!readFileSync(headerPath).equals(header)) differences.push(`${HEADER}: differs (the header)`);
  return differences;
}

/** A clean replace, so files the commit dropped disappear, then a read-back by hash. */
function write(vendor, files, header) {
  rmSync(vendor, { recursive: true, force: true });
  for (const [path, file] of files) {
    const target = join(vendor, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.bytes);
    chmodSync(target, file.mode === "100755" ? 0o755 : 0o644);
  }
  writeFileSync(join(vendor, HEADER), header);

  const written = listFiles(vendor).filter((path) => path !== HEADER);
  if (written.length !== files.size) throw new Error("the written copy has a different file count");
  for (const [path, file] of files) {
    if (blobId(readFileSync(join(vendor, path)), file.oid.length) !== file.oid) {
      throw new Error(`${path} does not hash to ${file.oid} after writing`);
    }
  }
}

/** Runs the sync script of the target commit in this process's place. */
function handOver(script, args) {
  const dir = mkdtempSync(join(tmpdir(), "house-style-sync-"));
  try {
    const file = join(dir, "sync.mjs");
    writeFileSync(file, script);
    const run = spawnSync(process.execPath, [file, ...args], {
      stdio: "inherit",
      env: { ...process.env, [HANDOVER_ENV]: "1" },
    });
    if (run.error) throw run.error;
    return run.status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── the pins ─────────────────────────────────────────────────────────────────

const SKIPPED_DIRS = new Set(["node_modules", "vendor", "dist", "coverage"]);

/**
 * The repo's package.json files: the root, each npm workspace, and (in a repo
 * without workspaces) each first-level folder that holds its own npm project.
 */
function manifests(repo) {
  const rootPath = join(repo, "package.json");
  const root = existsSync(rootPath) ? JSON.parse(readFileSync(rootPath, "utf8")) : {};
  const patterns = Array.isArray(root.workspaces) ? root.workspaces : (root.workspaces?.packages ?? []);
  const dirs = new Set([""]);
  if (patterns.length > 0) {
    for (const pattern of patterns) {
      if (typeof pattern !== "string" || pattern.startsWith("!")) continue;
      for (const dir of expand(repo, pattern.replace(/^\.\//, "").replace(/\/+$/, "").split("/"))) dirs.add(dir);
    }
  } else {
    for (const entry of readdirSync(repo, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIPPED_DIRS.has(entry.name)) dirs.add(entry.name);
    }
  }
  const out = [];
  for (const dir of [...dirs].sort()) {
    const path = join(repo, dir, "package.json");
    if (existsSync(path)) out.push({ where: dir === "" ? "package.json" : `${dir}/package.json`, path });
  }
  return out;
}

/** The folders a workspace pattern names; `*` matches within one segment, `**` any depth. */
function expand(repo, segments, prefix = "") {
  if (segments.length === 0) return [prefix];
  const [head, ...rest] = segments;
  const base = join(repo, prefix);
  if (!/[*?]/.test(head)) return expand(repo, rest, prefix ? `${prefix}/${head}` : head);
  let names;
  try {
    names = readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const join2 = (name) => (prefix ? `${prefix}/${name}` : name);
  if (head === "**")
    return [...expand(repo, rest, prefix), ...names.flatMap((name) => expand(repo, segments, join2(name)))];
  const pattern = new RegExp(
    `^${head
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
  );
  return names.filter((name) => pattern.test(name)).flatMap((name) => expand(repo, rest, join2(name)));
}

/**
 * Reports, without changing anything or the exit code, where the repo's pins
 * differ from the exact versions house-style lists (its peerDependencies).
 */
function reportPins(repo, pkg) {
  const wanted = Object.entries(pkg.peerDependencies ?? {});
  if (wanted.length === 0) return;
  const found = new Map(wanted.map(([name]) => [name, []]));
  for (const manifest of manifests(repo)) {
    const json = JSON.parse(readFileSync(manifest.path, "utf8"));
    for (const [name] of wanted) {
      const spec = json.devDependencies?.[name] ?? json.dependencies?.[name];
      if (spec !== undefined) found.get(name).push({ where: manifest.where, spec });
    }
  }
  const lines = [];
  const missing = [];
  for (const [name, version] of wanted) {
    const pins = found.get(name);
    if (pins.length === 0) missing.push(name);
    for (const pin of pins) {
      if (pin.spec !== version)
        lines.push(`pin ${name}: ${pin.where} has ${pin.spec}, house-style ${pkg.version} lists ${version}`);
    }
  }
  if (missing.length > 0) lines.push(`not pinned in this repo: ${missing.join(", ")}`);
  if (lines.length === 0) {
    console.log(`house-style:sync: every pin matches house-style ${pkg.version}.`);
    return;
  }
  console.log(`house-style:sync: pins to look at (reported only; nothing was changed):`);
  for (const line of lines) console.log(`  ${line}`);
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(`house-style:sync: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
