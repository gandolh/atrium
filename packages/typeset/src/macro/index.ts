/**
 * The macro layer (brief 37, chunk 6): the builtin tables and the
 * `\newcommand` expander. See `expand.ts` for why expansion is a queue rather
 * than a recursion, and `builtins.ts` for how to add a command.
 */

export { createBudget, spend, budgetDiagnostic } from "./budget.ts";
export type { Budget } from "./budget.ts";

export {
  BUILTIN_COMMANDS,
  BUILTIN_ENVIRONMENTS,
  DEFINITION_COMMANDS,
  FORMATTING_HOOKS,
  isKnownCommand,
  lookupCommand,
  lookupEnvironment,
} from "./builtins.ts";
export type { BuiltinSpec, EnvironmentSpec, SpecialId } from "./builtins.ts";

export { createExpandContext, expandMacros, mergeAdjacentText } from "./expand.ts";
export type { ExpandContext, MacroDefinition } from "./expand.ts";
