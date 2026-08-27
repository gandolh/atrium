import { useEffect } from "react";

/**
 * The compile button (brief 38 chunk 9), mounted at the end of the editor's
 * header row.
 *
 * **Compile is explicit, never on keystroke.** This component is the ONLY
 * thing that calls `onCompile` — there is no autosave-triggered or debounced
 * path into it anywhere in this file. `onCompile` is the caller's
 * responsibility to have already composed with `flush()` (see
 * `LatexEditor.onCompile`): compiling before the last edit is saved would
 * compile the previous autosave, not what's on screen.
 *
 * The `Mod-Enter` keybinding lives here, self-contained — the same pattern
 * `LatexEditor` already uses for `Mod-S` (save), just scoped to this
 * component's own concern rather than folded into the shell's keydown effect.
 */
export function CompileButton({
  pending,
  onCompile,
}: {
  /** True while a compile is in flight — disables the button and the key. */
  pending: boolean;
  onCompile: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      if (!pending) onCompile();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pending, onCompile]);

  return (
    <button
      type="button"
      onClick={onCompile}
      disabled={pending}
      title="Compile (Ctrl/Cmd+Enter)"
      className="flex shrink-0 items-center gap-1.5 rounded-card bg-ink-fill px-3 py-1.5 font-ui text-sm font-medium text-on-ink-fill transition hover:opacity-90 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent"
    >
      <CompileIcon spinning={pending} />
      {pending ? "Compiling…" : "Compile"}
    </button>
  );
}

/**
 * A quiet reload glyph — 1.75 stroke, inline SVG, same family as the file
 * tree's icons (`LatexFileTree`/`LatexList`). Spins continuously while a
 * compile is in flight; `motion-safe:` gives it the required
 * `prefers-reduced-motion` path for free (design.md "Motion degrades") — a
 * reduced-motion viewer just gets a static glyph.
 */
function CompileIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      className={`h-4 w-4 ${spinning ? "motion-safe:animate-spin" : ""}`}
      aria-hidden
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12a7.5 7.5 0 0 1 7.5-7.5 7.5 7.5 0 0 1 6.5 3.75" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M18.5 4.5v4.5H14" />
    </svg>
  );
}
