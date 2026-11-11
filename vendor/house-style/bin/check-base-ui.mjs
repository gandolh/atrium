#!/usr/bin/env node
/**
 * check-base-ui: the Base UI and Tailwind conventions a script can see, numbered
 * as the base-ui skill numbers them.
 *
 *   node vendor/house-style/bin/check-base-ui.mjs [--warn-only] [--version <x.y.z>] [repo-root]
 *
 * It reads the web roots from the repo's conventions.json (see the house-style
 * README), then walks each one:
 *
 *   rule 1   @base-ui/react pinned exactly to --version (default below), in each
 *            package.json from a web root up to the repo root that declares it
 *   rule 2   an import from the @base-ui/react root instead of a part's subpath
 *   rule 3   a Base UI import outside a ui folder (components/ui, features/<name>/ui)
 *   rule 5   a stylesheet other than the one (styles/index.css), a CSS module, and
 *            the one stylesheet without @import "tailwindcss"
 *   rule 6   an arbitrary colour in a class name: bg-[#…], text-[rgb(…)], …
 *   rule 9   a <X.Trigger> whose first child is a component and that has no render
 *            prop, or whose render wraps its content in a span or div (a warning)
 *   rule 10  a <Select.Root> without items (a warning)
 *   rule 11  a native dialog: window.confirm, alert or prompt, bare or not
 *
 * Each finding prints as `file:line rule-N severity: message`. Warnings never fail
 * the run; an error exits 1, and --warn-only shows errors as warnings. A finding a
 * conventions.json exception covers is dropped. Exit 2 is a usage error or a
 * malformed conventions.json. Zero dependencies: plain Node (>= 22).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  closingBracket,
  codeFiles,
  createReport,
  describeRoots,
  globRegex,
  insideRoot,
  isTestFile,
  lineIndex,
  loadConventions,
  maskSource,
  parseArgs,
  run,
  walk,
} from "./conventions.mjs";

const NAME = "check-base-ui";
/** The Base UI version the estate is on; a later one is a house-style minor version. */
const DEFAULT_VERSION = "1.9.0";
const USAGE = "usage: node vendor/house-style/bin/check-base-ui.mjs [--warn-only] [--version <x.y.z>] [repo-root]";

const STYLESHEET_FILE = /\.(css|scss|sass|less)$/;
const PACKAGE = "@base-ui/react";

function main() {
  const args = parseArgs(process.argv.slice(2), { usage: USAGE, takesVersion: true, defaultVersion: DEFAULT_VERSION });
  const repo = args.repo;
  const conventions = loadConventions(repo);
  describeRoots(NAME, conventions, ["web"]);
  const report = createReport({
    name: NAME,
    check: "base-ui",
    repo,
    conventions,
    warnOnly: args.warnOnly,
  });
  const roots = conventions.roots.web;
  if (roots.length === 0) console.log(`${NAME}: no web root, so there is nothing to check.`);

  checkPins(repo, roots, args.version, report);
  for (const root of roots) checkStylesheets(repo, root, conventions.stylesheet, report);

  const ui = conventions.ui.map(globRegex);
  for (const file of codeFiles(repo, roots)) {
    const inUi = roots.some((root) => contains(root, file) && ui.some((regex) => regex.test(insideRoot(root, file))));
    checkSource(repo, file, { inUi, uiNames: conventions.ui, test: isTestFile(file) }, report);
  }
  return report.finish();
}

function contains(root, file) {
  return root === "." || file.startsWith(`${root}/`);
}

// ── rule 1: the pin ──────────────────────────────────────────────────────────

/** Each package.json from a web root up to the repo root that declares Base UI must pin it exactly. */
function checkPins(repo, roots, version, report) {
  const seen = new Set();
  for (const root of roots) {
    for (let dir = resolve(repo, root); ; dir = dirname(dir)) {
      const manifest = join(dir, "package.json");
      const file = relative(repo, manifest).split(sep).join("/");
      if (existsSync(manifest) && !seen.has(file)) {
        seen.add(file);
        checkManifest(repo, file, version, report);
      }
      if (dir === repo || dirname(dir) === dir) break;
    }
  }
}

function checkManifest(repo, file, version, report) {
  const text = readFileSync(join(repo, file), "utf8");
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return; // npm reports a broken package.json better than this can.
  }
  const lines = text.split("\n");
  for (const field of ["dependencies", "devDependencies"]) {
    const spec = json[field]?.[PACKAGE];
    if (spec === undefined || spec === version) continue;
    const index = lines.findIndex((line) => line.includes(`"${PACKAGE}"`));
    const exact = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(spec);
    report.add({
      file,
      line: index + 1 || 1,
      rule: 1,
      message: exact
        ? `${field} pins ${PACKAGE} ${spec}; the estate is on ${version}`
        : `${field} has ${PACKAGE} "${spec}"; pin it exactly: "${version}"`,
    });
  }
}

// ── rule 5: one stylesheet ───────────────────────────────────────────────────

function checkStylesheets(repo, root, stylesheet, report) {
  const one = root === "." ? stylesheet : `${root}/${stylesheet}`;
  const others = walk(repo, root).filter((file) => STYLESHEET_FILE.test(file) && file !== one);
  // With no stylesheet at the declared path, a lone plain stylesheet is probably the repo's one, in another place.
  const loneOther =
    !existsSync(join(repo, one)) && others.filter((file) => !/\.module\.[a-z]+$/.test(file)).length === 1;
  for (const file of others) {
    const isModule = /\.module\.[a-z]+$/.test(file);
    const where = root === "." ? file : file.slice(root.length + 1);
    report.add({
      file,
      rule: 5,
      message: isModule
        ? `a CSS module: style the parts with Tailwind utilities, and keep the one stylesheet ${one}`
        : `a stylesheet other than ${one}: move its rules into utilities, or into that one stylesheet${
            loneOther
              ? `; if this is the one stylesheet, declare it with "stylesheet": "${where}" in conventions.json`
              : ""
          }`,
    });
  }
  if (existsSync(join(repo, one))) {
    const css = readFileSync(join(repo, one), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    if (!/@import\s+(?:url\(\s*)?["']tailwindcss(?:\/[^"']*)?["']/.test(css)) {
      report.add({ file: one, rule: 5, message: `the one stylesheet has no @import "tailwindcss"` });
    }
  }
}

// ── the source rules ─────────────────────────────────────────────────────────

const IMPORT = /\b(from|import|require)\s*\(?\s*(["'])(@base-ui\/react(?:\/[^"'\n]*)?)\2/g;
const ARBITRARY_COLOUR =
  /(?<![\w-])(?:[\w-]+:)*!?-?[a-z][a-z0-9-]*-\[(?:#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z])|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\()[^\]\s]*\]?/g;
const TRIGGER = /<((?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*)\.Trigger(?=[\s/>])/g;

function checkSource(repo, file, { inUi, uiNames, test }, report) {
  const text = readFileSync(join(repo, file), "utf8");
  const { code, bare } = maskSource(text);
  const lineOf = lineIndex(text);

  // Rules 2 and 3: where Base UI is imported from.
  for (const match of code.matchAll(IMPORT)) {
    if (bare.slice(match.index, match.index + match[1].length) !== match[1]) continue; // inside a string
    const specifier = match[3];
    const line = lineOf(match.index + match[0].indexOf(specifier));
    if (specifier === PACKAGE) {
      report.add({
        file,
        line,
        rule: 2,
        message: `imports the ${PACKAGE} root: import the part's subpath, such as ${PACKAGE}/dialog`,
      });
    }
    if (!inUi && !test) {
      report.add({
        file,
        line,
        rule: 3,
        message: `imports ${specifier} outside a ui folder (${uiNames.join(", ")}): use or add the wrapper there`,
      });
    }
  }
  if (test) return;

  // Rule 6: arbitrary colours in class names.
  for (const match of code.matchAll(ARBITRARY_COLOUR)) {
    report.add({
      file,
      line: lineOf(match.index),
      rule: 6,
      message: `${match[0]} is an arbitrary colour: use a colour token from @theme (bg-surface, text-ink)`,
    });
  }

  // Rule 9: triggers that wrap a component.
  for (const match of bare.matchAll(TRIGGER)) {
    const tag = openingTag(bare, match.index + match[0].length);
    if (tag === null) continue;
    const line = lineOf(match.index);
    const name = `${match[1]}.Trigger`;
    if (tag.render !== null) {
      const wrapper = /<(span|div)\b(?:[^>]*[^/>])?>\s*\{/.exec(tag.render);
      if (wrapper) {
        report.add({
          file,
          line,
          rule: 9,
          severity: "warning",
          message: `<${name}>'s render wraps its content in a <${wrapper[1]}>, so a button passed in nests inside the trigger: render that element instead`,
        });
      }
      continue;
    }
    if (tag.selfClosing) continue;
    const child = firstChild(bare, tag.end);
    // A part of the trigger's own component (<Select.Value> in <Select.Trigger>) is its anatomy, not a wrapped control.
    if (child !== null && /^[A-Z]/.test(child) && !child.startsWith(`${match[1]}.`)) {
      report.add({
        file,
        line,
        rule: 9,
        severity: "warning",
        message: `<${name}> has <${child}> as its first child: pass it as render={<${child} … />}, or the trigger's button wraps it`,
      });
    }
  }

  // Rule 10: a Select without items.
  for (const root of selectRoots(code)) {
    for (const match of bare.matchAll(root)) {
      const tag = openingTag(bare, match.index + match[0].length);
      if (tag === null || tag.spread || /(?:^|\s)items\s*=/.test(tag.top)) continue;
      report.add({
        file,
        line: lineOf(match.index),
        rule: 10,
        severity: "warning",
        message: `<${match[1]}.Root> has no items: without them the trigger shows the raw value, not its label`,
      });
    }
  }

  // Rule 11: native dialogs.
  const local = localDialogNames(bare);
  for (const match of bare.matchAll(/(?<![\w$.])(?:(window|globalThis|self)\s*\.\s*)?(confirm|alert|prompt)\s*\(/g)) {
    const owner = match[1];
    const name = match[2];
    if (owner === undefined) {
      if (local.has(name) || /\bfunction\s*\*?\s*$/.test(bare.slice(Math.max(0, match.index - 20), match.index)))
        continue;
      const open = match.index + match[0].length - 1;
      const close = closingBracket(bare, open);
      if (close !== -1 && /^\s*(?:\{|:)/.test(bare.slice(close, close + 40))) continue; // a method or a signature
    }
    report.add({
      file,
      line: lineOf(match.index),
      rule: 11,
      message: `${owner ? `${owner}.` : ""}${name}() is a native dialog: use the confirm pattern (an AlertDialog) or an inline message`,
    });
  }
}

/**
 * The opening tag that starts just past an element name at `start`: its top-level
 * attribute text, its render prop's value, whether it spreads props, whether it
 * closes itself, and the offset after its `>`. Null when it never closes.
 */
function openingTag(bare, start) {
  let depth = 0;
  let top = "";
  for (let i = start; i < bare.length; i++) {
    const c = bare[i];
    if (c === "{") {
      if (depth === 0 && bare.startsWith("{...", i)) top += " {...";
      depth++;
    } else if (c === "}") depth--;
    else if (depth === 0 && c === "/" && bare[i + 1] === ">") return finish(i + 2, true);
    else if (depth === 0 && c === ">") return finish(i + 1, false);
    else if (depth === 0) top += c;
    if (depth < 0) return null;
  }
  return null;

  function finish(end, selfClosing) {
    const attributes = bare.slice(start, end);
    let render = null;
    const at = /(?:^|\s)render\s*=\s*/.exec(top);
    if (at) {
      const from = attributes.search(/(?:^|\s)render\s*=\s*\{/);
      if (from !== -1) {
        const open = attributes.indexOf("{", from);
        const close = closingBracket(attributes, open);
        render = attributes.slice(open, close === -1 ? undefined : close);
      } else render = "";
    }
    return { top, render, spread: top.includes("{..."), selfClosing, end };
  }
}

/** The name of the first element among a tag's children, skipping blank text and empty `{}` (comments). */
function firstChild(bare, from) {
  let i = from;
  for (;;) {
    while (i < bare.length && /\s/.test(bare[i])) i++;
    if (bare[i] === "{") {
      const close = closingBracket(bare, i);
      if (close !== -1 && bare.slice(i + 1, close - 1).trim() === "") {
        i = close;
        continue;
      }
      return null;
    }
    const match = /^<([A-Za-z_$][\w$.]*)/.exec(bare.slice(i, i + 200));
    return match ? match[1] : null;
  }
}

/** Patterns for Select's Root under every name the file gives Base UI's Select. */
function selectRoots(code) {
  const names = new Set(["Select"]);
  for (const match of code.matchAll(
    /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']@base-ui\/react(?:\/select)?["']/g,
  )) {
    for (const spec of match[1].split(",")) {
      const alias = /^\s*(?:type\s+)?Select\s+as\s+([\w$]+)\s*$/.exec(spec);
      if (alias) names.add(alias[1]);
    }
  }
  for (const match of code.matchAll(/import\s+\*\s+as\s+([\w$]+)\s+from\s*["']@base-ui\/react(?:\/select)?["']/g)) {
    names.add(`${match[1]}.Select`);
  }
  return [...names].map((name) => new RegExp(`<(${name.replace(/[.$]/g, "\\$&")})\\.Root(?=[\\s/>])`, "g"));
}

/** confirm, alert and prompt bound in the file (a useConfirm() result, an import, a parameter), which aren't the native ones. */
function localDialogNames(bare) {
  const names = new Set();
  for (const name of ["confirm", "alert", "prompt"]) {
    const patterns = [
      new RegExp(`\\b(?:const|let|var|function|class)\\s+${name}\\b`),
      new RegExp(`\\b(?:const|let|var)\\s*[{[][^=;]*\\b${name}\\b[^=;]*[}\\]]\\s*=`),
      new RegExp(`\\bimport\\s+(?:type\\s+)?(?:${name}\\b|\\{[^}]*\\b${name}\\b[^}]*\\})`),
      new RegExp(`\\(\\s*\\{[^)]*\\b${name}\\b[^)]*\\}`),
    ];
    if (patterns.some((pattern) => pattern.test(bare))) names.add(name);
  }
  return names;
}

run(NAME, main);
