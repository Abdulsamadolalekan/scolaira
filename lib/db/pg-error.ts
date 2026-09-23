/**
 * SQLSTATE extraction for the application boundary.
 *
 * Drizzle wraps driver errors (`DrizzleQueryError`), and postgres.js wraps the
 * server error one level further, so the SQLSTATE the routes care about lives
 * somewhere in the cause chain rather than on the thrown object itself. Reading
 * it from the top level alone silently misses every wrapped error — which is
 * how a database-enforced conflict would surface as an internal 500 instead of
 * the operator-readable 409 the handler intends.
 *
 * Bounded walk (depth 5) because a cause chain is agent-influenced by nothing,
 * but a self-referential one would be an infinite loop.
 */
export function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const code = (current as { code?: unknown })?.code;
    if (typeof code === 'string' && code.length > 0) return code;
    current = (current as { cause?: unknown })?.cause;
  }
  return undefined;
}

/** The most human-readable message available in the cause chain. */
export function pgMessage(error: unknown): string | undefined {
  let current: unknown = error;
  let last: string | undefined;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const message = (current as { message?: unknown })?.message;
    if (typeof message === 'string' && message.length > 0) last = message;
    current = (current as { cause?: unknown })?.cause;
  }
  return last;
}
