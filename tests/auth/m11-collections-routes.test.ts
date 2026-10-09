// @vitest-environment node
/** M11 route contract: CSRF, idempotency, tenant-derived identity, and stale writes. */
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { call, CookieJar } from './support';
import { POST as registerPost } from '@/app/api/auth/register/route';
import { GET as meGet } from '@/app/api/auth/me/route';
import { POST as selectOrganizationPost } from '@/app/api/auth/select-organization/route';
import { GET as collectionsGet, POST as createCasePost } from '@/app/api/collections/route';
import { POST as transitionPost } from '@/app/api/collections/[id]/transition/route';
import { getSql } from '@/lib/db';
import {
  testDb,
  enableSavepointTransactionsForTest,
  disableSavepointTransactionsForTest,
} from '../setup-db';
import { withSystemContext } from '@/lib/db/tenant';
import * as invoicesRepo from '@/lib/db/repo/invoices';
import * as invoiceLinesRepo from '@/lib/db/repo/invoice-lines';
import { collectionsCaseEvents } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { kobo } from '@/lib/money';
import type { TenantCtx, UUID } from '@/lib/db/repo/_context';

function unique(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

async function ownerWithOutstanding(): Promise<{ jar: CookieJar; ctx: TenantCtx }> {
  const jar = new CookieJar();
  await call(registerPost as never, jar, {
    method: 'POST',
    path: '/api/auth/register',
    body: {
      email: `${unique('m11').toLowerCase()}@example.test`,
      password: 'M11-route-password-A1!',
      firstName: 'M11',
      lastName: 'Owner',
      organizationName: unique('M11 School'),
      organizationSlug: unique('m11-school').toLowerCase(),
    },
  });
  const me = await call(meGet as never, jar, { method: 'GET', path: '/api/auth/me' });
  expect(me.status).toBe(200);
  const organizationId = me.data.activeOrganizationId as UUID;
  const userId = me.data.user.id as UUID;
  const ids = {
    sessionId: randomUUID() as UUID,
    termId: randomUUID() as UUID,
    studentId: randomUUID() as UUID,
  };

  await withSystemContext(organizationId, userId, async () => {
    const sql = getSql();
    await sql`INSERT INTO academic_sessions (id, name, starts_on, is_current, status) VALUES (${ids.sessionId}::uuid, 'M11 Session', '2026-01-01'::date, true, 'ACTIVE')`;
    await sql`INSERT INTO terms (id, session_id, name, label, starts_on, due_date, is_current, status) VALUES (${ids.termId}::uuid, ${ids.sessionId}::uuid, 'M11 Term', '1', '2026-01-01'::date, '2026-12-01'::date, true, 'ACTIVE')`;
    await sql`INSERT INTO students (id, student_id, first_name, last_name, status) VALUES (${ids.studentId}::uuid, 'M11-ROUTE', 'Route', 'Student', 'ACTIVE')`;
  });

  await getSql()`SELECT set_tenant_context(${organizationId}::uuid, ${userId}::uuid)`;
  const ctx: TenantCtx = { organizationId, userId };
  const invoice = await invoicesRepo.createDraft(testDb(), ctx, {
    studentId: ids.studentId,
    termId: ids.termId,
    sessionId: ids.sessionId,
  });
  await invoiceLinesRepo.addLines(testDb(), ctx, invoice.id, [
    {
      description: 'M11 route test',
      quantity: 1,
      unitRateKobo: kobo(25_000),
      amountKobo: kobo(25_000),
    },
  ]);
  await invoicesRepo.issue(testDb(), ctx, invoice.id);
  return { jar, ctx };
}

async function staffSessionFor(ctx: TenantCtx): Promise<CookieJar> {
  const jar = new CookieJar();
  await call(registerPost as never, jar, {
    method: 'POST',
    path: '/api/auth/register',
    body: {
      email: `${unique('m11-staff').toLowerCase()}@example.test`,
      password: 'M11-staff-password-A1!',
      firstName: 'M11',
      lastName: 'Staff',
      organizationName: unique('M11 Staff School'),
      organizationSlug: unique('m11-staff-school').toLowerCase(),
    },
  });
  const me = await call(meGet as never, jar, { method: 'GET', path: '/api/auth/me' });
  expect(me.status).toBe(200);
  const userId = me.data.user.id as UUID;
  await withSystemContext(null, null, async () => {
    const sql = getSql();
    await sql`
      INSERT INTO organization_members (id, organization_id, user_id, role, status, joined_at)
      VALUES (${randomUUID()}::uuid, ${ctx.organizationId}::uuid, ${userId}::uuid, 'STAFF', 'ACTIVE', now())
    `;
  });
  const selected = await call(selectOrganizationPost as never, jar, {
    method: 'POST',
    path: '/api/auth/select-organization',
    body: { organizationId: ctx.organizationId },
    csrf: true,
  });
  expect(selected.status).toBe(200);
  return jar;
}

describe('M11 collection routes', () => {
  afterEach(() => disableSavepointTransactionsForTest());

  it('denies a valid tenant session whose role is not authorized for collections', async () => {
    enableSavepointTransactionsForTest();
    const { ctx } = await ownerWithOutstanding();
    const staffJar = await staffSessionFor(ctx);
    const response = await call(collectionsGet as never, staffJar, {
      method: 'GET',
      path: '/api/collections',
    });
    expect(response.status).toBe(403);
  });

  it('rejects unsafe requests without CSRF before a case is created', async () => {
    enableSavepointTransactionsForTest();
    const { jar, ctx } = await ownerWithOutstanding();
    const response = await call(createCasePost as never, jar, {
      method: 'POST',
      path: '/api/collections',
      csrf: false,
      body: { studentId: ctx.organizationId, priority: 'NORMAL', reason: 'wrong id' },
    });
    expect(response.status).toBe(403);
  });

  it('replays a successful create for the same idempotency key without a duplicate history row', async () => {
    enableSavepointTransactionsForTest();
    const { jar, ctx } = await ownerWithOutstanding();
    const studentRows =
      await getSql()`SELECT id FROM students WHERE organization_id = ${ctx.organizationId}::uuid LIMIT 1`;
    const studentId = String(studentRows[0]!.id);
    const headers = { 'Idempotency-Key': `m11-route-${randomUUID()}` };
    const body = { studentId, priority: 'HIGH', reason: 'Route-level duplicate request test' };

    const first = await call(createCasePost as never, jar, {
      method: 'POST',
      path: '/api/collections',
      headers,
      body,
      csrf: true,
    });
    expect(first.status).toBe(201);
    const second = await call(createCasePost as never, jar, {
      method: 'POST',
      path: '/api/collections',
      headers,
      body,
      csrf: true,
    });
    expect(second.status).toBe(201);
    expect(second.response.headers.get('Idempotent-Replayed')).toBe('true');
    expect(second.data.case.id).toBe(first.data.case.id);

    await getSql()`SELECT set_tenant_context(${ctx.organizationId}::uuid, ${ctx.userId}::uuid)`;
    const events = await testDb()
      .select()
      .from(collectionsCaseEvents)
      .where(eq(collectionsCaseEvents.caseId, first.data.case.id));
    expect(events.filter((event) => event.eventType === 'CREATED')).toHaveLength(1);
  });

  it('returns a safe conflict rather than an internal error for a second open student case', async () => {
    enableSavepointTransactionsForTest();
    const { jar, ctx } = await ownerWithOutstanding();
    const studentRows =
      await getSql()`SELECT id FROM students WHERE organization_id = ${ctx.organizationId}::uuid LIMIT 1`;
    const body = {
      studentId: String(studentRows[0]!.id),
      priority: 'NORMAL',
      reason: 'Duplicate open-case audit',
    };
    const first = await call(createCasePost as never, jar, {
      method: 'POST',
      path: '/api/collections',
      headers: { 'Idempotency-Key': randomUUID() },
      body,
      csrf: true,
    });
    expect(first.status).toBe(201);
    const second = await call(createCasePost as never, jar, {
      method: 'POST',
      path: '/api/collections',
      headers: { 'Idempotency-Key': randomUUID() },
      body,
      csrf: true,
    });
    expect(second.status).toBe(409);
    expect(second.data.error.code).toBe('CONFLICT');
  });

  it('requires the current optimistic version for state changes', async () => {
    enableSavepointTransactionsForTest();
    const { jar, ctx } = await ownerWithOutstanding();
    const studentRows =
      await getSql()`SELECT id FROM students WHERE organization_id = ${ctx.organizationId}::uuid LIMIT 1`;
    const body = {
      studentId: String(studentRows[0]!.id),
      priority: 'NORMAL',
      reason: 'Stale transition test',
    };
    const created = await call(createCasePost as never, jar, {
      method: 'POST',
      path: '/api/collections',
      headers: { 'Idempotency-Key': randomUUID() },
      body,
      csrf: true,
    });
    expect(created.status).toBe(201);

    const args = [{ params: Promise.resolve({ id: created.data.case.id }) }];
    const first = await call(transitionPost as never, jar, {
      method: 'POST',
      path: `/api/collections/${created.data.case.id}/transition`,
      headers: { 'Idempotency-Key': randomUUID() },
      body: { toState: 'IN_PROGRESS', note: 'First worker', expectedVersion: 0 },
      csrf: true,
      args,
    });
    expect(first.status).toBe(200);
    const stale = await call(transitionPost as never, jar, {
      method: 'POST',
      path: `/api/collections/${created.data.case.id}/transition`,
      headers: { 'Idempotency-Key': randomUUID() },
      body: { toState: 'ESCALATED', note: 'Stale worker', expectedVersion: 0 },
      csrf: true,
      args,
    });
    expect(stale.status).toBe(409);
  });
});
