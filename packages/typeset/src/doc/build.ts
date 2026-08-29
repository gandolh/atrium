import type { Argument, CommandNode, EnvironmentNode, GroupNode, LatexNode, MathNode } from "../parse/index.ts";
import type { Diagnostic, SourceRef } from "../diagnostics.ts";
import { error, info, unsupported, warning, wholeFile } from "../diagnostics.ts";
import type { Budget } from "../macro/budget.ts";
import { spend } from "../macro/budget.ts";
import type { BuiltinSpec, SpecialId } from "../macro/builtins.ts";
import {
  DECLINED_MATH_COMMANDS,
  DECLINED_MATH_ENVIRONMENTS,
  lookupCommand,
  lookupEnvironment,
} from "../macro/builtins.ts";
import { mergeAdjacentText } from "../macro/expand.ts";
import type {
  BibItem,
  BibliographyBlock,
  Block,
  CitationInline,
  CitationStyle,
  DisplayMathVariant,
  DocumentLength,
  FloatClass,
  FloatListEntry,
  FloatPlacement,
  FloatPlacementLetter,
  FontSelection,
  ImageSizing,
  Inline,
  LabelInfo,
  LengthRegister,
  ListItem,
  ListVariant,
  MathLine,
  PackageUse,
  ParagraphBlock,
  ReferenceInline,
  TableCell,
  TableColumn,
  TableColumnSpec,
  TableRow,
  TableRule,
  TextStyle,
  TocEntry,
  FootnoteInline,
  HeadingLevel,
} from "./model.ts";
import {
  DEFAULT_FLOAT_PLACEMENT,
  DEFAULT_TEXT_STYLE,
  HEADING_DEPTH,
  SECTION_NUMBER_DEPTH,
  UNRESOLVED_CITATION,
  UNRESOLVED_REFERENCE,
  captionMarker,
  cloneStyle,
  equationMarker,
  headingMarker,
  isMultiLineDisplay,
  isNumberedDisplay,
  labelMarker,
} from "./model.ts";
import type { Counters } from "./counters.ts";
import {
  createCounters,
  enumCounter,
  enumReferenceText,
  floatCounter,
  formatEnumLabel,
  formatEquationNumber,
  formatFloatNumber,
  formatHeadingNumber,
  headingCounter,
  isNumbered,
  reset,
  step,
} from "./counters.ts";
import { IMPLEMENTED_BIB_STYLE } from "./bib.ts";
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
  classLoc: SourceRef | null;
  listDepth: number;
  /** Per-variant nesting, tracked separately because LaTeX's labels are. */
  variantDepth: Record<ListVariant, number>;
  /**
   * The float being walked, or null outside one (brief 39). `\caption` reads
   * this to know which counter to step and which `\listof...` to join, and
   * refuses outright when it is null — a caption with no float has no number,
   * and printing it unnumbered would be silently wrong output.
   */
  float: { floatClass: FloatClass; construct: string } | null;
  /** Every `\caption`, in document order, for `\listoffigures`/`\listoftables`. */
  floatList: FloatListEntry[];
  /** How many captions have been built, so each gets its own marker name. */
  captions: number;
  /**
   * How many *numbered equation lines* have been built, so each gets its own
   * marker name. Not the same as `counters.equation`: they agree today, and
   * would stop agreeing the moment anything resets the counter (`\numberwithin`
   * is a diagnostic, but a marker name must be unique whatever the number is).
   */
  equations: number;
  /** Every `\cite`/`\citep`/`\citet`/`\nocite`, for the bibliography pass. */
  citations: CitationInline[];
  /**
   * Every `\bibliography` and `thebibliography` block, kept by reference so
   * `doc/index.ts` can fill in `content` once the whole document is walked and
   * every cited key is therefore known.
   */
  bibliographies: BibliographyBlock[];
  /** `\bibliographystyle`'s argument, wherever in the document it was written. */
  bibliographyStyle: string | null;
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
    classLoc: null,
    listDepth: 0,
    variantDepth: { itemize: 0, enumerate: 0, description: 0 },
    float: null,
    floatList: [],
    captions: 0,
    equations: 0,
    citations: [],
    bibliographies: [],
    bibliographyStyle: null,
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
        applyMath(node, sink, st, depth);
        break;
      case "command": {
        /*
         * The environment name after an unpaired `\begin`/`\end` arrives as a
         * sibling group. Swallow it: it is the name, not content, and setting
         * the word "itemize" into the paragraph would be a worse outcome than
         * the diagnostic `applyCommand` is about to raise.
         */
        if ((node.name === "begin" || node.name === "end") && nodes[i + 1]?.type === "group") i++;
        /*
         * Two of brief 39's commands have an argument the parser leaves as a
         * *sibling* group — the biggest surprise in `@unified-latex`'s output,
         * documented on `CommandNode` in `ast.ts`. Adopt it here, where the
         * siblings are in scope, rather than in `applySpecial`, which only ever
         * sees one node. Without this the argument would be typeset as ordinary
         * text and the construct would quietly lose it.
         */
        const adopted = adoptSiblingGroup(nodes, i, st);
        if (adopted !== null) {
          applyCommand(adopted.cmd, sink, st, depth);
          i += adopted.consumed + 1;
          continue;
        }
        applyCommand(node, sink, st, depth);
        break;
      }
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
    case "math-only":
      // Implemented — inside math. This arm is only ever reached by a math
      // command written in text mode, where real LaTeX says "Missing $
      // inserted" and this engine says which mode the command belongs to.
      st.diagnostics.push(unsupported(at, `\\${cmd.name}`, MATH_ONLY_DETAIL));
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
    case "listoffigures":
    case "listoftables":
      // Collected exactly the way `\tableofcontents` is: the entries are
      // gathered as the captions are built, whether or not anything asked for
      // the list, and the block only says where to set them.
      pushBlock(sink, { kind: "listof", floatClass: id === "listoffigures" ? "figure" : "table", loc: at });
      return;
    case "caption":
      applyCaption(cmd, sink, st, depth);
      return;
    case "includegraphics":
      applyIncludeGraphics(cmd, sink, st);
      return;
    case "cite":
    case "citep":
    case "citet":
    case "nocite":
      applyCitation(id, cmd, sink, st);
      return;
    case "bibliography":
      applyBibliographyCommand(cmd, sink, st);
      return;
    case "bibliographystyle": {
      const arg = mandatoryArgument(cmd);
      const style = arg === null ? "" : plainText(arg.content).trim();
      if (style.length === 0) {
        st.diagnostics.push(
          error("syntax", at, "\\bibliographystyle needs a style name, e.g. \\bibliographystyle{plain}", "\\bibliographystyle"),
        );
      } else {
        st.bibliographyStyle = style;
      }
      if (style.length > 0 && style !== IMPLEMENTED_BIB_STYLE) {
        st.diagnostics.push(
          unsupported(
            at,
            `\\bibliographystyle{${style}}`,
            `only the numeric \`${IMPLEMENTED_BIB_STYLE}\` style is implemented; author-year styles and .bst files are out of scope`,
          ),
        );
        return;
      }
      return;
    }
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
    // `\input`/`\include` have no case here — see the comment on their
    // (removed) rows in `macro/builtins.ts` for why: `doc/index.ts`'s
    // `resolveInputs()` consumes every literal one before this function ever
    // runs, so a case here could never fire.
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
  if (spec.role === "float") {
    applyFloat(env, spec.class, spec.spanning, sink, st, depth);
    return;
  }
  if (spec.role === "display-math") {
    applyDisplayMath(env, spec.variant, sink, st, depth);
    return;
  }
  if (spec.role === "math-only") {
    st.diagnostics.push(unsupported(at, env.name, MATH_ONLY_DETAIL));
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
    case "tabular":
      applyTabular(env, sink, st, depth);
      return;
    case "thebibliography":
      applyThebibliography(env, sink, st, depth);
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

// --- brief 39: floats, captions, images, tables, bibliography ---------------

/*
 * Everything below this line is brief 39's *syntax* half (chunk 39.1): the
 * constructs are parsed, validated, numbered and put into the document model,
 * and the four capabilities they need — image decode, column measurement, float
 * placement, bibliography formatting — are seams elsewhere (`src/image/`,
 * `layout/table.ts`, `layout/float.ts`, `doc/bib.ts`).
 *
 * **No interim notices remain.** Every one of brief 39's five chunks carried a
 * temporary loud-failure diagnostic here or at its own seam while its
 * capability was missing — image decode and placement (39.2), column
 * measurement and grid setting (39.3), float placement (39.4) and bibliography
 * formatting (39.5) — and every one of them has landed. The last to go was
 * `NOTICE-39.4`, on a `\caption` written outside any float: that case is not an
 * unimplemented capability and never will be one, it is an authoring error, so
 * the plain `syntax` error in `applyCaption` is now the whole story.
 */

/**
 * `\caption`, which only means anything inside a float: its number comes from
 * the float's class, and its setting is part of setting the float.
 *
 * The number is assigned *before* the caption's text is walked, exactly as
 * `applySection` does it, so a `\label` written inside the caption's own
 * argument records the caption's number rather than whatever came before.
 */
function applyCaption(cmd: CommandNode, sink: Sink, st: BuildState, depth: number): void {
  const at = cmd.loc.start;
  const float = st.float;
  if (float === null) {
    st.diagnostics.push(
      error(
        "syntax",
        at,
        "\\caption is only allowed inside a figure or table environment; there is no float here for it to number",
        "\\caption",
      ),
    );
    return;
  }
  const arg = mandatoryArgument(cmd);
  if (arg === null) {
    st.diagnostics.push(error("syntax", at, "\\caption needs its text", "\\caption"));
    return;
  }
  if (cmd.args.some((a) => a.bracket === "[")) {
    st.diagnostics.push(
      unsupported(
        at,
        "\\caption[...]",
        "a separate short caption for the list of figures or tables is not implemented",
      ),
    );
  }
  step(st.counters, floatCounter(float.floatClass));
  const number = formatFloatNumber(st.counters, float.floatClass);
  st.currentLabel = number;
  st.currentLabelKind = float.floatClass;
  const marker = captionMarker(st.captions);
  st.captions += 1;
  const content = walkInlines(arg.content, st, DEFAULT_TEXT_STYLE, "\\caption", depth + 1);
  // The very same array the caption sets, not a copy — the sharing `TocEntry`
  // relies on, so a `\ref` inside a caption resolves in both places at once.
  // Layout must drop occurrence-only inlines when it re-sets it; see `tocTitle`
  // in `layout/vlist.ts` for the bug that rule exists to prevent.
  st.floatList.push({ floatClass: float.floatClass, number, title: content, marker });
  pushBlock(sink, { kind: "caption", floatClass: float.floatClass, number, content, marker, loc: at });
}

/** `figure`, `figure*`, `table`, `table*`. */
function applyFloat(
  env: EnvironmentNode,
  floatClass: FloatClass,
  spanning: boolean,
  sink: Sink,
  st: BuildState,
  depth: number,
): void {
  const at = env.loc.start;
  if (st.float !== null) {
    // LaTeX refuses this outright ("Not in outer par mode"), and the inner
    // float's caption would take a number that no page could ever show.
    st.diagnostics.push(
      error(
        "syntax",
        at,
        `a \`${env.name}\` cannot be nested inside a \`${st.float.construct}\`; LaTeX floats do not nest`,
        env.name,
      ),
    );
  }
  const placement = readFloatPlacement(env, st);
  const saved = st.float;
  st.float = { floatClass, construct: env.name };
  const content = walkBlocks(env.body, st, DEFAULT_TEXT_STYLE, depth + 1);
  st.float = saved;
  if (content.length === 0) {
    st.diagnostics.push(warning("syntax", at, `\`${env.name}\` is empty, so it sets nothing`, env.name));
  }
  pushBlock(sink, {
    kind: "float",
    floatClass,
    construct: env.name,
    spanning,
    placement,
    content,
    loc: at,
  });
}

/** `[htbp]`, `[!ht]`, or nothing at all — in which case the class default applies. */
function readFloatPlacement(env: EnvironmentNode, st: BuildState): FloatPlacement {
  const at = env.loc.start;
  const arg = env.args.find((a) => a.bracket === "[");
  if (arg === undefined) return { ...DEFAULT_FLOAT_PLACEMENT, letters: [...DEFAULT_FLOAT_PLACEMENT.letters] };

  const letters: FloatPlacementLetter[] = [];
  let override = false;
  for (const char of plainText(arg.content)) {
    if (char === " " || char === "\t" || char === "\n") continue;
    if (char === "!") {
      override = true;
      continue;
    }
    if (char === "h" || char === "t" || char === "b" || char === "p") {
      if (!letters.includes(char)) letters.push(char);
      continue;
    }
    if (char === "H") {
      st.diagnostics.push(
        unsupported(
          at,
          `${env.name}[H]`,
          "the float package's H (exactly here, never moved) placement is out of scope; write [h] and accept that it may move",
        ),
      );
      continue;
    }
    st.diagnostics.push(
      error("syntax", at, `\`${char}\` is not a float placement letter; use h, t, b or p`, env.name),
    );
  }
  if (letters.length === 0) {
    st.diagnostics.push(
      warning(
        "syntax",
        at,
        `\`${env.name}\` was given no usable placement letter, so the class default (${DEFAULT_FLOAT_PLACEMENT.letters.join("")}) applies`,
        env.name,
      ),
    );
    return { letters: [...DEFAULT_FLOAT_PLACEMENT.letters], override, explicit: false };
  }
  return { letters, override, explicit: true };
}

/**
 * `\includegraphics[width=…,height=…,scale=…]{file}`.
 *
 * **Nothing is read.** The path is recorded as written; resolving it against
 * `compile()`'s file map, decoding the bytes and honouring the sizing keys is
 * `src/image/`'s job (chunk 39.2), because the engine performs no I/O of its
 * own (D38) and the document layer has no file map at all.
 */
function applyIncludeGraphics(cmd: CommandNode, sink: Sink, st: BuildState): void {
  const at = cmd.loc.start;
  const arg = mandatoryArgument(cmd);
  const path = arg === null ? "" : plainText(arg.content).trim();
  if (path.length === 0) {
    st.diagnostics.push(
      error("syntax", at, "\\includegraphics needs a file name, e.g. \\includegraphics{plot.png}", "\\includegraphics"),
    );
  }
  const options = cmd.args.find((a) => a.bracket === "[");
  const sizing = readImageSizing(options === undefined ? [] : options.content, at, st);
  // Emitted even when the name is missing: the node is what carries this site
  // into layout, and a construct that produced a diagnostic and then vanished
  // from the model is exactly the silent loss D38 forbids.
  emit(sink, { kind: "image", path, sizing, style: cloneStyle(sink.style), loc: at });
}

function readImageSizing(nodes: readonly LatexNode[], at: SourceRef, st: BuildState): ImageSizing {
  const sizing: ImageSizing = { width: null, height: null, scale: null };
  const raw = keyValueText(nodes).trim();
  if (raw.length === 0) return sizing;
  for (const part of raw.split(",")) {
    const text = part.trim();
    if (text.length === 0) continue;
    const eq = text.indexOf("=");
    if (eq < 0) {
      st.diagnostics.push(
        unsupported(
          at,
          `\\includegraphics[${text}]`,
          "only the width=, height= and scale= keys are implemented; graphicx's keyless options are out of scope",
        ),
      );
      continue;
    }
    const key = text.slice(0, eq).trim();
    const value = text.slice(eq + 1).trim();
    if (key === "width" || key === "height") {
      const length = parseDocumentLength(value);
      if (length === null) {
        st.diagnostics.push(
          error(
            "syntax",
            at,
            `\\includegraphics's ${key}=${value} is not a length this engine understands; use a unit (pt, bp, in, cm, mm, pc, em, ex) or a multiple of \\textwidth`,
            "\\includegraphics",
          ),
        );
        continue;
      }
      if (key === "width") sizing.width = length;
      else sizing.height = length;
      continue;
    }
    if (key === "scale") {
      const factor = Number(value);
      if (!Number.isFinite(factor) || factor <= 0) {
        st.diagnostics.push(
          error("syntax", at, `\\includegraphics's scale=${value} is not a positive number`, "\\includegraphics"),
        );
        continue;
      }
      sizing.scale = factor;
      continue;
    }
    st.diagnostics.push(
      unsupported(
        at,
        `\\includegraphics[${key}=...]`,
        "only the width=, height= and scale= keys are implemented",
      ),
    );
  }
  if (sizing.scale !== null && (sizing.width !== null || sizing.height !== null)) {
    // LaTeX resolves this silently in favour of the explicit size. Silently is
    // the problem: the author asked for two sizes and will get one.
    st.diagnostics.push(
      warning(
        "syntax",
        at,
        "\\includegraphics was given scale= as well as width= or height=; the explicit size wins and scale= is ignored",
        "\\includegraphics",
      ),
    );
  }
  return sizing;
}

/**
 * An option list as text, with a length register kept visible: `plainText`
 * would drop `\textwidth` (it flattens commands away) and `width=0.5\textwidth`
 * would silently become `width=0.5`, i.e. half a point wide.
 */
function keyValueText(nodes: readonly LatexNode[]): string {
  let out = "";
  for (const node of nodes) {
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
      case "command":
        out += `\\${node.name}`;
        break;
      case "group":
        out += `{${keyValueText(node.body)}}`;
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * The registers a length may be written as a multiple of. `\linewidth` and
 * `\columnwidth` are not the same as `\textwidth` — the first is the measure in
 * force, which is narrower inside a list — and resolving them is a page-design
 * question, answered by `resolveDocumentLength` in `layout/design.ts`.
 */
const LENGTH_REGISTERS: Readonly<Record<string, LengthRegister>> = {
  textwidth: "textwidth",
  linewidth: "linewidth",
  columnwidth: "columnwidth",
  textheight: "textheight",
  paperwidth: "paperwidth",
  paperheight: "paperheight",
};

/**
 * `3cm`, `0.8\textwidth`, `2em`, `-1pt` → a `DocumentLength`, or null when it is
 * not a length this engine reads.
 *
 * The absolute units are the same table `parseDimension` in `layout/design.ts`
 * uses, and `pt` means the PDF point there too (see that file's header on why
 * TeX's 1/72.27 inch is deliberately not used). The two are separate functions
 * because this one must *not* resolve `em`, `ex` or `\textwidth`: the document
 * layer does not know the type size in force or the page's measure, and baking
 * one page design into the model would be wrong the moment the model is laid
 * out again.
 */
function parseDocumentLength(text: string): DocumentLength | null {
  const trimmed = text.trim();
  const relative = /^([+-]?(?:\d+\.?\d*|\.\d+)?)\s*\\([A-Za-z]+)$/.exec(trimmed);
  if (relative !== null) {
    const register = LENGTH_REGISTERS[relative[2] ?? ""];
    if (register === undefined) return null;
    const written = relative[1] ?? "";
    const factor = written === "" || written === "+" ? 1 : written === "-" ? -1 : Number(written);
    if (!Number.isFinite(factor)) return null;
    return { kind: "relative", factor, of: register };
  }
  const absolute = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*(pt|bp|in|cm|mm|pc|em|ex|sp)?$/.exec(trimmed);
  if (absolute === null) return null;
  const value = Number(absolute[1]);
  if (!Number.isFinite(value)) return null;
  const unit = absolute[2] ?? "pt";
  if (unit === "em" || unit === "ex") return { kind: "font", value, unit };
  return { kind: "points", value: value * (ABSOLUTE_UNITS[unit] ?? 1) };
}

/** Points per unit. `pt` is the PDF point (1/72 in), as `layout/model.ts` requires. */
const ABSOLUTE_UNITS: Readonly<Record<string, number>> = {
  pt: 1,
  bp: 1,
  in: 72,
  cm: 72 / 2.54,
  mm: 72 / 25.4,
  pc: 12,
  sp: 1 / 65536,
};

// --- tables -----------------------------------------------------------------

/**
 * `tabular`: the cell grid, the column specification and the rules. **Parsed
 * only** — not one width is measured here, because measuring needs a shaper and
 * a measure the document layer must not know about (`layout/table.ts`).
 */
function applyTabular(env: EnvironmentNode, sink: Sink, st: BuildState, depth: number): void {
  const at = env.loc.start;
  if (env.args.some((a) => a.bracket === "[")) {
    st.diagnostics.push(
      unsupported(
        at,
        `${env.name}[...]`,
        "aligning a tabular's top or bottom row with the surrounding line is not implemented",
      ),
    );
  }
  const specArg = env.args.find((a) => a.bracket === "{");
  let spec: TableColumnSpec = { columns: [], rulesAfter: 0 };
  if (specArg === undefined) {
    st.diagnostics.push(
      error(
        "syntax",
        at,
        `\`${env.name}\` needs a column specification, e.g. \\begin{${env.name}}{lcr}`,
        env.name,
      ),
    );
  } else {
    spec = readColumnSpec(specArg.content, at, env.name, st);
    if (spec.columns.length === 0) {
      st.diagnostics.push(
        error("syntax", at, `\`${env.name}\`'s column specification declares no columns`, env.name),
      );
    }
  }
  const { rows, rulesBelow } = readTableBody(env, spec, st, depth);
  pushBlock(sink, { kind: "table", construct: env.name, spec, rows, rulesBelow, loc: at });
}

/** One thing in a column specification: a character, or a `{...}` group after `p`. */
type SpecToken = { kind: "char"; text: string } | { kind: "group"; text: string };

function specTokens(nodes: readonly LatexNode[]): SpecToken[] {
  const out: SpecToken[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        for (const char of node.value) out.push({ kind: "char", text: char });
        break;
      case "whitespace":
        out.push({ kind: "char", text: " " });
        break;
      case "escaped":
        out.push({ kind: "char", text: node.char });
        break;
      case "group":
        // `p{3cm}`'s width arrives as a real group, so the braces are structure
        // rather than characters — which is why `plainText` cannot read a column
        // specification: it would flatten `p{3cm}` to `p3cm`.
        out.push({ kind: "group", text: plainText(node.body) });
        break;
      case "command":
        out.push({ kind: "char", text: `\\${node.name}` });
        break;
      default:
        break;
    }
  }
  return out;
}

/** `{|l|c|p{3cm}|}` → columns and the rules between them. */
function readColumnSpec(
  nodes: readonly LatexNode[],
  at: SourceRef,
  construct: string,
  st: BuildState,
): TableColumnSpec {
  const columns: TableColumn[] = [];
  const tokens = specTokens(nodes);
  /** `|`s seen since the last column; they belong in front of the next one. */
  let rules = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "group") {
      st.diagnostics.push(
        error(
          "syntax",
          at,
          `a \`{...}\` in a column specification only follows \`p\`; \`{${token.text}}\` follows nothing`,
          construct,
        ),
      );
      continue;
    }
    const text = token.text;
    if (text === " " || text === "\t" || text === "\n") continue;
    if (text === "|") {
      rules += 1;
      continue;
    }
    if (text === "l" || text === "c" || text === "r") {
      columns.push({
        align: text === "l" ? "left" : text === "c" ? "center" : "right",
        width: null,
        rulesBefore: rules,
      });
      rules = 0;
      continue;
    }
    if (text === "p") {
      const next = tokens[i + 1];
      if (next === undefined || next.kind !== "group") {
        st.diagnostics.push(error("syntax", at, "a `p` column needs a width, e.g. `p{3cm}`", construct));
        continue;
      }
      i += 1;
      const width = parseDocumentLength(next.text);
      if (width === null) {
        st.diagnostics.push(
          error("syntax", at, `\`p{${next.text}}\` is not a column width this engine understands`, construct),
        );
        continue;
      }
      columns.push({ align: "paragraph", width, rulesBefore: rules });
      rules = 0;
      continue;
    }
    // Real LaTeX from a package the engine does not implement. Each of these
    // takes a `{...}` argument, which is skipped so one unknown column type is
    // one diagnostic rather than two.
    const packageColumn = ARRAY_PACKAGE_COLUMNS[text];
    if (packageColumn !== undefined) {
      st.diagnostics.push(unsupported(at, `${construct} column \`${text}\``, packageColumn));
      if (tokens[i + 1]?.kind === "group") i += 1;
      continue;
    }
    st.diagnostics.push(
      error(
        "syntax",
        at,
        `\`${text}\` is not a column type this engine understands; use l, c, r or p{width}`,
        construct,
      ),
    );
  }
  return { columns, rulesAfter: rules };
}

/** Column types that are real LaTeX from a package brief 39 leaves out. */
const ARRAY_PACKAGE_COLUMNS: Readonly<Record<string, string>> = {
  m: "the array package's m{width} (vertically centred) column is out of scope; use p{width}",
  b: "the array package's b{width} (bottom-aligned) column is out of scope; use p{width}",
  X: "tabularx's X column is out of scope; give the column an explicit p{width}",
  "@": "the @{...} inter-column material of a column specification is not implemented",
  "!": "the array package's !{...} inter-column material is not implemented",
  ">": "the array package's >{...} cell prefix is not implemented",
  "<": "the array package's <{...} cell suffix is not implemented",
  "*": "the *{n}{cols} repetition of a column specification is not implemented; write the columns out",
};

interface TableBody {
  rows: TableRow[];
  rulesBelow: TableRule[];
}

/**
 * The grid: cells split at `&`, rows at `\\`, with `\hline`/`\cline` collected
 * at row boundaries and `\multicolumn` read at the start of a cell.
 *
 * `&` arrives as its own `text` node (`"&"`) and `\&` as an `escaped` node, so
 * an escaped ampersand inside a cell is never mistaken for a separator. Text
 * values are still split on `&` defensively: nothing in the parser's contract
 * promises the separator always gets a node of its own.
 */
function readTableBody(
  env: EnvironmentNode,
  spec: TableColumnSpec,
  st: BuildState,
  depth: number,
): TableBody {
  const rows: TableRow[] = [];
  let pendingRules: TableRule[] = [];
  let cells: TableCell[] = [];
  let cellNodes: LatexNode[] = [];
  let override: { span: number; column: TableColumn | null; rulesAfter: number } | null = null;
  let rowLoc: SourceRef = env.loc.start;
  let cellLoc: SourceRef = env.loc.start;

  const atRowStart = (): boolean => cells.length === 0 && cellNodes.length === 0 && override === null;

  const note = (at: SourceRef): void => {
    if (atRowStart()) rowLoc = at;
    if (cellNodes.length === 0) cellLoc = at;
  };

  const endCell = (): void => {
    cells.push({
      content: walkInlines(cellNodes, st, DEFAULT_TEXT_STYLE, `a \`${env.name}\` cell`, depth + 1),
      span: override?.span ?? 1,
      override: override?.column ?? null,
      overrideRulesAfter: override?.rulesAfter ?? 0,
      loc: cellLoc,
    });
    cellNodes = [];
    override = null;
  };

  const endRow = (final: boolean): void => {
    endCell();
    /*
     * A `\\` at the very end of a `tabular` is idiomatic and does not begin a
     * row, so the empty row it would otherwise produce is dropped — but any
     * `\hline` written after it is kept, as `rulesBelow`. Dropping a row that
     * has content would be a silent loss, which is why the test is "one empty
     * unspanned cell" rather than "no cells".
     */
    const empty = cells.length === 1 && cells[0]!.content.length === 0 && cells[0]!.span === 1;
    if (final && empty) {
      cells = [];
      return;
    }
    const used = cells.reduce((total, cell) => total + cell.span, 0);
    if (spec.columns.length > 0 && used > spec.columns.length) {
      st.diagnostics.push(
        error(
          "syntax",
          rowLoc,
          `this \`${env.name}\` row has ${used} cells but the column specification declares ${spec.columns.length}`,
          env.name,
        ),
      );
    }
    rows.push({ cells, rulesAbove: pendingRules, loc: rowLoc });
    pendingRules = [];
    cells = [];
  };

  for (let i = 0; i < env.body.length; i++) {
    if (!spend(st.budget)) {
      reportStop(st, env.body[i]?.loc.start);
      break;
    }
    const node = env.body[i]!;
    if (node.type === "text" && node.value.includes("&")) {
      const parts = node.value.split("&");
      for (let p = 0; p < parts.length; p++) {
        if (p > 0) endCell();
        const value = parts[p]!;
        if (value.length === 0) continue;
        note(node.loc.start);
        cellNodes.push({ ...node, value });
      }
      continue;
    }
    if (node.type === "command") {
      if (node.name === "\\" || node.name === "tabularnewline") {
        if (node.args.some((a) => a.bracket === "[")) {
          st.diagnostics.push(
            unsupported(node.loc.start, "\\\\[...]", "extra vertical space between table rows is not implemented"),
          );
        }
        endRow(i === lastContentIndex(env.body));
        continue;
      }
      if (node.name === "hline") {
        if (!atRowStart()) {
          st.diagnostics.push(
            error(
              "syntax",
              node.loc.start,
              "\\hline may only appear at the start of a row, before any cell content",
              "\\hline",
            ),
          );
          continue;
        }
        pendingRules.push({ from: null, to: null, loc: node.loc.start });
        continue;
      }
      if (node.name === "cline") {
        const consumed = readCline(env, node, i, spec, st);
        if (consumed.rule !== null) {
          if (!atRowStart()) {
            st.diagnostics.push(
              error(
                "syntax",
                node.loc.start,
                "\\cline may only appear at the start of a row, before any cell content",
                "\\cline",
              ),
            );
          } else {
            pendingRules.push(consumed.rule);
          }
        }
        i += consumed.skip;
        continue;
      }
      if (node.name === "multicolumn") {
        const spanning = readMulticolumn(node, st);
        if (spanning === null) continue;
        if (cellNodes.some((n) => n.type !== "whitespace" && n.type !== "comment")) {
          st.diagnostics.push(
            error(
              "syntax",
              node.loc.start,
              "\\multicolumn must be the first thing in its cell",
              "\\multicolumn",
            ),
          );
          continue;
        }
        note(node.loc.start);
        override = { span: spanning.span, column: spanning.column, rulesAfter: spanning.rulesAfter };
        cellNodes = [...spanning.content];
        continue;
      }
    }
    if (node.type === "whitespace" && cellNodes.length === 0 && override === null) {
      // Leading space in a cell is not content; LaTeX discards it too, and
      // keeping it would make every cell's measured width a space too wide.
      continue;
    }
    note(node.loc.start);
    cellNodes.push(node);
  }
  endRow(true);

  return { rows, rulesBelow: pendingRules };
}

/**
 * The last node in a body that is not trailing whitespace or a comment — so a
 * `\\` followed only by a newline is recognised as the trailing one it is.
 */
function lastContentIndex(nodes: readonly LatexNode[]): number {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const type = nodes[i]!.type;
    if (type !== "whitespace" && type !== "comment" && type !== "parbreak") return i;
  }
  return -1;
}

/**
 * `\cline{2-3}`. `@unified-latex` has no signature for `\cline`, so its
 * argument arrives as a sibling group (see `ast.ts`) — which is why this takes
 * the body and an index rather than just the command.
 */
function readCline(
  env: EnvironmentNode,
  cmd: CommandNode,
  index: number,
  spec: TableColumnSpec,
  st: BuildState,
): { rule: TableRule | null; skip: number } {
  const at = cmd.loc.start;
  const own = cmd.args.find((a) => a.bracket === "{");
  const sibling = own === undefined ? env.body[index + 1] : undefined;
  const text =
    own !== undefined
      ? plainText(own.content)
      : sibling !== undefined && sibling.type === "group"
        ? plainText(sibling.body)
        : null;
  const skip = own === undefined && text !== null ? 1 : 0;
  if (text === null) {
    st.diagnostics.push(error("syntax", at, "\\cline needs a column range, e.g. \\cline{2-3}", "\\cline"));
    return { rule: null, skip };
  }
  const match = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(text);
  if (match === null) {
    st.diagnostics.push(
      error("syntax", at, `\\cline{${text.trim()}} is not a column range like 2-3`, "\\cline"),
    );
    return { rule: null, skip };
  }
  const from = Number(match[1]);
  const to = Number(match[2]);
  const columns = spec.columns.length;
  if (from < 1 || to < from || (columns > 0 && to > columns)) {
    st.diagnostics.push(
      error(
        "syntax",
        at,
        `\\cline{${from}-${to}} is outside this \`${env.name}\`'s ${columns} columns`,
        "\\cline",
      ),
    );
    return { rule: null, skip };
  }
  return { rule: { from, to, loc: at }, skip };
}

/** What a `\multicolumn` says about the cell it opens. */
interface SpanningCell {
  span: number;
  /** `\multicolumn`'s own one-column spec, which overrides the table's here. */
  column: TableColumn | null;
  rulesAfter: number;
  content: readonly LatexNode[];
}

/** `\multicolumn{2}{|c|}{content}` — a cell that occupies more than one column. */
function readMulticolumn(cmd: CommandNode, st: BuildState): SpanningCell | null {
  const at = cmd.loc.start;
  const args = cmd.args.filter((a) => a.bracket === "{");
  if (args.length < 3) {
    st.diagnostics.push(
      error(
        "syntax",
        at,
        "\\multicolumn needs three arguments: \\multicolumn{columns}{alignment}{content}",
        "\\multicolumn",
      ),
    );
    return null;
  }
  const span = Number(plainText(args[0]!.content).trim());
  if (!Number.isInteger(span) || span < 1) {
    st.diagnostics.push(
      error("syntax", at, "\\multicolumn's first argument must be a whole number of columns", "\\multicolumn"),
    );
    return null;
  }
  const spec = readColumnSpec(args[1]!.content, at, "\\multicolumn", st);
  if (spec.columns.length !== 1) {
    st.diagnostics.push(
      error(
        "syntax",
        at,
        `\\multicolumn's alignment argument must name exactly one column, not ${spec.columns.length}`,
        "\\multicolumn",
      ),
    );
  }
  return { span, column: spec.columns[0] ?? null, rulesAfter: spec.rulesAfter, content: args[2]!.content };
}

// --- bibliography -----------------------------------------------------------

/** Which `\cite` variant produced a citation. They differ only in how they print. */
const CITATION_STYLES: Readonly<Record<"cite" | "citep" | "citet" | "nocite", CitationStyle>> = {
  cite: "plain",
  citep: "parenthetical",
  citet: "textual",
  nocite: "silent",
};

/**
 * `\cite{a,b}`, `\citep`, `\citet`, `\nocite`. The keys are recorded raw; what
 * each prints is filled in by `resolveCitations` in `doc/bib.ts` during the same
 * second pass `\ref` already uses.
 */
function applyCitation(
  id: "cite" | "citep" | "citet" | "nocite",
  cmd: CommandNode,
  sink: Sink,
  st: BuildState,
): void {
  const at = cmd.loc.start;
  const arg = mandatoryArgument(cmd);
  const keys = (arg === null ? "" : plainText(arg.content))
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  if (keys.length === 0) {
    st.diagnostics.push(
      error("syntax", at, `\\${cmd.name} needs at least one citation key`, `\\${cmd.name}`),
    );
  }
  const citation: CitationInline = {
    kind: "citation",
    style: CITATION_STYLES[id],
    construct: `\\${cmd.name}`,
    keys,
    // `\nocite` prints nothing; every other form shows `[?]` until the
    // bibliography resolves it, the way `\ref` shows `??`.
    text: id === "nocite" ? "" : UNRESOLVED_CITATION,
    textStyle: cloneStyle(sink.style),
    loc: at,
  };
  // Recorded even with no keys, so the site itself is still reported by the
  // bibliography pass rather than disappearing with its diagnostic.
  st.citations.push(citation);
  if (id !== "nocite") emit(sink, citation);
}

/**
 * The commands whose real argument the parser hands back as a sibling group,
 * with the argument spliced in where `applySpecial` will look for it.
 *
 * Two shapes need this, both verified against the parser (2026-08-28):
 *
 * - `\citep`, `\citet` and `\nocite` have no signature at all — unlike
 *   `\cite`, which does — so they arrive with `args: []` and their `{keys}` as
 *   the next sibling. natbib's optional notes arrive with them, as literal
 *   `[`…`]` text, and are refused rather than set.
 * - `\caption*{Text}` parses as `\caption` *whose mandatory argument is the
 *   star*, with `{Text}` as the next sibling. Left alone, the caption's text
 *   became `*` and the real text was set as a stray paragraph inside the float
 *   — a silent loss, so the star is reported and the group adopted.
 *
 * Returns null, consuming nothing, unless there is really something to adopt: an
 * ordinary `[1]` after a citation must stay ordinary text.
 */
function adoptSiblingGroup(
  nodes: readonly LatexNode[],
  index: number,
  st: BuildState,
): { cmd: CommandNode; consumed: number } | null {
  const node = nodes[index]!;
  if (node.type !== "command") return null;
  if (node.name === "caption") return adoptStarredCaption(nodes, index, st);
  if (!CITATION_ADOPTS_SIBLING.has(node.name)) return null;
  if (node.args.some((a) => a.bracket === "{")) return null;

  let at = index + 1;
  let notes = 0;
  for (;;) {
    const close = closingBracket(nodes, at);
    if (close === null) break;
    notes += 1;
    at = close + 1;
  }
  const group = nodes[at];
  if (group === undefined || group.type !== "group") return null;
  if (notes > 0) {
    st.diagnostics.push(
      unsupported(
        node.loc.start,
        `\\${node.name}[...]`,
        "natbib's optional before/after citation notes are not implemented; they are dropped rather than set as text",
      ),
    );
  }
  const adopted: CommandNode = {
    ...node,
    args: [...node.args, { bracket: "{", content: (group as GroupNode).body, loc: group.loc }],
  };
  return { cmd: adopted, consumed: at - index };
}

const CITATION_ADOPTS_SIBLING: ReadonlySet<string> = new Set(["citep", "citet", "nocite"]);

/** The `\caption*` half of `adoptSiblingGroup` — see its doc comment. */
function adoptStarredCaption(
  nodes: readonly LatexNode[],
  index: number,
  st: BuildState,
): { cmd: CommandNode; consumed: number } | null {
  const node = nodes[index] as CommandNode;
  const arg = mandatoryArgument(node);
  if (arg === null || plainText(arg.content).trim() !== "*") return null;
  st.diagnostics.push(
    unsupported(
      node.loc.start,
      "\\caption*",
      "the unnumbered \\caption* form is not implemented; this caption is numbered like any other",
    ),
  );
  const group = nodes[index + 1];
  const body = group !== undefined && group.type === "group" ? (group as GroupNode).body : [];
  return {
    // The star's slot becomes the caption's real text, so `applyCaption` sees
    // the same shape it would have seen from an unstarred `\caption`.
    cmd: { ...node, args: node.args.map((a) => (a === arg ? { ...a, content: body } : a)) },
    consumed: body.length > 0 || (group !== undefined && group.type === "group") ? 1 : 0,
  };
}

/** Where a `[`…`]` run starting at `from` closes, or null if it does not look like one. */
function closingBracket(nodes: readonly LatexNode[], from: number): number | null {
  const first = nodes[from];
  if (first === undefined || first.type !== "text" || !first.value.startsWith("[")) return null;
  // A citation note is short. Past this the `[` is ordinary text that happens
  // to follow a citation, and consuming to a distant `]` would eat a sentence.
  const LIMIT = 32;
  for (let i = from; i < nodes.length && i - from < LIMIT; i++) {
    const node = nodes[i]!;
    if (node.type === "text" && node.value.includes("]")) return i;
  }
  return null;
}

/** `\bibliography{refs}` — the reference list built from `.bib` files. */
function applyBibliographyCommand(cmd: CommandNode, sink: Sink, st: BuildState): void {
  const at = cmd.loc.start;
  const arg = mandatoryArgument(cmd);
  const bibFiles = (arg === null ? "" : plainText(arg.content))
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (bibFiles.length === 0) {
    st.diagnostics.push(
      error("syntax", at, "\\bibliography needs at least one .bib file name", "\\bibliography"),
    );
  }
  const block: BibliographyBlock = {
    kind: "bibliography",
    construct: "\\bibliography",
    source: "bibfile",
    bibFiles,
    // Filled in again by `doc/index.ts` before formatting: a
    // `\bibliographystyle` written *after* the `\bibliography` still counts.
    style: st.bibliographyStyle,
    widestLabel: null,
    entries: [],
    content: [],
    loc: at,
  };
  st.bibliographies.push(block);
  pushBlock(sink, block);
}

/**
 * `thebibliography` — the reference list written out by hand. Its `\bibitem`s
 * are consumed structurally here, the same way `applyList` consumes `\item`,
 * which is why `\bibitem` keeps an `unsupported` row in `macro/builtins.ts`:
 * that row is reached only by a `\bibitem` written outside any such
 * environment, where nothing implements it.
 */
function applyThebibliography(env: EnvironmentNode, sink: Sink, st: BuildState, depth: number): void {
  const at = env.loc.start;
  const widestArg = env.args.find((a) => a.bracket === "{");
  // Empty as well as absent: `\begin{thebibliography}` with no argument makes
  // the parser take whatever follows as one — the first `\bibitem`, in a real
  // document — and `plainText` of that is empty, so the missing argument shows
  // up here as an empty one rather than as none.
  const widestLabel = widestArg === undefined ? "" : plainText(widestArg.content).trim();
  if (widestLabel.length === 0) {
    st.diagnostics.push(
      error(
        "syntax",
        at,
        `\`${env.name}\` needs its widest-label argument, e.g. \\begin{${env.name}}{9}`,
        env.name,
      ),
    );
  }
  const entries: BibItem[] = [];
  for (const node of env.body) {
    if (!spend(st.budget)) {
      reportStop(st, node.loc.start);
      break;
    }
    if (node.type === "whitespace" || node.type === "parbreak" || node.type === "comment") continue;
    if (node.type === "command" && node.name === "bibitem") {
      entries.push(buildBibItem(node, st, depth + 1));
      continue;
    }
    // `\bibitem`'s signature gobbles everything up to the next one, so anything
    // still sitting directly in the body was written before the first entry.
    st.diagnostics.push(
      error("syntax", node.loc.start, `content in \`${env.name}\` before the first \\bibitem`, env.name),
    );
  }
  if (entries.length === 0) {
    st.diagnostics.push(warning("syntax", at, `\`${env.name}\` has no \\bibitem`, env.name));
  }
  const block: BibliographyBlock = {
    kind: "bibliography",
    construct: env.name,
    source: "thebibliography",
    bibFiles: [],
    style: st.bibliographyStyle,
    widestLabel: widestLabel.length === 0 ? null : widestLabel,
    entries,
    content: [],
    loc: at,
  };
  st.bibliographies.push(block);
  pushBlock(sink, block);
}

function buildBibItem(cmd: CommandNode, st: BuildState, depth: number): BibItem {
  const at = cmd.loc.start;
  const braced = cmd.args.filter((a) => a.bracket === "{");
  const key = braced.length > 0 ? plainText(braced[0]!.content).trim() : "";
  if (key.length === 0) {
    st.diagnostics.push(error("syntax", at, "\\bibitem needs a citation key", "\\bibitem"));
  }
  const optional = cmd.args.find((a) => a.bracket === "[");
  // The trailing gobbled slot: `\bibitem`'s signature swallows everything up to
  // the next `\bibitem` or `\end`, exactly as `\item`'s does.
  const last = cmd.args.length > 0 ? cmd.args[cmd.args.length - 1]! : undefined;
  const bodyNodes = last !== undefined && last.bracket === null ? last.content : [];
  return {
    key,
    label: optional === undefined ? null : walkInlines(optional.content, st, DEFAULT_TEXT_STYLE, "\\bibitem[...]", depth),
    content: walkBlocks(bodyNodes, st, DEFAULT_TEXT_STYLE, depth),
    loc: at,
  };
}

function boldStyle(): TextStyle {
  return { font: { ...DEFAULT_TEXT_STYLE.font, weight: "bold" }, underline: false };
}

// --- mathematics (brief 40) -------------------------------------------------

/**
 * What a `math-only` name is told when it is written outside math mode. One
 * message for two hundred names, which is why `math-only` is a role rather
 * than an `unsupported` row each — see `BuiltinSpec` in `macro/builtins.ts`.
 */
const MATH_ONLY_DETAIL =
  "this is a math-mode construct and is implemented there; outside math ($...$, \\(...\\), \\[...\\] or a display environment) there is nothing for it to set";

/*
 * Math is the one construct whose *inside* the document layer deliberately does
 * not model. Everything else here turns nodes into blocks and inlines; a math
 * run turns nodes back into TeX, because the thing that will set it is MathJax
 * and MathJax reads TeX (D41 §1). Modelling the inside of a formula as
 * document-model nodes would be building a second representation nothing reads.
 *
 * What the document layer *does* own, and does here:
 *   - which delimiters wrote it, so a diagnostic can name the construct;
 *   - which display variant it is, so numbering and alignment are decidable;
 *   - the equation counter, `\label` and `\ref` (acceptance 4);
 *   - the In-list gate on names the source wrote literally (D41 §5).
 * Rendering is chunk 40.2, placement and the overrun diagnostic are 40.4, and
 * setting the number at the margin is 40.5 — see `MathBox`, `MathRenderer` and
 * `EquationNumberSetter` in `model.ts` for the shapes they meet.
 */

/**
 * `$…$`, `\(…\)`, `\[…\]` and `$$…$$` — the delimiter forms, which the parser
 * hands over as a `math` node with a `display` flag and nothing else. `\[` and
 * `$$` are indistinguishable by the time they get here (both are
 * `@unified-latex`'s `displaymath`), so both are named `\[...\]`; they mean the
 * same thing and neither is numbered.
 */
function applyMath(node: MathNode, sink: Sink, st: BuildState, depth: number): void {
  const at = node.loc.start;
  if (depth > MAX_NESTING) {
    reportStop(st, at, `source nesting is deeper than ${MAX_NESTING} levels`);
    return;
  }
  const construct = node.display ? "\\[...\\]" : "$...$";
  gateMathContent(node.body, st, construct);
  if (node.display) {
    // `\[…\]` is `displaymath`, and `displaymath` is never numbered — so a
    // `\label` in one has no number to print, which `collectMathLabels`
    // reports rather than letting `\ref` set a blank.
    buildDisplay(node.body, "bracket", construct, null, at, sink, st);
    return;
  }
  emit(sink, {
    kind: "math",
    source: printMath(node.body),
    construct,
    display: false,
    style: cloneStyle(sink.style),
    loc: at,
  });
}

/**
 * `\begin{equation}`, `\begin{align}` and the rest of brief 40's In list. The
 * environment name has to be kept: `align` and `gather` are both numbered
 * multi-line displays and differ only in whether `&` means anything, which is
 * MathJax's business, but the *diagnostics* have to say which one was written.
 */
function applyDisplayMath(
  env: EnvironmentNode,
  variant: DisplayMathVariant,
  sink: Sink,
  st: BuildState,
  depth: number,
): void {
  const at = env.loc.start;
  if (depth > MAX_NESTING) {
    reportStop(st, at, `source nesting is deeper than ${MAX_NESTING} levels`);
    return;
  }
  gateMathContent(env.body, st, env.name);
  if (env.args.some((a) => a.bracket === "[")) {
    // No In-list display environment takes an optional argument; one that was
    // written means a package this engine does not have is in play, and
    // dropping it silently would set a different equation than the author read.
    st.diagnostics.push(
      unsupported(at, env.name, "no display-math environment on brief 40's In list takes an optional argument"),
    );
  }
  buildDisplay(env.body, variant, env.name, env.name, at, sink, st);
}

/**
 * The half both entry points share: split the body into `\\`-separated lines,
 * number the ones that are numbered, register any `\label`s against them, and
 * push the block.
 *
 * `wrapper` is the environment name to print back around the TeX, or null for a
 * delimiter form. It matters: MathJax needs `\begin{align}…\end{align}` to know
 * where the alignment points are, and would set a bare `a &= b` as an error.
 */
function buildDisplay(
  body: readonly LatexNode[],
  variant: DisplayMathVariant,
  construct: string,
  wrapper: string | null,
  at: SourceRef,
  sink: Sink,
  st: BuildState,
): void {
  const numbered = isNumberedDisplay(variant);
  const rawLines = isMultiLineDisplay(variant) ? splitDisplayLines(body, at) : [{ nodes: body, loc: at }];
  const lines: MathLine[] = [];
  const markers: string[] = [];
  for (const raw of rawLines) {
    // `\nonumber`/`\notag` suppress *this line's* number and nothing else —
    // which is why the counter is stepped per line rather than per display.
    const suppressed = raw.nodes.some(
      (n) => n.type === "command" && (n.name === "nonumber" || n.name === "notag"),
    );
    const lineNumbered = numbered && !suppressed;
    let number: string | null = null;
    let marker: string | null = null;
    if (lineNumbered) {
      step(st.counters, "equation");
      number = formatEquationNumber(st.counters);
      marker = equationMarker(st.equations);
      st.equations += 1;
      markers.push(marker);
      // `\@currentlabel`: a `\label` written on this line refers to this
      // number, exactly as it would inside a `\section`. Set before the labels
      // on the line are read, cleared after the display, because a `\label`
      // written *after* an equation belongs to whatever numbered thing comes
      // next and not to the equation it happens to follow.
      st.currentLabel = number;
      st.currentLabelKind = "equation";
    }
    collectMathLabels(raw.nodes, st, marker, construct);
    lines.push({ source: printMath(raw.nodes), number, marker, loc: raw.loc });
  }
  const inner = printMath(body);
  const source = wrapper === null ? inner : `\\begin{${wrapper}}${inner}\\end{${wrapper}}`;
  /*
   * One `MarkerBlock` per numbered line, immediately before the display.
   *
   * `\pageref` resolves through markers that layout has *placed*, and layout
   * places `MarkerBlock`s already — so emitting them here closes the two-pass
   * cycle for equations today, with no layout change and no second reference
   * mechanism (brief 40 step 3 forbids one). It is provisional in exactly one
   * respect: a marker sitting immediately before the display reports the page
   * the display *starts* on, which is the right answer unless a page break
   * lands between the marker and the block. Chunk 40.4 can move the markers
   * inside the display's own vertical material and this loop goes away; until
   * then a `\pageref` to an equation is right rather than `??`.
   */
  for (const marker of markers) pushBlock(sink, { kind: "marker", name: marker, loc: at });
  pushBlock(sink, {
    kind: "displaymath",
    variant,
    construct,
    source,
    display: true,
    numbered,
    lines,
    loc: at,
  });
  if (numbered) {
    st.currentLabel = null;
    st.currentLabelKind = "document";
  }
}

/** One `\\`-separated line of a multi-line display, before it is printed back. */
interface DisplayLine {
  nodes: LatexNode[];
  loc: SourceRef;
}

/**
 * Split a display's body on top-level `\\`. Only top-level ones: a `\\` inside
 * a `pmatrix` nested in an `align` line separates matrix rows, not equation
 * lines, and it is inside that environment's own body so this walk never sees
 * it.
 */
function splitDisplayLines(body: readonly LatexNode[], at: SourceRef): DisplayLine[] {
  const lines: DisplayLine[] = [];
  let current: LatexNode[] = [];
  let loc = at;
  for (const node of body) {
    if (node.type === "command" && node.name === "\\") {
      lines.push({ nodes: current, loc });
      current = [];
      loc = node.loc.end;
      continue;
    }
    if (current.length === 0 && node.type !== "whitespace" && node.type !== "parbreak") loc = node.loc.start;
    current.push(node);
  }
  // A trailing `\\` before `\end{align}` is idiomatic and does not open a line;
  // an empty last line would otherwise be numbered and set as a blank row.
  if (current.some((n) => n.type !== "whitespace" && n.type !== "parbreak" && n.type !== "comment")) {
    lines.push({ nodes: current, loc });
  }
  return lines.length > 0 ? lines : [{ nodes: [], loc: at }];
}

/**
 * Register every `\label` written inside a math run, against the equation
 * number in force.
 *
 * Deliberately a second walk rather than a branch in `applySpecial`: the body
 * of a math run is never emitted as document material, so `\label` there never
 * reaches the ordinary command path. `marker` is null for an unnumbered
 * display, and that case is a warning for the same reason `applySpecial`'s is —
 * a `\ref` to it would print an empty string in a published document.
 */
function collectMathLabels(
  nodes: readonly LatexNode[],
  st: BuildState,
  marker: string | null,
  construct: string,
): void {
  for (const node of nodes) {
    if (node.type === "group") {
      collectMathLabels(node.body, st, marker, construct);
      continue;
    }
    if (node.type !== "command" || node.name !== "label") continue;
    const at = node.loc.start;
    const arg = mandatoryArgument(node);
    const key = arg === null ? "" : plainText(arg.content).trim();
    if (key.length === 0) {
      st.diagnostics.push(error("syntax", at, "\\label needs a non-empty key", "\\label"));
      continue;
    }
    if (st.labels.has(key)) {
      st.diagnostics.push(
        error("duplicate-label", at, `\\label{${key}} was already defined; the first definition wins`, "\\label"),
      );
      continue;
    }
    if (marker === null) {
      st.diagnostics.push(
        warning(
          "undefined-reference",
          at,
          `\\label{${key}} is inside ${construct}, which is not numbered, so \\ref{${key}} has no number to print`,
          "\\label",
        ),
      );
      st.labels.set(key, { key, text: UNRESOLVED_REFERENCE, marker: labelMarker(key), loc: at });
      continue;
    }
    // The label resolves through the *equation's* marker, not one of its own:
    // the marker is what layout places, and there is nothing inside the display
    // for a `labelMarker` to be attached to.
    st.labels.set(key, { key, text: st.currentLabel ?? UNRESOLVED_REFERENCE, marker, loc: at });
  }
}

/**
 * The In-list gate, name level (D41 §5).
 *
 * Walks everything a math run contains and reports the names brief 40 declined.
 * It does **not** report names it has never heard of: an unrecognised control
 * sequence inside math is MathJax's to judge — with `noundefined` dropped it
 * raises a real error through `formatError` (D41 §4) — and guessing here would
 * mean either a false `unsupported` for every symbol this list has not got
 * round to, or a false `undefined-command` for one MathJax knows and we do not.
 * Chunk 40.2 closes that half on the MathML, where macro expansion is done.
 */
function gateMathContent(nodes: readonly LatexNode[], st: BuildState, construct: string): void {
  for (const node of nodes) {
    if (!spend(st.budget)) return;
    switch (node.type) {
      case "command": {
        const detail = DECLINED_MATH_COMMANDS[node.name];
        if (detail !== undefined) st.diagnostics.push(unsupported(node.loc.start, `\\${node.name}`, detail));
        for (const arg of node.args) gateMathContent(arg.content, st, construct);
        break;
      }
      case "environment": {
        const detail = DECLINED_MATH_ENVIRONMENTS[node.name];
        if (detail !== undefined) st.diagnostics.push(unsupported(node.loc.start, node.name, detail));
        for (const arg of node.args) gateMathContent(arg.content, st, construct);
        gateMathContent(node.body, st, construct);
        break;
      }
      case "group":
        gateMathContent(node.body, st, construct);
        break;
      case "math":
        // `$` inside `$…$` is malformed, but `\text{… $x$ …}` nests legally.
        gateMathContent(node.body, st, construct);
        break;
      case "unknown":
        // A `\verb` or a `verbatim` inside math: the parser preserved it and
        // there is no sane TeX to print back for it, so it is refused here
        // rather than silently flattened into the formula.
        st.diagnostics.push(
          unsupported(node.loc.start, construct, `a ${node.originalType} construct inside math has no meaning to hand a math renderer`),
        );
        break;
      default:
        break;
    }
  }
}

/**
 * Print an expanded AST back to TeX, for the renderer.
 *
 * This is the whole reason `MathInline.source` is a string: what MathJax must
 * be handed is the *expanded* source, and by the time the builder runs the
 * document's own `\newcommand`s are gone from the tree — so slicing the
 * original file would hand MathJax macros it has never heard of, and slicing
 * anything at all would need the source text threaded through a layer that
 * deliberately does not have it.
 *
 * `\label`, `\nonumber` and `\notag` are dropped: they are numbering
 * instructions this file has already carried out, and MathJax would either set
 * them or refuse them.
 */
const MATH_ACTIVE_CHARS: ReadonlySet<string> = new Set(["^", "_"]);

function printMath(nodes: readonly LatexNode[]): string {
  let out = "";
  const append = (text: string): void => {
    // TeX's own rule, and the only subtlety in this function: a control word
    // swallows the letters that follow it, so `\alpha` + `x` must be printed
    // `\alpha x`. A control *symbol* (`\\`, `\{`) has no such problem, and
    // neither does anything not starting with a letter.
    if (/\\[A-Za-z]+$/.test(out) && /^[A-Za-z]/.test(text)) out += " ";
    out += text;
  };
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        append(node.value);
        break;
      case "whitespace":
        out += " ";
        break;
      case "parbreak":
        // A blank line inside math is an error in TeX; printing it back as one
        // space keeps the formula readable and lets MathJax decide.
        out += " ";
        break;
      case "comment":
        break;
      case "escaped":
        append(`\\${node.char}`);
        break;
      case "group":
        append(`{${printMath(node.body)}}`);
        break;
      case "math":
        append(node.display ? `\\[${printMath(node.body)}\\]` : `$${printMath(node.body)}$`);
        break;
      case "environment":
        append(`\\begin{${node.name}}${printMathArgs(node.args)}${printMath(node.body)}\\end{${node.name}}`);
        break;
      case "command": {
        if (node.name === "label" || node.name === "nonumber" || node.name === "notag") break;
        // `^` and `_` are the two math-mode macros the parser reports as
        // *commands* rather than as characters, because in math they take an
        // argument (`x^2` is `^` applied to `2`) — see `EscapedCharNode` in
        // `ast.ts`. They must print back as the bare character: `\^` is the
        // text-mode circumflex accent, so printing the backslash would hand the
        // renderer a different formula than the author wrote, and one that
        // still renders. That is the exact class of silent wrongness D38 is
        // about, which is why it is a named case and not a fallthrough.
        append(MATH_ACTIVE_CHARS.has(node.name) ? node.name : `\\${node.name}`);
        out += printMathArgs(node.args);
        break;
      }
      case "unknown":
        // Refused by `gateMathContent`, which runs first; printing the raw text
        // anyway keeps the two from disagreeing about what the run contained.
        append(node.raw);
        break;
    }
  }
  return out;
}

function printMathArgs(args: readonly Argument[]): string {
  let out = "";
  for (const arg of args) {
    if (arg.bracket === "{") out += `{${printMath(arg.content)}}`;
    else if (arg.bracket === "[") out += `[${printMath(arg.content)}]`;
    // A `bracket: null` slot with content is the `*` of a starred command, and
    // an empty one was never written at all — see `Argument` in `ast.ts`.
    else out += printMath(arg.content);
  }
  return out;
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
  // Kept with the options themselves: `documentDesign` reports an option it
  // cannot honour, and brief 37 treats a wrong line number as a bug.
  st.classLoc = at;
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
