import { useEffect, useRef } from "react";
import { Dialog } from "@base-ui/react/dialog";

import { useChromeHold } from "./use-auto-hide-chrome";

/**
 * A single entry in the shared table-of-contents (wiki/reader.md "Table of
 * contents drawer"). Format-agnostic: PDF derives these from the PDF outline
 * (page targets); EPUB (brief 07) derives them from the spine/nav (CFI/href
 * targets). The `target` is opaque to the drawer — the reader supplies an
 * `onNavigate` that knows how to resolve it.
 */
export interface TocEntry {
  id: string;
  label: string;
  /** Nesting depth (0 = top level) — used only for indentation. */
  depth: number;
  /** Opaque jump target resolved by the reader's `onNavigate`. */
  target: unknown;
}

/**
 * Shared TOC drawer, rendered as a left-anchored Base UI Dialog panel. The
 * reader owns open/close state (it also owns the toolbar button that toggles
 * it) and passes the flattened entries + a navigate callback.
 *
 * PDF-specific note (brief 06): the reader only renders the TOC toolbar button
 * when the PDF exposes an outline; if there's no outline, `entries` is empty
 * and the reader hides the control entirely (see wiki open question resolution:
 * "PDF gets TOC only when an outline exists").
 */
export function TocDrawer({
  open,
  onOpenChange,
  entries,
  onNavigate,
  currentId = null,
  title = "Contents",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: TocEntry[];
  onNavigate: (entry: TocEntry) => void;
  /** Entry id of the chapter currently being read — highlighted + scrolled to. */
  currentId?: string | null;
  title?: string;
}) {
  // Keep the chrome visible while the drawer is open so closing it doesn't
  // land the user on a hidden toolbar.
  useChromeHold(open);

  // Opening the drawer answers "where am I?" — bring the current chapter into
  // view without animation (it's an initial position, not a movement).
  const currentRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      currentRef.current?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(id);
  }, [open, currentId]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        {/* design.md "Depth is tonal": modals keep a 12px backdrop blur. */}
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-md transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed inset-y-0 left-0 z-50 flex w-[85vw] max-w-sm flex-col border-r border-reader-border bg-reader-bg text-reader-fg shadow-l1 transition-transform data-[starting-style]:-translate-x-full data-[ending-style]:-translate-x-full">
          <div className="flex items-center justify-between border-b border-reader-border px-4 py-3">
            <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
            <Dialog.Close
              aria-label="Close contents"
              className="grid h-8 w-8 place-items-center rounded-card text-reader-fg/70 hover:bg-reader-surface"
            >
              <CloseIcon />
            </Dialog.Close>
          </div>

          <nav className="flex-1 overflow-y-auto px-2 py-2">
            {entries.length === 0 ? (
              <p className="px-2 py-4 text-sm text-reader-fg/60">
                No table of contents available.
              </p>
            ) : (
              <ul>
                {entries.map((entry) => {
                  const isCurrent = currentId !== null && entry.id === currentId;
                  return (
                    <li key={entry.id} ref={isCurrent ? currentRef : undefined}>
                      <button
                        type="button"
                        onClick={() => onNavigate(entry)}
                        aria-current={isCurrent ? "true" : undefined}
                        style={{ paddingLeft: `${0.5 + entry.depth * 0.75}rem` }}
                        className={`relative block w-full rounded-card py-1.5 pr-2 text-left text-sm transition-colors ${
                          isCurrent
                            ? "bg-reader-surface font-medium text-reader-fg"
                            : "text-reader-fg/85 hover:bg-reader-surface"
                        }`}
                      >
                        {isCurrent && (
                          <span
                            aria-hidden="true"
                            className="absolute left-0 top-1/2 size-1.5 -translate-y-1/2 rounded-full bg-reader-accent"
                          />
                        )}
                        {entry.label}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </nav>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
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
