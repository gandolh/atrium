import { useEffect } from "react";

/**
 * The compile button (brief 38 chunk 9), mounted at the end of the editor's
 * header row. Brief 44's last chunk turned it into a compile/cancel toggle —
 * see "Replace, not beside" below.
 *
 * **Compile is explicit, never on keystroke.** This component is the ONLY
 * thing that calls `onCompile` — there is no autosave-triggered or debounced
 * path into it anywhere in this file. `onCompile` is the caller's
 * responsibility to have already composed with `flush()` (see
 * `LatexEditor.onCompile`): compiling before the last edit is saved would
 * compile the previous autosave, not what's on screen. The same is NOT true
 * of `onCancel` — cancelling never touches the buffer, so there is nothing to
 * flush first.
 *
 * The `Mod-Enter` keybinding lives here, self-contained — the same pattern
 * `LatexEditor` already uses for `Mod-S` (save), just scoped to this
 * component's own concern rather than folded into the shell's keydown effect.
 * **It stays a compile-only shortcut, inert while a compile is in flight** —
 * it does not double as a cancel key. Overloading one chord with two opposite
 * meanings (start vs. stop) depending on invisible state is the kind of thing
 * that only reveals itself when it fires by muscle memory and the wrong thing
 * happens; a cancel is deliberately mouse/Enter-on-the-button-only.
 *
 * ## Replace, not beside
 * A running compile used to leave a disabled "Compiling…" button sitting in
 * the header — a dead control with nothing to press. Rather than adding a
 * SECOND button next to it once cancel became possible, this one control now
 * plays both roles: "Compile" when idle, "Cancel" (still the primary
 * `ink-fill` treatment — design.md keeps `accent` for state only, never a
 * button fill, so a second colour was never on the table) while a compile of
 * THIS project is running. A second button would also have to fit into an
 * already-crowded, wrapping header row (back link, title, save state,
 * publish) for a control that is only ever useful opposite the first one —
 * one slot that always does the one relevant thing reads better than two
 * controls where one is always disabled.
 *
 * ## `pending` is the server's answer, not this tab's
 * The caller derives `pending` from the project row's `compileStatus`, OR-ed
 * with its own in-flight compile mutation — see `LatexEditor`'s `compiling`.
 * This component must not be given a purely local flag: every tab that can see
 * the project is entitled to stop the compile, and the 409 the server answers a
 * second compile with says so in as many words. A "Cancel" that only appeared
 * in the tab that pressed "Compile" would leave the instruction unfollowable
 * after nothing more exotic than a page reload.
 */
export function CompileButton({
  pending,
  cancelling,
  onCompile,
  onCancel,
}: {
  /** True while a compile is in flight for this project **according to the
   * server** (plus the caller's own in-flight mutation, for the instant before
   * the first refetch) — never from this tab's local state alone. */
  pending: boolean;
  /** True from the moment Cancel is pressed until that request settles —
   * disables the button so a second click can't fire a second cancel while
   * the first is still on the wire. */
  cancelling: boolean;
  onCompile: () => void;
  onCancel: () => void;
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

  const label = cancelling ? "Cancelling…" : pending ? "Cancel" : "Compile";
  const title = cancelling
    ? "Cancelling the compile…"
    : pending
      ? "Cancel the running compile"
      : "Compile (Ctrl/Cmd+Enter)";

  return (
    <button
      type="button"
      onClick={pending ? onCancel : onCompile}
      disabled={cancelling}
      title={title}
      className="flex shrink-0 items-center gap-1.5 rounded-card bg-ink-fill px-3 py-1.5 font-ui text-sm font-medium text-on-ink-fill transition hover:opacity-90 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent"
    >
      <CompileIcon spinning={pending} />
      {label}
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
