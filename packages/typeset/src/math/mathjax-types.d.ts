/**
 * A minimal ambient declaration for `mathjax@4.1.3`, which ships no types of
 * its own (it is the *packaged component* distribution — the sources, and such
 * types as exist, live in `@mathjax/src`, which we deliberately do not depend
 * on).
 *
 * This describes only the four things `bridge.ts` touches: `init`, `tex2mml`,
 * `tex2svg`, and the DOM adaptor that serialises a node. Everything else is
 * left off on purpose — a fuller declaration would be a second, unverifiable
 * copy of MathJax's API that nothing checks against the real package, and the
 * bridge's tests are what actually pin this contract.
 *
 * The file is named `mathjax-types.d.ts` rather than `mathjax.d.ts` because
 * `bridge.ts` sits beside it: a `mathjax.d.ts` next to a `mathjax.ts` would be
 * read as that module's declaration file rather than as an ambient one.
 */
declare module "mathjax" {
  /** A TeX error as MathJax's `formatError` hook receives it. */
  export interface MathJaxTexError {
    /** e.g. `Undefined control sequence \foo`, `Missing argument for \frac`. */
    message: string;
  }

  /** The TeX input jax, passed to `formatError` so its default can be reused. */
  export interface MathJaxTexInputJax {
    formatError(error: MathJaxTexError): unknown;
  }

  /**
   * MathJax's DOM abstraction. Node identity is opaque here — the bridge only
   * ever walks one level down and asks for serialised HTML.
   */
  export interface MathJaxAdaptor {
    outerHTML(node: unknown): string;
    childNodes(node: unknown): unknown[];
  }

  export interface MathJaxConfig {
    loader?: { load?: readonly string[] };
    svg?: {
      fontCache?: "none" | "local" | "global";
      /** v4 breaks long inline math into several `<svg>`s unless this is off. */
      linebreaks?: { inline?: boolean };
    };
    tex?: {
      packages?: { "[-]"?: readonly string[]; "[+]"?: readonly string[] };
      formatError?: (jax: MathJaxTexInputJax, error: MathJaxTexError) => unknown;
    };
  }

  export interface MathJaxInstance {
    /** TeX → MathML, serialised. The subset gate's input. */
    tex2mml(tex: string, options?: { display?: boolean }): string;
    /** TeX → an SVG container node, to be serialised through the adaptor. */
    tex2svg(tex: string, options?: { display?: boolean }): unknown;
    /**
     * The async form. Used once, at construction, to pull in the lazily-loaded
     * font ranges — see `FONT_WARMUP` in `bridge.ts`. Never used per render:
     * `compile()` is synchronous.
     */
    tex2svgPromise(tex: string, options?: { display?: boolean }): Promise<unknown>;
    startup: { adaptor: MathJaxAdaptor };
  }

  export function init(config: MathJaxConfig): Promise<MathJaxInstance>;
}
