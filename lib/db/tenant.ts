/**
 * Authorization-context entry points.
 *
 * These are the ONLY sanctioned ways to establish an authorization context.
 * The machinery lives in `./scope.ts` (R1, C-1) and guarantees that:
 *
 *   - the context is applied with transaction-local semantics, so Postgres
 *     itself reverts it (no reliance on application cleanup);
 *   - context and protected queries run on the same connection, and every
 *     `getSql()`/`getDb()` inside the callback resolves to that connection;
 *   - at exit the context is cleared/reset unconditionally on every
 *     identity-bearing variable and the result is read back from Postgres;
 *     a connection that cannot be proven neutral raises
 *     `ScopeIntegrityError` (fail closed);
 *   - invalid or absent context fails closed: the database validates tenant
 *     membership (`auth_scope_tenant_local`), platform admin status
 *     (`auth_scope_platform_local`) and public bearer tokens
 *     (`auth_scope_public_local`) before any protected query can run;
 *   - when the pool can spare a connection (`max > 1`), the scope holds it
 *     exclusively for its whole lifetime. When it cannot (`max == 1`), scopes
 *     are serialized instead. Neither mode depends on the pool size for
 *     correctness — that is the R1 fix.
 *
 * USAGE:
 *
 *   await withTenant({ organizationId, userId }, async (db, ctx) => {
 *     return db.transaction(async (tx) => invoices.issue(tx, ctx, invoiceId));
 *   });
 *
 * Nested `.transaction()` calls become savepoints on the same connection; a
 * callback can never commit an enclosing transaction or scope.
 */
import 'server-only';

import postgres from 'postgres';
import type { Database } from './index';
import { runScoped, type ScopeSpec, type ScopeOptions } from './scope';
import { asUUID, type SystemCtx, type TenantCtx, type UUID } from './repo/_context';
import { CONTEXT_GUCS } from './context';
import { getSql } from './index';

/** Options accepted by withTenant (kept for call-site compatibility). */
export interface WithTenantOptions {
  /**
   * Scopes are ALWAYS transactional: the transaction is what makes Postgres
   * responsible for reverting the context. Accepted for backward compatibility
   * and ignored.
   */
  transactional?: boolean;
}

/** Validated tenant identification from an inbound request. */
export interface TenantIdentity {
  organizationId: string;
  userId: string;
}

/** Execute `fn` with the database scoped to the given tenant. */
export async function withTenant<T>(
  identity: TenantIdentity,
  fn: (db: Database, ctx: TenantCtx) => Promise<T>,
  _options: WithTenantOptions = {},
): Promise<T> {
  const organizationId = asUUID(identity.organizationId);
  const userId = asUUID(identity.userId);
  const ctx: TenantCtx = { organizationId, userId };
  return runScoped({ kind: 'tenant', organizationId, userId }, (db) => fn(db, ctx), {
    label: 'tenant',
  });
}

/**
 * Execute `fn` in pre-authentication SYSTEM context: bootstrap visibility over
 * identity tables only (users, organizations, organization_members, sessions,
 * credentials, password resets). This does NOT open financial or tenant tables.
 *
 * Used by the session trust gate (`getSession()`), which must read a session
 * before it knows which tenant the request belongs to.
 */
export async function withSystemScope<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  return runScoped({ kind: 'system' }, (db) => fn(db), { label: 'system' });
}

/**
 * Execute `fn` in seeded/system context (seeds, tests, migrations).
 *
 * Mirrors the historical `auth_test_system_context(org, user)` behaviour:
 * with a NULL organization it is bootstrap + platform visibility with no
 * tenant token (used for cross-tenant seeding); with an organization it
 * delegates to validated tenant membership and mints the tenant token.
 *
 * Application request handlers must not use this.
 */
export async function withSystemContext<T>(
  orgId: UUID | null,
  userId: UUID | null,
  fn: (db: Database, ctx: SystemCtx) => Promise<T>,
): Promise<T> {
  const ctx: SystemCtx = { organizationId: orgId, userId, system: true };
  return runScoped(
    { kind: 'seed', organizationId: orgId, userId },
    (db) => fn(db, ctx),
    { label: 'seed' },
  );
}

/**
 * Execute `fn` in platform-support context. The platform token is minted by
 * the database and bound to the current backend, so a forged
 * `app.is_platform_admin='1'` does not authorize anything.
 */
export async function withPlatformContext<T>(
  userId: UUID,
  fn: (db: Database, ctx: { userId: UUID }) => Promise<T>,
): Promise<T> {
  return runScoped({ kind: 'platform', userId }, (db) => fn(db, { userId }), {
    label: 'platform',
  });
}

/**
 * Execute `fn` in bearer-authorized PUBLIC context (payment links).
 *
 * The token is resolved by the database, which reads the organization from the
 * link row and mints a proof bound to (token, organization, backend). There is
 * no code path that accepts a caller-supplied organization id, and a forged
 * `app.public_context` marker alone authorizes nothing (migration 0040).
 */
export async function withPublicScope<T>(
  token: string,
  fn: (db: Database, sql: postgres.Sql) => Promise<T>,
): Promise<T> {
  return runScoped({ kind: 'public', token }, (db, sql) => fn(db, sql), { label: 'public' });
}

/**
 * True when the database refused to establish PUBLIC context because the link
 * was missing, revoked, or expired. The scope raises SQLSTATE 28000 for that
 * case specifically, so callers can distinguish "this link is not usable" from
 * any other database failure.
 */
export function isPublicLinkUnusable(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '28000';
}

/** Status of a payment-link token for 404/410 disambiguation (no tenant context). */
export async function probePublicLinkStatus(
  token: string,
): Promise<'MISSING' | 'EXPIRED' | 'REVOKED' | 'ACTIVE'> {
  try {
    return await runScoped({ kind: 'none' }, async (_db, sql) => {
      const rows = (await sql`select auth_probe_public_link(${token}) as s`) as Array<{ s: string }>;
      return (rows[0]?.s ?? 'MISSING') as 'MISSING' | 'EXPIRED' | 'REVOKED' | 'ACTIVE';
    });
  } catch {
    return 'MISSING';
  }
}

/**
 * Execute `fn` in an explicitly constructed scope.
 *
 * Used by code that legitimately needs a neutral connection (public link
 * pre-flight lookups) and by the R1 isolation tests, which pass their own
 * pool so isolation is proven independently of the default pool size.
 */
export async function withScopedDb<T>(
  spec: ScopeSpec,
  fn: (db: Database, sql: postgres.Sql) => Promise<T>,
  options: ScopeOptions = {},
): Promise<T> {
  return runScoped(spec, fn, options);
}

/**
 * TEST-ONLY helper: assert the CURRENT connection's GUCs match the given
 * context. Used to prove context is bound to the connection that executes the
 * protected queries rather than to a JavaScript scope.
 */
export async function assertCurrentTenant(expected: TenantCtx): Promise<void> {
  const sql = getSql();
  const rows = await sql<{ org: string | null; usr: string | null }[]>`
    SELECT NULLIF(current_setting('app.organization_id', true), '')::text AS org,
           NULLIF(current_setting('app.user_id', true), '')::text AS usr
  `;
  const r = rows[0];
  if (!r || r.org !== expected.organizationId || r.usr !== expected.userId) {
    throw new Error(
      `Tenant context mismatch: expected org=${expected.organizationId} user=${expected.userId} got org=${r?.org} user=${r?.usr}`,
    );
  }
}

/** Read every identity-bearing context variable on the current connection. */
export async function currentContextState(): Promise<Record<string, string | null>> {
  const sql = getSql();
  const cols = CONTEXT_GUCS.map(
    (name, i) => `NULLIF(current_setting('${name}', true), '') AS c${i}`,
  ).join(', ');
  const rows = await sql.unsafe(`SELECT ${cols}`);
  const row = (rows[0] ?? {}) as Record<string, unknown>;
  const out: Record<string, string | null> = {};
  CONTEXT_GUCS.forEach((name, i) => {
    const v = row[`c${i}`];
    out[name] = v === null || v === undefined ? null : String(v);
  });
  return out;
}
