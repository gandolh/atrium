import { useEffect, useState } from "react";

/**
 * DEV-ONLY, OPT-IN sample loader. The uploader hands the PDF over in memory
 * (no persistence — D3), so a direct visit to `/read` has no file. To verify
 * rendering without the uploader, this fetches a bundled sample PDF and returns
 * it as a `File`.
 *
 * GATED so it never ships as default behavior:
 *   - `import.meta.env.DEV` — stripped from production builds entirely.
 *   - `enabled` — the caller only turns it on for an explicit `?dev=1` param.
 * In production this hook returns `null` and the sample is never bundled into
 * the app graph beyond the dev server.
 */
export function useDevSampleFile(enabled: boolean): File | null {
  const [file, setFile] = useState<File | null>(null);

  useEffect(() => {
    if (!import.meta.env.DEV || !enabled) return;
    let cancelled = false;
    void (async () => {
      // Dynamic import so the asset URL is only resolved when explicitly enabled.
      const { default: sampleUrl } = await import("./sample.pdf?url");
      const res = await fetch(sampleUrl);
      const blob = await res.blob();
      if (!cancelled) {
        setFile(new File([blob], "sample.pdf", { type: "application/pdf" }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return file;
}
