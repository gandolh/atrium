import { useEffect, useState } from "react";

/**
 * DEV-ONLY, OPT-IN sample EPUB loader — the EPUB twin of the PDF
 * `useDevSampleFile`. The uploader hands the EPUB over in memory (no
 * persistence — D3), so a direct visit to `/read?format=epub` has no file. This
 * fetches a tiny bundled sample EPUB and returns it as a `File` so the reader is
 * verifiable without the uploader.
 *
 * DOUBLE-GATED so it never ships as default behavior (same as the PDF sample):
 *   - `import.meta.env.DEV` — stripped from production builds entirely.
 *   - `enabled` — the caller only turns it on for an explicit `?dev=1` param.
 * In production this returns `null` and the asset is never bundled.
 */
export function useDevSampleEpub(enabled: boolean): File | null {
  const [file, setFile] = useState<File | null>(null);

  useEffect(() => {
    if (!import.meta.env.DEV || !enabled) return;
    let cancelled = false;
    (async () => {
      // Dynamic import so the asset URL is only resolved when explicitly enabled.
      const { default: sampleUrl } = await import("./sample.epub?url");
      const res = await fetch(sampleUrl);
      const blob = await res.blob();
      if (!cancelled) {
        setFile(new File([blob], "sample.epub", { type: "application/epub+zip" }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return file;
}
