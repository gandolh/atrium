import type { AbortLike } from "../compile.ts";
import type { Diagnostic, SourceRef } from "../diagnostics.ts";
import { error } from "../diagnostics.ts";

/**
 * The deterministic step budget (D38), threaded through macro expansion and
 * document building. A *count*, not a clock: the same document costs the same
 * number of steps on every machine, so "this compile was stopped" is
 * reproducible and testable in a way a timeout never is.
 *
 * Macro expansion is the budget's main consumer, because it is the only place
 * in this chunk where the work is not bounded by the size of the input:
 * `\newcommand{\x}{\x}` produces nodes forever, and the budget is what stops
 * it. Everything else spends a step per node mostly so a pathological *input*
 * (a megabyte of nested groups) also has a ceiling.
 */
export interface Budget {
  /** Steps still available. Never goes below zero. */
  remaining: number;
  /** Steps consumed so far — reported as `CompileStats.steps`. */
  spent: number;
  /** Latched once the budget or the signal stops the run. */
  stopped: boolean;
  /** Set when `signal.aborted` was what stopped it, rather than the count. */
  cancelled: boolean;
  /**
   * Latched by whichever stage reported the stop. Shared across stages so a
   * runaway macro produces one diagnostic and not one per stage it unwinds
   * through.
   */
  reported: boolean;
  signal: AbortLike | null;
}

export function createBudget(limit: number, signal: AbortLike | null = null): Budget {
  return { remaining: Math.max(0, limit), spent: 0, stopped: false, cancelled: false, reported: false, signal };
}

/**
 * Charge `cost` steps. Returns `false` once the run must stop — callers unwind
 * rather than throwing, because `compile()` reserves exceptions for engine
 * bugs and a runaway macro is not a bug in the engine.
 *
 * The abort signal is polled here rather than subscribed to: the engine is
 * synchronous, so a step boundary is the only place cancellation can be
 * observed at all.
 */
export function spend(budget: Budget, cost = 1): boolean {
  if (budget.stopped) return false;
  if (budget.signal !== null && budget.signal.aborted) {
    budget.stopped = true;
    budget.cancelled = true;
    return false;
  }
  budget.spent += cost;
  budget.remaining -= cost;
  if (budget.remaining <= 0) {
    budget.remaining = 0;
    budget.stopped = true;
    return false;
  }
  return true;
}

/**
 * The one diagnostic a stopped budget produces. Emitted once per build, not
 * once per node, so a runaway macro does not also produce a runaway diagnostic
 * list.
 */
export function budgetDiagnostic(budget: Budget, at: SourceRef, detail?: string): Diagnostic {
  if (budget.cancelled) {
    return error("budget-exceeded", at, "compilation was cancelled");
  }
  const base = `the step budget of ${budget.spent} steps ran out`;
  return error("budget-exceeded", at, detail ? `${base} — ${detail}` : base);
}
