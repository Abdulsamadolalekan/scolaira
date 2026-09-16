/**
 * Fee definitions repository.
 */
import { eq, and } from 'drizzle-orm';
import { feeDefinitions } from '../schema';
import type { TenantCtx, TenantScopedDb, UUID } from './_context';

export type FeeDefinition = typeof feeDefinitions.$inferSelect;
export type NewFeeDefinition = typeof feeDefinitions.$inferInsert;

export async function create(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: Omit<NewFeeDefinition, 'organizationId'>,
): Promise<FeeDefinition> {
  const rows = await db
    .insert(feeDefinitions)
    .values({ ...input, organizationId: ctx.organizationId })
    .returning();
  return rows[0]!;
}

export async function get(
  db: TenantScopedDb,
  ctx: TenantCtx,
  id: UUID,
): Promise<FeeDefinition | null> {
  const rows = await db
    .select()
    .from(feeDefinitions)
    .where(
      and(eq(feeDefinitions.id, id), eq(feeDefinitions.organizationId, ctx.organizationId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listForOrg(db: TenantScopedDb, ctx: TenantCtx): Promise<FeeDefinition[]> {
  return db
    .select()
    .from(feeDefinitions)
    .where(eq(feeDefinitions.organizationId, ctx.organizationId));
}
