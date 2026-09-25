// @vitest-environment node
/**
 * Audit append-only and correctness tests (§VI).
 */
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb, testSql } from '../setup-db';
import { auditEvents } from '@/lib/db/schema';
import { withSystemContext } from '@/lib/db/tenant';
import { seedTwoOrgs } from '../support/seed';
import * as auditRepo from '@/lib/db/repo/audit-events';
import type { TenantCtx, UUID } from '@/lib/db/repo/_context';


function ctxFor(orgId: UUID, userId: UUID): TenantCtx {
  return { organizationId: orgId, userId };
}

async function seedAndLogin() {
  const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
  await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;
  return { ids, db: testDb(), ctx: ctxFor(ids.orgId, ids.aliceId) };
}

async function expectRejects<T>(p: Promise<T>, pattern: RegExp): Promise<void> {
  let threw = false;
  try { await p; } catch (e: any) {
    threw = true;
    const msg = (e?.message ?? '') + ' | ' + (e?.cause?.message ?? '');
    expect(msg).toMatch(pattern);
  }
  expect(threw).toBe(true);
}

describe('Audit events', () => {
  it('record captures actor, action, entity, before/after, reason, timestamps', async () => {
    const { db, ctx } = await seedAndLogin();
    const ev = await auditRepo.record(db, ctx, {
      action: 'invoice.issued',
      entityType: 'invoices',
      entityId: '11111111-1111-1111-1111-111111111111' as UUID,
      before: { status: 'DRAFT' },
      after: { status: 'ISSUED', issuedAt: '2026-01-01' },
      reason: 'Term 3 billing run',
      requestId: 'req_1',
      correlationId: 'corr_1',
    });
    expect(ev.id).toBeTruthy();
    expect(ev.organizationId).toBe(ctx.organizationId);
    expect(ev.actorUserId).toBe(ctx.userId);
    expect(ev.actorType).toBe('USER');
    expect(ev.action).toBe('invoice.issued');
    expect(ev.entityType).toBe('invoices');
    expect(ev.reason).toBe('Term 3 billing run');
    expect(ev.createdAt).toBeTruthy();
  });

  it('SYSTEM actor when ctx has no userId', async () => {
    const { db, ids } = await seedAndLogin();
    const sysCtx = { organizationId: ids.orgId, userId: null } as unknown as TenantCtx;
    const ev = await auditRepo.record(db, sysCtx, {
      action: 'webhook.received', entityType: 'webhook_events',
    });
    expect(ev.actorType).toBe('SYSTEM');
    expect(ev.actorUserId).toBeNull();
  });

  it('listForEntity scoped to org + entity returns events in descending order', async () => {
    const { db, ctx } = await seedAndLogin();
    const eid = '22222222-2222-2222-2222-222222222222' as UUID;
    await auditRepo.record(db, ctx, { action: 'a1', entityType: 'invoices', entityId: eid });
    await auditRepo.record(db, ctx, { action: 'a2', entityType: 'invoices', entityId: eid });
    const list = await auditRepo.listForEntity(db, ctx, 'invoices', eid);
    expect(list.length).toBe(2);
    expect(list[0]!.action).toBe('a2'); // desc order
    expect(list[1]!.action).toBe('a1');
  });

  it('direct UPDATE of audit event is rejected (append-only)', async () => {
    const { db, ctx } = await seedAndLogin();
    const ev = await auditRepo.record(db, ctx, { action: 'a', entityType: 'invoices' });
    await expectRejects(
      db.update(auditEvents).set({ action: 'tampered' } as any).where(eq(auditEvents.id, ev.id)),
      /(append.?only|forbidden|permission denied)/i,
    );
  });

  it('direct DELETE of audit event is rejected (append-only)', async () => {
    const { db, ctx } = await seedAndLogin();
    const ev = await auditRepo.record(db, ctx, { action: 'a', entityType: 'invoices' });
    await expectRejects(
      db.delete(auditEvents).where(eq(auditEvents.id, ev.id)),
      /(append.?only|forbidden|permission denied)/i,
    );
  });

  it('audit row for Bob\'s entity is invisible from Alice\'s tenant under app role (RLS)', async () => {
    const { db, ids } = await seedAndLogin();
    let bId: UUID;
    await withSystemContext(ids.orgBId, ids.bobId, async () => {
      const ev = await auditRepo.record(db as any, ctxFor(ids.orgBId, ids.bobId), {
        action: 'b', entityType: 'invoices',
      });
      bId = ev.id;
    });
    await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;
    // RLS applies to app role, not superuser; drop to app role for this assertion.
    await testSql()`SET ROLE scolaira_app`;
    const rows = await db.select().from(auditEvents).where(eq(auditEvents.id, bId!)).limit(1);
    expect(rows.length).toBe(0);
    await testSql()`RESET ROLE`;
  });

  it('without tenant context set, SELECT returns 0 rows (default-deny) under app role', async () => {
    const { db, ctx } = await seedAndLogin();
    await auditRepo.record(db, ctx, { action: 'x', entityType: 'invoices' });
    await testSql()`SET ROLE scolaira_app`;
    await testSql()`SELECT set_config('app.organization_id', '', false)`;
    await testSql()`SELECT set_config('app.user_id', '', false)`;
    await testSql()`SELECT set_config('app.is_platform_admin', '0', false)`;
    const rows = await db.select().from(auditEvents).limit(10);
    expect(rows.length).toBe(0);
    await testSql()`RESET ROLE`;
    await testSql()`SELECT set_tenant_context(${ctx.organizationId}::uuid, ${ctx.userId}::uuid)`;
  });
});
