/**
 * Organization settings service (M4).
 */
import 'server-only';

import { eq } from 'drizzle-orm';
import { organizations } from '@/lib/db/schema';
import type { TenantCtx, TenantScopedDb } from '@/lib/db/repo/_context';
import { writeAudit } from './audit';

export interface OrgSettings {
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  currency: string;
  timezone: string;
}

export async function getSettings(db: TenantScopedDb, ctx: TenantCtx): Promise<OrgSettings> {
  const rows = await db
    .select({
      name: organizations.name,
      address: organizations.address,
      phone: organizations.phone,
      email: organizations.email,
      currency: organizations.currency,
      timezone: organizations.timezone,
    })
    .from(organizations)
    .where(eq(organizations.id, ctx.organizationId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error('Organization not found');
  return row as OrgSettings;
}

export async function updateSettings(
  db: TenantScopedDb,
  ctx: TenantCtx,
  input: Partial<OrgSettings>,
): Promise<OrgSettings> {
  const before = await getSettings(db, ctx);
  const updates: Partial<OrgSettings> = {};
  // Allow-list of mutable fields.
  for (const k of ['name', 'address', 'phone', 'email', 'currency', 'timezone'] as const) {
    if (k in input) updates[k] = input[k] as never;
  }
  if (Object.keys(updates).length === 0) return before;
  await db
    .update(organizations)
    .set({ ...updates, updatedAt: new Date() } as never)
    .where(eq(organizations.id, ctx.organizationId));
  const after = await getSettings(db, ctx);
  await writeAudit(db, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'org.settings.updated',
    entityType: 'organization',
    entityId: ctx.organizationId,
    before: before as unknown as Record<string, unknown>,
    after: after as unknown as Record<string, unknown>,
  });
  return after;
}
