/**
 * The `/ToUnicode` CMap: the difference between a PDF whose text can be copied
 * and one that yields mojibake.
 *
 * A Type0/Identity-H font addresses glyphs by *subset glyph id*, a number with
 * no relationship to any character. `/ToUnicode` is the only thing in the file
 * that says what those numbers meant. It is built here from
 * `GlyphRun.text` + `PositionedGlyph.cluster` rather than from the font's
 * `cmap`, because the cluster is the only record of what the *source* said:
 * an `fi` ligature is one glyph whose cmap reverse-lookup is U+FB01, but the
 * document typed `f` then `i`, and that is what a reader expects to paste.
 */

/** One subset glyph id and the source characters it stands for. */
export interface ToUnicodeEntry {
  /** Subset glyph id, i.e. the code that appears in the content stream. */
  code: number;
  /** UTF-16 source characters. May be several (a ligature) — never empty. */
  text: string;
}

/** PDF caps a single `beginbfchar` block at 100 entries. */
const MAX_ENTRIES_PER_BLOCK = 100;

function utf16beHex(text: string): string {
  let hex = "";
  for (let i = 0; i < text.length; i++) {
    hex += text.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
  }
  return hex;
}

function codeHex(code: number): string {
  return code.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * Render the CMap program. `entries` are sorted by code here rather than by the
 * caller, so the output depends on the *set* of glyphs used and not on the
 * order the document happened to use them in.
 */
export function buildToUnicodeCMap(entries: readonly ToUnicodeEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.code - b.code);

  const lines: string[] = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
  ];

  for (let start = 0; start < sorted.length; start += MAX_ENTRIES_PER_BLOCK) {
    const block = sorted.slice(start, start + MAX_ENTRIES_PER_BLOCK);
    lines.push(`${block.length} beginbfchar`);
    for (const entry of block) {
      lines.push(`<${codeHex(entry.code)}> <${utf16beHex(entry.text)}>`);
    }
    lines.push("endbfchar");
  }

  lines.push("endcmap", "CMapName currentdict /CMap defineresource pop", "end", "end", "");
  return lines.join("\n");
}
