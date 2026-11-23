/**
 * What an unexpected error may put in the log: its name, message and stack, nothing else.
 * Logging the error object itself prints every property it carries. A Postgres error carries
 * `detail`, `where` and `parameters`-like fields that quote the values of the failing row ("Key
 * (name)=(Falcon bid) already exists"), which are client content, and the log is not a place for it
 * (06-security 6, SEC-034).
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return `a ${typeof err} was thrown`;
}
