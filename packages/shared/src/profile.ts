import { z } from "zod";

/**
 * Profile contract (brief 35, D35) — a **profile** is a person in the household;
 * an **account** is the household itself. The account is the security boundary
 * (D30's scrypt + opaque sessions); a profile is an *identity* boundary only,
 * because switching is free (no password, no PIN). Anything here is therefore
 * readable by anyone holding a live session on the account, by design.
 *
 * Shared by apps/web and apps/api so the two can't drift (D11).
 */

/**
 * A profile's colour, standing in for Netflix's avatar. These are the Reading
 * Room kind-tint names from design.md / glossary "Tint" — cream (`--tint-book`),
 * rose (`--tint-music`), sky (`--tint-video`), mint (`--tint-note`). The wire
 * carries the *token name*, never a hex: the palette is theme-dependent (light,
 * sepia and dark each resolve these differently) so only the web layer can turn
 * one into a colour.
 *
 * Four names against a cap of five profiles is deliberate — colour is a glance
 * cue, not a key. Names are what must be unique (see `profileSchema.name`).
 */
export const PROFILE_COLORS = ["cream", "rose", "sky", "mint"] as const;
export const profileColorSchema = z.enum(PROFILE_COLORS);
export type ProfileColor = z.infer<typeof profileColorSchema>;

/**
 * Netflix's number (brief 35 decision 8), chosen so the picker stays one row.
 * Exported from the contract rather than the route so the API's 400 and the
 * web's "Add profile" affordance can never disagree about the limit.
 */
export const MAX_PROFILES_PER_ACCOUNT = 5;

export const profileSchema = z.object({
  id: z.string(),
  /**
   * Display name, 1–24 chars after trimming. **Uniqueness is per-account and
   * enforced by the DB** (`profiles_user_name`, a unique index on
   * `(user_id, name)`), not here — a schema cannot see the other profiles on
   * the account, so `POST /profiles` answers a collision with a 409.
   */
  name: z.string().trim().min(1).max(24),
  color: profileColorSchema,
  /** ISO timestamp the profile was created. */
  createdAt: z.string(),
  /**
   * The account's fallback profile: the one the migration created for an
   * existing user, the one a session with a null/dangling `active_profile_id`
   * resolves to, and the one orphaned notes are reassigned to on delete
   * (decision 3). Exactly one per account.
   */
  isDefault: z.boolean(),
});
export type Profile = z.infer<typeof profileSchema>;

/** `GET /profiles` response: the account's own profiles. */
export const profileListSchema = z.array(profileSchema);

/** `POST /profiles` body. `isDefault` is never client-supplied. */
export const createProfileSchema = z.object({
  name: z.string().trim().min(1).max(24),
  color: profileColorSchema,
});
export type CreateProfileRequest = z.infer<typeof createProfileSchema>;

/** `PATCH /profiles/:id` body — rename and/or recolour. */
export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(24).optional(),
    color: profileColorSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.color !== undefined, {
    message: "Nothing to update",
  });
export type UpdateProfileRequest = z.infer<typeof updateProfileSchema>;

/**
 * The reading pane's type settings (mirrors `FontSettings` in
 * apps/web reader-store). Every field optional — see `preferencesSchema`.
 */
export const fontSettingsSchema = z
  .object({
    /** Font size in px. */
    size: z.number().positive().optional(),
    /** `"reading"` is Newsreader, `"ui"` is Archivo (brief 32). */
    family: z.enum(["reading", "ui"]).optional(),
    /** Line spacing multiplier, e.g. 1.78. */
    lineSpacing: z.number().positive().optional(),
    /** Horizontal margin in px. */
    margins: z.number().nonnegative().optional(),
  })
  .passthrough();
export type FontSettingsPreference = z.infer<typeof fontSettingsSchema>;

/**
 * The `profiles.preferences` JSON blob (brief 35 step 8, revising D9 for
 * preferences only): theme, font settings, page mode and TOC sidebar, stored
 * server-side so they follow a person to another device.
 *
 * **Every field is optional and unknown keys pass through** — both are
 * load-bearing, and the instinct to tighten this into a strict schema would
 * break the feature twice over:
 *
 *  1. A profile that has never written preferences has no blob at all
 *     (`preferences` is NULL until the first PATCH), and the migration
 *     deliberately does not write one. `{}` must parse.
 *  2. Brief step 8 requires that *"an older client can't silently strip a newer
 *     client's preference"*. Two devices share one profile row; if the older
 *     one parses, drops what it doesn't recognise, and PATCHes the whole blob
 *     back, the newer device's setting is destroyed with no error anywhere.
 *     `.passthrough()` carries the unknown key through the round trip.
 */
export const preferencesSchema = z
  .object({
    theme: z.enum(["light", "sepia", "dark"]).optional(),
    fontSettings: fontSettingsSchema.optional(),
    pageMode: z.enum(["paged", "scroll"]).optional(),
    tocSidebarOpen: z.boolean().optional(),
  })
  .passthrough();
export type Preferences = z.infer<typeof preferencesSchema>;
