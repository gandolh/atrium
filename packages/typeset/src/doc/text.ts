/**
 * Text-level translation: the substitutions TeX makes in its mouth, before
 * anything is measured (brief 37, chunk 6).
 *
 * These run over a *merged* run of adjacent text nodes rather than node by
 * node, because the parser splits on every character it treats specially — an
 * em dash arrives as three separate `-` nodes and could not be recognised
 * otherwise (see `mergeAdjacentText` in `macro/expand.ts`).
 */

export type TextSegment =
  | { kind: "text"; text: string; offset: number }
  /** `~`: a space that is not a break opportunity. */
  | { kind: "tie"; offset: number };

/**
 * Apply TeX's text ligatures and quote conventions to one run.
 *
 * `---`/`--` become em/en dashes and `` `` ``/`''`/`` ` ``/`'` become curly
 * quotes, which is why a LaTeX document has typographic punctuation without
 * the author typing any. Order matters: the three-character forms are tested
 * before the two-character ones.
 */
export function scanTextRun(value: string): TextSegment[] {
  const out: TextSegment[] = [];
  let literal = "";
  let literalOffset = 0;
  const push = (text: string, offset: number): void => {
    if (literal.length === 0) literalOffset = offset;
    literal += text;
  };
  const flush = (): void => {
    if (literal.length > 0) {
      out.push({ kind: "text", text: literal, offset: literalOffset });
      literal = "";
    }
  };
  let i = 0;
  while (i < value.length) {
    const start = i;
    const three = value.slice(i, i + 3);
    const two = value.slice(i, i + 2);
    const one = value[i]!;
    let produced: string | null = null;
    if (three === "---") {
      produced = "—";
      i += 3;
    } else if (two === "--") {
      produced = "–";
      i += 2;
    } else if (two === "``") {
      produced = "“";
      i += 2;
    } else if (two === "''") {
      produced = "”";
      i += 2;
    } else if (two === "!`") {
      produced = "¡";
      i += 2;
    } else if (two === "?`") {
      produced = "¿";
      i += 2;
    } else if (one === "`") {
      produced = "‘";
      i += 1;
    } else if (one === "'") {
      produced = "’";
      i += 1;
    } else if (one === "~") {
      flush();
      out.push({ kind: "tie", offset: start });
      i += 1;
      continue;
    } else {
      produced = one;
      i += 1;
    }
    push(produced, start);
  }
  flush();
  return out;
}
