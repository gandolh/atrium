import { useEffect, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

import type { TocEntry } from "../chrome";

/**
 * Builds shared `TocEntry[]` from a PDF's outline (the PDF reader TOC decision:
 * "PDF gets a TOC only when an outline exists"). Uses PDF.js
 * `doc.getOutline()`, then resolves each node's destination to a 1-based page
 * number so `onNavigate` can jump directly.
 *
 * Returns an empty array when the PDF has no outline; the reader then hides the
 * TOC control entirely.
 */
export function usePdfOutline(doc: PDFDocumentProxy | null): TocEntry[] {
  const [entries, setEntries] = useState<TocEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!doc) {
      setEntries([]);
      return;
    }

    void (async () => {
      const outline = await doc.getOutline();
      if (!outline || outline.length === 0) {
        if (!cancelled) setEntries([]);
        return;
      }

      const flat: TocEntry[] = [];
      let counter = 0;

      // Resolve a node's `dest` (named string OR explicit array) to a 1-based
      // page number; `null` if it can't be resolved (we still list it, just
      // non-navigable).
      const resolvePage = async (dest: string | unknown[] | null): Promise<number | null> => {
        try {
          const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
          if (!Array.isArray(explicit) || explicit.length === 0) return null;
          const ref = explicit[0];
          const pageIndex = await doc.getPageIndex(ref as Parameters<typeof doc.getPageIndex>[0]);
          return pageIndex + 1;
        } catch {
          return null;
        }
      };

      type OutlineNode = Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>[number];

      const walk = async (nodes: OutlineNode[], depth: number) => {
        for (const node of nodes) {
          const page = await resolvePage(node.dest);
          flat.push({
            id: `toc-${counter++}`,
            label: node.title,
            depth,
            target: page, // number | null; PdfReader's onNavigate handles null.
          });
          if (node.items && node.items.length > 0) {
            await walk(node.items as OutlineNode[], depth + 1);
          }
        }
      };

      await walk(outline, 0);
      if (!cancelled) setEntries(flat);
    })();

    return () => {
      cancelled = true;
    };
  }, [doc]);

  return entries;
}
