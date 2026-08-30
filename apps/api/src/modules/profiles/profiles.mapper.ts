import { preferencesSchema, type Preferences, type Profile } from "@ebook-reader/shared";
import type { ProfileRow } from "./profiles.model.js";

/**
 * Row → wire for profiles. Shared with the auth module, which builds the login
 * response's `profile` and `profiles` from the same rows.
 */
export function toProfile(row: ProfileRow): Profile {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    createdAt: row.created_at,
    // SQLite stores the flag as 1/0; the contract is a boolean.
    isDefault: row.is_default === 1,
  };
}

/**
 * Decode a stored preferences blob, dropping anything the contract rejects.
 *
 * Falling back to `{}` rather than throwing is deliberate: a blob corrupted
 * outside the app would otherwise make every future PATCH a permanent 500 with
 * no way to write over it. Unknown *keys* are not corruption —
 * `preferencesSchema` is `.passthrough()`, so they survive this and the merge
 * in the service (brief 35 step 8).
 */
export function storedPreferences(raw: string | null): Preferences {
  if (!raw) return {};
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return {};
  }
  const parsed = preferencesSchema.safeParse(decoded);
  return parsed.success ? parsed.data : {};
}
