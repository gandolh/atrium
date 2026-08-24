import { useEffect, useState } from "react";
import type { Transition } from "motion/react";

/**
 * Reading Room motion primitives (wiki/design.md "Motion", D33).
 *
 * "Paper moves like paper: things lift, settle and fade. Nothing bounces,
 * springs past its mark, or slides in from off-screen." One curve, one set of
 * durations, one reduced-motion path — established here so briefs 28–33 reuse
 * them instead of each rolling its own.
 *
 * Two idioms are sanctioned and no more:
 *   - **Motion** (`motion/react`, the Motion Primitives base) for React-driven
 *     motion: grid re-filter, cover → reader shared layout, dock enter.
 *   - **anime.js** (`animejs`) for the progress rail ONLY, where an imperative
 *     timeline beats React state. SmoothUI is deliberately out.
 * Card hover and reader-chrome fade are plain CSS (`ease-paper` utility /
 * `var(--ease-paper)`); they need no library.
 */

/**
 * The system's single easing curve, as Motion/anime.js want it: a control-point
 * tuple. The CSS twin is `--ease-paper` in globals.css (Tailwind utility:
 * `ease-paper`) — change one and change the other.
 */
export const EASE_PAPER: readonly [number, number, number, number] = [0.2, 0.7, 0.3, 1];

/** The same curve as a CSS value, for inline styles and imperative animations. */
export const EASE_PAPER_CSS = "cubic-bezier(0.2, 0.7, 0.3, 1)";

/**
 * Durations in **milliseconds**, one per sanctioned moment (design.md "Motion").
 * `MOTION_S` is the same table in seconds, the unit Motion's `Transition` takes.
 */
export const MOTION_MS = {
  /** Card hover: lift 4px, shadow deepens. */
  hover: 300,
  /** Grid re-filter: tiles settle. Pair with `STAGGER_MS`. */
  refilter: 340,
  /** Cover → reader: the cover expands into the page (shared layout). */
  expand: 420,
  /** Player dock rises from the foot on playback start. */
  dock: 280,
  /** Reader chrome fading out on idle. */
  chromeOut: 600,
  /** Reader chrome coming back on interaction. */
  chromeIn: 150,
} as const;

/** Per-child delay for the grid re-filter settle, in milliseconds. */
export const STAGGER_MS = 20;

export type MotionMoment = keyof typeof MOTION_MS;

/** `MOTION_MS` in seconds — Motion's `Transition.duration` unit. */
export const MOTION_S = Object.fromEntries(
  Object.entries(MOTION_MS).map(([k, v]) => [k, v / 1000]),
) as Record<MotionMoment, number>;

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * One-shot read of the user's reduced-motion preference, for imperative code
 * (anime.js timelines, event handlers) that cannot use a hook. React components
 * should prefer {@link usePrefersReducedMotion}, which re-renders when the OS
 * setting changes mid-session.
 */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia(REDUCED_QUERY).matches;
}

/**
 * Live reduced-motion preference. Updates if the user flips the OS setting
 * while the app is open (the media query fires; a mount-time snapshot would
 * silently keep animating).
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const mq = window.matchMedia(REDUCED_QUERY);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/**
 * The reduced-motion wrapper every animated surface should go through.
 *
 * Builds a Motion `Transition` for one sanctioned moment on the system curve,
 * and — when the user asks for reduced motion — collapses it to a zero-duration
 * transition. The animation still *runs*, so the element still lands in its
 * final state and nothing is left mid-flight; it simply arrives instantly.
 * That degrades every call site the same way instead of each one inventing an
 * `if (reduced) return null`.
 *
 * ```tsx
 * const transition = useMotionTransition("refilter");
 * <motion.div layout transition={transition} />
 * ```
 *
 * @param moment which entry of {@link MOTION_MS} sets the duration
 * @param overrides merged last, so a call site can add `delay`, `layout`, etc.
 *   (`duration`/`ease` in here still lose to the reduced-motion collapse)
 */
export function useMotionTransition(
  moment: MotionMoment = "hover",
  overrides?: Transition,
): Transition {
  const reduced = usePrefersReducedMotion();
  return motionTransition(moment, reduced, overrides);
}

/**
 * Non-hook twin of {@link useMotionTransition}, for code that already knows the
 * preference (a parent passing it down, or an imperative timeline).
 */
export function motionTransition(
  moment: MotionMoment,
  reduced: boolean,
  overrides?: Transition,
): Transition {
  if (reduced) return { ...overrides, duration: 0, delay: 0 };
  return { duration: MOTION_S[moment], ease: [...EASE_PAPER], ...overrides };
}

/**
 * Stagger for the grid re-filter, already reduced-motion aware: with reduced
 * motion every child lands at once (delay 0) rather than rippling.
 *
 * Spread into a Motion container variant's `transition`:
 * ```tsx
 * transition: { ...motionTransition("refilter", reduced), ...staggerChildren(reduced) }
 * ```
 */
export function staggerChildren(reduced: boolean, stepMs: number = STAGGER_MS): Transition {
  return { staggerChildren: reduced ? 0 : stepMs / 1000 };
}
