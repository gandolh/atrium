/**
 * Local type declarations for `@pdf-lib/fontkit` 1.1.1.
 *
 * The package ships a `fontkit.d.ts`, but it describes neither the default
 * export the UMD bundle actually provides — Node's CJS lexer finds no named
 * exports in it — nor `Subset.encode`, which is the one method that lets this
 * package subset a font *synchronously* (see `subset.ts`). An ambient
 * declaration takes priority over a package's own types, so this replaces them
 * with the exact slice we call, following the same reasoning as
 * `src/font/fontkit.d.ts`: a narrow, verified surface that fails the typecheck
 * if an upgrade moves it.
 *
 * This is a *different* library from the `fontkit` the font layer uses. Both
 * are needed: `fontkit@2` shapes, `@pdf-lib/fontkit@1` subsets into the byte
 * format pdf-lib's font dictionaries describe. Glyph ids are the currency
 * between them, and glyph ids are a property of the file, not of the parser.
 *
 * The shapes themselves live in `fontkit-types.ts` so that they survive into
 * `dist`; nothing in *this* file may appear in an emitted declaration.
 */
declare module "@pdf-lib/fontkit" {
  import type { FontkitFont } from "./fontkit-types.ts";

  const fontkit: {
    create(data: Uint8Array): FontkitFont;
  };
  export default fontkit;
}
