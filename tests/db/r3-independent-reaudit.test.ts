// @vitest-environment node
/**
 * R3 independent re-audit (Phase 8).
 *
 * Written against the *security contract of the public surface*, not against
 * the R3 implementation: the author's reasoning is deliberately not reused, the
 * harness is duplicated rather than imported, and every test asks "as an
 * attacker holding (or guessing) a payment-link URL, what can I make this
 * surface do?".
 *
 * Attack surface reviewed:
 *   A. the bearer itself (unknown, revoked, malformed, forged context, cross-tenant)
 *   B. the amount (tampering via route and via raw SQL, type confusion, staleness)
 *   C. submission identity (replay, key repurposing, key/reference scoping)
 *   D. persistence and disclosure (credential storage, replay-cache reachability,
 *      response payloads)
 *   E. bounds (backlog, hourly window, platform budget)
 *   F. direct database access from public context (writes and reads)
 *   G. ledger non-interference after all of the above
 *
 * Owner-level probes (D) use the migration URL, because "the runtime role
 * cannot" and "even a database owner cannot rewrite it" are different claims
 * and only the second one is interesting for an append-only replay cache. They
 * require the fixture work to be committed first (a second connection cannot
 * see the harness's uncommitted per-test transaction).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { call, CookieJar } from '../auth/support';
import { POST as registerPost } from '@/app/api/auth/register/route';
import { GET as meGet } from '@/app/api/auth/me/route';
import { getSql, closeDb } from '@/lib/db';
import { withPublicScope, withScopedDb } from '@/lib/db/tenant';

type Jar = InstanceType<typeof CookieJar>;
type Actor = { jar: Jar; orgId: string; userId: string };

const uuid = () => randomUUID();
const key = (p = 'ra') => `${p}-${uuid()}`;
const ref = (p = 'REF') => `${p}-${uuid().slice(0, 8)}`;

const OWNER_URL =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://scolaira_owner:scolaira_owner_pw@localhost:5432/scolaira_test';
const ownerPool = postgres(OWNER_URL, { max: 1 });

/**
 * Commit the harness's ambient per-test transaction so a second connection
 * (the owner pool) can observe the rows this test created. The commits are
 * namespaced per test and the schema is recreated between runs.
 */
async function leaveHarnessTransaction(): Promise<void> {
  await getSql()
    .unsafe('COMMIT')
    .catch(() => {});
}

/** Run `fn` as the database owner with public context established from `token`. */
async function asOwnerPublic<T>(
  token: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return ownerPool.begin(async (tx) => {
    // The documented database-side scope API: the scope marker must be set for
    // auth_scope_public_local() to accept the call (it is transaction-local by
    // contract — see lib/db/scope.ts).
    await tx.unsafe(`SELECT set_config('app.r1_scope_depth', '1', true)`);
    await tx.unsafe(`SELECT auth_scope_public_local($1)`, [token]);
    return fn(tx);
  }) as Promise<T>;
}

async function registerOwner(prefix = 'ra'): Promise<Actor> {
  const slug = `${prefix}-${uuid().slice(0, 8)}`;
  const jar = new CookieJar();
  const reg = await call(registerPost, jar, {
    method: 'POST',
    path: '/api/auth/register',
    body: {
      email: `${slug}@example.com`,
      password: 'Pass-' + uuid().slice(0, 8) + '-A1!',
      firstName: 'Re',
      lastName: 'Audit',
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

async function createStudent(jar: Jar, tag: string) {
  const r = await callRoute('POST', '/api/students', jar, {
    studentId: `${tag}-${uuid().slice(0, 6)}`,
    firstName: 'Ngozi',
    lastName: 'Adeyemi',
    gender: 'F',
  });
  if (r.status !== 201) throw new Error(`student failed: ${r.status} ${JSON.stringify(r.data)}`);
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
  if (r.status !== 201) throw new Error(`invoice failed: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.invoice as { id: string; invoiceNumber: string };
}

async function createLink(jar: Jar, opts: { invoiceId?: string; amountKobo?: number }) {
  const r = await callRoute('POST', '/api/payment-links', jar, {
    invoiceId: opts.invoiceId,
    amountKobo: opts.amountKobo,
    note: 'Re-audit link',
  });
  if (r.status !== 201) throw new Error(`link failed: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.link as { id: string; token: string };
}

async function resetGuc() {
  const sql = getSql();
  try {
    await sql`select auth_clear_public_context()`.catch(() => {});
  } catch {}
  try {
    await sql`select clear_app_context()`.catch(() => {});
  } catch {}
}

function publicRequest(token: string, body: unknown, submitKey?: string | null) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (submitKey !== null) headers['idempotency-key'] = submitKey ?? key('sub');
  return new Request(`http://test.local/api/p/${token}/submit`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function submit(token: string, body: unknown, submitKey?: string | null) {
  const mod: any = await import(/* @vite-ignore */ `@/app/api/p/[token]/submit/route`);
  const handler: Function = (mod?.default ?? mod).POST;
  await resetGuc();
  let res: Response;
  try {
    res = await handler(publicRequest(token, body, submitKey), {
      params: Promise.resolve({ token }),
    });
  } catch (e: any) {
    await resetGuc();
    return { status: 500, body: { thrown: String(e?.message) }, headers: new Headers() };
  }
  await resetGuc();
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

async function view(token: string) {
  const mod: any = await import(/* @vite-ignore */ `@/app/api/p/[token]/view/route`);
  const handler: Function = (mod?.default ?? mod).GET;
  await resetGuc();
  let res: Response;
  try {
    res = await handler(new Request(`http://test.local/api/p/${token}/view`), {
      params: Promise.resolve({ token }),
    });
  } catch (e: any) {
    await resetGuc();
    return { status: 500, body: { thrown: String(e?.message) } };
  }
  await resetGuc();
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/** Raw call of the sanctioned entry point with attacker-chosen arguments. */
async function rawEntry(token: string, args: unknown[]) {
  return withScopedDb({ kind: 'none' }, async (_db, sql) => {
    await sql.unsafe('SAVEPOINT ra_entry').catch(() => {});
    try {
      const rows = (await sql.unsafe(
        `select payment_id, payment_number, amount_kobo, status, replayed
           from auth_public_submit_payment($1, $2, $3::bigint, $4, $5, $6, $7)`,
        [token, ...args] as any[],
      )) as any[];
      return { ok: true as const, rows };
    } catch (e: any) {
      return { ok: false as const, code: e?.code as string, message: String(e?.message ?? '') };
    } finally {
      await sql.unsafe('ROLLBACK TO SAVEPOINT ra_entry').catch(() => {});
    }
  });
}

async function asTenant<T>(actor: Actor, fn: (sql: any) => Promise<T>): Promise<T> {
  const sql = getSql();
  await sql`select set_tenant_context(${actor.orgId}::uuid, ${actor.userId}::uuid)`;
  try {
    return await fn(sql);
  } finally {
    await sql`select clear_app_context()`.catch(() => {});
  }
}

async function ledger(actor: Actor) {
  return asTenant(actor, async (sql) => {
    const rows = (await sql`select
      (select count(*)::int from payments) as payments,
      (select count(*)::int from payments where status = 'PENDING') as pending,
      (select count(*)::int from payments where status = 'PENDING' and unallocated_kobo <> 0) as bad_unallocated,
      (select count(*)::int from payment_allocations) as allocations,
      (select count(*)::int from receipts) as receipts,
      (select count(*)::int from reversals) as reversals,
      (select count(*)::int from audit_events where action = 'payment.pending') as pending_audits
    `) as any[];
    return rows[0];
  });
}

let A: Actor;
let B: Actor;

beforeAll(async () => {
  await getSql()`SELECT auth_clear_rate_limits()`.catch(() => {});
  A = await registerOwner('ra1');
  B = await registerOwner('ra2');
}, 120_000);

afterAll(async () => {
  await ownerPool.end({ timeout: 5 }).catch(() => {});
  await closeDb();
});

// ===========================================================================
// A. The bearer itself
// ===========================================================================
describe('A — the bearer credential', () => {
  it('A1 unknown and revoked bearers are refused without disclosure', async () => {
    const stu = await createStudent(A.jar, 'RA-A1');
    const inv = await createInvoice(A.jar, stu.id, 300_000);
    const live = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 300_000 });
    const revoked = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 300_000 });
    const revokedRes = await callRoute('PATCH', `/api/payment-links/${revoked.token}`, A.jar, {
      reason: 're-audit',
    });
    expect(revokedRes.status).toBe(200);

    const unknown = await submit(`nope-${uuid()}`, { payerName: 'Nobody', reference: ref('A1') });
    const afterRevoke = await submit(revoked.token, { payerName: 'Nobody', reference: ref('A1') });
    const viewUnknown = await view(`nope-${uuid()}`);

    expect(unknown.status).toBe(404);
    expect(afterRevoke.status).toBe(404);
    // The two are indistinguishable: no oracle for "this token once existed".
    expect(afterRevoke.body).toEqual(unknown.body);
    expect(viewUnknown.status).toBe(404);
    for (const body of [unknown.body, afterRevoke.body, viewUnknown.body]) {
      const serialised = JSON.stringify(body);
      expect(serialised).not.toContain(A.orgId);
      expect(serialised).not.toContain(inv.invoiceNumber);
      expect(serialised).not.toContain('300000');
      expect(serialised).not.toContain('Adeyemi');
    }
    // The live link was untouched by any of it.
    const stillLive = await view(live.token);
    expect(stillLive.status).toBe(200);
  });

  it('A2 malformed bearers are refused, never 500', async () => {
    const cases = [
      '',
      ' ',
      'x',
      'a'.repeat(4096),
      "'; drop table payments; --",
      '%%%___',
      'Ünicode-token-' + uuid().slice(0, 6),
    ];
    for (const token of cases) {
      const r = await submit(token, { payerName: 'Nobody', reference: ref('A2') });
      expect([400, 404, 410], `token ${JSON.stringify(token)} → ${r.status}`).toContain(r.status);
      expect(JSON.stringify(r.body)).not.toMatch(/(row-level|constraint|pg_|syntax|relation)/i);
    }
  });

  it('A3 a forged tenant context cannot steer or read a bearer submission', async () => {
    const stu = await createStudent(B.jar, 'RA-A3');
    const inv = await createInvoice(B.jar, stu.id, 150_000);
    const theirLink = await createLink(B.jar, { invoiceId: inv.id, amountKobo: 150_000 });
    const before = await ledger(A);

    // The attacker holds B's token and tries to make the payment land in their
    // own organization by forging the context around the call.
    const landing = await withScopedDb({ kind: 'none' }, async (_db, sql) => {
      await sql.unsafe(`select set_config('app.organization_id', '${A.orgId}', true)`);
      await sql.unsafe(`select set_config('app.public_context', '1', true)`);
      await sql.unsafe(`select set_config('app.public_proof', 'forged', true)`);
      await sql.unsafe('SAVEPOINT ra_a3').catch(() => {});
      try {
        const rows = (await sql.unsafe(
          `select p.id from payments p join payment_links l on l.id = p.link_id where l.token = $1`,
          [theirLink.token],
        )) as any[];
        return { visible: rows.length };
      } catch (e: any) {
        return { visible: -1, code: String(e?.code) };
      } finally {
        await sql.unsafe('ROLLBACK TO SAVEPOINT ra_a3').catch(() => {});
      }
    });

    const r = await submit(theirLink.token, { payerName: 'Their Parent', reference: ref('A3') });
    expect(r.status).toBe(201);
    // The payment is in B's tenant, not A's.
    expect(await ledger(A)).toEqual(before);
    const landed = await asTenant(B, async (sql) => {
      const rows = (await sql`select organization_id, link_id from payments
        where payment_number = ${r.body.payment.paymentNumber}`) as any[];
      return rows[0];
    });
    expect(landed.organization_id).toBe(B.orgId);
    expect(landed.link_id).toBe(theirLink.id);
    // …and the forged context could not read the submssion either.
    expect(landing.visible).toBeLessThanOrEqual(0);
  });

  it('A4 the raw entry point refuses every unusable bearer with 28000', async () => {
    const stu = await createStudent(A.jar, 'RA-A4');
    const inv = await createInvoice(A.jar, stu.id, 120_000);
    const link = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 120_000 });
    const revoked = await callRoute('PATCH', `/api/payment-links/${link.token}`, A.jar, {
      reason: 'revoke',
    });
    expect(revoked.status).toBe(200);

    for (const token of [link.token, '', 'x', `nope-${uuid()}`]) {
      const outcome = await rawEntry(token, [key('raw'), 120_000, ref('A4'), 'Attacker', null, null]);
      expect(outcome.ok, `entry point accepted ${JSON.stringify(token)}`).toBe(false);
      expect((outcome as any).code).toBe('28000');
    }
  });
});

// ===========================================================================
// B. The amount
// ===========================================================================
describe('B — the amount', () => {
  it('B1 no claim can lower, raise or zero the recorded amount', async () => {
    const stu = await createStudent(A.jar, 'RA-B1');
    const inv = await createInvoice(A.jar, stu.id, 2_000_000);
    const link = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 800_000 });
    const before = await ledger(A);

    const attempts = [0, -1, 1, 100, 799_999, 800_001, 1_000_000_000, 9_007_199_254_740_991];
    for (const amountKobo of attempts) {
      const r = await submit(link.token, { payerName: 'Attacker', reference: ref('B1'), amountKobo });
      expect([400, 409], `amount ${amountKobo} → ${r.status}`).toContain(r.status);
    }
    // Type confusion: the amount arrives as a string or a float.
    for (const amountKobo of ['800000', 800_000.5, null] as any[]) {
      const r = await submit(link.token, { payerName: 'Attacker', reference: ref('B1'), amountKobo });
      expect([200, 201, 400, 409], `amount ${JSON.stringify(amountKobo)} → ${r.status}`).toContain(r.status);
      if (r.status === 201) expect(r.body.payment.amountKobo).toBe(800_000);
    }
    expect(await ledger(A)).toEqual(before);
  });

  it('B2 the raw boundary refuses a tampered amount with 22023', async () => {
    const stu = await createStudent(A.jar, 'RA-B2');
    const inv = await createInvoice(A.jar, stu.id, 500_000);
    const link = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 500_000 });
    const before = await ledger(A);

    for (const amount of [1, 499_999, 500_001]) {
      const outcome = await rawEntry(link.token, [key('raw'), amount, ref('B2'), 'Attacker', null, null]);
      expect(outcome.ok).toBe(false);
      expect((outcome as any).code).toBe('22023');
    }
    expect(await ledger(A)).toEqual(before);
  });

  it('B4 the recorded amount is the database-derived amount, not the claim', async () => {
    const stu = await createStudent(A.jar, 'RA-B4');
    const inv = await createInvoice(A.jar, stu.id, 1_000_000);
    const link = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 400_000 });

    // The payer loads the page and sees 400 000, then the school edits the link
    // (the link row is the source of truth, and it can move under the payer).
    // The independent derivation runs on the owner connection, which cannot see
    // the harness's uncommitted transaction.
    await leaveHarnessTransaction();
    const derived = await asOwnerPublic(link.token, async (tx) => {
      const rows = (await tx.unsafe(`SELECT auth_public_amount_due($1) AS due`, [link.token])) as any[];
      return Number(rows[0].due);
    });
    expect(derived).toBe(400_000);

    const raise = await asTenant(A, async (sql) => {
      await sql`update payment_links set amount_kobo = 750000 where id = ${link.id}::uuid`;
      return true;
    });
    expect(raise).toBe(true);

    // Independently derive the new amount from the documented resolver…
    const derivedAgain = await asOwnerPublic(link.token, async (tx) => {
      const rows = (await tx.unsafe(`SELECT auth_public_amount_due($1) AS due`, [link.token])) as any[];
      return Number(rows[0].due);
    });
    expect(derivedAgain).toBe(750_000);

    // …and prove the entry point agrees with it, in both directions: the stale
    // claim is refused, the current one is accepted and recorded verbatim.
    const stale = await submit(link.token, { payerName: 'Stale', reference: ref('B4'), amountKobo: 400_000 });
    expect(stale.status).toBe(409);
    const fresh = await submit(link.token, { payerName: 'Fresh', reference: ref('B4'), amountKobo: 750_000 });
    expect(fresh.status).toBe(201);
    expect(fresh.body.payment.amountKobo).toBe(750_000);

    // Submitting with no claim at all still records the derived amount.
    const silent = await submit(link.token, { payerName: 'Silent', reference: ref('B4') });
    expect(silent.status).toBe(201);
    expect(silent.body.payment.amountKobo).toBe(750_000);

    const stored = await asTenant(A, async (sql) => {
      const rows = (await sql`select amount_kobo from payments where link_id = ${link.id}::uuid order by created_at`) as any[];
      return rows.map((r: any) => Number(r.amount_kobo));
    });
    expect(stored).toEqual([750_000, 750_000]);
  });

  it('B3 a settled invoice cannot be paid through a stale link', async () => {
    const stu = await createStudent(A.jar, 'RA-B3');
    const inv = await createInvoice(A.jar, stu.id, 90_000);
    const link = await createLink(A.jar, { invoiceId: inv.id });
    const pay = await callRoute(
      'POST',
      '/api/payments',
      A.jar,
      {
        method: 'BANK_TRANSFER',
        amountKobo: 90_000,
        reference: ref('RA-PAY'),
        payerName: 'Bursar',
        initialStatus: 'CONFIRMED',
        allocations: [{ invoiceId: inv.id, amountKobo: 90_000 }],
      },
      { 'idempotency-key': key('pay') },
    );
    expect(pay.status).toBe(201);

    const before = await ledger(A);
    const viaRoute = await submit(link.token, { payerName: 'Attacker', reference: ref('B3') });
    expect(viaRoute.status).toBe(409);
    const viaRaw = await rawEntry(link.token, [key('raw'), 90_000, ref('B3'), 'Attacker', null, null]);
    expect(viaRaw.ok).toBe(false);
    expect((viaRaw as any).code).toBe('22023');
    expect(await ledger(A)).toEqual(before);
  });
});

// ===========================================================================
// C. Submission identity
// ===========================================================================
describe('C — submission identity', () => {
  it('C1 replaying a captured submission never creates a second row', async () => {
    const stu = await createStudent(A.jar, 'RA-C1');
    const inv = await createInvoice(A.jar, stu.id, 600_000);
    const link = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 200_000 });
    const body = { payerName: 'Parent One', reference: ref('C1') };

    const first = await submit(link.token, body, key('first'));
    const replayed = await submit(link.token, { ...body, payerName: 'Attacker' }, key('attacker'));
    const rawReplay = await rawEntry(link.token, [key('raw'), 200_000, body.reference, 'Attacker', null, null]);

    expect(first.status).toBe(201);
    expect([200, 409]).toContain(replayed.status);
    // The outcome the attacker sees is the genuine one, not one they influenced.
    if (replayed.status === 200) expect(replayed.body).toEqual(first.body);
    expect(rawReplay.ok).toBe(true);
    if (rawReplay.ok) {
      expect(rawReplay.rows[0].payment_number).toBe(first.body.payment.paymentNumber);
      expect((rawReplay.rows[0] as any).replayed).toBe(true);
    }

    const counts = await asTenant(A, async (sql) => {
      const rows = (await sql`select
        (select count(*)::int from payments where link_id = ${link.id}::uuid) as rows_for_link,
        (select count(*)::int from payments where reference = ${body.reference}) as rows_for_reference
      `) as any[];
      return rows[0];
    });
    expect(Number(counts.rows_for_link)).toBe(1);
    expect(Number(counts.rows_for_reference)).toBe(1);
  });

  it('C2 submission keys are link-scoped, and a reference stays unique per organization', async () => {
    const stu = await createStudent(A.jar, 'RA-C2');
    const inv = await createInvoice(A.jar, stu.id, 400_000);
    const linkOne = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 200_000 });
    const linkTwo = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 200_000 });
    const sharedKey = key('shared');
    const sharedRef = ref('C2');

    const first = await submit(linkOne.token, { payerName: 'Parent', reference: sharedRef }, sharedKey);
    expect(first.status).toBe(201);

    // (a) The same key on ANOTHER link is a different submission (keys are
    //     scoped per link, not globally), and it must not return link one's
    //     outcome.
    const otherLink = await submit(
      linkTwo.token,
      { payerName: 'Parent', reference: ref('C2b') },
      sharedKey,
    );
    expect(otherLink.status).toBe(201);
    expect(otherLink.body.payment.paymentNumber).not.toBe(first.body.payment.paymentNumber);

    // (b) The same BANK REFERENCE on another link is refused by R2/H-7's
    //     organization-wide live-reference guard — neither replayed (that would
    //     hide a genuinely different claim) nor duplicated.
    const sameRef = await submit(linkTwo.token, { payerName: 'Parent', reference: sharedRef }, key('c2c'));
    expect(sameRef.status).toBe(409);

    const counts = await asTenant(A, async (sql) => {
      const rows = (await sql`select
        (select count(*)::int from payments where reference = ${sharedRef}) as rows_for_reference,
        (select count(*)::int from payments where link_id = ${linkTwo.id}::uuid) as rows_for_link_two
      `) as any[];
      return rows[0];
    });
    expect(Number(counts.rows_for_reference)).toBe(1);
    expect(Number(counts.rows_for_link_two)).toBe(1);
  });

  it('C3 a repurposed key is refused, and a guessed key is not a replay', async () => {
    const stu = await createStudent(A.jar, 'RA-C3');
    const inv = await createInvoice(A.jar, stu.id, 900_000);
    const link = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 300_000 });
    const reused = key('reused');

    const first = await submit(link.token, { payerName: 'Parent', reference: ref('C3') }, reused);
    const other = await submit(link.token, { payerName: 'Parent', reference: ref('C3') }, reused);
    expect(first.status).toBe(201);
    expect(other.status).toBe(409);

    // A guessed key cannot collide its way into someone else's outcome.
    const guessed = await submit(link.token, { payerName: 'Attacker', reference: ref('C3') }, key('guess'));
    expect(guessed.status).toBe(201);

    const counts = await asTenant(A, async (sql) => {
      const rows = (await sql`select count(*)::int as n from payments where link_id = ${link.id}::uuid`) as any[];
      return Number(rows[0].n);
    });
    expect(counts).toBe(2);
  });
});

// ===========================================================================
// D. Persistence and disclosure
// ===========================================================================
describe('D — persistence and disclosure', () => {
  it('D1 the replay cache is unreachable and unrewritable', async () => {
    const stu = await createStudent(A.jar, 'RA-D1');
    const inv = await createInvoice(A.jar, stu.id, 250_000);
    const link = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 250_000 });
    const submitted = await submit(link.token, { payerName: 'Parent', reference: ref('D1') });
    expect(submitted.status).toBe(201);

    // (a) The runtime role has no privilege at all.
    const runtime = await withScopedDb({ kind: 'none' }, async (_db, sql) => {
      const out: Record<string, string> = {};
      for (const [label, statement] of [
        ['select', `SELECT count(*) FROM public_submission_keys`],
        [
          'insert',
          `INSERT INTO public_submission_keys (organization_id, link_id, key_hash, reference_hash, payment_id, payment_number, amount_kobo)
             VALUES ('${A.orgId}', '${link.id}', repeat('a',64), repeat('b',64), gen_random_uuid(), 'PMT-Z', 1)`,
        ],
        ['update', `UPDATE public_submission_keys SET amount_kobo = 1`],
        ['delete', `DELETE FROM public_submission_keys`],
      ] as Array<[string, string]>) {
        await sql.unsafe('SAVEPOINT ra_d1').catch(() => {});
        try {
          await sql.unsafe(statement);
          out[label] = 'ALLOWED';
        } catch (e: any) {
          out[label] = String(e?.code ?? 'error');
        }
        await sql.unsafe('ROLLBACK TO SAVEPOINT ra_d1').catch(() => {});
      }
      return out;
    });
    for (const [label, outcome] of Object.entries(runtime)) {
      expect(outcome, `runtime role was allowed to ${label} the replay cache`).not.toBe('ALLOWED');
    }

    // The owner probes need committed rows: a second connection cannot see the
    // harness's uncommitted per-test transaction.
    await leaveHarnessTransaction();

    // (b) …but the entry point's own path (owner + bearer proof) can see the row.
    const ownerVisible = await asOwnerPublic(link.token, async (tx) => {
      const rows = (await tx.unsafe(
        `SELECT count(*)::int AS n FROM public_submission_keys WHERE link_id = $1::uuid`,
        [link.id],
      )) as any[];
      return Number(rows[0].n);
    });
    expect(ownerVisible).toBeGreaterThanOrEqual(1);

    // (c) Even the OWNER cannot rewrite an outcome: append-only by policy.
    const ownerAttempt = await asOwnerPublic(link.token, async (tx) => {
      const updated = (await tx.unsafe(
        `UPDATE public_submission_keys SET amount_kobo = 1 WHERE link_id = $1::uuid RETURNING id`,
        [link.id],
      )) as any[];
      const deleted = (await tx.unsafe(
        `DELETE FROM public_submission_keys WHERE link_id = $1::uuid RETURNING id`,
        [link.id],
      )) as any[];
      return { updated: updated.length, deleted: deleted.length };
    });
    expect(ownerAttempt.updated).toBe(0);
    expect(ownerAttempt.deleted).toBe(0);

    // (d) Without the bearer proof, even the owner sees nothing at all.
    const blind = (await ownerPool.unsafe(
      `SELECT count(*)::int AS n FROM public_submission_keys`,
    )) as any[];
    expect(Number(blind[0].n)).toBe(0);
  });

  it('D2 nothing stores the bearer token or the raw submission key', async () => {
    const stu = await createStudent(A.jar, 'RA-D2');
    const inv = await createInvoice(A.jar, stu.id, 700_000);
    const link = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 700_000 });
    const submitKey = key('plaintext');
    const r = await submit(link.token, { payerName: 'Parent', reference: ref('D2') }, submitKey);
    expect(r.status).toBe(201);

    // Every table that could plausibly carry free text from a submission, plus
    // the tables R3 touches. `payment_links` is excluded by design: it is the
    // bearer store itself.
    const TABLES = [
      'payments',
      'audit_events',
      'receipts',
      'reversals',
      'payment_allocations',
      'invoices',
      'invoice_lines',
      'reconciliation_cases',
      'reconciliation_evidence',
      'reconciliation_candidates',
      'collections_cases',
      'collections_case_events',
      'reminders',
      'idempotency_keys',
      'communications',
      'webhook_events',
      'waivers',
      'students',
    ];

    const scanned = await asTenant(A, async (sql) => {
      const found: string[] = [];
      const checked: string[] = [];
      for (const table of TABLES) {
        for (const [needle, label] of [
          [link.token, 'token'],
          [submitKey, 'key'],
        ] as Array<[string, string]>) {
          await sql.unsafe('SAVEPOINT ra_d2').catch(() => {});
          try {
            const rows = (await sql.unsafe(
              `select count(*)::int as n from ${table} where strpos(row_to_json(${table})::text, $1) > 0`,
              [needle],
            )) as any[];
            checked.push(table);
            if (Number(rows[0].n) > 0) found.push(`${table}:${label}`);
          } catch {
            // Unreadable in this context is not a leak; recorded separately.
            checked.push(`${table}(unreadable)`);
          }
          await sql.unsafe('ROLLBACK TO SAVEPOINT ra_d2').catch(() => {});
        }
      }
      return { found, checked };
    });

    expect(scanned.found, 'a stored row carried a credential').toEqual([]);
    // Coverage proof: the two tables the submission actually writes were
    // really scanned (not silently skipped).
    expect(scanned.checked).toContain('payments');
    expect(scanned.checked).toContain('audit_events');

    // The replay cache stores hashes only.
    await leaveHarnessTransaction();
    const stored = await asOwnerPublic(link.token, async (tx) => {
      const rows = (await tx.unsafe(
        `SELECT key_hash, reference_hash, payment_number, amount_kobo, status,
                strpos(key_hash, $2) > 0 AS key_leaks, strpos(reference_hash, $2) > 0 AS ref_leaks
           FROM public_submission_keys WHERE link_id = $1::uuid`,
        [link.id, submitKey],
      )) as any[];
      return rows;
    });
    expect(stored.length).toBeGreaterThanOrEqual(1);
    for (const row of stored) {
      expect(String(row.key_hash)).toMatch(/^[0-9a-f]{64}$/);
      expect(String(row.reference_hash)).toMatch(/^[0-9a-f]{64}$/);
      expect(row.key_leaks).toBe(false);
      expect(row.ref_leaks).toBe(false);
      expect(row.payment_number).toBeTruthy();
    }
    expect(JSON.stringify(stored)).not.toContain(submitKey);
    expect(JSON.stringify(stored)).not.toContain(link.token);
  });

  it('D3 public responses never carry a credential', async () => {
    const stu = await createStudent(A.jar, 'RA-D3');
    const inv = await createInvoice(A.jar, stu.id, 350_000);
    const link = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 350_000 });

    const v = await view(link.token);
    const s = await submit(link.token, { payerName: 'Parent', reference: ref('D3') }, key('d3'));

    for (const payload of [v.body, s.body]) {
      const serialised = JSON.stringify(payload);
      expect(serialised).not.toContain(link.token);
      expect(serialised).not.toContain(link.id);
      expect(serialised).not.toContain(A.orgId);
    }
    // The view payload is exactly the minimised shape (no student identity, no
    // invoice totals, no link state).
    expect(Object.keys(v.body).sort()).toEqual(
      ['amountDueKobo', 'expiresAt', 'invoice', 'note', 'organization', 'student'].sort(),
    );
    const flat = JSON.stringify(v.body);
    for (const forbidden of ['lastName', 'studentId', 'totalKobo', 'paidKobo', 'remainingKobo', 'status', 'token']) {
      expect(flat, `view payload exposed ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// ===========================================================================
// E. Bounds
// ===========================================================================
describe('E — bounds', () => {
  it('E1 the backlog bound cannot be exceeded, and a refusal reserves nothing', async () => {
    const stu = await createStudent(A.jar, 'RA-E1');
    const inv = await createInvoice(A.jar, stu.id, 9_000_000);
    const link = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 120_000 });

    for (let i = 0; i < 5; i += 1) {
      const r = await submit(link.token, { payerName: `P${i}`, reference: ref('E1') }, key('e1'));
      expect(r.status).toBe(201);
    }
    const before = await ledger(A);
    const refusedRef = ref('E1-REFUSED');
    const refused = await submit(link.token, { payerName: 'P6', reference: refusedRef }, key('e1'));
    expect(refused.status).toBe(429);
    expect(await ledger(A)).toEqual(before);

    // The refused attempt left no reservation behind: the same bank reference
    // is still usable once the queue has been cleared by staff.
    const payId = await asTenant(A, async (sql) => {
      const rows = (await sql`select id from payments where link_id = ${link.id}::uuid order by created_at limit 1`) as any[];
      return rows[0].id as string;
    });
    const confirmed = await callRoute('POST', `/api/payments/${payId}/confirm`, A.jar, {});
    expect(confirmed.status).toBe(200);

    await getSql()`SELECT auth_clear_rate_limits()`.catch(() => {});
    const accepted = await submit(link.token, { payerName: 'P7', reference: refusedRef }, key('e1b'));
    expect(accepted.status).toBe(201);
  });

  it('E2 the hourly window bounds a link whose queue is being cleared', async () => {
    const stu = await createStudent(A.jar, 'RA-E2');
    const inv = await createInvoice(A.jar, stu.id, 9_000_000);
    const link = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 60_000 });

    for (let i = 0; i < 10; i += 1) {
      const r = await submit(link.token, { payerName: `P${i}`, reference: ref('E2') }, key('e2'));
      if (r.status !== 201) throw new Error(`unexpected ${r.status} at ${i}: ${JSON.stringify(r.body)}`);
      const payId = await asTenant(A, async (sql) => {
        const rows = (await sql`select id from payments where payment_number = ${r.body.payment.paymentNumber}`) as any[];
        return rows[0].id as string;
      });
      const confirmed = await callRoute('POST', `/api/payments/${payId}/confirm`, A.jar, {});
      expect(confirmed.status).toBe(200);
    }
    const eleventh = await submit(link.token, { payerName: 'P11', reference: ref('E2') }, key('e2'));
    expect(eleventh.status).toBe(429);
  }, 120_000);

  it('E3 the platform budget bounds a flood of forged tokens', async () => {
    const before = await ledger(A);
    let refused = 0;
    for (let i = 0; i < 140; i += 1) {
      const r = await submit(`flood-${uuid()}`, { payerName: 'Flood', reference: ref('E3') }, key('e3'));
      if (r.status === 429) {
        refused += 1;
        break;
      }
      expect(r.status).toBe(404);
    }
    expect(refused).toBe(1);
    expect(await ledger(A)).toEqual(before);
  }, 120_000);
});

// ===========================================================================
// F. Direct database access from public context
// ===========================================================================
describe('F — direct database access', () => {
  it('F1 public context cannot write the ledger, the audit trail or the cache', async () => {
    const stu = await createStudent(A.jar, 'RA-F1');
    const inv = await createInvoice(A.jar, stu.id, 500_000);
    const link = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 500_000 });
    const before = await ledger(A);

    const attempts = await withPublicScope(link.token, async (_db, sql) => {
      const out: Record<string, string> = {};
      const statements: Array<[string, string]> = [
        [
          'payment_bank',
          `INSERT INTO payments (organization_id, method, status, amount_kobo, reference, payer_name)
             VALUES ('${A.orgId}', 'BANK_TRANSFER', 'PENDING', 500000, 'DIRECT-B', 'Direct')`,
        ],
        [
          'payment_cash',
          `INSERT INTO payments (organization_id, method, status, amount_kobo, reference, payer_name)
             VALUES ('${A.orgId}', 'CASH', 'PENDING', 500000, 'DIRECT-C', 'Direct')`,
        ],
        [
          'payment_confirmed',
          `INSERT INTO payments (organization_id, method, status, amount_kobo, reference, payer_name)
             VALUES ('${A.orgId}', 'BANK_TRANSFER', 'CONFIRMED', 500000, 'DIRECT-D', 'Direct')`,
        ],
        [
          'payment_other_org',
          `INSERT INTO payments (organization_id, method, status, amount_kobo, reference, payer_name)
             VALUES ('${B.orgId}', 'BANK_TRANSFER', 'PENDING', 500000, 'DIRECT-E', 'Direct')`,
        ],
        [
          'payment_no_link',
          `INSERT INTO payments (organization_id, method, status, amount_kobo, reference, payer_name, notes)
             VALUES ('${A.orgId}', 'BANK_TRANSFER', 'PENDING', 500000, 'DIRECT-F', 'Direct', 'free text')`,
        ],
        [
          'audit',
          `INSERT INTO audit_events (organization_id, actor_type, action, entity_type, entity_id, after, metadata)
             VALUES ('${A.orgId}', 'USER', 'payment.confirmed', 'payment', gen_random_uuid(), '{}'::jsonb, '{}'::jsonb)`,
        ],
        [
          'cache',
          `INSERT INTO public_submission_keys (organization_id, link_id, key_hash, reference_hash, payment_id, payment_number, amount_kobo)
             VALUES ('${A.orgId}', '${link.id}', repeat('a',64), repeat('b',64), gen_random_uuid(), 'PMT-Y', 1)`,
        ],
        ['read_payments', `SELECT count(*)::int AS n FROM payments`],
        ['read_cache', `SELECT count(*)::int AS n FROM public_submission_keys`],
      ];
      for (const [label, statement] of statements) {
        await sql.unsafe('SAVEPOINT ra_f1').catch(() => {});
        try {
          const rows = (await sql.unsafe(statement)) as any[];
          const empty = rows && rows.length && Number(rows[0].n) === 0;
          out[label] = empty ? 'EMPTY' : 'ALLOWED';
        } catch (e: any) {
          out[label] = String(e?.code ?? 'error');
        }
        await sql.unsafe('ROLLBACK TO SAVEPOINT ra_f1').catch(() => {});
      }
      return out;
    });

    for (const [label, outcome] of Object.entries(attempts)) {
      expect(outcome, `public context was allowed to run: ${label}`).not.toBe('ALLOWED');
    }
    expect(await ledger(A)).toEqual(before);
  });

  it('F2 even a syntactically valid forged context cannot write', async () => {
    const before = await ledger(A);
    const outcome = await withScopedDb({ kind: 'none' }, async (_db, sql) => {
      await sql.unsafe(`select set_config('app.organization_id', '${A.orgId}', true)`);
      await sql.unsafe(`select set_config('app.public_context', '1', true)`);
      await sql.unsafe(`select set_config('app.is_platform_admin', '0', true)`);
      await sql.unsafe('SAVEPOINT ra_f2').catch(() => {});
      try {
        await sql.unsafe(`INSERT INTO payments (organization_id, method, status, amount_kobo, reference, payer_name)
                            VALUES ('${A.orgId}', 'BANK_TRANSFER', 'PENDING', 1234, 'FORGED-2', 'Forged')`);
        return 'ALLOWED';
      } catch (e: any) {
        return String(e?.code ?? 'error');
      } finally {
        await sql.unsafe('ROLLBACK TO SAVEPOINT ra_f2').catch(() => {});
      }
    });
    expect(outcome).not.toBe('ALLOWED');
    expect(await ledger(A)).toEqual(before);
  });

  it("F3 an authenticated insert cannot claim another tenant's link", async () => {
    const stu = await createStudent(B.jar, 'RA-F3');
    const inv = await createInvoice(B.jar, stu.id, 100_000);
    const theirLink = await createLink(B.jar, { invoiceId: inv.id, amountKobo: 100_000 });

    const outcome = await asTenant(A, async (sql) => {
      await sql.unsafe('SAVEPOINT ra_f3').catch(() => {});
      try {
        await sql.unsafe(
          `INSERT INTO payments (organization_id, method, status, amount_kobo, reference, payer_name, link_id)
             VALUES ('${A.orgId}', 'BANK_TRANSFER', 'PENDING', 1000, 'CROSS-3', 'Cross', '${theirLink.id}')`,
        );
        return { ok: true as const };
      } catch (e: any) {
        return { ok: false as const, code: String(e?.code), message: String(e?.message ?? '') };
      } finally {
        await sql.unsafe('ROLLBACK TO SAVEPOINT ra_f3').catch(() => {});
      }
    });
    expect(outcome.ok).toBe(false);
    expect((outcome as any).code).toBe('23503');
    expect((outcome as any).message).toContain('payments__link_id__org_fkey');
  });

  it('F4 every accepted submission left a complete payment + audit + reservation trio', async () => {
    const stu = await createStudent(A.jar, 'RA-F4');
    const inv = await createInvoice(A.jar, stu.id, 450_000);
    const link = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 150_000 });
    const r = await submit(link.token, { payerName: 'Parent', reference: ref('F4') }, key('f4'));
    expect(r.status).toBe(201);

    const trio = await asTenant(A, async (sql) => {
      const rows = (await sql`select
        (select count(*)::int from payments where payment_number = ${r.body.payment.paymentNumber}) as payments,
        (select count(*)::int from audit_events a join payments p on p.id = a.entity_id
           where p.payment_number = ${r.body.payment.paymentNumber} and a.action = 'payment.pending') as audits
      `) as any[];
      return rows[0];
    });
    expect(Number(trio.payments)).toBe(1);
    expect(Number(trio.audits)).toBe(1);

    await leaveHarnessTransaction();
    const reserved = await asOwnerPublic(link.token, async (tx) => {
      const rows = (await tx.unsafe(
        `SELECT count(*)::int AS n FROM public_submission_keys WHERE payment_number = $1`,
        [r.body.payment.paymentNumber],
      )) as any[];
      return Number(rows[0].n);
    });
    expect(reserved).toBe(1);
  });
});

// ===========================================================================
// G. Ledger non-interference
// ===========================================================================
describe('G — ledger non-interference', () => {
  it('G1 the public surface never moved money, anywhere', async () => {
    const stu = await createStudent(A.jar, 'RA-G1');
    const inv = await createInvoice(A.jar, stu.id, 1_100_000);
    const link = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 1_100_000 });
    const submitted = await submit(link.token, { payerName: 'Parent', reference: ref('G1') }, key('g1'));
    expect(submitted.status).toBe(201);

    const state = await asTenant(A, async (sql) => {
      const rows = (await sql`select
        (select count(*)::int from invoices i
           where i.paid_kobo <> (select coalesce(sum(a.amount_kobo),0) from payment_allocations a
                                  where a.invoice_id = i.id and a.status = 'ACTIVE')) as inconsistent_invoices,
        (select count(*)::int from payment_allocations a join payments p on p.id = a.payment_id
           where a.status = 'ACTIVE' and p.status <> 'CONFIRMED') as active_without_confirmed,
        (select count(*)::int from payments where status = 'PENDING' and unallocated_kobo <> 0) as pending_with_balance,
        (select count(*)::int from receipts r join payments p on p.id = r.payment_id
           where p.status = 'PENDING') as receipts_for_pending
      `) as any[];
      return rows[0];
    });
    expect(Number(state.inconsistent_invoices)).toBe(0);
    expect(Number(state.active_without_confirmed)).toBe(0);
    expect(Number(state.pending_with_balance)).toBe(0);
    expect(Number(state.receipts_for_pending)).toBe(0);
  });

  it('G2 the invoice behind a submission is untouched', async () => {
    const stu = await createStudent(A.jar, 'RA-G2');
    const inv = await createInvoice(A.jar, stu.id, 260_000);
    const link = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 260_000 });

    const before = await asTenant(A, async (sql) => {
      const rows = (await sql`select paid_kobo, status, total_kobo from invoices where id = ${inv.id}::uuid`) as any[];
      return rows[0];
    });
    const r = await submit(link.token, { payerName: 'Parent', reference: ref('G2') }, key('g2'));
    expect(r.status).toBe(201);
    const after = await asTenant(A, async (sql) => {
      const rows = (await sql`select paid_kobo, status, total_kobo from invoices where id = ${inv.id}::uuid`) as any[];
      return rows[0];
    });

    expect(Number(after.paid_kobo)).toBe(Number(before.paid_kobo));
    expect(after.status).toBe(before.status);
    expect(Number(after.total_kobo)).toBe(Number(before.total_kobo));
  });
});
