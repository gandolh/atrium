import { useEffect, useRef, useState } from "react";

/**
 * Shared "jump to page" control for the toolbar's right cluster (wiki/reader.md
 * "Progress indicator", extended). Renders `Page [N] / total` where `N` is an
 * inline editable field: click it (or tab in), type a page number, and
 * Enter/blur jumps there. Format-agnostic — the reader supplies `onJump(page)`
 * that means "go to this 1-based page" (a real page for PDF; a book-wide page
 * resolved through the page map for EPUB). Falls back to a quiet placeholder
 * while `total` is still unknown (e.g. EPUB's page map still counting).
 *
 * `usePageNavKeys` ignores key events from inputs, so typing here (including
 * Space / arrows) never turns the page underneath.
 */
export function PageJumpInput({
  current,
  total,
  onJump,
  unitLabel = "Page",
  percent = null,
}: {
  /** Current 1-based page, or `null` before it's known. */
  current: number | null;
  /** Total pages, or `null` while still loading. */
  total: number | null;
  /** Jump to a 1-based page (already clamped to `[1, total]`). */
  onJump: (page: number) => void;
  unitLabel?: string;
  /** Optional percentage chip shown alongside (reflowable EPUB uses this). */
  percent?: number | null;
}) {
  // `null` = not editing (mirror `current`); a string = the in-progress draft.
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Tracks whether we were already editing on the last render, so the
  // select-all effect below only fires on the null -> string transition
  // (focus), not on every keystroke while `draft` keeps changing.
  const wasEditingRef = useRef(false);

  // Select-all once editing begins so a typed number replaces the shown page
  // outright — but not on later keystrokes, or each digit would wipe out the
  // one before it (the selection would re-cover the whole field every time).
  useEffect(() => {
    const isEditing = draft !== null;
    if (isEditing && !wasEditingRef.current) inputRef.current?.select();
    wasEditingRef.current = isEditing;
  }, [draft]);

  const canJump = total !== null && total > 0;

  // Read the value to jump to from the draft, or straight off the field (so the
  // Go button works even when the input was never focused/edited).
  function commit() {
    const raw = draft ?? inputRef.current?.value ?? "";
    setDraft(null);
    if (!total || raw === "") return;
    const n = parseInt(raw, 10);
    if (Number.isFinite(n)) onJump(Math.min(Math.max(n, 1), total));
  }

  // Size the field to at least 3 digits (min per request) — wider if the book
  // has more — so it fits the number without the width jumping as pages turn.
  const fieldCh = Math.max(String(total ?? 999).length, 3);

  return (
    <div className="flex shrink-0 items-center gap-2 text-sm text-reader-fg/80" aria-live="off">
      {canJump ? (
        <span className="flex items-center gap-1.5 whitespace-nowrap tabular-nums">
          {/* The unit label, Go button, and % chip drop away on narrow bars so
              the position cluster ("3 / 1020") never clips or overflows the
              pill — blur (or the mobile keyboard's Done/Go) still commits. */}
          <span className="hidden text-reader-fg/60 sm:inline">{unitLabel}</span>
          <input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            aria-label={`Go to ${unitLabel.toLowerCase()} (1 to ${total})`}
            value={draft ?? String(current ?? "")}
            onFocus={() => setDraft(String(current ?? ""))}
            onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ""))}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                inputRef.current?.blur();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setDraft(null);
                inputRef.current?.blur();
              }
            }}
            style={{ width: `${fieldCh + 1.5}ch` }}
            className="rounded-sm bg-reader-bg px-1 py-0.5 text-center text-reader-fg tabular-nums transition outline-none focus:ring-1 focus:ring-reader-accent"
          />
          <span className="text-reader-fg/60">/ {total}</span>
          <button
            type="button"
            // onMouseDown (before the input's blur) + preventDefault keeps focus
            // put so `commit` reads the just-typed value, then we blur ourselves.
            onMouseDown={(e) => {
              e.preventDefault();
              commit();
              inputRef.current?.blur();
            }}
            aria-label={`Go to ${unitLabel.toLowerCase()}`}
            title="Go"
            className="hidden rounded-md bg-reader-accent/15 px-2 py-0.5 text-xs font-semibold text-reader-accent transition hover:bg-reader-accent/25 focus-visible:outline-2 focus-visible:outline-reader-accent sm:inline"
          >
            Go
          </button>
        </span>
      ) : (
        <span className="whitespace-nowrap text-reader-fg/40 tabular-nums">{unitLabel} …</span>
      )}
      {percent !== null && (
        <span className="hidden rounded-sm bg-reader-surface px-1.5 py-0.5 text-xs text-reader-fg/70 tabular-nums md:inline">
          {percent}%
        </span>
      )}
    </div>
  );
}
