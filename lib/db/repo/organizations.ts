/**
 * Organizations repository.
 *
 * Organizations are special: a user can only see their own org through RLS
 * (the organizations RLS policy filters by id = current_setting('app.organization_id')).
 * The only operation that creates a tenant is platform signup (M3); within a
 * tenant context the organization row is read-only.
 */
import { eq } from 'drizzle-orm';
import { organizations } from '../schema';
import type { TenantCtx, TenantScopedDb } from './_context';

export type Organization = typeof organizations.$inferSelect;

export async function get(db: TenantScopedDb, ctx: TenantCtx): Promise<Organization> {
  const row = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, ctx.organizationId))
    .limit(1);
  const org = row[0];
  if (!org) {
    throw new Error(`Authenticated organization ${ctx.organizationId} not found`);
  }
  return org;
}
