/**
 * Narrows a value the caller knows is there (a guard ran before it, a row was just written) and says so by name
 * if it is not, instead of a `!` that lets `undefined` flow on. The thrown error is a 500 that says nothing to
 * the client.
 */
export function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`${what} is missing`);
  return value;
}
