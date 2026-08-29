import type { Diagnostic, SourceRef } from "../diagnostics.ts";
import { error, unsupported } from "../diagnostics.ts";

/**
 * The subset gate (D41). MathJax will happily set things brief 40 declared
 * **Out** — `\begin{cases}` and `\DeclareMathOperator` both render clean — and
 * the owner's call is to refuse them anyway. A subset engine whose subset is
 * not precisely knowable cannot honour D38's promise that an unimplemented
 * construct *says so*, and "it happened to work" is not a contract.
 *
 * **The gate reads the MathML, not the TeX source, and that is the whole
 * point.** Macros expand: `\newcommand{\c}{\begin{cases}…\end{cases}}\c` has no
 * `cases` anywhere in its source, and a source-level regex would wave it
 * through. MathJax's MathML records what was *actually used* — the `<mrow>`
 * that environment produced carries `data-latex="\begin{cases}…"` even when the
 * document only ever wrote `\c`. That attribute is the gate's evidence.
 *
 * ## What is checked
 *
 * Every element except the root `<math>`, on two axes:
 *
 * 1. **The element name**, against `ALLOWED_ELEMENTS`. This is the backstop: if
 *    MathJax emits a node type nothing in the In list produces (`mmultiscripts`
 *    from `\sideset`, say), the construct is out of subset whatever its
 *    `data-latex` says.
 * 2. **The head of its `data-latex`** — the environment or command that
 *    *produced* that node — against `ALLOWED_ENVIRONMENTS` / `ALLOWED_COMMANDS`.
 *
 * The root `<math>` is skipped deliberately: its `data-latex` is the whole run
 * echoed back verbatim, so reading it would be exactly the source-level regex
 * this design rejects.
 *
 * ## Why symbols are a rule rather than a list
 *
 * The In list admits symbols **by category** — "Greek, relations, operators,
 * arrows" — and TeX has well over a thousand of them. Enumerating those names
 * would be a list nobody could maintain, and a stale one would refuse `\varrho`
 * while claiming to be precise, which is worse than the rule below.
 *
 * So: a command whose MathML node is a **token element** (`mi`/`mo`/`mn`) whose
 * `data-latex` is *nothing but* command tokens is treated as a symbol or an
 * operator name. That is exactly the shape of a symbol — it takes no argument,
 * and it becomes one glyph (or, for `\lim`/`\sin`, one upright word). Anything
 * that takes an argument produces structure instead (`\operatorname{foo}` is an
 * `mi` whose `data-latex` carries braces; `\mathsf{s}` is an `mrow`), so it
 * falls through to the explicit allowlist and is refused there.
 *
 * The check is per-expression: a command is a symbol because *this* expression
 * shows MathJax rendering it as one, never because a table said so.
 *
 * ## Why the "known unsupported" tables exist
 *
 * `bridge.ts` drops MathJax's `require` and `autoload` packages, so `\color`,
 * `\href`, `\cancel`, `\require` and friends come back as **"Undefined control
 * sequence"**. They are real LaTeX that Atrium declined, not typos, and D38 is
 * explicit that conflating `unsupported` with `undefined-command` makes the
 * diagnostic useless to a writer. The tables below are what keeps that
 * distinction honest, and they are the same shape `builtins.ts` already uses
 * for brief 39's `\rotatebox` and `\multirow`.
 */

/**
 * The MathML element vocabulary brief 40's In list actually produces, measured
 * against `mathjax@4.1.3` rather than assumed.
 *
 * `mpadded` and `mphantom` are in because allowed constructs emit them
 * internally (`\overrightarrow` pads its arrow), not because `\phantom` is
 * supported — the command gate refuses that, and keeping the element here means
 * one diagnostic naming `\phantom` instead of two naming a MathML detail the
 * author never wrote. `mlabeledtr` is how a numbered `equation` carries its tag.
 */
export const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  "math",
  "mfrac",
  "mi",
  "mlabeledtr",
  "mn",
  "mo",
  "mover",
  "mpadded",
  "mphantom",
  "mroot",
  "mrow",
  "mspace",
  "msqrt",
  "mstyle",
  "msub",
  "msubsup",
  "msup",
  "mtable",
  "mtd",
  "mtext",
  "mtr",
  "munder",
  "munderover",
]);

/** Token elements: the ones whose `data-latex` can name a bare symbol. */
const TOKEN_ELEMENTS: ReadonlySet<string> = new Set(["mi", "mn", "mo"]);

/**
 * The structural half of brief 40's In list, command by command. Symbols and
 * operator names are **not** here — they come in through the token rule above.
 *
 * Read this as the brief's Scope section transcribed, not as a wishlist: every
 * entry maps to a bullet there, and the two commands that look like padding
 * (`\limits`/`\nolimits`) are the bullet "sums/products/integrals with limits in
 * both inline and display style".
 */
export const ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  // Fractions and binomials.
  "\\frac",
  "\\dfrac",
  "\\tfrac",
  "\\binom",
  "\\dbinom",
  "\\tbinom",
  // Radicals.
  "\\sqrt",
  // Limit placement on big operators.
  "\\limits",
  "\\nolimits",
  // Over- and underbraces.
  "\\overbrace",
  "\\underbrace",
  // Accents.
  "\\hat",
  "\\widehat",
  "\\tilde",
  "\\widetilde",
  "\\bar",
  "\\overline",
  "\\underline",
  "\\vec",
  "\\overrightarrow",
  "\\overleftarrow",
  "\\dot",
  "\\ddot",
  "\\dddot",
  "\\ddddot",
  "\\acute",
  "\\grave",
  "\\check",
  "\\breve",
  "\\mathring",
  // Delimiters that grow.
  "\\left",
  "\\right",
  "\\middle",
  "\\big",
  "\\Big",
  "\\bigg",
  "\\Bigg",
  "\\bigl",
  "\\Bigl",
  "\\biggl",
  "\\Biggl",
  "\\bigr",
  "\\Bigr",
  "\\biggr",
  "\\Biggr",
  "\\bigm",
  "\\Bigm",
  "\\biggm",
  "\\Biggm",
  // Math alphabets — the five the brief names, plus `\boldsymbol`, which the
  // owner admitted on 2026-08-29 as common enough in ordinary papers to be
  // worth the widening. `\mathsf`, `\mathtt` and `\mathfrak` are real and
  // render fine, and stay refused: the In list is an allowlist ("and nothing
  // beyond it"), and widening it is a decision for whoever owns the brief, not
  // for the gate.
  "\\mathbb",
  "\\mathcal",
  "\\mathrm",
  "\\mathbf",
  "\\mathit",
  "\\boldsymbol",
  // Style selection. `\displaystyle` is admitted for the same reason as
  // `\boldsymbol`: an ordinary paper reaches for it constantly to get a
  // full-size fraction or sum inline. Its siblings stay refused.
  "\\displaystyle",
  // Text inside math.
  "\\text",
  // Explicit spacing — implied by the amsmath subset the In list admits.
  "\\,",
  "\\:",
  "\\;",
  "\\!",
  "\\ ",
  "\\quad",
  "\\qquad",
  "\\thinspace",
  "\\medspace",
  "\\thickspace",
  "\\negthinspace",
  "\\negmedspace",
  "\\negthickspace",
  // Equation numbering, for the display environments.
  "\\notag",
  "\\nonumber",
]);

/** The math environments the In list names. `cases` is deliberately absent. */
export const ALLOWED_ENVIRONMENTS: ReadonlySet<string> = new Set([
  "math",
  "displaymath",
  "equation",
  "equation*",
  "align",
  "align*",
  "gather",
  "gather*",
  "split",
  "matrix",
  "pmatrix",
  "bmatrix",
  "Bmatrix",
  "vmatrix",
  "Vmatrix",
  "array",
]);

/**
 * The text-mode gap, measured rather than guessed. MathJax's `textmacros`
 * package gives `\text{}` the accent commands (`\'`, `` \` ``, `\^`, `\"`,
 * `\~`, `\=`, `\.`, `\u`, `\v`) and stops there — the ligature and
 * special-letter macros, the remaining accents and the symbol macros are all
 * undefined inside it.
 *
 * Every one of them is real LaTeX, so every one of them is `unsupported` and
 * never `undefined-command`. The advice they carry is checked: a literal
 * `\text{Stra\u00dfe}`, `\text{caf\u00e9 na\u00efve}` and `\text{\u0153uvre}`
 * all set correctly, so "write the character" is a real instruction rather than
 * a shrug.
 */
const TEXT_MODE_LITERAL =
  "MathJax's text mode inside math does not define it — write the character itself (\u201c\\text{Stra\u00dfe}\u201d, not \u201c\\text{Stra\\ss e}\u201d)";
const TEXT_MODE_ACCENT =
  "MathJax's text mode inside math implements \\', \\`, \\^, \\\", \\~, \\=, \\. , \\u and \\v only — write the accented character itself";
const TEXT_MODE_SYMBOL = "MathJax's text mode inside math does not define it — write the character itself";

/**
 * Real LaTeX that MathJax no longer defines here, because `bridge.ts` drops the
 * packages that would load it. Without this table each of these would be
 * reported as `undefined-command` — telling an author that `\color` is not a
 * thing, which is false. The value is the `detail` the diagnostic carries.
 *
 * Anything **not** listed and still undefined really is undefined (a typo, or a
 * `\newcommand` the document never wrote), and gets `undefined-command`.
 */
export const KNOWN_UNSUPPORTED_COMMANDS: ReadonlyMap<string, string> = new Map([
  ["\\require", "loading extra MathJax components is disabled — a document must not choose what the engine loads"],
  ["\\color", "colour in math is out of brief 40's subset"],
  ["\\textcolor", "colour in math is out of brief 40's subset"],
  ["\\colorbox", "colour in math is out of brief 40's subset"],
  ["\\fcolorbox", "colour in math is out of brief 40's subset"],
  ["\\href", "links inside math are out of brief 40's subset"],
  ["\\class", "CSS hooks are meaningless in a PDF"],
  ["\\style", "CSS hooks are meaningless in a PDF"],
  ["\\cssId", "CSS hooks are meaningless in a PDF"],
  ["\\bbox", "boxed and background-filled math is out of brief 40's subset"],
  ["\\cancel", "strike-through math (the `cancel` package) is out of brief 40's subset"],
  ["\\bcancel", "strike-through math (the `cancel` package) is out of brief 40's subset"],
  ["\\xcancel", "strike-through math (the `cancel` package) is out of brief 40's subset"],
  ["\\cancelto", "strike-through math (the `cancel` package) is out of brief 40's subset"],
  ["\\enclose", "enclosure notation is out of brief 40's subset"],
  ["\\unicode", "raw code-point escapes are out of brief 40's subset — write the character"],
  ["\\verb", "verbatim inside math is out of brief 40's subset"],
  ["\\mathtip", "tooltips are meaningless in a PDF"],
  ["\\texttip", "tooltips are meaningless in a PDF"],
  ["\\toggle", "interactive math is meaningless in a PDF"],
  ["\\ce", "mhchem is out of brief 40's subset"],
  ["\\pu", "mhchem is out of brief 40's subset"],
  ["\\bra", "the `physics`/`braket` packages are out of brief 40's subset"],
  ["\\ket", "the `physics`/`braket` packages are out of brief 40's subset"],
  ["\\braket", "the `physics`/`braket` packages are out of brief 40's subset"],
  ["\\dv", "the `physics` package is out of brief 40's subset"],
  ["\\pdv", "the `physics` package is out of brief 40's subset"],
  ["\\qty", "the `physics` package is out of brief 40's subset"],
  ["\\SI", "siunitx is out of brief 40's subset"],
  ["\\si", "siunitx is out of brief 40's subset"],
  ["\\num", "siunitx is out of brief 40's subset"],
  ["\\ang", "siunitx is out of brief 40's subset"],
  ["\\bm", "use `\\mathbf` — `\\bm` is out of brief 40's subset"],
  ["\\mathscr", "brief 40 sets `\\mathbb`, `\\mathcal`, `\\mathrm`, `\\mathbf` and `\\mathit` and no other alphabet"],
  ["\\DeclareMathAlphabet", "custom math alphabets are out of brief 40's subset"],
  ["\\newtheorem", "theorem environments are out of brief 40's subset"],
  ["\\theoremstyle", "theorem environments are out of brief 40's subset"],
  ["\\ss", TEXT_MODE_LITERAL],
  ["\\aa", TEXT_MODE_LITERAL],
  ["\\AA", TEXT_MODE_LITERAL],
  ["\\o", TEXT_MODE_LITERAL],
  ["\\O", TEXT_MODE_LITERAL],
  ["\\ae", TEXT_MODE_LITERAL],
  ["\\AE", TEXT_MODE_LITERAL],
  ["\\oe", TEXT_MODE_LITERAL],
  ["\\OE", TEXT_MODE_LITERAL],
  ["\\l", TEXT_MODE_LITERAL],
  ["\\L", TEXT_MODE_LITERAL],
  ["\\i", TEXT_MODE_LITERAL],
  ["\\j", TEXT_MODE_LITERAL],
  ["\\H", TEXT_MODE_ACCENT],
  ["\\c", TEXT_MODE_ACCENT],
  ["\\k", TEXT_MODE_ACCENT],
  ["\\d", TEXT_MODE_ACCENT],
  ["\\b", TEXT_MODE_ACCENT],
  ["\\r", TEXT_MODE_ACCENT],
  ["\\dag", TEXT_MODE_SYMBOL],
  ["\\ddag", TEXT_MODE_SYMBOL],
  ["\\P", TEXT_MODE_SYMBOL],
  ["\\pounds", TEXT_MODE_SYMBOL],
  ["\\copyright", TEXT_MODE_SYMBOL],
  ["\\LaTeX", TEXT_MODE_SYMBOL],
  ["\\TeX", TEXT_MODE_SYMBOL],
]);

/**
 * The same distinction for environments. `Unknown environment 'CD'` must not be
 * reported as `undefined-environment` — amscd is real, we declined it.
 *
 * A theorem environment the document defined itself is not listed and will read
 * as `undefined-environment`, which is correct: `\newtheorem`, the command that
 * would have defined it, is refused above with its own `unsupported`.
 */
export const KNOWN_UNSUPPORTED_ENVIRONMENTS: ReadonlyMap<string, string> = new Map([
  ["CD", "commutative diagrams (amscd) are out of brief 40's subset"],
  ["tikzpicture", "TikZ is out of brief 40's subset"],
  ["tikzcd", "commutative diagrams (tikz-cd) are out of brief 40's subset"],
  ["theorem", "theorem environments are out of brief 40's subset"],
  ["lemma", "theorem environments are out of brief 40's subset"],
  ["proposition", "theorem environments are out of brief 40's subset"],
  ["corollary", "theorem environments are out of brief 40's subset"],
  ["definition", "theorem environments are out of brief 40's subset"],
  ["remark", "theorem environments are out of brief 40's subset"],
  ["proof", "theorem environments are out of brief 40's subset"],
]);

/** The head of a node's `data-latex`: what produced that node. */
type Head =
  | { readonly kind: "command"; readonly name: string }
  | { readonly kind: "environment"; readonly name: string };

/**
 * `<tag attr="value" …>`, non-greedy on nothing. MathJax's serialiser always
 * double-quotes and always XML-escapes, so a `"` or a `>` can never appear
 * inside a value — which is what makes scanning safe without a parser here.
 * `</close>` tags do not match: `<` must be followed by a letter.
 */
const TAG_PATTERN = /<([A-Za-z][\w.:-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*\/?>/g;

const DATA_LATEX_PATTERN = /\bdata-latex\s*=\s*"([^"]*)"/;

/** A command token: a backslash then letters, or a backslash then one character. */
const COMMAND_PATTERN = /\\(?:[A-Za-z]+|[\s\S])/y;

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * What produced this node. `\begin{…}` first, because `\begin` is itself a
 * command and would otherwise swallow the environment name.
 */
export function headOf(latex: string): Head | null {
  const source = latex.replace(/^\s+/, "");
  const environment = /^\\begin\{([^}]*)\}/.exec(source);
  if (environment !== null) return { kind: "environment", name: environment[1] ?? "" };
  const letters = /^\\[A-Za-z]+/.exec(source);
  if (letters !== null) return { kind: "command", name: letters[0] };
  const single = /^\\[\s\S]/.exec(source);
  if (single !== null) return { kind: "command", name: single[0] };
  return null;
}

/**
 * Every command in `latex`, or `null` if `latex` holds anything that is not a
 * command token — a brace, a letter, a digit, a delimiter.
 *
 * The `null` case is what stops `\displaystyle x` (an `mi` whose `data-latex`
 * is a command *and* a literal `x`) from smuggling `\displaystyle` in through
 * the symbol rule. It is also why merged relations survive: MathJax coalesces
 * `\rightarrow\longrightarrow` into one `<mo>`, and both are commands.
 */
export function commandsOnly(latex: string): readonly string[] | null {
  const commands: string[] = [];
  let index = 0;
  while (index < latex.length) {
    if (/\s/.test(latex[index] ?? "")) {
      index += 1;
      continue;
    }
    if (latex[index] !== "\\") return null;
    COMMAND_PATTERN.lastIndex = index;
    const match = COMMAND_PATTERN.exec(latex);
    if (match === null) return null;
    commands.push(match[0]);
    index = COMMAND_PATTERN.lastIndex;
  }
  return commands.length > 0 ? commands : null;
}

interface ScannedTag {
  readonly name: string;
  readonly latex: string | null;
}

function scanTags(mathml: string): ScannedTag[] {
  const tags: ScannedTag[] = [];
  TAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_PATTERN.exec(mathml)) !== null) {
    const attributes = match[2] ?? "";
    const latex = DATA_LATEX_PATTERN.exec(attributes);
    tags.push({ name: match[1] ?? "", latex: latex === null ? null : unescapeXml(latex[1] ?? "") });
  }
  return tags;
}

/**
 * Gate one rendered expression. Returns the diagnostics that make it refusable
 * — empty means every construct in it is inside brief 40's In list.
 *
 * `mathml` is `MathJax.tex2mml(…)` output for the run, **before** any SVG has
 * been asked for: an expression that fails here never gets drawn, so a refused
 * construct cannot leak into a PDF as a picture nobody gated.
 *
 * At most one diagnostic per distinct construct, because a matrix of `\mathsf`
 * cells is one decision the author has to make, not thirty.
 */
export function checkMathSubset(mathml: string, at: SourceRef): Diagnostic[] {
  const tags = scanTags(mathml);
  if (tags.length === 0 || tags[0]?.name !== "math") {
    // MathJax always serialises a `<math>` root. Not finding one means its
    // output shape changed under us, which is an engine problem and not the
    // document's fault — say so rather than gating whatever this is.
    return [error("internal", at, "MathJax produced MathML with no <math> root; the math bridge cannot gate it")];
  }

  // Pass one: which commands did MathJax render as bare tokens? Collected over
  // the whole expression, because the node that proves `\alpha` is a symbol is
  // not always the node that mentions it (a group's `data-latex` names the
  // first command inside it).
  const symbols = new Set<string>();
  for (let index = 1; index < tags.length; index += 1) {
    const tag = tags[index];
    if (tag === undefined || tag.latex === null) continue;
    if (!TOKEN_ELEMENTS.has(tag.name)) continue;
    const commands = commandsOnly(tag.latex);
    if (commands === null) continue;
    for (const command of commands) symbols.add(command);
  }

  const diagnostics: Diagnostic[] = [];
  const reported = new Set<string>();
  const refuse = (construct: string, detail: string): void => {
    if (reported.has(construct)) return;
    reported.add(construct);
    diagnostics.push(unsupported(at, construct, detail));
  };

  for (let index = 1; index < tags.length; index += 1) {
    const tag = tags[index];
    if (tag === undefined) continue;

    if (!ALLOWED_ELEMENTS.has(tag.name)) {
      refuse(
        tag.name,
        `MathJax rendered this run with a <${tag.name}>, which nothing in brief 40's supported subset produces`,
      );
      continue;
    }

    if (tag.latex === null) continue;
    const head = headOf(tag.latex);
    if (head === null) continue;

    if (head.kind === "environment") {
      if (ALLOWED_ENVIRONMENTS.has(head.name)) continue;
      refuse(
        head.name,
        KNOWN_UNSUPPORTED_ENVIRONMENTS.get(head.name) ??
          "MathJax can set it, but it is outside brief 40's declared math subset (D41)",
      );
      continue;
    }

    if (ALLOWED_COMMANDS.has(head.name) || symbols.has(head.name)) continue;
    refuse(
      head.name,
      KNOWN_UNSUPPORTED_COMMANDS.get(head.name) ??
        "MathJax can set it, but it is outside brief 40's declared math subset (D41)",
    );
  }

  return diagnostics;
}
