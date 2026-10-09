/**
 * Authorization-context variable registry (R1, C-1).
 *
 * The database stores SCOLAIRA's authorization state in Postgres session GUCs.
 * Every variable that can carry identity or authorization state MUST be
 * declared here so that:
 *
 *   - connection setup (`onconnect`) can reset all of them;
 *   - scope teardown can clear all of them and *verify* the result;
 *   - the R1 regression tests can assert the full set is covered, so that a
 *     future migration adding a new `app.*` variable cannot silently escape
 *     cleanup.
 *
 * The list is intentionally duplicated as `CONTEXT_GUCS` (TypeScript) and is
 * checked against the database by tests/security/r1-context-coverage.test.ts,
 * which scans the live function bodies for `app.<name>` references.
 */

/**
 * Every GUC capable of carrying identity, tenancy, or authorization state.
 *
 *  - organization_id            tenant scope
 *  - user_id                    acting principal
 *  - acting_role                membership role used for role-aware policies
 *  - is_platform_admin          platform branch selector (validated by HMAC)
 *  - platform_admin_id          platform actor identity
 *  - platform_token             HMAC proof bound to platform_admin_id + backend
 *  - tenant_token               HMAC proof bound to organization_id + user_id
 *  - auth_bootstrap             pre-authentication visibility (identity tables)
 *  - bypass_financial_triggers  break-glass marker
 *  - public_context             public payment-link mode marker
 *  - public_link_token          the bearer token that justified public mode
 *  - public_proof               HMAC proof bound to public_link_token + org (R1/C-3)
 */
export const CONTEXT_GUCS = [
  'app.organization_id',
  'app.user_id',
  'app.acting_role',
  'app.is_platform_admin',
  'app.platform_admin_id',
  'app.platform_token',
  'app.tenant_token',
  'app.auth_bootstrap',
  'app.bypass_financial_triggers',
  'app.public_context',
  'app.public_link_token',
  'app.public_proof',
] as const;

export type ContextGuc = (typeof CONTEXT_GUCS)[number];

/** Internal probe used to ask Postgres whether a transaction block is open. */
export const TX_PROBE_GUC = 'app.r1_tx_probe';

/**
 * Transaction-local marker set by the outermost scope. Read by the
 * scope-aware legacy context setters (migration 0039) so they write at the
 * transaction-local layer inside a scope instead of silently shadowing it.
 */
export const SCOPE_DEPTH_GUC = 'app.r1_scope_depth';

/** Variables that carry tenancy/identity (used by the "is this clean?" check). */
export const IDENTITY_GUCS = CONTEXT_GUCS;

export type ContextState = Record<ContextGuc, string | null>;

/** Minimal exec surface needed to run context SQL (postgres.js or a scoped client). */
export interface ContextExec {
  unsafe(query: string, params?: unknown[], options?: unknown): unknown;
}

function asRows(result: unknown): Array<Record<string, unknown>> {
  return Array.isArray(result) ? (result as Array<Record<string, unknown>>) : [];
}

/**
 * Clear the context registry at the requested layers, in ONE statement so it
 * cannot be partially applied.
 *
 *   session: `set_config(..., false)` — survives the transaction; this is what
 *            an unrelated later request would inherit, so it is always cleared.
 *   local:   `set_config(..., true)` — reverted by Postgres with the
 *            transaction, but must be cleared explicitly when the scope ran
 *            inside a transaction it does not own (savepoint case), otherwise
 *            the rest of that transaction would still be running under our
 *            context.
 *
 * This mirrors the database-side `clear_app_context()` but covers the full
 * registry (including `public_proof`, the scope marker and the transaction
 * probe), and is executed directly so a failure cannot be swallowed by a
 * `SECURITY DEFINER` helper's own semantics.
 */
export async function clearContextLayers(
  exec: ContextExec,
  layers: { local?: boolean; session?: boolean } = { local: true, session: true },
): Promise<void> {
  const names = [...CONTEXT_GUCS, SCOPE_DEPTH_GUC, TX_PROBE_GUC] as const;
  const parts: string[] = [];
  if (layers.local) for (const name of names) parts.push(`set_config('${name}', '', true)`);
  if (layers.session) for (const name of names) parts.push(`set_config('${name}', '', false)`);
  if (parts.length === 0) return;
  await exec.unsafe(`SELECT ${parts.join(', ')}`);
}

/** Clear the session layer only (connection birth, post-scope hygiene). */
export async function clearContextSessionScoped(exec: ContextExec): Promise<void> {
  await clearContextLayers(exec, { session: true });
}

/**
 * Read back every context variable. One round trip; the result is the
 * evidence used by scope teardown to prove the connection is neutral.
 */
export async function readContextState(exec: ContextExec): Promise<ContextState> {
  const cols = CONTEXT_GUCS.map(
    (name, i) => `NULLIF(current_setting('${name}', true), '') AS c${i}`,
  ).join(', ');
  const rows = asRows(await exec.unsafe(`SELECT ${cols}`));
  const row = rows[0] ?? {};
  const out = {} as ContextState;
  CONTEXT_GUCS.forEach((name, i) => {
    const v = row[`c${i}`];
    out[name] = v === null || v === undefined ? null : String(v);
  });
  return out;
}

/** Names of the variables that are still set in `state`. */
export function dirtyContextVariables(state: ContextState): string[] {
  return CONTEXT_GUCS.filter((name) => state[name] !== null && state[name] !== '');
}

/** True when two context states carry identical values for every variable. */
export function sameContextState(a: ContextState, b: ContextState): boolean {
  return CONTEXT_GUCS.every((name) => (a[name] ?? '') === (b[name] ?? ''));
}

/** Thrown when a scope cannot prove the connection was returned neutral. */
export class ScopeIntegrityError extends Error {
  readonly code = 'SCOPE_INTEGRITY_VIOLATION';
  constructor(message: string) {
    super(message);
    this.name = 'ScopeIntegrityError';
  }
}
