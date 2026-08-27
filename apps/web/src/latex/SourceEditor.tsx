import { useEffect, useRef } from "react";
import {
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  StreamLanguage,
  bracketMatching,
  indentOnInput,
  indentUnit,
} from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";

import type { Theme } from "../store/reader-store";
import { atriumSourceTheme } from "./source-theme";

/**
 * The CodeMirror 6 source pane (brief 38 chunk 8).
 *
 * **This module is the lazy chunk.** It is the ONLY place `@codemirror/*` is
 * imported, and `LatexEditor` reaches it through `React.lazy` — brief 15's
 * code-splitting precedent, for the same reason: the LaTeX editor is one
 * destination out of many, and nobody opening the library should download an
 * editor. (Monaco was considered and rejected: roughly ten times the entry
 * chunk for that one destination, a bundled web worker, and a touch story that
 * does not survive contact with a phone.)
 *
 * The extension set is deliberately small. v1 of LaTeX is three things —
 * multi-file projects, compile + preview, and an error log — so there is no
 * autocomplete, no linting, no snippets, no fold gutter here; each of those is
 * explicitly out of scope, and each is also a chunk of bytes the phone would
 * pay for.
 */

/** A request to put the caret on a line, from the diagnostics panel (chunk 9). */
export interface RevealTarget {
  /** Project-relative path. Ignored unless it matches the open document. */
  file: string;
  /** 1-based source line. `0` (a whole-document diagnostic) reveals nothing. */
  line: number;
  /** 1-based column, when the diagnostic pins one. */
  column?: number;
  /**
   * Bumped by the caller for every jump. Two clicks on the same diagnostic are
   * two distinct requests, and identity — not value — is what tells them apart.
   */
  nonce: number;
}

interface SourceEditorProps {
  /**
   * Identity of the open document, normally its project-relative path. A change
   * swaps the buffer wholesale (fresh history, caret at the top); a change to
   * `value` alone patches the existing one.
   */
  docKey: string;
  value: string;
  onChange: (next: string) => void;
  /** The active reading theme; only its dark/light-ness reaches CodeMirror. */
  theme: Theme;
  readOnly?: boolean;
  reveal?: RevealTarget | null;
  /** Accessible name for the text box. */
  label: string;
}

// --- The reveal wash ---------------------------------------------------------

/**
 * A one-shot line decoration for "here is the line you asked for". Lives in a
 * `StateField` rather than in React state because it must survive (and be
 * mapped through) the edits the person makes next, which is exactly what
 * CodeMirror's state fields are for.
 */
const setRevealLine = StateEffect.define<number | null>();

const revealField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setRevealLine)) continue;
      next =
        effect.value === null
          ? Decoration.none
          : Decoration.set([
              Decoration.line({ class: "cm-atrium-reveal" }).range(effect.value),
            ]);
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// --- Extensions --------------------------------------------------------------

const themeCompartment = new Compartment();
const readOnlyCompartment = new Compartment();

/**
 * `stex` is CodeMirror 5's LaTeX mode, run through `StreamLanguage`. There is
 * no first-party `@codemirror/lang-latex`; this is the mode CodeMirror itself
 * ships for LaTeX, and a stream tokenizer is the right shape for a language
 * whose "grammar" is mostly `\command{argument}` anyway. It also declares
 * `commentTokens: { line: "%" }`, so `Mod-/` comments LaTeX correctly for free.
 */
const latexLanguage = StreamLanguage.define(stex);

function baseExtensions(theme: Theme, readOnly: boolean, label: string): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    rectangularSelection(),
    indentOnInput(),
    bracketMatching(),
    // Two spaces: what the seeded `main.tex` uses, and what a `\begin{itemize}`
    // body wants without pushing an 80-column line off the pane.
    indentUnit.of("  "),
    latexLanguage,
    revealField,
    // `indentWithTab` last so Tab indents inside the editor. It is a known
    // keyboard trap, which is why Escape-then-Tab still leaves: `defaultKeymap`
    // does not bind Escape, so the browser's own focus handling takes it.
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.lineWrapping,
    EditorState.allowMultipleSelections.of(true),
    // Named for screen readers; without this the pane is an unlabelled textbox.
    EditorView.contentAttributes.of({ "aria-label": label, spellcheck: "false" }),
    themeCompartment.of(atriumSourceTheme(theme === "dark")),
    readOnlyCompartment.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
  ];
}

export function SourceEditor({
  docKey,
  value,
  onChange,
  theme,
  readOnly = false,
  reveal = null,
  label,
}: SourceEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // The change handler is read through a ref so a new closure on every render
  // never forces the view to be rebuilt (which would lose the caret).
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Mount once. Everything after this is a transaction, not a remount.
  useEffect(() => {
    if (!host.current) return;
    const instance = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          ...baseExtensions(theme, readOnly, label),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = instance;
    return () => {
      instance.destroy();
      view.current = null;
    };
    // Mount-only: `value`/`theme`/`readOnly` are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swapping documents: a full state replacement, so undo history does not
  // reach back into the previous file (undoing your way from `chapter.tex`
  // into `main.tex`'s text would be a data-loss bug, not a feature).
  const mountedDoc = useRef(docKey);
  useEffect(() => {
    const instance = view.current;
    if (!instance || mountedDoc.current === docKey) return;
    mountedDoc.current = docKey;
    instance.setState(
      EditorState.create({
        doc: value,
        extensions: [
          ...baseExtensions(theme, readOnly, label),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    );
    // Only `docKey` opens a new document; `value` riding along is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  // An externally-changed `value` for the SAME document (a reload after a
  // failed save, a rename carrying text across). Guarded on inequality: echoing
  // the value we just emitted back into the document would move the caret to
  // the end on every keystroke.
  useEffect(() => {
    const instance = view.current;
    if (!instance || mountedDoc.current !== docKey) return;
    const current = instance.state.doc.toString();
    if (current === value) return;
    instance.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value, docKey]);

  // Theme changes are a reconfigure, not a remount — the caret and scroll
  // position survive flipping the app between light, sepia and dark.
  useEffect(() => {
    view.current?.dispatch({
      effects: themeCompartment.reconfigure(atriumSourceTheme(theme === "dark")),
    });
  }, [theme]);

  useEffect(() => {
    view.current?.dispatch({
      effects: readOnlyCompartment.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  // Jump to a line (chunk 9 clicks a diagnostic; this is the landing).
  useEffect(() => {
    const instance = view.current;
    if (!instance || !reveal) return;
    // A diagnostic for a different file, or one with no single line (`line: 0`
    // is the whole-document case in the shared contract), reveals nothing.
    if (reveal.file !== docKey || reveal.line < 1) return;
    if (reveal.line > instance.state.doc.lines) return;

    const line = instance.state.doc.line(reveal.line);
    const column = Math.min(Math.max((reveal.column ?? 1) - 1, 0), line.length);
    const pos = line.from + column;
    instance.dispatch({
      selection: { anchor: pos },
      effects: [
        EditorView.scrollIntoView(pos, { y: "center" }),
        setRevealLine.of(line.from),
      ],
    });
    instance.focus();
  }, [reveal, docKey]);

  return <div ref={host} className="min-h-0 w-full flex-1 overflow-hidden" />;
}
