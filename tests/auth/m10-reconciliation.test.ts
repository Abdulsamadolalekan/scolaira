// @vitest-environment node
/** M10 HTTP contract: authentication, CSRF, authorization, idempotency, and workflow. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { call, CookieJar } from './support';
import { POST as registerPost } from '@/app/api/auth/register/route';
import { GET as meGet } from '@/app/api/auth/me/route';
import { POST as paymentPost } from '@/app/api/payments/route';
import { POST as studentPost } from '@/app/api/students/route';
import { GET as dashboardGet } from '@/app/api/dashboard/summary/route';
import { GET as queueGet } from '@/app/api/reconciliation/queue/route';
import { GET as detailGet } from '@/app/api/reconciliation/payments/[id]/route';
import { POST as evidencePost } from '@/app/api/reconciliation/payments/[id]/evidence/route';
import { POST as allocatePost } from '@/app/api/reconciliation/payments/[id]/allocate/route';
import { POST as confirmPost } from '@/app/api/reconciliation/payments/[id]/confirm/route';
import { POST as matchPost } from '@/app/api/reconciliation/payments/[id]/match/route';
import { POST as flagPost } from '@/app/api/reconciliation/payments/[id]/flag/route';
import { POST as resolvePost } from '@/app/api/reconciliation/payments/[id]/resolve/route';
import { getSql } from '@/lib/db';
import { authorize } from '@/lib/authz/permissions';
import {
  disableSavepointTransactionsForTest,
  enableSavepointTransactionsForTest,
} from '../setup-db';

function unique(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}
function password(): string {
  return `Pass-${Math.random().toString(36).slice(2, 10)}-A1!`;
}

async function registerOwner(): Promise<{ jar: CookieJar; orgId: string; userId: string }> {
  const jar = new CookieJar();
  const registered = await call(registerPost as any, jar, {
    method: 'POST',
    path: '/api/auth/register',
    body: {
      email: `${unique('m10').toLowerCase()}@m10.example`,
      password: password(),
      firstName: 'M10',
      lastName: 'Owner',
      organizationName: unique('M10 School'),
      organizationSlug: unique('m10-school'),
    },
  });
  expect(registered.status).toBe(201);
  const me = await call(meGet as any, jar, { method: 'GET', path: '/api/auth/me' });
  expect(me.status).toBe(200);
  return { jar, orgId: me.data.activeOrganizationId, userId: me.data.user.id };
}

function dynamic(
  handler: Function,
  jar: CookieJar,
  method: string,
  path: string,
  id: string,
  body?: unknown,
  headers?: HeadersInit,
  csrf = true,
) {
  return call(handler as any, jar, {
    method,
    path,
    body,
    headers,
    csrf,
    args: [{ params: Promise.resolve({ id }) }],
  });
}

describe('M10 reconciliation route contract', () => {
  let owner: { jar: CookieJar; orgId: string; userId: string };

  beforeEach(() => enableSavepointTransactionsForTest());
  afterEach(() => disableSavepointTransactionsForTest());
  beforeAll(async () => {
    await getSql()`SELECT auth_clear_rate_limits()`.catch(() => {});
    owner = await registerOwner();
  }, 60000);
  afterAll(async () => {
    await getSql()`SELECT clear_app_context()`.catch(() => {});
  });

  it('keeps reconciliation permissions explicit and denies STAFF/platform support mutations', () => {
    for (const role of ['OWNER', 'SCHOOL_ADMIN', 'FINANCE_OFFICER'] as const) {
      expect(authorize({ role, isPlatformSupport: false }, 'reconciliation.read').allowed).toBe(
        true,
      );
      expect(authorize({ role, isPlatformSupport: false }, 'reconciliation.review').allowed).toBe(
        true,
      );
      expect(authorize({ role, isPlatformSupport: false }, 'reconciliation.resolve').allowed).toBe(
        true,
      );
    }
    expect(
      authorize({ role: 'STAFF', isPlatformSupport: false }, 'reconciliation.read').allowed,
    ).toBe(false);
    expect(
      authorize({ role: null, isPlatformSupport: true }, 'reconciliation.review').allowed,
    ).toBe(false);
  });

  it('counts confirmed unallocated work in the dashboard from the same server truth as the queue', async () => {
    const before = await call(dashboardGet as any, owner.jar, {
      method: 'GET',
      path: '/api/dashboard/summary',
    });
    expect(before.status).toBe(200);
    const beforeCount = before.data.kpis.unreconciledPayments as number;

    const payment = await call(paymentPost as any, owner.jar, {
      method: 'POST',
      path: '/api/payments',
      body: {
        method: 'BANK_TRANSFER',
        amountKobo: 42_000,
        reference: unique('dashboard-unallocated'),
        initialStatus: 'CONFIRMED',
      },
      headers: { 'idempotency-key': unique('dashboard-payment') },
      csrf: true,
    });
    expect(payment.status).toBe(201);

    const after = await call(dashboardGet as any, owner.jar, {
      method: 'GET',
      path: '/api/dashboard/summary',
    });
    expect(after.status).toBe(200);
    expect(after.data.kpis.unreconciledPayments).toBe(beforeCount + 1);
    expect(after.data.attention.some((item: any) => item.id === payment.data.payment.id)).toBe(
      true,
    );
  });

  it('runs evidence → confirm → explicit student match, with replay and CSRF/idempotency guards', async () => {
    const paymentResponse = await call(paymentPost as any, owner.jar, {
      method: 'POST',
      path: '/api/payments',
      body: {
        method: 'BANK_TRANSFER',
        amountKobo: 100_000,
        reference: unique('bank-ref'),
        initialStatus: 'PENDING',
      },
      headers: { 'idempotency-key': unique('record-payment') },
      csrf: true,
    });
    expect(paymentResponse.status).toBe(201);
    const paymentId = paymentResponse.data.payment.id as string;

    const queueBefore = await call(queueGet as any, owner.jar, {
      method: 'GET',
      path: '/api/reconciliation/queue',
    });
    expect(queueBefore.status).toBe(200);
    expect(
      queueBefore.data.queue.some(
        (row: any) => row.paymentId === paymentId && row.state === 'UNMATCHED',
      ),
    ).toBe(true);
    const invalidCursor = Buffer.from(
      JSON.stringify({ createdAt: 'not-a-timestamp', paymentId: 'not-a-uuid' }),
      'utf8',
    ).toString('base64url');
    const invalidCursorResponse = await call(queueGet as any, owner.jar, {
      method: 'GET',
      path: `/api/reconciliation/queue?cursor=${invalidCursor}`,
    });
    expect(invalidCursorResponse.status).toBe(400);
    expect(invalidCursorResponse.data.error.code).toBe('BAD_REQUEST');

    const confirmedPaymentResponse = await call(paymentPost as any, owner.jar, {
      method: 'POST',
      path: '/api/payments',
      body: {
        method: 'BANK_TRANSFER',
        amountKobo: 80_000,
        reference: unique('confirmed-bank-ref'),
        initialStatus: 'CONFIRMED',
      },
      headers: { 'idempotency-key': unique('record-confirmed-payment') },
      csrf: true,
    });
    expect(confirmedPaymentResponse.status).toBe(201);
    const confirmedPaymentId = confirmedPaymentResponse.data.payment.id as string;
    const allocationWithoutEvidence = await dynamic(
      allocatePost,
      owner.jar,
      'POST',
      `/api/reconciliation/payments/${confirmedPaymentId}/allocate`,
      confirmedPaymentId,
      { allocations: [{ invoiceId: '00000000-0000-4000-8000-000000000001', amountKobo: 1 }] },
      { 'idempotency-key': unique('allocate-without-evidence') },
    );
    expect(allocationWithoutEvidence.status).toBe(409);
    expect(allocationWithoutEvidence.data.error.message).toMatch(/evidence/i);
    const unsafeAllocationAmount = await dynamic(
      allocatePost,
      owner.jar,
      'POST',
      `/api/reconciliation/payments/${confirmedPaymentId}/allocate`,
      confirmedPaymentId,
      {
        allocations: [
          {
            invoiceId: '00000000-0000-4000-8000-000000000001',
            amountKobo: Number.MAX_SAFE_INTEGER + 1,
          },
        ],
      },
      { 'idempotency-key': unique('unsafe-allocation-amount') },
    );
    expect(unsafeAllocationAmount.status).toBe(400);

    const evidenceBody = {
      kind: 'BANK_REFERENCE',
      reference: 'statement-2026-09-21-001',
      note: 'Operator checked the bank statement reference.',
    };
    const evidenceKey = unique('evidence');
    const evidence = await dynamic(
      evidencePost,
      owner.jar,
      'POST',
      `/api/reconciliation/payments/${paymentId}/evidence`,
      paymentId,
      evidenceBody,
      { 'idempotency-key': evidenceKey },
    );
    expect(evidence.status).toBe(201);
    const evidenceReplay = await dynamic(
      evidencePost,
      owner.jar,
      'POST',
      `/api/reconciliation/payments/${paymentId}/evidence`,
      paymentId,
      evidenceBody,
      { 'idempotency-key': evidenceKey },
    );
    expect(evidenceReplay.status).toBe(201);
    expect(evidenceReplay.response.headers.get('idempotent-replayed')).toBe('true');
    expect(evidenceReplay.data.evidence.id).toBe(evidence.data.evidence.id);

    const missingKey = await dynamic(
      evidencePost,
      owner.jar,
      'POST',
      `/api/reconciliation/payments/${paymentId}/evidence`,
      paymentId,
      { kind: 'OPERATOR_NOTE', note: 'Should be rejected without a key.' },
    );
    expect(missingKey.status).toBe(400);
    const missingCsrf = await dynamic(
      flagPost,
      owner.jar,
      'POST',
      `/api/reconciliation/payments/${paymentId}/flag`,
      paymentId,
      { flagged: true, reason: 'CSRF negative test' },
      { 'idempotency-key': unique('csrf-negative') },
      false,
    );
    expect(missingCsrf.status).toBe(403);

    const confirmed = await dynamic(
      confirmPost,
      owner.jar,
      'POST',
      `/api/reconciliation/payments/${paymentId}/confirm`,
      paymentId,
      {},
      { 'idempotency-key': unique('confirm') },
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.data.payment.status).toBe('CONFIRMED');

    const studentResponse = await call(studentPost as any, owner.jar, {
      method: 'POST',
      path: '/api/students',
      body: { studentId: unique('M10-STU'), firstName: 'Ada', lastName: 'Reconciled' },
      headers: { 'idempotency-key': unique('student') },
      csrf: true,
    });
    expect(studentResponse.status).toBe(201);
    const studentId = studentResponse.data.student.id as string;
    const matched = await dynamic(
      matchPost,
      owner.jar,
      'POST',
      `/api/reconciliation/payments/${paymentId}/match`,
      paymentId,
      { studentId, basis: 'Payer name and bank reference manually agree with the student record.' },
      { 'idempotency-key': unique('match') },
    );
    expect(matched.status).toBe(200);
    expect(matched.data.reconciliation.state).toBe('RECONCILED');

    const detail = await dynamic(
      detailGet,
      owner.jar,
      'GET',
      `/api/reconciliation/payments/${paymentId}`,
      paymentId,
      undefined,
      undefined,
      false,
    );
    expect(detail.status).toBe(200);
    expect(detail.data.reconciliation.case.state).toBe('RECONCILED');
    expect(detail.data.reconciliation.case.createdBy).toBe(owner.userId);
    expect(detail.data.reconciliation.evidence).toHaveLength(1);
    expect(detail.data.reconciliation.evidence[0].createdBy).toBe(owner.userId);
    expect(detail.data.reconciliation.evidence[0].createdAt).toBeTruthy();
    expect(detail.data.reconciliation.candidates[0].studentId).toBe(studentId);
    expect(detail.data.reconciliation.candidates[0].createdBy).toBe(owner.userId);
    expect(detail.data.reconciliation.candidates[0].decidedBy).toBe(owner.userId);
    expect(detail.data.reconciliation.candidates[0].decidedAt).toBeTruthy();
    expect(detail.data.audit.some((event: any) => event.actorUserId === owner.userId)).toBe(true);
    expect(detail.data.payment.unallocatedKobo).toBe(100_000);

    const flagged = await dynamic(
      flagPost,
      owner.jar,
      'POST',
      `/api/reconciliation/payments/${paymentId}/flag`,
      paymentId,
      { flagged: true, reason: 'Escalated for a second human review.' },
      { 'idempotency-key': unique('flag') },
    );
    expect(flagged.status).toBe(200);
    expect(flagged.data.reconciliation.state).toBe('FLAGGED');
    const unflagged = await dynamic(
      flagPost,
      owner.jar,
      'POST',
      `/api/reconciliation/payments/${paymentId}/flag`,
      paymentId,
      { flagged: false, reason: 'Second review completed.' },
      { 'idempotency-key': unique('unflag') },
    );
    expect(unflagged.status).toBe(200);
    expect(unflagged.data.reconciliation.state).toBe('RECONCILED');
    const flaggedAgain = await dynamic(
      flagPost,
      owner.jar,
      'POST',
      `/api/reconciliation/payments/${paymentId}/flag`,
      paymentId,
      { flagged: true, reason: 'Final exception review.' },
      { 'idempotency-key': unique('flag-final') },
    );
    expect(flaggedAgain.status).toBe(200);
    const resolveKey = unique('resolve');
    const resolved = await dynamic(
      resolvePost,
      owner.jar,
      'POST',
      `/api/reconciliation/payments/${paymentId}/resolve`,
      paymentId,
      { resolutionCode: 'NO_FINANCIAL_ACTION', note: 'Reviewed with no financial correction.' },
      { 'idempotency-key': resolveKey },
    );
    expect(resolved.status).toBe(200);
    expect(resolved.data.reconciliation.state).toBe('RECONCILED');
    const resolveReplay = await dynamic(
      resolvePost,
      owner.jar,
      'POST',
      `/api/reconciliation/payments/${paymentId}/resolve`,
      paymentId,
      { resolutionCode: 'NO_FINANCIAL_ACTION', note: 'Reviewed with no financial correction.' },
      { 'idempotency-key': resolveKey },
    );
    expect(resolveReplay.status).toBe(200);
    expect(resolveReplay.response.headers.get('idempotent-replayed')).toBe('true');
    const closedDetail = await dynamic(
      detailGet,
      owner.jar,
      'GET',
      `/api/reconciliation/payments/${paymentId}`,
      paymentId,
      undefined,
      undefined,
      false,
    );
    expect(closedDetail.data.reconciliation.case).toBeNull();
    expect(closedDetail.data.reconciliation.derived).toMatchObject({
      state: 'UNMATCHED',
      kind: 'TO_MATCH',
    });
    expect(closedDetail.data.reconciliation.history[0].closedAt).toBeTruthy();
    expect(
      closedDetail.data.audit.some((event: any) => event.action === 'reconciliation.resolve'),
    ).toBe(true);

    const foreign = await registerOwner();
    const foreignQueue = await call(queueGet as any, foreign.jar, {
      method: 'GET',
      path: '/api/reconciliation/queue',
    });
    expect(foreignQueue.status).toBe(200);
    expect(foreignQueue.data.queue.some((row: any) => row.paymentId === paymentId)).toBe(false);
    const foreignDetail = await dynamic(
      detailGet,
      foreign.jar,
      'GET',
      `/api/reconciliation/payments/${paymentId}`,
      paymentId,
      undefined,
      undefined,
      false,
    );
    expect(foreignDetail.status).toBe(404);
    const foreignEvidence = await dynamic(
      evidencePost,
      foreign.jar,
      'POST',
      `/api/reconciliation/payments/${paymentId}/evidence`,
      paymentId,
      { kind: 'OPERATOR_NOTE', note: 'Foreign tenant payload.' },
      { 'idempotency-key': unique('foreign-evidence') },
    );
    expect(foreignEvidence.status).toBe(404);
  });
});
