import { createFontHandle } from "./fontkit-handle.ts";
import type { FontFamily, FontHandle, FontProvider, FontRequest, FontSlant, FontWeight } from "./handle.ts";

/**
 * The Latin Modern face set — the engine's default typeface, and the reason a
 * document it sets looks like a TeX document rather than like a web page.
 *
 * This module is **pure**: it turns font *bytes* into a `FontProvider` and does
 * not know where the bytes came from. That split is deliberate. `compile()`
 * performs no I/O (D38), so the caller injects the provider through
 * `CompileOptions.fonts`; a Node caller gets its bytes from
 * `@ebook-reader/typeset/fonts/node`, a browser caller from `fetch()`, and
 * neither arrangement leaks into `src/`.
 */

/**
 * Every face the engine ships, named by its upstream CTAN filename stem.
 *
 * These strings are `FontHandle.id`, and `FontHandle.id` is printed verbatim
 * into every golden dump — renaming one churns every golden in the repo. The
 * upstream stem is the scheme precisely because it is not ours to drift: it is
 * fixed by the `lm` package, and it is what a maintainer sees in
 * `assets/fonts/`.
 */
export const LATIN_MODERN_FACE_IDS = [
  "lmroman10-regular",
  "lmroman10-italic",
  "lmroman10-bold",
  "lmroman10-bolditalic",
  "lmsans10-regular",
  "lmsans10-oblique",
  "lmsans10-bold",
  "lmsans10-boldoblique",
  "lmmono10-regular",
  "lmmono10-italic",
  "lmmonolt10-bold",
  "lmmonolt10-boldoblique",
] as const;

export type LatinModernFaceId = (typeof LATIN_MODERN_FACE_IDS)[number];

/**
 * Font files keyed by face id. A missing entry is not an error here — it
 * becomes an `undefined` from `get()`, and thence a `missing-font` diagnostic
 * from the caller — so a browser that fetched only the roman faces is a
 * perfectly legitimate input.
 */
export type LatinModernBytes = Readonly<Partial<Record<LatinModernFaceId, Uint8Array>>>;

/**
 * Which file answers which request.
 *
 * Two entries deserve their explanation in the code rather than only in
 * `assets/fonts/README.md`:
 *
 * - **Sans italic is `oblique`.** Latin Modern Sans, like Computer Modern Sans,
 *   has no true italic; the slanted face *is* the family's italic and is what
 *   LaTeX binds `\itshape` to. Not a substitution.
 * - **Mono bold comes from the "Light" series.** Computer Modern Typewriter has
 *   no bold at all and Latin Modern inherits that; `lmmonolt10-bold` is the only
 *   bold typewriter GUST ships and is what TeX distributions use for
 *   `\ttfamily\bfseries`. Choosing it once, here, in a table a reader can see is
 *   the opposite of substituting silently at request time.
 */
const FACE_FOR: Record<FontFamily, Record<FontWeight, Record<FontSlant, LatinModernFaceId>>> = {
  serif: {
    regular: { upright: "lmroman10-regular", italic: "lmroman10-italic" },
    bold: { upright: "lmroman10-bold", italic: "lmroman10-bolditalic" },
  },
  sans: {
    regular: { upright: "lmsans10-regular", italic: "lmsans10-oblique" },
    bold: { upright: "lmsans10-bold", italic: "lmsans10-boldoblique" },
  },
  mono: {
    regular: { upright: "lmmono10-regular", italic: "lmmono10-italic" },
    bold: { upright: "lmmonolt10-bold", italic: "lmmonolt10-boldoblique" },
  },
};

/** The face a request resolves to, whether or not its bytes are available. */
export function latinModernFaceId(request: FontRequest): LatinModernFaceId {
  return FACE_FOR[request.family][request.weight][request.slant];
}

/**
 * A `FontProvider` over the supplied bytes.
 *
 * Handles are parsed on first use and then cached: a document that only ever
 * asks for roman regular never pays to parse the other eleven faces, and one
 * that asks a thousand times parses once. `get()` returns `undefined` — never a
 * near-enough face — when the requested bytes are absent, because the caller's
 * `missing-font` diagnostic is more useful to a reader than a page silently set
 * in the wrong typeface.
 */
export function createLatinModernProvider(bytes: LatinModernBytes): FontProvider {
  const handles = new Map<string, FontHandle>();

  return {
    get(request: FontRequest): FontHandle | undefined {
      const id = latinModernFaceId(request);

      const cached = handles.get(id);
      if (cached !== undefined) return cached;

      const data = bytes[id];
      if (data === undefined) return undefined;

      const handle = createFontHandle(id, data);
      handles.set(id, handle);
      return handle;
    },
  };
}
