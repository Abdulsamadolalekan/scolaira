/**
 * Users repository (scoped).
 *
 * Users are not tenant-owned rows — the users RLS policy restricts reads to
 * "self or platform_admin". Within a tenant, service code primarily needs to
 * look up the acting user and list members. Membership enumeration lives in
 * `organization-members`.
 */
import { eq } from 'drizzle-orm';
import { users } from '../schema';
import type { TenantScopedDb, TenantCtx } from './_context';

export type User = typeof users.$inferSelect;

export async function getById(db: TenantScopedDb, _ctx: TenantCtx, userId: string): Promise<User | null> {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return rows[0] ?? null;
}
