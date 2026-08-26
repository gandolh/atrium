import type * as Ast from "@unified-latex/unified-latex-types";
import { error } from "../diagnostics.ts";
import type { Diagnostic, SourceRef } from "../diagnostics.ts";
import type { Argument, LatexNode, SourceSpan } from "./ast.ts";

/**
 * Maps `@unified-latex`'s general-purpose LaTeX AST onto ours (see the module
 * doc comment in `ast.ts` for why we don't just re-export theirs).
 *
 * Two things this file exists to work around, both found by probing the
 * library directly rather than trusting its docs — see the handoff notes for
 * chunk 6:
 *
 * 1. **Malformed input never throws and never signals itself.** An unclosed
 *    `\begin{itemize}`, a mismatched `\end{enumerate}`, an unclosed `{`, or a
 *    stray `}` all parse "successfully": the library just falls back to
 *    treating `\begin`/`\end` as ordinary macros and stray braces as literal
 *    text, with no error node anywhere in the tree. The only way to detect
 *    these is to notice, while walking, that a `\begin`/`\end` macro or a
 *    literal `{`/`}` character survived into the mapped tree at all — a
 *    correctly-matched pair never shows up this way, because the library
 *    consumes it into a proper `environment`/`group` node. `checkMalformed`
 *    below is that check, run once per content-list element as we walk.
 *
 * 2. **Position goes missing on specific boundary nodes.** A `whitespace` or
 *    `parbreak` node that sits at the edge of content gathered by a macro's
 *    custom argument parser (confirmed for `\item`'s trailing text, and for
 *    the gap between two `\item`s in an environment's direct content) comes
 *    back with no `position` field at all. Every other node kind, in every
 *    case tested, always has one. `resolveSpan` recovers the missing span
 *    exactly (not approximately): such a node is always a gap between two
 *    positioned siblings, so its span is `(previous sibling's end, next
 *    sibling's start)`, which is not a guess — it *is* the gap.
 */

const ESCAPED_CHARS = new Set(["%", "&", "_", "#", "$", "{", "}"]);

function toRef(pos: { line: number; column: number }, file: string): SourceRef {
  return { file, line: pos.line, column: pos.column };
}

/** Scans forward from `from` for the next sibling that still has a real
 * position, for reconstructing a position-less node's span (see file doc). */
function findNextKnownStart(rawNodes: readonly Ast.Node[], from: number, file: string): SourceRef | null {
  for (let i = from; i < rawNodes.length; i++) {
    const pos = rawNodes[i]?.position;
    if (pos) return toRef(pos.start, file);
  }
  return null;
}

function resolveSpan(
  raw: Ast.Node,
  file: string,
  cursor: SourceRef,
  rawNodes: readonly Ast.Node[],
  index: number,
): SourceSpan {
  const pos = raw.position;
  if (pos) return { start: toRef(pos.start, file), end: toRef(pos.end, file) };
  const nextStart = findNextKnownStart(rawNodes, index + 1, file);
  return { start: cursor, end: nextStart ?? cursor };
}

/** The `\begin`/`\end` immediately followed by its `{name}` group, tolerating
 * a single space (`\begin {itemize}` is valid LaTeX) — used only to make the
 * diagnostic message name the environment; absence of a name doesn't change
 * whether the diagnostic fires. */
function envNameFollowing(rawNodes: readonly Ast.Node[], index: number): string | null {
  let i = index + 1;
  if (rawNodes[i]?.type === "whitespace") i++;
  const next = rawNodes[i];
  if (next && next.type === "group" && next.content.length === 1) {
    const only = next.content[0];
    if (only && only.type === "string") return only.content;
  }
  return null;
}

function checkMalformed(
  raw: Ast.Node,
  rawNodes: readonly Ast.Node[],
  index: number,
  file: string,
  diagnostics: Diagnostic[],
): void {
  if (raw.type === "macro" && (raw.content === "begin" || raw.content === "end")) {
    // Always positioned in every case observed; `wholeFile`-style fallback
    // would misreport the line, so this stays a hard requirement rather than
    // silently degrading — if it ever fires, treat it as a bug to revisit.
    const ref = raw.position ? toRef(raw.position.start, file) : { file, line: 0 };
    const name = envNameFollowing(rawNodes, index);
    const label = name ? `\\${raw.content}{${name}}` : `\\${raw.content}`;
    const message =
      raw.content === "begin"
        ? `unclosed environment${name ? ` \`${name}\`` : ""} — no matching \\end${name ? `{${name}}` : ""}`
        : `\\end${name ? `{${name}}` : ""} has no matching \\begin${name ? `{${name}}` : ""}`;
    diagnostics.push(error("syntax", ref, message, label));
    return;
  }
  if (raw.type === "string" && (raw.content === "{" || raw.content === "}")) {
    const ref = raw.position ? toRef(raw.position.start, file) : { file, line: 0 };
    const message =
      raw.content === "{" ? "unmatched { — this group is never closed" : "unmatched } — no matching { was opened";
    diagnostics.push(error("syntax", ref, message, raw.content));
  }
}

/**
 * `\%`, `\&`, `\_`, `\#`, `\$`, `\{`, `\}` — a macro whose *entire* identity
 * is "print this one literal character". Told apart from a bare-backslash
 * math macro like `^`/`_` (math superscript/subscript, which takes an
 * argument) by `escapeToken`: an escaped special has no `escapeToken` at all
 * (it uses the ordinary backslash), while `^`/`_` as math macros always carry
 * `escapeToken: ""` even though they print as a single character too.
 */
function isEscapedChar(raw: Ast.Macro): boolean {
  return raw.escapeToken === undefined && !raw.args && raw.content.length === 1 && ESCAPED_CHARS.has(raw.content);
}

function rawText(raw: Ast.Node, source: string): string {
  if ("content" in raw && typeof raw.content === "string") return raw.content;
  const pos = raw.position;
  return pos ? source.slice(pos.start.offset, pos.end.offset) : "";
}

function mapArgs(
  rawArgs: readonly Ast.Argument[] | undefined,
  file: string,
  source: string,
  startCursor: SourceRef,
  diagnostics: Diagnostic[],
): { args: Argument[]; endCursor: SourceRef } {
  if (!rawArgs || rawArgs.length === 0) return { args: [], endCursor: startCursor };

  const args: Argument[] = [];
  let cursor = startCursor;
  for (const rawArg of rawArgs) {
    const bracket = rawArg.openMark === "{" ? "{" : rawArg.openMark === "[" ? "[" : null;
    if (rawArg.content.length === 0) {
      // Slot from a known signature the source didn't write (e.g. `\section`'s
      // short-title). Zero-width at the point it would have started, so it
      // never perturbs the cursor for the argument that follows it.
      args.push({ bracket, content: [], loc: { start: cursor, end: cursor } });
      continue;
    }
    const { nodes, endCursor } = mapContentList(rawArg.content, file, source, cursor, diagnostics);
    args.push({ bracket, content: nodes, loc: { start: nodes[0]!.loc.start, end: endCursor } });
    cursor = endCursor;
  }
  return { args, endCursor: cursor };
}

/**
 * Maps one node. Returns both the mapped node (whose `loc` is *just that
 * node's own token* — e.g. a `CommandNode`'s `loc` covers `\item`, not the
 * args after it) and `consumedEnd`: how far the source was actually consumed
 * mapping it, which the caller must use as the next sibling's cursor seed.
 *
 * The two differ for `CommandNode`: `@unified-latex` positions a macro node
 * over only the command token itself, never over the arguments that follow
 * it — and for a macro with a custom "gobble everything up to the next
 * `\item`/`\end`" argument parser (built in for `\item` and similar), that
 * gap can be arbitrary. Using the macro's own `loc.end` as the next sibling's
 * cursor would place a position-recovered node (see the file doc comment) at
 * the *start* of `\item`'s consumed text instead of its end — same line in
 * the common case, but a materially wrong column, and wrong outright once
 * the consumed content spans multiple lines. Every other node kind's own
 * `position.end` from `@unified-latex` already covers everything it consumed
 * (an environment's covers through its `\end`, a group's through its `}`),
 * so `consumedEnd` equals `loc.end` for all of them.
 */
function mapNode(
  raw: Ast.Node,
  file: string,
  source: string,
  span: SourceSpan,
  diagnostics: Diagnostic[],
): { node: LatexNode; consumedEnd: SourceRef } {
  switch (raw.type) {
    case "string":
      return { node: { type: "text", value: raw.content, loc: span }, consumedEnd: span.end };
    case "whitespace":
      return { node: { type: "whitespace", loc: span }, consumedEnd: span.end };
    case "parbreak":
      return { node: { type: "parbreak", loc: span }, consumedEnd: span.end };
    case "comment":
      return {
        node: { type: "comment", value: raw.content, sameLine: raw.sameline ?? false, loc: span },
        consumedEnd: span.end,
      };
    case "macro": {
      if (isEscapedChar(raw)) return { node: { type: "escaped", char: raw.content, loc: span }, consumedEnd: span.end };
      const { args, endCursor } = mapArgs(raw.args, file, source, span.end, diagnostics);
      return { node: { type: "command", name: raw.content, args, loc: span }, consumedEnd: endCursor };
    }
    case "environment":
    case "mathenv": {
      const { args, endCursor } = mapArgs(raw.args, file, source, span.start, diagnostics);
      const { nodes: body } = mapContentList(raw.content, file, source, endCursor, diagnostics);
      return { node: { type: "environment", name: raw.env, args, body, loc: span }, consumedEnd: span.end };
    }
    case "group": {
      const { nodes: body } = mapContentList(raw.content, file, source, span.start, diagnostics);
      return { node: { type: "group", body, loc: span }, consumedEnd: span.end };
    }
    case "inlinemath":
    case "displaymath": {
      const { nodes: body } = mapContentList(raw.content, file, source, span.start, diagnostics);
      return {
        node: { type: "math", display: raw.type === "displaymath", body, loc: span },
        consumedEnd: span.end,
      };
    }
    default:
      // `verb`, `verbatim`, or a future `@unified-latex` node kind this stage
      // has no dedicated mapping for. Preserved rather than dropped (D38) —
      // see `UnknownNode`'s doc comment in ast.ts. Not a diagnostic: this
      // stage doesn't judge what's "supported", that's a later chunk's call.
      return {
        node: { type: "unknown", originalType: raw.type, raw: rawText(raw, source), loc: span },
        consumedEnd: span.end,
      };
  }
}

/**
 * Maps one `@unified-latex` content list (a root's, an environment's, a
 * group's, an argument's, ...) to ours, threading the position-recovery
 * cursor through it. `initialCursor` seeds the span of a position-less first
 * element; every other node determines the next element's seed from how far
 * it actually consumed the source (see `mapNode`'s doc comment on
 * `consumedEnd`), not merely its own `loc.end`.
 */
export function mapContentList(
  rawNodes: readonly Ast.Node[],
  file: string,
  source: string,
  initialCursor: SourceRef,
  diagnostics: Diagnostic[],
): { nodes: LatexNode[]; endCursor: SourceRef } {
  const out: LatexNode[] = [];
  let cursor = initialCursor;
  for (let i = 0; i < rawNodes.length; i++) {
    const raw = rawNodes[i]!;
    const span = resolveSpan(raw, file, cursor, rawNodes, i);
    checkMalformed(raw, rawNodes, i, file, diagnostics);
    const { node, consumedEnd } = mapNode(raw, file, source, span, diagnostics);
    out.push(node);
    cursor = consumedEnd;
  }
  return { nodes: out, endCursor: cursor };
}
