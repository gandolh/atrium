import type {
  DisplayMathVariant,
  FloatClass,
  FontSelection,
  HeadingLevel,
  ListVariant,
} from "../doc/model.ts";

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
  /**
   * Real LaTeX that is only meaningful **inside math mode** — `\frac`,
   * `\alpha`, `\left` (brief 40). Written outside `$…$` there is nothing for
   * it to set, and real LaTeX refuses it too ("Missing $ inserted"), so it
   * produces a diagnostic naming the reason. Written *inside* math it never
   * reaches this table at all: the body of a math run is printed back to TeX
   * and handed to the renderer, never walked as document material.
   *
   * A separate role rather than an `unsupported` row per name because the
   * message is one message and the list is two hundred names long — and
   * because a reader of this table needs to see at a glance that `\frac` **is**
   * implemented, just not here. Same idea as `\bibitem`'s row, which says the
   * same thing about `thebibliography`.
   */
  | { role: "math-only" }
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

// --- mathematics (brief 40) -------------------------------------------------

/**
 * The math allowlist, and the reason it exists.
 *
 * D41 §5 is the owner's explicit call: **math is gated to brief 40's In list**,
 * even where MathJax would happily render more. The recommendation was the
 * opposite — accept MathJax's surface and treat the Out list as "not promised"
 * — and it was overridden deliberately, because a subset engine whose subset is
 * not precisely knowable cannot honour D38's promise that an unimplemented
 * construct *says so*. The cost accepted with it: this list has to be
 * maintained by hand, and it refuses constructs that demonstrably work.
 *
 * The gate has two halves and this file holds the data for both:
 *
 * 1. **Names written outside math mode** reach `BUILTIN_COMMANDS` /
 *    `BUILTIN_ENVIRONMENTS` like any other command, so the In-list names appear
 *    there with `role: "math-only"` — `\frac` is real LaTeX and must never
 *    report `undefined-command`, but outside `$…$` there is nothing for it to
 *    set. Same shape as `\bibitem`'s row, which says the same thing about
 *    `thebibliography`.
 * 2. **Names written inside math mode** never reach those tables at all: the
 *    body of a math run is not walked, it is printed back to TeX and handed to
 *    the renderer. `doc/build.ts` walks it once more for the gate, and reports
 *    every name in `DECLINED_MATH_COMMANDS`/`DECLINED_MATH_ENVIRONMENTS`.
 *
 * That second half is a **name-level** gate on the *expanded* AST, and it is
 * deliberately not the whole gate D41 §5 describes. §5 asks for a gate on
 * MathJax's MathML output, because MathJax expands macros of its own that this
 * engine has never seen (`\implies`, `\to`'s aliases, the whole amsmath macro
 * layer) and the AST therefore cannot show what was really used. That gate
 * needs MathJax and belongs to chunk 40.2; this one catches everything a
 * document writes literally, which is every case an author can be told about by
 * line number, and it needs no renderer to work.
 */

/**
 * Every math command brief 40's In list promises to set. Chunk 40.2's MathML
 * gate reads this too — one list, so the two halves of the gate cannot drift.
 *
 * Grouped by the In list's own bullets. Names already in `BUILTIN_COMMANDS`
 * with a text-mode meaning (`\underline`, `\ldots`, `\dots`) are **not** here:
 * the explicit rows below win over the generated ones, and a command that means
 * something in both modes is not math-only.
 */
export const MATH_COMMANDS: readonly string[] = [
  // Structures: fractions, radicals, binomials, over/underbraces, big operators.
  "frac", "dfrac", "tfrac", "binom", "dbinom", "tbinom", "sqrt",
  "overbrace", "underbrace", "overline", "overrightarrow", "overleftarrow",
  "sum", "prod", "coprod", "int", "iint", "iiint", "oint", "bigcup", "bigcap",
  "bigoplus", "bigotimes", "bigvee", "bigwedge", "bigsqcup",
  // Limits in both styles — the In list names "sums/products/integrals with
  // limits in both inline and display style", which is what these four control.
  "limits", "nolimits", "displaystyle", "textstyle", "scriptstyle", "scriptscriptstyle",
  // Accents.
  "hat", "widehat", "bar", "vec", "dot", "ddot", "tilde", "widetilde",
  "check", "breve", "acute", "grave", "mathring",
  // Delimiters that grow.
  "left", "right", "middle",
  "big", "Big", "bigg", "Bigg",
  "bigl", "bigr", "Bigl", "Bigr", "biggl", "biggr", "Biggl", "Biggr",
  "bigm", "Bigm", "biggm", "Biggm",
  "langle", "rangle", "lvert", "rvert", "lVert", "rVert", "vert", "Vert",
  "lfloor", "rfloor", "lceil", "rceil", "backslash",
  // Math alphabets. The In list names five; `\mathsf` and `\mathtt` ride along
  // because they are LaTeX's own standard alphabets, set in faces this engine
  // already ships, and the Out list's "custom math alphabets" is about
  // `\DeclareMathAlphabet` and package faces like `\mathscr`, not these.
  "mathbb", "mathcal", "mathrm", "mathbf", "mathit", "mathsf", "mathtt", "mathnormal",
  "boldsymbol", "text",
  // Named operators (`\log`, `\sin`, …) — LaTeX's fixed set, not
  // `\DeclareMathOperator`'s, which is on the Out list.
  "log", "ln", "lg", "exp", "sin", "cos", "tan", "sec", "csc", "cot",
  "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "coth",
  "det", "dim", "gcd", "hom", "ker", "deg", "arg", "max", "min", "sup", "inf",
  "lim", "liminf", "limsup", "Pr", "bmod", "pmod", "mod",
  // Greek.
  "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta",
  "theta", "vartheta", "iota", "kappa", "lambda", "mu", "nu", "xi", "pi",
  "varpi", "rho", "varrho", "sigma", "varsigma", "tau", "upsilon", "phi",
  "varphi", "chi", "psi", "omega",
  "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Upsilon", "Phi",
  "Psi", "Omega",
  // Relations.
  "leq", "le", "geq", "ge", "neq", "ne", "equiv", "sim", "simeq", "approx",
  "cong", "propto", "ll", "gg", "subset", "supset", "subseteq", "supseteq",
  "in", "ni", "notin", "perp", "parallel", "mid", "prec", "succ", "preceq",
  "succeq", "asymp", "doteq", "models", "vdash", "dashv", "leqslant", "geqslant",
  // Binary operators and the rest of the symbol sweep.
  "times", "div", "pm", "mp", "cdot", "cdots", "vdots", "ddots",
  "ast", "star", "circ", "bullet", "oplus", "ominus", "otimes", "oslash",
  "odot", "cap", "cup", "sqcup", "sqcap", "setminus", "wedge", "vee",
  "land", "lor", "neg", "lnot", "forall", "exists", "nexists", "nabla",
  "partial", "infty", "emptyset", "varnothing", "hbar", "ell", "Re", "Im",
  "aleph", "angle", "triangle", "surd", "top", "bot", "prime", "colon",
  // Arrows.
  "to", "gets", "rightarrow", "leftarrow", "leftrightarrow",
  "Rightarrow", "Leftarrow", "Leftrightarrow",
  "longrightarrow", "longleftarrow", "longleftrightarrow",
  "Longrightarrow", "Longleftarrow", "Longleftrightarrow",
  "mapsto", "longmapsto", "hookrightarrow", "hookleftarrow",
  "uparrow", "downarrow", "updownarrow", "Uparrow", "Downarrow",
  "nearrow", "searrow", "swarrow", "nwarrow", "implies", "impliedby", "iff",
  // Math-mode spacing and numbering control. `\nonumber`/`\notag` are In
  // because the engine implements the numbering they suppress — `doc/build.ts`
  // reads them off the line and leaves `MathLine.number` null.
  "quad", "qquad", "nonumber", "notag",
];

/**
 * Every math environment brief 40's In list promises to set, and which display
 * variant each one is. `null` means it is a *structure* inside a formula
 * (`pmatrix`, `array`) rather than a display of its own, so it has no variant:
 * written inside math it is part of the TeX handed to the renderer, and written
 * outside math it is `math-only` like `\frac` is.
 *
 * `Bmatrix` and `Vmatrix` are here beside the four the brief names: the In list
 * bullet is "Matrices", and these two are the same construct with a different
 * pair of delimiters, set by the same MathJax code path.
 */
export const MATH_ENVIRONMENTS: Readonly<Record<string, DisplayMathVariant | null>> = {
  equation: "equation",
  "equation*": "equation*",
  displaymath: "displaymath",
  align: "align",
  "align*": "align*",
  gather: "gather",
  // `gather*` is the unnumbered `gather`, exactly as `align*` is the
  // unnumbered `align`. Brief 40's In list names `align*` and not `gather*`,
  // which reads as a transcription slip rather than a decision — the owner
  // confirmed it as one on 2026-08-29, so it is admitted with its pair.
  "gather*": "gather*",
  split: "split",
  matrix: null,
  pmatrix: null,
  bmatrix: null,
  Bmatrix: null,
  vmatrix: null,
  Vmatrix: null,
  array: null,
};

/**
 * Math commands brief 40 declines, and why. Every one of these is real LaTeX
 * that a real document could contain, so every one is `unsupported` and never
 * `undefined-command` — conflating the two is the bug D38 exists to prevent.
 *
 * Two of them, `\DeclareMathOperator` and (below) the `cases` environment,
 * render perfectly well in MathJax. They are refused anyway. That is D41 §5,
 * and it is the owner's call, not an oversight: see the note at the top of this
 * section for the trade it buys.
 */
export const DECLINED_MATH_COMMANDS: Readonly<Record<string, string>> = {
  DeclareMathOperator:
    "\\DeclareMathOperator defines a new operator, and brief 40 sets a fixed subset of math rather than executing definitions (its Out list; D41 §5 — MathJax renders it, and the engine declines it anyway so the supported subset stays knowable)",
  operatorname:
    "amsmath's \\operatorname is the inline form of \\DeclareMathOperator, on brief 40's Out list; the built-in operators (\\log, \\sin, \\lim and the rest) are implemented",
  // Custom math alphabets — the Out list item, and the package faces that come
  // with it. `\mathbb`/`\mathcal`/`\mathrm`/`\mathbf`/`\mathit` are In.
  DeclareMathAlphabet: "custom math alphabets are on brief 40's Out list",
  SetMathAlphabet: "custom math alphabets are on brief 40's Out list",
  DeclareSymbolFont: "custom math alphabets are on brief 40's Out list",
  DeclareMathSymbol: "custom math alphabets are on brief 40's Out list",
  mathscr: "\\mathscr needs a script face this engine does not ship; custom math alphabets are on brief 40's Out list",
  mathfrak: "\\mathfrak needs a fraktur face this engine does not ship; custom math alphabets are on brief 40's Out list",
  // mathtools.
  DeclarePairedDelimiter: "the mathtools package is on brief 40's Out list",
  coloneqq: "the mathtools package is on brief 40's Out list",
  mathclap: "the mathtools package is on brief 40's Out list",
  mathllap: "the mathtools package is on brief 40's Out list",
  mathrlap: "the mathtools package is on brief 40's Out list",
  shortintertext: "the mathtools package is on brief 40's Out list",
  prescript: "the mathtools package is on brief 40's Out list",
  // physics. `\qty` is siunitx v3's name too, so the message names both.
  dv: "the physics package is on brief 40's Out list",
  pdv: "the physics package is on brief 40's Out list",
  bra: "the physics package is on brief 40's Out list",
  ket: "the physics package is on brief 40's Out list",
  braket: "the physics package is on brief 40's Out list",
  ketbra: "the physics package is on brief 40's Out list",
  vb: "the physics package is on brief 40's Out list",
  va: "the physics package is on brief 40's Out list",
  vu: "the physics package is on brief 40's Out list",
  qty: "the physics and siunitx packages are both on brief 40's Out list, and both define \\qty",
  // siunitx.
  si: "the siunitx package is on brief 40's Out list",
  SI: "the siunitx package is on brief 40's Out list",
  num: "the siunitx package is on brief 40's Out list",
  ang: "the siunitx package is on brief 40's Out list",
  unit: "the siunitx package is on brief 40's Out list",
  qtylist: "the siunitx package is on brief 40's Out list",
  SIlist: "the siunitx package is on brief 40's Out list",
  // TikZ in math, and commutative diagrams.
  tikz: "TikZ in math is on brief 40's Out list; TikZ/pgf is out of scope everywhere",
  xymatrix: "commutative diagrams are on brief 40's Out list",
  // amsmath numbering machinery outside the In list. `\tag` in particular
  // would otherwise print a number this engine's equation counter never
  // issued, which is silently-wrong output rather than a missing feature.
  tag: "manual equation tags (\\tag) are outside brief 40's In list; an equation's number comes from the equation counter",
  eqref: "amsmath's \\eqref is outside brief 40's In list; \\ref to an equation prints its number without the parentheses",
  intertext: "amsmath's \\intertext is outside brief 40's In list",
  substack: "amsmath's \\substack is outside brief 40's In list",
  numberwithin: "amsmath's \\numberwithin is outside brief 40's In list; equations are numbered straight through the document, as article.cls numbers them",
};

/** Math environments brief 40 declines, and why. Same contract as the commands above. */
export const DECLINED_MATH_ENVIRONMENTS: Readonly<Record<string, string>> = {
  // The Out list names `cases` outright: "cases beyond what array gives".
  // MathJax renders it cleanly; it is refused anyway (D41 §5).
  cases: "brief 40's Out list names cases: an array inside \\left\\{ … \\right. sets the same thing (D41 §5 — MathJax renders cases, and the engine declines it anyway so the supported subset stays knowable)",
  dcases: "the mathtools package is on brief 40's Out list, and cases is on it too",
  rcases: "the mathtools package is on brief 40's Out list, and cases is on it too",
  // amsmath displays outside the In list, which is align, align*, gather,
  // split, equation, equation* and displaymath.
  aligned: "brief 40's In list covers align, align*, gather and split; the aligned box environment is not on it",
  alignedat: "brief 40's In list covers align, align*, gather and split; alignedat is not on it",
  alignat: "brief 40's In list covers align, align*, gather and split; alignat is not on it",
  "alignat*": "brief 40's In list covers align, align*, gather and split; alignat* is not on it",
  flalign: "brief 40's In list covers align, align*, gather and split; flalign is not on it",
  "flalign*": "brief 40's In list covers align, align*, gather and split; flalign* is not on it",
  multline: "brief 40's In list covers align, align*, gather and split; multline is not on it",
  "multline*": "brief 40's In list covers align, align*, gather and split; multline* is not on it",
  gathered: "brief 40's In list covers align, align*, gather and split; the gathered box environment is not on it",
  subequations: "amsmath's subequations renumbers a group of equations, and brief 40 numbers them straight through",
  smallmatrix: "brief 40's In list covers matrix, pmatrix, bmatrix, vmatrix and array; smallmatrix is not on it",
  // Commutative diagrams.
  tikzcd: "commutative diagrams are on brief 40's Out list; TikZ/pgf is out of scope everywhere",
  CD: "commutative diagrams are on brief 40's Out list",
  xy: "commutative diagrams are on brief 40's Out list",
};


/**
 * The `math-only` rows for every In-list math command, generated from
 * `MATH_COMMANDS` so that the allowlist has exactly one definition. Spread
 * **first** into `BUILTIN_COMMANDS`, so an explicit row below always wins: a
 * name that means something in text mode as well (`\underline`) is not
 * math-only, whatever a list of math symbols says.
 */
function mathOnlyCommandRows(): Record<string, BuiltinSpec> {
  const rows: Record<string, BuiltinSpec> = {};
  for (const name of MATH_COMMANDS) rows[name] = { role: "math-only" };
  return rows;
}

/** The `unsupported` rows for every declined math command, from one source. */
function declinedMathCommandRows(): Record<string, BuiltinSpec> {
  const rows: Record<string, BuiltinSpec> = {};
  for (const [name, detail] of Object.entries(DECLINED_MATH_COMMANDS)) {
    rows[name] = { role: "unsupported", detail };
  }
  return rows;
}

/** Every command name (without its backslash) the engine has heard of. */
export const BUILTIN_COMMANDS: Readonly<Record<string, BuiltinSpec>> = {
  // --- mathematics (brief 40) ---
  // Generated, and spread first so every explicit row below overrides them.
  ...mathOnlyCommandRows(),
  ...declinedMathCommandRows(),

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
  newtheorem: unimplemented("theorem environments are out of scope for brief 37, and \\newtheorem is on brief 40's Out list"),
  usetikzlibrary: unimplemented("TikZ/pgf is out of scope"),
  theoremstyle: unimplemented("theorem environments are on brief 40's Out list"),
  newtheoremstyle: unimplemented("theorem environments are on brief 40's Out list"),
  qedhere: unimplemented("theorem environments are on brief 40's Out list"),
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
  "theequation",
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
  /**
   * A display-math environment on brief 40's In list. `variant` is what
   * `DisplayMathBlock.variant` becomes, and it decides numbering and alignment
   * — the environment's *name* is kept on the block separately, because
   * `\begin{equation}` and `\begin{align}` differ in more than a label.
   */
  | { role: "display-math"; variant: DisplayMathVariant }
  /**
   * A math *structure* environment — `pmatrix`, `array`. Inside math it is part
   * of the TeX handed to the renderer and never reaches this table; outside
   * math there is nothing for it to set. The environment twin of
   * `BuiltinSpec`'s `math-only`, and reported the same way.
   */
  | { role: "math-only" }
  | { role: "unsupported"; detail: string };

/**
 * The `display-math` and `math-only` rows for every In-list math environment,
 * and the `unsupported` rows for every declined one — generated from
 * `MATH_ENVIRONMENTS` and `DECLINED_MATH_ENVIRONMENTS` so the allowlist and the
 * table cannot disagree.
 */
function mathEnvironmentRows(): Record<string, EnvironmentSpec> {
  const rows: Record<string, EnvironmentSpec> = {};
  for (const [name, variant] of Object.entries(MATH_ENVIRONMENTS)) {
    rows[name] = variant === null ? { role: "math-only" } : { role: "display-math", variant };
  }
  for (const [name, detail] of Object.entries(DECLINED_MATH_ENVIRONMENTS)) {
    rows[name] = { role: "unsupported", detail };
  }
  return rows;
}

export const BUILTIN_ENVIRONMENTS: Readonly<Record<string, EnvironmentSpec>> = {
  // --- mathematics (brief 40) ---
  // Generated, and spread first so every explicit row below overrides them.
  ...mathEnvironmentRows(),

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
  // The seven `math is brief 40` placeholders that stood here are gone: brief
  // 40 landed, and `equation`, `equation*`, `align`, `align*`, `gather`,
  // `displaymath` and `array` are now rows generated from `MATH_ENVIRONMENTS`
  // above. The two that stayed behind are the two brief 40 did *not* take.
  //
  // `math` is `\(…\)` written as an environment. Inline math is implemented,
  // but the In list names the two delimiter forms and not this one, and D41 §5
  // says the gate follows the In list even where the engine could obviously
  // set the thing — so it is declined explicitly rather than quietly allowed.
  // `\begin{math}` IS `\(…\)`, and `\(…\)` is In — so this reads like a slip in
  // the In list rather than a decision, and the owner agreed on 2026-08-29.
  // It is refused anyway, because it is not a table entry: `$…$` and `\(…\)`
  // reach the document layer as a parsed `MathNode` (the parser knows they
  // open math mode), while an environment's body is parsed as ordinary
  // content. Admitting it means re-parsing that body in math mode, which is
  // a parser change, not a widening. Refused with the spelling that works.
  math: { role: "unsupported", detail: "this engine reads inline math as $…$ or \\(…\\); the math environment would need its body re-parsed in math mode, so write \\(…\\) instead" },
  eqnarray: { role: "unsupported", detail: "eqnarray is deprecated even in LaTeX and is not on brief 40's In list; align sets the same thing" },
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
  // Theorem environments. `theorem` and `proof` were already here from brief
  // 37; the rest are the conventional `\newtheorem` names an author writes
  // beside them, and they were in no table at all — so a document using them
  // was told `lemma` is not a thing, when what is true is that brief 40 lists
  // theorem environments on its Out list. `\newtheorem` itself is a row in
  // `BUILTIN_COMMANDS` and reports the same way.
  theorem: { role: "unsupported", detail: "theorem environments are out of scope for brief 37, and are on brief 40's Out list" },
  proof: { role: "unsupported", detail: "theorem environments are out of scope for brief 37, and are on brief 40's Out list" },
  lemma: { role: "unsupported", detail: "theorem environments are on brief 40's Out list" },
  corollary: { role: "unsupported", detail: "theorem environments are on brief 40's Out list" },
  proposition: { role: "unsupported", detail: "theorem environments are on brief 40's Out list" },
  definition: { role: "unsupported", detail: "theorem environments are on brief 40's Out list" },
  remark: { role: "unsupported", detail: "theorem environments are on brief 40's Out list" },
  example: { role: "unsupported", detail: "theorem environments are on brief 40's Out list" },
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
