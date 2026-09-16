/**
 * Fee assignments repository.
 */
import { eq, and } from 'drizzle-orm';
import { feeAssignments } from '../schema';
import type { TenantCtx, TenantScopedDb, UUID } from './_context';

export type FeeAssignment = typeof feeAssignments.$inferSelect;
export type NewFeeAssignment = typeof feeAssignments.$inferInsert;

export async function create(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: Omit<NewFeeAssignment, 'organizationId'>,
): Promise<FeeAssignment> {
  const rows = await db
    .insert(feeAssignments)
    .values({ ...input, organizationId: ctx.organizationId })
    .returning();
  return rows[0]!;
}

export async function get(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
): Promise<FeeAssignment | null> {
  const rows = await db
    .select()
    .from(feeAssignments)
    .where(
      and(
        eq(feeAssignments.id, id),
        eq(feeAssignments.organizationId, ctx.organizationId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listForTerm(
  db: TenantScopedDb,
  ctx: TenantCtx,
  termId: UUID,
): Promise<FeeAssignment[]> {
  return db
    .select()
    .from(feeAssignments)
    .where(
      and(
        eq(feeAssignments.organizationId, ctx.organizationId),
        eq(feeAssignments.termId, termId),
      ),
    );
}
