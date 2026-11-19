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
 *   rule 3   process.env outside the config.ts at the top of a server or shared root
 *            (or the files conventions.json's "env" names), and any read of NODE_ENV,
 *            in server and shared roots (tests excepted). A string that only
 *            mentions NODE_ENV is not a read; one that is the name alone is
 *   rule 5   a feature reached past its index, from another feature or from app.ts:
 *            house-style's .dependency-cruiser.cjs (feature-through-index,
 *            app-through-feature-index), not this script
 *   rule 6   request input parsed by hand (schema.parse(request.body), a parse
 *            helper given the whole request.query), and a route registered with
 *            no schema, its path a literal or, on a Fastify-looking receiver,
 *            computed; a heuristic, tests excepted
 *   rule 7   domain/ importing a feature, and Fastify imported under lib/: the
 *            dependency-cruiser preset (domain-not-to-features, lib-without-fastify),
 *            not this script. Code under domain/ is otherwise server code like any other
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
  globRegex,
  insideRoot,
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
const CONFIG_AT_TOP = /^config\.[cm]?[jt]s$/;

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
    `${NAME}: checks rules ${RULES.join(", ")}; rules 5 and 7 (a feature through its index, app.ts included; domain/ never importing a feature; no Fastify in lib/) are dependency-cruiser's, in vendor/house-style/.dependency-cruiser.cjs`,
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

  const envReader = envReaderTest(conventions.env, [...server, ...shared]);

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
    if (!test) checkEnvironment(file, masked, lineOf, envReader, report);
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

/**
 * Which files may read process.env, and the name the message gives them: by default the
 * config.ts at the top of each server or shared root (one reader per root; a config.ts
 * further down is a finding of its own), or exactly the globs of conventions.json's "env",
 * which replace it (as ESLint's `env` option replaces its default).
 */
function envReaderTest(env, roots) {
  if (env === null) {
    const rootOf = (file) => roots.find((root) => root === "." || file.startsWith(`${root}/`)) ?? null;
    const atTop = (file) =>
      roots.some((root) => (root === "." || file.startsWith(`${root}/`)) && CONFIG_AT_TOP.test(insideRoot(root, file)));
    return {
      test: atTop,
      name: "config.ts",
      // A config.ts below the root reads the environment past the one reader.
      below: (file) => {
        const root = CONFIG.test(file) ? rootOf(file) : null;
        return root === null ? null : root === "." ? "config.ts" : `${root}/config.ts`;
      },
    };
  }
  const globs = env.map(globRegex);
  return {
    test: (file) => globs.some((glob) => glob.test(file)),
    name: `the env reader (${env.join(", ")})`,
    below: () => null,
  };
}

function checkEnvironment(file, { code, bare }, lineOf, envReader, report) {
  const byLine = new Map();
  // NODE_ENV as a name in code, or a string that is the name alone (process.env["NODE_ENV"],
  // env("NODE_ENV")); a message that mentions it, quoted or not, is not a read. A string's own
  // quotes survive in `bare` and its contents don't, so quotes still there are the delimiters.
  const named = [...code.matchAll(/(["'`])NODE_ENV\1/g)].filter(
    (match) => bare[match.index] === match[1] && bare[match.index + match[0].length - 1] === match[1],
  );
  const reads = [...bare.matchAll(/\bNODE_ENV\b/g), ...named];
  for (const match of reads) {
    const line = lineOf(match.index);
    byLine.set(line, "reads NODE_ENV: the app is configured by its own variables, never by NODE_ENV");
  }
  if (!envReader.test(file)) {
    const reader = envReader.below(file);
    const message =
      reader === null
        ? `reads process.env outside ${envReader.name}: take the setting from the parsed config`
        : `reads process.env in a config file below the root: ${reader} is the one reader, so take the setting from it`;
    for (const match of bare.matchAll(/\bprocess\s*\.\s*env\b/g)) {
      const line = lineOf(match.index);
      if (!byLine.has(line)) byLine.set(line, message);
    }
  }
  for (const [line, message] of byLine) report.add({ file, line, rule: 3, message });
}

// ── rule 6: schemas on the route, not parsing in the handler ─────────────────

const REQUEST_INPUT = /\b(?:request|req)\s*\.\s*(?:body|query|params|headers)\b/g;
const METHODS = "get|post|put|patch|delete|head|options|all";
/** A schema's own parse, or a bare parse, safeParse or validate: any request input given to it is parsed by hand. */
const SCHEMA_CALL = /^(?:(?:safe)?[Pp]arse|[Vv]alidate)(?:Async)?$/;
/** The names a Fastify instance usually goes by, for a route whose path isn't a literal. */
const ROUTE_RECEIVERS = ["app", "fastify", "instance", "server", "scope", "router"];

function checkSchemas(file, { code, bare }, lineOf, report) {
  // Parsing request input by hand: schema.parse(request.body), parse(schema, request.query, reply).
  // A helper of the route's own (parseRange, validateRedirect) given a property of validated
  // input, request.headers.range, is not; given the whole request.body, it is.
  for (const match of bare.matchAll(/(?<![\w$])(?:([\w$]+)\s*\.\s*)?((?:safe)?[Pp]arse\w*|[Vv]alidate\w*)\s*\(/g)) {
    const [, owner, callee] = match;
    if (owner === "JSON" || /^parse(?:Int|Float)$/.test(callee)) continue;
    const open = match.index + match[0].length - 1;
    const close = closingBracket(bare, open);
    if (close === -1) continue;
    const args = bare.slice(open, close);
    const inputs = [...args.matchAll(REQUEST_INPUT)];
    const input = inputs[0];
    if (!input) continue;
    const whole = inputs.some((m) => !/^\s*(?:\?\s*\.|!?\s*\.|!?\s*\[)/.test(args.slice(m.index + m[0].length)));
    if (!SCHEMA_CALL.test(callee) && !whole) continue;
    report.add({
      file,
      line: lineOf(match.index),
      rule: 6,
      message: `${owner ? `${owner}.` : ""}${callee}(…${input[0].replace(/\s+/g, "")}…) parses request input by hand: declare it as the route's schema, through the type provider`,
    });
  }

  // A route registered with no schema: app.get("/x", handler), or app.route({ … }) without one.
  const shorthand = new RegExp(`(?<![\\w$])([A-Za-z_$][\\w$]*)\\s*\\.\\s*(${METHODS})\\s*(?=[<(])`, "g");
  const calls = [];
  for (const match of bare.matchAll(shorthand)) {
    let open = match.index + match[0].length;
    if (bare[open] === "<") {
      open = skipTypeArguments(bare, open);
      while (/\s/.test(bare[open] ?? "")) open++;
      if (bare[open] !== "(") continue;
    }
    const literal = /^\(\s*(["'`])([/*][^"'`]*)\1/.exec(code.slice(open, open + 300));
    calls.push({ match, open, path: literal ? literal[2] : null });
  }
  // A computed path is read only on a receiver that looks like Fastify: one of the usual names,
  // or one this file registers a literal route on. cache.get(key, fallback) is not a route.
  const receivers = new Set([...ROUTE_RECEIVERS, ...calls.filter((c) => c.path !== null).map((c) => c.match[1])]);
  for (const { match, open, path: literalPath } of calls) {
    if (literalPath === null && !receivers.has(match[1])) continue;
    const close = closingBracket(bare, open);
    if (close === -1) continue;
    const args = splitArguments(bare, open, close);
    if (args.length < 2) continue;
    let path = literalPath;
    if (path === null) {
      const first = code.slice(...args[0]).trim();
      // A string that isn't a path (a header name, a key) is no route; a template with `${` is computed.
      if (/^["']/.test(first) || (first.startsWith("`") && !first.includes("${"))) continue;
      // A class or a token, as NestJS resolves a provider with app.get(ConfigService<Env, true>), is no path.
      if (/^[A-Z][a-z0-9][\w$]*\s*(?:<|$)/.test(first)) continue;
      path = first.replace(/\s+/g, " ");
      if (path.length > 60) path = `${path.slice(0, 57)}...`;
    }
    // app.get(path, handler), app.get(path, options, handler), or app.get(path, { ..., handler }).
    const options = bare.slice(...args[1]).trim();
    if (args.length >= 3 && !options.startsWith("{")) continue;
    if (options.startsWith("{") && hasSchemaKey(options)) continue;
    report.add({
      file,
      line: lineOf(match.index),
      rule: 6,
      message: `${match[2].toUpperCase()} ${path} declares no schema: give it its params, querystring, body and response schemas`,
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
