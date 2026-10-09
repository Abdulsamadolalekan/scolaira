// @vitest-environment node
/**
 * R3 — public payment surface hardening (H-3).
 *
 * Contract suite. Every assertion here is about the SECURITY AND FINANCIAL
 * contract of the unauthenticated payment-link surface, not about the code that
 * happens to implement it:
 *
 *   A. the amount recorded is the link's authoritative amount, never the
 *      caller's claim
 *   B. a submission and its retries are one submission (idempotency identity)
 *   C. submissions are bounded (backlog, per-link window, platform budget)
 *   D. the bearer secret is never persisted; provenance survives without it
 *   E. the surface discloses only what a payer needs
 *   F. public context cannot write to the ledger directly
 *   G. tenant isolation and ledger non-interference hold throughout
 *
 * Measured before R3 (see the closeout): a caller could submit amountKobo = 100
 * against a 500 000 kobo link and have it recorded; eight submissions in a row
 * were all accepted; the raw token was persisted in payments.notes and audit
 * metadata; the view endpoint returned the token, the student's full name,
 * their internal identifier and the invoice's total/paid; a rejected input
 * echoed the database's own message; and public context could INSERT into
 * payments directly with no audit row, no binding and no bounds.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { call, CookieJar } from '../auth/support';
import { POST as registerPost } from '@/app/api/auth/register/route';
import { GET as meGet } from '@/app/api/auth/me/route';
import { getSql, closeDb } from '@/lib/db';
import { withPublicScope, withScopedDb } from '@/lib/db/tenant';

type Jar = InstanceType<typeof CookieJar>;
type Actor = { jar: Jar; orgId: string; userId: string };

const uuid = () => randomUUID();
const key = (p = 'r3') => `${p}-${uuid()}`;
const ref = (p = 'TELLER') => `${p}-${uuid().slice(0, 8)}`;

async function registerOwner(prefix = 'r3'): Promise<Actor> {
  const slug = `${prefix}-${uuid().slice(0, 8)}`;
  const jar = new CookieJar();
  const reg = await call(registerPost, jar, {
    method: 'POST',
    path: '/api/auth/register',
    body: {
      email: `${slug}@example.com`,
      password: 'Pass-' + uuid().slice(0, 8) + '-A1!',
      firstName: 'R3',
      lastName: 'Owner',
      organizationName: 'School ' + slug,
      organizationSlug: slug,
    },
  });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status}`);
  const me = await call(meGet, jar, { method: 'GET', path: '/api/auth/me' });
  const seeded = await callRoute('POST', '/api/setup/seed-current-term', jar, {});
  if (seeded.status !== 200) throw new Error(`seed term failed: ${seeded.status}`);
  return { jar, orgId: me.data.activeOrganizationId, userId: me.data.user.id };
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
  if (s1 === 'payment-links' && segs.length === 3)
    target = await load('app/api/payment-links/[token]/route', { token: s2! });
  else if (s1 === 'payments' && segs.length === 4)
    target = await load(`app/api/payments/[id]/${s3}/route`, { id: s2! });
  else if (s1 === 'invoices' && segs.length === 4)
    target = await load(`app/api/invoices/[id]/${s3}/route`, { id: s2! });
  else if (s1 === 'receipts' && segs.length === 3)
    target = await load('app/api/receipts/[id]/route', { id: s2! });
  else target = await load('app/' + segs.join('/') + '/route');
  return call(
    (async (req: Request) =>
      target.params
        ? target.handler(req, { params: Promise.resolve(target.params) })
        : target.handler(req)) as any,
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

// ---------- domain fixtures ----------

async function createStudent(jar: Jar, tag = 'R3') {
  const r = await callRoute('POST', '/api/students', jar, {
    studentId: `${tag}-${uuid().slice(0, 6)}`,
    firstName: 'Ada',
    lastName: 'Okafor',
    gender: 'F',
  });
  if (r.status !== 201) throw new Error(`create student failed: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.student as { id: string; studentId: string };
}

async function createInvoice(jar: Jar, studentId: string, totalKobo: number) {
  const r = await callRoute(
    'POST',
    '/api/invoices',
    jar,
    {
      studentId,
      dueDate: new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10),
      lines: [{ description: 'Tuition', quantity: 1, unitRateKobo: totalKobo }],
    },
    { 'idempotency-key': key('inv') },
  );
  if (r.status !== 201) throw new Error(`create invoice failed: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.invoice as { id: string; invoiceNumber: string; totalKobo: number; paidKobo: number };
}

async function createLink(jar: Jar, opts: { invoiceId?: string; amountKobo?: number; note?: string }) {
  const r = await callRoute('POST', '/api/payment-links', jar, {
    invoiceId: opts.invoiceId,
    amountKobo: opts.amountKobo,
    note: opts.note ?? 'R3 link',
  });
  if (r.status !== 201) throw new Error(`create link failed: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.link as { id: string; token: string };
}

async function recordConfirmedPayment(jar: Jar, opts: { amountKobo: number; allocations?: Array<{ invoiceId: string; amountKobo: number }> }) {
  const r = await callRoute(
    'POST',
    '/api/payments',
    jar,
    {
      method: 'BANK_TRANSFER',
      amountKobo: opts.amountKobo,
      reference: ref('R3PAY'),
      payerName: 'Parent Payer',
      initialStatus: 'CONFIRMED',
      allocations: opts.allocations ?? [],
    },
    { 'idempotency-key': key('pay') },
  );
  if (r.status !== 201) throw new Error(`record payment failed: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.payment as { id: string; paymentNumber: string; amountKobo: number; status: string };
}

async function confirmPayment(jar: Jar, paymentId: string) {
  const r = await callRoute('POST', `/api/payments/${paymentId}/confirm`, jar, {}, {});
  if (r.status !== 200) throw new Error(`confirm failed: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}

// ---------- public surface helpers (no cookies, no auth) ----------

async function resetGuc() {
  const sql = getSql();
  try { await sql`select auth_clear_public_context()`.catch(() => {}); } catch {}
  try { await sql`select clear_app_context()`.catch(() => {}); } catch {}
}

async function submit(token: string, body: unknown, submitKey?: string | null) {
  const mod: any = await import(/* @vite-ignore */ `@/app/api/p/[token]/submit/route`);
  const handler: Function = (mod?.default ?? mod).POST;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (submitKey !== null) headers['idempotency-key'] = submitKey ?? key('sub');
  const req = new Request(`http://test.local/api/p/${token}/submit`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  await resetGuc();
  let res: Response;
  try {
    res = await handler(req, { params: Promise.resolve({ token }) });
  } catch (e: any) {
    await resetGuc();
    return { status: 500, headers: new Headers(), data: { thrown: e?.message } };
  }
  await resetGuc();
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, headers: res.headers, data };
}

async function view(token: string) {
  const mod: any = await import(/* @vite-ignore */ `@/app/api/p/[token]/view/route`);
  const handler: Function = (mod?.default ?? mod).GET;
  const req = new Request(`http://test.local/api/p/${token}/view`, { method: 'GET' });
  await resetGuc();
  let res: Response;
  try {
    res = await handler(req, { params: Promise.resolve({ token }) });
  } catch (e: any) {
    await resetGuc();
    return { status: 500, data: { thrown: e?.message } };
  }
  await resetGuc();
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

/** Runs `fn` with the given tenant context on the harness connection. */
async function asTenant<T>(actor: Actor, fn: (sql: any) => Promise<T>): Promise<T> {
  const sql = getSql();
  await sql`select set_tenant_context(${actor.orgId}::uuid, ${actor.userId}::uuid)`;
  try {
    return await fn(sql);
  } finally {
    await sql`select clear_app_context()`.catch(() => {});
  }
}

/** Direct call of the sanctioned entry point (the raw-SQL boundary). */
async function callEntryPoint(token: string, args: unknown[]) {
  return withScopedDb({ kind: 'none' }, async (_db, sql) => {
    await sql.unsafe('SAVEPOINT r3_entry').catch(() => {});
    try {
      const rows = (await sql.unsafe(
        `select payment_id, payment_number, amount_kobo, status, replayed
           from auth_public_submit_payment($1, $2, $3::bigint, $4, $5, $6, $7)`,
        [token, ...args] as any[],
      )) as any[];
      return { ok: true as const, rows };
    } catch (e: any) {
      return { ok: false as const, code: e?.code as string, message: e?.message as string };
    } finally {
      await sql.unsafe('ROLLBACK TO SAVEPOINT r3_entry').catch(() => {});
    }
  });
}

async function pendingCount(actor: Actor, linkId: string) {
  return asTenant(actor, async (sql) => {
    const rows = (await sql`select count(*)::int as n from payments
      where link_id = ${linkId}::uuid and status = 'PENDING'`) as any[];
    return Number(rows[0].n);
  });
}

async function paymentCount(actor: Actor) {
  return asTenant(actor, async (sql) => {
    const rows = (await sql`select count(*)::int as n from payments`) as any[];
    return Number(rows[0].n);
  });
}

async function auditCount(actor: Actor, action: string) {
  return asTenant(actor, async (sql) => {
    const rows = (await sql`select count(*)::int as n from audit_events where action = ${action}`) as any[];
    return Number(rows[0].n);
  });
}

let owner: Actor;
let otherOrg: Actor;

beforeAll(async () => {
  const sql = getSql();
  await sql`SELECT auth_clear_rate_limits()`.catch(() => {});
  await sql`DELETE FROM payments WHERE notes LIKE 'Submitted via payment link %'`.catch(() => {});
  owner = await registerOwner('r3a');
  otherOrg = await registerOwner('r3b');
}, 120_000);

afterAll(async () => { await closeDb(); });

// ===========================================================================
// A. Amount binding
// ===========================================================================
describe('R3 — the recorded amount is the link\'s, not the caller\'s', () => {
  it('A1 a claim below the link amount is refused and records nothing', async () => {
    const stu = await createStudent(owner.jar, 'A1');
    const inv = await createInvoice(owner.jar, stu.id, 1_000_000);
    const link = await createLink(owner.jar, { invoiceId: inv.id, amountKobo: 500_000 });
    const before = await paymentCount(owner);
    const audits = await auditCount(owner, 'payment.pending');

    const r = await submit(link.token, { payerName: 'Ada Parent', reference: ref(), amountKobo: 100 });

    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe('AMOUNT_MISMATCH');
    expect(await paymentCount(owner)).toBe(before);
    expect(await auditCount(owner, 'payment.pending')).toBe(audits);
  });

  it('A2 with no claim the database records the link amount', async () => {
    const stu = await createStudent(owner.jar, 'A2');
    const inv = await createInvoice(owner.jar, stu.id, 1_000_000);
    const link = await createLink(owner.jar, { invoiceId: inv.id, amountKobo: 500_000 });

    const r = await submit(link.token, { payerName: 'Ada Parent', reference: ref() });

    expect(r.status).toBe(201);
    expect(r.data.payment.amountKobo).toBe(500_000);
    expect(r.data.payment.status).toBe('PENDING');
    const stored = await asTenant(owner, async (sql) => {
      const rows = (await sql`select amount_kobo, status, link_id from payments
        where payment_number = ${r.data.payment.paymentNumber}`) as any[];
      return rows[0];
    });
    expect(Number(stored.amount_kobo)).toBe(500_000);
    expect(stored.link_id).toBe(link.id);
  });

  it('A3 a claim equal to the link amount is accepted', async () => {
    const stu = await createStudent(owner.jar, 'A3');
    const inv = await createInvoice(owner.jar, stu.id, 1_000_000);
    const link = await createLink(owner.jar, { invoiceId: inv.id, amountKobo: 500_000 });

    const r = await submit(link.token, { payerName: 'Ada Parent', reference: ref(), amountKobo: 500_000 });

    expect(r.status).toBe(201);
    expect(r.data.payment.amountKobo).toBe(500_000);
  });

  it('A4 a claim above the link amount is refused', async () => {
    const stu = await createStudent(owner.jar, 'A4');
    const inv = await createInvoice(owner.jar, stu.id, 1_000_000);
    const link = await createLink(owner.jar, { invoiceId: inv.id, amountKobo: 500_000 });
    const before = await paymentCount(owner);

    const r = await submit(link.token, { payerName: 'Ada Parent', reference: ref(), amountKobo: 999_999 });

    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe('AMOUNT_MISMATCH');
    expect(await paymentCount(owner)).toBe(before);
  });

  it('A5 an amount-less link follows the invoice\'s outstanding balance', async () => {
    const stu = await createStudent(owner.jar, 'A5');
    const inv = await createInvoice(owner.jar, stu.id, 2_000_000);
    const link = await createLink(owner.jar, { invoiceId: inv.id });

    const first = await submit(link.token, { payerName: 'Ada Parent', reference: ref() });
    expect(first.status).toBe(201);
    expect(first.data.payment.amountKobo).toBe(2_000_000);

    // Settle half of the invoice through the authenticated path, then the same
    // rule must report the reduced balance on a fresh link.
    await recordConfirmedPayment(owner.jar, {
      amountKobo: 500_000,
      allocations: [{ invoiceId: inv.id, amountKobo: 500_000 }],
    });
    const link2 = await createLink(owner.jar, { invoiceId: inv.id });
    const second = await submit(link2.token, { payerName: 'Ada Parent', reference: ref() });
    expect(second.status).toBe(201);
    expect(second.data.payment.amountKobo).toBe(1_500_000);

    // …and the stale amount is now a mismatch, not a silent under/overpayment.
    const stale = await submit(link2.token, {
      payerName: 'Ada Parent',
      reference: ref(),
      amountKobo: 2_000_000,
    });
    expect(stale.status).toBe(409);
    expect(stale.data.error.code).toBe('AMOUNT_MISMATCH');
  });

  it('A6 a fully settled invoice has nothing to submit', async () => {
    const stu = await createStudent(owner.jar, 'A6');
    const inv = await createInvoice(owner.jar, stu.id, 400_000);
    const link = await createLink(owner.jar, { invoiceId: inv.id });
    await recordConfirmedPayment(owner.jar, {
      amountKobo: 400_000,
      allocations: [{ invoiceId: inv.id, amountKobo: 400_000 }],
    });
    const before = await paymentCount(owner);

    const r = await submit(link.token, { payerName: 'Ada Parent', reference: ref() });

    expect(r.status).toBe(409);
    expect(await paymentCount(owner)).toBe(before);
  });

  it('A7 the database refuses a tampered amount even when the route is bypassed', async () => {
    const stu = await createStudent(owner.jar, 'A7');
    const inv = await createInvoice(owner.jar, stu.id, 1_000_000);
    const link = await createLink(owner.jar, { invoiceId: inv.id, amountKobo: 750_000 });
    const before = await paymentCount(owner);

    const outcome = await callEntryPoint(link.token, [key('raw'), 1, ref(), 'Raw Payer', null, null]);

    expect(outcome.ok).toBe(false);
    expect((outcome as any).code).toBe('22023');
    expect(await paymentCount(owner)).toBe(before);
  });

  it('A8 the pre-R3 entry point signature no longer exists', async () => {
    const outcome = await withScopedDb({ kind: 'none' }, async (_db, sql) => {
      await sql.unsafe('SAVEPOINT r3_a8').catch(() => {});
      try {
        await sql.unsafe(`select * from auth_public_submit_payment($1, 100, 'R', 'P')`, ['x']);
        return { ok: true as const };
      } catch (e: any) {
        return { ok: false as const, code: e?.code as string };
      } finally {
        await sql.unsafe('ROLLBACK TO SAVEPOINT r3_a8').catch(() => {});
      }
    });
    expect(outcome.ok).toBe(false);
    expect((outcome as any).code).toBe('42883'); // undefined_function — fail closed
  });
});

// ===========================================================================
// B. Submission idempotency
// ===========================================================================
describe('R3 — a submission and its retries are one submission', () => {
  it('B1 the same key replays the original outcome byte-for-byte', async () => {
    const stu = await createStudent(owner.jar, 'B1');
    const inv = await createInvoice(owner.jar, stu.id, 600_000);
    const link = await createLink(owner.jar, { invoiceId: inv.id, amountKobo: 600_000 });
    const k = key('same');
    const body = { payerName: 'Ada Parent', payerPhone: '08012345678', reference: ref() };
    const before = await paymentCount(owner);
    const audits = await auditCount(owner, 'payment.pending');

    const first = await submit(link.token, body, k);
    const second = await submit(link.token, body, k);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(second.data).toEqual(first.data);
    expect(await paymentCount(owner)).toBe(before + 1);
    expect(await auditCount(owner, 'payment.pending')).toBe(audits + 1);
  });

  it('B2 a different key with the same reference is still the same submission', async () => {
    const stu = await createStudent(owner.jar, 'B2');
    const inv = await createInvoice(owner.jar, stu.id, 300_000);
    const link = await createLink(owner.jar, { invoiceId: inv.id, amountKobo: 300_000 });
    const body = { payerName: 'Ada Parent', reference: ref('SAME-REF') };
    const before = await paymentCount(owner);

    // Same phone, different device, same bank reference: a retry, not a fraud.
    const first = await submit(link.token, body, key('dev1'));
    const second = await submit(link.token, { ...body, payerPhone: '08099999999' }, key('dev2'));

    expect(first.status).toBe(201);
    expect([200, 409]).toContain(second.status);
    expect(await paymentCount(owner)).toBe(before + 1);
  });

  it('B3 a submission without a key is refused and records nothing', async () => {
    const stu = await createStudent(owner.jar, 'B3');
    const inv = await createInvoice(owner.jar, stu.id, 250_000);
    const link = await createLink(owner.jar, { invoiceId: inv.id, amountKobo: 250_000 });
    const before = await paymentCount(owner);

    const r = await submit(link.token, { payerName: 'Ada Parent', reference: ref() }, null);

    expect(r.status).toBe(400);
    expect(r.data.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(await paymentCount(owner)).toBe(before);
  });

  it('B4 a too-short key is refused', async () => {
    const stu = await createStudent(owner.jar, 'B4');
    const inv = await createInvoice(owner.jar, stu.id, 250_000);
    const link = await createLink(owner.jar, { invoiceId: inv.id, amountKobo: 250_000 });
    const before = await paymentCount(owner);

    const r = await submit(link.token, { payerName: 'Ada Parent', reference: ref() }, 'short');

    expect(r.status).toBe(400);
    expect(await paymentCount(owner)).toBe(before);
  });

  it('B5 reusing a key for a different reference is refused, not silently swallowed', async () => {
    const stu = await createStudent(owner.jar, 'B5');
    const inv = await createInvoice(owner.jar, stu.id, 900_000);
    const link = await createLink(owner.jar, { invoiceId: inv.id, amountKobo: 900_000 });
    const k = key('reuse');
    const before = await paymentCount(owner);

    const first = await submit(link.token, { payerName: 'Ada Parent', reference: ref() }, k);
    const second = await submit(link.token, { payerName: 'Ada Parent', reference: ref() }, k);

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(await paymentCount(owner)).toBe(before + 1);
  });
});

// ===========================================================================
// C. Bounded submissions
// ===========================================================================
describe('R3 — submissions are bounded', () => {
  it('C1 a link may leave at most five submissions awaiting reconciliation', async () => {
    const stu = await createStudent(owner.jar, 'C1');
    const inv = await createInvoice(owner.jar, stu.id, 5_000_000);
    const link = await createLink(owner.jar, { invoiceId: inv.id, amountKobo: 100_000 });

    const accepted: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await submit(link.token, { payerName: `Parent ${i}`, reference: ref('C1') });
      expect(r.status).toBe(201);
      accepted.push(r.data.payment.paymentNumber);
    }

    const blocked = await submit(link.token, { payerName: 'Parent 6', reference: ref('C1') });
    expect(blocked.status).toBe(429);
    expect(blocked.data.error.code).toBe('TOO_MANY_REQUESTS');
    expect(await pendingCount(owner, link.id)).toBe(5);

    // The bound is the queue, not a lifetime lock: once staff process one
    // submission the link accepts the next genuine one.
    const paymentId = await asTenant(owner, async (sql) => {
      const rows = (await sql`select id from payments where payment_number = ${accepted[0]}`) as any[];
      return rows[0].id as string;
    });
    await confirmPayment(owner.jar, paymentId);
    const after = await submit(link.token, { payerName: 'Parent 7', reference: ref('C1') });
    expect(after.status).toBe(201);
  });

  it('C2 a single link accepts at most ten submissions per hour', async () => {
    const stu = await createStudent(owner.jar, 'C2');
    const inv = await createInvoice(owner.jar, stu.id, 9_000_000);
    const link = await createLink(owner.jar, { invoiceId: inv.id, amountKobo: 50_000 });

    let accepted = 0;
    for (let i = 0; i < 10; i += 1) {
      const r = await submit(link.token, { payerName: `Parent ${i}`, reference: ref('C2') });
      if (r.status !== 201) throw new Error(`submission ${i} rejected: ${r.status} ${JSON.stringify(r.data)}`);
      accepted += 1;
      // Clear the backlog so the hourly bound is the one under test.
      const paymentId = await asTenant(owner, async (sql) => {
        const rows = (await sql`select id from payments where payment_number = ${r.data.payment.paymentNumber}`) as any[];
        return rows[0].id as string;
      });
      await confirmPayment(owner.jar, paymentId);
    }
    expect(accepted).toBe(10);

    const eleventh = await submit(link.token, { payerName: 'Parent 11', reference: ref('C2') });
    expect(eleventh.status).toBe(429);
    expect(eleventh.data.error.code).toBe('TOO_MANY_REQUESTS');
  });

  it('C3 the platform budget bounds even forged-token traffic', async () => {
    const bogus = `nope-${uuid()}`;
    let refused = 0;
    let last: any = null;
    for (let i = 0; i < 125; i += 1) {
      const r = await submit(bogus, { payerName: 'Nobody', reference: ref('C3') });
      last = r;
      if (r.status === 429) { refused += 1; break; }
      expect(r.status).toBe(404);
    }
    expect(refused).toBe(1);
    expect(last.data.error.code).toBe('TOO_MANY_REQUESTS');
  }, 120_000);
});

// ===========================================================================
// D. The bearer secret is never persisted
// ===========================================================================
describe('R3 — the bearer token never reaches stored row data', () => {
  it('D1 a submission stores provenance, never the token', async () => {
    const stu = await createStudent(owner.jar, 'D1');
    const inv = await createInvoice(owner.jar, stu.id, 800_000);
    const link = await createLink(owner.jar, { invoiceId: inv.id, amountKobo: 800_000 });

    const r = await submit(link.token, { payerName: 'Ada Parent', reference: ref('D1') });
    expect(r.status).toBe(201);

    // The authenticating path is in scope too: creating the link must not have
    // written the token into the audit trail either (R3 measured that it did).
    const createAudit = await asTenant(owner, async (sql) => {
      const rows = (await sql.unsafe(
        `select count(*)::int as n from audit_events
          where action in ('payment_link.create', 'payment_link.revoke')
            and strpos(row_to_json(audit_events)::text, $1) > 0`,
        [link.token],
      )) as any[];
      return Number(rows[0].n);
    });
    expect(createAudit, 'link management audit rows persisted the raw token').toBe(0);

    const scanned = await asTenant(owner, async (sql) => {
      const tables = [
        'payments',
        'audit_events',
        'receipts',
        'reversals',
        'payment_allocations',
        'reconciliation_cases',
        'reconciliation_evidence',
        'reconciliation_candidates',
        'collections_cases',
        'collections_case_events',
        'reminders',
        'idempotency_keys',
      ];
      const hits: Record<string, number> = {};
      for (const table of tables) {
        // strpos, not LIKE: a nanoid token may contain `_` or `%`, which would
        // turn a LIKE pattern into a wildcard match and produce a false leak.
        const rows = (await sql.unsafe(
          `select count(*)::int as n from ${table} where strpos(row_to_json(${table})::text, $1) > 0`,
          [link.token],
        )) as any[];
        hits[table] = Number(rows[0].n);
      }
      const pay = (await sql`select notes, link_id from payments where payment_number = ${r.data.payment.paymentNumber}`) as any[];
      const aud = (await sql`select metadata, after from audit_events where entity_id = (select id from payments where payment_number = ${r.data.payment.paymentNumber})`) as any[];
      return { hits, pay: pay[0], aud: aud[0] };
    });

    for (const [table, n] of Object.entries(scanned.hits)) {
      expect(n, `${table} persisted the raw bearer token`).toBe(0);
    }
    expect(scanned.pay.link_id).toBe(link.id);
    expect(String(scanned.pay.notes)).toContain(link.id);
    expect(String(scanned.pay.notes)).not.toContain(link.token);
    expect(scanned.aud.metadata.linkId).toBe(link.id);
    expect(scanned.aud.metadata.linkFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(String(scanned.aud.metadata.linkFingerprint)).not.toContain(link.token);
  });

  it('D2 the fingerprint correlates submissions without being the token', async () => {
    const stu = await createStudent(owner.jar, 'D2');
    const inv = await createInvoice(owner.jar, stu.id, 700_000);
    const linkA = await createLink(owner.jar, { invoiceId: inv.id, amountKobo: 100_000 });
    const linkB = await createLink(owner.jar, { invoiceId: inv.id, amountKobo: 100_000 });

    const a1 = await submit(linkA.token, { payerName: 'Parent A', reference: ref('D2') });
    const a2 = await submit(linkA.token, { payerName: 'Parent A', reference: ref('D2') });
    const b1 = await submit(linkB.token, { payerName: 'Parent B', reference: ref('D2') });
    expect([a1.status, a2.status, b1.status]).toEqual([201, 201, 201]);

    const prints = await asTenant(owner, async (sql) => {
      const rows = (await sql`select metadata->>'linkFingerprint' as fp, metadata->>'linkId' as link_id
        from audit_events where action = 'payment.pending' and metadata->>'linkId' in (${linkA.id}, ${linkB.id})`) as any[];
      return rows.map((r) => ({ fp: r.fp as string, linkId: r.link_id as string }));
    });
    expect(prints.length).toBe(3);

    // The fingerprint is a stable, non-reversible correlation tag: both
    // submissions on one link share it, the other link has its own, and the
    // token is not recoverable from it.
    const fpByLink = new Map<string, Set<string>>();
    for (const row of prints) {
      const set = fpByLink.get(row.linkId) ?? new Set<string>();
      set.add(row.fp);
      fpByLink.set(row.linkId, set);
    }
    expect(fpByLink.get(linkA.id)?.size).toBe(1);
    expect(fpByLink.get(linkB.id)?.size).toBe(1);
    expect([...fpByLink.values()].flatMap((v) => [...v]).length).toBe(2);
    for (const row of prints) {
      expect(row.fp, 'the fingerprint must be 16 hex characters').toMatch(/^[0-9a-f]{16}$/);
      expect(row.fp).not.toContain(linkA.token);
      expect(row.fp).not.toContain(linkB.token);
    }
  });
});

// ===========================================================================
// E. The surface discloses only what a payer needs
// ===========================================================================
describe('R3 — public responses are minimised', () => {
  it('E1 the view payload contains exactly the payer-facing fields', async () => {
    const stu = await createStudent(owner.jar, 'E1');
    const inv = await createInvoice(owner.jar, stu.id, 1_200_000);
    const link = await createLink(owner.jar, { invoiceId: inv.id, amountKobo: 1_200_000 });

    const v = await view(link.token);

    expect(v.status).toBe(200);
    expect(Object.keys(v.data).sort()).toEqual(
      ['amountDueKobo', 'expiresAt', 'invoice', 'note', 'organization', 'student'].sort(),
    );
    expect(Object.keys(v.data.invoice).sort()).toEqual(
      ['invoiceNumber', 'studentFirstName', 'studentInitial'].sort(),
    );
    expect(Object.keys(v.data.organization).sort()).toEqual(['name', 'phone'].sort());
    expect(v.data.amountDueKobo).toBe(1_200_000);
    const serialised = JSON.stringify(v.data);
    expect(serialised).not.toContain(link.token);
    expect(serialised).not.toContain(stu.studentId);
    expect(serialised).not.toContain('Okafor');
  });

  it('E2 the submit response contains exactly the acknowledgement fields', async () => {
    const stu = await createStudent(owner.jar, 'E2');
    const inv = await createInvoice(owner.jar, stu.id, 150_000);
    const link = await createLink(owner.jar, { invoiceId: inv.id, amountKobo: 150_000 });

    const r = await submit(link.token, { payerName: 'Ada Parent', reference: ref('E2') });

    expect(r.status).toBe(201);
    expect(Object.keys(r.data)).toEqual(['payment']);
    expect(Object.keys(r.data.payment).sort()).toEqual(['amountKobo', 'paymentNumber', 'status'].sort());
    expect(JSON.stringify(r.data)).not.toContain(link.token);
  });

  it('E3 failures never echo database internals', async () => {
    const stu = await createStudent(owner.jar, 'E3');
    const inv = await createInvoice(owner.jar, stu.id, 200_000);
    const link = await createLink(owner.jar, { invoiceId: inv.id, amountKobo: 200_000 });
    const forbidden = /(submission |row-level security|constraint|relation|SQLSTATE|pg_|policy|column |violates)/i;

    const cases = [
      await submit(link.token, { payerName: '   ', reference: ref('E3') }),
      await submit(link.token, { payerName: 'Ada Parent', reference: '   ' }),
      await submit(link.token, { payerName: 'x'.repeat(200), reference: ref('E3') }),
      await submit(link.token, '{not json', key('E3')),
    ];
    for (const c of cases) {
      expect(c.status).toBeGreaterThanOrEqual(400);
      const message = String((c.data as any)?.error?.message ?? '');
      expect(message, `leaked internals: ${message}`).not.toMatch(forbidden);
      expect(JSON.stringify(c.data)).not.toMatch(forbidden);
    }
  });
});

// ===========================================================================
// F. Public context cannot write to the ledger directly
// ===========================================================================
describe('R3 — public context has no direct write path', () => {
  it('F1 a bearer cannot INSERT a payment directly', async () => {
    const stu = await createStudent(owner.jar, 'F1');
    const inv = await createInvoice(owner.jar, stu.id, 500_000);
    const link = await createLink(owner.jar, { invoiceId: inv.id, amountKobo: 500_000 });
    const before = await paymentCount(owner);

    const attempts = await withPublicScope(link.token, async (_db, sql) => {
      const out: Record<string, string> = {};
      for (const [label, statement] of [
        ['bank_transfer', `INSERT INTO payments (organization_id, method, status, amount_kobo, reference, payer_name)
                             VALUES ('${owner.orgId}', 'BANK_TRANSFER', 'PENDING', 999, 'DIRECT-1', 'Direct')`],
        ['cash', `INSERT INTO payments (organization_id, method, status, amount_kobo, reference, payer_name)
                    VALUES ('${owner.orgId}', 'CASH', 'PENDING', 999, 'DIRECT-2', 'Direct')`],
        ['confirmed', `INSERT INTO payments (organization_id, method, status, amount_kobo, reference, payer_name)
                         VALUES ('${owner.orgId}', 'BANK_TRANSFER', 'CONFIRMED', 999, 'DIRECT-3', 'Direct')`],
        ['audit', `INSERT INTO audit_events (organization_id, actor_type, action, entity_type, entity_id, after, metadata)
                     VALUES ('${owner.orgId}', 'USER', 'payment.pending', 'payment', gen_random_uuid(), '{}'::jsonb, '{}'::jsonb)`],
        ['keys', `INSERT INTO public_submission_keys (organization_id, link_id, key_hash, reference_hash, payment_id, payment_number, amount_kobo)
                    VALUES ('${owner.orgId}', '${link.id}', repeat('a',64), repeat('b',64), gen_random_uuid(), 'PMT-X', 1)`],
        ['keys_select', `SELECT count(*) FROM public_submission_keys`],
      ] as Array<[string, string]>) {
        await sql.unsafe('SAVEPOINT r3f').catch(() => {});
        try {
          await sql.unsafe(statement);
          out[label] = 'ALLOWED';
        } catch (e: any) {
          out[label] = String(e?.code ?? 'error');
        }
        await sql.unsafe('ROLLBACK TO SAVEPOINT r3f').catch(() => {});
      }
      return out;
    });

    for (const [label, outcome] of Object.entries(attempts)) {
      expect(outcome, `public context was allowed to run: ${label}`).not.toBe('ALLOWED');
    }
    expect(await paymentCount(owner)).toBe(before);
  });

  it('F2 a forged context cannot write either', async () => {
    const before = await paymentCount(owner);
    const outcome = await withScopedDb({ kind: 'none' }, async (_db, sql) => {
      await sql.unsafe(`select set_config('app.organization_id', '${owner.orgId}', true)`);
      await sql.unsafe(`select set_config('app.public_context', '1', true)`);
      await sql.unsafe(`select set_config('app.public_proof', 'forged', true)`);
      await sql.unsafe('SAVEPOINT r3_f2').catch(() => {});
      try {
        await sql.unsafe(`INSERT INTO payments (organization_id, method, status, amount_kobo, reference, payer_name)
                            VALUES ('${owner.orgId}', 'BANK_TRANSFER', 'PENDING', 1234, 'FORGED-1', 'Forged')`);
        return 'ALLOWED';
      } catch (e: any) {
        return String(e?.code ?? 'error');
      } finally {
        await sql.unsafe('ROLLBACK TO SAVEPOINT r3_f2').catch(() => {});
      }
    });
    expect(outcome).not.toBe('ALLOWED');
    expect(await paymentCount(owner)).toBe(before);
  });

  it('F3 the sanctioned entry point still works (the contrast)', async () => {
    const stu = await createStudent(owner.jar, 'F3');
    const inv = await createInvoice(owner.jar, stu.id, 100_000);
    const link = await createLink(owner.jar, { invoiceId: inv.id, amountKobo: 100_000 });

    const r = await submit(link.token, { payerName: 'Ada Parent', reference: ref('F3') });

    expect(r.status).toBe(201);
    expect(r.data.payment.status).toBe('PENDING');
  });
});

// ===========================================================================
// G. Isolation and ledger non-interference
// ===========================================================================
describe('R3 — isolation and ledger non-interference', () => {
  it('G1 a submission on another tenant\'s link never touches this tenant', async () => {
    const theirStudent = await createStudent(otherOrg.jar, 'G1');
    const theirInvoice = await createInvoice(otherOrg.jar, theirStudent.id, 350_000);
    const theirLink = await createLink(otherOrg.jar, { invoiceId: theirInvoice.id, amountKobo: 350_000 });
    const mineBefore = await paymentCount(owner);

    const r = await submit(theirLink.token, { payerName: 'Their Parent', reference: ref('G1') });
    expect(r.status).toBe(201);

    // The payment exists in their tenant and nowhere else.
    expect(await paymentCount(owner)).toBe(mineBefore);
    const theirs = await asTenant(otherOrg, async (sql) => {
      const rows = (await sql`select count(*)::int as n, max(link_id::text) as link from payments
        where payment_number = ${r.data.payment.paymentNumber}`) as any[];
      return rows[0];
    });
    expect(Number(theirs.n)).toBe(1);
    expect(theirs.link).toBe(theirLink.id);
  });

  it('G2 a payment cannot reference another tenant\'s link (composite FK)', async () => {
    const theirStudent = await createStudent(otherOrg.jar, 'G2');
    const theirInvoice = await createInvoice(otherOrg.jar, theirStudent.id, 120_000);
    const theirLink = await createLink(otherOrg.jar, { invoiceId: theirInvoice.id, amountKobo: 120_000 });

    const outcome = await asTenant(owner, async (sql) => {
      await sql.unsafe('SAVEPOINT r3_g2').catch(() => {});
      try {
        await sql.unsafe(
          `INSERT INTO payments (organization_id, method, status, amount_kobo, reference, payer_name, link_id)
             VALUES ('${owner.orgId}', 'BANK_TRANSFER', 'PENDING', 1, 'CROSS-LINK', 'Cross', '${theirLink.id}')`,
        );
        return { ok: true as const };
      } catch (e: any) {
        return { ok: false as const, code: e?.code as string, message: String(e?.message ?? '') };
      } finally {
        await sql.unsafe('ROLLBACK TO SAVEPOINT r3_g2').catch(() => {});
      }
    });
    expect(outcome.ok).toBe(false);
    expect((outcome as any).code).toBe('23503');
    expect(String((outcome as any).message)).toContain('payments__link_id__org_fkey');
  });

  it('G3 the public surface never moved money', async () => {
    const stu = await createStudent(owner.jar, 'G3');
    const inv = await createInvoice(owner.jar, stu.id, 1_500_000);
    const link = await createLink(owner.jar, { invoiceId: inv.id, amountKobo: 250_000 });

    const first = await submit(link.token, { payerName: 'Ada Parent', reference: ref('G3') });
    expect(first.status).toBe(201);

    const state = await asTenant(owner, async (sql) => {
      const pay = (await sql`select id, status, amount_kobo, unallocated_kobo from payments
        where payment_number = ${first.data.payment.paymentNumber}`) as any[];
      const alloc = (await sql`select count(*)::int as n from payment_allocations
        where payment_id = ${pay[0].id}::uuid`) as any[];
      const receipts = (await sql`select count(*)::int as n from receipts
        where payment_id = ${pay[0].id}::uuid`) as any[];
      const invRow = (await sql`select paid_kobo, status from invoices where id = ${inv.id}::uuid`) as any[];
      const sum = (await sql`select coalesce(sum(a.amount_kobo),0)::bigint as v
        from payment_allocations a where a.invoice_id = ${inv.id}::uuid and a.status = 'ACTIVE'`) as any[];
      return { pay: pay[0], alloc: Number(alloc[0].n), receipts: Number(receipts[0].n), inv: invRow[0], sum: Number(sum[0].v) };
    });

    expect(state.pay.status).toBe('PENDING');
    expect(Number(state.pay.unallocated_kobo)).toBe(0);
    expect(state.alloc).toBe(0);
    expect(state.receipts).toBe(0);
    expect(Number(state.inv.paid_kobo)).toBe(0);
    expect(Number(state.inv.paid_kobo)).toBe(state.sum);
  });

  it('G4 the amount resolver fails closed and writes nothing', async () => {
    const stu = await createStudent(owner.jar, 'G4');
    const inv = await createInvoice(owner.jar, stu.id, 220_000);
    const link = await createLink(owner.jar, { invoiceId: inv.id, amountKobo: 220_000 });
    const before = await paymentCount(owner);

    const outcomes = await withScopedDb({ kind: 'none' }, async (_db, sql) => {
      const read = async (t: string) => {
        const rows = (await sql.unsafe(`select auth_public_amount_due($1) as due`, [t])) as any[];
        return rows[0]?.due ?? null;
      };
      const active = await read(link.token);
      const unknown = await read(`nope-${uuid()}`);
      const empty = await read('');
      return { active, unknown, empty };
    });

    expect(Number(outcomes.active)).toBe(220_000);
    expect(outcomes.unknown).toBeNull();
    expect(outcomes.empty).toBeNull();
    expect(await paymentCount(owner)).toBe(before);
  });
});
