import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";

import type { SearchMatch, SearchProvider } from "./search-seam";
import { useChromeHold } from "./use-auto-hide-chrome";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * SHARED IN-BOOK SEARCH UI  (brief 07 — completes the `search-seam.ts` stub)
 * ─────────────────────────────────────────────────────────────────────────────
 * Format-agnostic search surface reused by BOTH readers (D19). Rendered as a
 * right-anchored Base UI Dialog panel (mirrors `TocDrawer`'s left drawer) so the
 * chrome stays consistent. It knows nothing about PDF/EPUB: it drives a
 * `SearchProvider` (supplied by whichever reader mounts it) and reports the
 * chosen match's opaque `target` back via `onJump`, which the reader resolves
 * (page number for PDF, CFI for EPUB).
 *
 * Reuse contract, same shape as the rest of `chrome/`: no format branching, no
 * renderer imports. PDF (`PdfReader`) and EPUB (`EpubReader`) each build their
 * own provider and pass it in.
 */
export function SearchPanel({
  open,
  onOpenChange,
  provider,
  onJump,
  title = "Search",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Reader-supplied search implementation (PDF text layer / epub.js spine). */
  provider: SearchProvider;
  /**
   * Resolve a match's opaque target (jump to page/CFI) in the reader. Receives
   * the query that produced the match so the reader can highlight it in the
   * rendered page.
   */
  onJump: (match: SearchMatch, query: string) => void;
  title?: string;
}) {
  // Keep the chrome visible while the panel is open (same as the TOC drawer).
  useChromeHold(open);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchMatch[] | null>(null);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards against out-of-order async results (a slow earlier query resolving
  // after a newer one) and against setState after close/unmount.
  const runIdRef = useRef(0);
  // The query that produced the current `results` — what a selected match
  // should be highlighted as (the input may have changed since).
  const executedQueryRef = useRef("");

  // Focus the input when the panel opens; reset state when it closes.
  useEffect(() => {
    if (open) {
      // Base UI mounts the popup async; focus on the next frame.
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    setQuery("");
    setResults(null);
    setSearching(false);
    runIdRef.current += 1; // Invalidate any in-flight search.
  }, [open]);

  const runSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults(null);
      return;
    }
    const runId = ++runIdRef.current;
    executedQueryRef.current = trimmed;
    setSearching(true);
    try {
      const matches = await provider.search(trimmed);
      if (runId !== runIdRef.current) return; // Superseded / panel closed.
      setResults(matches);
    } catch {
      if (runId !== runIdRef.current) return;
      setResults([]);
    } finally {
      if (runId === runIdRef.current) setSearching(false);
    }
  }, [query, provider]);

  const onSubmit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      void runSearch();
    },
    [runSearch],
  );

  const onSelect = useCallback(
    (match: SearchMatch) => {
      onJump(match, executedQueryRef.current);
      onOpenChange(false);
    },
    [onJump, onOpenChange],
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        {/* design.md "Depth is tonal": modals keep a 12px backdrop blur. */}
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-md transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed inset-y-0 right-0 z-50 flex w-[85vw] max-w-sm flex-col border-l border-reader-border bg-reader-bg text-reader-fg shadow-l1 transition-transform data-[starting-style]:translate-x-full data-[ending-style]:translate-x-full">
          <div className="flex items-center justify-between border-b border-reader-border px-4 py-3">
            <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
            <Dialog.Close
              aria-label="Close search"
              className="grid h-8 w-8 place-items-center rounded-card text-reader-fg/70 hover:bg-reader-surface"
            >
              <CloseIcon />
            </Dialog.Close>
          </div>

          <form onSubmit={onSubmit} className="border-b border-reader-border px-4 py-3">
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search in book…"
                className="min-w-0 flex-1 rounded-card border border-reader-border bg-reader-surface px-3 py-1.5 text-sm text-reader-fg outline-none focus-visible:ring-2 focus-visible:ring-reader-accent"
              />
              {/* design.md "accent means state only, never a button fill":
                  ink-filled primary, not accent-filled (brief 27 conformance
                  gap, fixed here alongside the OpeningErrorState instance). */}
              <button
                type="submit"
                disabled={searching || query.trim().length === 0}
                className="shrink-0 rounded-card bg-ink-fill px-3 py-1.5 text-sm font-medium text-on-ink-fill transition disabled:opacity-40"
              >
                {searching ? "…" : "Go"}
              </button>
            </div>
          </form>

          <div className="flex-1 overflow-y-auto px-2 py-2">
            {!searching && results === null && (
              <p className="px-2 py-4 text-sm text-reader-fg/60">
                Search the whole book — results are grouped by chapter.
              </p>
            )}
            {searching && (
              <p className="px-2 py-4 text-sm text-reader-fg/60 motion-safe:animate-pulse">
                Searching the whole book…
              </p>
            )}
            {!searching && results !== null && results.length === 0 && (
              <p className="px-2 py-4 text-sm text-reader-fg/60">
                No matches for “{executedQueryRef.current}”.
              </p>
            )}
            {!searching && results !== null && results.length > 0 && (
              <>
                <p className="px-2 pb-1 pt-1 text-xs text-reader-fg/60">
                  {results.length} {results.length === 1 ? "result" : "results"}
                </p>
                <ul>
                  {results.map((match, i) => {
                    // Group results under a chapter header when the label
                    // changes (results arrive in book order).
                    const showGroup =
                      match.label && match.label !== results[i - 1]?.label;
                    return (
                      <li key={i}>
                        {showGroup && (
                          <p className="truncate px-2 pb-1 pt-3 text-xs font-medium text-reader-fg/60">
                            {match.label}
                          </p>
                        )}
                        <button
                          type="button"
                          onClick={() => onSelect(match)}
                          className="block w-full rounded-card px-2 py-2 text-left text-sm text-reader-fg/85 hover:bg-reader-surface"
                        >
                          <span className="line-clamp-3 text-reader-fg/85">
                            {emphasizeQuery(match.excerpt, executedQueryRef.current)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Render an excerpt with the query occurrences set heavier, so the eye lands
 * on the match instead of re-reading the whole snippet. */
function emphasizeQuery(excerpt: string, query: string) {
  const q = query.trim();
  if (!q) return excerpt;
  const haystack = excerpt.toLowerCase();
  const needle = q.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  let idx = haystack.indexOf(needle);
  if (idx === -1) return excerpt;
  while (idx !== -1) {
    if (idx > from) parts.push(excerpt.slice(from, idx));
    parts.push(
      <strong key={idx} className="font-semibold text-reader-fg">
        {excerpt.slice(idx, idx + needle.length)}
      </strong>,
    );
    from = idx + needle.length;
    idx = haystack.indexOf(needle, from);
  }
  if (from < excerpt.length) parts.push(excerpt.slice(from));
  return parts;
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}
