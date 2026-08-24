import { useEffect, useRef, useState, type KeyboardEvent } from "react";

/**
 * Cross-library search field (brief 30) — rendered into `AppHeader`'s search
 * slot from `LibraryHome`. Chrome matches the slot brief 28 left: a 1px
 * `line` border, 4px (`rounded-card`) radius. A quiet "/" hint chip sits at
 * the field's trailing edge while it's idle and empty; once there's a query
 * (or the field is focused) the hint gives way to a "Clear" affordance.
 *
 * Debouncing and the `?q` round-trip are `LibraryHome`'s job (it already owns
 * the URL state, mirroring how `/discover` debounces its own search box) —
 * this component only owns the **keyboard behaviour**: focusing itself on a
 * bare `/` pressed anywhere on the page, and clearing + blurring on `Esc`.
 */
export function LibrarySearchField({
  value,
  onChange,
  resultsSummary,
}: {
  /** The field's current (undebounced) text — controlled by the caller. */
  value: string;
  onChange: (next: string) => void;
  /** Rendered as a visually-hidden live region so screen readers hear result counts update. */
  resultsSummary?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = useState(false);

  // `/` focuses the field from anywhere on the page — EXCEPT when focus is
  // already inside an input, a textarea, or a contenteditable, so a "/" typed
  // into another field (or this one) never gets hijacked into a jump.
  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const alreadyTyping = tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable === true;
      if (alreadyTyping) return;
      e.preventDefault();
      inputRef.current?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function onKeyDownInput(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    onChange("");
    inputRef.current?.blur();
  }

  const showHint = !focused && value.length === 0;
  const showClear = value.length > 0;

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        role="searchbox"
        aria-label="Search your library"
        placeholder="Search title, author, series…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDownInput}
        className="w-full rounded-card border border-line bg-paper py-2 pl-3 pr-10 font-ui text-sm text-ink placeholder:text-ink-variant/70 transition-colors duration-200 ease-paper focus:outline-none focus-visible:border-accent"
      />
      <div className="pointer-events-none absolute inset-y-0 right-2 flex items-center">
        {showClear ? (
          <button
            type="button"
            onClick={() => {
              onChange("");
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            className="pointer-events-auto rounded px-1 py-0.5 font-ui text-xs font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
          >
            Clear
          </button>
        ) : showHint ? (
          <span
            aria-hidden
            className="rounded border border-line-soft px-1.5 py-0.5 font-ui text-xs text-ink-variant"
          >
            /
          </span>
        ) : null}
      </div>
      {resultsSummary && (
        <p role="status" aria-live="polite" className="sr-only">
          {resultsSummary}
        </p>
      )}
    </div>
  );
}
