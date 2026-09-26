/**
 * Is the authentication secret usable?
 *
 * A tiny, dependency-free module on purpose. Two callers need this answer:
 *
 *   - `lib/ops/readiness.ts` (the `/api/ready` probe), and
 *   - `instrumentation.ts` (the boot-time configuration line).
 *
 * The second one runs in Next's instrumentation context, where importing the
 * readiness module would drag in the whole database layer (measured: the build
 * fails with `./node_modules/postgres/src/index.js → lib/db/index.ts →
 * lib/ops/readiness.ts → instrumentation.ts`). One predicate, one definition,
 * no shared import graph — so the two surfaces can never contradict each other
 * about whether auth is configured, which they did before this module existed
 * (a 9-character secret was reported "configured" at boot while `/api/ready`
 * refused it).
 */

/** Minimum usable session secret, in bytes of UTF-8 text. */
export const MIN_SESSION_SECRET_BYTES = 32;

/** Is the session secret present AND long enough to be usable? */
export function authSecretUsable(env: { SCOLAIRA_SESSION_SECRET?: string | undefined }): boolean {
  return (env.SCOLAIRA_SESSION_SECRET ?? '').length >= MIN_SESSION_SECRET_BYTES;
}
