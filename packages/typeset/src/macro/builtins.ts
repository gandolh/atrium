import type { FontSelection, HeadingLevel, ListVariant } from "../doc/model.ts";

/**
 * The builtin command and environment tables (brief 37, chunk 6).
 *
 * This file is **data, not behaviour**: every command the engine knows about
 * appears here exactly once, with a `role` that says which branch of the
 * document builder handles it. Keeping it declarative is what makes the
 * loud-failure contract (D38) checkable — a name that is in no table at all is
 * an `undefined-command`, a name whose role is `unsupported` is real LaTeX we
 * chose not to implement, and there is no third case where a command quietly
 * does nothing.
 *
 * **Adding a command (chunk 8 and later):** add one row to `BUILTIN_COMMANDS`.
 * If it fits an existing role — a style, a fixed symbol, a sectioning level —
 * nothing else changes. If it needs its own branch, give it
 * `{ role: "special", id: "..." }`, widen `SpecialId`, and add the `case` to
 * `applySpecial` in `doc/build.ts`; the compiler will point at the missing case
 * because `SpecialId` is a closed union. Environments work the same way through
 * `BUILTIN_ENVIRONMENTS`.
 */

/** A command with its own branch in the builder. Closed on purpose — see above. */
export type SpecialId =
  | "documentclass"
  | "usepackage"
  | "title"
  | "author"
  | "date"
  | "maketitle"
  | "tableofcontents"
  | "label"
  | "ref"
  | "pageref"
  | "footnote"
  | "item"
  | "linebreak"
  | "pagebreak"
  | "noindent"
  | "today"
  | "input"
  | "verb"
  | "stray-environment"
  | "ignore";

export type BuiltinSpec =
  /**
   * Sets its one mandatory argument in a modified style. `font` is merged over
   * the style in force, so `\textbf` inside `\texttt` stays typewriter.
   * `emph` *toggles* slant the way LaTeX's `\emph` does rather than forcing it.
   */
  | { role: "text-style"; font?: Partial<FontSelection>; emph?: boolean; underline?: boolean }
  /**
   * The same style change written as a declaration (`{\bfseries ...}`): it
   * applies to the rest of the enclosing group instead of to an argument.
   * `reset` restores the document's ground style (`\normalfont`).
   */
  | { role: "style-declaration"; font?: Partial<FontSelection>; emph?: boolean; reset?: boolean }
  /** Prints a fixed string in the style in force. */
  | { role: "symbol"; text: string }
  | { role: "section"; level: HeadingLevel }
  | { role: "special"; id: SpecialId }
  /** Real LaTeX, deliberately not implemented. Always produces a diagnostic. */
  | { role: "unsupported"; detail: string };

/**
 * The message every TeX-programming primitive gets. These are not "not yet":
 * the engine reads LaTeX-shaped documents, it does not execute TeX, and no
 * later brief changes that (D38).
 */
const TEX_PROGRAMMING = "the engine reads LaTeX-shaped documents and does not execute TeX; this is permanently out of scope";

function texProgramming(): BuiltinSpec {
  return { role: "unsupported", detail: TEX_PROGRAMMING };
}

function unimplemented(detail: string): BuiltinSpec {
  return { role: "unsupported", detail };
}

/** Every command name (without its backslash) the engine has heard of. */
export const BUILTIN_COMMANDS: Readonly<Record<string, BuiltinSpec>> = {
  // --- preamble ---
  documentclass: { role: "special", id: "documentclass" },
  usepackage: { role: "special", id: "usepackage" },
  RequirePackage: { role: "special", id: "usepackage" },
  title: { role: "special", id: "title" },
  author: { role: "special", id: "author" },
  date: { role: "special", id: "date" },

  // An unpaired \begin/\end never becomes an environment: the parser maps it
  // to a plain command plus a sibling group holding the name (see `ast.ts`).
  begin: { role: "special", id: "stray-environment" },
  end: { role: "special", id: "stray-environment" },

  // --- structure ---
  section: { role: "section", level: "section" },
  subsection: { role: "section", level: "subsection" },
  subsubsection: { role: "section", level: "subsubsection" },
  paragraph: { role: "section", level: "paragraph" },
  maketitle: { role: "special", id: "maketitle" },
  tableofcontents: { role: "special", id: "tableofcontents" },
  item: { role: "special", id: "item" },

  // --- cross-references ---
  label: { role: "special", id: "label" },
  ref: { role: "special", id: "ref" },
  pageref: { role: "special", id: "pageref" },
  footnote: { role: "special", id: "footnote" },

  // --- text-level style ---
  emph: { role: "text-style", emph: true },
  textbf: { role: "text-style", font: { weight: "bold" } },
  textit: { role: "text-style", font: { slant: "italic" } },
  texttt: { role: "text-style", font: { family: "mono" } },
  textrm: { role: "text-style", font: { family: "serif" } },
  textsf: { role: "text-style", font: { family: "sans" } },
  textmd: { role: "text-style", font: { weight: "regular" } },
  textup: { role: "text-style", font: { slant: "upright" } },
  textnormal: { role: "text-style", font: { family: "serif", weight: "regular", slant: "upright" } },
  underline: { role: "text-style", underline: true },

  // Declaration forms of the same faces. `{\bfseries x}` is the idiom half of
  // real documents use, and it is the same mechanic as `\textbf` with a
  // different scope, so leaving it out would fail ordinary documents for no
  // gain.
  bfseries: { role: "style-declaration", font: { weight: "bold" } },
  mdseries: { role: "style-declaration", font: { weight: "regular" } },
  itshape: { role: "style-declaration", font: { slant: "italic" } },
  upshape: { role: "style-declaration", font: { slant: "upright" } },
  ttfamily: { role: "style-declaration", font: { family: "mono" } },
  rmfamily: { role: "style-declaration", font: { family: "serif" } },
  sffamily: { role: "style-declaration", font: { family: "sans" } },
  em: { role: "style-declaration", emph: true },
  normalfont: { role: "style-declaration", reset: true },

  // --- fixed symbols and spacing ---
  ldots: { role: "symbol", text: "…" },
  dots: { role: "symbol", text: "…" },
  textellipsis: { role: "symbol", text: "…" },
  S: { role: "symbol", text: "§" },
  P: { role: "symbol", text: "¶" },
  dag: { role: "symbol", text: "†" },
  ddag: { role: "symbol", text: "‡" },
  copyright: { role: "symbol", text: "©" },
  pounds: { role: "symbol", text: "£" },
  textbackslash: { role: "symbol", text: "\\" },
  textasciitilde: { role: "symbol", text: "~" },
  textasciicircum: { role: "symbol", text: "^" },
  textbar: { role: "symbol", text: "|" },
  textless: { role: "symbol", text: "<" },
  textgreater: { role: "symbol", text: ">" },
  textendash: { role: "symbol", text: "–" },
  textemdash: { role: "symbol", text: "—" },
  textquoteleft: { role: "symbol", text: "‘" },
  textquoteright: { role: "symbol", text: "’" },
  textquotedblleft: { role: "symbol", text: "“" },
  textquotedblright: { role: "symbol", text: "”" },
  LaTeX: { role: "symbol", text: "LaTeX" },
  LaTeXe: { role: "symbol", text: "LaTeX2e" },
  TeX: { role: "symbol", text: "TeX" },
  // `\ ` — a control space, i.e. an ordinary inter-word space that survives
  // the space-gobbling after a control word.
  " ": { role: "symbol", text: " " },

  // --- flow ---
  "\\": { role: "special", id: "linebreak" },
  newline: { role: "special", id: "linebreak" },
  newpage: { role: "special", id: "pagebreak" },
  clearpage: { role: "special", id: "pagebreak" },
  cleardoublepage: { role: "special", id: "pagebreak" },
  pagebreak: { role: "special", id: "pagebreak" },
  noindent: { role: "special", id: "noindent" },
  today: { role: "special", id: "today" },
  input: { role: "special", id: "input" },
  include: { role: "special", id: "input" },
  verb: { role: "special", id: "verb" },
  // `\protect` and friends only matter to a macro processor with fragile
  // arguments; here they are genuinely nothing, which is why they are the only
  // commands allowed to do nothing.
  protect: { role: "special", id: "ignore" },
  relax: { role: "special", id: "ignore" },
  ignorespaces: { role: "special", id: "ignore" },

  // --- real LaTeX we do not implement (brief-scoped) ---
  includegraphics: unimplemented("images are out of scope for brief 37"),
  caption: unimplemented("floats and their captions are out of scope for brief 37"),
  centering: unimplemented("centred text is out of scope for brief 37"),
  cite: unimplemented("bibliographies are brief 39"),
  citep: unimplemented("bibliographies are brief 39"),
  citet: unimplemented("bibliographies are brief 39"),
  nocite: unimplemented("bibliographies are brief 39"),
  bibliography: unimplemented("bibliographies are brief 39"),
  bibliographystyle: unimplemented("bibliographies are brief 39"),
  bibitem: unimplemented("bibliographies are brief 39"),
  textsc: unimplemented("the engine ships no small-caps face"),
  textsl: unimplemented("the engine ships no slanted face distinct from italic"),
  scshape: unimplemented("the engine ships no small-caps face"),
  slshape: unimplemented("the engine ships no slanted face distinct from italic"),
  marginpar: unimplemented("margin notes are out of scope"),
  footnotemark: unimplemented("only the combined \\footnote form is implemented"),
  footnotetext: unimplemented("only the combined \\footnote form is implemented"),
  thanks: unimplemented("title-page footnotes are out of scope for brief 37"),
  and: unimplemented("multiple authors are out of scope for brief 37"),
  hspace: unimplemented("explicit spacing is out of scope for brief 37"),
  vspace: unimplemented("explicit spacing is out of scope for brief 37"),
  hfill: unimplemented("explicit spacing is out of scope for brief 37"),
  vfill: unimplemented("explicit spacing is out of scope for brief 37"),
  smallskip: unimplemented("explicit spacing is out of scope for brief 37"),
  medskip: unimplemented("explicit spacing is out of scope for brief 37"),
  bigskip: unimplemented("explicit spacing is out of scope for brief 37"),
  linebreak: unimplemented("only the \\\\ form of a forced line break is implemented"),
  nolinebreak: unimplemented("break suppression is out of scope for brief 37"),
  pagestyle: unimplemented("page styles are out of scope for brief 37"),
  thispagestyle: unimplemented("page styles are out of scope for brief 37"),
  setlength: unimplemented("length registers are out of scope"),
  addtolength: unimplemented("length registers are out of scope"),
  newcounter: unimplemented("user counters are out of scope for brief 37"),
  setcounter: unimplemented("counter assignment is out of scope for brief 37"),
  addtocounter: unimplemented("counter assignment is out of scope for brief 37"),
  stepcounter: unimplemented("counter assignment is out of scope for brief 37"),
  refstepcounter: unimplemented("counter assignment is out of scope for brief 37"),
  appendix: unimplemented("appendix numbering is out of scope for brief 37"),
  chapter: unimplemented("only the article class is implemented, and it has no \\chapter"),
  part: unimplemented("part-level sectioning is out of scope for brief 37"),
  index: unimplemented("index packages are out of scope"),
  glossary: unimplemented("glossary packages are out of scope"),
  newtheorem: unimplemented("theorem environments are out of scope for brief 37"),
  usetikzlibrary: unimplemented("TikZ/pgf is out of scope"),
  colorbox: unimplemented("colour is out of scope for brief 37"),
  textcolor: unimplemented("colour is out of scope for brief 37"),
  href: unimplemented("hyperlinks are out of scope for brief 37"),
  url: unimplemented("hyperlinks are out of scope for brief 37"),

  // --- TeX programming: permanently out of scope ---
  def: texProgramming(),
  gdef: texProgramming(),
  edef: texProgramming(),
  xdef: texProgramming(),
  let: texProgramming(),
  catcode: texProgramming(),
  expandafter: texProgramming(),
  noexpand: texProgramming(),
  csname: texProgramming(),
  endcsname: texProgramming(),
  newif: texProgramming(),
  ifx: texProgramming(),
  ifnum: texProgramming(),
  fi: texProgramming(),
  else: texProgramming(),
  advance: texProgramming(),
  multiply: texProgramming(),
  divide: texProgramming(),
  count: texProgramming(),
  dimen: texProgramming(),
  newcount: texProgramming(),
  newdimen: texProgramming(),
  hbox: texProgramming(),
  vbox: texProgramming(),
  makeatletter: texProgramming(),
  makeatother: texProgramming(),
  write: texProgramming(),
  immediate: texProgramming(),
  openout: texProgramming(),
  special: texProgramming(),
};

/** The commands that *define* macros. Handled by the expander, never the builder. */
export const DEFINITION_COMMANDS: ReadonlySet<string> = new Set([
  "newcommand",
  "renewcommand",
  "providecommand",
]);

/**
 * Names whose redefinition would change counter or list-label formatting.
 * Redefining one is valid LaTeX that this engine does not honour, and the
 * failure would otherwise be *silent wrong output* rather than a missing
 * feature — the exact thing D38 forbids. So the definition is still recorded
 * (in case the document also uses the name directly) and a diagnostic is
 * raised.
 */
export const FORMATTING_HOOKS: ReadonlySet<string> = new Set([
  "thesection",
  "thesubsection",
  "thesubsubsection",
  "theparagraph",
  "thepage",
  "thefootnote",
  "theenumi",
  "theenumii",
  "theenumiii",
  "theenumiv",
  "labelitemi",
  "labelitemii",
  "labelitemiii",
  "labelitemiv",
  "labelenumi",
  "labelenumii",
  "labelenumiii",
  "labelenumiv",
  "contentsname",
  "refname",
  "abstractname",
  "figurename",
  "tablename",
]);

export type EnvironmentSpec =
  | { role: "list"; variant: ListVariant }
  | { role: "special"; id: "document" | "abstract" | "verbatim" }
  | { role: "unsupported"; detail: string };

export const BUILTIN_ENVIRONMENTS: Readonly<Record<string, EnvironmentSpec>> = {
  document: { role: "special", id: "document" },
  abstract: { role: "special", id: "abstract" },
  verbatim: { role: "special", id: "verbatim" },
  itemize: { role: "list", variant: "itemize" },
  enumerate: { role: "list", variant: "enumerate" },
  description: { role: "list", variant: "description" },

  // Known LaTeX, deliberately not implemented.
  figure: { role: "unsupported", detail: "floats are out of scope for brief 37" },
  "figure*": { role: "unsupported", detail: "floats are out of scope for brief 37" },
  table: { role: "unsupported", detail: "floats are out of scope for brief 37" },
  "table*": { role: "unsupported", detail: "floats are out of scope for brief 37" },
  wrapfigure: { role: "unsupported", detail: "floats are out of scope for brief 37" },
  tabular: { role: "unsupported", detail: "tables are out of scope for brief 37" },
  tabularx: { role: "unsupported", detail: "tables are out of scope for brief 37" },
  longtable: { role: "unsupported", detail: "tables are out of scope for brief 37" },
  array: { role: "unsupported", detail: "math is brief 40" },
  equation: { role: "unsupported", detail: "math is brief 40" },
  "equation*": { role: "unsupported", detail: "math is brief 40" },
  align: { role: "unsupported", detail: "math is brief 40" },
  "align*": { role: "unsupported", detail: "math is brief 40" },
  gather: { role: "unsupported", detail: "math is brief 40" },
  eqnarray: { role: "unsupported", detail: "math is brief 40" },
  displaymath: { role: "unsupported", detail: "math is brief 40" },
  math: { role: "unsupported", detail: "math is brief 40" },
  thebibliography: { role: "unsupported", detail: "bibliographies are brief 39" },
  center: { role: "unsupported", detail: "centred text is out of scope for brief 37" },
  flushleft: { role: "unsupported", detail: "ragged text is out of scope for brief 37" },
  flushright: { role: "unsupported", detail: "ragged text is out of scope for brief 37" },
  quote: { role: "unsupported", detail: "block quotations are out of scope for brief 37" },
  quotation: { role: "unsupported", detail: "block quotations are out of scope for brief 37" },
  verse: { role: "unsupported", detail: "verse is out of scope for brief 37" },
  minipage: { role: "unsupported", detail: "boxes are out of scope for brief 37" },
  tikzpicture: { role: "unsupported", detail: "TikZ/pgf is out of scope" },
  lstlisting: { role: "unsupported", detail: "the listings package is out of scope; use verbatim" },
  Verbatim: { role: "unsupported", detail: "the fancyvrb package is out of scope; use verbatim" },
  multicols: { role: "unsupported", detail: "multi-column layout is out of scope" },
  titlepage: { role: "unsupported", detail: "custom title pages are out of scope for brief 37" },
  list: { role: "unsupported", detail: "the generic list environment is out of scope for brief 37" },
  trivlist: { role: "unsupported", detail: "the generic list environment is out of scope for brief 37" },
  picture: { role: "unsupported", detail: "the picture environment is out of scope" },
  theorem: { role: "unsupported", detail: "theorem environments are out of scope for brief 37" },
  proof: { role: "unsupported", detail: "theorem environments are out of scope for brief 37" },
};

export function lookupCommand(name: string): BuiltinSpec | undefined {
  return Object.prototype.hasOwnProperty.call(BUILTIN_COMMANDS, name) ? BUILTIN_COMMANDS[name] : undefined;
}

export function lookupEnvironment(name: string): EnvironmentSpec | undefined {
  return Object.prototype.hasOwnProperty.call(BUILTIN_ENVIRONMENTS, name)
    ? BUILTIN_ENVIRONMENTS[name]
    : undefined;
}

/** Whether the engine has *heard of* a command, whatever it does with it. */
export function isKnownCommand(name: string): boolean {
  return DEFINITION_COMMANDS.has(name) || lookupCommand(name) !== undefined;
}
