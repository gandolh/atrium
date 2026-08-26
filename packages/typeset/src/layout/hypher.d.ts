/**
 * Local type declarations for `hypher` 0.2.5 and `hyphenation.en-us` 0.2.1,
 * both of which ship JavaScript only.
 *
 * Same reasoning as `src/font/fontkit.d.ts`: this is the exact slice we call,
 * written against the sources it was verified against, so an upgrade that moves
 * any of it fails the typecheck here rather than at runtime. Nothing in this
 * file may appear in the package's public `.d.ts` output — `tsc` neither emits
 * nor copies declaration files — so `hyphenate.ts` exposes its own `Hyphenator`
 * interface and never a `Hypher`.
 *
 * Both packages are CommonJS (`module.exports = …`), so under Node ESM the
 * whole export object arrives as `default`.
 */
declare module "hypher" {
  /**
   * A Liang pattern set, the format Hyphenator.js established.
   *
   * `patterns` is keyed by pattern length; each value is the concatenation of
   * every pattern of that length, which is why the keys are numeric strings.
   * They are integer-like, so `for…in` walks them in ascending numeric order
   * per the ECMAScript ordinary-own-property order — the trie hypher builds
   * from them is therefore identical on every run.
   */
  export interface HyphenationPatterns {
    id: string[];
    /** Minimum characters before the first break — 2 for en-US. */
    leftmin: number;
    /** Minimum characters after the last break — 3 for en-US. */
    rightmin: number;
    patterns: Record<string, string>;
    /** Comma-separated words pre-split with U+2027, overriding the patterns. */
    exceptions?: string;
  }

  class Hypher {
    constructor(language: HyphenationPatterns);
    readonly leftMin: number;
    readonly rightMin: number;
    /**
     * The word split at every legal break. A word it will not break comes back
     * as a single-element array; a word containing U+00AD is returned as-is.
     */
    hyphenate(word: string): string[];
  }

  export default Hypher;
}

declare module "hyphenation.en-us" {
  import type { HyphenationPatterns } from "hypher";
  const patterns: HyphenationPatterns;
  export default patterns;
}
