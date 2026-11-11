import { useEffect } from "react";

/**
 * Shared keyboard page navigation (wiki/reader.md "Page nav"). ArrowLeft /
 * PageUp go to the previous page; ArrowRight / Space / PageDown go to the next.
 *
 * Format-agnostic: the reader passes `onPrev`/`onNext` that mean "previous /
 * next unit" — a page for PDF, a location for EPUB. Ignores key
 * events originating from inputs/editable surfaces so it never fights typing in
 * the (future) search box.
 */
export function usePageNavKeys(options: { onPrev: () => void; onNext: () => void; enabled?: boolean }) {
  const { onPrev, onNext, enabled = true } = options;

  useEffect(() => {
    if (!enabled) return;

    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }

      switch (event.key) {
        case "ArrowLeft":
        case "PageUp":
          event.preventDefault();
          onPrev();
          break;
        case "ArrowRight":
        case "PageDown":
        case " ":
          event.preventDefault();
          onNext();
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, onPrev, onNext]);
}
