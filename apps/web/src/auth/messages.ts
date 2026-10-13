import type { AuthError } from "../../vendor/ward/ward-auth-react.js";

/**
 * Atrium's words for the library's error codes. The library sends codes only,
 * so every sentence a person reads about signing in is written here, once.
 * An unknown code reads like `unknown`.
 */
const MESSAGES: Record<string, string> = {
  invalid_credentials: "That username and password don't match.",
  invalid_request: "Something in that form was missing. Try again.",
  password_too_short: "The new password is too short.",
  password_too_long: "The new password is too long.",
  invalid_username: "That username can't be used.",
  network: "Atrium can't be reached. Check your connection and try again.",
  cross_site: "That request came from another site, so it was refused.",
  unauthorized: "You've been signed out. Sign in again.",
  access_denied: "Ward did not let you in here. Ask the operator for access to Atrium.",
  ward_unavailable: "Ward is unreachable right now. Sign in with your Atrium password.",
  ward_misconfigured: "Atrium's connection to Ward is misconfigured. Tell the operator.",
  ward_session_ended: "Your Ward session ended. Sign in again.",
  invalid_callback: "That Ward sign-in expired or was interrupted. Try again.",
  already_linked: "This account already has a Ward account linked.",
  ward_account_in_use: "That Ward account is linked to a different Atrium account.",
  ward_account_mismatch: "A different Ward account came back. Use the one linked here.",
  not_linked: "No Ward account is linked.",
  no_local_password: "Set an Atrium password first, or you would have no way to sign in.",
  reauthentication_required: "Confirm it's you with Ward first, then set the password.",
  unknown: "Something went wrong. Try again.",
};

/** The sentence for `error`, with the lockout's wait spelled out. */
export function authMessage(error: AuthError): string {
  if (error.code === "too_many_attempts") {
    const wait = error.retryAfterSeconds;
    if (wait === undefined) return "Too many attempts. Wait a while, then try again.";
    const minutes = Math.ceil(wait / 60);
    return minutes > 1
      ? `Too many attempts. Try again in ${minutes} minutes.`
      : `Too many attempts. Try again in ${wait} seconds.`;
  }
  return MESSAGES[error.code] ?? MESSAGES.unknown!;
}

/** The sentence for a session `reason` (why a session was refused), if it needs one. */
export function sessionReasonMessage(reason: string | undefined): string | null {
  if (reason === undefined) return null;
  return MESSAGES[reason] ?? null;
}
