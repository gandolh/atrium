import { useEffect, useRef } from "react";

import type { TocEntry } from "./TocDrawer";

/**
 * Contents sidebar. On desktop (md+) it docks in-flow and the reading column
 * shifts to make room; on mobile it becomes a slide-in overlay with a scrim
 * (a docked 288px panel would crush a 375px reading pane to an unusable
 * sliver). Its open state is a remembered preference (store's `tocSidebarOpen`).
 *
 * Kept deliberately quiet: same warm surface as the page, a hairline divider,
 * the current chapter marked with an accent dot. No dashboard chrome.
 */

/** True when the viewport is in the mobile-overlay range (below Tailwind md). */
function isMobileViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
}
export function TocSidebar({
  open,
  entries,
  onNavigate,
  onClose,
  currentId = null,
  title = "Contents",
}: {
  open: boolean;
  entries: TocEntry[];
  onNavigate: (entry: TocEntry) => void;
  onClose: () => void;
  /** Entry id of the chapter currently being read — highlighted + scrolled to. */
  currentId?: string | null;
  title?: string;
}) {
  // Keep the current chapter in view when it changes or the panel opens — an
  // initial position, not an animated movement (reading state is sacred).
  const currentRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      currentRef.current?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(id);
  }, [open, currentId]);

  return (
    <>
      {/* Mobile scrim — tap to dismiss the overlay. Desktop docking needs none. */}
      {open && (
        // design.md "Depth is tonal": modals keep a 12px backdrop blur.
        <div
          aria-hidden="true"
          onClick={onClose}
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-md md:hidden"
        />
      )}

      <aside
        // md+ : docked, in-flow; width animates 0↔72 so the reading column
        //       reflows smoothly and collapses to zero when closed.
        // <md : fixed slide-in overlay (translate) so it never steals the
        //       reading pane's width. `inert` when closed pulls the clipped
        //       list out of the a11y tree + tab order. Motion honors reduce.
        inert={!open}
        className={[
          "h-full overflow-hidden border-reader-border bg-reader-bg",
          "md:relative md:shrink-0 md:border-r md:transition-[width] md:duration-200 md:motion-reduce:transition-none",
          open ? "md:w-72" : "md:w-0 md:border-r-0",
          "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:w-[86vw] max-md:max-w-80 max-md:border-r max-md:shadow-l1 max-md:transition-transform max-md:duration-200 max-md:motion-reduce:transition-none",
          open ? "max-md:translate-x-0" : "max-md:-translate-x-full",
        ].join(" ")}
      >
      {/* Fixed inner width (desktop) so content doesn't reflow while the panel
          animates; full width inside the mobile overlay. */}
      <div className="flex h-full w-72 flex-col max-md:w-full">
        <div className="flex items-center justify-between border-b border-reader-border px-4 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Hide contents"
            title="Hide contents"
            className="grid h-8 w-8 place-items-center rounded-card text-reader-fg/70 hover:bg-reader-surface"
          >
            <CollapseIcon />
          </button>
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
                      onClick={() => {
                        onNavigate(entry);
                        // On the mobile overlay, jumping should dismiss the
                        // panel (like a drawer); the docked desktop panel stays.
                        if (isMobileViewport()) onClose();
                      }}
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
      </div>
      </aside>
    </>
  );
}

function CollapseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M15 6l-6 6 6 6"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
