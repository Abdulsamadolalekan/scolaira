/**
 * Repository-context primitives.
 *
 * The M2 contract (see docs/database/M2_ARCHITECTURE_REPORT.md §17) requires
 * repositories to be an explicit, type-safe, tenant-scoped boundary between
 * application behavior and the database. Every repository function:
 *
 *   1. Takes a `TenantScopedDb` (which is either the drizzle Database instance
 *      or a drizzle transaction) so that multi-step operations can compose into
 *      a single atomic transaction.
 *   2. Takes a non-optional `TenantCtx` carrying the verified `organizationId`
 *      and the acting `userId`. RLS on the database side enforces that only
 *      rows matching organizationId are visible, but the TypeScript signature
 *      makes it impossible to accidentally call a repo method without scoping.
 *   3. Never reads across tenants, never writes SQL that omits the
 *      organization_id predicate, and never silently falls back to "all orgs".
 *
 * Repository methods do NOT compute paid_kobo / total_kobo / unallocated_kobo
 * themselves. Those values are maintained by database triggers; repos insert
 * invoice_lines, payment_allocations, reversals and SELECT the authoritative
 * values back from Postgres after the statement.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as schema from '../schema';

/**
 * A UUID string. Branded to prevent accidental mixing with generic strings.
 *
 * The brand is optional (`__uuid?`) so that a `UUID` is still assignable to
 * `string` for drizzle's benefit, but arbitrary strings are NOT assignable to
 * `UUID` (you must construct one via `asUUID` after validation).
 */
export type UUID = string & { readonly __uuid?: unique symbol };

/** Cast a validated plain string to a branded UUID. Runtime validation (Zod)
 *  happens at the service boundary; this is just a type-level marker. */
export function asUUID(id: string): UUID {
  return id as UUID;
}

/**
 * Tenant context that every scoped repository method requires.
 *
 * `organizationId` is mandatory: without it, there is no legitimate tenant
 * operation, and RLS would return zero rows anyway.
 *
 * `userId` is mandatory for mutations that record the actor. Read-only methods
 * may accept a TenantCtx with userId = null for rare system reads (used
 * internally by migrations/tests through `systemRepo`), but that path is NOT
 * exported to application code.
 */
export interface TenantCtx {
  readonly organizationId: UUID;
  readonly userId: UUID | null;
}

/**
 * System context bypasses membership validation and is used ONLY by migrations,
 * seeds, and internal tooling that run as the table owner. Application code
 * never constructs a SystemCtx.
 */
export interface SystemCtx {
  readonly organizationId: UUID | null;
  readonly userId: UUID | null;
  readonly system: true;
}

/**
 * The database handle passed to repository methods.
 * Accepts either the base Drizzle instance or a transaction (`db.transaction(tx => ...)`).
 */
export type TenantScopedDb = PostgresJsDatabase<typeof schema>;

/**
 * Assert that an `organizationId` parameter matches the active tenant scope.
 *
 * This is defense-in-depth on the TypeScript side: RLS in the database is the
 * hard guarantee, but mismatched IDs in application code (e.g. passing a
 * student from org B into an insert for org A) should fail loud and early
 * with a developer error rather than being caught silently by the RLS
 * WITH CHECK policy (which would raise a confusing policy-violation error).
 */
export function assertSameOrganization(
  ctx: TenantCtx,
  candidate: { organizationId?: UUID | null } | UUID | null | undefined,
  label = 'row',
): void {
  const candidateId =
    candidate === null || candidate === undefined
      ? null
      : typeof candidate === 'string'
        ? candidate
        : candidate.organizationId ?? null;

  if (candidateId === null) return; // caller did not set it; trigger will populate from GUC
  if (candidateId !== ctx.organizationId) {
    throw new Error(
      `Tenant violation: ${label} belongs to organization ${candidateId} but active scope is ${ctx.organizationId}`,
    );
  }
}

/**
 * Error class for invariant / business-rule violations detected by the
 * repository/service boundary before the database raises them. For database-
 * level violations (triggers, CHECKs, FKs) we let the original Postgres error
 * propagate so callers see the precise `code` (e.g. check_violation,
 * foreign_key_violation, insufficient_privilege).
 */
export class RepoInvariantError extends Error {
  readonly code = 'REPO_INVARIANT_VIOLATION';
  constructor(message: string) {
    super(message);
    this.name = 'RepoInvariantError';
  }
}
