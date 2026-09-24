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

/**
 * Read one diagnostic field (`constraint`, `column`, `table`, `detail`) from
 * the deepest informative node of the cause chain.
 *
 * Postgres reports a unique violation as `23505` plus the constraint/index
 * name, and (for `insert … values`) a `detail` of the form
 * `Key (email)=(a@b) already exists.` — either identifies the column a caller
 * has to explain to the operator. Which one is populated depends on the driver
 * node the error passes through, so callers should ask for all of them.
 */
export function pgField(error: unknown, field: 'constraint' | 'column' | 'table' | 'detail'): string | undefined {
  let current: unknown = error;
  let found: string | undefined;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const value = (current as Record<string, unknown>)?.[field];
    if (typeof value === 'string' && value.length > 0) found = value;
    current = (current as { cause?: unknown })?.cause;
  }
  return found;
}

/**
 * The COLUMN a unique violation names, when the driver reports it.
 *
 * Postgres sends `Key (email)=(a@b) already exists.` in `detail`; only the key
 * inside the parentheses is trustworthy for identifying the field, because the
 * *values* in that line are attacker-chosen — a caller that searched the whole
 * text would answer "email is taken" for a school address literally named
 * `email-taken`. `detail` is not always available (postgres.js drops it), in
 * which case callers fall back to `uniqueViolationIndex()`.
 */
export function uniqueViolationKey(error: unknown): string | undefined {
  const detail = pgField(error, 'detail');
  if (detail) {
    const key = /Key \(([^)]+)\)=/.exec(detail)?.[1];
    if (key) return key.trim();
  }
  return pgField(error, 'column');
}

/**
 * The constraint/index a unique violation names, lower-cased.
 *
 * Preference order matters: the structured `constraint` field when the driver
 * exposes it, otherwise the identifier quoted in the message
 * (`duplicate key value violates unique constraint "users_email_unique"`).
 * The quoted identifier is database-controlled, which is why it is safe to
 * read it from the message — the *values* that collide never appear there.
 */
export function uniqueViolationIndex(error: unknown): string {
  const field = pgField(error, 'constraint');
  if (field) return field.toLowerCase();
  const message = pgMessage(error) ?? '';
  const quoted =
    /unique constraint "([^"]+)"/i.exec(message)?.[1] ??
    /unique index "([^"]+)"/i.exec(message)?.[1];
  return (quoted ?? '').toLowerCase();
}

/**
 * True when the cause chain carries a unique-violation (`23505`).
 *
 * `columns` narrows the match to a specific column so a handler can answer
 * "this email is taken" instead of a generic conflict: the match is made
 * against the constraint/index name, the `detail` text and the `column` field,
 * because the three disagree depending on how the statement was issued.
 */
export function isUniqueViolation(error: unknown, columns?: readonly string[]): boolean {
  if (sqlState(error) !== '23505') return false;
  if (!columns || columns.length === 0) return true;
  const haystack = [
    pgField(error, 'constraint'),
    pgField(error, 'column'),
    pgField(error, 'detail'),
    pgMessage(error),
  ]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase();
  return columns.some((c) => haystack.includes(c.toLowerCase()));
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
