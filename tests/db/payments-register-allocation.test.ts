// @vitest-environment node
/**
 * Regression — the payments register must agree with the allocation ledger.
 *
 * Measured defect (product walkthrough, self-healing QA): the register's list
 * query correlated its sub-select with `${payments.id}`, which drizzle rendered
 * as a bare `"id"`. Inside the sub-select the `payment_allocations pa` alias owns
 * an `id` of its own, so the predicate silently became `pa.payment_id = pa.id` —
 * never true. Every payment therefore reported `allocatedKobo: 0` and
 * `allocationCount: 0`, and a fully allocated ₦450,000 payment displayed
 * "Allocated ₦0.00" beside an invoice that read PAID.
 *
 * This test is written against the measured symptom, not the implementation:
 * for a fully allocated payment, a partially allocated payment, and a payment
 * with no allocation at all, the register's per-row figures must equal the
 * allocation ledger's own sums, and `amount = allocated + unallocated` must hold.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CookieJar, call } from '../auth/support';
import { getSql, closeDb } from '@/lib/db';
import { enableSavepointTransactionsForTest } from '../setup-db';
import { POST as Register } from '@/app/api/auth/register/route';
import { GET as Me } from '@/app/api/auth/me/route';
import { POST as SeedTerm } from '@/app/api/setup/seed-current-term/route';
import { GET as Payments } from '@/app/api/payments/route';

interface Owner {
  jar: CookieJar;
  orgId: string;
  userId: string;
}

/** Register a throwaway school and return an authenticated jar for its owner. */
async function makeOwner(slug: string): Promise<Owner> {
  const jar = new CookieJar();
  const r = await call(Register as any, jar, {
    method: 'POST',
    path: '/api/auth/register',
    body: {
      email: `${slug}@example.com`,
      password: 'Str0ng!Passw0rd-For-Test',
      firstName: 'Own',
      lastName: 'Er',
      organizationName: `School ${slug}`,
      organizationSlug: slug,
    },
  });
  expect(r.status, `register ${slug}: ${JSON.stringify(r.data)}`).toBe(201);
  const me = await call(Me as any, jar, { method: 'GET', path: '/api/auth/me' });
  expect(me.status).toBe(200);
  return { jar, orgId: me.data.activeOrganizationId as string, userId: me.data.user.id as string };
}

describe('payments register — Allocated column matches the ledger', () => {
  let owner: Owner;

  beforeAll(async () => {
    enableSavepointTransactionsForTest();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('reports allocated kobo and allocation count per payment', async () => {
    owner = await makeOwner('payalloc');
    const seeded = await call(SeedTerm as any, owner.jar, {
      method: 'POST',
      path: '/api/setup/seed-current-term',
      csrf: true,
      body: {},
    });
    expect([200, 201]).toContain(seeded.status);
    const term = seeded.data.term as { id: string };
    const session = seeded.data.session as { id: string };

    const sql = getSql();
    await sql.unsafe(`select set_tenant_context($1::uuid, $2::uuid)`, [owner.orgId, owner.userId]);

    // One student, three invoices — one per payment under test.
    await sql.unsafe(
      `insert into students (organization_id, student_id, first_name, last_name, status)
       values ($1::uuid, 'PAYALLOC-1', 'Pay', 'Alloc', 'ACTIVE'::student_status)`,
      [owner.orgId],
    );
    await sql.unsafe(
      `insert into invoices (organization_id, invoice_number, student_id, term_id, session_id, status,
                             total_kobo, paid_kobo, issue_date, due_date)
       select $1::uuid, 'PAYALLOC-INV-' || n, s.id, $2::uuid, $3::uuid, 'ISSUED'::invoice_status,
              case n when 1 then 4500000 when 2 then 800000 else 500000 end, 0,
              current_date - 30, current_date - 10
         from students s, generate_series(1, 3) n
        where s.organization_id = $1::uuid and s.student_id = 'PAYALLOC-1'`,
      [owner.orgId, term.id, session.id],
    );

    // Three CONFIRMED payments, each seeded with unallocated = amount and then
    // reduced by the allocation trigger (repo code never writes unallocated_kobo).
    await sql.unsafe(
      `insert into payments (organization_id, payment_number, method, status, amount_kobo,
                             unallocated_kobo, payer_name, paid_at, recorded_by)
       select $1::uuid, 'PAYALLOC-P' || n, 'CASH'::payment_method, 'CONFIRMED'::payment_status,
              case n when 1 then 4500000 when 2 then 800000 else 500000 end,
              case n when 1 then 4500000 when 2 then 800000 else 500000 end,
              'Payalloc ' || n, now(), $2::uuid
         from generate_series(1, 3) n`,
      [owner.orgId, owner.userId],
    );

    // Payment 1 → fully allocated. Payment 2 → ₦5,000 of ₦8,000 allocated.
    // Payment 3 → left unallocated.
    await sql.unsafe(
      `insert into payment_allocations (organization_id, payment_id, invoice_id, amount_kobo, status, created_by)
       select $1::uuid, p.id, i.id, v.amount, 'ACTIVE'::allocation_status, $2::uuid
         from (values (1, 4500000), (2, 500000)) as v(n, amount)
         join payments p on p.organization_id = $1::uuid and p.payment_number = 'PAYALLOC-P' || v.n
         join invoices i on i.organization_id = $1::uuid and i.invoice_number = 'PAYALLOC-INV-' || v.n`,
      [owner.orgId, owner.userId],
    );

    const res = await call(Payments as any, owner.jar, { method: 'GET', path: '/api/payments' });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const rows = res.data.payments as Array<{
      paymentNumber: string;
      amountKobo: number;
      allocatedKobo: number;
      unallocatedKobo: number;
      allocationCount: number;
    }>;
    const byNumber = Object.fromEntries(rows.map((r) => [r.paymentNumber, r]));

    const full = byNumber['PAYALLOC-P1']!;
    const partial = byNumber['PAYALLOC-P2']!;
    const none = byNumber['PAYALLOC-P3']!;
    expect([full, partial, none].every(Boolean)).toBe(true);

    // The register's own figures (this is what the UI renders as "Allocated").
    expect(full.allocatedKobo).toBe(4_500_000);
    expect(full.allocationCount).toBe(1);
    expect(full.unallocatedKobo).toBe(0);

    expect(partial.allocatedKobo).toBe(500_000);
    expect(partial.allocationCount).toBe(1);
    expect(partial.unallocatedKobo).toBe(300_000);

    expect(none.allocatedKobo).toBe(0);
    expect(none.allocationCount).toBe(0);
    expect(none.unallocatedKobo).toBe(500_000);

    // The row must close arithmetically, and the register must equal the ledger.
    for (const row of [full, partial, none]) {
      expect(row.allocatedKobo + row.unallocatedKobo).toBe(row.amountKobo);
    }

    // Ledger cross-check straight from the database (route handlers clear the
    // tenant GUCs on return, so re-establish context before reading).
    await sql.unsafe(`select set_tenant_context($1::uuid, $2::uuid)`, [owner.orgId, owner.userId]);
    const [ledger] = (await sql.unsafe(
      `select coalesce(sum(a.amount_kobo), 0)::bigint as total
         from payment_allocations a
         join payments p on p.id = a.payment_id
        where p.organization_id = $1::uuid and a.status = 'ACTIVE'`,
      [owner.orgId],
    )) as unknown as Array<{ total: string }>;
    const registerTotal = rows.reduce((sum, r) => sum + r.allocatedKobo, 0);
    expect(registerTotal).toBe(Number(ledger!.total));
  });
});
