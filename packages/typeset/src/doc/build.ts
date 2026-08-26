import type { Argument, CommandNode, EnvironmentNode, LatexNode } from "../parse/index.ts";
import type { Diagnostic, SourceRef } from "../diagnostics.ts";
import { error, info, unsupported, warning, wholeFile } from "../diagnostics.ts";
import type { Budget } from "../macro/budget.ts";
import { spend } from "../macro/budget.ts";
import type { BuiltinSpec, SpecialId } from "../macro/builtins.ts";
import { lookupCommand, lookupEnvironment } from "../macro/builtins.ts";
import { mergeAdjacentText } from "../macro/expand.ts";
import type {
  Block,
  FontSelection,
  Inline,
  LabelInfo,
  ListItem,
  ListVariant,
  PackageUse,
  ParagraphBlock,
  ReferenceInline,
  TextStyle,
  TocEntry,
  FootnoteInline,
  HeadingLevel,
} from "./model.ts";
import {
  DEFAULT_TEXT_STYLE,
  HEADING_DEPTH,
  SECTION_NUMBER_DEPTH,
  UNRESOLVED_REFERENCE,
  cloneStyle,
  headingMarker,
  labelMarker,
} from "./model.ts";
import type { Counters } from "./counters.ts";
import {
  createCounters,
  enumCounter,
  enumReferenceText,
  formatEnumLabel,
  formatHeadingNumber,
  headingCounter,
  isNumbered,
  reset,
  step,
} from "./counters.ts";
import { scanTextRun } from "./text.ts";

/**
 * The document builder (brief 37, chunk 6): the expanded AST becomes blocks,
 * inlines, counters and labels.
 *
 * The loud-failure contract (D38) lives here. Every node kind reaches a branch
 * that either models it or produces a diagnostic naming it — there is no
 * `default: break` anywhere in this file that drops content, and adding one
 * would be a correctness bug rather than an omission.
 */

/** Packages the engine accepts. Everything else is a diagnostic, by design. */
const ALLOWED_PACKAGES: Readonly<Record<string, string | null>> = {
  // Read by chunk 7 for margins; the only package that changes any output.
  geometry: null,
  // Genuinely nothing to do: the engine is UTF-8 throughout and sets Latin
  // Modern regardless, so these declare what is already true.
  inputenc: "the engine always reads UTF-8",
  fontenc: "the engine always sets Latin Modern",
  lmodern: "the engine always sets Latin Modern",
  textcomp: "the engine always sets Latin Modern",
};

const MAX_NESTING = 200;
/** LaTeX's own ceilings: six lists deep in total, four of any one kind. */
const MAX_LIST_DEPTH = 6;
const MAX_VARIANT_DEPTH = 4;

interface BuildState {
  file: string;
  diagnostics: Diagnostic[];
  budget: Budget;
  counters: Counters;
  labels: Map<string, LabelInfo>;
  /**
   * LaTeX's `\@currentlabel`: what a `\label` written *now* would record. Set
   * by whatever last stepped a counter — a heading, a list item, a footnote.
   */
  currentLabel: string | null;
  /** Names the current label site for diagnostics ("section 2.1"). */
  currentLabelKind: string;
  toc: TocEntry[];
  footnotes: FootnoteInline[];
  /** Every `\ref`/`\pageref`, for the second pass. */
  references: ReferenceInline[];
  headings: number;
  title: Inline[] | null;
  author: Inline[] | null;
  date: Inline[] | null;
  packages: PackageUse[];
  documentClass: string | null;
  classOptions: string;
  listDepth: number;
  /** Per-variant nesting, tracked separately because LaTeX's labels are. */
  variantDepth: Record<ListVariant, number>;
}

export function createBuildState(file: string, diagnostics: Diagnostic[], budget: Budget): BuildState {
  return {
    file,
    diagnostics,
    budget,
    counters: createCounters(),
    labels: new Map(),
    currentLabel: null,
    currentLabelKind: "document",
    toc: [],
    footnotes: [],
    references: [],
    headings: 0,
    title: null,
    author: null,
    date: null,
    packages: [],
    documentClass: null,
    classOptions: "",
    listDepth: 0,
    variantDepth: { itemize: 0, enumerate: 0, description: 0 },
  };
}

export type { BuildState };

// --- the sink --------------------------------------------------------------

/**
 * Where a walk deposits what it produces. Paragraphs are accumulated rather
 * than returned so that a group (`{\bfseries a} b`) can contribute inlines to
 * the paragraph already in progress instead of starting a new one.
 */
interface Sink {
  blocks: Block[];
  para: Inline[];
  paraLoc: SourceRef | null;
  indent: boolean;
  style: TextStyle;
}

function createSink(style: TextStyle): Sink {
  return { blocks: [], para: [], paraLoc: null, indent: true, style: cloneStyle(style) };
}

function emit(sink: Sink, inline: Inline): void {
  if (sink.paraLoc === null) sink.paraLoc = inline.loc;
  sink.para.push(inline);
}

/** Inter-word space, but never leading and never doubled. */
function emitSpace(sink: Sink, loc: SourceRef): void {
  if (sink.para.length === 0) return;
  const last = sink.para[sink.para.length - 1]!;
  if (last.kind === "space" || last.kind === "linebreak") return;
  sink.para.push({ kind: "space", style: cloneStyle(sink.style), loc });
}

function flush(sink: Sink, indentNext = true): void {
  while (sink.para.length > 0 && sink.para[sink.para.length - 1]!.kind === "space") sink.para.pop();
  if (sink.para.length > 0) {
    const block: ParagraphBlock = {
      kind: "paragraph",
      content: sink.para,
      indent: sink.indent,
      loc: sink.paraLoc ?? { file: "", line: 0 },
    };
    sink.blocks.push(block);
  }
  sink.para = [];
  sink.paraLoc = null;
  sink.indent = indentNext;
}

function pushBlock(sink: Sink, block: Block, indentNext = true): void {
  flush(sink, indentNext);
  sink.blocks.push(block);
}

// --- entry points for a node list ------------------------------------------

export function walkBlocks(
  nodes: readonly LatexNode[],
  st: BuildState,
  style: TextStyle,
  depth = 0,
): Block[] {
  const sink = createSink(style);
  emitNodes(nodes, sink, st, depth);
  flush(sink);
  return sink.blocks;
}

/**
 * Walk a list that may only produce horizontal material — a heading's title, a
 * `\item`'s term, `\title`'s argument. Block content there is a real mistake in
 * the source, so it is reported rather than silently relocated.
 */
export function walkInlines(
  nodes: readonly LatexNode[],
  st: BuildState,
  style: TextStyle,
  where: string,
  depth = 0,
): Inline[] {
  const blocks = walkBlocks(nodes, st, style, depth);
  const out: Inline[] = [];
  for (const block of blocks) {
    if (block.kind === "paragraph") {
      if (out.length > 0) out.push({ kind: "space", style: cloneStyle(style), loc: block.loc });
      for (const inline of block.content) out.push(inline);
      continue;
    }
    if (block.kind === "marker") {
      out.push({ kind: "marker", name: block.name, loc: block.loc });
      continue;
    }
    st.diagnostics.push(
      error("syntax", block.loc, `a ${block.kind} cannot appear in ${where}`, where),
    );
  }
  return out;
}

// --- the walk ---------------------------------------------------------------

function emitNodes(nodes: readonly LatexNode[], sink: Sink, st: BuildState, depth: number): void {
  if (depth > MAX_NESTING) {
    reportStop(st, nodes[0]?.loc.start, `source nesting is deeper than ${MAX_NESTING} levels`);
    return;
  }
  let i = 0;
  while (i < nodes.length) {
    if (!spend(st.budget)) {
      reportStop(st, nodes[i]?.loc.start);
      return;
    }
    const node = nodes[i]!;
    switch (node.type) {
      case "text": {
        // Adjacent text nodes are one run: `--` and `` `` `` are split across
        // nodes by the parser and only mean anything rejoined.
        const chunks: { value: string; loc: SourceRef; at: number }[] = [];
        let value = "";
        while (i < nodes.length && nodes[i]!.type === "text") {
          const t = nodes[i] as Extract<LatexNode, { type: "text" }>;
          chunks.push({ value: t.value, loc: t.loc.start, at: value.length });
          value += t.value;
          i++;
        }
        const locAt = (offset: number): SourceRef => {
          let found = chunks[0]!.loc;
          for (const c of chunks) {
            if (c.at <= offset) found = c.loc;
            else break;
          }
          return found;
        };
        for (const seg of scanTextRun(value)) {
          if (seg.kind === "tie") emit(sink, { kind: "tie", style: cloneStyle(sink.style), loc: locAt(seg.offset) });
          else emit(sink, { kind: "text", text: seg.text, style: cloneStyle(sink.style), loc: locAt(seg.offset) });
        }
        continue;
      }
      case "whitespace":
        emitSpace(sink, node.loc.start);
        break;
      case "parbreak":
        flush(sink);
        break;
      case "comment":
        // A comment is not content; dropping it removes nothing from the
        // document, which is the one thing that separates it from a construct.
        break;
      case "escaped":
        emit(sink, { kind: "text", text: node.char, style: cloneStyle(sink.style), loc: node.loc.start });
        break;
      case "group": {
        const saved = cloneStyle(sink.style);
        emitNodes(node.body, sink, st, depth + 1);
        sink.style = saved;
        break;
      }
      case "math":
        st.diagnostics.push(
          unsupported(
            node.loc.start,
            node.display ? "\\[...\\]" : "$...$",
            "math typesetting is brief 40, a separate future brief",
          ),
        );
        break;
      case "command":
        /*
         * The environment name after an unpaired `\begin`/`\end` arrives as a
         * sibling group. Swallow it: it is the name, not content, and setting
         * the word "itemize" into the paragraph would be a worse outcome than
         * the diagnostic `applyCommand` is about to raise.
         */
        if ((node.name === "begin" || node.name === "end") && nodes[i + 1]?.type === "group") i++;
        applyCommand(node, sink, st, depth);
        break;
      case "environment":
        applyEnvironment(node, sink, st, depth);
        break;
      case "unknown":
        applyUnknown(node.originalType, node.raw, node.loc.start, sink, st);
        break;
    }
    i++;
  }
}

function applyUnknown(
  originalType: string,
  raw: string,
  at: SourceRef,
  sink: Sink,
  st: BuildState,
): void {
  if (originalType === "verbatim") {
    pushBlock(sink, { kind: "verbatim", lines: verbatimLines(raw), loc: at });
    return;
  }
  if (originalType === "verb") {
    const style: TextStyle = { font: { ...sink.style.font, family: "mono" }, underline: false };
    emit(sink, { kind: "text", text: raw, style, loc: at });
    return;
  }
  st.diagnostics.push(unsupported(at, originalType, "the parser produced a construct this engine has no model for"));
}

/** `verbatim` swallows the newline after `\begin` and before `\end`, as TeX does. */
function verbatimLines(raw: string): string[] {
  const lines = raw.split("\n");
  if (lines.length > 0 && lines[0] === "") lines.shift();
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// --- commands ---------------------------------------------------------------

function applyCommand(cmd: CommandNode, sink: Sink, st: BuildState, depth: number): void {
  const at = cmd.loc.start;
  const spec = lookupCommand(cmd.name);
  if (spec === undefined) {
    st.diagnostics.push(
      error(
        "undefined-command",
        at,
        `\\${cmd.name} is not defined — check the spelling, or define it with \\newcommand`,
        `\\${cmd.name}`,
      ),
    );
    return;
  }
  switch (spec.role) {
    case "unsupported":
      st.diagnostics.push(unsupported(at, `\\${cmd.name}`, spec.detail));
      return;
    case "symbol":
      if (spec.text === " ") emitSpace(sink, at);
      else emit(sink, { kind: "text", text: spec.text, style: cloneStyle(sink.style), loc: at });
      return;
    case "style-declaration":
      sink.style = applyFontDelta(sink.style, spec);
      return;
    case "text-style": {
      const arg = mandatoryArgument(cmd);
      if (arg === null) {
        st.diagnostics.push(error("syntax", at, `\\${cmd.name} needs an argument`, `\\${cmd.name}`));
        return;
      }
      const saved = cloneStyle(sink.style);
      sink.style = applyFontDelta(sink.style, spec);
      emitNodes(arg.content, sink, st, depth + 1);
      sink.style = saved;
      return;
    }
    case "section":
      applySection(cmd, spec.level, sink, st, depth);
      return;
    case "special":
      applySpecial(spec.id, cmd, sink, st, depth);
      return;
  }
}

function applyFontDelta(
  style: TextStyle,
  spec: Extract<BuiltinSpec, { role: "text-style" | "style-declaration" }>,
): TextStyle {
  if (spec.role === "style-declaration" && spec.reset === true) return cloneStyle(DEFAULT_TEXT_STYLE);
  const font: FontSelection = { ...style.font, ...(spec.font ?? {}) };
  if (spec.emph === true) {
    // `\emph` toggles rather than sets: emphasis inside emphasis goes back to
    // upright, which is the whole reason LaTeX has it as well as `\textit`.
    font.slant = style.font.slant === "italic" ? "upright" : "italic";
  }
  const underline = style.underline || (spec.role === "text-style" && spec.underline === true);
  return { font, underline };
}

function applySection(
  cmd: CommandNode,
  level: HeadingLevel,
  sink: Sink,
  st: BuildState,
  depth: number,
): void {
  const at = cmd.loc.start;
  const titleArg = mandatoryArgument(cmd);
  if (titleArg === null) {
    st.diagnostics.push(error("syntax", at, `\\${cmd.name} needs a title argument`, `\\${cmd.name}`));
    return;
  }
  if (cmd.args.some((a) => a.bracket === "[")) {
    st.diagnostics.push(
      unsupported(at, `\\${cmd.name}[...]`, "a separate short title for the table of contents is not implemented"),
    );
  }
  const starred = isStarred(cmd);
  const numbered = !starred && isNumbered(level);
  let number: string | null = null;
  if (numbered) {
    step(st.counters, headingCounter(level));
    number = formatHeadingNumber(st.counters, level);
    st.currentLabel = number;
    st.currentLabelKind = cmd.name;
  }
  const marker = headingMarker(st.headings);
  st.headings += 1;
  // Headings are set bold in `article`; the *size* is chunk 7's to choose, but
  // the face belongs here so `\emph` inside a title toggles from the right base.
  const title = walkInlines(titleArg.content, st, boldStyle(), `\\${cmd.name}`, depth + 1);
  pushBlock(sink, { kind: "heading", level, number, title, marker, loc: at }, false);
  // `tocdepth` matches `secnumdepth` in `article`, and a `*` form is listed by
  // neither — so the ToC entry rides on exactly the numbering condition.
  if (!starred && HEADING_DEPTH[level] <= SECTION_NUMBER_DEPTH) {
    st.toc.push({ level, number, title, marker });
  }
}

function applySpecial(id: SpecialId, cmd: CommandNode, sink: Sink, st: BuildState, depth: number): void {
  const at = cmd.loc.start;
  switch (id) {
    case "ignore":
      return;
    case "documentclass":
      st.diagnostics.push(
        error("syntax", at, "\\documentclass belongs in the preamble, before \\begin{document}", "\\documentclass"),
      );
      return;
    case "usepackage":
      st.diagnostics.push(
        error("syntax", at, "\\usepackage belongs in the preamble, before \\begin{document}", "\\usepackage"),
      );
      return;
    case "title":
    case "author":
    case "date": {
      const arg = mandatoryArgument(cmd);
      if (arg === null) {
        st.diagnostics.push(error("syntax", at, `\\${cmd.name} needs an argument`, `\\${cmd.name}`));
        return;
      }
      const value = walkInlines(arg.content, st, DEFAULT_TEXT_STYLE, `\\${cmd.name}`, depth + 1);
      if (id === "title") st.title = value;
      else if (id === "author") st.author = value;
      else st.date = value;
      return;
    }
    case "maketitle": {
      if (st.title === null) {
        st.diagnostics.push(
          warning("syntax", at, "\\maketitle with no \\title — the title block will be empty", "\\maketitle"),
        );
      }
      if (st.date === null) {
        // The engine performs no I/O and therefore has no clock (D38), so it
        // cannot supply LaTeX's default of "today". Warning, not error: the
        // document still sets correctly, it just carries no date.
        st.diagnostics.push(
          warning(
            "unsupported",
            at,
            "no \\date was given and this engine has no clock, so no date is printed",
            "\\maketitle",
          ),
        );
      }
      pushBlock(sink, {
        kind: "title",
        title: st.title ?? [],
        author: st.author ?? [],
        date: st.date,
        loc: at,
      }, false);
      return;
    }
    case "tableofcontents":
      pushBlock(sink, { kind: "toc", loc: at });
      return;
    case "label": {
      const arg = mandatoryArgument(cmd);
      if (arg === null) {
        st.diagnostics.push(error("syntax", at, "\\label needs a key", "\\label"));
        return;
      }
      const key = plainText(arg.content).trim();
      if (key.length === 0) {
        st.diagnostics.push(error("syntax", at, "\\label needs a non-empty key", "\\label"));
        return;
      }
      if (st.labels.has(key)) {
        st.diagnostics.push(
          error("duplicate-label", at, `\\label{${key}} was already defined; the first definition wins`, "\\label"),
        );
        return;
      }
      if (st.currentLabel === null) {
        // A label with nothing to refer to would resolve to an empty string and
        // print as a blank in the reader's document — silent wrongness.
        st.diagnostics.push(
          warning(
            "undefined-reference",
            at,
            `\\label{${key}} is not inside anything numbered, so \\ref{${key}} has no number to print`,
            "\\label",
          ),
        );
      }
      const marker = labelMarker(key);
      st.labels.set(key, { key, text: st.currentLabel ?? UNRESOLVED_REFERENCE, marker, loc: at });
      if (sink.para.length > 0) emit(sink, { kind: "marker", name: marker, loc: at });
      else pushBlock(sink, { kind: "marker", name: marker, loc: at }, sink.indent);
      return;
    }
    case "ref":
    case "pageref": {
      const arg = mandatoryArgument(cmd);
      if (arg === null) {
        st.diagnostics.push(error("syntax", at, `\\${cmd.name} needs a key`, `\\${cmd.name}`));
        return;
      }
      const key = plainText(arg.content).trim();
      const reference: ReferenceInline = {
        kind: "reference",
        refKind: id,
        key,
        text: UNRESOLVED_REFERENCE,
        style: cloneStyle(sink.style),
        loc: at,
      };
      st.references.push(reference);
      emit(sink, reference);
      return;
    }
    case "footnote": {
      const arg = mandatoryArgument(cmd);
      if (arg === null) {
        st.diagnostics.push(error("syntax", at, "\\footnote needs its text", "\\footnote"));
        return;
      }
      const number = step(st.counters, "footnote");
      const label = String(number);
      const savedLabel = st.currentLabel;
      const savedKind = st.currentLabelKind;
      st.currentLabel = label;
      st.currentLabelKind = "footnote";
      const content = walkBlocks(arg.content, st, DEFAULT_TEXT_STYLE, depth + 1);
      st.currentLabel = savedLabel;
      st.currentLabelKind = savedKind;
      const footnote: FootnoteInline = {
        kind: "footnote",
        number,
        label,
        content,
        style: cloneStyle(sink.style),
        loc: at,
      };
      st.footnotes.push(footnote);
      emit(sink, footnote);
      return;
    }
    case "item":
      st.diagnostics.push(
        error("syntax", at, "\\item appears outside itemize, enumerate or description", "\\item"),
      );
      return;
    case "linebreak":
      if (cmd.args.some((a) => a.bracket === "[")) {
        st.diagnostics.push(
          unsupported(at, "\\\\[...]", "extra vertical space on a line break is not implemented"),
        );
      }
      emit(sink, { kind: "linebreak", loc: at });
      return;
    case "pagebreak":
      pushBlock(sink, { kind: "pagebreak", loc: at });
      return;
    case "noindent":
      if (sink.para.length === 0) sink.indent = false;
      return;
    case "today":
      st.diagnostics.push(
        warning("unsupported", at, "this engine performs no I/O and has no clock, so \\today prints nothing", "\\today"),
      );
      return;
    case "input":
      st.diagnostics.push(
        unsupported(
          at,
          `\\${cmd.name}`,
          "\\input must be written literally in the source; one produced by a macro is not resolved",
        ),
      );
      return;
    case "verb":
      st.diagnostics.push(unsupported(at, "\\verb", "this form of \\verb was not recognised by the parser"));
      return;
    case "stray-environment":
      st.diagnostics.push(
        error(
          "syntax",
          at,
          `\\${cmd.name} could not be paired with its partner, so the environment it names is not set`,
          `\\${cmd.name}`,
        ),
      );
      return;
  }
}

// --- environments -----------------------------------------------------------

function applyEnvironment(env: EnvironmentNode, sink: Sink, st: BuildState, depth: number): void {
  const at = env.loc.start;
  const spec = lookupEnvironment(env.name);
  if (spec === undefined) {
    st.diagnostics.push(
      error(
        "undefined-environment",
        at,
        `the environment \`${env.name}\` is not defined — check the spelling`,
        env.name,
      ),
    );
    return;
  }
  if (spec.role === "unsupported") {
    st.diagnostics.push(unsupported(at, env.name, spec.detail));
    return;
  }
  if (spec.role === "list") {
    applyList(env, spec.variant, sink, st, depth);
    return;
  }
  switch (spec.id) {
    case "document": {
      // A nested `document` is malformed, but its content is still content.
      const saved = cloneStyle(sink.style);
      emitNodes(env.body, sink, st, depth + 1);
      sink.style = saved;
      return;
    }
    case "abstract":
      pushBlock(
        sink,
        { kind: "abstract", content: walkBlocks(env.body, st, DEFAULT_TEXT_STYLE, depth + 1), loc: at },
        false,
      );
      return;
    case "verbatim":
      pushBlock(sink, { kind: "verbatim", lines: verbatimLines(plainText(env.body)), loc: at });
      return;
  }
}

function applyList(
  env: EnvironmentNode,
  variant: ListVariant,
  sink: Sink,
  st: BuildState,
  depth: number,
): void {
  const at = env.loc.start;
  const listDepth = st.listDepth + 1;
  const variantDepth = st.variantDepth[variant] + 1;
  if (listDepth > MAX_LIST_DEPTH || variantDepth > MAX_VARIANT_DEPTH) {
    st.diagnostics.push(
      error(
        "syntax",
        at,
        `lists may nest ${MAX_LIST_DEPTH} deep and ${MAX_VARIANT_DEPTH} deep in one kind; this \`${env.name}\` is ${listDepth} and ${variantDepth}`,
        env.name,
      ),
    );
    return;
  }
  if (env.args.some((a) => a.bracket === "[")) {
    st.diagnostics.push(unsupported(at, `${env.name}[...]`, "list options are not implemented"));
  }
  if (variant === "enumerate") reset(st.counters, enumCounter(variantDepth));

  const savedDepth = st.listDepth;
  const savedVariantDepth = st.variantDepth[variant];
  st.listDepth = listDepth;
  st.variantDepth[variant] = variantDepth;
  const items: ListItem[] = [];
  for (const node of env.body) {
    if (!spend(st.budget)) {
      reportStop(st, node.loc.start);
      break;
    }
    if (node.type === "whitespace" || node.type === "parbreak" || node.type === "comment") continue;
    if (node.type === "command" && node.name === "item") {
      items.push(buildItem(node, variant, variantDepth, st, depth + 1));
      continue;
    }
    /*
     * `\item`'s argument parser gobbles everything up to the next `\item` or
     * `\end`, so anything still sitting directly in the body is material
     * written *before* the first `\item` — which LaTeX rejects outright.
     */
    st.diagnostics.push(
      error("syntax", node.loc.start, `content in \`${env.name}\` before the first \\item`, env.name),
    );
  }
  st.listDepth = savedDepth;
  st.variantDepth[variant] = savedVariantDepth;

  if (items.length === 0) {
    st.diagnostics.push(warning("syntax", at, `\`${env.name}\` has no \\item`, env.name));
    return;
  }
  pushBlock(sink, { kind: "list", variant, depth: listDepth, variantDepth, items, loc: at });
}

function buildItem(
  cmd: CommandNode,
  variant: ListVariant,
  variantDepth: number,
  st: BuildState,
  depth: number,
): ListItem {
  const at = cmd.loc.start;
  const optional = cmd.args.find((a) => a.bracket === "[");
  // The body is the trailing gobbled slot: `\item`'s signature swallows
  // everything up to the next `\item`/`\end`, nested environments included.
  const last = cmd.args.length > 0 ? cmd.args[cmd.args.length - 1]! : undefined;
  const bodyNodes = last !== undefined && last.bracket === null ? last.content : [];

  let label: Inline[] | null = null;
  if (variant === "enumerate") {
    const value = step(st.counters, enumCounter(variantDepth));
    st.currentLabel = enumReferenceText(st.counters, variantDepth);
    st.currentLabelKind = "item";
    label = [
      {
        kind: "text",
        text: formatEnumLabel(variantDepth, value),
        style: cloneStyle(DEFAULT_TEXT_STYLE),
        loc: at,
      },
    ];
    if (optional !== undefined) {
      st.diagnostics.push(
        unsupported(at, "\\item[...]", "a custom label on an enumerate item would break its numbering"),
      );
    }
  } else if (optional !== undefined) {
    label = walkInlines(optional.content, st, boldStyle(), "\\item[...]", depth + 1);
  } else if (variant === "description") {
    st.diagnostics.push(
      warning("syntax", at, "a description item with no \\item[term] has nothing to label it", "\\item"),
    );
  }

  return { label, content: walkBlocks(bodyNodes, st, DEFAULT_TEXT_STYLE, depth + 1), loc: at };
}

function boldStyle(): TextStyle {
  return { font: { ...DEFAULT_TEXT_STYLE.font, weight: "bold" }, underline: false };
}

// --- the preamble -----------------------------------------------------------

/**
 * Read `\documentclass` and `\usepackage` from the preamble. Everything else
 * there is walked as ordinary content so that `\title` and friends are seen —
 * anything that produces *typeset* material in the preamble is a mistake, and
 * `walkBlocks` reports it as one on the way past.
 */
export function readPreamble(nodes: readonly LatexNode[], st: BuildState): LatexNode[] {
  const rest: LatexNode[] = [];
  for (const node of nodes) {
    if (!spend(st.budget)) {
      reportStop(st, node.loc.start);
      break;
    }
    if (node.type !== "command") {
      rest.push(node);
      continue;
    }
    if (node.name === "documentclass") {
      readDocumentClass(node, st);
      continue;
    }
    if (node.name === "usepackage" || node.name === "RequirePackage") {
      readPackage(node, st);
      continue;
    }
    rest.push(node);
  }
  return rest;
}

function readDocumentClass(cmd: CommandNode, st: BuildState): void {
  const at = cmd.loc.start;
  const arg = mandatoryArgument(cmd);
  const name = arg === null ? "" : plainText(arg.content).trim();
  const options = cmd.args.find((a) => a.bracket === "[");
  st.classOptions = options === undefined ? "" : plainText(options.content).trim();
  if (st.documentClass !== null) {
    st.diagnostics.push(error("syntax", at, "a document has only one \\documentclass", "\\documentclass"));
    return;
  }
  st.documentClass = name;
  if (name !== "article") {
    st.diagnostics.push(
      unsupported(at, `\\documentclass{${name}}`, "only the article class is implemented"),
    );
  }
}

function readPackage(cmd: CommandNode, st: BuildState): void {
  const at = cmd.loc.start;
  const arg = mandatoryArgument(cmd);
  if (arg === null) {
    st.diagnostics.push(error("syntax", at, "\\usepackage needs a package name", "\\usepackage"));
    return;
  }
  const optionsArg = cmd.args.find((a) => a.bracket === "[");
  const options = optionsArg === undefined ? "" : plainText(optionsArg.content).trim();
  for (const raw of plainText(arg.content).split(",")) {
    const name = raw.trim();
    if (name.length === 0) continue;
    if (!Object.prototype.hasOwnProperty.call(ALLOWED_PACKAGES, name)) {
      st.diagnostics.push(
        unsupported(
          at,
          `\\usepackage{${name}}`,
          "the engine implements no .sty files; only geometry, inputenc, fontenc, lmodern and textcomp are accepted",
        ),
      );
      continue;
    }
    const noop = ALLOWED_PACKAGES[name];
    if (noop !== null && noop !== undefined) {
      st.diagnostics.push(info("unsupported", at, `\\usepackage{${name}} has no effect — ${noop}`, `\\usepackage{${name}}`));
    }
    st.packages.push({ name, options, loc: at });
  }
}

// --- shared helpers ---------------------------------------------------------

/** The last brace-delimited argument the parser filled in — a command's "the" argument. */
function mandatoryArgument(cmd: CommandNode): Argument | null {
  for (let i = cmd.args.length - 1; i >= 0; i--) {
    const arg = cmd.args[i]!;
    if (arg.bracket === "{") return arg;
  }
  return null;
}

/**
 * The `*` of a `*` variant. The parser reports it as an unbracketed slot
 * holding the single character, not as part of the command's name.
 */
function isStarred(cmd: CommandNode): boolean {
  const first = cmd.args[0];
  if (first === undefined || first.bracket !== null) return false;
  return first.content.length === 1 && first.content[0]!.type === "text" && first.content[0]!.value === "*";
}

/** Flatten a node list to the characters it contributes — keys, class names, verbatim. */
export function plainText(nodes: readonly LatexNode[]): string {
  let out = "";
  for (const node of mergeAdjacentText(nodes)) {
    switch (node.type) {
      case "text":
        out += node.value;
        break;
      case "whitespace":
        out += " ";
        break;
      case "escaped":
        out += node.char;
        break;
      case "parbreak":
        out += "\n";
        break;
      case "group":
        out += plainText(node.body);
        break;
      default:
        break;
    }
  }
  return out;
}

function reportStop(st: BuildState, at: SourceRef | undefined, detail?: string): void {
  if (st.budget.reported) return;
  st.budget.reported = true;
  const where = at ?? wholeFile(st.file);
  if (st.budget.cancelled) {
    st.diagnostics.push(error("budget-exceeded", where, "compilation was cancelled"));
    return;
  }
  const base = `building the document ran out of steps after ${st.budget.spent}`;
  st.diagnostics.push(error("budget-exceeded", where, detail ? `${base} — ${detail}` : base));
}
