// @vitest-environment node
/** M10 HTTP contract: authentication, CSRF, authorization, idempotency, and workflow. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { call, CookieJar } from './support';
import { POST as registerPost } from '@/app/api/auth/register/route';
import { GET as meGet } from '@/app/api/auth/me/route';
import { POST as paymentPost } from '@/app/api/payments/route';
import { POST as studentPost } from '@/app/api/students/route';
import { GET as queueGet } from '@/app/api/reconciliation/queue/route';
import { GET as detailGet } from '@/app/api/reconciliation/payments/[id]/route';
import { POST as evidencePost } from '@/app/api/reconciliation/payments/[id]/evidence/route';
import { POST as confirmPost } from '@/app/api/reconciliation/payments/[id]/confirm/route';
import { POST as matchPost } from '@/app/api/reconciliation/payments/[id]/match/route';
import { POST as flagPost } from '@/app/api/reconciliation/payments/[id]/flag/route';
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
    expect(detail.data.reconciliation.evidence).toHaveLength(1);
    expect(detail.data.reconciliation.candidates[0].studentId).toBe(studentId);
    expect(detail.data.payment.unallocatedKobo).toBe(100_000);
  });
});
