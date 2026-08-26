import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLatex } from "../src/parse/index.ts";
import { createBudget } from "../src/macro/budget.ts";
import { createExpandContext, expandMacros } from "../src/macro/expand.ts";
import type { Diagnostic } from "../src/diagnostics.ts";
import type { LatexNode } from "../src/parse/index.ts";

/**
 * The `\newcommand` expander (brief 37, chunk 6).
 *
 * These test the *mechanic* the parser forces on us — a user macro arrives
 * with `args: []` and its arguments as siblings — rather than going through
 * the document builder, so a failure points at the expander rather than at
 * whatever the builder made of its output.
 */

function expand(source: string, stepBudget = 100_000): { text: string; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const parsed = parseLatex(source, "t.tex");
  for (const d of parsed.diagnostics) diagnostics.push(d);
  const ctx = createExpandContext(createBudget(stepBudget), diagnostics);
  return { text: render(expandMacros(parsed.root, ctx)), diagnostics };
}

/** A flat, readable transcript of a node list — enough to assert expansion on. */
function render(nodes: readonly LatexNode[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        out += node.value;
        break;
      case "whitespace":
        out += " ";
        break;
      case "parbreak":
        out += "\n\n";
        break;
      case "escaped":
        out += `\\${node.char}`;
        break;
      case "command":
        out += `\\${node.name}`;
        for (const arg of node.args) {
          if (arg.bracket === "{") out += `{${render(arg.content)}}`;
          else if (arg.bracket === "[") out += `[${render(arg.content)}]`;
        }
        break;
      case "group":
        out += `{${render(node.body)}}`;
        break;
      case "environment":
        out += `\\begin{${node.name}}${render(node.body)}\\end{${node.name}}`;
        break;
      case "math":
        out += `$${render(node.body)}$`;
        break;
      case "comment":
        break;
      case "unknown":
        out += `<${node.originalType}>`;
        break;
    }
  }
  return out;
}

function codes(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((d) => d.code ?? "?");
}

test("a macro with no arguments expands to its body", () => {
  const { text, diagnostics } = expand("\\newcommand{\\hi}{hello}a \\hi b");
  assert.deepEqual(diagnostics, []);
  assert.equal(text, "a hello b");
});

test("a required argument is taken from the following sibling group", () => {
  // The parser gives `\shout` `args: []` and `{loud}` as a *sibling* — the
  // expander is what knows the group belongs to it.
  const { text } = expand("\\newcommand{\\shout}[1]{[#1!]}\\shout{loud} rest");
  assert.equal(text, "[loud!] rest");
});

test("two required arguments consume two groups, in order", () => {
  const { text } = expand("\\newcommand{\\pair}[2]{#2-#1}\\pair{a}{b}");
  assert.equal(text, "b-a");
});

test("a single-token argument takes one character and leaves the rest behind", () => {
  const { text } = expand("\\newcommand{\\one}[1]{<#1>}\\one ab");
  assert.equal(text, "<a>b");
});

test("a parameter used twice is substituted twice", () => {
  const { text } = expand("\\newcommand{\\twice}[1]{#1#1}\\twice{x}");
  assert.equal(text, "xx");
});

test("## is a literal #", () => {
  const { text, diagnostics } = expand("\\newcommand{\\hash}{##}\\hash");
  assert.deepEqual(diagnostics, []);
  assert.equal(text, "#");
});

test("an optional argument defaults when no bracket follows", () => {
  const { text } = expand("\\newcommand{\\greet}[1][Hello]{#1 there}\\greet");
  assert.equal(text, "Hello there");
});

test("an optional argument is taken when a bracket does follow", () => {
  const { text } = expand("\\newcommand{\\greet}[1][Hello]{#1 there}\\greet[Hi]");
  assert.equal(text, "Hi there");
});

test("an optional argument plus required ones fills both", () => {
  const { text } = expand("\\newcommand{\\m}[3][d]{(#1,#2,#3)}\\m{b}{c} then \\m[a]{b}{c}");
  assert.equal(text, "(d,b,c) then (a,b,c)");
});

test("a bracket that is not an optional argument is left as text", () => {
  // `\note` takes no optional argument, so `[see]` is ordinary prose and must
  // survive untouched — the failure mode here is silently eating a bracket.
  const { text } = expand("\\newcommand{\\note}[1]{<#1>}\\note{x} [see]");
  assert.equal(text, "<x> [see]");
});

test("an optional argument may contain nested brackets and commands", () => {
  const { text } = expand("\\newcommand{\\o}[1][x]{<#1>}\\o[a[b]c]");
  assert.equal(text, "<a[b]c>");
});

test("macros nest: a macro body may use another macro", () => {
  const { text } = expand("\\newcommand{\\inner}[1]{(#1)}\\newcommand{\\outer}[1]{[\\inner{#1}]}\\outer{z}");
  assert.equal(text, "[(z)]");
});

test("a macro may be used inside another macro's argument", () => {
  const { text } = expand("\\newcommand{\\a}[1]{<#1>}\\newcommand{\\b}{B}\\a{\\b}");
  assert.equal(text, "<B>");
});

test("a macro used inside a group or environment expands there too", () => {
  const { text } = expand("\\newcommand{\\x}{X}{\\x}\\begin{itemize}\\item \\x\\end{itemize}");
  assert.match(text, /\{X\}/);
  assert.match(text, /X\\end\{itemize\}|X/);
});

test("recursion that terminates is fine — depth is not the limit, steps are", () => {
  const source =
    "\\newcommand{\\a}[1]{[#1]}\\newcommand{\\b}[1]{\\a{\\a{#1}}}\\newcommand{\\c}[1]{\\b{\\b{#1}}}\\c{q}";
  const { text } = expand(source);
  assert.equal(text, "[[[[q]]]]");
});

test("\\renewcommand replaces an existing definition", () => {
  const { text } = expand("\\newcommand{\\v}{one}\\v \\renewcommand{\\v}{two}\\v");
  assert.equal(text, "one two");
});

test("\\renewcommand of a builtin uses the arguments the parser already attached", () => {
  // `\emph` *does* have a CTAN signature, so its argument is on the node and
  // there is no sibling group to consume. The expander has to notice.
  const { text } = expand("\\renewcommand{\\emph}[1]{<<#1>>}\\emph{x}");
  assert.equal(text, "<<x>>");
});

test("\\providecommand keeps an existing definition", () => {
  const { text } = expand("\\newcommand{\\p}{first}\\providecommand{\\p}{second}\\p");
  assert.equal(text, "first");
});

test("\\newcommand over an existing name warns but still redefines", () => {
  const { text, diagnostics } = expand("\\newcommand{\\d}{a}\\newcommand{\\d}{b}\\d");
  assert.equal(text, "b");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.severity, "warning");
  assert.equal(diagnostics[0]!.code, "syntax");
});

test("\\renewcommand of a name that was never defined warns", () => {
  const { diagnostics } = expand("\\renewcommand{\\nope}{x}");
  assert.deepEqual(codes(diagnostics), ["undefined-command"]);
});

test("too few arguments is a syntax diagnostic, not a silent empty expansion", () => {
  const { diagnostics } = expand("\\newcommand{\\two}[2]{#1#2}\\two{a}");
  assert.deepEqual(codes(diagnostics), ["syntax"]);
  assert.match(diagnostics[0]!.message, /takes 2 arguments/);
});

test("#3 in a two-parameter macro is a syntax diagnostic", () => {
  const { diagnostics } = expand("\\newcommand{\\two}[2]{#1#3}\\two{a}{b}");
  assert.deepEqual(codes(diagnostics), ["syntax"]);
  assert.match(diagnostics[0]!.message, /#3/);
});

test("redefining a counter-formatting hook is unsupported, not silently ignored", () => {
  const { diagnostics } = expand("\\renewcommand{\\thesection}{X}");
  assert.ok(diagnostics.some((d) => d.code === "unsupported" && d.construct === "\\thesection"));
});

test("a macro that expands to itself is stopped by the budget, not the stack", () => {
  const { diagnostics } = expand("\\newcommand{\\loop}{\\loop}\\loop", 50_000);
  assert.deepEqual(codes(diagnostics), ["budget-exceeded"]);
  assert.match(diagnostics[0]!.message, /never terminates/);
});

test("mutual recursion is stopped by the budget too", () => {
  const { diagnostics } = expand("\\newcommand{\\a}{\\b}\\newcommand{\\b}{\\a}\\a", 50_000);
  assert.deepEqual(codes(diagnostics), ["budget-exceeded"]);
});

test("a macro that doubles its own body is stopped, and quickly", () => {
  const started = Date.now();
  const { diagnostics } = expand("\\newcommand{\\l}{\\l\\l}\\l", 5_000_000);
  assert.deepEqual(codes(diagnostics), ["budget-exceeded"]);
  // Not a benchmark — a guard against the O(n²) shape this had when the work
  // list was spliced instead of pushed back.
  assert.ok(Date.now() - started < 10_000, "runaway expansion must fail fast");
});

test("a recursive macro that consumes an argument still terminates against the budget", () => {
  const { diagnostics } = expand("\\newcommand{\\r}[1]{\\r{#1}}\\r{x}", 50_000);
  assert.deepEqual(codes(diagnostics), ["budget-exceeded"]);
});

test("one runaway macro produces exactly one diagnostic", () => {
  const { diagnostics } = expand("\\newcommand{\\loop}{\\loop}\\loop", 50_000);
  assert.equal(diagnostics.length, 1);
});

test("an abort signal stops expansion at a step boundary", () => {
  const diagnostics: Diagnostic[] = [];
  const parsed = parseLatex("\\newcommand{\\loop}{\\loop}\\loop", "t.tex");
  const budget = createBudget(5_000_000, { aborted: true });
  expandMacros(parsed.root, createExpandContext(budget, diagnostics));
  assert.deepEqual(codes(diagnostics), ["budget-exceeded"]);
  assert.match(diagnostics[0]!.message, /cancelled/);
});

test("a malformed \\newcommand is a diagnostic, not a definition", () => {
  const { diagnostics } = expand("\\newcommand{notacommand}{x}");
  assert.deepEqual(codes(diagnostics), ["syntax"]);
});

test("a non-numeric argument count is a diagnostic", () => {
  const { diagnostics } = expand("\\newcommand{\\x}[q]{y}");
  assert.ok(diagnostics.some((d) => d.code === "syntax"));
});

test("diagnostics from expansion carry the file and a real line", () => {
  const { diagnostics } = expand("a\nb\n\\newcommand{\\two}[2]{#1}\\two{x}");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.file, "t.tex");
  assert.equal(diagnostics[0]!.line, 3);
});
