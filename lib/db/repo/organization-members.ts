/**
 * Organization members repository — scoped to a tenant.
 */
import { eq, and } from 'drizzle-orm';
import { organizationMembers } from '../schema';
import type { RepoInvariantError, TenantCtx, TenantScopedDb, UUID } from './_context';

export type OrganizationMember = typeof organizationMembers.$inferSelect;
export type NewOrganizationMember = typeof organizationMembers.$inferInsert;

export async function listForOrg(db: TenantScopedDb, ctx: TenantCtx): Promise<OrganizationMember[]> {
  return db
    .select()
    .from(organizationMembers)
    .where(eq(organizationMembers.organizationId, ctx.organizationId));
}

export async function findByUser(
  db: TenantScopedDb,
  ctx: TenantCtx,
  userId: UUID,
): Promise<OrganizationMember | null> {
  const rows = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, ctx.organizationId),
        eq(organizationMembers.userId, userId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function isActiveMember(
  db: TenantScopedDb,
  ctx: TenantCtx,
  userId: UUID,
): Promise<boolean> {
  const m = await findByUser(db, ctx, userId);
  return m?.status === 'ACTIVE';
}

export { type RepoInvariantError };
