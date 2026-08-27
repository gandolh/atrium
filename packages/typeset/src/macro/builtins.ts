import type { FloatClass, FontSelection, HeadingLevel, ListVariant } from "../doc/model.ts";

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
  | "listoffigures"
  | "listoftables"
  | "caption"
  | "includegraphics"
  | "cite"
  | "citep"
  | "citet"
  | "nocite"
  | "bibliography"
  | "bibliographystyle"
  | "label"
  | "ref"
  | "pageref"
  | "footnote"
  | "item"
  | "linebreak"
  | "pagebreak"
  | "noindent"
  | "today"
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

  // --- floats (brief 39) ---
  caption: { role: "special", id: "caption" },
  listoffigures: { role: "special", id: "listoffigures" },
  listoftables: { role: "special", id: "listoftables" },
  includegraphics: { role: "special", id: "includegraphics" },

  // --- bibliography (brief 39) ---
  cite: { role: "special", id: "cite" },
  citep: { role: "special", id: "citep" },
  citet: { role: "special", id: "citet" },
  nocite: { role: "special", id: "nocite" },
  bibliography: { role: "special", id: "bibliography" },
  bibliographystyle: { role: "special", id: "bibliographystyle" },

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
  // `\input`/`\include` are deliberately *not* here. `doc/index.ts`'s
  // `resolveInputs()` runs on the raw parse tree, before macro expansion and
  // before this table is ever consulted, and it recurses into every group,
  // environment and command argument (`\newcommand` bodies included) to find
  // and consume every literal `\input`/`\include` node there is — with its
  // own diagnostics (`syntax` for no filename, `missing-file`, a self-include
  // cycle). A `command` node named "input" or "include" therefore never
  // survives to reach this table at all (confirmed: not even one buried
  // inside an unused macro definition, which is the shape that looks most
  // likely to slip through). A row here, and the `case "input"` it used to
  // route to in `applySpecial`, promised to catch a case that could not
  // occur — dead code that claims to handle something it cannot reach, which
  // is worse than no code (chunk 8). Removed rather than kept "just in
  // case": if `resolveInputs` ever regresses, the honest failure is
  // `undefined-command`, not a message about a case this table cannot prove
  // it still catches.
  verb: { role: "special", id: "verb" },
  // `\protect` and friends only matter to a macro processor with fragile
  // arguments; here they are genuinely nothing, which is why they are the only
  // commands allowed to do nothing.
  protect: { role: "special", id: "ignore" },
  relax: { role: "special", id: "ignore" },
  ignorespaces: { role: "special", id: "ignore" },

  // --- real LaTeX we do not implement (brief-scoped) ---
  centering: unimplemented("centred text is out of scope for brief 37"),
  // `\bibitem` is real LaTeX, and inside `thebibliography` it *is* implemented
  // — but never through this table: `applyBibliography` in `doc/build.ts` reads
  // the environment's body and consumes each `\bibitem` node structurally, the
  // same way `applyList` consumes `\item`. So this row is reached only by a
  // `\bibitem` written outside any `thebibliography`, where the honest answer
  // is that nothing implements it.
  bibitem: unimplemented("\\bibitem is only recognised inside a thebibliography environment"),
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
  // Readable inside `\includegraphics`'s `width=`/`height=` keys and a `p{}`
  // column, where `doc/build.ts` reads the register out of the raw nodes
  // without ever consulting this table. On its own it is a length register,
  // and length registers are out of scope.
  textwidth: unimplemented("length registers are out of scope, except as \\includegraphics's width=/height= and a p{} column's width"),
  linewidth: unimplemented("length registers are out of scope, except as \\includegraphics's width=/height= and a p{} column's width"),
  columnwidth: unimplemented("length registers are out of scope, except as \\includegraphics's width=/height= and a p{} column's width"),
  textheight: unimplemented("length registers are out of scope, except as \\includegraphics's width=/height= and a p{} column's width"),
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

  // --- real LaTeX we do not implement (brief 39's Out list, chunk 39.6) ---
  // These four command names were, until this chunk, in no table at all —
  // which made them `undefined-command`, telling an author that `\rotatebox`
  // or `\multirow` are not real LaTeX. They are: `\rotatebox` is graphicx,
  // `\multirow` is the multirow package, and `\toprule`/`\midrule`/
  // `\bottomrule`/`\cmidrule` are booktabs. Brief 39 lists all of them as
  // things this engine deliberately declined, so the honest diagnostic is
  // `unsupported`, matching how `wrapfigure`/`tabularx`/`longtable` (a few
  // rows and one table up) already report. `detail` says *why brief 39
  // stops here*, not "not yet" — there is no brief that picks this back up.
  rotatebox: unimplemented("graphicx's \\rotatebox is out of scope for brief 39; images are placed unrotated"),
  toprule: unimplemented("the booktabs package is out of scope for brief 39; only \\hline and \\cline are implemented"),
  midrule: unimplemented("the booktabs package is out of scope for brief 39; only \\hline and \\cline are implemented"),
  bottomrule: unimplemented("the booktabs package is out of scope for brief 39; only \\hline and \\cline are implemented"),
  cmidrule: unimplemented("the booktabs package is out of scope for brief 39; only \\hline and \\cline are implemented"),
  multirow: unimplemented("the multirow package is out of scope for brief 39; every cell spans exactly one row"),
  // `subcaption` (the package's per-image `\subcaption` command) is here;
  // its `subfigure` *environment* is the matching row in
  // `BUILTIN_ENVIRONMENTS` below.
  subcaption: unimplemented("the subcaption package is out of scope for brief 39"),

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
  /**
   * A float environment. `class` picks the counter, the `\listof...` and the
   * caption name; `spanning` is the `*` form. A role rather than four `special`
   * ids because the four differ only in these two flags.
   */
  | { role: "float"; class: FloatClass; spanning: boolean }
  | { role: "special"; id: "document" | "abstract" | "verbatim" | "tabular" | "thebibliography" }
  | { role: "unsupported"; detail: string };

export const BUILTIN_ENVIRONMENTS: Readonly<Record<string, EnvironmentSpec>> = {
  document: { role: "special", id: "document" },
  abstract: { role: "special", id: "abstract" },
  verbatim: { role: "special", id: "verbatim" },
  itemize: { role: "list", variant: "itemize" },
  enumerate: { role: "list", variant: "enumerate" },
  description: { role: "list", variant: "description" },

  // --- brief 39 ---
  figure: { role: "float", class: "figure", spanning: false },
  "figure*": { role: "float", class: "figure", spanning: true },
  table: { role: "float", class: "table", spanning: false },
  "table*": { role: "float", class: "table", spanning: true },
  tabular: { role: "special", id: "tabular" },
  thebibliography: { role: "special", id: "thebibliography" },

  // Known LaTeX, deliberately not implemented.
  wrapfigure: { role: "unsupported", detail: "text wrapped around a float is out of scope (brief 39's Out list)" },
  tabularx: { role: "unsupported", detail: "only plain tabular is implemented (brief 39's Out list)" },
  longtable: { role: "unsupported", detail: "only plain tabular is implemented (brief 39's Out list)" },
  // The subcaption package's environment (its `\subcaption` command is the
  // matching row in `BUILTIN_COMMANDS` above). Was previously in no table at
  // all, which reported `undefined-environment` — a false claim that no such
  // environment exists, for a package brief 39 names as declined on purpose.
  subfigure: { role: "unsupported", detail: "the subcaption package is out of scope for brief 39" },
  array: { role: "unsupported", detail: "math is brief 40" },
  equation: { role: "unsupported", detail: "math is brief 40" },
  "equation*": { role: "unsupported", detail: "math is brief 40" },
  align: { role: "unsupported", detail: "math is brief 40" },
  "align*": { role: "unsupported", detail: "math is brief 40" },
  gather: { role: "unsupported", detail: "math is brief 40" },
  eqnarray: { role: "unsupported", detail: "math is brief 40" },
  displaymath: { role: "unsupported", detail: "math is brief 40" },
  math: { role: "unsupported", detail: "math is brief 40" },
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
