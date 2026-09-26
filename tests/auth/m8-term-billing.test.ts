// @vitest-environment node
/** M8 route-boundary tests: real sessions, CSRF, role gates, and tenant RLS. */
import { describe, expect, it, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { call, CookieJar } from './support';
import { POST as registerPost } from '@/app/api/auth/register/route';
import { GET as meGet } from '@/app/api/auth/me/route';
import { POST as selectOrgPost } from '@/app/api/auth/select-organization/route';
import { POST as seedTermPost } from '@/app/api/setup/seed-current-term/route';
import { POST as feePost, GET as feeGet } from '@/app/api/fee-definitions/route';
import { PUT as assignmentPut } from '@/app/api/terms/[id]/fee-assignments/route';
import { GET as previewGet } from '@/app/api/terms/[id]/bill-preview/route';
import { POST as billPost } from '@/app/api/terms/[id]/bill/route';
import { GET as debtorsGet } from '@/app/api/debtors/route';
import { GET as summaryGet } from '@/app/api/dashboard/summary/route';
import { organizationMembers, students, classes, classEnrollments } from '@/lib/db/schema';
import { withSystemContext, withTenant } from '@/lib/db/tenant';

// This file imports the small test-only DB bridge below rather than touching
// production connection constructors directly.
type Actor = { jar: CookieJar; orgId: string; userId: string; role: string };

function unique(prefix: string) { return `${prefix}-${Math.random().toString(36).slice(2, 10)}`; }
function password() { return `Pass-${Math.random().toString(36).slice(2, 10)}-A1!`; }

async function register(firstName: string, role?: 'SCHOOL_ADMIN' | 'FINANCE_OFFICER' | 'STAFF', orgId?: string): Promise<Actor> {
  const jar = new CookieJar();
  const email = `${unique(firstName).toLowerCase()}@example.com`;
  const reg = await call(registerPost as any, jar, { method: 'POST', path: '/api/auth/register', body: {
    email, password: password(), firstName, lastName: 'M8', organizationName: `School ${firstName}`, organizationSlug: unique(firstName).toLowerCase(),
  }});
  expect(reg.status).toBe(201);
  const me = await call(meGet as any, jar, { method: 'GET', path: '/api/auth/me' });
  const activeOrg = orgId ?? me.data.activeOrganizationId;
  const userId = me.data.user.id as string;
  if (role && orgId) {
    await withSystemContext(null, null, async (db) => {
      await db.insert(organizationMembers).values({ organizationId: orgId, userId, role, status: 'ACTIVE', joinedAt: new Date(), createdAt: new Date(), updatedAt: new Date() } as any);
    });
    const selected = await call(selectOrgPost as any, jar, { method: 'POST', path: '/api/auth/select-organization', body: { organizationId: orgId }, csrf: true });
    expect(selected.status).toBe(200);
  }
  return { jar, orgId: activeOrg, userId, role: role ?? 'OWNER' };
}

async function dynamicCall(handler: Function, actor: Actor | null, method: string, path: string, id: string, body?: unknown, csrf = true) {
  const jar = actor?.jar ?? new CookieJar();
  const wrapped = (request: Request) => handler(request, { params: Promise.resolve({ id }) });
  return call(wrapped as any, jar, { method, path, body, csrf });
}

async function seedDomain(actor: Actor) {
  const seed = await call(seedTermPost as any, actor.jar, { method: 'POST', path: '/api/setup/seed-current-term', body: {}, csrf: true });
  expect(seed.status).toBe(200);
  const term = seed.data.term as { id: string; sessionId: string };
  const ids = { studentId: randomUUID(), classId: randomUUID() };
  await withTenant({ organizationId: actor.orgId, userId: actor.userId }, async (db) => {
    await db.insert(classes).values({ id: ids.classId, organizationId: actor.orgId, name: 'M8 Class', sortOrder: 1 } as any);
    await db.insert(students).values({ id: ids.studentId, organizationId: actor.orgId, studentId: `M8-${unique('S')}`, firstName: 'Ada', lastName: 'Billing', status: 'ACTIVE' } as any);
    await db.insert(classEnrollments).values({ organizationId: actor.orgId, studentId: ids.studentId, classId: ids.classId, termId: term.id, enrolledOn: '2026-01-01' } as any);
  });
  return { term, ids };
}

describe('M8 route boundary', () => {
  let owner: Actor;
  let schoolAdmin: Actor;
  let finance: Actor;
  let foreign: Actor;
  let term: { id: string; sessionId: string };
  let feeId: string;

  beforeAll(async () => {
    owner = await register('Owner');
    schoolAdmin = await register('Admin', 'SCHOOL_ADMIN', owner.orgId);
    finance = await register('Finance', 'FINANCE_OFFICER', owner.orgId);
    foreign = await register('Foreign');
    term = (await seedDomain(owner)).term;
  }, 60000);


  it('unauthenticated bill POST is rejected before tenant lookup', async () => {
    const result = await dynamicCall(billPost, null, 'POST', `/api/terms/${term.id}/bill`, term.id, { overrides: [] }, false);
    expect(result.status).toBe(401);
  });

  it('CSRF-less state change is rejected', async () => {
    const result = await dynamicCall(billPost, owner, 'POST', `/api/terms/${term.id}/bill`, term.id, { overrides: [] }, false);
    expect(result.status).toBe(403);
  });

  it('SCHOOL_ADMIN can configure and review but cannot commit term billing', async () => {
    const feeResult = await call(feePost as any, schoolAdmin.jar, { method: 'POST', path: '/api/fee-definitions', body: { code: 'TUITION', name: 'Tuition', description: null, defaultAmountKobo: 100000 }, csrf: true });
    expect(feeResult.status).toBe(201);
    feeId = feeResult.data.feeDefinition.id;
    const assignmentResult = await dynamicCall(assignmentPut, schoolAdmin, 'PUT', `/api/terms/${term.id}/fee-assignments`, term.id, { assignments: [{ feeDefinitionId: feeId, classId: null, amountKobo: 100000, adjustmentKobo: 0, status: 'ACTIVE' }] });
    expect(assignmentResult.status).toBe(200);
    const review = await dynamicCall(previewGet, schoolAdmin, 'GET', `/api/terms/${term.id}/bill-preview`, term.id, undefined, false);
    expect(review.status).toBe(200);
    expect(review.data.preview.students).toHaveLength(1);
    const commit = await dynamicCall(billPost, schoolAdmin, 'POST', `/api/terms/${term.id}/bill`, term.id, { overrides: [] }, true);
    expect(commit.status).toBe(403);
  });

  it('OWNER can issue; FINANCE_OFFICER can safely retry; fee reads stay tenant-scoped', async () => {
    // Self-contained setup. R1 scopes run transaction-locally inside the
    // harness's per-test transaction, so work performed by an earlier test is
    // no longer visible here (before R1 a route's BEGIN/COMMIT incidentally
    // committed the harness transaction, which is what this test used to rely
    // on). Assertions are unchanged; they now exercise their own data.
    const feeResult = await call(feePost as any, schoolAdmin.jar, {
      method: 'POST', path: '/api/fee-definitions',
      body: { code: 'TUITION-BILL', name: 'Tuition (bill)', description: null, defaultAmountKobo: 100000 },
      csrf: true,
    });
    expect(feeResult.status).toBe(201);
    const assignmentResult = await dynamicCall(
      assignmentPut, schoolAdmin, 'PUT', `/api/terms/${term.id}/fee-assignments`, term.id,
      { assignments: [{ feeDefinitionId: feeResult.data.feeDefinition.id, classId: null, amountKobo: 100000, adjustmentKobo: 0, status: 'ACTIVE' }] },
    );
    expect(assignmentResult.status).toBe(200);

    const issued = await dynamicCall(billPost, finance, 'POST', `/api/terms/${term.id}/bill`, term.id, { overrides: [] });
    expect(issued.status).toBe(200);
    expect(issued.data.bill.createdInvoices).toBe(1);
    const retry = await dynamicCall(billPost, owner, 'POST', `/api/terms/${term.id}/bill`, term.id, { overrides: [] });
    expect(retry.status).toBe(200);
    expect(retry.data.bill.createdInvoices).toBe(0);
    const debtorRows = await call(debtorsGet as any, finance.jar, { method: 'GET', path: '/api/debtors' });
    expect(debtorRows.status).toBe(200);
    expect(debtorRows.data.totals.outstandingKobo).toBe(100000);
    const dashboard = await call(summaryGet as any, finance.jar, { method: 'GET', path: '/api/dashboard/summary' });
    expect(dashboard.status).toBe(200);
    expect(dashboard.data.kpis.billedKobo).toBe(100000);
    const feeList = await call(feeGet as any, foreign.jar, { method: 'GET', path: '/api/fee-definitions' });
    expect(feeList.status).toBe(200);
    expect(feeList.data.feeDefinitions).toHaveLength(0);
  });

  it('cross-tenant term ID is not billable or previewable', async () => {
    const foreignSeed = await call(seedTermPost as any, foreign.jar, { method: 'POST', path: '/api/setup/seed-current-term', body: {}, csrf: true });
    expect(foreignSeed.status).toBe(200);
    const foreignTermId = foreignSeed.data.term.id as string;
    const result = await dynamicCall(billPost, owner, 'POST', `/api/terms/${foreignTermId}/bill`, foreignTermId, { overrides: [] });
    expect(result.status).toBe(404);
    const preview = await dynamicCall(previewGet, owner, 'GET', `/api/terms/${foreignTermId}/bill-preview`, foreignTermId, undefined, false);
    expect(preview.status).toBe(404);
  });
});
