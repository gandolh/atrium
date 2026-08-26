import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The Node half of the font story: the one place in this package that opens a
 * file.
 *
 * `compile()` performs no I/O (D38) — that is the whole security design, and
 * `src/` is compiled with `"types": []` so a stray `node:fs` import there is a
 * type error rather than a code-review question. But fonts live in files, and
 * `CompileOptions.fonts` exists precisely because *somebody* has to read them.
 * That somebody is this module: it lives outside `src/`, compiles as its own
 * program with the Node types, and hands back plain bytes.
 *
 * It deliberately imports nothing from `src/`. Bytes in, bytes out — so the
 * only thing a browser build has to replace is a `fetch()`, and the pure half
 * (`createLatinModernProvider`) is identical in both worlds:
 *
 * ```ts
 * import { createLatinModernProvider } from "@ebook-reader/typeset";
 * import { loadLatinModernBytes } from "@ebook-reader/typeset/fonts/node";
 *
 * const fonts = createLatinModernProvider(loadLatinModernBytes());
 * compile(files, "main.tex", { fonts });
 * ```
 */

/**
 * How far up from this module to look for `assets/fonts`.
 *
 * The module runs from two depths — `node/fonts.ts` when `node --test` executes
 * the TypeScript directly, `dist/fonts.js` once built — and both happen to sit
 * one level below the package root. The search is still a search rather than a
 * fixed `".."` so that a future change of output layout fails loudly at the
 * throw below instead of quietly returning an empty font set.
 */
const MAX_SEARCH_DEPTH = 4;

/** Absolute path of the committed font directory. */
export function latinModernFontDir(): string {
  let dir = import.meta.dirname;
  for (let up = 0; up < MAX_SEARCH_DEPTH; up++) {
    const candidate = join(dir, "assets", "fonts");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `@ebook-reader/typeset: no assets/fonts directory within ${MAX_SEARCH_DEPTH} levels of ${import.meta.dirname}. ` +
      `The fonts are committed to the package; if this fires, the build output moved or the package was published without its assets.`,
  );
}

/**
 * Read every committed face, keyed by filename stem — which is exactly
 * `FontHandle.id`, so the result drops straight into
 * `createLatinModernProvider()`.
 *
 * Reading the directory rather than a hard-coded list means the file set has
 * one source of truth (`assets/fonts/`) instead of two that can drift. A face
 * whose bytes are absent simply never appears, and the provider then answers
 * `undefined` for it so the caller emits `missing-font`.
 *
 * Every face is read eagerly — 1.2 MB in twelve files, once per process —
 * because the alternative is a lazy handle that turns a font lookup deep inside
 * layout into a synchronous disk read, and the engine's callers are entitled to
 * assume that `compile()` itself touches nothing.
 */
export function loadLatinModernBytes(): Record<string, Uint8Array> {
  const dir = latinModernFontDir();
  const bytes: Record<string, Uint8Array> = {};

  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".otf")) continue;
    bytes[name.slice(0, -".otf".length)] = new Uint8Array(readFileSync(join(dir, name)));
  }

  return bytes;
}
