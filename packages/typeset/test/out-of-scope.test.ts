import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompileResult, Diagnostic } from "../src/index.ts";
import { compile, createLatinModernProvider } from "../src/index.ts";
import { loadLatinModernBytes } from "../node/fonts.ts";

/**
 * Brief 39, chunk 39.6: a diagnostic fixture for **every** item on brief 39's
 * "Out" list (verbatim: `longtable`, `tabularx`, `booktabs`, `multirow`,
 * `subfigure`/`subcaption`, wrapped text around floats (`wrapfigure`),
 * `\rotatebox`, EPS/PDF/SVG graphics, BibLaTeX/`biber` syntax, author-year and
 * custom `.bst` styles).
 *
 * Five of those items already have a fixture pinning `code`, `severity` and a
 * message that names the construct, written by an earlier chunk in a sibling
 * file — duplicating them here would only make two suites break together
 * instead of one:
 *
 * - `longtable`, `tabularx` and `wrapfigure` — `unsupported.test.ts`'s
 *   `UNSUPPORTED_ENVIRONMENTS` table.
 * - EPS / PDF / SVG graphics — `images.test.ts`'s `UNSUPPORTED_FORMATS` table,
 *   which decodes each by signature and names the format in the message.
 * - author-year and custom `.bst` styles — `figures-tables-bib.test.ts`'s
 *   "a style other than the numeric one is `unsupported`" test, exercised
 *   with `apalike` (itself a real author-year style), which is the same code
 *   path any other unrecognised style name — including a custom `.bst` — would
 *   hit: this engine implements exactly one style, so anything else is
 *   `unsupported` naming itself.
 *
 * What is left, and what this file actually covers:
 *
 * - `booktabs` (`\toprule`, `\midrule`, `\bottomrule`, `\cmidrule`)
 * - `multirow` (`\multirow`)
 * - `subfigure` (the `subcaption` package's environment) and `subcaption`
 *   (its command)
 * - `\rotatebox`
 * - BibLaTeX/`biber` syntax, via `\usepackage{biblatex}`
 *
 * **The contract question this chunk exists to settle:** before this chunk,
 * `booktabs`'s commands, `multirow`, `subcaption` and `\rotatebox` were in no
 * table in `macro/builtins.ts` at all, and `subfigure` was an unrecognised
 * environment — which made every one of them `undefined-command` /
 * `undefined-environment`. That code means "no such thing exists," which is a
 * false statement about real, widely-used LaTeX (`graphicx`'s `\rotatebox`,
 * the `multirow` and `booktabs` packages, `subcaption`) that brief 39 lists as
 * a construct Atrium chose not to implement — the exact meaning of
 * `unsupported`, and exactly how `wrapfigure`/`tabularx`/`longtable` already
 * report. `macro/builtins.ts` gained one row per command (not per package —
 * an author writes `\toprule`, never `\booktabs`) marking them `unsupported`,
 * with a `detail` that says *why brief 39 stops here*, never "not yet."
 */

const fonts = createLatinModernProvider(loadLatinModernBytes());
const encoder = new TextEncoder();

function encode(text: string): Uint8Array {
  return encoder.encode(text);
}

function compileSource(src: string): CompileResult {
  return compile({ "main.tex": encode(src) }, "main.tex", { fonts });
}

/** Wrap a body in the minimal preamble every fixture below needs. */
function doc(body: string): string {
  return `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
}

function unsupportedFor(result: CompileResult, construct: string): Diagnostic | undefined {
  return result.diagnostics.find((d) => d.code === "unsupported" && d.construct === construct);
}

// --- booktabs -----------------------------------------------------------

/**
 * An author only ever writes the package's rule commands, never `\booktabs`
 * itself — so one row per command, and one assertion per command, each
 * pinning both the construct name and that the message names the package.
 */
const BOOKTABS_COMMANDS = ["toprule", "midrule", "bottomrule", "cmidrule"];

test("every booktabs rule command reports `unsupported`, naming the package", () => {
  for (const name of BOOKTABS_COMMANDS) {
    const result = compileSource(doc(`\\${name}`));
    const hit = unsupportedFor(result, `\\${name}`);
    assert.ok(hit !== undefined, `\\${name} did not report unsupported — got: ${JSON.stringify(result.diagnostics)}`);
    assert.equal(hit.severity, "error");
    assert.match(hit.message, /booktabs/);
  }
});

// --- multirow -------------------------------------------------------------

test("\\multirow reports `unsupported`, naming the package", () => {
  const result = compileSource(doc("\\multirow"));
  const hit = unsupportedFor(result, "\\multirow");
  assert.ok(hit !== undefined, `did not report unsupported — got: ${JSON.stringify(result.diagnostics)}`);
  assert.equal(hit.severity, "error");
  assert.match(hit.message, /multirow/);
});

// --- subfigure / subcaption -------------------------------------------------

test("the subcaption package's \\subcaption command reports `unsupported`, naming the package", () => {
  const result = compileSource(doc("\\subcaption{x}"));
  const hit = unsupportedFor(result, "\\subcaption");
  assert.ok(hit !== undefined, `did not report unsupported — got: ${JSON.stringify(result.diagnostics)}`);
  assert.equal(hit.severity, "error");
  assert.match(hit.message, /subcaption/);
});

/**
 * `subfigure` written where real documents write it — nested inside a
 * `figure` — rather than bare, because that nesting has a knock-on this chunk
 * measured and is deliberately pinning: refusing `subfigure`'s content leaves
 * the enclosing `figure` with nothing to typeset, so `applyFloat` (`doc/build.ts`)
 * also reports its own, unrelated "is empty" warning.
 *
 * That second diagnostic is a **true, independent statement** — the figure
 * really does set nothing, for a reason the first diagnostic already gave —
 * not noise duplicating the first: it is the same "content vanished" warning
 * any other float would get if every one of its children were refused, and
 * silencing it here would special-case `subfigure` out of a check that exists
 * precisely to catch a float whose content quietly disappeared. Both
 * diagnostics are asserted, not just the first.
 */
test(
  "subfigure inside a figure reports `unsupported` naming the subcaption package, and the emptied figure warns separately",
  () => {
    const result = compileSource(
      doc("\\begin{figure}\n\\begin{subfigure}{0.5\\textwidth}\nx\n\\end{subfigure}\n\\end{figure}"),
    );
    const sub = unsupportedFor(result, "subfigure");
    assert.ok(sub !== undefined, `did not report unsupported — got: ${JSON.stringify(result.diagnostics)}`);
    assert.equal(sub.severity, "error");
    assert.match(sub.message, /subcaption/);

    const empty = result.diagnostics.find((d) => d.code === "syntax" && d.construct === "figure");
    assert.ok(empty !== undefined, `the enclosing figure did not warn about being empty — got: ${JSON.stringify(result.diagnostics)}`);
    assert.equal(empty.severity, "warning");
    assert.match(empty.message, /empty/);
  },
);

// --- \rotatebox -------------------------------------------------------------

test("\\rotatebox reports `unsupported`, naming graphicx", () => {
  const result = compileSource(doc("\\rotatebox{90}{x}"));
  const hit = unsupportedFor(result, "\\rotatebox");
  assert.ok(hit !== undefined, `did not report unsupported — got: ${JSON.stringify(result.diagnostics)}`);
  assert.equal(hit.severity, "error");
  assert.match(hit.message, /graphicx/);
});

// --- BibLaTeX / biber syntax -------------------------------------------------

/**
 * BibLaTeX documents opt in with `\usepackage{biblatex}` before ever writing
 * `\addbibresource` or `\printbibliography` — this engine's numeric style is
 * built on the older `\bibliography`/`\bibliographystyle` interface
 * (chunk 39.5), so the load itself is where biblatex syntax is refused. This
 * goes through the same general "package not in the accepted five" path
 * `unsupported.test.ts` already exercises with `tikz`; what this fixture adds
 * is the specific name brief 39's Out list requires a fixture for.
 */
test("\\usepackage{biblatex} reports `unsupported`, naming biblatex", () => {
  const result = compileSource(
    "\\documentclass{article}\n\\usepackage{biblatex}\n\\begin{document}\nx\n\\end{document}\n",
  );
  const hit = unsupportedFor(result, "\\usepackage{biblatex}");
  assert.ok(hit !== undefined, `did not report unsupported — got: ${JSON.stringify(result.diagnostics)}`);
  assert.equal(hit.severity, "error");
});
