import type { MathJaxInstance } from "mathjax";
import { error } from "../diagnostics.ts";
import { classifyTexError, findMathmlErrors } from "./errors.ts";
import { findUnresolvedSvgReferences, readMathGeometry } from "./geometry.ts";
import { checkMathSubset } from "./subset.ts";
import type { MathRenderer, MathRequest, MathResult } from "./index.ts";

/**
 * The MathJax bridge (D41): one TeX math run in, one SVG plus its placement
 * geometry out, and every failure on the way a real Atrium `Diagnostic`.
 *
 * ## Why this is the only file that names `mathjax`
 *
 * `packages/typeset/src/` is a pure library — no filesystem, no network, no
 * processes — and `"types": []` turns that from a convention into a compile
 * error. MathJax breaks the *transitive* half of that: `init()` loads its
 * components off disk. That is the same shape as the `fontkit` caveat already
 * recorded in `wiki/typeset.md`, and it is acceptable for the same reason, but
 * only under one condition, which this file exists to hold:
 *
 * **No document may steer what gets loaded.** Two things enforce it.
 *
 * 1. `LOADED_COMPONENTS` is a frozen literal. Nothing derives from the input.
 * 2. MathJax's **`require` and `autoload` packages are dropped**, which is a
 *    deviation from settled call §1 and a deliberate one. Measured against
 *    `mathjax@4.1.3`: with them loaded, `\require{physics}` — and, through
 *    `autoload`, plain `\color{red}{x}` or `\href{…}{y}` — makes `tex2svg`
 *    **throw** `MathJax retry -- an asynchronous action is required`, because
 *    MathJax has decided to go and load another component *at the document's
 *    request*. That is precisely the property the fontkit precedent depends on
 *    not being true, and it turns an out-of-subset construct into an exception
 *    rather than a diagnostic. Dropped, every one of them becomes a clean
 *    `Undefined control sequence`, which `errors.ts` maps back to `unsupported`
 *    so the author is still told the truth about `\color`.
 *
 * The import is **dynamic**, so `src/index.ts`'s static module graph does not
 * pull ~70 MB of MathJax into a caller that never sets any math. And the
 * renderer is *injected* rather than constructed inside `compile()`: the engine
 * is synchronous and `init()` is not, and injection is the shape this engine
 * already uses for the other thing it cannot acquire itself (`CompileOptions.fonts`).
 *
 * ## Why undefined macros must be loud
 *
 * MathJax's default package set includes **`noundefined`**, which renders an
 * unknown control sequence as red text and reports *nothing at all*. Left in,
 * that puts a silently wrong answer inside the one contract this engine exists
 * to keep (D38). Dropped, `tex.formatError` fires with
 * `Undefined control sequence \foo` and the run is refused. `math-bridge.test.ts`
 * asserts both behaviours, because this is the single most reversible mistake
 * in the file and nothing else would catch it.
 */

/** Frozen: the document never contributes to this, which is the whole point. */
const LOADED_COMPONENTS = ["input/tex", "output/svg"] as const;

/**
 * `noundefined` — see above, the loud-failure requirement.
 * `require`/`autoload` — see above, the no-document-steered-loading requirement.
 */
const DROPPED_PACKAGES = ["noundefined", "require", "autoload"] as const;

/**
 * `fontCache: "none"` inlines every glyph as `<path>` data rather than emitting
 * `<use>` against a shared `<defs>`. Verified against `mathjax@4.1.3`: with it,
 * an SVG run contains no `<use>` and no `<defs>` at all, which is what lets
 * chunk 40.1's emitter be paths-and-transforms and nothing more.
 *
 * **`linebreaks: { inline: false }` is not cosmetic.** MathJax v4 breaks long
 * inline math across lines *by itself*, and it does it by emitting several
 * `<svg>` elements separated by `<mjx-break>` inside one container — measured:
 * `\to\gets\longrightarrow\hookrightarrow` comes back as seven children.
 * Three reasons that is wrong here, any one of which would be enough:
 *
 * - **Brief 40 puts line breaking inside math explicitly out of scope.** A
 *   display equation too wide for the text block is meant to produce a
 *   diagnostic so the author can break it themselves.
 * - **Atrium already breaks lines**, with Knuth–Plass over its own boxes and
 *   glue. A second breaker upstream, working to a width this engine never told
 *   it, would fight the first one.
 * - **A run has to be one box.** Brief 40's overrun check measures a rendered
 *   display against the text width; pre-broken pieces have no such width left
 *   to measure, and chunk 40.1's emitter takes one SVG.
 *
 * Turned off, every run comes back as exactly one `<svg>` at its natural width,
 * which is what `render()` asserts below.
 */
const SVG_OPTIONS = { fontCache: "none", linebreaks: { inline: false } } as const;

/**
 * **The lazy-font problem, and why this string exists.**
 *
 * MathJax v4 splits New Computer Modern into *dynamic ranges* — `double-struck`,
 * `script`, `arrows`, `symbols` and thirty-odd more — and loads each one off
 * disk the first time a glyph in it is needed. Measured against
 * `mathjax@4.1.3`: a cold `tex2svg("\\mathbb{R}")` does not draw a blackboard
 * R, it **throws** `MathJax retry -- an asynchronous action is required`.
 *
 * That is a bigger version of the `\require` hazard this file already guards
 * against, and it cannot be closed by dropping a package: the trigger is an
 * ordinary in-subset glyph. Two things close it instead.
 *
 * 1. **This warm-up.** One representative glyph per range brief 40's In list can
 *    reach, rendered through the *promise* API at construction time — where
 *    async is allowed and a caller is already awaiting. Ranges load whole, so
 *    one `\mathbb{R}` brings in every blackboard letter. After it, `render()` is
 *    genuinely synchronous and genuinely reads nothing.
 * 2. **The gate runs first, on the MathML.** `tex2mml` needs no font data at
 *    all, so an out-of-subset alphabet (`\mathfrak`, `\mathsf`) is refused
 *    before anything could go looking for its glyphs. The ranges reachable from
 *    `render()` are therefore exactly the ranges the In list names — which is
 *    what makes a fixed warm-up list sufficient rather than a hopeful guess.
 *
 * `math-bridge.test.ts` sweeps the In list synchronously and fails if any of it
 * still needs a load, so a missing range shows up as a red test rather than as
 * a thrown retry in a compile. Anything that slips through both is still caught:
 * `errors.ts` maps a retry to a diagnostic, never to an exception.
 *
 * Both styles are warmed because display style pulls the large and stretchy
 * variants of a glyph, which live apart from the inline ones.
 */
const FONT_WARMUP =
  "\\mathbb{R}\\mathcal{L}\\wp\\Re\\Im\\ell\\diamondsuit\\perp\\nleq\\rightsquigarrow" +
  "\\varepsilon\\hat{x}\\left\\langle x\\right\\rangle\\sum\\triangle" +
  // Text mode reaches its own ranges: accented Latin, and the punctuation and
  // currency a sentence inside `\\text{}` can carry.
  "\\text{caf\u00e9 na\u00efve Stra\u00dfe \u00c5ngstr\u00f6m \u0153uvre \u00a3100 \u00a9 \u2020}";

/**
 * Build a renderer. Async once, per process — `init()` reads MathJax's
 * components off disk, and calling it a second time with the same config
 * returns the same instance rather than doing the work twice.
 *
 * Nothing here throws for a *document* reason. It can still reject if MathJax
 * itself cannot be loaded at all, which is a deployment problem and not
 * something a diagnostic can usefully describe.
 */
export async function createMathRenderer(): Promise<MathRenderer> {
  const { init } = await import("mathjax");

  // Filled by the `formatError` hook below and drained around each conversion.
  // Safe as shared state because every MathJax call the bridge makes is
  // synchronous: nothing can interleave between the drain and the read.
  const captured: string[] = [];

  const mathjax: MathJaxInstance = await init({
    loader: { load: LOADED_COMPONENTS },
    svg: SVG_OPTIONS,
    tex: {
      packages: { "[-]": DROPPED_PACKAGES },
      formatError: (jax, texError) => {
        captured.push(texError.message);
        // Hand back MathJax's own rendering of the error. Suppressing it would
        // make `tex2svg` throw instead, and the bridge wants a value it can
        // discard, not an exception it has to reconstruct a message from.
        return jax.formatError(texError);
      },
    },
  });

  const adaptor = mathjax.startup.adaptor;

  // Pull in every font range the subset can reach, before anyone can call
  // `render()`. See `FONT_WARMUP`: without this, an in-subset `\mathbb{R}`
  // throws rather than draws. Diagnostics from the priming expression are
  // discarded — it is our own TeX, not the document's, and if it ever stops
  // being valid the In-list sweep in the tests is what says so.
  await mathjax.tex2svgPromise(FONT_WARMUP, { display: true });
  await mathjax.tex2svgPromise(FONT_WARMUP, { display: false });
  captured.length = 0;

  const drain = (): string[] => captured.splice(0, captured.length);

  return {
    render(request: MathRequest): MathResult {
      const { tex, display, at } = request;

      // 1. MathML first. The gate runs on it (settled call §5), and getting it
      //    is also the cheapest way to find out whether the run parses at all —
      //    so a refused expression is never drawn, and a refused construct can
      //    never leak into a PDF as a picture nobody gated.
      drain();
      let mathml: string;
      try {
        mathml = mathjax.tex2mml(tex, { display });
      } catch (cause) {
        return { run: null, diagnostics: [classifyTexError(messageOf(cause), at)] };
      }

      // The hook is the specified channel; the `<merror>` scan is the backstop
      // for a MathJax that stops calling it. Deduplicated, because MathJax
      // reports the same failure through both.
      const texErrors = dedupe([...drain(), ...findMathmlErrors(mathml)]);
      if (texErrors.length > 0) {
        return { run: null, diagnostics: texErrors.map((message) => classifyTexError(message, at)) };
      }

      // 2. The subset gate (D41). MathJax can set more than brief 40 promises;
      //    anything outside the In list is refused here even though the SVG
      //    below would have come out clean.
      const gated = checkMathSubset(mathml, at);
      if (gated.length > 0) return { run: null, diagnostics: gated };

      // 3. Only now, the picture.
      drain();
      let container: unknown;
      try {
        container = mathjax.tex2svg(tex, { display });
      } catch (cause) {
        return { run: null, diagnostics: [classifyTexError(messageOf(cause), at)] };
      }
      const svgErrors = drain();
      if (svgErrors.length > 0) {
        // The MathML pass already succeeded, so the same source failing here is
        // an inconsistency inside MathJax rather than anything the document did.
        return {
          run: null,
          diagnostics: [
            error("internal", at, `MathJax set this run as MathML but failed to draw it: ${svgErrors.join("; ")}`),
          ],
        };
      }

      const children = adaptor.childNodes(container);
      const svgNode = children[0];
      if (children.length !== 1 || svgNode === undefined) {
        return {
          run: null,
          diagnostics: [
            error("internal", at, `MathJax's container held ${children.length} children where exactly one <svg> was expected`),
          ],
        };
      }
      const svg = adaptor.outerHTML(svgNode);

      const unresolved = findUnresolvedSvgReferences(svg);
      if (unresolved.length > 0) {
        // Settled call §2's guard. The emitter draws paths and transforms only,
        // so a `<use>` would come out as a formula missing glyphs — wrong output
        // presented as success, which is the outcome D38 exists to prevent.
        return {
          run: null,
          diagnostics: [
            error(
              "internal",
              at,
              `MathJax emitted ${unresolved.join(" and ")} despite fontCache:"none"; the SVG emitter resolves neither`,
            ),
          ],
        };
      }

      const { geometry, diagnostics } = readMathGeometry(svg, at);
      if (geometry === null) return { run: null, diagnostics };

      return { run: { svg, display, geometry }, diagnostics: [] };
    },
  };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function dedupe(messages: readonly string[]): string[] {
  return [...new Set(messages)];
}
