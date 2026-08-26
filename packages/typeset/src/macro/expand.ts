import type { CommandNode, LatexNode, SourceSpan, TextNode } from "../parse/index.ts";
import type { Diagnostic, SourceRef } from "../diagnostics.ts";
import { error, unsupported, warning } from "../diagnostics.ts";
import type { Budget } from "./budget.ts";
import { spend } from "./budget.ts";
import { DEFINITION_COMMANDS, FORMATTING_HOOKS, isKnownCommand } from "./builtins.ts";

/**
 * `\newcommand` expansion (brief 37, chunk 6).
 *
 * **The central mechanic, and why it is unusual.** The parser is stateless: it
 * only fills in `args` for commands in `@unified-latex`'s CTAN catalog, so a
 * user macro always arrives with `args: []` and the `{...}` written after it
 * arrives as a *sibling* `GroupNode`. Knowing that the group belongs to the
 * macro requires knowing the macro's arity, which requires having seen its
 * `\newcommand` — state the parser deliberately does not keep. So this module
 * walks the tree in document order, collects definitions as it meets them, and
 * consumes following siblings itself. `gatherArguments` is that step.
 *
 * **Expansion is a queue, not a recursion.** A macro's substituted body is
 * spliced back into the work list at the position the macro occupied and the
 * scan resumes there, exactly as TeX pushes tokens back onto its input. Two
 * things fall out of that: a macro whose body ends in another macro can still
 * pick up the arguments that follow it, and — the reason it matters here —
 * runaway recursion consumes *steps* rather than *stack*, so
 * `\newcommand{\x}{\x}` dies against the budget with a `budget-exceeded`
 * diagnostic instead of overflowing (D38).
 */

/** A body element, after `#n` has been recognised. */
type Substitution = { kind: "node"; node: LatexNode } | { kind: "param"; index: number };

export interface MacroDefinition {
  name: string;
  /** Total parameters, including the optional first one when there is one. */
  paramCount: number;
  /** The `[default]` of an optional first parameter, or `null` when there is none. */
  optionalDefault: LatexNode[] | null;
  body: LatexNode[];
  definedAt: SourceRef;
}

export interface ExpandContext {
  macros: Map<string, MacroDefinition>;
  diagnostics: Diagnostic[];
  budget: Budget;
}

export function createExpandContext(budget: Budget, diagnostics: Diagnostic[]): ExpandContext {
  return { macros: new Map(), diagnostics, budget };
}

/**
 * How deep the *source* may nest groups/environments before the walk gives up.
 * This bounds real recursion in this file (macro recursion does not recurse —
 * see the module comment), so a hostile document cannot overflow the stack.
 */
const MAX_NESTING = 200;

/**
 * Ceiling on how much unread material may be outstanding. The budget stops a
 * runaway macro by *time*; this stops it by *memory*, because
 * `\newcommand{\x}{\x\x}` doubles its output every pass and would otherwise
 * allocate for as long as the budget allows.
 */
const MAX_PENDING = 200_000;

/** Charged per expansion on top of the body's size, so a nullary loop still pays. */
const EXPANSION_COST = 8;

/**
 * Expand every user macro in `nodes`, in document order, returning a tree in
 * which no `\newcommand`-defined command remains. Definitions are collected as
 * the walk meets them, so a macro used before its `\newcommand` stays
 * unexpanded and is reported by the builder as an `undefined-command` — which
 * is what LaTeX does too.
 *
 * Macro scoping is **global**: a `\newcommand` inside a group or environment
 * outlives it. Real LaTeX scopes local definitions to their group; honouring
 * that would need a scope stack through a walk that is already the most
 * intricate thing in this chunk, for a pattern documents in scope do not use.
 */
export function expandMacros(nodes: readonly LatexNode[], ctx: ExpandContext): LatexNode[] {
  return expandList(nodes, ctx, 0);
}

function expandList(input: readonly LatexNode[], ctx: ExpandContext, depth: number): LatexNode[] {
  if (depth > MAX_NESTING) {
    reportStop(ctx, input[0]?.loc.start, `source nesting is deeper than ${MAX_NESTING} levels`);
    return input.slice();
  }
  const stream: Stream = { stack: [], rest: input, index: 0 };
  const out: LatexNode[] = [];
  for (;;) {
    if (!spend(ctx.budget)) {
      reportStop(ctx, peek(stream)?.loc.start);
      // Whatever is still unread is carried through unexpanded rather than
      // dropped: the compile has already failed, and a truncated tree would
      // turn one honest diagnostic into a cascade of invented ones.
      drain(stream, out);
      return out;
    }
    const node = take(stream);
    if (node === undefined) return out;
    if (node.type !== "command") {
      out.push(expandChildren(node, ctx, depth));
      continue;
    }
    if (DEFINITION_COMMANDS.has(node.name)) {
      readDefinition(node, ctx);
      continue;
    }
    const def = ctx.macros.get(node.name);
    if (def === undefined) {
      out.push(expandChildren(node, ctx, depth));
      continue;
    }
    const args = gatherArguments(node, stream, def, ctx);
    const replacement = substitute(def.body, args, def, ctx, 0);
    if (!spend(ctx.budget, EXPANSION_COST + replacement.length)) {
      reportStop(ctx, node.loc.start, `expanding \\${def.name}`);
      drain(stream, out);
      return out;
    }
    if (remaining(stream) + replacement.length > MAX_PENDING) {
      ctx.budget.stopped = true;
      reportStop(ctx, node.loc.start, `\\${def.name} expanded to more than ${MAX_PENDING} unread nodes`);
      drain(stream, out);
      return out;
    }
    // Pushed back rather than spliced: the replacement is itself expandable,
    // and a body ending in another macro must still see the siblings that
    // follow it. Pushback is also O(1), where splicing into a shared list is
    // O(n) and turns a doubling macro into quadratic work before the budget
    // ever notices.
    pushBack(stream, replacement);
  }
}

/**
 * TeX's input stack, in miniature: `stack` holds material pushed back by an
 * expansion (top at the end), `rest` is the original list still unread. Every
 * operation is O(1), which is what keeps a runaway macro cheap enough that the
 * step budget — not the clock — is what stops it.
 */
interface Stream {
  stack: LatexNode[];
  rest: readonly LatexNode[];
  index: number;
}

function take(s: Stream): LatexNode | undefined {
  if (s.stack.length > 0) return s.stack.pop();
  return s.index < s.rest.length ? s.rest[s.index++] : undefined;
}

function peek(s: Stream): LatexNode | undefined {
  if (s.stack.length > 0) return s.stack[s.stack.length - 1];
  return s.index < s.rest.length ? s.rest[s.index] : undefined;
}

function unread(s: Stream, node: LatexNode): void {
  s.stack.push(node);
}

function pushBack(s: Stream, nodes: readonly LatexNode[]): void {
  for (let i = nodes.length - 1; i >= 0; i--) s.stack.push(nodes[i]!);
}

function remaining(s: Stream): number {
  return s.stack.length + (s.rest.length - s.index);
}

function drain(s: Stream, out: LatexNode[]): void {
  for (;;) {
    const node = take(s);
    if (node === undefined) return;
    out.push(node);
  }
}

/** Take one node, logging it so a failed scan can put everything back. */
function takeLogged(s: Stream, log: LatexNode[]): LatexNode | undefined {
  const node = take(s);
  if (node !== undefined) log.push(node);
  return node;
}

/** Undo a scan: the log holds the originals, so the stream is restored exactly. */
function restore(s: Stream, log: readonly LatexNode[]): void {
  for (let i = log.length - 1; i >= 0; i--) s.stack.push(log[i]!);
}

/** Expand inside a node's arguments/body without treating the node itself as a macro. */
function expandChildren(node: LatexNode, ctx: ExpandContext, depth: number): LatexNode {
  switch (node.type) {
    case "command":
      if (node.args.length === 0) return node;
      return { ...node, args: node.args.map((a) => ({ ...a, content: expandList(a.content, ctx, depth + 1) })) };
    case "environment":
      return {
        ...node,
        args: node.args.map((a) => ({ ...a, content: expandList(a.content, ctx, depth + 1) })),
        body: expandList(node.body, ctx, depth + 1),
      };
    case "group":
      return { ...node, body: expandList(node.body, ctx, depth + 1) };
    case "math":
      return { ...node, body: expandList(node.body, ctx, depth + 1) };
    default:
      return node;
  }
}

function reportStop(ctx: ExpandContext, at: SourceRef | undefined, detail?: string): void {
  if (ctx.budget.reported) return;
  ctx.budget.reported = true;
  const where: SourceRef = at ?? { file: "", line: 0 };
  if (ctx.budget.cancelled) {
    ctx.diagnostics.push(error("budget-exceeded", where, "compilation was cancelled"));
    return;
  }
  const base = `macro expansion ran out of steps after ${ctx.budget.spent}`;
  ctx.diagnostics.push(
    error(
      "budget-exceeded",
      where,
      detail
        ? `${base} — ${detail}. A macro that expands to itself never terminates.`
        : `${base}. A macro that expands to itself never terminates.`,
    ),
  );
}

// --- reading a definition --------------------------------------------------

/**
 * Read `\newcommand{\x}[n][default]{body}`.
 *
 * The parser hands `\newcommand` six argument slots — star, an unused
 * alternate-form slot, the name, `[n]`, `[default]`, the body — but the
 * positions are read by *bracket kind* rather than by index, so a shape that
 * differs (or a source that omitted a slot) degrades into a diagnostic instead
 * of a wrong definition.
 */
function readDefinition(cmd: CommandNode, ctx: ExpandContext): void {
  const at = cmd.loc.start;
  const braces = cmd.args.filter((a) => a.bracket === "{");
  const brackets = cmd.args.filter((a) => a.bracket === "[");
  if (braces.length < 2) {
    ctx.diagnostics.push(
      error("syntax", at, `\\${cmd.name} needs a command name and a body, e.g. \\${cmd.name}{\\x}{...}`, `\\${cmd.name}`),
    );
    return;
  }
  const nameArg = braces[0]!;
  const bodyArg = braces[braces.length - 1]!;

  const named = nameArg.content.find((n) => n.type === "command");
  if (named === undefined || named.type !== "command") {
    ctx.diagnostics.push(
      error("syntax", at, `\\${cmd.name} expects a command name in its first argument, e.g. \\${cmd.name}{\\x}{...}`, `\\${cmd.name}`),
    );
    return;
  }
  const name = named.name;

  let paramCount = 0;
  if (brackets.length > 0) {
    const raw = plainText(brackets[0]!.content).trim();
    const parsed = /^[0-9]$/.test(raw) ? Number(raw) : NaN;
    if (Number.isNaN(parsed)) {
      ctx.diagnostics.push(
        error("syntax", at, `\\${cmd.name}{\\${name}}: argument count \`${raw}\` is not a digit 0–9`, `\\${cmd.name}`),
      );
      return;
    }
    paramCount = parsed;
  }
  const optionalDefault = brackets.length > 1 ? brackets[1]!.content : null;
  if (optionalDefault !== null && paramCount === 0) {
    ctx.diagnostics.push(
      error("syntax", at, `\\${cmd.name}{\\${name}}: a default value needs at least one parameter`, `\\${cmd.name}`),
    );
    return;
  }

  const already = ctx.macros.has(name);
  if (cmd.name === "newcommand" && (already || isKnownCommand(name))) {
    ctx.diagnostics.push(
      warning("syntax", at, `\\newcommand{\\${name}}: \\${name} is already defined — use \\renewcommand`, `\\${name}`),
    );
  } else if (cmd.name === "renewcommand" && !already && !isKnownCommand(name)) {
    ctx.diagnostics.push(
      warning("undefined-command", at, `\\renewcommand{\\${name}}: \\${name} was never defined`, `\\${name}`),
    );
  } else if (cmd.name === "providecommand" && (already || isKnownCommand(name))) {
    return; // \providecommand keeps the existing meaning.
  }

  if (FORMATTING_HOOKS.has(name)) {
    // Recorded anyway — but redefining it would otherwise change nothing at all
    // and produce quietly wrong numbering, which is the failure D38 forbids.
    ctx.diagnostics.push(
      unsupported(at, `\\${name}`, "this engine does not read counter or list-label formatting hooks"),
    );
  }

  ctx.macros.set(name, {
    name,
    paramCount,
    optionalDefault,
    body: bodyArg.content,
    definedAt: at,
  });
}

function plainText(nodes: readonly LatexNode[]): string {
  let s = "";
  for (const n of nodes) {
    if (n.type === "text") s += n.value;
    else if (n.type === "whitespace") s += " ";
  }
  return s;
}

// --- gathering arguments from siblings -------------------------------------

function gatherArguments(
  cmd: CommandNode,
  stream: Stream,
  def: MacroDefinition,
  ctx: ExpandContext,
): LatexNode[][] {
  /*
   * A macro that shadows a command the parser *does* have a signature for
   * (`\renewcommand{\emph}[1]{...}`) arrives with its arguments already
   * attached, and there is nothing to consume from the siblings. Filled slots
   * on the node therefore win over the sibling scan, in order.
   */
  const attached = cmd.args.filter((a) => a.bracket !== null);
  let taken = 0;
  const args: LatexNode[][] = [];
  let required = def.paramCount;

  if (def.optionalDefault !== null) {
    required -= 1;
    if (taken < attached.length && attached[taken]!.bracket === "[") {
      args.push(attached[taken]!.content);
      taken++;
    } else {
      const optional = scanOptional(stream);
      args.push(optional ?? def.optionalDefault);
    }
  }

  for (let k = 0; k < required; k++) {
    if (taken < attached.length) {
      args.push(attached[taken]!.content);
      taken++;
      continue;
    }
    const token = takeToken(stream);
    if (token === null) {
      ctx.diagnostics.push(
        error(
          "syntax",
          cmd.loc.start,
          `\\${def.name} takes ${def.paramCount} argument${def.paramCount === 1 ? "" : "s"} but only ${args.length} ${args.length === 1 ? "was" : "were"} given`,
          `\\${def.name}`,
        ),
      );
      args.push([]);
      continue;
    }
    args.push(token);
  }
  return args;
}

function retext(node: TextNode, value: string): TextNode {
  // Split pieces keep the whole original span. A character-accurate span would
  // mean re-deriving columns from a value the parser has already normalised;
  // the start is what diagnostics quote, and it is correct.
  return { type: "text", value, loc: node.loc };
}

/** Skip the spaces and comments LaTeX skips before an argument. */
function skipBlanks(stream: Stream, log: LatexNode[]): LatexNode | undefined {
  let node = takeLogged(stream, log);
  while (node !== undefined && (node.type === "whitespace" || node.type === "comment")) {
    node = takeLogged(stream, log);
  }
  return node;
}

/**
 * Consume `[...]`, if one is next.
 *
 * `[` and `]` are ordinary text to the parser (it has no signature telling it
 * otherwise), so this scans *characters* inside text nodes rather than looking
 * for a bracket node, and nesting is counted so `[a[b]c]` survives. Returns
 * `null` with the stream restored when there is no optional argument, so the
 * caller falls back to the default without having eaten a space.
 */
function scanOptional(stream: Stream): LatexNode[] | null {
  const log: LatexNode[] = [];
  const open = skipBlanks(stream, log);
  if (open === undefined || open.type !== "text" || !open.value.startsWith("[")) {
    restore(stream, log);
    return null;
  }

  const content: LatexNode[] = [];
  let depth = 0;
  let holder: TextNode = open;
  let text: string | null = open.value.slice(1);
  for (;;) {
    if (text === null) {
      const node = takeLogged(stream, log);
      if (node === undefined) break;
      if (node.type === "text") {
        holder = node;
        text = node.value;
        continue;
      }
      // A blank line cannot appear in an optional argument; treat the bracket
      // as ordinary text rather than swallowing a paragraph.
      if (node.type === "parbreak") break;
      content.push(node);
      continue;
    }
    let i = 0;
    let closer = -1;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === "[") depth++;
      else if (ch === "]") {
        if (depth === 0) {
          closer = i;
          break;
        }
        depth--;
      }
      i++;
    }
    if (closer >= 0) {
      if (closer > 0) content.push(retext(holder, text.slice(0, closer)));
      const rest = text.slice(closer + 1);
      if (rest.length > 0) unread(stream, retext(holder, rest));
      return content;
    }
    if (text.length > 0) content.push(retext(holder, text));
    text = null;
  }
  restore(stream, log);
  return null;
}

/**
 * Take one mandatory argument: a `{...}` group, or a single token. "A single
 * token" is why this splits text nodes — in `\x ab` with a one-argument `\x`,
 * LaTeX's argument is `a` and `b` is left behind, and the parser handed us
 * `"ab"` as one node.
 */
function takeToken(stream: Stream): LatexNode[] | null {
  const log: LatexNode[] = [];
  const node = skipBlanks(stream, log);
  if (node === undefined) {
    restore(stream, log);
    return null;
  }
  switch (node.type) {
    case "group":
      return node.body;
    case "parbreak":
      restore(stream, log);
      return null;
    case "text": {
      const code = node.value.codePointAt(0);
      if (code === undefined) return [];
      const first = String.fromCodePoint(code);
      const rest = node.value.slice(first.length);
      if (rest.length > 0) unread(stream, retext(node, rest));
      return [retext(node, first)];
    }
    default:
      return [node];
  }
}

// --- substituting #n into a body -------------------------------------------

/**
 * Replace `#1`…`#9` in a macro body with the gathered arguments.
 *
 * `#` and its digit arrive as two *adjacent text nodes* (`"#"` then `"1Y"`),
 * never as a placeholder node, so adjacent text is merged before scanning —
 * otherwise `#` and `1` would never be seen together. `##` is a literal `#`.
 */
function substitute(
  body: readonly LatexNode[],
  args: readonly LatexNode[][],
  def: MacroDefinition,
  ctx: ExpandContext,
  depth: number,
): LatexNode[] {
  if (depth > MAX_NESTING) return body.slice();
  const out: LatexNode[] = [];
  for (const node of mergeAdjacentText(body)) {
    if (!spend(ctx.budget)) return out;
    switch (node.type) {
      case "text": {
        for (const part of splitParameters(node, def, ctx)) {
          if (part.kind === "node") out.push(part.node);
          else for (const a of args[part.index] ?? []) out.push(a);
        }
        break;
      }
      case "group":
        out.push({ ...node, body: substitute(node.body, args, def, ctx, depth + 1) });
        break;
      case "math":
        out.push({ ...node, body: substitute(node.body, args, def, ctx, depth + 1) });
        break;
      case "environment":
        out.push({
          ...node,
          args: node.args.map((a) => ({ ...a, content: substitute(a.content, args, def, ctx, depth + 1) })),
          body: substitute(node.body, args, def, ctx, depth + 1),
        });
        break;
      case "command":
        out.push(
          node.args.length === 0
            ? node
            : {
                ...node,
                args: node.args.map((a) => ({ ...a, content: substitute(a.content, args, def, ctx, depth + 1) })),
              },
        );
        break;
      default:
        out.push(node);
    }
  }
  return out;
}

function splitParameters(node: TextNode, def: MacroDefinition, ctx: ExpandContext): Substitution[] {
  if (!node.value.includes("#")) return [{ kind: "node", node }];
  const parts: Substitution[] = [];
  let literal = "";
  const flush = (): void => {
    if (literal.length > 0) {
      parts.push({ kind: "node", node: retext(node, literal) });
      literal = "";
    }
  };
  for (let i = 0; i < node.value.length; i++) {
    const ch = node.value[i]!;
    if (ch !== "#") {
      literal += ch;
      continue;
    }
    const next = node.value[i + 1];
    if (next === "#") {
      literal += "#";
      i++;
      continue;
    }
    if (next !== undefined && next >= "1" && next <= "9") {
      const index = Number(next) - 1;
      if (index >= def.paramCount) {
        ctx.diagnostics.push(
          error(
            "syntax",
            def.definedAt,
            `\\${def.name} uses #${next} but was declared with ${def.paramCount} parameter${def.paramCount === 1 ? "" : "s"}`,
            `\\${def.name}`,
          ),
        );
      } else {
        flush();
        parts.push({ kind: "param", index });
      }
      i++;
      continue;
    }
    ctx.diagnostics.push(
      error("syntax", def.definedAt, `\\${def.name}: \`#\` must be followed by a digit 1–9 or by another \`#\``, `\\${def.name}`),
    );
    literal += "#";
  }
  flush();
  return parts;
}

/**
 * Join runs of adjacent text nodes. Needed because the parser splits on every
 * punctuation character it treats specially, so `#1`, `--` and `` `` `` all
 * arrive as several nodes and can only be recognised once rejoined.
 */
export function mergeAdjacentText(nodes: readonly LatexNode[]): LatexNode[] {
  const out: LatexNode[] = [];
  let pending: { value: string; loc: SourceSpan } | null = null;
  const flush = (): void => {
    if (pending !== null) {
      out.push({ type: "text", value: pending.value, loc: pending.loc });
      pending = null;
    }
  };
  for (const node of nodes) {
    if (node.type === "text") {
      pending =
        pending === null
          ? { value: node.value, loc: node.loc }
          : { value: pending.value + node.value, loc: { start: pending.loc.start, end: node.loc.end } };
      continue;
    }
    flush();
    out.push(node);
  }
  flush();
  return out;
}
