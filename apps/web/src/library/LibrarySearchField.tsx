import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { SearchIcon } from "../components/places";

/**
 * Cross-library search field — rendered into `AppHeader`'s search
 * slot from `LibraryHome`. Chrome matches the slot the one-home layout left: a 1px
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
      <span className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-ink-variant">
        <SearchIcon />
      </span>
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
        className="h-11 w-full rounded-card border border-outline bg-paper-raised pr-12 pl-10 font-ui text-ui font-normal text-ink transition-colors duration-200 ease-paper placeholder:text-ink-variant focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-[820px]:h-12 max-[820px]:text-body"
      />
      <div className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center">
        {showClear ? (
          <button
            type="button"
            onClick={() => {
              onChange("");
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            className="pointer-events-auto rounded-sm px-1 py-0.5 font-ui text-micro font-medium text-ink-variant transition hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
          >
            Clear
          </button>
        ) : showHint ? (
          <span
            aria-hidden
            className="grid h-[22px] min-w-6 place-items-center rounded-sm border border-line bg-paper-low px-2 font-ui text-micro text-ink-variant max-[820px]:hidden"
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
