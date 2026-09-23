/**
 * M6 endpoint hardening tests.
 *
 * Exercises the new M6 API surface (invoices issue/void, payment-links,
 * receipts, students update/archive/restore, public /p/[token], dashboard
 * KPI term scoping) through real route handlers using the in-process
 * cookie-jar harness from tests/auth/support — no dev-bypass headers, no
 * stubbed auth.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { call, CookieJar } from '../auth/support';
import { POST as registerPost } from '@/app/api/auth/register/route';
import { GET as meGet } from '@/app/api/auth/me/route';
import { getSql, closeDb } from '@/lib/db';
import { organizationMembers } from '@/lib/db/schema';
import { withSystemContext, withTenant } from '@/lib/db/tenant';

function uniqueEmail(prefix = 'u'): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}@example.com`;
}
function uniqueSlug(p = 's'): string {
  return `${p}-${Math.random().toString(36).slice(2, 10)}`.toLowerCase().replace(/_/g, '-');
}
function uniquePassword(): string {
  return 'Pass-' + Math.random().toString(36).slice(2, 10) + '-A1!';
}
function uid(): string { return randomUUID(); }

type Actor = {
  jar: InstanceType<typeof CookieJar>; userId: string; orgId: string;
  memberId: string; role: string; email: string; password: string;
};

async function registerOwner(opts: { email?: string; slug?: string; firstName?: string } = {}): Promise<Actor> {
  const email = opts.email ?? uniqueEmail('own');
  const password = uniquePassword();
  const slug = opts.slug ?? uniqueSlug('o');
  const jar = new CookieJar();
  const reg = await call(registerPost, jar, {
    method: 'POST', path: '/api/auth/register',
    body: { email, password, firstName: opts.firstName ?? 'Owner', lastName: 'Person',
            organizationName: 'School of ' + slug, organizationSlug: slug },
  });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.data)}`);
  const me = await call(meGet, jar, { method: 'GET', path: '/api/auth/me' });
  const member = (me.data.memberships as any[]).find((m) => m.organizationId === me.data.activeOrganizationId);
  return { jar, email, password, orgId: me.data.activeOrganizationId, userId: me.data.user.id,
           memberId: member.id, role: me.data.activeRole };
}

async function addMember(owner: Actor, role: 'SCHOOL_ADMIN' | 'FINANCE_OFFICER' | 'STAFF', label: string): Promise<Actor> {
  const email = uniqueEmail(label); const password = uniquePassword();
  const jar = new CookieJar();
  const reg = await call(registerPost, jar, {
    method: 'POST', path: '/api/auth/register',
    body: { email, password, firstName: label, lastName: 'User',
            organizationName: label + ' solo', organizationSlug: uniqueSlug(label) },
  });
  if (reg.status !== 201) throw new Error(`register ${label} failed: ${reg.status}`);
  const me = await call(meGet, jar, { method: 'GET', path: '/api/auth/me' });
  const userId = me.data.user.id;
  await withSystemContext(null, null, async (sdb) => {
    await sdb.insert(organizationMembers).values({
      id: uid(), organizationId: owner.orgId, userId, role, status: 'ACTIVE',
      joinedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    } as any);
  });
  const sel = await callRoute('POST', '/api/auth/select-organization', jar, { organizationId: owner.orgId });
  if (sel.status !== 200) throw new Error(`select org ${label} failed: ${sel.status}`);
  const after = await call(meGet, jar, { method: 'GET', path: '/api/auth/me' });
  const member = (after.data.memberships as any[]).find((m) => m.organizationId === owner.orgId);
  return { jar, email, password, userId, orgId: owner.orgId, memberId: member.id, role };
}

/** Dynamic-route-aware dispatcher. */
async function callRoute(method: string, path: string, jar: InstanceType<typeof CookieJar>, body?: unknown, extraHeaders?: Record<string, string>) {
  const segs = path.split('/').filter(Boolean);
  function load(modPath: string, params?: Record<string, string>) {
    return import(/* @vite-ignore */ `@/${modPath}`).then((mod: any) => {
      const exports = mod?.default ?? mod;
      const handler: Function = exports[method];
      if (typeof handler !== 'function') throw new Error(`no ${method} handler in ${modPath}`);
      return { handler, params };
    });
  }
  async function match(): Promise<{handler: Function; params?: Record<string,string>}> {
    const s0 = segs[0]!, s1 = segs[1]!, s2 = segs[2]!, s3 = segs[3]!;
    if (s0 === 'api' && s1 === 'p' && segs.length >= 4)
      return load(`app/api/p/[token]/${s3}/route`, { token: s2 });
    if (s0 === 'api' && s1 === 'receipts' && segs.length === 3)
      return load(`app/api/receipts/[id]/route`, { id: s2 });
    if (s0 === 'api' && s1 === 'invoices' && segs.length === 4)
      return load(`app/api/invoices/[id]/${s3}/route`, { id: s2 });
    if (s0 === 'api' && s1 === 'invoices' && segs.length === 3)
      return load(`app/api/invoices/[id]/route`, { id: s2 });
    if (s0 === 'api' && s1 === 'payments' && segs.length === 4)
      return load(`app/api/payments/[id]/${s3}/route`, { id: s2 });
    if (s0 === 'api' && s1 === 'payments' && segs.length === 3)
      return load(`app/api/payments/[id]/route`, { id: s2 });
    if (s0 === 'api' && s1 === 'payment-links' && segs.length === 3)
      return load(`app/api/payment-links/[token]/route`, { token: s2 });
    if (s0 === 'api' && s1 === 'students' && segs.length === 4)
      return load(`app/api/students/[id]/${s3}/route`, { id: s2 });
    if (s0 === 'api' && s1 === 'students' && segs.length === 3)
      return load(`app/api/students/[id]/route`, { id: s2 });
    return load('app/' + segs.join('/') + '/route');
  }
  const { handler, params } = await match();
  const headersInit: Record<string,string> = { 'content-type': 'application/json', ...(extraHeaders ?? {}) };
  const init: any = { method, path, body, csrf: !['GET','HEAD','OPTIONS'].includes(method), headers: headersInit };
  const wrapped = async (req: Request) =>
    params ? handler(req, { params: Promise.resolve(params) }) : handler(req);
  return call(wrapped as any, jar, init);
}

// ---------- Domain helpers ----------
// student.create requires SCHOOL_ADMIN or OWNER (per permissions matrix).
async function createStudent(jar: InstanceType<typeof CookieJar>, opts: { firstName?: string; lastName?: string; studentId?: string; gender?: string } = {}) {
  const sid = opts.studentId ?? 'S-' + Math.random().toString(36).slice(2,8).toUpperCase();
  const r = await callRoute('POST', '/api/students', jar, {
    studentId: sid,
    firstName: opts.firstName ?? 'Ade',
    lastName: opts.lastName ?? 'Tester',
    gender: opts.gender ?? 'M',
  });
  if (r.status !== 201) throw new Error(`create student failed: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.student as { id: string; studentId: string };
}

async function createInvoice(jar: InstanceType<typeof CookieJar>, studentId: string, totalKobo = 5000000) {
  const idem = 'inv-' + Math.random().toString(36).slice(2, 12);
  const r = await callRoute('POST', '/api/invoices', jar, {
    studentId,
    dueDate: new Date(Date.now() + 30*86400_000).toISOString().slice(0,10),
    lines: [{ description: 'Tuition', quantity: 1, unitRateKobo: totalKobo }],
  }, { 'idempotency-key': idem });
  if (r.status !== 201) throw new Error(`create invoice failed: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.invoice as { id: string; invoiceNumber: string; totalKobo: number; paidKobo: number };
}

async function recordConfirmedPayment(jar: InstanceType<typeof CookieJar>, opts: { amountKobo: number; reference?: string; allocations?: Array<{invoiceId: string; amountKobo: number}>; payerName?: string }) {
  const idem = 'pay-' + Math.random().toString(36).slice(2, 12);
  const r = await callRoute('POST', '/api/payments', jar, {
    method: 'BANK_TRANSFER',
    amountKobo: opts.amountKobo,
    reference: opts.reference ?? ('REF-' + Math.random().toString(36).slice(2,8)),
    payerName: opts.payerName ?? 'Parent Payer',
    initialStatus: 'CONFIRMED',
    allocations: opts.allocations ?? [],
  }, { 'idempotency-key': idem });
  if (r.status !== 201) throw new Error(`record payment failed: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.payment as { id: string; paymentNumber: string; amountKobo: number; unallocatedKobo: number; status: string };
}

async function createPaymentLink(jar: InstanceType<typeof CookieJar>, opts: { invoiceId?: string; studentId?: string; amountKobo?: number }) {
  const r = await callRoute('POST', '/api/payment-links', jar, {
    invoiceId: opts.invoiceId, studentId: opts.studentId,
    amountKobo: opts.amountKobo, note: 'Test link',
  });
  if (r.status !== 201) throw new Error(`create link failed: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.link as { id: string; token: string; url: string };
}

describe('M6 — endpoint hardening', () => {
  let owner: Actor;
  let admin: Actor;
  let finance: Actor;
  let staff: Actor;
  let foreign: Actor;

  beforeAll(async () => {
    const sql = getSql();
    await sql`SELECT auth_clear_rate_limits()`.catch(() => {});
    owner = await registerOwner({ firstName: 'Owner' });
    admin = await addMember(owner, 'SCHOOL_ADMIN', 'adm');
    finance = await addMember(owner, 'FINANCE_OFFICER', 'fin');
    staff = await addMember(owner, 'STAFF', 'stf');
    foreign = await registerOwner({ firstName: 'Foreign' });
    for (const actor of [owner, foreign]) {
      const s = await callRoute('POST', '/api/setup/seed-current-term', actor.jar, {});
      if (s.status !== 200) throw new Error(`seed term failed for ${actor.email}: ${s.status} ${JSON.stringify(s.data)}`);
    }
  }, 60000);

  afterAll(async () => { await closeDb(); });

  // =========================================================================
  // INVOICE ISSUE / VOID
  // =========================================================================
  describe('invoices (issue / void)', () => {
    it('FINANCE_OFFICER can create+issue an invoice', async () => {
      const stu = await createStudent(admin.jar, { studentId: 'INV-STU-' + Math.random().toString(36).slice(2,6) });
      const inv = await createInvoice(finance.jar, stu.id, 1000000);
      expect(inv.totalKobo).toBe(1000000);
      expect(inv.paidKobo).toBe(0);
    });

    it('FINANCE_OFFICER can void an unpaid invoice; replay is idempotent', async () => {
      const stu = await createStudent(admin.jar, { studentId: 'VOID-STU-' + Math.random().toString(36).slice(2,6) });
      const inv = await createInvoice(finance.jar, stu.id, 2000000);
      const key = 'void-' + Math.random().toString(36).slice(2, 10);
      const v1 = await callRoute('POST', `/api/invoices/${inv.id}/void`, finance.jar, { reason: 'Issued in error' }, { 'idempotency-key': key });
      expect(v1.status).toBe(200);
      // Same key replays the original response without re-deciding (R2).
      const v2 = await callRoute('POST', `/api/invoices/${inv.id}/void`, finance.jar, { reason: 'Replay' }, { 'idempotency-key': key });
      expect([200, 409]).toContain(v2.status);
      // A different key still resolves to the already-VOID invoice.
      const v3 = await callRoute('POST', `/api/invoices/${inv.id}/void`, finance.jar, { reason: 'Second attempt' }, { 'idempotency-key': 'void-' + Math.random().toString(36).slice(2, 10) });
      expect(v3.status).toBe(200);
      expect(v3.data.invoice.status).toBe('VOID');
    });

    it('void is rejected when invoice has paid amount', async () => {
      const stu = await createStudent(admin.jar, { studentId: 'PAID-STU-' + Math.random().toString(36).slice(2,6) });
      const inv = await createInvoice(finance.jar, stu.id, 3000000);
      await recordConfirmedPayment(finance.jar, { amountKobo: 3000000, allocations: [{ invoiceId: inv.id, amountKobo: 3000000 }] });
      const v = await callRoute('POST', `/api/invoices/${inv.id}/void`, finance.jar, { reason: 'nope' }, { 'idempotency-key': 'void-' + Math.random().toString(36).slice(2, 10) });
      expect(v.status).toBe(409);
    });

    it('STAFF cannot void invoices (wrong role)', async () => {
      const stu = await createStudent(admin.jar, { studentId: 'WR-STU-' + Math.random().toString(36).slice(2,6) });
      const inv = await createInvoice(finance.jar, stu.id, 500000);
      const r = await callRoute('POST', `/api/invoices/${inv.id}/void`, staff.jar, { reason: 'x' }, { 'idempotency-key': 'void-' + Math.random().toString(36).slice(2, 10) });
      expect(r.status).toBe(403);
    });

    it('foreign org cannot void our invoice (cross-tenant)', async () => {
      const stu = await createStudent(admin.jar, { studentId: 'XT-STU-' + Math.random().toString(36).slice(2,6) });
      const inv = await createInvoice(finance.jar, stu.id, 500000);
      const r = await callRoute('POST', `/api/invoices/${inv.id}/void`, foreign.jar, { reason: 'x' }, { 'idempotency-key': 'void-' + Math.random().toString(36).slice(2, 10) });
      expect([403, 404]).toContain(r.status);
    });

    it('invoice create is idempotent (same key replays original)', async () => {
      const stu = await createStudent(admin.jar, { studentId: 'IDEM-' + Math.random().toString(36).slice(2,6) });
      const idemKey = 'inv-idem-' + Math.random().toString(36).slice(2,10);
      const body = { studentId: stu.id, lines: [{ description: 'Books', quantity: 1, unitRateKobo: 750000 }] };
      const r1 = await callRoute('POST', '/api/invoices', finance.jar, body, { 'idempotency-key': idemKey });
      const r2 = await callRoute('POST', '/api/invoices', finance.jar, body, { 'idempotency-key': idemKey });
      expect(r1.status).toBe(201);
      // Replay returns 200 (per repo idempotent replay).
      expect([200, 201]).toContain(r2.status);
      expect(r2.data.invoice.id).toBe(r1.data.invoice.id);
    });
  });

  // =========================================================================
  // PAYMENT LINKS
  // =========================================================================
  describe('payment-links', () => {
    it('FINANCE_OFFICER can create a link and list it', async () => {
      const stu = await createStudent(admin.jar, { studentId: 'PL-STU-' + Math.random().toString(36).slice(2,6) });
      const inv = await createInvoice(finance.jar, stu.id, 1000000);
      const link = await createPaymentLink(finance.jar, { invoiceId: inv.id });
      expect(link.token).toMatch(/^[A-Za-z0-9_-]{16,}$/);
      expect(link.url).toBe(`/p/${link.token}`);
      const list = await callRoute('GET', '/api/payment-links', finance.jar);
      expect(list.status).toBe(200);
      const found = (list.data.links as any[]).find(l => l.token === link.token);
      expect(found).toBeTruthy();
      expect(found.status).toBe('ACTIVE');
    });

    it('STAFF cannot create links', async () => {
      const stu = await createStudent(admin.jar, { studentId: 'PL-S-' + Math.random().toString(36).slice(2,6) });
      const inv = await createInvoice(finance.jar, stu.id, 500000);
      const r = await callRoute('POST', '/api/payment-links', staff.jar, { invoiceId: inv.id });
      expect(r.status).toBe(403);
    });

    it('foreign org cannot list our links or create a link against our invoice', async () => {
      const stu = await createStudent(admin.jar, { studentId: 'PL-X-' + Math.random().toString(36).slice(2,6) });
      const inv = await createInvoice(finance.jar, stu.id, 500000);
      const l = await callRoute('GET', '/api/payment-links', foreign.jar);
      expect(l.status).toBe(200);
      expect((l.data.links as any[])).toHaveLength(0);
      const c = await callRoute('POST', '/api/payment-links', foreign.jar, { invoiceId: inv.id });
      expect([400, 403, 404]).toContain(c.status);
    });

    it('revoke idempotent: ACTIVE→REVOKED on first call; second call no-ops', async () => {
      const stu = await createStudent(admin.jar, { studentId: 'PL-R-' + Math.random().toString(36).slice(2,6) });
      const inv = await createInvoice(finance.jar, stu.id, 500000);
      const link = await createPaymentLink(finance.jar, { invoiceId: inv.id });
      const r1 = await callRoute('PATCH', `/api/payment-links/${link.token}`, finance.jar, { status: 'REVOKED' });
      expect(r1.status).toBe(200);
      const r2 = await callRoute('PATCH', `/api/payment-links/${link.token}`, finance.jar, { status: 'REVOKED' });
      expect(r2.status).toBe(200);
      const v = await callPublicView(link.token);
      expect(v.status).toBe(404);
    });

    it('expired link returns 410 from public view', async () => {
      // Create a link with expires_at in the past via direct insert (the
      // POST helper doesn't accept negative expiresInDays because the schema
      // requires ≥1; direct SQL simulates a naturally-expired link).
      const stu = await createStudent(admin.jar, { studentId: 'PL-E-' + Math.random().toString(36).slice(2,6) });
      const inv = await createInvoice(finance.jar, stu.id, 500000);
      const sql = getSql();
      const token = 'exp-' + Math.random().toString(36).slice(2, 20);
      await sql`select set_tenant_context(${finance.orgId}::uuid, ${finance.userId}::uuid)`;
      await sql`
        insert into payment_links (organization_id, token, status, invoice_id, amount_kobo, expires_at, note, created_at, updated_at)
        values (${finance.orgId}::uuid, ${token}, 'ACTIVE', ${inv.id}::uuid, 500000::bigint,
                now() - interval '30 days', 'expired test link', now(), now())`;
      await sql`select clear_app_context()`.catch(()=>{});
      const v = await callPublicView(token);
      expect(v.status).toBe(410);
    });

    it('invalid token returns 404 (no information disclosure)', async () => {
      const v = await callPublicView('does-not-exist-00000000');
      expect(v.status).toBe(404);
    });
  });

  // =========================================================================
  // RECEIPTS
  // =========================================================================
  describe('receipts', () => {
    it('FINANCE_OFFICER can issue a receipt for a CONFIRMED payment with ACTIVE allocation; issue is idempotent', async () => {
      const stu = await createStudent(admin.jar, { studentId: 'RCP-1-' + Math.random().toString(36).slice(2,6) });
      const inv = await createInvoice(finance.jar, stu.id, 2500000);
      const pay = await recordConfirmedPayment(finance.jar, { amountKobo: 2500000, allocations: [{ invoiceId: inv.id, amountKobo: 2500000 }] });
      const key = 'rcp-' + Math.random().toString(36).slice(2, 10);
      const r1 = await callRoute('POST', '/api/receipts', finance.jar, { paymentId: pay.id }, { 'idempotency-key': key });
      expect(r1.status).toBe(201);
      expect(r1.data.receipt.receiptNumber).toMatch(/^RCP-/);
      expect(r1.data.receipt.amountKobo).toBe(2500000);
      // Same key: the stored response is replayed verbatim (R2 requires the key).
      const r2 = await callRoute('POST', '/api/receipts', finance.jar, { paymentId: pay.id }, { 'idempotency-key': key });
      expect(r2.status).toBe(201);
      expect(r2.data.receipt.id).toBe(r1.data.receipt.id);
      expect(r2.response.headers.get('idempotent-replayed')).toBe('true');
      // A different key still resolves to the one ISSUED receipt (state idempotency).
      const r3 = await callRoute('POST', '/api/receipts', finance.jar, { paymentId: pay.id }, { 'idempotency-key': 'rcp-' + Math.random().toString(36).slice(2, 10) });
      expect(r3.status).toBe(200);
      expect(r3.data.receipt.id).toBe(r1.data.receipt.id);
      const g = await callRoute('GET', `/api/receipts/${r1.data.receipt.id}`, finance.jar);
      expect(g.status).toBe(200);
      expect(g.data.receipt.receiptNumber).toMatch(/^RCP-/);
      expect(g.data.payment.paymentNumber).toBe(pay.paymentNumber);
    });

    it('receipt rejected for PENDING payment', async () => {
      const stu = await createStudent(admin.jar, { studentId: 'RCP-P-' + Math.random().toString(36).slice(2,6) });
      await createInvoice(finance.jar, stu.id, 1000000);
      const idem = 'pen-' + Math.random().toString(36).slice(2,10);
      const pr = await callRoute('POST', '/api/payments', finance.jar, {
        method: 'BANK_TRANSFER', amountKobo: 1000000, reference: 'PEN-'+Math.random().toString(36).slice(2,6),
        payerName: 'P', initialStatus: 'PENDING', allocations: [],
      }, { 'idempotency-key': idem });
      expect(pr.status).toBe(201);
      const r = await callRoute('POST', '/api/receipts', finance.jar, { paymentId: pr.data.payment.id }, { 'idempotency-key': 'rcp-' + Math.random().toString(36).slice(2, 10) });
      expect([400, 409]).toContain(r.status);
    });

    it('receipt rejected for CONFIRMED payment with NO ACTIVE allocations', async () => {
      const pay = await recordConfirmedPayment(finance.jar, { amountKobo: 1000000, allocations: [] });
      const r = await callRoute('POST', '/api/receipts', finance.jar, { paymentId: pay.id }, { 'idempotency-key': 'rcp-' + Math.random().toString(36).slice(2, 10) });
      expect(r.status).toBe(400);
    });

    it('STAFF cannot issue receipts', async () => {
      const stu = await createStudent(admin.jar, { studentId: 'RCP-S-' + Math.random().toString(36).slice(2,6) });
      const inv = await createInvoice(finance.jar, stu.id, 500000);
      const pay = await recordConfirmedPayment(finance.jar, { amountKobo: 500000, allocations: [{ invoiceId: inv.id, amountKobo: 500000 }] });
      const r = await callRoute('POST', '/api/receipts', staff.jar, { paymentId: pay.id }, { 'idempotency-key': 'rcp-' + Math.random().toString(36).slice(2, 10) });
      expect(r.status).toBe(403);
    });

    it('foreign org cannot fetch our receipt (tenant isolation)', async () => {
      const stu = await createStudent(admin.jar, { studentId: 'RCP-X-' + Math.random().toString(36).slice(2,6) });
      const inv = await createInvoice(finance.jar, stu.id, 500000);
      const pay = await recordConfirmedPayment(finance.jar, { amountKobo: 500000, allocations: [{ invoiceId: inv.id, amountKobo: 500000 }] });
      const rc = await callRoute('POST', '/api/receipts', finance.jar, { paymentId: pay.id }, { 'idempotency-key': 'rcp-' + Math.random().toString(36).slice(2, 10) });
      const r = await callRoute('GET', `/api/receipts/${rc.data.receipt.id}`, foreign.jar);
      expect([403, 404]).toContain(r.status);
    });

    it('receipt amount reflects only allocated kobo when payment partially allocated', async () => {
      const stu = await createStudent(admin.jar, { studentId: 'RCP-U-' + Math.random().toString(36).slice(2,6) });
      const inv = await createInvoice(finance.jar, stu.id, 1500000);
      const pay = await recordConfirmedPayment(finance.jar, { amountKobo: 3000000, allocations: [{ invoiceId: inv.id, amountKobo: 1500000 }] });
      const r = await callRoute('POST', '/api/receipts', finance.jar, { paymentId: pay.id }, { 'idempotency-key': 'rcp-' + Math.random().toString(36).slice(2, 10) });
      expect(r.status).toBe(201);
      expect(r.data.receipt.amountKobo).toBe(1500000);
      expect(Number(pay.unallocatedKobo)).toBeGreaterThanOrEqual(1500000);
    });
  });

  // =========================================================================
  // STUDENTS update / archive / restore
  // =========================================================================
  describe('students (update / archive / restore)', () => {
    // Per permissions matrix, these require OWNER or SCHOOL_ADMIN;
    // FINANCE_OFFICER has only student.read.
    it('SCHOOL_ADMIN can update a student', async () => {
      const stu = await createStudent(admin.jar, { studentId: 'STU-U-' + Math.random().toString(36).slice(2,6), firstName: 'Before' });
      const r = await callRoute('PATCH', `/api/students/${stu.id}`, admin.jar, { firstName: 'After' });
      expect(r.status).toBe(200);
      expect(r.data.student.firstName).toBe('After');
    });

    it('FINANCE_OFFICER cannot update/archive/restore students', async () => {
      const stu = await createStudent(admin.jar, { studentId: 'STU-NF-' + Math.random().toString(36).slice(2,6) });
      const u = await callRoute('PATCH', `/api/students/${stu.id}`, finance.jar, { firstName: 'X' });
      expect(u.status).toBe(403);
      const a = await callRoute('POST', `/api/students/${stu.id}/archive`, finance.jar, { reason: 'x' });
      expect(a.status).toBe(403);
      const r = await callRoute('POST', `/api/students/${stu.id}/restore`, finance.jar, {});
      expect(r.status).toBe(403);
    });

    it('archive succeeds (admin) when no open invoices; restore reactivates', async () => {
      const stu = await createStudent(admin.jar, { studentId: 'STU-A-' + Math.random().toString(36).slice(2,6) });
      const a = await callRoute('POST', `/api/students/${stu.id}/archive`, admin.jar, { reason: 'Left' });
      expect(a.status).toBe(200);
      const g = await callRoute('GET', `/api/students/${stu.id}`, admin.jar);
      expect(g.status).toBe(200);
      expect(g.data.student.status).not.toBe('ACTIVE');
      const r = await callRoute('POST', `/api/students/${stu.id}/restore`, admin.jar, {});
      expect(r.status).toBe(200);
      const g2 = await callRoute('GET', `/api/students/${stu.id}`, admin.jar);
      expect(g2.data.student.status).toBe('ACTIVE');
    });

    it('archive returns 409 when student has outstanding invoices', async () => {
      const stu = await createStudent(admin.jar, { studentId: 'STU-O-' + Math.random().toString(36).slice(2,6) });
      await createInvoice(finance.jar, stu.id, 1000000);
      const a = await callRoute('POST', `/api/students/${stu.id}/archive`, admin.jar, { reason: 'nope' });
      expect(a.status).toBe(409);
    });

    it('STAFF cannot archive a student', async () => {
      const stu = await createStudent(admin.jar, { studentId: 'STU-WR-' + Math.random().toString(36).slice(2,6) });
      const r = await callRoute('POST', `/api/students/${stu.id}/archive`, staff.jar, { reason: 'x' });
      expect(r.status).toBe(403);
    });

    it('foreign org cannot archive our student', async () => {
      const stu = await createStudent(admin.jar, { studentId: 'STU-X-' + Math.random().toString(36).slice(2,6) });
      const r = await callRoute('POST', `/api/students/${stu.id}/archive`, foreign.jar, { reason: 'x' });
      expect([403, 404]).toContain(r.status);
    });
  });

  // =========================================================================
  // PUBLIC /p/[token]
  // =========================================================================
  describe('public /p/[token]', () => {
    it('ACTIVE token returns view with minimal information', async () => {
      const stu = await createStudent(admin.jar, { studentId: 'PUB-V-' + Math.random().toString(36).slice(2,6) });
      const inv = await createInvoice(finance.jar, stu.id, 4500000);
      const link = await createPaymentLink(finance.jar, { invoiceId: inv.id });
      const v = await callPublicView(link.token);
      expect(v.status).toBe(200);
      expect(v.data.organization.name).toBeTruthy();
      expect(v.data.invoice.studentFirstName).toBeTruthy();
      expect(v.data.invoice.studentLastName.length).toBeGreaterThan(0);
      expect(v.data.invoice.invoiceNumber).toBe(inv.invoiceNumber);
      expect(v.data.invoice.remainingKobo).toBe(4500000);
    });

    it('invalid / revoked / expired tokens return 404/410 (no information disclosure)', async () => {
      const bad1 = await callPublicView('nope-000000000000');
      expect(bad1.status).toBe(404);
      const stu = await createStudent(admin.jar, { studentId: 'PUB-R-' + Math.random().toString(36).slice(2,6) });
      const inv = await createInvoice(finance.jar, stu.id, 500000);
      const link = await createPaymentLink(finance.jar, { invoiceId: inv.id });
      await callRoute('PATCH', `/api/payment-links/${link.token}`, finance.jar, { status: 'REVOKED' });
      expect((await callPublicView(link.token)).status).toBe(404);
      const sql = getSql();
      const expToken = 'exp2-' + Math.random().toString(36).slice(2, 20);
      await sql`select set_tenant_context(${finance.orgId}::uuid, ${finance.userId}::uuid)`;
      await sql`
        insert into payment_links (organization_id, token, status, invoice_id, amount_kobo, expires_at, note, created_at, updated_at)
        values (${finance.orgId}::uuid, ${expToken}, 'ACTIVE', ${inv.id}::uuid, 500000::bigint,
                now() - interval '30 days', 'expired test link', now(), now())`;
      await sql`select clear_app_context()`.catch(()=>{});
      expect((await callPublicView(expToken)).status).toBe(410);
    });

    it('public submit creates a PENDING payment only — no confirm, no allocation, no invoice change, no receipt; audit event written', async () => {
      const sql = getSql();
      const stu = await createStudent(admin.jar, { studentId: 'PUB-S-' + Math.random().toString(36).slice(2,6) });
      const inv = await createInvoice(finance.jar, stu.id, 7500000);
      const link = await createPaymentLink(finance.jar, { invoiceId: inv.id });
      // Read invoice.paid_kobo under finance tenant context (invoices has no
      // public-visible column outside the narrow invoice lookup policy).
      await sql`select set_tenant_context(${finance.orgId}::uuid, ${finance.userId}::uuid)`;
      const before = await sql<any[]>`select paid_kobo from invoices where id = ${inv.id}::uuid`;
      const beforePaid = Number(before[0]!.paid_kobo);
      await sql`select clear_app_context()`.catch(()=>{});

      const anon = new CookieJar();
      const ref = 'TELLER-' + Math.random().toString(36).slice(2,8);
      const sub = await callPublicSubmit(link.token, anon, {
        payerName: 'Chidi Parent', payerPhone: '08012345678', reference: ref,
      });
      if (sub.status !== 201) {
        // Force-print the diagnostic body.
        expect({ status: sub.status, body: sub.data }).toEqual({ status: 201 });
      }
      expect(sub.data.payment.status).toBe('PENDING');
      expect(sub.data.payment.paymentNumber).toMatch(/^PMT-/);
      expect(sub.data.payment.amountKobo).toBe(7500000);

      // Enter finance tenant context to read payments/invoices (RLS scoped).
      await sql`select set_tenant_context(${finance.orgId}::uuid, ${finance.userId}::uuid)`;
      const payIdRows = await sql<any[]>`select id, status, amount_kobo, unallocated_kobo from payments where payment_number = ${sub.data.payment.paymentNumber}`;
      const payRow = payIdRows[0]!;
      expect(payRow.status).toBe('PENDING');
      expect(Number(payRow.unallocated_kobo)).toBe(0);
      const allocRows = await sql<any[]>`select count(*)::text as n from payment_allocations where payment_id = ${payRow.id}::uuid`;
      expect(allocRows[0]!.n).toBe('0');
      const after = await sql<any[]>`select paid_kobo from invoices where id = ${inv.id}::uuid`;
      expect(Number(after[0]!.paid_kobo)).toBe(beforePaid);
      const rcpt = await sql<any[]>`select count(*)::text as n from receipts where payment_id = ${payRow.id}::uuid`;
      expect(rcpt[0]!.n).toBe('0');
      const aud = await sql<any[]>`select action from audit_events where entity_id = ${payRow.id}::uuid and action = 'payment.pending'`;
      expect(aud.length).toBeGreaterThanOrEqual(1);
      await sql`select clear_app_context()`.catch(()=>{});
    });

    it('public submit against revoked/expired/invalid token fails', async () => {
      const anon = new CookieJar();
      const bad = await callPublicSubmit('no-such-token-00', anon, { payerName: 'X', reference: 'R' });
      expect(bad.status).toBe(404);

      const stu = await createStudent(admin.jar, { studentId: 'PUB-F-' + Math.random().toString(36).slice(2,6) });
      const inv = await createInvoice(finance.jar, stu.id, 500000);
      const link = await createPaymentLink(finance.jar, { invoiceId: inv.id });
      await callRoute('PATCH', `/api/payment-links/${link.token}`, finance.jar, { status: 'REVOKED' });
      expect((await callPublicSubmit(link.token, anon, { payerName: 'X', reference: 'R' })).status).toBe(404);

      const sql2 = getSql();
      const expTok = 'exp3-' + Math.random().toString(36).slice(2, 20);
      await sql2`select set_tenant_context(${finance.orgId}::uuid, ${finance.userId}::uuid)`;
      await sql2`
        insert into payment_links (organization_id, token, status, invoice_id, amount_kobo, expires_at, note, created_at, updated_at)
        values (${finance.orgId}::uuid, ${expTok}, 'ACTIVE', ${inv.id}::uuid, 500000::bigint,
                now() - interval '30 days', 'expired test link', now(), now())`;
      await sql2`select clear_app_context()`.catch(()=>{});
      expect((await callPublicSubmit(expTok, anon, { payerName: 'X', reference: 'R' })).status).toBe(410);
    });

    it('malformed submission is rejected (validation)', async () => {
      const stu = await createStudent(admin.jar, { studentId: 'PUB-M-' + Math.random().toString(36).slice(2,6) });
      const inv = await createInvoice(finance.jar, stu.id, 500000);
      const link = await createPaymentLink(finance.jar, { invoiceId: inv.id });
      const anon = new CookieJar();
      const bad = await callPublicSubmit(link.token, anon, { payerName: '', reference: '' } as any);
      expect(bad.status).toBe(400);
    });
  });

  // =========================================================================
  // DASHBOARD KPI regression
  // =========================================================================
  describe('dashboard KPI term scoping', () => {
    it('collectedKobo counts ACTIVE allocations in the CURRENT term only', async () => {
      const sql = getSql();
      // Use a dedicated student for this test so prior-test allocations do
      // not pollute the assertion.
      const stu = await createStudent(admin.jar, { studentId: 'KPI-' + Math.random().toString(36).slice(2,6) });
      const invCurrent = await createInvoice(finance.jar, stu.id, 2000000);
      await recordConfirmedPayment(finance.jar, {
        amountKobo: 2000000,
        reference: 'KPI-CUR-' + Math.random().toString(36).slice(2,4),
        allocations: [{ invoiceId: invCurrent.id, amountKobo: 2000000 }],
      });

      // Create a non-current term and a separate invoice+allocation against
      // it using set_tenant_context so RLS permits writes. Amount 3,000,000
      // goes to the other term — the dashboard MUST NOT count it.
      await sql`select set_tenant_context(${finance.orgId}::uuid, ${finance.userId}::uuid)`;
      const curTerm = (await sql<any[]>`select id, session_id, starts_on, ends_on from terms where organization_id = ${finance.orgId}::uuid and is_current = true limit 1`)[0]!;
      const otherTermId = uid();
      await sql`
        insert into terms (id, organization_id, session_id, name, label, starts_on, ends_on, due_date, is_current, billed, status, created_at, updated_at)
        values (${otherTermId}::uuid, ${finance.orgId}::uuid, ${curTerm.session_id}::uuid, 'Other Term', 'OTH',
                ${curTerm.starts_on}, ${curTerm.ends_on}, now()+'60 days'::interval,
                false, false, 'ACTIVE', now(), now())`;
      const otherInvId = uid();
      await sql`
        insert into invoices (id, organization_id, student_id, term_id, session_id, invoice_number, status, total_kobo, paid_kobo, issued_at, due_date, created_at, updated_at, created_by)
        values (${otherInvId}::uuid, ${finance.orgId}::uuid, ${stu.id}::uuid, ${otherTermId}::uuid, ${curTerm.session_id}::uuid,
                'INV-OTH-'||substr(gen_random_uuid()::text,1,8), 'ISSUED', 3000000::bigint, 0::bigint,
                now(), now()+'60 days'::interval, now(), now(), ${finance.userId}::uuid)`;
      const pay2Id = uid();
      await sql`
        insert into payments (id, organization_id, payment_number, method, status, amount_kobo, unallocated_kobo, reference, payer_name, paid_at, created_at, updated_at, recorded_by)
        values (${pay2Id}::uuid, ${finance.orgId}::uuid, 'PMT-KPI-'||substr(gen_random_uuid()::text,1,6), 'BANK_TRANSFER', 'CONFIRMED',
                3000000::bigint, 3000000::bigint, ${'KPI-OTH-'+Math.random().toString(36).slice(2,4)}, 'Payer', now(), now(), now(), ${finance.userId}::uuid)`;
      await sql`
        insert into payment_allocations (id, organization_id, payment_id, invoice_id, amount_kobo, status, allocated_at, created_at, updated_at, created_by)
        values (gen_random_uuid(), ${finance.orgId}::uuid, ${pay2Id}::uuid, ${otherInvId}::uuid, 3000000::bigint, 'ACTIVE', now(), now(), now(), ${finance.userId}::uuid)`;
      await sql`select clear_app_context()`.catch(()=>{});
      await sql`select set_tenant_context(${finance.orgId}::uuid, ${finance.userId}::uuid)`;

      // Call the dashboard (withTenant sets tenant GUCs on the connection).
      await sql`select clear_app_context()`.catch(()=>{});
      const dash = await callRoute('GET', '/api/dashboard/summary', finance.jar);
      expect(dash.status).toBe(200);

      // Re-establish tenant context on our sql handle (pooled connections
      // don't share GUCs) and run verification queries inside withTenant
      // to ensure RLS is active for the verification reads.
      let curForStu = 0, curTotal = 0, othTotal = 0;
      await withTenant({ organizationId: finance.orgId, userId: finance.userId } as any, async () => {
        const a = await sql<any[]>`
          select coalesce(sum(a.amount_kobo),0)::bigint as v
          from payment_allocations a
          join invoices i on i.id = a.invoice_id
          join payments p on p.id = a.payment_id
          where i.student_id = ${stu.id}::uuid
            and i.term_id = ${curTerm.id}::uuid
            and a.status = 'ACTIVE' and p.status = 'CONFIRMED'`;
        curForStu = Number(a[0]!.v);
        const c = await sql<any[]>`
          select coalesce(sum(a.amount_kobo),0)::bigint as v
          from payment_allocations a
          join invoices i on i.id = a.invoice_id
          join payments p on p.id = a.payment_id
          where i.organization_id = ${finance.orgId}::uuid
            and i.term_id = ${curTerm.id}::uuid
            and a.status = 'ACTIVE' and p.status = 'CONFIRMED'`;
        curTotal = Number(c[0]!.v);
        const o = await sql<any[]>`
          select coalesce(sum(a.amount_kobo),0)::bigint as v
          from payment_allocations a
          join invoices i on i.id = a.invoice_id
          join payments p on p.id = a.payment_id
          where i.organization_id = ${finance.orgId}::uuid
            and i.term_id = ${otherTermId}::uuid
            and a.status = 'ACTIVE' and p.status = 'CONFIRMED'`;
        othTotal = Number(o[0]!.v);
      });

      // The student's current-term ACTIVE allocation is exactly 2M.
      expect(curForStu).toBe(2000000);
      // Other term has ≥3M ACTIVE allocations (our seed) — proving the data
      // set does contain allocations outside the current term.
      expect(othTotal).toBeGreaterThanOrEqual(3000000);
      // Dashboard reported collected equals current-term total (not cur+oth).
      expect(dash.data.kpis.collectedKobo).toBe(curTotal);
    });
  });
});

// ---------- Public helpers (no auth) ----------
async function resetGuc() {
  const sql = getSql();
  try { await sql`select auth_clear_public_context()`.catch(()=>{}); } catch {}
  try { await sql`select clear_app_context()`.catch(()=>{}); } catch {}
}
async function callPublicView(token: string) {
  const mod: any = await import(/* @vite-ignore */ `@/app/api/p/[token]/view/route`);
  const handler: Function = (mod?.default ?? mod).GET;
  const req = new Request(`http://test.local/api/p/${token}/view`, { method: 'GET' });
  await resetGuc();
  let res: Response;
  try {
    res = await handler(req, { params: Promise.resolve({ token }) });
  } catch (e: any) {
    await resetGuc();
    return { status: 500, data: { error: { message: e?.message, stack: e?.stack } } };
  }
  await resetGuc();
  const text = await res.text();
  let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
async function callPublicSubmit(token: string, _jar: InstanceType<typeof CookieJar>, body: any) {
  const mod: any = await import(/* @vite-ignore */ `@/app/api/p/[token]/submit/route`);
  const handler: Function = (mod?.default ?? mod).POST;
  const req = new Request(`http://test.local/api/p/${token}/submit`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  await resetGuc();
  let res: Response;
  try {
    res = await handler(req, { params: Promise.resolve({ token }) });
  } catch (e: any) {
    await resetGuc();
    return { status: 500, data: { error: { message: e?.message ?? String(e), stack: e?.stack } } };
  }
  await resetGuc();
  const text = await res.text();
  let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
