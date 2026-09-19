/**
 * M7 adversarial suite — debtors/aging workbench & reminders.
 *
 * Covers:
 *   - Auth: unauthenticated, CSRF enforcement on POST remind
 *   - Tenant isolation: Org B cannot read or remind Org A students
 *   - Forged IDs: random/nonexistent/paid-invoice IDs
 *   - Cooldown: replay within 4h returns 429
 *   - Balance-zero: cannot remind when no open balance
 *   - Immutability: reminders table UPDATE/DELETE blocked by app role
 *   - Financial integrity: totals reflect trigger-maintained columns
 *
 * Notes for this harness:
 *   Each test runs inside a BEGIN/ROLLBACK transaction on a single connection.
 *   Route handlers clear tenant GUCs on return, so any direct SQL we run after
 *   a handler must re-establish tenant context before reading RLS-protected
 *   rows. Tests that need a reminder row to already exist send one via the
 *   API in-arrange (the same way a real operator would) rather than relying
 *   on cross-test state.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
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
  let userA: { id: string };
  let stuA: { id: string; studentId: string };
  let invA: { id: string; invoiceNumber: string };
  let invAPaid: { id: string; invoiceNumber: string };

  // Re-establish tenant context on the test connection after any handler
  // call (handlers clear GUCs on return). Tests that do direct SQL against
  // RLS-protected tables must await this first.
  async function enterCtxA() {
    const sql = getSql();
    await sql`select set_tenant_context(${orgA.id}::uuid, ${userA.id}::uuid)`;
    return sql;
  }

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
    userA = { id: meA.data.user.id };
    expect(orgA.id).toMatch(uuidRe);
    expect(orgB.id).toMatch(uuidRe);
    expect(orgA.id).not.toBe(orgB.id);

    const { POST: SeedTerm } = await import('@/app/api/setup/seed-current-term/route');
    const seedA = await call(SeedTerm as any, ownerA, { method: 'POST', csrf: true, body: {} });
    expect([200, 201, 409]).toContain(seedA.status);

    // Student + overdue invoice.
    const sidA = unique('SA');
    const cs = await call(CreateStudent as any, ownerA, {
      method: 'POST', csrf: true,
      body: { studentId: sidA, firstName: 'Adeleke', lastName: 'Okafor', gender: 'M' },
    });
    expect(cs.status).toBe(201);
    stuA = { id: cs.data.student.id, studentId: sidA };

    const ci = await call(CreateInvoice as any, ownerA, {
      method: 'POST', csrf: true,
      headers: { 'idempotency-key': 'inv-' + unique('1') },
      body: {
        studentId: stuA.id,
        dueDate: '2020-01-15',
        lines: [{ description: 'Tuition', quantity: 1, unitRateKobo: 5000000 }],
      },
    });
    expect(ci.status, `create overdue invoice: ${JSON.stringify(ci.data)}`).toBe(201);
    invA = { id: ci.data.invoice.id, invoiceNumber: ci.data.invoice.invoiceNumber };

    // Paid-in-full invoice (balance-zero case).
    const ci2 = await call(CreateInvoice as any, ownerA, {
      method: 'POST', csrf: true,
      headers: { 'idempotency-key': 'inv-' + unique('2') },
      body: {
        studentId: stuA.id,
        dueDate: '2030-01-01',
        lines: [{ description: 'Books', quantity: 1, unitRateKobo: 100000 }],
      },
    });
    expect(ci2.status).toBe(201);
    invAPaid = { id: ci2.data.invoice.id, invoiceNumber: ci2.data.invoice.invoiceNumber };

    const { POST: RecordPayment } = await import('@/app/api/payments/route');
    const rp = await call(RecordPayment as any, ownerA, {
      method: 'POST', csrf: true,
      body: {
        method: 'CASH',
        amountKobo: 100000,
        payerName: 'Parent',
        reference: unique('PAY'),
        initialStatus: 'CONFIRMED',
        paidAt: new Date().toISOString(),
        allocations: [{ invoiceId: invAPaid.id, amountKobo: 100000 }],
      },
    });
    expect(rp.status, `pay-in-full: ${JSON.stringify(rp.data)}`).toBe(201);
  });

  beforeEach(async () => {
    // Reset tenant GUC to neutral before each test (in case a prior handler
    // or test left it set). Handlers set their own context; we re-enter
    // explicitly for direct-SQL tests via enterCtxA().
    const sql = getSql();
    await sql.unsafe('RESET ALL').catch(() => {});
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
    const r = await call(SendReminder as any, ownerB, {
      method: 'POST', csrf: true,
      body: { channel: 'PRINT' },
      args: [{ params: Promise.resolve({ studentId: stuA.id }) }],
    });
    expect(r.status).toBe(404);
    // Defense in depth: org A's view of reminders for stuA should not grow
    // as a result of org B's attempt. Read through the public API (same
    // path a bursar uses) so RLS is exercised end-to-end.
    const before = await call(DebtorDetail as any, ownerA, {
      method: 'GET', args: [{ params: Promise.resolve({ studentId: stuA.id }) }],
    });
    const beforeCount = before.data.reminders.length;
    await call(SendReminder as any, ownerB, {
      method: 'POST', csrf: true,
      body: { channel: 'PRINT' },
      args: [{ params: Promise.resolve({ studentId: stuA.id }) }],
    });
    const after = await call(DebtorDetail as any, ownerA, {
      method: 'GET', args: [{ params: Promise.resolve({ studentId: stuA.id }) }],
    });
    expect(after.data.reminders.length).toBe(beforeCount);
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

  it('non-existent syntactically-valid studentId returns 404', async () => {
    const r = await call(SendReminder as any, ownerA, {
      method: 'POST', csrf: true,
      body: { channel: 'PRINT' },
      args: [{ params: Promise.resolve({ studentId: '00000000-0000-4000-8000-000000000099' }) }],
    });
    expect(r.status).toBe(404);
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
  // 5. Happy path — record creation and response shape.
  // -----------------------------------------------------------------------
  it('PRINT reminder creates an immutable record and returns a server-rendered document', async () => {
    const sql = await enterCtxA();
    const before = await sql<{id:string}[]>`select id from reminders where student_id = ${stuA.id}::uuid`;
    const beforeCount = before.length;

    const r = await call(SendReminder as any, ownerA, {
      method: 'POST', csrf: true,
      body: { channel: 'PRINT' },
      args: [{ params: Promise.resolve({ studentId: stuA.id }) }],
    });
    expect(r.status).toBe(201);
    expect(r.data.status).toBe('SENT');
    expect(r.data.channel).toBe('PRINT');
    expect(r.data.document.studentName).toMatch(/Okafor/);
    expect(r.data.document.totalKobo).toBe(5000000);
    expect(r.data.document.body).toContain('outstanding');
    expect(r.data.reminders.length).toBeGreaterThanOrEqual(1);

    // Row was persisted and visible under tenant RLS.
    await enterCtxA();
    const after = await sql<{id:string;status:string;balance_kobo:number;channel:string;body:string}[]>`
      select id, status, balance_kobo, channel, body from reminders
       where student_id = ${stuA.id}::uuid
       order by created_at desc`;
    expect(after.length).toBe(beforeCount + 1);
    expect(after[0]!.status).toBe('SENT');
    expect(after[0]!.channel).toBe('PRINT');
    expect(Number(after[0]!.balance_kobo)).toBe(5000000);
    expect(after[0]!.body).toContain('outstanding');
  });

  // -----------------------------------------------------------------------
  // 6. Cooldown / idempotency.
  // -----------------------------------------------------------------------
  it('replay within cooldown window returns 429 TOO_EARLY and writes no new row', async () => {
    // First send to guarantee a recent reminder exists.
    const first = await call(SendReminder as any, ownerA, {
      method: 'POST', csrf: true,
      body: { channel: 'PRINT' },
      args: [{ params: Promise.resolve({ studentId: stuA.id }) }],
    });
    expect(first.status).toBe(201);

    const sql = await enterCtxA();
    const afterFirst = await sql<{id:string}[]>`select id from reminders where student_id = ${stuA.id}::uuid`;
    const countAfterFirst = afterFirst.length;

    const second = await call(SendReminder as any, ownerA, {
      method: 'POST', csrf: true,
      body: { channel: 'PRINT' },
      args: [{ params: Promise.resolve({ studentId: stuA.id }) }],
    });
    expect(second.status).toBe(429);
    expect(second.data.error.code).toBe('TOO_EARLY');

    await enterCtxA();
    const afterSecond = await sql<{id:string}[]>`select id from reminders where student_id = ${stuA.id}::uuid`;
    expect(afterSecond.length).toBe(countAfterFirst);
  });

  // -----------------------------------------------------------------------
  // 7. Immutability trigger — UPDATE/DELETE blocked as app role.
  // -----------------------------------------------------------------------
  it('reminders table is immutable from the runtime app role (no UPDATE/DELETE)', async () => {
    // Arrange: create a reminder via the API.
    const sent = await call(SendReminder as any, ownerA, {
      method: 'POST', csrf: true,
      body: { channel: 'PRINT' },
      args: [{ params: Promise.resolve({ studentId: stuA.id }) }],
    });
    expect(sent.status).toBe(201);

    const sql = await enterCtxA();
    const rows = await sql<{id:string}[]>`select id from reminders where student_id = ${stuA.id}::uuid limit 1`;
    expect(rows.length).toBe(1);
    const rid = rows[0]!.id;

    // Switch to the runtime app role (what production uses) and attempt
    // tampering. Each attempt runs inside a SAVEPOINT so the expected error
    // does not poison the outer test transaction. Both attempts must throw
    // thanks to trg_reminders_immutable and the "USING (false)" no-update/
    // no-delete RLS policies.
    await sql.unsafe('SAVEPOINT m7_mut');
    await sql.unsafe('SET LOCAL ROLE scolaira_app');
    let updateThrew = false;
    try {
      await sql.unsafe('SAVEPOINT m7_upd');
      try { await sql`update reminders set body = 'tampered' where id = ${rid}::uuid`; } catch { updateThrew = true; }
      await sql.unsafe('ROLLBACK TO SAVEPOINT m7_upd');
    } catch { updateThrew = true; }
    let deleteThrew = false;
    try {
      await sql.unsafe('SAVEPOINT m7_del');
      try { await sql`delete from reminders where id = ${rid}::uuid`; } catch { deleteThrew = true; }
      await sql.unsafe('ROLLBACK TO SAVEPOINT m7_del');
    } catch { deleteThrew = true; }
    try { await sql.unsafe('RESET ROLE'); } catch { /* savepoint rollback already reset */ }
    await sql.unsafe('RELEASE SAVEPOINT m7_mut');
    expect(updateThrew).toBe(true);
    expect(deleteThrew).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 8. Financial fidelity in list + detail responses.
  // -----------------------------------------------------------------------
  it('/api/debtors totals match trigger-maintained invoice balances', async () => {
    const r = await call(DebtorsList as any, ownerA, { method: 'GET' });
    expect(r.status).toBe(200);
    const stu = r.data.students.find((s: any) => s.studentId === stuA.id);
    expect(stu).toBeTruthy();
    expect(stu.outstandingKobo).toBeGreaterThanOrEqual(5000000);
    expect(stu.overdueKobo).toBeGreaterThanOrEqual(5000000);
    expect(['OVERDUE_90', 'SEVERE']).toContain(stu.agingBucket);
    expect(stu.openInvoiceCount).toBeGreaterThanOrEqual(1);
  });

  it('/api/debtors/:id returns per-invoice aging and reminder history', async () => {
    // Arrange: ensure a reminder exists for this student in this txn.
    const sent = await call(SendReminder as any, ownerA, {
      method: 'POST', csrf: true,
      body: { channel: 'PRINT' },
      args: [{ params: Promise.resolve({ studentId: stuA.id }) }],
    });
    expect([201, 429]).toContain(sent.status);

    const r = await call(DebtorDetail as any, ownerA, {
      method: 'GET',
      args: [{ params: Promise.resolve({ studentId: stuA.id }) }],
    });
    expect(r.status).toBe(200);
    expect(r.data.student.id).toBe(stuA.id);

    const invSummary = r.data.invoices.find((i: any) => i.id === invA.id);
    expect(invSummary).toBeTruthy();
    expect(invSummary.remainingKobo).toBe(5000000);
    expect(invSummary.daysOverdue).toBeGreaterThan(365); // due date 2020-01-15

    expect(r.data.reminders.length).toBeGreaterThanOrEqual(1);
    expect(r.data.reminders[0].channel).toBe('PRINT');
    expect(r.data.reminders[0].balanceKobo).toBeGreaterThanOrEqual(5000000);

    expect(r.data.summary.outstandingKobo).toBeGreaterThanOrEqual(5000000);
    expect(r.data.summary.overdueKobo).toBeGreaterThanOrEqual(5000000);
  });
});
