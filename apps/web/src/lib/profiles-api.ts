import {
  preferencesSchema,
  profileListSchema,
  profileSchema,
  type CreateProfileRequest,
  type Preferences,
  type Profile,
  type UpdateProfileRequest,
} from "@ebook-reader/shared";

import { apiFetch } from "./api-client";

/**
 * Profile API calls (brief 35, D35). Thin wrappers over the Fastify
 * `/profiles` routes, shaped exactly like notes-api.ts: responses validate
 * against the shared Zod contract so client and server can't drift (D11),
 * auth rides on `apiFetch`'s bearer token, and `ApiError` propagates.
 *
 * The status codes ARE part of this contract, so nothing here swallows one:
 * 400 (the cap of five, or deleting the last profile), 409 (duplicate name, or
 * a profile that still owns notes and needs `reassign`), 404 (a profile id
 * belonging to another account — never a 200, never a 403, since the account
 * must not learn that the id exists).
 *
 * Note there is no profile header or query param anywhere below. The session
 * carries the active profile server-side (brief decision 1), so
 * `activateProfile` is the ONLY thing that changes what every subsequent
 * request is scoped to — which is also why `auth.ts` pairs it with a cache
 * clear rather than a refetch.
 */

export async function fetchProfiles(): Promise<Profile[]> {
  const res = await apiFetch("/profiles");
  return profileListSchema.parse(await res.json());
}

export async function createProfile(body: CreateProfileRequest): Promise<Profile> {
  const res = await apiFetch("/profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return profileSchema.parse(await res.json());
}

export async function updateProfile(id: string, fields: UpdateProfileRequest): Promise<Profile> {
  const res = await apiFetch(`/profiles/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  return profileSchema.parse(await res.json());
}

/**
 * Delete a profile. Without `reassign` the server refuses (409) when the
 * profile still owns notes — decision 3: progress may be dropped with the
 * profile, but notes are *authored* work and are never silently destroyed.
 * Pass `{ reassign: true }` to move them to the account's default profile
 * instead, which is what the manage screen's confirm step opts into.
 */
export async function deleteProfile(id: string, options?: { reassign?: boolean }): Promise<void> {
  const query = options?.reassign ? "?reassign=1" : "";
  await apiFetch(`/profiles/${id}${query}`, { method: "DELETE" });
}

/** Point the session at `id`; every later request is scoped to it. */
export async function activateProfile(id: string): Promise<Profile> {
  const res = await apiFetch(`/profiles/${id}/activate`, { method: "POST" });
  return profileSchema.parse(await res.json());
}

/**
 * Read the profile's preferences blob. `{}` if the profile has never written
 * one (the DB column is NULL until the first PATCH — migration deliberately
 * leaves it unset, brief 35 step 8) — never a 404 for that case, only for a
 * profile id that isn't this account's.
 */
export async function fetchPreferences(id: string): Promise<Preferences> {
  const res = await apiFetch(`/profiles/${id}/preferences`);
  return preferencesSchema.parse(await res.json());
}

/**
 * Merge a partial preferences patch into the profile's blob and return the
 * MERGED result — the server owns the merge, so a client sending `{ theme }`
 * never has to round-trip the keys it isn't changing (and can't strip a newer
 * client's unknown key by omission; see `preferencesSchema`'s passthrough).
 */
export async function updatePreferences(id: string, patch: Preferences): Promise<Preferences> {
  const res = await apiFetch(`/profiles/${id}/preferences`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return preferencesSchema.parse(await res.json());
}
