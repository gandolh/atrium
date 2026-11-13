/**
 * The three button looks (D63), as class strings for a `<button>` or a `<Link>`:
 *
 * - `BUTTON`: the secondary button, an `outline` edge on `paper-raised`.
 * - `BUTTON_SOLID`: the solid ink button. Accent never fills a button.
 * - `BUTTON_QUIET`: no edge, for a row's quiet action.
 *
 * All are 44 px tall and 12 px round; a matched pair on a phone adds `max-[820px]:h-12`.
 */
const BASE =
  "inline-flex h-11 items-center justify-center gap-2 rounded-card px-4 font-ui text-ui font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed [&_svg]:shrink-0";

export const BUTTON = `${BASE} border border-outline bg-paper-raised text-ink hover:bg-paper-low disabled:opacity-50 [&_svg]:text-ink-variant`;

export const BUTTON_SOLID = `${BASE} bg-ink-fill px-5 font-semibold text-on-ink-fill hover:bg-ink-fill-hover disabled:bg-paper-container disabled:text-ink-variant`;

export const BUTTON_QUIET = `${BASE} text-ink-variant hover:text-ink disabled:opacity-50`;
