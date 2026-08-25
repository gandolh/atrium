import { ApiError } from "../lib/api-client";

/**
 * The `/profiles` routes' documented 4xx bodies (brief 35's API contract),
 * parsed defensively — an unrecognised shape (a network error, a proxy's HTML
 * page) just falls through to a generic message rather than throwing a second
 * error while handling the first. Kept in one place so the picker, switcher
 * and manage screen can't drift on what each code means.
 */
interface ProfileErrorBody {
  error?: string;
  limit?: number;
  noteCount?: number;
}

function bodyOf(err: unknown): ProfileErrorBody | undefined {
  if (err instanceof ApiError && err.body && typeof err.body === "object") {
    return err.body as ProfileErrorBody;
  }
  return undefined;
}

/**
 * The note count carried on a 409 `PROFILE_HAS_NOTES` delete response, or
 * `null` when `err` isn't that — the manage screen's signal to escalate its
 * delete confirm from "progress only" to "progress + N notes will move".
 */
export function noteCountFrom(err: unknown): number | null {
  const body = bodyOf(err);
  if (body?.error === "PROFILE_HAS_NOTES" && typeof body.noteCount === "number") {
    return body.noteCount;
  }
  return null;
}

/** A message honest about which server rule a failed create/rename/recolor/delete hit. */
export function profileErrorMessage(err: unknown, fallback: string): string {
  const body = bodyOf(err);
  switch (body?.error) {
    case "NAME_TAKEN":
      return "That name is already used in this account.";
    case "PROFILE_LIMIT":
      return `An account can hold up to ${body.limit ?? "five"} profiles.`;
    case "LAST_PROFILE":
      return "The last profile in an account can't be deleted.";
    case "DEFAULT_PROFILE":
      return "The default profile can't be deleted — rename or recolour it instead.";
    case "INVALID_REQUEST":
      return "Names must be 1–24 characters.";
    default:
      return fallback;
  }
}
