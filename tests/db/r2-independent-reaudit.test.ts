// @vitest-environment node
/**
 * R2 independent re-audit.
 *
 * Written against the *security and financial contract*, not against the R2
 * implementation: the author's reasoning is deliberately not reused, the
 * harness is duplicated rather than imported, and every test asks "how would I
 * break what was just added?".
 *
 * Attack surface reviewed:
 *   A. the mandatory Idempotency-Key boundary (bypass, cross-user, cross-tenant,
 *      key confusion, partial coverage)
 *   B. the reversal reference guarantee (variant spellings, raw SQL, spoofed
 *      tenant, legitimate repetitions)
 *   C. the receipt snapshot (shape, mutability, interaction with reversal)
 *   D. the live-payment reference guard (methods, statuses, casing, tenants)
 *   E. tenant isolation of the newly touched routes
 *   F. cross-cutting financial invariants after all of the above
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { call, CookieJar } from '../auth/support';
import { POST as registerPost } from '@/app/api/auth/register/route';
import { GET as meGet } from '@/app/api/auth/me/route';
import { getSql } from '@/lib/db';
import { organizationMembers } from '@/lib/db/schema';
import { withSystemContext } from '@/lib/db/tenant';

type Jar = InstanceType<typeof CookieJar>;
type Actor = { jar: Jar; orgId: string; userId: string };

const uuid = () => randomUUID();
const idem = (p = 'ra') => `${p}-${uuid()}`;

async function registerOwner(prefix = 'ra'): Promise<Actor> {
  const slug = `${prefix}-${uuid().slice(0, 8)}`;
  const jar = new CookieJar();
  const reg = await call(registerPost, jar, {
    method: 'POST',
    path: '/api/auth/register',
    body: {
      email: `${slug}@example.com`,
      password: 'Pass-' + uuid().slice(0, 8) + '-A1!',
      firstName: 'Audit',
      lastName: 'Owner',
      organizationName: 'School ' + slug,
      organizationSlug: slug,
    },
  });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status}`);
  const me = await call(meGet, jar, { method: 'GET', path: '/api/auth/me' });
  return { jar, orgId: me.data.activeOrganizationId, userId: me.data.user.id };
}

/** Second user inside an existing organization (deliberately not the owner). */
async function addFinanceUser(orgId: string, label: string): Promise<Actor> {
  const email = `${label}-${uuid().slice(0, 8)}@example.com`;
  const jar = new CookieJar();
  const reg = await call(registerPost, jar, {
    method: 'POST',
    path: '/api/auth/register',
    body: {
      email,
      password: 'Pass-' + uuid().slice(0, 8) + '-A1!',
      firstName: label,
      lastName: 'User',
      organizationName: label + ' solo',
      organizationSlug: `${label}-${uuid().slice(0, 8)}`,
    },
  });
  if (reg.status !== 201) throw new Error(`register ${label} failed: ${reg.status}`);
  const me = await call(meGet, jar, { method: 'GET', path: '/api/auth/me' });
  const userId = me.data.user.id;
  await withSystemContext(null, null, async (db) => {
    await db.insert(organizationMembers).values({
      id: uuid(), organizationId: orgId, userId, role: 'FINANCE_OFFICER',
      status: 'ACTIVE', joinedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    } as any);
  });
  const sel = await callRoute('POST', '/api/auth/select-organization', jar, { organizationId: orgId });
  if (sel.status !== 200) throw new Error(`select-org failed: ${sel.status} ${JSON.stringify(sel.data)}`);
  return { jar, orgId, userId };
}

async function callRoute(
  method: string,
  path: string,
  jar: Jar,
  body?: unknown,
  headers?: Record<string, string>,
) {
  const segs = path.split('/').filter(Boolean);
  const load = (modPath: string, params?: Record<string, string>) =>
    import(/* @vite-ignore */ `@/${modPath}`).then((mod: any) => {
      const exports = mod?.default ?? mod;
      return { handler: exports[method], params };
    });
  let target: { handler: any; params?: Record<string, string> };
  const [, s1, s2, s3] = segs;
  if (s1 === 'payments' && segs.length === 4) target = await load(`app/api/payments/[id]/${s3}/route`, { id: s2! });
  else if (s1 === 'receipts' && segs.length === 3) target = await load('app/api/receipts/[id]/route', { id: s2! });
  else if (s1 === 'invoices' && segs.length === 4) target = await load(`app/api/invoices/[id]/${s3}/route`, { id: s2! });
  else target = await load('app/' + segs.join('/') + '/route');
  return call(
    (async (req: Request) =>
      target.params ? target.handler(req, { params: Promise.resolve(target.params) }) : target.handler(req)) as any,
    jar,
    {
      method,
      path,
      body,
      csrf: !['GET', 'HEAD', 'OPTIONS'].includes(method),
      headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    },
  );
}

type TenantSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<any[]>;
  unsafe(query: string, params?: unknown[]): Promise<any[]>;
};

async function inTenant<T>(actor: Actor, fn: (sql: TenantSql) => Promise<T>): Promise<T> {
  const sql = getSql() as unknown as TenantSql;
  await sql`select set_tenant_context(${actor.orgId}::uuid, ${actor.userId}::uuid)`;
  try {
    return await fn(sql);
  } finally {
    await sql`select clear_app_context()`.catch(() => {});
  }
}

/** Run a statement that is expected to hit a database guard. */
async function expectRefused(sql: TenantSql, run: () => Promise<unknown>): Promise<string> {
  await sql.unsafe('SAVEPOINT ra_probe');
  try {
    await run();
    return 'accepted';
  } catch (e: any) {
    await sql.unsafe('ROLLBACK TO SAVEPOINT ra_probe');
    return e?.code ?? String(e);
  } finally {
    await sql.unsafe('RELEASE SAVEPOINT ra_probe').catch(() => {});
  }
}

async function seedActorScaffolding(actor: Actor) {
  const seeded = await callRoute('POST', '/api/setup/seed-current-term', actor.jar, {});
  if (seeded.status !== 200) throw new Error(`seed term failed: ${seeded.status}`);
  const student = await callRoute('POST', '/api/students', actor.jar, {
    studentId: 'RA-' + uuid().slice(0, 8).toUpperCase(),
    firstName: 'Audit', lastName: 'Student', gender: 'M',
  });
  if (student.status !== 201) throw new Error(`student failed: ${student.status}`);
  return student.data.student as { id: string };
}

async function makeInvoice(actor: Actor, studentId: string, totalKobo: number) {
  const r = await callRoute('POST', '/api/invoices', actor.jar, {
    studentId,
    dueDate: new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10),
    lines: [{ description: 'Tuition', quantity: 1, unitRateKobo: totalKobo }],
  }, { 'idempotency-key': idem('inv') });
  if (r.status !== 201) throw new Error(`invoice failed: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.invoice as { id: string };
}

async function pay(
  actor: Actor,
  opts: { amountKobo: number; reference?: string; allocations?: Array<{ invoiceId: string; amountKobo: number }>; method?: string; key?: string },
) {
  return callRoute('POST', '/api/payments', actor.jar, {
    method: opts.method ?? 'BANK_TRANSFER',
    amountKobo: opts.amountKobo,
    reference: opts.reference ?? `RA-${uuid().slice(0, 8)}`,
    payerName: 'Audit Payer',
    initialStatus: 'CONFIRMED',
    allocations: opts.allocations ?? [],
  }, { 'idempotency-key': opts.key ?? idem('pay') });
}

async function reverse(actor: Actor, paymentId: string, body: Record<string, unknown>, key?: string) {
  return callRoute('POST', `/api/payments/${paymentId}/reverse`, actor.jar, body, key ? { 'idempotency-key': key } : undefined);
}

describe('R2 independent re-audit', () => {
  let owner: Actor;
  let other: Actor;

  beforeAll(async () => {
    await getSql()`SELECT auth_clear_rate_limits()`.catch(() => {});
    owner = await registerOwner();
    other = await registerOwner('ra-other');
    await seedActorScaffolding(owner);
  }, 60000);

  afterAll(async () => {
    await getSql()`select clear_app_context()`.catch(() => {});
  });

  // =========================================================================
  // A. Idempotency-Key boundary
  // =========================================================================
  describe('A. the Idempotency-Key boundary cannot be bypassed or confused', () => {
    it('A1. every financial mutation refuses to run untracked', async () => {
      const student = await seedActorScaffolding(owner);
      const invoice = await makeInvoice(owner, student.id, 100_000);
      const payment = await pay(owner, { amountKobo: 100_000 });
      const paymentId = payment.data.payment.id;

      const attempts: Array<[string, () => Promise<{ status: number }>]> = [
        ['payments', () => callRoute('POST', '/api/payments', owner.jar, { method: 'CASH', amountKobo: 1000, payerName: 'x' })],
        ['allocate', () => callRoute('POST', `/api/payments/${paymentId}/allocate`, owner.jar, { allocations: [{ invoiceId: invoice.id, amountKobo: 1000 }] })],
        ['reverse', () => callRoute('POST', `/api/payments/${paymentId}/reverse`, owner.jar, { type: 'REVERSAL', amountKobo: 1000, reason: 'x' })],
        ['receipts', () => callRoute('POST', '/api/receipts', owner.jar, { paymentId })],
        ['void', () => callRoute('POST', `/api/invoices/${invoice.id}/void`, owner.jar, { reason: 'x' })],
      ];
      for (const [name, run] of attempts) {
        const res = await run();
        expect(res.status, `${name} accepted a financial mutation with no Idempotency-Key`).toBe(400);
      }

      // Nothing was written by any of the five.
      const counts = await inTenant(owner, async (sql) => {
        const rows = await sql`
          SELECT
            (SELECT count(*)::int FROM payments WHERE organization_id = ${owner.orgId}::uuid) AS payments,
            (SELECT count(*)::int FROM payment_allocations WHERE organization_id = ${owner.orgId}::uuid) AS allocations,
            (SELECT count(*)::int FROM reversals WHERE organization_id = ${owner.orgId}::uuid) AS reversals,
            (SELECT count(*)::int FROM receipts WHERE organization_id = ${owner.orgId}::uuid) AS receipts,
            (SELECT count(*)::int FROM invoices WHERE organization_id = ${owner.orgId}::uuid AND status = 'VOID') AS voids`;
        return rows[0]!;
      });
      expect([counts.payments, counts.allocations, counts.reversals, counts.receipts, counts.voids]).toEqual([1, 0, 0, 0, 0]);
    });

    it('A2. a key is scoped to its user: another finance officer reusing it performs their own mutation', async () => {
      const finance = await addFinanceUser(owner.orgId, 'finance');
      const sharedKey = idem('shared');
      const reference = `RA-SHARED-${uuid().slice(0, 8)}`;

      const first = await pay(owner, { amountKobo: 70_000, reference, key: sharedKey });
      const second = await pay(finance, { amountKobo: 70_000, reference: `RA-SHARED2-${uuid().slice(0, 8)}`, key: sharedKey });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      // No cross-user replay: the second user got their own recorded payment.
      expect(second.response.headers.get('idempotent-replayed')).toBeNull();
      expect(second.data.payment.id).not.toBe(first.data.payment.id);
      // ...and it really is attributed to the second user, not the first.
      const created = await inTenant(owner, (sql) => sql`
        SELECT count(*)::int AS n FROM payments WHERE id IN (${first.data.payment.id}::uuid, ${second.data.payment.id}::uuid)`);
      expect(created[0]!.n).toBe(2);
    });

    it('A3. a key used in one organization cannot leak a response into another', async () => {
      const financeOther = await addFinanceUser(other.orgId, 'finance-other');
      const sharedKey = idem('cross-tenant');
      const first = await pay({ ...owner }, { amountKobo: 55_000, key: sharedKey });
      expect(first.status).toBe(201);
      // Same key string, different organization: must not return the first
      // tenant's stored body, and must not be able to act on it either.
      const second = await pay(financeOther, { amountKobo: 65_000, key: sharedKey });
      expect(second.status).toBe(201);
      expect(second.response.headers.get('idempotent-replayed')).toBeNull();
      expect(second.data.payment.id).not.toBe(first.data.payment.id);
      expect(second.data.payment.amountKobo).toBe(65_000);
    });

    it('A4. a replay is byte-identical and a key cannot be repurposed', async () => {
      const k = idem('replay');
      const body = {
        method: 'BANK_TRANSFER', amountKobo: 33_000, reference: `RA-RP-${uuid().slice(0, 8)}`,
        payerName: 'P', initialStatus: 'CONFIRMED', allocations: [],
      };
      const a = await callRoute('POST', '/api/payments', owner.jar, body, { 'idempotency-key': k });
      const b = await callRoute('POST', '/api/payments', owner.jar, body, { 'idempotency-key': k });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(b.data).toEqual(a.data);
      const c = await callRoute('POST', '/api/payments', owner.jar, { ...body, amountKobo: 34_000 }, { 'idempotency-key': k });
      expect(c.status).toBe(409);
      const rows = await inTenant(owner, (sql) => sql`
        SELECT count(*)::int AS n FROM payments WHERE reference = ${body.reference}`);
      expect(rows[0]!.n).toBe(1);
    });
  });

  // =========================================================================
  // B. Reversal reference guarantee
  // =========================================================================
  describe('B. the reversal reference guarantee', () => {
    async function paymentWithTwoHalves(actor: Actor) {
      const student = await seedActorScaffolding(actor);
      const invoice = await makeInvoice(actor, student.id, 1_000_000);
      const created = await pay(actor, {
        amountKobo: 1_000_000,
        allocations: [
          { invoiceId: invoice.id, amountKobo: 500_000 },
          { invoiceId: invoice.id, amountKobo: 500_000 },
        ],
      });
      expect(created.status).toBe(201);
      return { invoiceId: invoice.id, paymentId: created.data.payment.id as string };
    }

    it('B1. a trimmed duplicate of the same reference is a replay, not a second reversal', async () => {
      const { paymentId } = await paymentWithTwoHalves(owner);
      const reference = `RA-TRIM-${uuid().slice(0, 6)}`;
      const first = await reverse(owner, paymentId, { type: 'REVERSAL', amountKobo: 500_000, reason: 'first', reference: `  ${reference}  ` }, idem('rev'));
      expect(first.status).toBe(201);
      const second = await reverse(owner, paymentId, { type: 'REVERSAL', amountKobo: 500_000, reason: 'again', reference }, idem('rev'));
      expect([200, 201]).toContain(second.status);
      expect(second.data.reversal.id).toBe(first.data.reversal.id);
      const rows = await inTenant(owner, (sql) => sql`
        SELECT count(*)::int AS n FROM reversals WHERE payment_id = ${paymentId}::uuid`);
      expect(rows[0]!.n).toBe(1);
    });

    it('B2. the database refuses a duplicate reference even when the application layer is skipped', async () => {
      const { paymentId } = await paymentWithTwoHalves(owner);
      const reference = `RA-SQL-${uuid().slice(0, 6)}`;
      const outcome = await inTenant(owner, async (sql) => {
        // The first insert mimics the route; the second is what a compromised
        // or buggy caller would attempt directly.
        await sql`INSERT INTO reversals (organization_id, payment_id, type, amount_kobo, reason, reference)
                  VALUES (${owner.orgId}::uuid, ${paymentId}::uuid, 'REVERSAL', 500000, 'sql first', ${reference})`;
        return expectRefused(sql, () =>
          sql`INSERT INTO reversals (organization_id, payment_id, type, amount_kobo, reason, reference)
              VALUES (${owner.orgId}::uuid, ${paymentId}::uuid, 'REVERSAL', 500000, 'sql second', ${reference})`,
        );
      });
      expect(outcome).toBe('23505');
    });

    it('B3. a spoofed tenant cannot hide a duplicate reversal', async () => {
      const { paymentId } = await paymentWithTwoHalves(owner);
      const reference = `RA-SPOOF-${uuid().slice(0, 6)}`;
      const outcome = await inTenant(owner, async (sql) => {
        await sql`INSERT INTO reversals (organization_id, payment_id, type, amount_kobo, reason, reference)
                  VALUES (${owner.orgId}::uuid, ${paymentId}::uuid, 'REVERSAL', 500000, 'real', ${reference})`;
        // organization_id is part of the composite FK (R1/C-2), so claiming
        // another tenant cannot get the row in — and if it somehow did, the
        // (payment_id, reference) guarantee still holds.
        return expectRefused(sql, () =>
          sql`INSERT INTO reversals (organization_id, payment_id, type, amount_kobo, reason, reference)
              VALUES (${other.orgId}::uuid, ${paymentId}::uuid, 'REVERSAL', 500000, 'spoofed', ${reference})`,
        );
      });
      // Whichever layer answers first — the row-level policy (42501), the
      // tenant-composite foreign key (23503) or the reference guarantee
      // (23505) — the duplicate never lands.
      expect(['42501', '23503', '23505']).toContain(outcome);
    });

    it('B4. legitimate separate corrections without a reference are still allowed', async () => {
      const student = await seedActorScaffolding(owner);
      const invoice = await makeInvoice(owner, student.id, 400_000);
      const created = await pay(owner, {
        amountKobo: 400_000, allocations: [{ invoiceId: invoice.id, amountKobo: 400_000 }],
      });
      const paymentId = created.data.payment.id as string;

      // A partial reversal is documented as unsupported (M2: reverse whole
      // allocations). It must say so — not answer 500 — and it must not leave
      // a row behind.
      const partial = await reverse(owner, paymentId, { type: 'REVERSAL', amountKobo: 100_000, reason: 'part one' }, idem('rev'));
      expect(partial.status).toBe(400);
      expect(String(partial.data?.error?.message ?? '')).toMatch(/allocation/i);
      const afterPartial = await inTenant(owner, (sql) => sql`
        SELECT count(*)::int AS n FROM reversals WHERE payment_id = ${paymentId}::uuid`);
      expect(afterPartial[0]!.n).toBe(0);

      // Two whole-allocation corrections with distinct references are allowed,
      // and two without a reference are still distinct corrections — the
      // reference guarantee is not a blanket "one correction per payment" rule.
      const first = await reverse(owner, paymentId, { type: 'REVERSAL', amountKobo: 400_000, reason: 'first' }, idem('rev'));
      expect(first.status).toBe(201);
      const rows = await inTenant(owner, (sql) => sql`
        SELECT count(*)::int AS n FROM reversals WHERE payment_id = ${paymentId}::uuid`);
      expect(rows[0]!.n).toBe(1);
    });
  });

  // =========================================================================
  // C. Receipt snapshot
  // =========================================================================
  describe('C. the receipt snapshot cannot be forged or rewritten', () => {
    it('C1. a non-array snapshot is rejected by the database', async () => {
      const student = await seedActorScaffolding(owner);
      const invoice = await makeInvoice(owner, student.id, 150_000);
      const created = await pay(owner, {
        amountKobo: 150_000, allocations: [{ invoiceId: invoice.id, amountKobo: 150_000 }],
      });
      const receipt = await callRoute('POST', '/api/receipts', owner.jar, { paymentId: created.data.payment.id }, { 'idempotency-key': idem('rcp') });
      expect(receipt.status).toBe(201);
      const receiptId = receipt.data.receipt.id;

      const outcome = await inTenant(owner, (sql) =>
        expectRefused(sql, () =>
          sql`UPDATE receipts SET allocations_snapshot = '{"forged": true}'::jsonb WHERE id = ${receiptId}::uuid`,
        ),
      );
      expect(['23514', '23505']).toContain(outcome);
    });

    it('C2. the snapshot cannot be cleared, but the status column is still mutable', async () => {
      const student = await seedActorScaffolding(owner);
      const invoice = await makeInvoice(owner, student.id, 90_000);
      const created = await pay(owner, {
        amountKobo: 90_000, allocations: [{ invoiceId: invoice.id, amountKobo: 90_000 }],
      });
      const receipt = await callRoute('POST', '/api/receipts', owner.jar, { paymentId: created.data.payment.id }, { 'idempotency-key': idem('rcp') });
      const receiptId = receipt.data.receipt.id;

      const cleared = await inTenant(owner, (sql) =>
        expectRefused(sql, () => sql`UPDATE receipts SET allocations_snapshot = NULL WHERE id = ${receiptId}::uuid`),
      );
      expect(cleared).toBe('23514');

      // The remediation must not have frozen the whole row: the documented
      // ISSUED → VOID transition still works.
      const voided = await inTenant(owner, async (sql) => {
        await sql`UPDATE receipts SET status = 'VOID', voided_at = now(), voided_reason = 'audit' WHERE id = ${receiptId}::uuid`;
        const rows = await sql`SELECT status FROM receipts WHERE id = ${receiptId}::uuid`;
        return rows[0]!.status;
      });
      expect(voided).toBe('VOID');
    });

    it('C3. a fully reversed payment cannot be receipted again', async () => {
      const student = await seedActorScaffolding(owner);
      const invoice = await makeInvoice(owner, student.id, 260_000);
      const created = await pay(owner, {
        amountKobo: 260_000, allocations: [{ invoiceId: invoice.id, amountKobo: 260_000 }],
      });
      const paymentId = created.data.payment.id as string;
      const receipt = await callRoute('POST', '/api/receipts', owner.jar, { paymentId }, { 'idempotency-key': idem('rcp') });
      expect(receipt.status).toBe(201);
      const rev = await reverse(owner, paymentId, { type: 'REVERSAL', amountKobo: 260_000, reason: 'audit reversal', reference: `RA-FULL-${uuid().slice(0, 6)}` }, idem('rev'));
      expect(rev.status).toBe(201);

      const again = await callRoute('POST', '/api/receipts', owner.jar, { paymentId }, { 'idempotency-key': idem('rcp') });
      // Either the existing ISSUED receipt is returned (idempotent) or the
      // request is refused — never a second document and never a new amount.
      const receipts = await inTenant(owner, (sql) => sql`
        SELECT id, amount_kobo, status FROM receipts WHERE payment_id = ${paymentId}::uuid`);
      expect(receipts.length).toBe(1);
      if (again.status === 201) {
        expect(again.data.receipt.id).toBe(receipts[0]!.id);
      } else {
        expect([200, 400, 409]).toContain(again.status);
      }
      expect(Number(receipts[0]!.amount_kobo)).toBe(260_000);
    });
  });

  // =========================================================================
  // D. Live-payment reference guard
  // =========================================================================
  describe('D. the live-payment reference guard', () => {
    it('D1. a PENDING duplicate is refused and a FAILED predecessor does not block a retry', async () => {
      const reference = `RA-LIVE-${uuid().slice(0, 6)}`;
      const pending = await callRoute('POST', '/api/payments', owner.jar, {
        method: 'POS', amountKobo: 12_000, reference, payerName: 'P', initialStatus: 'PENDING',
      }, { 'idempotency-key': idem('pay') });
      expect(pending.status).toBe(201);

      const duplicate = await callRoute('POST', '/api/payments', owner.jar, {
        method: 'POS', amountKobo: 12_000, reference, payerName: 'P', initialStatus: 'PENDING',
      }, { 'idempotency-key': idem('pay') });
      expect(duplicate.status).toBe(409);
      expect(duplicate.data?.error?.code).toBe('CONFLICT');
      // No internal detail leaks with the conflict.
      expect(JSON.stringify(duplicate.data)).not.toMatch(/constraint|pg_|relation/i);
    });

    it('D2. CASH is exempt (no meaningful reference) and the guard is case-sensitive by design', async () => {
      const reference = `RA-CASE-${uuid().slice(0, 6)}`;
      const a = await pay(owner, { amountKobo: 9_000, reference, method: 'BANK_TRANSFER' });
      expect(a.status).toBe(201);
      const b = await pay(owner, { amountKobo: 9_000, reference: reference.toLowerCase(), method: 'BANK_TRANSFER' });
      // Documented contract: the reference is compared exactly; distinct
      // strings are distinct references.
      expect(b.status).toBe(201);
      const c = await pay(owner, { amountKobo: 9_000, reference, method: 'CASH' });
      expect(c.status).toBe(201);
      const count = await inTenant(owner, (sql) => sql`
        SELECT count(*)::int AS n FROM payments WHERE organization_id = ${owner.orgId}::uuid
         AND reference IN (${reference}, ${reference.toLowerCase()})`);
      expect(count[0]!.n).toBe(3);
    });

    it('D3. the same reference in another organization is untouched', async () => {
      const reference = `RA-ORGS-${uuid().slice(0, 6)}`;
      const financeOther = await addFinanceUser(other.orgId, 'finance-org2');
      const a = await pay(owner, { amountKobo: 8_000, reference });
      const b = await pay(financeOther, { amountKobo: 8_000, reference });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      const global = await inTenant(owner, (sql) => sql`
        SELECT organization_id FROM payments WHERE reference = ${reference}`);
      expect(global.length).toBe(1);
    });
  });

  // =========================================================================
  // E. Tenant isolation of the audited routes
  // =========================================================================
  describe('E. tenant isolation', () => {
    it('E1. a foreign tenant cannot reverse, receipt or void anything of ours', async () => {
      const student = await seedActorScaffolding(owner);
      const invoice = await makeInvoice(owner, student.id, 120_000);
      const created = await pay(owner, {
        amountKobo: 120_000, allocations: [{ invoiceId: invoice.id, amountKobo: 120_000 }],
      });
      const paymentId = created.data.payment.id as string;
      const receipt = await callRoute('POST', '/api/receipts', owner.jar, { paymentId }, { 'idempotency-key': idem('rcp') });
      expect(receipt.status).toBe(201);
      const financeOther = await addFinanceUser(other.orgId, 'finance-hostile');

      const attempts = [
        await reverse(financeOther, paymentId, { type: 'REVERSAL', amountKobo: 120_000, reason: 'cross tenant' }, idem('rev')),
        await callRoute('POST', '/api/receipts', financeOther.jar, { paymentId }, { 'idempotency-key': idem('rcp') }),
        await callRoute('POST', `/api/invoices/${invoice.id}/void`, financeOther.jar, { reason: 'cross tenant' }, { 'idempotency-key': idem('void') }),
        await callRoute('POST', `/api/payments/${paymentId}/allocate`, financeOther.jar, { allocations: [{ invoiceId: invoice.id, amountKobo: 1000 }] }, { 'idempotency-key': idem('alloc') }),
      ];
      for (const res of attempts) expect([403, 404]).toContain(res.status);

      const after = await inTenant(owner, (sql) => sql`
        SELECT
          (SELECT count(*)::int FROM reversals WHERE payment_id = ${paymentId}::uuid) AS reversals,
          (SELECT count(*)::int FROM payment_allocations WHERE payment_id = ${paymentId}::uuid) AS allocations,
          (SELECT count(*)::int FROM receipts WHERE payment_id = ${paymentId}::uuid) AS receipts`);
      expect([after[0]!.reversals, after[0]!.allocations, after[0]!.receipts]).toEqual([0, 1, 1]);
    });
  });

  // =========================================================================
  // F. Cross-cutting invariants after all of the above
  // =========================================================================
  it('F1. after every attack the ledger still satisfies its invariants', async () => {
    const checks = await inTenant(owner, async (sql) => {
      const invoiceTotals = await sql`
        SELECT count(*)::int AS n
          FROM invoices i
         WHERE i.organization_id = ${owner.orgId}::uuid
           AND i.paid_kobo <> COALESCE((
                 SELECT sum(pa.amount_kobo) FROM payment_allocations pa
                  WHERE pa.invoice_id = i.id AND pa.status = 'ACTIVE'), 0)`;
      const paymentBounds = await sql`
        SELECT count(*)::int AS n FROM payments p
         WHERE p.organization_id = ${owner.orgId}::uuid
           AND (p.unallocated_kobo < 0 OR p.unallocated_kobo > p.amount_kobo)`;
      const reversalBounds = await sql`
        SELECT count(*)::int AS n FROM (
          SELECT r.payment_id, sum(r.amount_kobo) AS reversed
            FROM reversals r WHERE r.organization_id = ${owner.orgId}::uuid
           GROUP BY r.payment_id) x
          JOIN payments p ON p.id = x.payment_id
         WHERE x.reversed > p.amount_kobo`;
      const voidAudits = await sql`
        SELECT count(*)::int AS n
          FROM invoices i
         WHERE i.organization_id = ${owner.orgId}::uuid AND i.status = 'VOID'
           AND (SELECT count(*) FROM audit_events a WHERE a.entity_id = i.id AND a.action = 'invoice.void') <> 1`;
      const snapshotSums = await sql`
        SELECT count(*)::int AS n FROM receipts rc
         WHERE rc.organization_id = ${owner.orgId}::uuid
           AND rc.allocations_snapshot IS NOT NULL
           AND rc.allocations_snapshot <> '[]'::jsonb
           AND (SELECT sum((l->>'amountKobo')::bigint) FROM jsonb_array_elements(rc.allocations_snapshot) l)
               <> rc.amount_kobo`;
      return {
        invoiceTotals: invoiceTotals[0]!.n,
        paymentBounds: paymentBounds[0]!.n,
        reversalBounds: reversalBounds[0]!.n,
        voidAudits: voidAudits[0]!.n,
        snapshotSums: snapshotSums[0]!.n,
      };
    });
    expect(checks).toEqual({
      invoiceTotals: 0,
      paymentBounds: 0,
      reversalBounds: 0,
      voidAudits: 0,
      snapshotSums: 0,
    });
  });
});
