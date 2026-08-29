import type { Diagnostic, SourceRef } from "../diagnostics.ts";
import { error, unsupported } from "../diagnostics.ts";
import { KNOWN_UNSUPPORTED_COMMANDS, KNOWN_UNSUPPORTED_ENVIRONMENTS } from "./subset.ts";

/**
 * Turning MathJax's TeX errors into Atrium diagnostics — and specifically, into
 * the *right* one.
 *
 * MathJax reports every TeX failure as a single English string. Three of its
 * shapes matter, because D38's contract turns on telling them apart and
 * `wiki/typeset.md` records that the engine has already got this wrong twice:
 *
 * - `Undefined control sequence \foo` — either a typo (`undefined-command`) or
 *   real LaTeX we declined (`unsupported`). Which one it is comes from
 *   `KNOWN_UNSUPPORTED_COMMANDS`, not from the message.
 * - `Unknown environment 'CD'` — same fork, `undefined-environment` against
 *   `KNOWN_UNSUPPORTED_ENVIRONMENTS`.
 * - anything else (`Missing argument for \frac`, `Extra close brace`,
 *   `Misplaced &`) — the source is malformed, which is `syntax`.
 *
 * **Why this fork is load-bearing.** `bridge.ts` drops MathJax's `require` and
 * `autoload` packages, which is what stops a document choosing what the engine
 * loads. The side effect is that `\color`, `\href`, `\cancel` and the whole
 * `\require`-reachable world come back as "undefined". Reporting those as
 * `undefined-command` would tell an author that `\color` is not a thing —
 * false, and useless. The table is the price of the purity.
 */

const UNDEFINED_COMMAND = /^Undefined control sequence (\\\S+)/;
const UNKNOWN_ENVIRONMENT = /^Unknown environment '([^']*)'/;

/**
 * MathJax's escape hatch for "I need to load something first". Documents can no
 * longer trigger it (see `bridge.ts`), so if one ever does it means a package
 * slipped back into the loaded set — report it as the subset refusal it is
 * rather than letting a thrown string reach `compile()`.
 */
const RETRY_MESSAGE = /MathJax retry/;

export function classifyTexError(message: string, at: SourceRef): Diagnostic {
  const command = UNDEFINED_COMMAND.exec(message);
  if (command !== null) {
    const name = command[1] ?? "";
    const declined = KNOWN_UNSUPPORTED_COMMANDS.get(name);
    if (declined !== undefined) return unsupported(at, name, declined);
    return error("undefined-command", at, `${name} is not defined — no such math command, and nothing defined it`, name);
  }

  const environment = UNKNOWN_ENVIRONMENT.exec(message);
  if (environment !== null) {
    const name = environment[1] ?? "";
    const declined = KNOWN_UNSUPPORTED_ENVIRONMENTS.get(name);
    if (declined !== undefined) return unsupported(at, name, declined);
    return error(
      "undefined-environment",
      at,
      `the math environment ${name} is not defined — no such environment, and nothing defined it`,
      name,
    );
  }

  if (RETRY_MESSAGE.test(message)) {
    return unsupported(
      at,
      "math",
      "this construct asked MathJax to load another component, which the engine does not allow (D38: no I/O a document can steer)",
    );
  }

  return error("syntax", at, `math could not be read: ${message}`);
}

/**
 * MathJax renders a failed expression as an `<merror>` node carrying the same
 * message the `formatError` hook saw. The hook is the primary channel — it is
 * what settled call §4 specifies — but reading the node too means a future
 * MathJax that stops calling the hook still cannot produce a silent wrong
 * answer: an unreported `<merror>` would otherwise sail through the subset gate
 * as an allowed element and land in the PDF as the literal words "Undefined
 * control sequence" set in serif.
 */
const MERROR_MESSAGE = /<merror\b[^>]*\bdata-mjx-error\s*=\s*"([^"]*)"/g;

export function findMathmlErrors(mathml: string): string[] {
  const messages: string[] = [];
  MERROR_MESSAGE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MERROR_MESSAGE.exec(mathml)) !== null) {
    messages.push(
      (match[1] ?? "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&"),
    );
  }
  return messages;
}
