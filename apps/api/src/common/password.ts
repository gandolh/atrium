import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Password hashing for user accounts. scrypt (memory-hard) with a random
 * per-password salt; the stored form is `saltHex:hashHex`. Chosen over a bare
 * sha256 because these are human-chosen passwords, not high-entropy tokens.
 */

const SALT_BYTES = 16;
const KEY_LEN = 64;

/** Hash a plaintext password into the `saltHex:hashHex` storage form. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, KEY_LEN);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

/**
 * Constant-time verify of a plaintext password against a stored `saltHex:hashHex`.
 * Returns false (never throws) on a malformed stored value.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
