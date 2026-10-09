// @vitest-environment node
/**
 * R2 — exceptional-path financial integrity.
 *
 * Everything here is written against the *boundary*, not against the
 * implementation: the invariants are asserted through real route handlers and
 * through raw SQL on real separate connections, so any future rewrite that
 * breaks them fails here.
 *
 * Findings this suite closes (verified against the running database before the
 * fix, see docs/security/R2_EXCEPTIONAL_PATH_FINANCIAL_INTEGRITY_CLOSEOUT.md):
 *
 *   H-7.1  Reversal idempotency was SELECT-then-INSERT with no database
 *          constraint. Measured: two connections following the route's exact
 *          sequence both passed the guard and both inserted, so a 1,000,000
 *          kobo payment was reduced to paid_kobo=0 / ISSUED by two
 *          individually-valid halves of one logical correction.
 *   H-7.2  Payment recording, receipt issuance and invoice void carried no
 *          mandatory idempotency boundary, and receipts/void read their
 *          preconditions outside any transaction.
 *   M-3    A receipt's frozen amount was rendered against *current* ACTIVE
 *          allocations, so a post-issuance reversal made the printed document
 *          contradict the ledger.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { call, CookieJar } from '../auth/support';
import { POST as registerPost } from '@/app/api/auth/register/route';
import { GET as meGet } from '@/app/api/auth/me/route';
import { getSql } from '@/lib/db';
import { setupConcurrencyFixtures } from '../support/concurrent-seed';

const URL =
  process.env.DATABASE_URL ?? 'postgresql://scolaira_app:scolaira_app_pw@localhost:5432/scolaira_test';

type Jar = InstanceType<typeof CookieJar>;
type Actor = { jar: Jar; userId: string; orgId: string };

// ---------------------------------------------------------------------------
// Harness (same shape as the M6 endpoint tests: real handlers, real cookies)
// ---------------------------------------------------------------------------

async function registerOwner(): Promise<Actor> {
  const email = `r2-${randomUUID().slice(0, 8)}@example.com`;
  const slug = `r2-${randomUUID().slice(0, 8)}`;
  const jar = new CookieJar();
  const reg = await call(registerPost, jar, {
    method: 'POST',
    path: '/api/auth/register',
    body: {
      email,
      password: 'Pass-' + randomUUID().slice(0, 8) + '-A1!',
      firstName: 'R2',
      lastName: 'Owner',
      organizationName: 'School ' + slug,
      organizationSlug: slug,
    },
  });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.data)}`);
  const me = await call(meGet, jar, { method: 'GET', path: '/api/auth/me' });
  return { jar, userId: me.data.user.id, orgId: me.data.activeOrganizationId };
}

/** Dynamic-route-aware dispatcher (subset needed by R2). */
async function callRoute(
  method: string,
  path: string,
  jar: Jar,
  body?: unknown,
  extraHeaders?: Record<string, string>,
) {
  const segs = path.split('/').filter(Boolean);
  const load = (modPath: string, params?: Record<string, string>) =>
    import(/* @vite-ignore */ `@/${modPath}`).then((mod: any) => {
      const exports = mod?.default ?? mod;
      const handler = exports[method];
      if (typeof handler !== 'function') throw new Error(`no ${method} handler in ${modPath}`);
      return { handler, params };
    });
  let target: { handler: any; params?: Record<string, string> };
  const [, s1, s2, s3] = segs;
  if (s1 === 'payments' && segs.length === 4) target = await load(`app/api/payments/[id]/${s3}/route`, { id: s2! });
  else if (s1 === 'receipts' && segs.length === 3) target = await load('app/api/receipts/[id]/route', { id: s2! });
  else if (s1 === 'invoices' && segs.length === 4) target = await load(`app/api/invoices/[id]/${s3}/route`, { id: s2! });
  else target = await load('app/' + segs.join('/') + '/route');
  const init: any = {
    method,
    path,
    body,
    csrf: !['GET', 'HEAD', 'OPTIONS'].includes(method),
    headers: { 'content-type': 'application/json', ...(extraHeaders ?? {}) },
  };
  const wrapped = async (req: Request) =>
    target.params ? target.handler(req, { params: Promise.resolve(target.params) }) : target.handler(req);
  return call(wrapped as any, jar, init);
}

const key = (p = 'r2') => `${p}-${randomUUID()}`;

async function createInvoice(jar: Jar, studentId: string, totalKobo: number) {
  const r = await callRoute('POST', '/api/invoices', jar, {
    studentId,
    dueDate: new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10),
    lines: [{ description: 'Tuition', quantity: 1, unitRateKobo: totalKobo }],
  }, { 'idempotency-key': key('inv') });
  if (r.status !== 201) throw new Error(`invoice failed: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.invoice as { id: string; invoiceNumber: string };
}

async function createStudent(jar: Jar) {
  const r = await callRoute('POST', '/api/students', jar, {
    studentId: 'R2-' + randomUUID().slice(0, 8).toUpperCase(),
    firstName: 'Ada',
    lastName: 'Parent',
    gender: 'F',
  });
  if (r.status !== 201) throw new Error(`student failed: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.student as { id: string };
}

/** Record a CONFIRMED payment (optionally allocated) through the API. */
async function recordPayment(
  jar: Jar,
  opts: { amountKobo: number; reference?: string; allocations?: Array<{ invoiceId: string; amountKobo: number }>; idem?: string },
) {
  const idem = opts.idem ?? key('pay');
  const r = await callRoute('POST', '/api/payments', jar, {
    method: 'BANK_TRANSFER',
    amountKobo: opts.amountKobo,
    reference: opts.reference ?? `R2REF-${randomUUID().slice(0, 8)}`,
    payerName: 'Parent Payer',
    initialStatus: 'CONFIRMED',
    allocations: opts.allocations ?? [],
  }, { 'idempotency-key': idem });
  return { status: r.status, data: r.data, response: r.response, idem };
}

type TenantSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<any[]>;
  unsafe(query: string, params?: unknown[]): Promise<any[]>;
};

/** Tenant-scoped read helper against the live database. */
async function inTenant<T>(actor: Actor, fn: (sql: TenantSql) => Promise<T>): Promise<T> {
  const sql = getSql() as unknown as TenantSql & { (s: TemplateStringsArray, ...v: unknown[]): Promise<any[]> };
  await sql`select set_tenant_context(${actor.orgId}::uuid, ${actor.userId}::uuid)`;
  try {
    return await fn(sql as unknown as TenantSql);
  } finally {
    await sql`select clear_app_context()`.catch(() => {});
  }
}

/** A committed financial fixture on its own autocommit connections. */
async function seedCommittedFinancials() {
  const fx = await setupConcurrencyFixtures();
  const created = await fx.asTenant(async (sql) => {
    const invoiceId = randomUUID();
    await sql`INSERT INTO invoices (id, student_id, term_id, session_id, status, total_kobo, paid_kobo, due_date)
              VALUES (${invoiceId}::uuid, ${fx.studentId}::uuid, ${fx.termId}::uuid, ${fx.sessionId}::uuid,
                      'ISSUED', 1000000, 0, now()::date + 30)`;
    await sql`INSERT INTO invoice_lines (organization_id, invoice_id, description, quantity, unit_rate_kobo, amount_kobo)
              VALUES (${fx.orgId}::uuid, ${invoiceId}::uuid, 'tuition', 1, 1000000, 1000000)`;
    const paymentId = randomUUID();
    await sql`INSERT INTO payments (id, organization_id, method, status, amount_kobo, unallocated_kobo, reference, paid_at)
              VALUES (${paymentId}::uuid, ${fx.orgId}::uuid, 'BANK_TRANSFER', 'CONFIRMED', 1000000, 0, ${'R2-COMMITTED-' + paymentId.slice(0, 8)}, now())`;
    for (let i = 0; i < 2; i += 1) {
      await sql`INSERT INTO payment_allocations (organization_id, payment_id, invoice_id, amount_kobo, status)
                VALUES (${fx.orgId}::uuid, ${paymentId}::uuid, ${invoiceId}::uuid, 500000, 'ACTIVE')`;
    }
    return { invoiceId, paymentId };
  });
  return { fx, ...created };
}

async function openTenantConnection(orgId: string, userId: string) {
  const sql = postgres(URL, { max: 1 });
  await sql`SELECT set_tenant_context(${orgId}::uuid, ${userId}::uuid)`;
  return sql;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Leave the harness's per-test transaction, so each request owns its own
 * transaction the way it does in production.
 *
 * Needed by the concurrency group only: while an ambient transaction is open,
 * two overlapping requests share one connection and each wraps itself in a
 * SAVEPOINT; a failure in one then invalidates the other's savepoint name and
 * the connection ends up aborted — a property of the harness's ambient
 * transaction, not of the product (outside it every request scope opens its own
 * BEGIN and the shared-connection lock serialises them). The data these tests
 * create is deliberately committed and namespaced per test; the global setup
 * recreates the schema between runs.
 */
async function leaveHarnessTransaction(): Promise<void> {
  await getSql().unsafe('COMMIT').catch(() => {});
}

describe('R2 — exceptional-path financial integrity', () => {
  let owner: Actor;
  const openConnections: postgres.Sql[] = [];

  beforeAll(async () => {
    const sql = getSql();
    await sql`SELECT auth_clear_rate_limits()`.catch(() => {});
    owner = await registerOwner();
    const seeded = await callRoute('POST', '/api/setup/seed-current-term', owner.jar, {});
    if (seeded.status !== 200) {
      throw new Error(`seed term failed: ${seeded.status} ${JSON.stringify(seeded.data)}`);
    }
  }, 60000);

  afterAll(async () => {
    await Promise.all(openConnections.splice(0).map((s) => s.end({ timeout: 5 }).catch(() => {})));
    await getSql()`select clear_app_context()`.catch(() => {});
  });

  // =========================================================================
  // A. Mandatory idempotency boundary on financial mutations
  // =========================================================================
  describe('A. financial mutations require an Idempotency-Key', () => {
    it('A1. payment recording without a key is refused (400) and records nothing', async () => {
      const r = await callRoute('POST', '/api/payments', owner.jar, {
        method: 'BANK_TRANSFER', amountKobo: 100_000, payerName: 'P',
      });
      expect(r.status).toBe(400);
      expect(String(r.data?.error?.message ?? '')).toMatch(/Idempotency-Key/i);
    });

    it('A2. the same key replays instead of recording a second payment', async () => {
      const student = await createStudent(owner.jar);
      const invoice = await createInvoice(owner.jar, student.id, 500_000);
      const idem = key('pay-replay');
      const body = {
        method: 'BANK_TRANSFER', amountKobo: 500_000, reference: `R2-REPLAY-${randomUUID().slice(0, 8)}`,
        payerName: 'P', initialStatus: 'CONFIRMED',
        allocations: [{ invoiceId: invoice.id, amountKobo: 500_000 }],
      };
      const first = await callRoute('POST', '/api/payments', owner.jar, body, { 'idempotency-key': idem });
      expect(first.status).toBe(201);
      const second = await callRoute('POST', '/api/payments', owner.jar, body, { 'idempotency-key': idem });
      expect(second.status).toBe(201);
      expect(second.response.headers.get('idempotent-replayed')).toBe('true');
      expect(second.data.payment.id).toBe(first.data.payment.id);

      const rows = await inTenant(owner, (sql) => sql`
        SELECT count(*)::int AS n FROM payments WHERE id = ${first.data.payment.id}::uuid`);
      expect(rows[0].n).toBe(1);
      const inv = await inTenant(owner, (sql) => sql`
        SELECT paid_kobo, total_kobo, status FROM invoices WHERE id = ${invoice.id}::uuid`);
      // The allocation was applied exactly once.
      expect(Number(inv[0].paid_kobo)).toBe(500_000);
      expect(inv[0].status).toBe('PAID');
    });

    it('A3. reusing a key with a different body is a 409, not a silent second effect', async () => {
      const idem = key('pay-reuse');
      const first = await recordPayment(owner.jar, { amountKobo: 250_000, idem });
      expect(first.status).toBe(201);
      const second = await callRoute('POST', '/api/payments', owner.jar, {
        method: 'BANK_TRANSFER', amountKobo: 999_000, reference: `R2-OTHER-${randomUUID().slice(0, 8)}`,
        payerName: 'P', initialStatus: 'CONFIRMED', allocations: [],
      }, { 'idempotency-key': idem });
      expect(second.status).toBe(409);
      expect(second.data?.error?.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('A4. reversal requires a key and replays the same reversal', async () => {
      const student = await createStudent(owner.jar);
      const invoice = await createInvoice(owner.jar, student.id, 400_000);
      const pay = await recordPayment(owner.jar, {
        amountKobo: 400_000, allocations: [{ invoiceId: invoice.id, amountKobo: 400_000 }],
      });
      expect(pay.status).toBe(201);
      const paymentId = pay.data.payment.id;

      const noKey = await callRoute('POST', `/api/payments/${paymentId}/reverse`, owner.jar, {
        type: 'REVERSAL', amountKobo: 400_000, reason: 'without key',
      });
      expect(noKey.status).toBe(400);

      const idem = key('rev-replay');
      const body = { type: 'REVERSAL', amountKobo: 400_000, reason: 'bank returned the transfer', reference: `RV-${randomUUID().slice(0, 8)}` };
      const first = await callRoute('POST', `/api/payments/${paymentId}/reverse`, owner.jar, body, { 'idempotency-key': idem });
      expect(first.status).toBe(201);
      const second = await callRoute('POST', `/api/payments/${paymentId}/reverse`, owner.jar, body, { 'idempotency-key': idem });
      expect([200, 201]).toContain(second.status);
      expect(second.data.reversal.id).toBe(first.data.reversal.id);

      const rows = await inTenant(owner, (sql) => sql`
        SELECT count(*)::int AS n FROM reversals WHERE payment_id = ${paymentId}::uuid`);
      expect(rows[0].n).toBe(1);
    });

    it('A5. allocation requires a key and replays the same allocation', async () => {
      const student = await createStudent(owner.jar);
      const invoice = await createInvoice(owner.jar, student.id, 300_000);
      const pay = await recordPayment(owner.jar, { amountKobo: 300_000 });
      const paymentId = pay.data.payment.id;

      const noKey = await callRoute('POST', `/api/payments/${paymentId}/allocate`, owner.jar, {
        allocations: [{ invoiceId: invoice.id, amountKobo: 300_000 }],
      });
      expect(noKey.status).toBe(400);

      const idem = key('alloc-replay');
      const body = { allocations: [{ invoiceId: invoice.id, amountKobo: 300_000 }] };
      const first = await callRoute('POST', `/api/payments/${paymentId}/allocate`, owner.jar, body, { 'idempotency-key': idem });
      expect(first.status).toBe(200);
      const second = await callRoute('POST', `/api/payments/${paymentId}/allocate`, owner.jar, body, { 'idempotency-key': idem });
      expect(second.status).toBe(200);
      expect(second.response.headers.get('idempotent-replayed')).toBe('true');

      const rows = await inTenant(owner, (sql) => sql`
        SELECT count(*)::int AS n FROM payment_allocations WHERE payment_id = ${paymentId}::uuid`);
      expect(rows[0].n).toBe(1);
      const inv = await inTenant(owner, (sql) => sql`
        SELECT paid_kobo FROM invoices WHERE id = ${invoice.id}::uuid`);
      expect(Number(inv[0].paid_kobo)).toBe(300_000);
    });

    it('A6. receipt issuance and invoice void require a key', async () => {
      const student = await createStudent(owner.jar);
      const invoice = await createInvoice(owner.jar, student.id, 200_000);
      const noKeyReceipt = await callRoute('POST', '/api/receipts', owner.jar, { paymentId: randomUUID() });
      expect(noKeyReceipt.status).toBe(400);
      const noKeyVoid = await callRoute('POST', `/api/invoices/${invoice.id}/void`, owner.jar, { reason: 'x' });
      expect(noKeyVoid.status).toBe(400);
    });
  });

  // =========================================================================
  // B. Concurrent financial requests
  // =========================================================================
  describe('B. concurrency', () => {
    it('B1. two concurrent reversals carrying the same reference reverse once', async () => {
      await leaveHarnessTransaction();
      const student = await createStudent(owner.jar);
      const invoice = await createInvoice(owner.jar, student.id, 600_000);
      const pay = await recordPayment(owner.jar, {
        amountKobo: 600_000, allocations: [{ invoiceId: invoice.id, amountKobo: 600_000 }],
      });
      const paymentId = pay.data.payment.id;
      const body = { type: 'REVERSAL', amountKobo: 600_000, reason: 'duplicate bank notification', reference: `RV-DUP-${randomUUID().slice(0, 8)}` };

      const [a, b] = await Promise.all([
        callRoute('POST', `/api/payments/${paymentId}/reverse`, owner.jar, body, { 'idempotency-key': key('rev-a') }),
        callRoute('POST', `/api/payments/${paymentId}/reverse`, owner.jar, body, { 'idempotency-key': key('rev-b') }),
      ]);
      const ok = [a, b].filter((r) => [200, 201].includes(r.status));
      expect(ok.length).toBeGreaterThanOrEqual(1);
      // Nothing may have been answered with an internal error.
      for (const r of [a, b]) expect(r.status).not.toBe(500);

      const revs = await inTenant(owner, (sql) => sql`
        SELECT id, amount_kobo FROM reversals WHERE payment_id = ${paymentId}::uuid`);
      expect(revs.length).toBe(1);
      expect(Number(revs[0]!.amount_kobo)).toBe(600_000);

      const inv = await inTenant(owner, (sql) => sql`
        SELECT paid_kobo, status FROM invoices WHERE id = ${invoice.id}::uuid`);
      // Exactly one 600,000 reversal: the money is back, the invoice reopens
      // once — not a double reversal on top of it.
      expect(Number(inv[0].paid_kobo)).toBe(0);
      const payRow = await inTenant(owner, (sql) => sql`
        SELECT status, unallocated_kobo, amount_kobo FROM payments WHERE id = ${paymentId}::uuid`);
      expect(payRow[0].status).toBe('REVERSED');
      expect(Number(payRow[0].unallocated_kobo)).toBe(Number(payRow[0].amount_kobo));
      const audit = await inTenant(owner, (sql) => sql`
        SELECT count(*)::int AS n FROM audit_events WHERE entity_id = ${paymentId}::uuid AND action = 'payment.reverse'`);
      expect(audit[0].n).toBe(1);
    });

    it('B2. two concurrent payments with the same bank reference record once', async () => {
      await leaveHarnessTransaction();
      const reference = `R2-SAME-${randomUUID().slice(0, 8)}`;
      const [a, b] = await Promise.all([
        recordPayment(owner.jar, { amountKobo: 150_000, reference }),
        recordPayment(owner.jar, { amountKobo: 150_000, reference }),
      ]);
      const created = [a, b].filter((r) => r.status === 201);
      const conflicts = [a, b].filter((r) => r.status === 409);
      expect(created.length).toBe(1);
      expect(conflicts.length).toBe(1);
      expect(conflicts[0]!.data?.error?.code).toBe('CONFLICT');

      const rows = await inTenant(owner, (sql) => sql`
        SELECT count(*)::int AS n FROM payments WHERE organization_id = ${owner.orgId}::uuid AND reference = ${reference}`);
      expect(rows[0]!.n).toBe(1);
    });

    it('B3. two concurrent receipt issues produce one document', async () => {
      await leaveHarnessTransaction();
      const student = await createStudent(owner.jar);
      const invoice = await createInvoice(owner.jar, student.id, 450_000);
      const pay = await recordPayment(owner.jar, {
        amountKobo: 450_000, allocations: [{ invoiceId: invoice.id, amountKobo: 450_000 }],
      });
      const paymentId = pay.data.payment.id;

      const [a, b] = await Promise.all([
        callRoute('POST', '/api/receipts', owner.jar, { paymentId }, { 'idempotency-key': key('rcp-a') }),
        callRoute('POST', '/api/receipts', owner.jar, { paymentId }, { 'idempotency-key': key('rcp-b') }),
      ]);
      expect([a, b].every((r) => [200, 201].includes(r.status))).toBe(true);

      const receipts = await inTenant(owner, (sql) => sql`
        SELECT id, amount_kobo, allocations_snapshot FROM receipts
         WHERE payment_id = ${paymentId}::uuid AND status = 'ISSUED'`);
      expect(receipts.length).toBe(1);
      expect(Number(receipts[0]!.amount_kobo)).toBe(450_000);
      // The snapshot exists and sums to the receipted amount.
      const lines = receipts[0]!.allocations_snapshot as Array<{ amountKobo: number }>;
      expect(Array.isArray(lines)).toBe(true);
      expect(lines.reduce((s, l) => s + Number(l.amountKobo), 0)).toBe(450_000);
      const audit = await inTenant(owner, (sql) => sql`
        SELECT count(*)::int AS n FROM audit_events WHERE entity_id = ${receipts[0]!.id}::uuid AND action = 'receipt.issue'`);
      expect(audit[0]!.n).toBe(1);
    });

    it('B4. two concurrent identical allocations allocate once', async () => {
      await leaveHarnessTransaction();
      const student = await createStudent(owner.jar);
      const invoice = await createInvoice(owner.jar, student.id, 250_000);
      const pay = await recordPayment(owner.jar, { amountKobo: 500_000 });
      const paymentId = pay.data.payment.id;
      const body = { allocations: [{ invoiceId: invoice.id, amountKobo: 250_000 }] };

      const [a, b] = await Promise.all([
        callRoute('POST', `/api/payments/${paymentId}/allocate`, owner.jar, body, { 'idempotency-key': key('alloc-a') }),
        callRoute('POST', `/api/payments/${paymentId}/allocate`, owner.jar, body, { 'idempotency-key': key('alloc-b') }),
      ]);
      const applied = [a, b].filter((r) => r.status === 200);
      expect(applied.length).toBe(1);
      // The loser is told what happened; it is never an internal error and
      // never a second allocation.
      expect([a, b].every((r) => [200, 400, 409].includes(r.status))).toBe(true);

      const allocs = await inTenant(owner, (sql) => sql`
        SELECT count(*)::int AS n FROM payment_allocations WHERE payment_id = ${paymentId}::uuid`);
      expect(allocs[0]!.n).toBe(1);
      const inv = await inTenant(owner, (sql) => sql`
        SELECT paid_kobo, total_kobo FROM invoices WHERE id = ${invoice.id}::uuid`);
      expect(Number(inv[0].paid_kobo)).toBe(250_000);
    });
  });

  // =========================================================================
  // C. Receipt snapshot: the document of record cannot drift
  // =========================================================================
  describe('C. receipt snapshot', () => {
    it('C1. the receipt renders from its own frozen allocation set', async () => {
      const student = await createStudent(owner.jar);
      const invoice = await createInvoice(owner.jar, student.id, 320_000);
      const pay = await recordPayment(owner.jar, {
        amountKobo: 320_000, allocations: [{ invoiceId: invoice.id, amountKobo: 320_000 }],
      });
      const issued = await callRoute('POST', '/api/receipts', owner.jar, { paymentId: pay.data.payment.id }, { 'idempotency-key': key('rcp') });
      expect(issued.status).toBe(201);

      const view = await callRoute('GET', `/api/receipts/${issued.data.receipt.id}`, owner.jar);
      expect(view.status).toBe(200);
      expect(view.data.linesSource).toBe('SNAPSHOT');
      const total = view.data.allocations.reduce((s: number, a: any) => s + Number(a.amountKobo), 0);
      expect(total).toBe(320_000);
      expect(total).toBe(Number(view.data.receipt.amountKobo));
    });

    it('C2. a receipt keeps showing what it receipted after the payment is reversed', async () => {
      const student = await createStudent(owner.jar);
      const invoice = await createInvoice(owner.jar, student.id, 700_000);
      const pay = await recordPayment(owner.jar, {
        amountKobo: 700_000, allocations: [{ invoiceId: invoice.id, amountKobo: 700_000 }],
      });
      const paymentId = pay.data.payment.id;
      const issued = await callRoute('POST', '/api/receipts', owner.jar, { paymentId }, { 'idempotency-key': key('rcp') });
      expect(issued.status).toBe(201);

      const rev = await callRoute('POST', `/api/payments/${paymentId}/reverse`, owner.jar, {
        type: 'REFUND', amountKobo: 700_000, reason: 'transfer recalled by the bank',
        reference: `RV-REFUND-${randomUUID().slice(0, 8)}`,
      }, { 'idempotency-key': key('rev') });
      expect(rev.status).toBe(201);

      // No ACTIVE allocations remain...
      const active = await inTenant(owner, (sql) => sql`
        SELECT count(*)::int AS n FROM payment_allocations WHERE payment_id = ${paymentId}::uuid AND status = 'ACTIVE'`);
      expect(active[0].n).toBe(0);

      // ...but the document of record still reports what was receipted.
      const view = await callRoute('GET', `/api/receipts/${issued.data.receipt.id}`, owner.jar);
      expect(view.status).toBe(200);
      expect(view.data.linesSource).toBe('SNAPSHOT');
      const total = view.data.allocations.reduce((s: number, a: any) => s + Number(a.amountKobo), 0);
      expect(total).toBe(Number(view.data.receipt.amountKobo));
      expect(total).toBe(700_000);
      const payRow = await inTenant(owner, (sql) => sql`
        SELECT status FROM payments WHERE id = ${paymentId}::uuid`);
      // REFUND is a distinct terminal state from REVERSAL (M5 semantics, left
      // exactly as they were); what matters here is the receipt, not the label.
      expect(payRow[0]!.status).toBe('REFUNDED');
    });

    it('C3. the snapshot is write-once even for direct SQL', async () => {
      const student = await createStudent(owner.jar);
      const invoice = await createInvoice(owner.jar, student.id, 120_000);
      const pay = await recordPayment(owner.jar, {
        amountKobo: 120_000, allocations: [{ invoiceId: invoice.id, amountKobo: 120_000 }],
      });
      const issued = await callRoute('POST', '/api/receipts', owner.jar, { paymentId: pay.data.payment.id }, { 'idempotency-key': key('rcp') });
      const receiptId = issued.data.receipt.id;

      const outcome = await inTenant(owner, async (sql) => {
        await sql.unsafe('SAVEPOINT r2_snapshot_probe');
        try {
          await sql`UPDATE receipts SET allocations_snapshot = '[]'::jsonb WHERE id = ${receiptId}::uuid`;
          return 'updated';
        } catch (e: any) {
          await sql.unsafe('ROLLBACK TO SAVEPOINT r2_snapshot_probe');
          return e.code as string;
        } finally {
          await sql.unsafe('RELEASE SAVEPOINT r2_snapshot_probe').catch(() => {});
        }
      });
      expect(outcome).toBe('23514');
      const lines = await inTenant(owner, (sql) => sql`
        SELECT allocations_snapshot FROM receipts WHERE id = ${receiptId}::uuid`);
      expect(((lines[0]!.allocations_snapshot as unknown[]) ?? []).length).toBe(1);
    });
  });

  // =========================================================================
  // D. Database-level enforcement (bypassing the application entirely)
  // =========================================================================
  describe('D. the database refuses what the application refuses', () => {
    it('D1. two connections following the pre-R2 reversal sequence get one reversal', async () => {
      const { fx, paymentId, invoiceId } = await seedCommittedFinancials();
      const reference = `R2-RACE-${randomUUID().slice(0, 8)}`;
      const a = await openTenantConnection(fx.orgId, fx.userId);
      const b = await openTenantConnection(fx.orgId, fx.userId);
      openConnections.push(a, b);

      await a.unsafe('BEGIN');
      const seenA = await a`SELECT id FROM reversals WHERE payment_id = ${paymentId}::uuid AND reference = ${reference}`;
      await a`INSERT INTO reversals (organization_id, payment_id, type, amount_kobo, reason, reference)
              VALUES (${fx.orgId}::uuid, ${paymentId}::uuid, 'REVERSAL', 500000, 'race A', ${reference})`;

      const bOutcome = (async () => {
        await b.unsafe('BEGIN');
        const seenB = await b`SELECT id FROM reversals WHERE payment_id = ${paymentId}::uuid AND reference = ${reference}`;
        try {
          await b`INSERT INTO reversals (organization_id, payment_id, type, amount_kobo, reason, reference)
                  VALUES (${fx.orgId}::uuid, ${paymentId}::uuid, 'REVERSAL', 500000, 'race B', ${reference})`;
          await b.unsafe('COMMIT');
          return { code: 'inserted', seen: seenB.length };
        } catch (e: any) {
          await b.unsafe('ROLLBACK').catch(() => {});
          return { code: e.code as string, seen: seenB.length };
        }
      })();

      await sleep(1200);
      await a.unsafe('COMMIT');
      const loser = await bOutcome;

      // Both connections passed the application-style guard (this is exactly
      // what happened before R2), and the database still refused the second.
      expect(seenA.length).toBe(0);
      expect(loser.seen).toBe(0);
      expect(loser.code).toBe('23505');

      const rows = await a`SELECT count(*)::int AS n FROM reversals WHERE payment_id = ${paymentId}::uuid`;
      expect(rows[0]!.n).toBe(1);
      const inv = await a`SELECT paid_kobo, status FROM invoices WHERE id = ${invoiceId}::uuid`;
      expect(Number(inv[0]!.paid_kobo)).toBe(500_000);
      expect(inv[0]!.status).toBe('PARTIALLY_PAID');
    });

    it('D2. one live payment per organization and reference, but retries after failure are allowed', async () => {
      const { fx } = await seedCommittedFinancials();
      const reference = `R2-LIVE-${randomUUID().slice(0, 8)}`;
      const sql = await openTenantConnection(fx.orgId, fx.userId);
      openConnections.push(sql);

      const insertPayment = (status: string) =>
        sql`INSERT INTO payments (organization_id, method, status, amount_kobo, unallocated_kobo, reference, paid_at)
            VALUES (${fx.orgId}::uuid, 'OTHER', ${status}, 5000, 5000, ${reference}, ${status === 'CONFIRMED' ? sql`now()` : null})`;

      await insertPayment('CONFIRMED');
      const duplicate = await insertPayment('CONFIRMED').then(
        () => 'inserted',
        (e: any) => e.code as string,
      );
      expect(duplicate).toBe('23505');

      // A superseded attempt does not block a legitimate retry of the same
      // teller reference (the rule the application intended all along).
      await insertPayment('FAILED');
      const retry = await insertPayment('FAILED').then(
        () => 'inserted',
        (e: any) => e.code as string,
      );
      expect(retry).toBe('inserted');

      const live = await sql`SELECT count(*)::int AS n FROM payments
                              WHERE organization_id = ${fx.orgId}::uuid AND reference = ${reference}
                                AND status NOT IN ('FAILED','REJECTED')`;
      expect(live[0]!.n).toBe(1);
    });

    it('D3. the reference guard is per organization, not global', async () => {
      const first = await seedCommittedFinancials();
      const second = await seedCommittedFinancials();
      const reference = `R2-SHARED-${randomUUID().slice(0, 8)}`;
      const a = await openTenantConnection(first.fx.orgId, first.fx.userId);
      const b = await openTenantConnection(second.fx.orgId, second.fx.userId);
      openConnections.push(a, b);
      await a`INSERT INTO payments (organization_id, method, status, amount_kobo, unallocated_kobo, reference, paid_at)
              VALUES (${first.fx.orgId}::uuid, 'BANK_TRANSFER', 'CONFIRMED', 7000, 7000, ${reference}, now())`;
      const other = await b`INSERT INTO payments (organization_id, method, status, amount_kobo, unallocated_kobo, reference, paid_at)
                            VALUES (${second.fx.orgId}::uuid, 'BANK_TRANSFER', 'CONFIRMED', 7000, 7000, ${reference}, now())
                            RETURNING id`.then(
        () => 'inserted',
        (e: any) => e.code as string,
      );
      expect(other).toBe('inserted');
    });
  });

  // =========================================================================
  // E. Void transactionality and audit coupling (M-2)
  // =========================================================================
  describe('E. invoice void', () => {
    it('E1. a refused void leaves no audit row and no state change', async () => {
      const student = await createStudent(owner.jar);
      const invoice = await createInvoice(owner.jar, student.id, 900_000);
      const pay = await recordPayment(owner.jar, {
        amountKobo: 900_000, allocations: [{ invoiceId: invoice.id, amountKobo: 900_000 }],
      });
      expect(pay.status).toBe(201);

      const refused = await callRoute('POST', `/api/invoices/${invoice.id}/void`, owner.jar, {
        reason: 'stale idea',
      }, { 'idempotency-key': key('void') });
      expect(refused.status).toBe(409);
      const audit = await inTenant(owner, (sql) => sql`
        SELECT count(*)::int AS n FROM audit_events WHERE entity_id = ${invoice.id}::uuid AND action = 'invoice.void'`);
      expect(audit[0].n).toBe(0);
      const inv = await inTenant(owner, (sql) => sql`
        SELECT status FROM invoices WHERE id = ${invoice.id}::uuid`);
      expect(inv[0].status).toBe('PAID');
    });

    it('E2. the sanctioned path (reverse, then void) leaves one audit row and one void', async () => {
      const student = await createStudent(owner.jar);
      const invoice = await createInvoice(owner.jar, student.id, 800_000);
      const pay = await recordPayment(owner.jar, {
        amountKobo: 800_000, allocations: [{ invoiceId: invoice.id, amountKobo: 800_000 }],
      });
      const paymentId = pay.data.payment.id;
      const rev = await callRoute('POST', `/api/payments/${paymentId}/reverse`, owner.jar, {
        type: 'REVERSAL', amountKobo: 800_000, reason: 'recorded against the wrong invoice',
        reference: `RV-${randomUUID().slice(0, 8)}`,
      }, { 'idempotency-key': key('rev') });
      expect(rev.status).toBe(201);

      const voided = await callRoute('POST', `/api/invoices/${invoice.id}/void`, owner.jar, {
        reason: 'duplicate invoice',
      }, { 'idempotency-key': key('void') });
      expect(voided.status).toBe(200);
      expect(voided.data.invoice.status).toBe('VOID');

      const audit = await inTenant(owner, (sql) => sql`
        SELECT count(*)::int AS n FROM audit_events WHERE entity_id = ${invoice.id}::uuid AND action = 'invoice.void'`);
      expect(audit[0].n).toBe(1);
    });

    it('E3. every VOID invoice has exactly one audit row (no orphan evidence, no silent void)', async () => {
      // One invoice that may legitimately be voided, one that may not.
      const refundable = await createInvoice(owner.jar, (await createStudent(owner.jar)).id, 110_000);
      const blocked = await createInvoice(owner.jar, (await createStudent(owner.jar)).id, 130_000);
      const pay = await recordPayment(owner.jar, {
        amountKobo: 130_000, allocations: [{ invoiceId: blocked.id, amountKobo: 130_000 }],
      });
      expect(pay.status).toBe(201);

      const okVoid = await callRoute('POST', `/api/invoices/${refundable.id}/void`, owner.jar, { reason: 'cancelled' }, { 'idempotency-key': key('void') });
      expect(okVoid.status).toBe(200);
      const refused = await callRoute('POST', `/api/invoices/${blocked.id}/void`, owner.jar, { reason: 'paid' }, { 'idempotency-key': key('void') });
      expect(refused.status).toBe(409);

      const voids = await inTenant(owner, (sql) => sql`
        SELECT i.id,
               (SELECT count(*)::int FROM audit_events a WHERE a.entity_id = i.id AND a.action = 'invoice.void') AS audits
          FROM invoices i
         WHERE i.organization_id = ${owner.orgId}::uuid AND i.status = 'VOID'`);
      expect(voids.length).toBe(1);
      expect(voids[0]!.id).toBe(refundable.id);
      expect(Number(voids[0]!.audits)).toBe(1);
      const blockedAudits = await inTenant(owner, (sql) => sql`
        SELECT count(*)::int AS n FROM audit_events WHERE entity_id = ${blocked.id}::uuid AND action = 'invoice.void'`);
      expect(blockedAudits[0]!.n).toBe(0);
    });
  });

  // =========================================================================
  // F. Financial non-interference: the numbers still tie out
  // =========================================================================
  it('F1. a full lifecycle ties out exactly, and the remediation changed no amount', async () => {
    const student = await createStudent(owner.jar);
    const invoice = await createInvoice(owner.jar, student.id, 1_000_000);

    // Partial payment 400,000, receipted.
    const first = await recordPayment(owner.jar, {
      amountKobo: 400_000, allocations: [{ invoiceId: invoice.id, amountKobo: 400_000 }],
    });
    expect(first.status).toBe(201);
    const receipt = await callRoute('POST', '/api/receipts', owner.jar, { paymentId: first.data.payment.id }, { 'idempotency-key': key('rcp') });
    expect(receipt.status).toBe(201);
    expect(receipt.data.receipt.amountKobo).toBe(400_000);

    // Second payment 600,000 completes the invoice.
    const second = await recordPayment(owner.jar, {
      amountKobo: 600_000, allocations: [{ invoiceId: invoice.id, amountKobo: 600_000 }],
    });
    const secondId = second.data.payment.id;

    let inv = await inTenant(owner, (sql) => sql`
      SELECT total_kobo, paid_kobo, status FROM invoices WHERE id = ${invoice.id}::uuid`);
    expect(Number(inv[0].total_kobo)).toBe(1_000_000);
    expect(Number(inv[0].paid_kobo)).toBe(1_000_000);
    expect(inv[0].status).toBe('PAID');

    // The second payment is reversed in full.
    const rev = await callRoute('POST', `/api/payments/${secondId}/reverse`, owner.jar, {
      type: 'REVERSAL', amountKobo: 600_000, reason: 'teller error, funds returned',
      reference: `RV-${randomUUID().slice(0, 8)}`,
    }, { 'idempotency-key': key('rev') });
    expect(rev.status).toBe(201);

    inv = await inTenant(owner, (sql) => sql`
      SELECT paid_kobo, status FROM invoices WHERE id = ${invoice.id}::uuid`);
    expect(Number(inv[0].paid_kobo)).toBe(400_000);
    expect(inv[0].status).toBe('PARTIALLY_PAID');

    const allocations = await inTenant(owner, (sql) => sql`
      SELECT status, amount_kobo FROM payment_allocations
       WHERE organization_id = ${owner.orgId}::uuid AND invoice_id = ${invoice.id}::uuid
       ORDER BY amount_kobo`);
    expect(allocations.map((a: any) => [a.status, Number(a.amount_kobo)])).toEqual([
      ['ACTIVE', 400_000],
      ['REVERSED', 600_000],
    ]);

    const payments = await inTenant(owner, (sql) => sql`
      SELECT id, status, amount_kobo, unallocated_kobo FROM payments
       WHERE organization_id = ${owner.orgId}::uuid AND id IN (${first.data.payment.id}::uuid, ${secondId}::uuid)
       ORDER BY amount_kobo`);
    expect(payments.map((p: any) => [Number(p.amount_kobo), p.status, Number(p.unallocated_kobo)])).toEqual([
      [400_000, 'CONFIRMED', 0],
      [600_000, 'REVERSED', 600_000],
    ]);

    // The receipted document is unchanged by the reversal, and the ledger says
    // the same thing the receipt does for the payment it covers.
    const view = await callRoute('GET', `/api/receipts/${receipt.data.receipt.id}`, owner.jar);
    expect(view.data.linesSource).toBe('SNAPSHOT');
    expect(view.data.allocations.reduce((s: number, a: any) => s + Number(a.amountKobo), 0)).toBe(400_000);
  });
});
