import { PROFILE_COLORS, type ProfileColor } from "@ebook-reader/shared";

/**
 * Profile colour token → Reading Room kind tint (design.md "Kind tints", D33).
 *
 * The wire carries a token NAME, never a hex (see `profile.ts` in the shared
 * contract): each tint resolves differently in light, sepia and dark, so only
 * this layer — where the stylesheet is — can turn one into a colour. This file
 * is that map and nothing more. It deliberately reuses the four existing kind
 * tints instead of introducing a profile palette: D33's palette is settled, and
 * a fifth decorative colour would break the "one decorative move" rule and the
 * tint test along with it.
 *
 * Naming is a reuse, not a claim: a `rose` profile has nothing to do with music.
 * The tints are simply the four ground colours the system already guarantees are
 * distinguishable from each other and from `--paper` in all three themes.
 */

/**
 * Colour → Tailwind background class, spelled out as full literal class names
 * rather than built with a template literal. Tailwind's compiler only sees
 * class names that appear literally in source, so `` `bg-tint-${color}` ``
 * would silently ship unstyled — the same trap CoverCard.tsx documents.
 */
export const PROFILE_TINT_CLASS: Record<ProfileColor, string> = {
  cream: "bg-tint-book",
  rose: "bg-tint-music",
  sky: "bg-tint-video",
  mint: "bg-tint-note",
};

/**
 * Colour → the underlying CSS custom property, for the rare place a class can't
 * reach (an inline `style`, or a non-CSS API via `tokens.ts`'s `cssToken`).
 * Prefer `profileTintClass` — a `var()` resolved in JS is a snapshot and won't
 * follow a theme change on its own.
 */
export const PROFILE_TINT_VAR: Record<ProfileColor, string> = {
  cream: "--tint-book",
  rose: "--tint-music",
  sky: "--tint-video",
  mint: "--tint-note",
};

/** Human labels for the manage screen's colour chooser (swatches need names). */
export const PROFILE_COLOR_LABEL: Record<ProfileColor, string> = {
  cream: "Cream",
  rose: "Rose",
  sky: "Sky",
  mint: "Mint",
};

/** The tint background class for a profile's colour — how a tile gets painted. */
export function profileTintClass(color: ProfileColor): string {
  return PROFILE_TINT_CLASS[color];
}

/**
 * The colour to pre-select when adding a profile: the first one not already
 * taken, falling back to the head of the palette once all four are in use
 * (four colours against a cap of five profiles is deliberate — colour is a
 * glance cue, not a key; names are what must be unique).
 */
export function suggestProfileColor(taken: readonly ProfileColor[]): ProfileColor {
  return PROFILE_COLORS.find((c) => !taken.includes(c)) ?? PROFILE_COLORS[0];
}
