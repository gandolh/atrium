import { z } from "zod";
// Import from the leaf module, not ./index.js, to avoid an import cycle
// (index.js re-exports this file).
import { profileSchema } from "./profile.js";

/**
 * Auth contract. Per-user accounts (username + password); the library itself is
 * shared across all users. Accounts are seeded by the operator — there is no
 * self-registration endpoint. Supersedes the single shared platform password
 * (brief 09): the wire now carries a `username` and login mints a per-user,
 * server-stored session token.
 *
 * An account is the household and the security boundary; the profiles it holds
 * are identities inside it, not permissions (D35) — so the login response can
 * safely hand the client every profile on the account.
 */

/** Login request with username + password. */
export const loginRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * Login response with session token, the resolved username, and the account's
 * profiles (brief 35 step 1).
 *
 * `profile` and `profiles` are **required**, not optional: every account has at
 * least one profile (the migration and the seed script both guarantee a
 * `Default`), login always activates one, and the last profile can't be
 * deleted — so an absent value would mean a server bug, and making it optional
 * would only hide that behind a client-side fallback branch. Shipping them here
 * is what lets the picker render without a second round-trip.
 */
export const loginResponseSchema = z.object({
  token: z.string().min(1),
  username: z.string().min(1),
  /** The profile login made active — the account's default. */
  profile: profileSchema,
  /** Every profile on the account, so the picker needs no follow-up fetch. */
  profiles: z.array(profileSchema),
});

export type LoginResponse = z.infer<typeof loginResponseSchema>;

/** Auth status indicating if authentication is required. */
export const authStatusSchema = z.object({
  required: z.boolean(),
});

export type AuthStatus = z.infer<typeof authStatusSchema>;
