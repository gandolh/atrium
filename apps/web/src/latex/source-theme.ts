import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

/**
 * The LaTeX source pane's CodeMirror theme, built from Reading Room tokens
 * (brief 38 chunk 8).
 *
 * **No stock theme.** `@codemirror/theme-one-dark` and friends each ship their
 * own palette, which would drop a second colour system into the middle of the
 * app — exactly what design.md's "tokens only" rule exists to prevent. Every
 * value below is a `var(--…)` resolved from `globals.css`, so the editor
 * re-themes with the rest of the app the instant `data-theme` changes on
 * `<html>`: light, sepia and dark all come free, with no per-theme branch here.
 *
 * The editor is a WORKING surface, not a reading surface, so it takes the one
 * deviation the system allows it — `--font-code`, the platform monospace stack
 * (see globals.css for why fixed-width is structural here) — and nothing else.
 *
 * Only `dark` (below) cannot be expressed as a custom property: CodeMirror uses
 * it to pick which of its two built-in selection/cursor layer treatments to
 * use, and it is a boolean baked into the extension, so the caller reconfigures
 * this through a compartment when the theme changes.
 */

/** Selection/active-line washes. Accent is STATE (design.md) — a selection is state. */
const SELECTION = "color-mix(in srgb, var(--accent) 26%, transparent)";
const SELECTION_MATCH = "color-mix(in srgb, var(--accent) 14%, transparent)";
const ACTIVE_LINE = "color-mix(in srgb, var(--paper-container) 55%, transparent)";

function editorTheme(dark: boolean): Extension {
  return EditorView.theme(
    {
      "&": {
        color: "var(--ink)",
        backgroundColor: "var(--paper-low)",
        // 13.5px, matching design.md's `label-ui` step — the source pane is
        // interface, not prose, so it sits on the Archivo scale even though it
        // is set in the code face.
        fontSize: "13.5px",
        height: "100%",
      },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": {
        fontFamily: "var(--font-code)",
        lineHeight: "1.65",
        // Vertical only in practice — the pane turns on `lineWrapping`, so a
        // long `\\begin{tabular}` row folds instead of pushing the source off
        // the right edge. That is what keeps the phone workable (decision 5)
        // without giving it a second scroll axis to fight.
        overflow: "auto",
      },
      ".cm-content": {
        padding: "12px 0 40vh 0",
        caretColor: "var(--ink)",
      },
      ".cm-gutters": {
        backgroundColor: "var(--paper-low)",
        color: "var(--ink-variant)",
        borderRight: "1px solid var(--line-soft)",
        // Numbers line up (design.md) — this gutter is nothing but numbers.
        fontVariantNumeric: "tabular-nums",
      },
      ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 12px" },
      ".cm-activeLineGutter": {
        backgroundColor: ACTIVE_LINE,
        color: "var(--ink)",
      },
      ".cm-activeLine": { backgroundColor: ACTIVE_LINE },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ink)" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        { backgroundColor: SELECTION },
      ".cm-selectionMatch": { backgroundColor: SELECTION_MATCH },
      ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
        backgroundColor: "var(--paper-container)",
        outline: "1px solid var(--line)",
      },
      ".cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket": {
        color: "var(--danger)",
      },
      ".cm-specialChar": { color: "var(--danger)" },
      ".cm-placeholder": { color: "var(--ink-variant)" },
    },
    { dark },
  );
}

/**
 * LaTeX highlighting, on two hues and no more.
 *
 * The legacy `stex` mode emits CodeMirror-5 token names, which
 * `StreamLanguage` maps onto lezer tags: `tag` → `tagName` (control
 * sequences and math delimiters), `atom` → `atom` (environment names,
 * `\\label`/`\\ref`/`\\cite` keys, `\\usepackage` arguments), `variable-2` →
 * `special(variableName)` (identifiers inside math), plus the obvious
 * `comment` / `bracket` / `number`, and `error` → `invalid`.
 *
 * Everything that is not a command or an argument stays on an existing token,
 * so the pane reads as prose with structure picked out of it rather than as a
 * christmas tree.
 */
const highlight = HighlightStyle.define([
  // \section, \begin, \\, escaped characters, and $ / $$ / \[ math delimiters.
  { tag: [t.tagName, t.keyword], color: "var(--code-command)", fontWeight: "500" },
  // {article}, {fig:plot}, the key inside \ref{…}.
  { tag: t.atom, color: "var(--code-arg)" },
  // Identifiers inside math mode read as the maths they are, not as prose.
  { tag: t.special(t.variableName), color: "var(--ink)", fontStyle: "italic" },
  { tag: t.number, color: "var(--ink)" },
  { tag: t.bracket, color: "var(--ink-variant)" },
  { tag: t.comment, color: "var(--ink-variant)", fontStyle: "italic" },
  // A stray `}` with nothing open. Danger is the system's error colour.
  { tag: t.invalid, color: "var(--danger)" },
]);

/** The full theme extension for one active reading theme. */
export function atriumSourceTheme(dark: boolean): Extension {
  return [editorTheme(dark), syntaxHighlighting(highlight)];
}
