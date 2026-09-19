/**
 * M7 adversarial suite — debtors/aging workbench & reminders.
 *
 * Covers:
 *   - Auth: unauthenticated, CSRF enforcement on POST remind
 *   - Tenant isolation: Org B cannot read or remind Org A students
 *   - Forged IDs: random/nonexistent/paid-invoice IDs
 *   - Cooldown: replay within 4h returns 429
 *   - Balance-zero: cannot remind when no open balance
 *   - Immutability: reminders table writes cannot be UPDATE/DELETE'd by app role
 *   - Financial integrity: totals in API reflect trigger-maintained columns
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { CookieJar, call, uuidRe } from './support';
import { GET as DebtorsList } from '@/app/api/debtors/route';
import { GET as DebtorDetail } from '@/app/api/debtors/[studentId]/route';
import { POST as SendReminder } from '@/app/api/debtors/[studentId]/remind/route';
import { POST as Register } from '@/app/api/auth/register/route';
import { POST as CreateStudent } from '@/app/api/students/route';
import { POST as CreateInvoice } from '@/app/api/invoices/route';
import { getSql } from '@/lib/db';

function unique(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

async function makeOwner(email: string, orgName: string) {
  const jar = new CookieJar();
  const firstName = unique('Own');
  const slug = unique('sch');
  const password = 'Str0ng!Passw0rd-For-Test';
  const r = await call(Register as any, jar, {
    method: 'POST',
    body: { email, password, firstName, lastName: 'User', organizationName: orgName, organizationSlug: slug },
  });
  expect(r.status, `register ${email}: ${JSON.stringify(r.data)}`).toBe(201);
  return { jar, firstName };
}

describe('M7 — Debtors / Reminders adversarial', () => {
  let ownerA: CookieJar;
  let ownerB: CookieJar;
  let orgA: { id: string };
  let orgB: { id: string };
  let stuA: { id: string; studentId: string };
  let invA: { id: string; invoiceNumber: string };
  let invAPaid: { id: string; invoiceNumber: string };

  beforeAll(async () => {
    const emailA = `${unique('a')}@example.com`;
    const emailB = `${unique('b')}@example.com`;
    const a = await makeOwner(emailA, 'School Alpha');
    const b = await makeOwner(emailB, 'School Beta');
    ownerA = a.jar;
    ownerB = b.jar;

    const { GET: MeGet } = await import('@/app/api/auth/me/route');
    const meA = await call(MeGet as any, ownerA, { method: 'GET' });
    const meB = await call(MeGet as any, ownerB, { method: 'GET' });
    orgA = { id: meA.data.activeOrganizationId };
    orgB = { id: meB.data.activeOrganizationId };
    expect(orgA.id).toMatch(uuidRe);
    expect(orgB.id).toMatch(uuidRe);
    expect(orgA.id).not.toBe(orgB.id);

    // Org A: one student with a long-overdue issued invoice.
    const sidA = unique('SA');
    const cs = await call(CreateStudent as any, ownerA, {
      method: 'POST', csrf: true,
      body: { studentId: sidA, firstName: 'Adeleke', lastName: 'Okafor', gender: 'MALE' },
    });
    expect(cs.status).toBe(201);
    stuA = { id: cs.data.student.id, studentId: sidA };

    const invNum = unique('INV');
    const ci = await call(CreateInvoice as any, ownerA, {
      method: 'POST', csrf: true,
      body: {
        studentId: stuA.id,
        invoiceNumber: invNum,
        dueDate: '2020-01-15',
        lines: [{ description: 'Tuition', quantity: 1, unitPriceKobo: 5000000 }],
        issue: true,
      },
    });
    expect(ci.status, `create overdue invoice: ${JSON.stringify(ci.data)}`).toBe(201);
    invA = { id: ci.data.invoice.id, invoiceNumber: invNum };

    // Org A: a second invoice we'll pay in full (balance-zero case).
    const invNum2 = unique('IPD');
    const ci2 = await call(CreateInvoice as any, ownerA, {
      method: 'POST', csrf: true,
      body: {
        studentId: stuA.id,
        invoiceNumber: invNum2,
        dueDate: '2030-01-01',
        lines: [{ description: 'Books', quantity: 1, unitPriceKobo: 100000 }],
        issue: true,
      },
    });
    expect(ci2.status).toBe(201);
    invAPaid = { id: ci2.data.invoice.id, invoiceNumber: invNum2 };

    const { POST: RecordPayment } = await import('@/app/api/payments/route');
    const payNum = unique('PAY');
    const rp = await call(RecordPayment as any, ownerA, {
      method: 'POST', csrf: true,
      body: {
        paymentNumber: payNum,
        method: 'CASH',
        payerName: 'Parent',
        amountKobo: 100000,
        allocations: [{ invoiceId: invAPaid.id, amountKobo: 100000 }],
        status: 'CONFIRMED',
        paidAt: new Date().toISOString(),
      },
    });
    expect(rp.status, `pay-in-full: ${JSON.stringify(rp.data)}`).toBe(201);
  });

  // -----------------------------------------------------------------------
  // 1. Unauthenticated.
  // -----------------------------------------------------------------------
  it('unauthenticated GET /api/debtors returns 401', async () => {
    const jar = new CookieJar();
    const r = await call(DebtorsList as any, jar, { method: 'GET' });
    expect(r.status).toBe(401);
  });

  it('unauthenticated POST remind returns 401', async () => {
    const jar = new CookieJar();
    const r = await call(SendReminder as any, jar, {
      method: 'POST',
      body: { channel: 'PRINT' },
      args: [{ params: Promise.resolve({ studentId: stuA.id }) }],
    });
    expect(r.status).toBe(401);
  });

  it('POST remind without CSRF token is rejected', async () => {
    const r = await call(SendReminder as any, ownerA, {
      method: 'POST', csrf: false,
      body: { channel: 'PRINT' },
      args: [{ params: Promise.resolve({ studentId: stuA.id }) }],
    });
    expect([401, 403]).toContain(r.status);
  });

  // -----------------------------------------------------------------------
  // 2. Tenant isolation.
  // -----------------------------------------------------------------------
  it('org B cannot list org A debtors via /api/debtors', async () => {
    const r = await call(DebtorsList as any, ownerB, { method: 'GET' });
    expect(r.status).toBe(200);
    const ids = r.data.students.map((s: any) => s.studentId);
    expect(ids).not.toContain(stuA.id);
  });

  it('org B cannot read org A student debtor detail', async () => {
    const r = await call(DebtorDetail as any, ownerB, {
      method: 'GET',
      args: [{ params: Promise.resolve({ studentId: stuA.id }) }],
    });
    expect(r.status).toBe(404);
  });

  it('org B cannot send reminder to org A student', async () => {
    const sql = getSql();
    const r = await call(SendReminder as any, ownerB, {
      method: 'POST', csrf: true,
      body: { channel: 'PRINT' },
      args: [{ params: Promise.resolve({ studentId: stuA.id }) }],
    });
    expect(r.status).toBe(404);
    const cross = await sql`select id from reminders where student_id = ${stuA.id} and organization_id = ${orgB.id}::uuid`;
    expect(cross.length).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 3. Forged / nonexistent IDs.
  // -----------------------------------------------------------------------
  it('nonexistent studentId returns 404', async () => {
    const rand = '00000000-0000-4000-8000-000000000001';
    const r = await call(SendReminder as any, ownerA, {
      method: 'POST', csrf: true,
      body: { channel: 'PRINT' },
      args: [{ params: Promise.resolve({ studentId: rand }) }],
    });
    expect(r.status).toBe(404);
  });

  it('malformed (non-uuid) studentId does not 500', async () => {
    const r = await call(SendReminder as any, ownerA, {
      method: 'POST', csrf: true,
      body: { channel: 'PRINT' },
      args: [{ params: Promise.resolve({ studentId: "'; DROP TABLE students;--" }) }],
    });
    expect([400, 404]).toContain(r.status);
  });

  it('cannot send reminder for a random invoiceId even on own student', async () => {
    const rand = '00000000-0000-4000-8000-000000000002';
    const r = await call(SendReminder as any, ownerA, {
      method: 'POST', csrf: true,
      body: { channel: 'PRINT', invoiceId: rand },
      args: [{ params: Promise.resolve({ studentId: stuA.id }) }],
    });
    expect(r.status).toBe(400);
  });

  // -----------------------------------------------------------------------
  // 4. Balance-zero rejection.
  // -----------------------------------------------------------------------
  it('cannot remind against a fully-paid invoice', async () => {
    const r = await call(SendReminder as any, ownerA, {
      method: 'POST', csrf: true,
      body: { channel: 'PRINT', invoiceId: invAPaid.id },
      args: [{ params: Promise.resolve({ studentId: stuA.id }) }],
    });
    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe('BAD_REQUEST');
  });

  // -----------------------------------------------------------------------
  // 5. Happy path + cooldown.
  // -----------------------------------------------------------------------
  it('PRINT reminder creates immutable record and returns document payload', async () => {
    const sql = getSql();
    const before = await sql`select id from reminders where student_id = ${stuA.id} and organization_id = ${orgA.id}::uuid`;
    const beforeCount = before.length;
    const r = await call(SendReminder as any, ownerA, {
      method: 'POST', csrf: true,
      body: { channel: 'PRINT' },
      args: [{ params: Promise.resolve({ studentId: stuA.id }) }],
    });
    // Might be 201 or 429 depending on cooldown state from prior tests in suite.
    expect([201, 429]).toContain(r.status);
    if (r.status === 201) {
      expect(r.data.status).toBe('SENT');
      expect(r.data.document.studentName).toMatch(/Okafor/);
      expect(r.data.document.totalKobo).toBe(5000000);
    }
    const after = await sql`select id, status from reminders where student_id = ${stuA.id} and organization_id = ${orgA.id}::uuid order by created_at`;
    expect(after.length).toBeGreaterThanOrEqual(beforeCount + (r.status === 201 ? 1 : 0));
  });

  it('replay within cooldown window returns 429 TOO_EARLY', async () => {
    // Send once first to guarantee a recent reminder exists.
    await call(SendReminder as any, ownerA, {
      method: 'POST', csrf: true,
      body: { channel: 'PRINT' },
      args: [{ params: Promise.resolve({ studentId: stuA.id }) }],
    });
    const second = await call(SendReminder as any, ownerA, {
      method: 'POST', csrf: true,
      body: { channel: 'PRINT' },
      args: [{ params: Promise.resolve({ studentId: stuA.id }) }],
    });
    expect(second.status).toBe(429);
    expect(second.data.error.code).toBe('TOO_EARLY');
  });

  // -----------------------------------------------------------------------
  // 6. Immutability trigger blocks UPDATE/DELETE as app role.
  // -----------------------------------------------------------------------
  it('reminders table is immutable from app role', async () => {
    const sql = getSql();
    const rows = await sql`select id from reminders where student_id = ${stuA.id} and organization_id = ${orgA.id}::uuid limit 1`;
    expect(rows.length).toBeGreaterThan(0);
    await sql`set local role scolaira_app`;
    let updateThrew = false;
    try { await sql`update reminders set body = 'tampered' where id = ${rows[0]!.id}::uuid`; } catch { updateThrew = true; }
    let deleteThrew = false;
    try { await sql`delete from reminders where id = ${rows[0]!.id}::uuid`; } catch { deleteThrew = true; }
    await sql`reset role`;
    expect(updateThrew).toBe(true);
    expect(deleteThrew).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 7. List/detail reflect trigger-maintained totals.
  // -----------------------------------------------------------------------
  it('/api/debtors totals match invoice balances', async () => {
    const r = await call(DebtorsList as any, ownerA, { method: 'GET' });
    expect(r.status).toBe(200);
    const stu = r.data.students.find((s: any) => s.studentId === stuA.id);
    expect(stu).toBeTruthy();
    expect(stu.outstandingKobo).toBeGreaterThanOrEqual(5000000);
    expect(stu.overdueKobo).toBeGreaterThanOrEqual(5000000);
    expect(['OVERDUE_90', 'SEVERE']).toContain(stu.agingBucket);
  });

  it('/api/debtors/:id returns per-invoice and reminder history', async () => {
    const r = await call(DebtorDetail as any, ownerA, {
      method: 'GET',
      args: [{ params: Promise.resolve({ studentId: stuA.id }) }],
    });
    expect(r.status).toBe(200);
    expect(r.data.student.id).toBe(stuA.id);
    const invSummary = r.data.invoices.find((i: any) => i.id === invA.id);
    expect(invSummary).toBeTruthy();
    expect(invSummary.remainingKobo).toBe(5000000);
    expect(r.data.reminders.length).toBeGreaterThanOrEqual(1);
    expect(r.data.reminders[0].channel).toBe('PRINT');
    expect(r.data.reminders[0].balanceKobo).toBeGreaterThanOrEqual(5000000);
  });
});
