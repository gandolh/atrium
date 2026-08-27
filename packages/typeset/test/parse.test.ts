import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLatex } from "../src/parse/index.ts";
import type { CommandNode, EnvironmentNode, GroupNode, LatexNode, MathNode } from "../src/parse/index.ts";

/**
 * Structural coverage for the parse layer (brief 37, chunk 3): every node
 * kind the acceptance criteria names, mapped from `@unified-latex`'s tree
 * onto ours. Position accuracy has its own file (`parse-positions.test.ts`);
 * malformed input has its own (`parse-malformed.test.ts`). This file is about
 * shape: does `\section{Title}` produce a `command` with the right args, does
 * `\begin{itemize}...\end{itemize}` nest correctly, and so on.
 */

function types(nodes: LatexNode[]): string[] {
  return nodes.map((n) => n.type);
}

test("a text run maps to a TextNode with its literal value", () => {
  const { root, diagnostics } = parseLatex("hello", "x.tex");
  assert.deepEqual(diagnostics, []);
  assert.equal(root.length, 1);
  assert.equal(root[0]!.type, "text");
  assert.equal((root[0] as { value: string }).value, "hello");
});

test("inter-word space maps to a WhitespaceNode, distinct from a paragraph break", () => {
  const { root } = parseLatex("a b", "x.tex");
  assert.deepEqual(types(root), ["text", "whitespace", "text"]);
});

test("a blank line maps to a single ParBreakNode, however many blank lines there are", () => {
  const one = parseLatex("a\n\nb", "x.tex");
  const many = parseLatex("a\n\n\n\nb", "x.tex");
  assert.deepEqual(types(one.root), ["text", "parbreak", "text"]);
  assert.deepEqual(types(many.root), ["text", "parbreak", "text"]);
});

test("a single newline (no blank line) is whitespace, not a paragraph break", () => {
  const { root } = parseLatex("a\nb", "x.tex");
  assert.deepEqual(types(root), ["text", "whitespace", "text"]);
});

test("a command with a required argument", () => {
  const { root, diagnostics } = parseLatex("\\section{Title}", "x.tex");
  assert.deepEqual(diagnostics, []);
  assert.equal(root.length, 1);
  const cmd = root[0] as CommandNode;
  assert.equal(cmd.type, "command");
  assert.equal(cmd.name, "section");
  // `\section`'s known signature is `s o o m` (star, short-toc, toc, title):
  // the three optional slots the source didn't write still appear, unfilled.
  assert.equal(cmd.args.length, 4);
  assert.deepEqual(
    cmd.args.map((a) => a.bracket),
    [null, null, null, "{"],
  );
  const title = cmd.args[3]!;
  assert.equal(title.content.length, 1);
  assert.equal(title.content[0]!.type, "text");
  assert.equal((title.content[0] as { value: string }).value, "Title");
});

test("\\newcommand carries its name, arg count and body as arguments", () => {
  const { root, diagnostics } = parseLatex("\\newcommand{\\x}[1]{val: #1}", "x.tex");
  assert.deepEqual(diagnostics, []);
  const cmd = root[0] as CommandNode;
  assert.equal(cmd.name, "newcommand");
  // Known signature: `s m o m m` — starred, name, default-value, numargs... the
  // exact slot order is `@unified-latex`'s call, not ours to pin down here;
  // what matters is that the two things the writer typed both show up intact.
  const braceArgs = cmd.args.filter((a) => a.bracket === "{");
  const bracketArgs = cmd.args.filter((a) => a.bracket === "[");
  assert.equal(bracketArgs.length, 1);
  assert.equal(bracketArgs[0]!.content.length, 1);
  assert.equal((bracketArgs[0]!.content[0] as { value: string }).value, "1");
  const nameArg = braceArgs.find((a) => a.content[0]?.type === "command");
  assert.ok(nameArg, "the {\\x} slot maps its content as a CommandNode named \"x\"");
  assert.equal((nameArg!.content[0] as CommandNode).name, "x");
  const bodyArg = braceArgs.find(
    (a) => a.content.some((n) => n.type === "text" && n.value === "val"),
  );
  assert.ok(bodyArg, "the {val: #1} slot is present with its literal text");
});

test("an unknown (undefined) command gets no arguments — its braces are a sibling group", () => {
  const { root, diagnostics } = parseLatex("\\foo{bar}", "x.tex");
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(types(root), ["command", "group"]);
  const cmd = root[0] as CommandNode;
  assert.equal(cmd.name, "foo");
  assert.deepEqual(cmd.args, []);
  const group = root[1] as GroupNode;
  assert.equal(group.body.length, 1);
  assert.equal((group.body[0] as { value: string }).value, "bar");
});

test("a matched environment nests its body and keeps its name", () => {
  const { root, diagnostics } = parseLatex("\\begin{itemize}\n\\item one\n\\end{itemize}", "x.tex");
  assert.deepEqual(diagnostics, []);
  assert.equal(root.length, 1);
  const env = root[0] as EnvironmentNode;
  assert.equal(env.type, "environment");
  assert.equal(env.name, "itemize");
  const item = env.body.find((n): n is CommandNode => n.type === "command" && n.name === "item");
  assert.ok(item, "the \\item macro is in the environment's body");
});

test("a nested environment nests correctly", () => {
  const { root, diagnostics } = parseLatex(
    "\\begin{quote}\n\\begin{center}\ntext\n\\end{center}\n\\end{quote}",
    "x.tex",
  );
  assert.deepEqual(diagnostics, []);
  const outer = root[0] as EnvironmentNode;
  assert.equal(outer.name, "quote");
  const inner = outer.body.find((n): n is EnvironmentNode => n.type === "environment");
  assert.ok(inner);
  assert.equal(inner.name, "center");
});

test("an environment nested inside \\item's gathered content is still there, just not as a direct sibling of \\item", () => {
  // \item's argument parser gobbles everything up to the next \item/\end —
  // that includes a nested environment, which is correct LaTeX (a nested
  // list under a bullet really is that item's content). It ends up inside
  // the \item command's own args, not in the outer environment's `body`.
  const { root, diagnostics } = parseLatex(
    "\\begin{itemize}\n\\item outer\n\\begin{itemize}\n\\item inner\n\\end{itemize}\n\\end{itemize}",
    "x.tex",
  );
  assert.deepEqual(diagnostics, []);
  const outer = root[0] as EnvironmentNode;
  assert.ok(
    outer.body.every((n) => n.type !== "environment"),
    "the nested itemize is not a direct sibling of \\item in the outer body",
  );
  const item = outer.body.find((n): n is CommandNode => n.type === "command" && n.name === "item")!;
  const gatheredArg = item.args.find((a) => a.content.length > 0)!;
  const nested = gatheredArg.content.find((n): n is EnvironmentNode => n.type === "environment");
  assert.ok(nested, "the nested environment is inside \\item's gathered argument content");
  assert.equal(nested!.name, "itemize");
});

test("a brace group that is not an argument maps to a GroupNode", () => {
  const { root, diagnostics } = parseLatex("a {grouped text} b", "x.tex");
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(types(root), ["text", "whitespace", "group", "whitespace", "text"]);
  const group = root[2] as GroupNode;
  assert.deepEqual(types(group.body), ["text", "whitespace", "text"]);
});

test("a comment excludes the leading % and the line ending from its value", () => {
  const { root, diagnostics } = parseLatex("text % a comment\nmore", "x.tex");
  assert.deepEqual(diagnostics, []);
  const comment = root.find((n) => n.type === "comment");
  assert.ok(comment);
  assert.equal((comment as { value: string }).value, " a comment");
});

test("inline math ($...$) maps to a MathNode with display: false", () => {
  const { root, diagnostics } = parseLatex("$x^2$", "x.tex");
  assert.deepEqual(diagnostics, []);
  assert.equal(root.length, 1);
  const math = root[0] as MathNode;
  assert.equal(math.type, "math");
  assert.equal(math.display, false);
  // `^` in math mode takes an argument (superscript) — it maps as a command,
  // not an EscapedCharNode, even though it prints as a single character too.
  // See the escaped-vs-math-macro test below for why.
  const sup = math.body.find((n): n is CommandNode => n.type === "command" && n.name === "^");
  assert.ok(sup, "\\^ inside math mode is a CommandNode with an argument");
  assert.equal(sup.args[0]!.content[0]!.type, "text");
});

test("display math (\\[...\\] and $$...$$) maps to a MathNode with display: true", () => {
  const brackets = parseLatex("before \\[ x \\] after", "x.tex");
  const dollars = parseLatex("before $$ x $$ after", "x.tex");
  for (const { root, diagnostics } of [brackets, dollars]) {
    assert.deepEqual(diagnostics, []);
    const math = root.find((n): n is MathNode => n.type === "math");
    assert.ok(math);
    assert.equal(math.display, true);
  }
});

for (const [source, char] of [
  ["\\%", "%"],
  ["\\&", "&"],
  ["\\_", "_"],
  ["\\#", "#"],
  ["\\$", "$"],
] as const) {
  test(`escaped special ${JSON.stringify(source)} maps to an EscapedCharNode`, () => {
    const { root, diagnostics } = parseLatex(source, "x.tex");
    assert.deepEqual(diagnostics, []);
    assert.equal(root.length, 1);
    assert.equal(root[0]!.type, "escaped");
    assert.equal((root[0] as { char: string }).char, char);
  });
}

test("a control word gobbles the whitespace that follows it, the way TeX's tokenizer does", () => {
  // The brief's own example: `\textbackslash large` must set as `\large`
  // (backslash glyph immediately followed by "large"), not `\ large` with a
  // visible gap — because `\textbackslash` (all letters) is a *control
  // word*, and TeX's tokenizer consumes the space after a control word
  // before a space token is ever produced. `@unified-latex` itself doesn't
  // model this (confirmed by direct probing — see from-unified-latex.ts) so
  // there is no upstream whitespace node here at all to preserve.
  const { root, diagnostics } = parseLatex("\\textbackslash large", "x.tex");
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(types(root), ["command", "text"]);
  assert.equal((root[0] as CommandNode).name, "textbackslash");
  assert.equal((root[1] as { value: string }).value, "large");
});

test("a control symbol does not gobble the whitespace that follows it", () => {
  // `\%` is a *control symbol* (backslash + one non-letter character): TeX's
  // tokenizer returns to normal state immediately, so the space after it is
  // a real space token, unlike after a control word.
  const { root, diagnostics } = parseLatex("\\% text", "x.tex");
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(types(root), ["escaped", "whitespace", "text"]);
});

test("a control word gobbles the whitespace even when it takes no known arguments", () => {
  const { root } = parseLatex("\\large text", "x.tex");
  assert.deepEqual(types(root), ["command", "text"]);
  assert.equal((root[1] as { value: string }).value, "text");
});

test("a control word does not gobble across a blank line — that is still a paragraph break", () => {
  // TeX's skip-blanks state after a control word still yields \par for a
  // genuinely blank line; only ordinary inter-word space is swallowed.
  const { root } = parseLatex("\\large\n\ntext", "x.tex");
  assert.deepEqual(types(root), ["command", "parbreak", "text"]);
});

test("a math-mode macro that shares a character with an escaped special is not confused for one", () => {
  // `_` outside math is the escaped-underscore special; `_` inside math is
  // the subscript macro and takes an argument. Same content string, must not
  // map the same way.
  const escaped = parseLatex("\\_", "x.tex");
  const subscript = parseLatex("$a_b$", "x.tex");
  assert.equal(escaped.root[0]!.type, "escaped");
  const math = subscript.root[0] as MathNode;
  const sub = math.body.find((n): n is CommandNode => n.type === "command" && n.name === "_");
  assert.ok(sub, "math-mode _ is a CommandNode, not an EscapedCharNode");
});
