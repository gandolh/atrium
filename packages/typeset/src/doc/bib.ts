import type { Diagnostic, SourceRef } from "../diagnostics.ts";
import { error, unsupported, warning } from "../diagnostics.ts";
import { spend } from "../macro/budget.ts";
import type { Budget } from "../macro/budget.ts";
import type {
  BibliographyBlock,
  BibItem,
  Block,
  CitationInline,
  HeadingBlock,
  Inline,
  ListBlock,
  ParagraphBlock,
  TextInline,
  TextStyle,
} from "./model.ts";
import { DEFAULT_TEXT_STYLE, UNRESOLVED_CITATION, cloneStyle } from "./model.ts";

/**
 * **Chunk 39.5**: `.bib` parsing, citation resolution, and the one built-in
 * style (numeric; author-year is deferred by brief 39).
 *
 * Chunk 39.1 parsed every citing construct into a `CitationInline` (carrying
 * raw keys) or a `BibliographyBlock` (carrying `.bib` file names, the style,
 * and any `\bibitem`s) and left two stubs here. This file fills them in:
 *
 * - a hand-written `.bib` scanner (`parseBibText` and friends) that never
 *   throws and never over-runs the step budget, because a `.bib` is user
 *   input like any `.tex` file and D38 applies to it too;
 * - `formatBibliography`, which turns parsed entries (or a `thebibliography`'s
 *   already-parsed `\bibitem`s) into an ordinary numbered list — the reuse
 *   that keeps this out of the layout layer entirely, per its own doc comment;
 * - `resolveCitations`, which assigns those numbers to every `\cite` site.
 *
 * **The numbering order.** Real BibTeX's `plain.bst` sorts alphabetically by
 * author; brief 39 explicitly defers author-year styles and asks for
 * "numeric" only. What this file implements under the name the document
 * writes (`\bibliographystyle{plain}` — `IMPLEMENTED_BIB_STYLE`) is therefore
 * closer to real BibTeX's `unsrt.bst`: entries are numbered in the order they
 * are first cited, with `\nocite`-only keys taking the next numbers in the
 * order they were `\nocite`d, and `\nocite{*}` pulling in every remaining
 * entry in the order the `.bib` defined them. This is not a rename anyone
 * will notice from the numbers alone — a numeric citation looks the same
 * either way — and it is far cheaper to build correctly than an alphabetical
 * sort keyed on BibTeX's own name-formatting rules, which this engine does
 * not implement.
 *
 * **The two-map handoff.** `formatBibliography` runs once per bibliography
 * block, in document order, *before* `resolveCitations` runs once for the
 * whole document (both calls come from `doc/index.ts`'s `resolveBibliography`
 * — see its own doc comment for why the order is not arbitrary). Both
 * functions need to agree on "what number does key X have", so this file
 * keeps a `WeakMap<BibContext, Map<string, ResolvedEntry>>`: `formatBibliography`
 * writes into it once per block, `resolveCitations` only reads. Keying on the
 * `BibContext` object rather than adding a field to its public shape means a
 * fresh compile's table can never leak into another's, and lets the seam
 * documented above stay exactly the shape 39.1 published.
 */

// --- the seam (unchanged shape) ---------------------------------------------

/** The project's text files, decoded — `SourceFiles` in `doc/index.ts`. `.bib` is text. */
export type BibFiles = Readonly<Record<string, string>>;

/** What both entry points need. One object so the two calls read alike. */
export interface BibContext {
  /**
   * The whole project, decoded. `.bib` files are inputs like the `.tex` (D38):
   * the engine performs no I/O, so a name in `\bibliography{refs}` is resolved
   * against these keys — `refs`, then `refs.bib` — or it is a `missing-file`
   * diagnostic. There is no path to open.
   */
  files: BibFiles;
  /**
   * Every `\cite`/`\citep`/`\citet`/`\nocite` in the document, in source order.
   * That order *is* the numbering order (see the file's own doc comment for
   * why "plain" prints in citation order rather than alphabetically), and
   * `\nocite` sites (`style: "silent"`) contribute keys without printing.
   */
  citations: readonly CitationInline[];
  /** Where diagnostics go. Appended to, never replaced. */
  diagnostics: Diagnostic[];
  /** Spend a step per entry parsed and per key resolved. */
  budget: Budget;
  /** The entrypoint, for a diagnostic with no better position than the document. */
  file: string;
}

/** The one style brief 39 implements. Everything else is a diagnostic naming it. */
export const IMPLEMENTED_BIB_STYLE = "plain";

// --- a resolved citation: what a key is worth once its list is built -------

/** What `resolveCitations` needs to know about a key once its list has been formatted. */
interface ResolvedEntry {
  /** 1-based position in the reference list this key belongs to — the numeric label. */
  number: number;
  /**
   * A short "Author" / "Author and Author" / "Author et al." for `\citet`,
   * derived from the entry's `author` field. `null` when there is no author
   * to derive one from — a `misc` entry with none, or a `thebibliography`
   * entry (free-form `Block[]`, not a field the engine can pick "author" out
   * of) — in which case `\citet` falls back to the bare bracket, same as
   * `\cite`. Documented as a known simplification rather than hidden.
   */
  authorShort: string | null;
}

/**
 * The handoff between the two seam functions (see the file's doc comment).
 * Keyed on the `BibContext` object itself so a table never outlives the
 * compile that built it and the public seam shape does not grow a field only
 * this file's two halves need to see.
 */
const RESOLVED_ENTRIES = new WeakMap<BibContext, Map<string, ResolvedEntry>>();

function tableFor(ctx: BibContext): Map<string, ResolvedEntry> {
  let table = RESOLVED_ENTRIES.get(ctx);
  if (table === undefined) {
    table = new Map();
    RESOLVED_ENTRIES.set(ctx, table);
  }
  return table;
}

// --- THE SEAM (2 of 2, read first): the reference list as ordinary blocks --

/**
 * Turn one `BibliographyBlock` into the paragraphs `layout/vlist.ts` already
 * knows how to set, and assign every entry it prints a number.
 *
 * A `.bib` file can define far more entries than a document actually cites —
 * that is the point of having one bibliography shared across projects — so
 * **only cited (or `\nocite`d) entries are printed**, in citation order, which
 * is exactly what real BibTeX does too: an uncited entry sits in the `.bib`
 * forever and never reaches a `.bbl`. `\nocite{*}` is the escape hatch that
 * means "cite everything", handled by `citationOrder` below.
 */
export function formatBibliography(request: BibliographyBlock, ctx: BibContext): Block[] {
  const table = tableFor(ctx);
  return request.source === "thebibliography"
    ? formatThebibliography(request, ctx, table)
    : formatBibfile(request, ctx, table);
}

/** `\bibliography{a,b}`: parse every named `.bib`, then print what was cited. */
function formatBibfile(
  request: BibliographyBlock,
  ctx: BibContext,
  table: Map<string, ResolvedEntry>,
): Block[] {
  if (request.bibFiles.length === 0) {
    // Already a `syntax` error from `applyBibliographyCommand` (no argument at
    // all) — this is not a *second* report of the same fact, it is the fact
    // that there is now nothing this seam can do about it either, phrased the
    // way brief 37's `unsupported.test.ts` inventory expects a bare
    // `\bibliography` to read (verified against that suite directly).
    ctx.diagnostics.push(
      error(
        "unsupported",
        request.loc,
        `${request.construct} was given no .bib file name, so no reference list is set`,
        request.construct,
      ),
    );
    return [];
  }

  const strings = builtinStrings();
  const entries = new Map<string, BibEntry>();
  const order: string[] = [];
  let anyFileFound = false;

  for (const name of request.bibFiles) {
    const resolved = resolveBibFileName(name, ctx.files);
    if (resolved === null) {
      ctx.diagnostics.push(
        error(
          "missing-file",
          request.loc,
          `${request.construct}{${name}} — no "${name}" or "${name}.bib" in the project`,
          request.construct,
        ),
      );
      continue;
    }
    anyFileFound = true;
    parseBibText(ctx.files[resolved]!, resolved, ctx, strings, entries, order);
  }
  if (!anyFileFound) return [];

  resolveCrossrefs(entries, ctx.diagnostics);

  const printOrder = citationOrder(ctx, entries, order);
  if (printOrder.length === 0) return [];

  const items: ReferenceItem[] = printOrder.map((key, index) => {
    const entry = entries.get(key)!;
    const number = index + 1;
    table.set(key, { number, authorShort: shortAuthor(entry.fields.get("author")) });
    return {
      label: [textInline(`[${number}]`, entry.loc)],
      content: entryParagraph(entry),
      loc: entry.loc,
    };
  });

  return [referenceHeading(request.loc), referenceList(items, request.loc)];
}

/**
 * `thebibliography`: unlike a `.bib` list, every `\bibitem` the author wrote
 * is printed — there is no BibTeX-style "only what was cited" filter, because
 * there is no separate database to filter from. The author already decided
 * what belongs in the list by writing it.
 */
function formatThebibliography(
  request: BibliographyBlock,
  ctx: BibContext,
  table: Map<string, ResolvedEntry>,
): Block[] {
  if (request.entries.length === 0) {
    // `applyThebibliography` already warned "has no \bibitem"; this is the
    // separate fact that nothing is set as a result, at error severity so no
    // PDF is produced silently missing the list the author asked for. Also
    // what keeps this environment inside `unsupported.test.ts`'s inventory
    // for the one shape that inventory actually exercises (an empty list) —
    // a non-empty `thebibliography` is genuinely implemented now and no
    // longer reports anything here.
    ctx.diagnostics.push(
      error(
        "unsupported",
        request.loc,
        `\`${request.construct}\` has no \\bibitem entries, so no reference list is set`,
        request.construct,
      ),
    );
    return [];
  }

  const items: ReferenceItem[] = request.entries.map((item: BibItem, index: number) => {
    const number = index + 1;
    // A `thebibliography` entry's "content" is arbitrary `Block[]` the author
    // wrote by hand — there is no `author` field to derive a short name from,
    // so `\citet` against one of these falls back to the bare bracket.
    table.set(item.key, { number, authorShort: null });
    const label: Inline[] =
      item.label !== null && item.label.length > 0
        ? [textInline("[", item.loc), ...item.label, textInline("]", item.loc)]
        : [textInline(`[${number}]`, item.loc)];
    return { label, content: item.content, loc: item.loc };
  });

  return [referenceHeading(request.loc), referenceList(items, request.loc)];
}

interface ReferenceItem {
  label: Inline[];
  content: Block[];
  loc: SourceRef;
}

/** `article.cls`'s `\refname` — hardcoded rather than read from a macro table this seam has no access to. */
function referenceHeading(at: SourceRef): HeadingBlock {
  return {
    kind: "heading",
    level: "section",
    number: null,
    title: [
      {
        kind: "text",
        text: "References",
        style: { font: { family: "serif", weight: "bold", slant: "upright" }, underline: false },
        loc: at,
      },
    ],
    // Unique per block (by source position) so two bibliographies in one
    // document — unusual, but not rejected — do not collide in `ctx.pageOf`.
    marker: `bib:${at.file}:${at.line}`,
    loc: at,
  };
}

/**
 * The list itself: `layout/vlist.ts`'s non-`description` item path prints
 * `item.label` as a hanging label in the margin and `item.content` flush at
 * the left margin — exactly a numbered reference list. `variant: "enumerate"`
 * is cosmetic (every label here is explicit, so the auto-numbering that
 * variant would otherwise supply never runs).
 */
function referenceList(items: readonly ReferenceItem[], at: SourceRef): ListBlock {
  return {
    kind: "list",
    variant: "enumerate",
    depth: 1,
    variantDepth: 1,
    items: items.map((item) => ({ label: item.label, content: item.content, loc: item.loc })),
    loc: at,
  };
}

/**
 * The keys actually printed, and in what order — real BibTeX's "only what
 * was cited" rule (see `formatBibfile`'s doc comment).
 *
 * Every `\cite`/`\citep`/`\citet`/`\nocite` is walked in document order
 * (`ctx.citations`, brief 37's second-pass order); the first time a key
 * belonging to *this* block's entries is named, it takes the next number.
 * `\nocite{*}` expands to every entry this block defines, in the order the
 * `.bib` (or `thebibliography`) itself gave them — `order`.
 *
 * A key belonging to a *different* bibliography block (unusual — a document
 * with two `\bibliography` commands — but not rejected) is silently not
 * this block's problem: it is either printed by whichever block does own it,
 * or, if no block owns it anywhere, `resolveCitations` reports it once the
 * whole picture is known. Diagnosing "not mine" here would risk a false
 * "undefined" report for a key the *next* block is about to define.
 */
function citationOrder(ctx: BibContext, entries: ReadonlyMap<string, BibEntry>, order: readonly string[]): string[] {
  const printOrder: string[] = [];
  const seen = new Set<string>();
  const take = (key: string): void => {
    if (seen.has(key) || !entries.has(key)) return;
    seen.add(key);
    printOrder.push(key);
  };
  for (const citation of ctx.citations) {
    for (const key of citation.keys) {
      if (key === "*") {
        for (const k of order) take(k);
        continue;
      }
      take(key);
    }
  }
  return printOrder;
}

// --- THE SEAM (1 of 2): what every citation prints --------------------------

/**
 * Read the numbers `formatBibliography` assigned (it always runs first — see
 * the file's doc comment) and stamp every `\cite` site's `text` with them.
 *
 * Mutates `CitationInline.text` in place — the `\ref` mechanism, not a
 * shortcut. Nothing else on the document is touched.
 */
export function resolveCitations(ctx: BibContext): void {
  const table = tableFor(ctx);
  for (const citation of ctx.citations) {
    if (citation.keys.length === 0) {
      // Already a `syntax` error from `applyCitation` ("needs at least one
      // citation key"); this is the separate, still-error-severity fact that
      // a citation naming nothing cannot be resolved either, which is what
      // keeps `\cite` (bare) inside `unsupported.test.ts`'s inventory — that
      // suite predates this chunk and still exercises exactly this shape.
      ctx.diagnostics.push(
        unsupported(citation.loc, citation.construct, "this citation names no key, so nothing can be resolved"),
      );
      continue;
    }

    if (citation.style === "silent") {
      // `\nocite{k}` still owes the reader a diagnostic if `k` names nothing
      // anywhere — the author asked for a specific entry to be force-included
      // and it does not exist — but `\nocite{*}` is not itself a key.
      for (const key of citation.keys) {
        if (key === "*") continue;
        if (!table.has(key)) {
          ctx.diagnostics.push(
            error(
              "undefined-reference",
              citation.loc,
              `${citation.construct}{${key}} — no bibliography entry for "${key}"`,
              citation.construct,
            ),
          );
        }
      }
      continue; // `\nocite` prints nothing; `text` stays "" (set by build.ts).
    }

    const resolved: ResolvedEntry[] = [];
    let allFound = true;
    for (const key of citation.keys) {
      const hit = table.get(key);
      if (hit === undefined) {
        allFound = false;
        ctx.diagnostics.push(
          error(
            "undefined-reference",
            citation.loc,
            `${citation.construct}{${key}} — no bibliography entry for "${key}"; it prints as ${UNRESOLVED_CITATION}`,
            citation.construct,
          ),
        );
        continue;
      }
      resolved.push(hit);
    }
    // A `\cite{a,zzz}` where `zzz` does not exist prints one unresolved mark
    // for the whole site rather than a partial `[3, ?]` — half a correct
    // citation is not a citation anyone should trust, and `UNRESOLVED_CITATION`
    // is a single fixed string by design (`doc/model.ts`), not a composable one.
    citation.text = allFound ? citationText(citation, resolved) : UNRESOLVED_CITATION;
  }
}

/** `\cite{a,b}` prints one label with both numbers — `[1, 2]`, never `[1][2]`. */
function citationText(citation: CitationInline, resolved: readonly ResolvedEntry[]): string {
  const bracket = `[${resolved.map((r) => r.number).join(", ")}]`;
  if (citation.style !== "textual") return bracket; // `plain` and `parenthetical` both print the bare bracket in numeric mode.
  const names = resolved.map((r) => r.authorShort).filter((n): n is string => n !== null);
  return names.length === 0 ? bracket : `${names.join("; ")} ${bracket}`;
}

/**
 * `\citet`'s "Author" half. BibTeX names split on the literal `" and "`
 * separator; this does not attempt BibTeX's full name-part algorithm (von/Jr
 * particles, `{Protected}` name pieces) — it takes the text after the last
 * comma-free space, or before the first comma in a `Last, First` name, which
 * is right for the ordinary case and wrong only for the kind of name BibTeX
 * itself needs a dedicated name-parser for. A documented simplification, not
 * a silent one.
 */
function shortAuthor(author: string | undefined): string | null {
  if (author === undefined) return null;
  const people = author
    .split(/\s+and\s+/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (people.length === 0) return null;
  const last = (name: string): string => {
    const comma = name.indexOf(",");
    if (comma >= 0) return name.slice(0, comma).trim();
    const parts = name.split(/\s+/).filter((p) => p.length > 0);
    return parts.length > 0 ? parts[parts.length - 1]! : name;
  };
  if (people.length === 1) return last(people[0]!);
  if (people.length === 2) return `${last(people[0]!)} and ${last(people[1]!)}`;
  return `${last(people[0]!)} et al.`;
}

// --- turning one entry into a paragraph -------------------------------------

const ITALIC: TextStyle = { font: { family: "serif", weight: "regular", slant: "italic" }, underline: false };

function textInline(text: string, loc: SourceRef, style: TextStyle = DEFAULT_TEXT_STYLE): TextInline {
  return { kind: "text", text, style: cloneStyle(style), loc };
}

/** One printed piece of an entry — a name, a title, a venue — with whether it italicises. */
interface Piece {
  text: string;
  italic?: boolean;
}

/**
 * What to print for an entry, by type. Not `plain.bst`'s exact punctuation —
 * nothing in brief 39's acceptance pins byte-for-byte reference formatting,
 * only that the four entry types are covered — but a reasonable, deterministic
 * reading of each type's own fields, degrading gracefully as fields go
 * missing rather than producing ragged punctuation or crashing.
 */
function entryPieces(entry: BibEntry): Piece[] {
  const f = (name: string): string | undefined => entry.fields.get(name);
  const pieces: Piece[] = [];
  const author = f("author");
  const title = f("title");
  if (author !== undefined && author.length > 0) pieces.push({ text: author });
  if (title !== undefined && title.length > 0) pieces.push({ text: title, italic: true });

  switch (entry.type) {
    case "article": {
      const journal = f("journal");
      const volume = f("volume");
      const number = f("number");
      const pages = f("pages");
      const year = f("year");
      let venue = journal ?? "";
      if (volume !== undefined) venue += (venue.length > 0 ? " " : "") + volume;
      if (number !== undefined) venue += `(${number})`;
      if (venue.length > 0) pieces.push({ text: venue });
      if (pages !== undefined) pieces.push({ text: `pp. ${pages}` });
      if (year !== undefined) pieces.push({ text: year });
      break;
    }
    case "book": {
      const publisher = f("publisher");
      const year = f("year");
      if (publisher !== undefined) pieces.push({ text: publisher });
      if (year !== undefined) pieces.push({ text: year });
      break;
    }
    case "inproceedings": {
      const booktitle = f("booktitle");
      const pages = f("pages");
      const year = f("year");
      if (booktitle !== undefined) pieces.push({ text: `In ${booktitle}` });
      if (pages !== undefined) pieces.push({ text: `pp. ${pages}` });
      if (year !== undefined) pieces.push({ text: year });
      break;
    }
    // `misc`, and every entry type this parser does not specifically know —
    // logged once at parse time (see `KNOWN_TYPES`) and still given the most
    // generic reasonable treatment here rather than being dropped.
    default: {
      const howpublished = f("howpublished");
      const note = f("note");
      const year = f("year");
      if (howpublished !== undefined) pieces.push({ text: howpublished });
      if (note !== undefined) pieces.push({ text: note });
      if (year !== undefined) pieces.push({ text: year });
      break;
    }
  }
  if (pieces.length === 0) pieces.push({ text: entry.key }); // never a blank reference line
  return pieces;
}

function entryParagraph(entry: BibEntry): Block[] {
  const pieces = entryPieces(entry);
  const content: Inline[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;
    content.push(textInline(piece.text, entry.loc, piece.italic ? ITALIC : DEFAULT_TEXT_STYLE));
    if (!/[.?!]$/.test(piece.text)) content.push(textInline(".", entry.loc));
    if (i < pieces.length - 1) content.push({ kind: "space", style: cloneStyle(DEFAULT_TEXT_STYLE), loc: entry.loc });
  }
  const paragraph: ParagraphBlock = { kind: "paragraph", content, indent: false, loc: entry.loc };
  return [paragraph];
}

// --- the .bib parser ---------------------------------------------------------

/** Entry types brief 39 actually formats. Anything else still parses — see `entryPieces`'s default case. */
const KNOWN_TYPES: ReadonlySet<string> = new Set(["article", "book", "inproceedings", "misc"]);

interface BibEntry {
  /** Lower-cased entry type as written — `"article"`, `"phdthesis"`, ... */
  type: string;
  /** As written. Case-sensitive — BibTeX keys are, and so is citing them here. */
  key: string;
  /** Field name (lower-cased) → value, braces already stripped, `@string`s already expanded. */
  fields: Map<string, string>;
  loc: SourceRef;
}

function resolveBibFileName(name: string, files: BibFiles): string | null {
  for (const candidate of [name, `${name}.bib`]) {
    if (Object.prototype.hasOwnProperty.call(files, candidate)) return candidate;
  }
  return null;
}

/** BibTeX predefines the twelve month abbreviations as `@string`s; nothing else is builtin. */
function builtinStrings(): Map<string, string> {
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const table = new Map<string, string>();
  for (let i = 0; i < months.length; i++) {
    table.set(months[i]!.slice(0, 3).toLowerCase(), months[i]!);
  }
  return table;
}

/**
 * One level of `crossref`: a field a child entry does not define is inherited
 * from the entry its `crossref` names, if that entry exists in the same
 * `.bib` (files named together in one `\bibliography{a,b}` are one pool).
 * Real BibTeX resolves this transitively when style files ask for it
 * (`min-crossrefs`); one level is what a hand-formatted numeric list needs
 * and is what brief 39 asks for ("cross-references", not "transitive
 * cross-reference chains").
 */
function resolveCrossrefs(entries: ReadonlyMap<string, BibEntry>, diagnostics: Diagnostic[]): void {
  for (const entry of entries.values()) {
    const crossref = entry.fields.get("crossref");
    if (crossref === undefined) continue;
    const parent = entries.get(crossref);
    if (parent === undefined) {
      diagnostics.push(
        error(
          "undefined-reference",
          entry.loc,
          `@${entry.type}{${entry.key},...} crossref{${crossref}} — no entry "${crossref}" in this .bib`,
          `@${entry.type}`,
        ),
      );
      continue;
    }
    for (const [field, value] of parent.fields) {
      if (!entry.fields.has(field)) entry.fields.set(field, value);
    }
  }
}

// --- the scanner --------------------------------------------------------------

/**
 * A hand-rolled recursive-descent-ish scanner rather than a regular
 * expression grammar: `.bib` values nest braces to arbitrary depth
 * (`{Effects of {Capitalization}}`) and a regex cannot count, so this walks
 * one character at a time, which is also what makes budget-charging by
 * consumed length straightforward (see `spendText`).
 */
interface Scanner {
  text: string;
  i: number;
  line: number;
  column: number;
  file: string;
}

function scannerAt(text: string, file: string): Scanner {
  return { text, i: 0, line: 1, column: 1, file };
}

function eof(s: Scanner): boolean {
  return s.i >= s.text.length;
}

function peek(s: Scanner): string {
  return s.i < s.text.length ? s.text[s.i]! : "";
}

function here(s: Scanner): SourceRef {
  return { file: s.file, line: s.line, column: s.column };
}

function advance(s: Scanner): string {
  const c = s.text[s.i]!;
  s.i++;
  if (c === "\n") {
    s.line++;
    s.column = 1;
  } else {
    s.column++;
  }
  return c;
}

function skipWs(s: Scanner): void {
  while (!eof(s) && /\s/.test(peek(s))) advance(s);
}

function skipToAny(s: Scanner, delims: readonly string[]): void {
  while (!eof(s) && !delims.includes(peek(s))) advance(s);
}

/** A step per roughly 16 characters consumed — see the file's doc comment on why length, not count, is charged for values. */
function spendText(ctx: BibContext, length: number): boolean {
  return spend(ctx.budget, Math.max(1, Math.ceil(length / 16)));
}

/** `{` already at `peek(s)`. Consumes the matching `}`, balancing nested braces (BibTeX's protection groups). */
function readBraced(s: Scanner, ctx: BibContext): string {
  advance(s); // '{'
  let depth = 1;
  let out = "";
  while (!eof(s) && depth > 0) {
    const c = advance(s);
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) break;
    }
    out += c;
    if (!spendText(ctx, 1)) return out;
  }
  if (depth > 0) {
    ctx.diagnostics.push(error("syntax", here(s), "unterminated { in a .bib value", "@string"));
  }
  return out;
}

/** `"` already at `peek(s)`. Braces inside a quoted value are balanced and do not end it — `"a {quoted "word"} here"` is one value. */
function readQuoted(s: Scanner, ctx: BibContext): string {
  advance(s); // opening '"'
  let depth = 0;
  let out = "";
  while (!eof(s)) {
    const c = peek(s);
    if (c === '"' && depth === 0) {
      advance(s);
      return out;
    }
    if (c === "{") depth++;
    else if (c === "}" && depth > 0) depth--;
    out += advance(s);
    if (!spendText(ctx, 1)) return out;
  }
  ctx.diagnostics.push(error("syntax", here(s), 'unterminated " in a .bib value', "@string"));
  return out;
}

/**
 * A field's whole value: one or more braced/quoted/bare tokens joined by `#`
 * (BibTeX string concatenation), e.g. `"The " # month # " Report"`. Returns
 * the concatenated, brace-stripped text — braces are BibTeX's *protection*
 * syntax (case-guarding), not printable characters, so `{Capitalization}`
 * prints as `Capitalization` (real BibTeX style files do the same).
 */
function readValue(s: Scanner, ctx: BibContext, strings: ReadonlyMap<string, string>): string {
  let result = "";
  let sawAny = false;
  for (;;) {
    skipWs(s);
    if (eof(s)) {
      if (!sawAny) ctx.diagnostics.push(error("syntax", here(s), "expected a value, found end of file", "@string"));
      break;
    }
    const c = peek(s);
    let piece: string;
    if (c === "{") {
      piece = readBraced(s, ctx);
    } else if (c === '"') {
      piece = readQuoted(s, ctx);
    } else {
      let token = "";
      while (!eof(s) && !/[\s,}#%)]/.test(peek(s))) token += advance(s);
      if (token.length === 0) {
        ctx.diagnostics.push(
          error("syntax", here(s), 'expected a value: a { }, a " ", a number, or a string name', "@string"),
        );
        break;
      }
      if (/^[0-9]+$/.test(token)) {
        piece = token;
      } else {
        const resolved = strings.get(token.toLowerCase());
        if (resolved === undefined) {
          ctx.diagnostics.push(
            warning("undefined-reference", here(s), `@string name "${token}" is not defined; treated as empty`, "@string"),
          );
          piece = "";
        } else {
          piece = resolved;
        }
      }
    }
    result += piece;
    sawAny = true;
    if (!spendText(ctx, piece.length)) break;
    skipWs(s);
    if (peek(s) === "#") {
      advance(s);
      continue;
    }
    break;
  }
  return result.replace(/[{}]/g, "");
}

/** The closing delimiter for whichever of `{`/`(` an entry or `@string` opened with — real `.bib` files use either. */
function closingFor(open: string): string {
  return open === "(" ? ")" : "}";
}

function readIdentifier(s: Scanner, extra = ""): string {
  let out = "";
  while (!eof(s) && (/[A-Za-z0-9]/.test(peek(s)) || extra.includes(peek(s)))) out += advance(s);
  return out;
}

/** `@string{name = value}` or `@string(name = value)`. Case-insensitive name, available to every later value in this and later files. */
function parseStringDef(s: Scanner, ctx: BibContext, at: SourceRef, strings: Map<string, string>): void {
  skipWs(s);
  const open = peek(s);
  if (open !== "{" && open !== "(") {
    ctx.diagnostics.push(error("syntax", at, "@string must be followed by { name = value }", "@string"));
    return;
  }
  const close = closingFor(open);
  advance(s);
  skipWs(s);
  const name = readIdentifier(s, "_:.+-");
  if (name.length === 0) {
    ctx.diagnostics.push(error("syntax", at, "@string needs a name", "@string"));
    skipToAny(s, [close]);
    if (!eof(s)) advance(s);
    return;
  }
  skipWs(s);
  if (peek(s) !== "=") {
    ctx.diagnostics.push(error("syntax", at, `@string{${name}} needs = value`, "@string"));
    skipToAny(s, [close]);
    if (!eof(s)) advance(s);
    return;
  }
  advance(s); // '='
  const value = readValue(s, ctx, strings);
  strings.set(name.toLowerCase(), value);
  skipWs(s);
  if (peek(s) === ",") advance(s); // a trailing comma before the close is tolerated
  skipWs(s);
  if (peek(s) === close) {
    advance(s);
  } else {
    ctx.diagnostics.push(error("syntax", here(s), `@string{${name}} is missing its closing ${close}`, "@string"));
    skipToAny(s, [close]);
    if (!eof(s)) advance(s);
  }
}

/** Anything balanced-bracket-shaped that this parser reads but discards — `@comment{...}`. */
function consumeBalanced(s: Scanner, ctx: BibContext): void {
  const open = advance(s);
  const close = closingFor(open);
  let depth = 1;
  while (!eof(s) && depth > 0) {
    const c = advance(s);
    if (c === open) depth++;
    else if (c === close) depth--;
    if (!spendText(ctx, 1)) return;
  }
}

function registerEntry(
  entries: Map<string, BibEntry>,
  order: string[],
  entry: BibEntry,
  diagnostics: Diagnostic[],
): void {
  if (entries.has(entry.key)) {
    diagnostics.push(
      warning(
        "duplicate-label",
        entry.loc,
        `bibliography key "${entry.key}" is defined more than once; the first definition is kept`,
        `@${entry.type}`,
      ),
    );
    return;
  }
  entries.set(entry.key, entry);
  order.push(entry.key);
}

/** `@article{key, field = value, ...}` (or `book`/`inproceedings`/`misc`/anything else). */
function parseEntry(
  s: Scanner,
  ctx: BibContext,
  type: string,
  at: SourceRef,
  strings: Map<string, string>,
  entries: Map<string, BibEntry>,
  order: string[],
): void {
  skipWs(s);
  const open = peek(s);
  if (open !== "{" && open !== "(") {
    ctx.diagnostics.push(
      error("syntax", at, `@${type} must be followed by { or ( — this entry could not be read`, `@${type}`),
    );
    return;
  }
  const close = closingFor(open);
  advance(s);
  skipWs(s);

  let key = "";
  while (!eof(s) && peek(s) !== "," && peek(s) !== close && !/\s/.test(peek(s))) key += advance(s);
  skipWs(s);
  if (key.length === 0) {
    ctx.diagnostics.push(error("syntax", at, `@${type} entry has no citation key`, `@${type}`));
  }

  if (peek(s) === ",") {
    advance(s);
  } else if (peek(s) !== close) {
    ctx.diagnostics.push(error("syntax", at, `@${type}{${key}} — expected , or ${close} after the key`, `@${type}`));
    skipToAny(s, [",", close]);
    if (peek(s) === ",") advance(s);
  }

  const fields = new Map<string, string>();
  while (!eof(s)) {
    if (!spend(ctx.budget)) return;
    skipWs(s);
    if (eof(s)) {
      ctx.diagnostics.push(error("syntax", at, `@${type}{${key}} is missing its closing ${close}`, `@${type}`));
      break;
    }
    if (peek(s) === close) {
      advance(s);
      break;
    }
    if (peek(s) === ",") {
      advance(s); // a stray/trailing comma between fields
      continue;
    }
    const fieldAt = here(s);
    const fieldName = readIdentifier(s, "_:.+-");
    if (fieldName.length === 0) {
      ctx.diagnostics.push(
        error("syntax", fieldAt, `@${type}{${key}} — unexpected character in its field list`, `@${type}`),
      );
      advance(s); // guaranteed progress even on a character no rule recognises
      continue;
    }
    skipWs(s);
    if (peek(s) !== "=") {
      ctx.diagnostics.push(
        error("syntax", fieldAt, `@${type}{${key}} — field "${fieldName}" has no = value`, `@${type}`),
      );
      skipToAny(s, [",", close]);
      continue;
    }
    advance(s); // '='
    const value = readValue(s, ctx, strings);
    fields.set(fieldName.toLowerCase(), value);
    skipWs(s);
    if (peek(s) === ",") {
      advance(s);
      continue;
    }
    if (peek(s) === close) {
      advance(s);
      break;
    }
    ctx.diagnostics.push(
      error("syntax", here(s), `@${type}{${key}} — expected , or ${close} after field "${fieldName}"`, `@${type}`),
    );
    skipToAny(s, [",", close]);
  }

  if (key.length === 0) return; // nothing citeable was defined; already reported above

  if (!KNOWN_TYPES.has(type)) {
    // Still parsed and still printed (via `entryPieces`'s generic fallback) —
    // brief 39 lists this as an "Out" shape that must produce a diagnostic,
    // not one that must vanish from the reference list. A reader who cited it
    // still gets a number and a reasonable line; the diagnostic says why it
    // is not formatted the way an `article`/`book`/`inproceedings`/`misc`
    // entry would be.
    ctx.diagnostics.push(
      unsupported(
        at,
        `@${type}`,
        `@${type} is not one of article/book/inproceedings/misc; "${key}" prints with generic formatting`,
      ),
    );
  }
  registerEntry(entries, order, { type, key, fields, loc: at }, ctx.diagnostics);
}

/**
 * The whole `.bib` file: everything outside an `@...{...}` block is a comment
 * by convention (a `.bib` has no other syntax), so the top-level loop simply
 * looks for the next `@` and otherwise advances — no special-casing for `%`
 * or blank lines is needed because nothing outside an entry is ever read.
 */
function parseBibText(
  text: string,
  file: string,
  ctx: BibContext,
  strings: Map<string, string>,
  entries: Map<string, BibEntry>,
  order: string[],
): void {
  const s = scannerAt(text, file);
  while (!eof(s)) {
    if (!spend(ctx.budget)) return;
    const before = s.i;
    skipWs(s);
    if (eof(s)) break;
    if (peek(s) !== "@") {
      advance(s);
      continue;
    }
    const at = here(s);
    advance(s); // '@'
    const type = readIdentifier(s).toLowerCase();
    if (type.length === 0) {
      ctx.diagnostics.push(error("syntax", at, "`@` with no entry type name after it", "@"));
    } else if (type === "comment") {
      skipWs(s);
      if (peek(s) === "{" || peek(s) === "(") consumeBalanced(s, ctx);
      // A genuine comment, by BibTeX convention — nothing is lost, so nothing is diagnosed.
    } else if (type === "preamble") {
      skipWs(s);
      if (peek(s) === "{" || peek(s) === "(") consumeBalanced(s, ctx);
      ctx.diagnostics.push(
        unsupported(at, "@preamble", "a raw TeX preamble string in a .bib file is not interpreted; it changes nothing"),
      );
    } else if (type === "string") {
      parseStringDef(s, ctx, at, strings);
    } else {
      parseEntry(s, ctx, type, at, strings, entries, order);
    }
    if (s.i === before) advance(s); // guaranteed forward progress
  }
}
