/**
 * Structured operational events (H-6/F10).
 *
 * One line of JSON per event, on stdout/stderr, with a stable `event` name and
 * a small, non-disclosing payload. This is deliberately provider-neutral: the
 * product must be able to signal a failure without promising an external
 * observability vendor (provider claims are H-9, not H-6).
 *
 * Never pass secrets, connection strings, tokens or table rows into `fields`.
 * The readiness probe is the main caller and its own payloads are already
 * filtered to stable reason codes and counts.
 */

type FieldValue = string | number | boolean | null | undefined;

function serialise(event: string, fields: Record<string, FieldValue>): string {
  const payload: Record<string, FieldValue> = { event };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    payload[key] = value;
  }
  return JSON.stringify(payload);
}

/** Emit an informational operational event. */
export function logEvent(event: string, fields: Record<string, FieldValue> = {}): void {
  // eslint-disable-next-line no-console
  console.info(serialise(event, fields));
}

/** Emit a failure signal. Severity is the only difference from logEvent. */
export function logFailure(event: string, fields: Record<string, FieldValue> = {}): void {
  // eslint-disable-next-line no-console
  console.error(serialise(event, fields));
}
