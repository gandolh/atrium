/**
 * Classifying SQLite constraint failures.
 *
 * Several routes answer from the constraint rather than from a SELECT-then-act
 * check, because the check is a race: two tabs adding a profile called "Ana"
 * would both pass it. That makes recognising *which* constraint fired part of
 * the app's behaviour, not error-handling boilerplate.
 *
 * WHY THE ERROR CHAIN IS WALKED. `better-sqlite3` throws a `SqliteError`
 * carrying a stable `code`. Knex sits between that throw and the caller and is
 * free to re-throw its own error with the driver's attached as `cause` — which
 * it does for some paths and not others. Reading `err.code` alone therefore
 * worked or silently stopped working depending on which Knex method raised it,
 * and a classifier that silently stops working turns a 409 into a 500. Walking
 * the chain is what makes this independent of that detail.
 */

/** Every `code` in the error chain, outermost first. */
function errorCodes(err: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = err;
  // Bounded: a cause chain is short, and a cycle must not hang the request.
  for (let depth = 0; current !== null && current !== undefined && depth < 8; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
}

/**
 * True for a unique-index violation. Matched on `code`, never on the message
 * text, which is not a stable interface.
 */
export function isUniqueViolation(err: unknown): boolean {
  return errorCodes(err).includes("SQLITE_CONSTRAINT_UNIQUE");
}

/**
 * True for an `ON DELETE RESTRICT` violation — in practice `notes.profile_id`
 * or `note_folders.profile_id` (brief 35 decision 3).
 *
 * Matches BOTH constraint codes on purpose. SQLite implements RESTRICT with an
 * implicit trigger, so a RESTRICT violation surfaces as
 * `SQLITE_CONSTRAINT_TRIGGER` — verified against the bundled SQLite 3.53.2 —
 * while a plain immediate foreign-key failure gives
 * `SQLITE_CONSTRAINT_FOREIGNKEY`. Checking only the latter left this classifier
 * never matching, which turned a deliberate 409 into an unhandled 500. Both are
 * listed rather than one, so changing the FK action later can't silently
 * re-break it.
 */
export function isForeignKeyViolation(err: unknown): boolean {
  const codes = errorCodes(err);
  return (
    codes.includes("SQLITE_CONSTRAINT_TRIGGER") || codes.includes("SQLITE_CONSTRAINT_FOREIGNKEY")
  );
}
