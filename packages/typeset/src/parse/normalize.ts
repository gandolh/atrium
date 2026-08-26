/**
 * `@unified-latex`'s tokenizer miscounts CRLF line endings: a single `\r\n`
 * (one line break) is parsed as a `parbreak` (a *blank* line), not as
 * ordinary whitespace. Confirmed empirically — `"line1\r\nline2"` produces
 * `[string, parbreak, string]`, while `"line1\nline2"` correctly produces
 * `[string, whitespace, string]`. A `.tex` file edited on Windows would
 * therefore get a spurious paragraph break after every single line, silently
 * changing the document.
 *
 * Fixed once, here, by normalizing before the source ever reaches the parser
 * rather than patched around afterwards: every `\r\n` (and a lone `\r`, for
 * old Mac-style files) becomes `\n`. This is exact, not approximate — `\r`
 * only ever appears at a line boundary, so folding it away changes nothing
 * about line or column numbers for real content; every line keeps the same
 * 1-based line number and every character keeps the same column, because the
 * discarded byte never carried a column of its own.
 */
export function normalizeLineEndings(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}
