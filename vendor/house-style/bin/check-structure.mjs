#!/usr/bin/env node
/**
 * check-structure: the code-structure rules a script can see, numbered as the
 * code-structure skill numbers them.
 *
 *   node vendor/house-style/bin/check-structure.mjs [--warn-only] [repo-root]
 *
 * It reads the server, web and shared roots from the repo's conventions.json (see
 * the house-style README; without one it says so and checks the default roots):
 *
 *   rule 1   listen( in a server root anywhere but server.ts (tests excepted: a
 *            fake upstream or a real-socket test isn't the app's entry)
 *   rule 2   a server root whose app.ts exports no buildApp, or that has no app.ts
 *   rule 3   process.env outside config.ts, and any NODE_ENV, in server and shared
 *            roots (tests excepted)
 *   rule 5   a feature reached past its index: house-style's .dependency-cruiser.cjs
 *            (feature-through-index), not this script
 *   rule 6   request input parsed by hand (schema.parse(request.body), a parse
 *            helper given request.query), and a route registered with no schema;
 *            a heuristic, tests excepted
 *   rule 7   Fastify imported under lib/: the dependency-cruiser preset
 *            (lib-without-fastify), not this script
 *   rule 11  a file over 400 lines, in any root, test files aside (a warning)
 *
 * Each finding prints as `file:line rule-N severity: message`. Warnings never fail
 * the run; an error exits 1, and --warn-only shows errors as warnings. A finding a
 * conventions.json exception covers is dropped. Exit 2 is a usage error or a
 * malformed conventions.json. Zero dependencies: plain Node (>= 22).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  closingBracket,
  codeFiles,
  createReport,
  describeRoots,
  isTestFile,
  lineIndex,
  loadConventions,
  maskSource,
  parseArgs,
  run,
  splitArguments,
} from "./conventions.mjs";

const NAME = "check-structure";
const USAGE = "usage: node vendor/house-style/bin/check-structure.mjs [--warn-only] [repo-root]";
const RULES = [1, 2, 3, 6, 11];
/** Past this many lines a file is split by sub-domain before it grows (rule 11). */
const MAX_LINES = 400;

const ENTRY = /(?:^|\/)server\.[cm]?[jt]s$/;
const APP = /(?:^|\/)app\.[cm]?[jt]s$/;
const CONFIG = /(?:^|\/)config\.[cm]?[jt]s$/;

function main() {
  const args = parseArgs(process.argv.slice(2), { usage: USAGE });
  const repo = args.repo;
  const conventions = loadConventions(repo);
  describeRoots(NAME, conventions, ["server", "web", "shared"]);
  const report = createReport({
    name: NAME,
    check: "structure",
    repo,
    conventions,
    warnOnly: args.warnOnly,
  });
  const { server, web, shared } = conventions.roots;
  if (server.length + web.length + shared.length === 0) console.log(`${NAME}: no root, so there is nothing to check.`);
  console.log(
    `${NAME}: checks rules ${RULES.join(", ")}; rules 5 and 7 (a feature through its index, no Fastify in lib/) are dependency-cruiser's, in vendor/house-style/.dependency-cruiser.cjs`,
  );

  const serverFiles = new Set(codeFiles(repo, server));
  const sharedFiles = new Set(codeFiles(repo, shared));

  for (const root of server) {
    const apps = codeFiles(repo, [root]).filter((file) => APP.test(file) && !isTestFile(file));
    if (apps.length === 0) {
      report.add({
        file: root === "." ? "app.ts" : `${root}/app.ts`,
        rule: 2,
        message:
          "missing: a server root has an app.ts that exports buildApp(config), registers plugins then features, and never listens",
      });
    }
  }

  for (const file of codeFiles(repo, [...server, ...web, ...shared])) {
    const text = readFileSync(join(repo, file), "utf8");
    const test = isTestFile(file);
    const lines = text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
    if (lines > MAX_LINES && !test) {
      report.add({
        file,
        rule: 11,
        severity: "warning",
        message: `${lines} lines, over ${MAX_LINES}: split it by sub-domain before adding to it`,
      });
    }
    const inServer = serverFiles.has(file);
    const inShared = sharedFiles.has(file);
    if (!inServer && !inShared) continue;

    const masked = maskSource(text);
    const lineOf = lineIndex(text);
    if (inServer && !test) {
      checkListen(file, masked, lineOf, report);
      if (APP.test(file)) checkBuildApp(file, masked, report);
      checkSchemas(file, masked, lineOf, report);
    }
    if (!test) checkEnvironment(file, masked, lineOf, report);
  }
  return report.finish();
}

// ── rule 1: only server.ts listens ───────────────────────────────────────────

function checkListen(file, { bare }, lineOf, report) {
  if (ENTRY.test(file)) return;
  for (const match of bare.matchAll(/(?<![\w$])listen\s*\(/g)) {
    const before = bare.slice(Math.max(0, match.index - 20), match.index);
    if (/\bfunction\s*$|\basync\s*$/.test(before)) continue; // a definition, not a call
    const close = closingBracket(bare, match.index + match[0].length - 1);
    if (close !== -1 && /^\s*(?:\{|:)/.test(bare.slice(close, close + 40))) continue; // a method or a signature
    report.add({
      file,
      line: lineOf(match.index),
      rule: 1,
      message:
        "calls listen() outside server.ts: server.ts builds the app, listens and shuts down; nothing else listens",
    });
  }
}

// ── rule 2: app.ts exports buildApp ──────────────────────────────────────────

function checkBuildApp(file, { bare }, report) {
  const exported =
    /\bexport\s+(?:async\s+)?function\s*\*?\s*buildApp\b/.test(bare) ||
    /\bexport\s+(?:const|let|var)\s+buildApp\b/.test(bare) ||
    /\bexport\s*\{[^}]*\bbuildApp\b[^}]*\}/.test(bare);
  if (!exported) {
    report.add({
      file,
      rule: 2,
      message:
        "exports no buildApp: app.ts exports buildApp(config), which registers plugins then features and never listens",
    });
  }
}

// ── rule 3: config.ts reads the environment ──────────────────────────────────

function checkEnvironment(file, { code, bare }, lineOf, report) {
  const byLine = new Map();
  for (const match of code.matchAll(/\bNODE_ENV\b/g)) {
    const line = lineOf(match.index);
    byLine.set(line, "reads NODE_ENV: the app is configured by its own variables, never by NODE_ENV");
  }
  if (!CONFIG.test(file)) {
    for (const match of bare.matchAll(/\bprocess\s*\.\s*env\b/g)) {
      const line = lineOf(match.index);
      if (!byLine.has(line))
        byLine.set(line, "reads process.env outside config.ts: take the setting from the parsed config");
    }
  }
  for (const [line, message] of byLine) report.add({ file, line, rule: 3, message });
}

// ── rule 6: schemas on the route, not parsing in the handler ─────────────────

const REQUEST_INPUT = /\b(?:request|req)\s*\.\s*(?:body|query|params|headers)\b/;
const METHODS = "get|post|put|patch|delete|head|options|all";

function checkSchemas(file, { code, bare }, lineOf, report) {
  // Parsing request input by hand: schema.parse(request.body), parse(schema, request.query, reply).
  for (const match of bare.matchAll(/(?<![\w$])(?:([\w$]+)\s*\.\s*)?((?:safe)?[Pp]arse\w*|[Vv]alidate\w*)\s*\(/g)) {
    const [, owner, callee] = match;
    if (owner === "JSON" || /^parse(?:Int|Float)$/.test(callee)) continue;
    const open = match.index + match[0].length - 1;
    const close = closingBracket(bare, open);
    if (close === -1) continue;
    const input = REQUEST_INPUT.exec(bare.slice(open, close));
    if (!input) continue;
    report.add({
      file,
      line: lineOf(match.index),
      rule: 6,
      message: `${owner ? `${owner}.` : ""}${callee}(…${input[0].replace(/\s+/g, "")}…) parses request input by hand: declare it as the route's schema, through the type provider`,
    });
  }

  // A route registered with no schema: app.get("/x", handler), or app.route({ … }) without one.
  const shorthand = new RegExp(`(?<![\\w$])([A-Za-z_$][\\w$]*)\\s*\\.\\s*(${METHODS})\\s*(?=[<(])`, "g");
  for (const match of bare.matchAll(shorthand)) {
    let open = match.index + match[0].length;
    if (bare[open] === "<") {
      open = skipTypeArguments(bare, open);
      while (/\s/.test(bare[open] ?? "")) open++;
      if (bare[open] !== "(") continue;
    }
    const path = /^\(\s*(["'`])([/*][^"'`]*)\1/.exec(code.slice(open, open + 300));
    if (!path) continue;
    const close = closingBracket(bare, open);
    if (close === -1) continue;
    const args = splitArguments(bare, open, close);
    if (args.length < 2) continue;
    // app.get(path, handler), app.get(path, options, handler), or app.get(path, { ..., handler }).
    const options = bare.slice(...args[1]).trim();
    if (args.length >= 3 && !options.startsWith("{")) continue;
    if (options.startsWith("{") && hasSchemaKey(options)) continue;
    report.add({
      file,
      line: lineOf(match.index),
      rule: 6,
      message: `${match[2].toUpperCase()} ${path[2]} declares no schema: give it its params, querystring, body and response schemas`,
    });
  }
  for (const match of bare.matchAll(/(?<![\w$])[A-Za-z_$][\w$]*\s*\.\s*route\s*\(\s*\{/g)) {
    const open = match.index + match[0].length - 1;
    const close = closingBracket(bare, open);
    if (close === -1) continue;
    const object = bare.slice(open, close);
    if (!/(?:^|[{,\s])url\s*:/.test(object) || hasSchemaKey(object)) continue;
    const url = /\burl\s*:\s*(["'`])([^"'`]*)\1/.exec(code.slice(open, close));
    const method = /\bmethod\s*:\s*(["'`])([^"'`]*)\1/.exec(code.slice(open, close));
    report.add({
      file,
      line: lineOf(match.index),
      rule: 6,
      message: `${method ? method[2].toUpperCase() : "route"} ${url ? url[2] : "(computed url)"} declares no schema: give it its params, querystring, body and response schemas`,
    });
  }
}

/** Whether an options object (masked text) names a schema at its top level. */
function hasSchemaKey(object) {
  let depth = 0;
  let top = "";
  for (const c of object) {
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    else if (depth === 1) top += c;
    else if (depth === 0) top += c;
  }
  return /(?:^|[,\s])schema\s*(?::|,|$)|\.\.\./.test(top.trim());
}

/** The offset after the `>` that closes type arguments opened at `open`. */
function skipTypeArguments(bare, open) {
  let depth = 0;
  for (let i = open; i < bare.length; i++) {
    if (bare[i] === "<") depth++;
    else if (bare[i] === ">" && bare[i - 1] !== "=") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return bare.length;
}

run(NAME, main);
