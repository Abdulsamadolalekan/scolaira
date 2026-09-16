/**
 * Tenant context helper.
 *
 * Establishes Postgres GUC-based tenant scope for the duration of either a
 * single statement or a transaction. This is the ONLY sanctioned way for
 * application code to switch tenant context; raw calls to
 * `set_tenant_context(...)` via SQL in application code are prohibited.
 *
 * Guarantees (proven in the M2 architecture gate, see
 * docs/database/M2_ARCHITECTURE_REPORT.md §7):
 *
 *   - Non-members cannot set another school's context (the SECURITY DEFINER
 *     function verifies an ACTIVE organization_members row and raises
 *     insufficient_privilege otherwise).
 *   - With no context set, RLS returns zero rows for every tenant table
 *     (default-deny).
 *   - Context is set at the SESSION level on the underlying postgres
 *     connection. For safety, every `withTenant` / `withSystemContext` block
 *     clears the context in a `finally` clause so that connection pooling
 *     cannot leak state between requests.
 *
 * USAGE (application code):
 *
 *   import { withTenant } from '@/lib/db/tenant';
 *   import { invoices } from '@/lib/db/repo';
 *
 *   const result = await withTenant(
 *     { organizationId, userId },
 *     async (db, ctx) => {
 *       return invoices.issue(db, ctx, invoiceId);
 *     },
 *   );
 *
 * Transactional variant (single DB transaction across multiple repo calls):
 *
 *   await withTenant({ organizationId, userId }, async (db, ctx) => {
 *     return db.transaction(async (tx) => {
 *       // use tx (which inherits the session GUCs) inside repo methods
 *       await payments.confirm(tx, ctx, payId);
 *       await paymentAllocations.allocate(tx, ctx, {...});
 *     });
 *   });
 *
 * CONTEXT LIFECYCLE:
 *   - set on entry (via `select set_tenant_context(org,user)`)
 *   - cleared on exit (RESET app.organization_id; app.user_id; app.is_platform_admin)
 *   - cleared even if the callback throws
 *   - never left set across awaits that release the connection (the callback
 *     holds the connection for its duration because postgres-js awaits are
 *     serial on a connection, and drizzle's `db.transaction` does not
 *     release the connection until commit).
 */
import 'server-only';

import { getSql, getDb, type Database } from './index';
import { asUUID, type SystemCtx, type TenantCtx, type UUID } from './repo/_context';

/** Options to withTenant. */
export interface WithTenantOptions {
  /** Use a dedicated transaction for the callback. Default: false (the callback
   *  receives the drizzle db; individual statements autocommit). When true,
   *  the callback is wrapped in BEGIN/COMMIT with proper rollback on throw. */
  transactional?: boolean;
}

/** Validated tenant identification from an inbound request. */
export interface TenantIdentity {
  organizationId: string;
  userId: string;
}

/**
 * Execute `fn` with the Postgres session scoped to the given tenant.
 *
 * The callback receives a `db` handle and a strongly-typed `ctx` whose
 * organizationId/userId are branded UUIDs.
 */
export async function withTenant<T>(
  identity: TenantIdentity,
  fn: (db: Database, ctx: TenantCtx) => Promise<T>,
  options: WithTenantOptions = {},
): Promise<T> {
  const sql = getSql();
  const db = getDb();
  const organizationId = asUUID(identity.organizationId);
  const userId = asUUID(identity.userId);

  const ctx: TenantCtx = { organizationId, userId };

  // Establish context by invoking the SECURITY DEFINER function.
  // set_tenant_context raises insufficient_privilege for non-members; the error
  // propagates unchanged to the caller.
  try {
    await sql`SELECT set_tenant_context(${organizationId}::uuid, ${userId}::uuid)`;

    if (options.transactional) {
      return await db.transaction(async (tx) => fn(tx as unknown as Database, ctx));
    }
    return await fn(db, ctx);
  } finally {
    // Always clear the GUCs so the pooled connection returns to a neutral state.
    // We must NOT use set_tenant_context(NULL, NULL) because that raises when
    // userId is NULL; use RESET (per-session) on all tenant GUCs.
    await sql`
      SELECT set_config('app.organization_id', '', false),
             set_config('app.user_id', '', false),
             set_config('app.is_platform_admin', '0', false),
             set_config('app.auth_bootstrap', '0', false),
             set_config('app.bypass_financial_triggers', '0', false);
    `.catch(() => {
      // If the connection is in a broken state, best effort to clear; the pool
      // will discard it. Swallow to avoid masking the original error.
    });
  }
}

/**
 * Execute `fn` in SYSTEM context (migrations, seeds, tests).
 *
 * SYSTEM context bypasses membership verification but is NOT grantable to the
 * `scolaira_app` role (the SECURITY DEFINER function `set_tenant_context_for_system`
 * is owned by the migration/superuser role and NOT granted to the runtime
 * role). Therefore application code cannot construct a SystemCtx.
 *
 * This function is imported only by migrations, seed scripts, and tests.
 */
export async function withSystemContext<T>(
  orgId: UUID | null,
  userId: UUID | null,
  fn: (db: Database, ctx: SystemCtx) => Promise<T>,
): Promise<T> {
  const sql = getSql();
  const db = getDb();
  const ctx: SystemCtx = {
    organizationId: orgId,
    userId,
    system: true,
  };
  try {
    // Use SECURITY DEFINER owner-side wrapper because the raw
    // set_tenant_context_for_system is REVOKEd from scolaira_app.
    // Note: this sets is_platform_admin='1' when orgId is NULL, but RLS
    // policies require auth_is_platform_admin_authorized() to be true
    // (which checks platform_admin_id is a real platform admin, set only
    // via enter_platform_context). For tests we additionally pass a
    // userId; withSystemContext is only used for test seeding.
    await sql`SELECT auth_test_system_context(${orgId}::uuid, ${userId}::uuid)`;
    return await fn(db, ctx);
  } finally {
    await sql`SELECT clear_app_context()`.catch(() => {});
  }
}

/**
 * Low-level helper for TEST infrastructure only: asserts that the CURRENT
 * session's GUCs match the given context. Used by test harness assertions.
 * Not exported from the package barrel; only from this module.
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
