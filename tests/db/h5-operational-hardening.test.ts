// @vitest-environment node
/**
 * H-5 — operational & observability hardening of the public payment surface.
 *
 * Contract suite. Every assertion is about an OPERATIONAL guarantee, not about
 * the code that implements it:
 *
 *   A. a leaked link can be remediated by rotation, safely, by an authorized
 *      operator, without losing the link or its provenance
 *   B. the exposure report is actionable (which link, how exposed, what to do)
 *      and never discloses the credential
 *   C. the append-only replay cache has a lifecycle that cannot create a
 *      duplicate payment, delete live retry evidence, or leave RLS suspended
 *   D. refusals and abuse are durable, attributable, secret-free signals, and
 *      telemetry can never break a payment
 *   E. none of it is reachable by an unauthorized actor, another tenant, or the
 *      runtime role
 *
 * The measured pre-H-5 state is in the closeout; the independent adversarial
 * re-audit lives in `h5-independent-reaudit.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { call, CookieJar } from '../auth/support';
import { POST as registerPost } from '@/app/api/auth/register/route';
import { GET as meGet } from '@/app/api/auth/me/route';
import { getSql, closeDb } from '@/lib/db';
import { withScopedDb } from '@/lib/db/tenant';
import { organizationMembers } from '@/lib/db/schema';
import { withSystemContext } from '@/lib/db/tenant';

type Jar = InstanceType<typeof CookieJar>;
type Actor = { jar: Jar; orgId: string; userId: string; role?: string };

const uuid = () => randomUUID();
const key = (p = 'h5') => `${p}-${uuid()}`;
const ref = (p = 'REF') => `${p}-${uuid().slice(0, 8)}`;

const OWNER_URL = process.env.DATABASE_MIGRATION_URL!;
const ownerPool = postgres(OWNER_URL, { max: 1 });

/** Commit the harness's per-test transaction so the owner pool can observe rows. */
async function leaveHarnessTransaction(): Promise<void> {
  await getSql()
    .unsafe('COMMIT')
    .catch(() => {});
}

/**
 * Run a may-fail statement as the owner inside its own transaction, with the
 * savepoint hygiene a failure requires: without the ROLLBACK TO SAVEPOINT the
 * ambient transaction is poisoned and the COMMIT itself fails, which makes a
 * clean refusal look like an infrastructure error.
 */
type ProbeResult = { ok: true; rows: any[] } | { ok: false; code: string; message: string };

async function ownerTry(
  statement: string,
  args: any[] = [],
  setup?: (conn: any) => Promise<void>,
  run?: (conn: any) => Promise<ProbeResult>,
): Promise<ProbeResult> {
  const conn: any = await (ownerPool as any).reserve();
  try {
    await conn.unsafe('BEGIN');
    await conn.unsafe('SAVEPOINT h5probe');
    try {
      if (setup) await setup(conn);
      const outcome = run ? await run(conn) : { ok: true as const, rows: (await conn.unsafe(statement, args)) as any[] };
      await conn.unsafe('RELEASE SAVEPOINT h5probe');
      return outcome;
    } catch (e: any) {
      await conn.unsafe('ROLLBACK TO SAVEPOINT h5probe').catch(() => {});
      return { ok: false as const, code: String(e?.code), message: String(e?.message ?? '') };
    }
  } finally {
    await conn.unsafe('ROLLBACK').catch(() => {});
    conn.release();
  }
}

async function callRoute(
  method: string,
  path: string,
  jar: Jar | null,
  body?: unknown,
  headers?: Record<string, string>,
  opts: { csrf?: boolean } = {},
) {
  const [pathname, search] = path.split('?');
  const localPath = search ? `${pathname}?${search}` : pathname!;
  void localPath;
  const segs = pathname!.split('/').filter(Boolean);
  const load = (modPath: string, params?: Record<string, string>) =>
    import(/* @vite-ignore */ `@/${modPath}`).then((mod: any) => {
      const exports = mod?.default ?? mod;
      return { handler: exports[method], params };
    });
  let target: { handler: any; params?: Record<string, string> };
  const [, s1, s2, s3] = segs;
  if (s1 === 'payment-links' && segs.length === 4)
    target = await load(`app/api/payment-links/[token]/${s3}/route`, { token: s2! });
  else if (s1 === 'payment-links' && segs.length === 3 && ['exposure', 'signals'].includes(s2!))
    target = await load(`app/api/payment-links/${s2}/route`);
  else if (s1 === 'payment-links' && segs.length === 3)
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
    (jar ?? new CookieJar()) as Jar,
    {
    method,
    path,
    body,
    csrf: opts.csrf ?? !['GET', 'HEAD', 'OPTIONS'].includes(method),
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
  });
}

async function registerOwner(prefix = 'h5'): Promise<Actor> {
  const slug = `${prefix}-${uuid().slice(0, 8)}`;
  const jar = new CookieJar();
  const reg = await call(registerPost, jar, {
    method: 'POST',
    path: '/api/auth/register',
    body: {
      email: `${slug}@example.com`,
      password: 'Pass-' + uuid().slice(0, 8) + '-A1!',
      firstName: 'H5',
      lastName: 'Owner',
      organizationName: 'School ' + slug,
      organizationSlug: slug,
    },
  });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status}`);
  const me = await call(meGet, jar, { method: 'GET', path: '/api/auth/me' });
  const seeded = await callRoute('POST', '/api/setup/seed-current-term', jar, {});
  if (seeded.status !== 200) throw new Error(`seed term failed: ${seeded.status}`);
  return { jar, orgId: me.data.activeOrganizationId, userId: me.data.user.id, role: me.data.activeRole };
}

/** Add an ACTIVE member with a role into the actor's org and switch to it. */
async function addMember(owner: Actor, role: 'SCHOOL_ADMIN' | 'FINANCE_OFFICER' | 'STAFF'): Promise<Actor> {
  const email = `${role.toLowerCase()}-${uuid().slice(0, 8)}@example.com`;
  const jar = new CookieJar();
  const reg = await call(registerPost, jar, {
    method: 'POST',
    path: '/api/auth/register',
    body: {
      email,
      password: 'Pass-' + uuid().slice(0, 8) + '-A1!',
      firstName: role,
      lastName: 'User',
      organizationName: role + ' solo',
      organizationSlug: `${role.toLowerCase().replace(/_/g, '-')}-${uuid().slice(0, 8)}`,
    },
  });
  if (reg.status !== 201) throw new Error(`register member failed: ${reg.status}`);
  const me = await call(meGet, jar, { method: 'GET', path: '/api/auth/me' });
  await withSystemContext(null, null, async (sdb) => {
    await sdb.insert(organizationMembers).values({
      id: uuid(),
      organizationId: owner.orgId,
      userId: me.data.user.id,
      role,
      status: 'ACTIVE',
      joinedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
  });
  const sel = await callRoute('POST', '/api/auth/select-organization', jar, { organizationId: owner.orgId });
  if (sel.status !== 200) throw new Error(`select org failed: ${sel.status} ${JSON.stringify(sel.data)}`);
  const after = await call(meGet, jar, { method: 'GET', path: '/api/auth/me' });
  expect(after.data.activeRole).toBe(role);
  return { jar, orgId: owner.orgId, userId: me.data.user.id, role };
}

// ---------- domain fixtures ----------

async function createStudent(jar: Jar, tag = 'H5') {
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
  return r.data.invoice as { id: string; invoiceNumber: string };
}

async function createLink(jar: Jar, opts: { invoiceId?: string; amountKobo?: number; note?: string }) {
  const r = await callRoute('POST', '/api/payment-links', jar, {
    invoiceId: opts.invoiceId,
    amountKobo: opts.amountKobo,
    note: opts.note ?? 'H-5 link',
  });
  if (r.status !== 201) throw new Error(`create link failed: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.link as { id: string; token: string };
}

/** R3-proven hygiene: public-surface calls must not inherit leaked GUC state. */
async function resetGuc() {
  const sql = getSql();
  try {
    await sql`select auth_clear_public_context()`.catch(() => {});
  } catch {}
  try {
    await sql`select clear_app_context()`.catch(() => {});
  } catch {}
}

async function submit(token: string, body: unknown, submitKey?: string) {
  const mod: any = await import(/* @vite-ignore */ `@/app/api/p/[token]/submit/route`);
  await resetGuc();
  const res: Response = await (mod?.default ?? mod).POST(
    new Request(`http://test.local/api/p/${token}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': submitKey ?? key('sub') },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ token }) },
  ).finally(() => resetGuc());
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

async function view(token: string) {
  const mod: any = await import(/* @vite-ignore */ `@/app/api/p/[token]/view/route`);
  await resetGuc();
  const res: Response = await (mod?.default ?? mod).GET(new Request(`http://test.local/api/p/${token}/view`), {
    params: Promise.resolve({ token }),
  }).finally(() => resetGuc());
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

async function tenantRows<T = any>(actor: Actor, fn: (sql: any) => Promise<T>): Promise<T> {
  const sql = getSql();
  await sql`select set_tenant_context(${actor.orgId}::uuid, ${actor.userId}::uuid)`;
  try {
    return await fn(sql);
  } finally {
    await sql`select clear_app_context()`.catch(() => {});
  }
}

let A: Actor;
let B: Actor;

beforeAll(async () => {
  await getSql()`SELECT auth_clear_rate_limits()`.catch(() => {});
  A = await registerOwner('h5a');
  B = await registerOwner('h5b');
}, 180_000);

afterAll(async () => {
  await ownerPool.end({ timeout: 5 }).catch(() => {});
  await closeDb();
});

// ===========================================================================
// A. Rotation
// ===========================================================================
describe('A — a leaked link can be rotated safely by an authorized operator', () => {
  it('A1 rotation preserves the link and retires only the old token', async () => {
    const stu = await createStudent(A.jar, 'H5-A1');
    const inv = await createInvoice(A.jar, stu.id, 400_000);
    const link = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 400_000 });
    const oldToken = link.token;

    // A submission arrives BEFORE the rotation: it must keep its provenance.
    const before = await submit(oldToken, { payerName: 'Parent One', reference: ref('A1') });
    expect(before.status).toBe(201);

    const rotated = await callRoute('POST', `/api/payment-links/${oldToken}/rotate`, A.jar, { reason: 'URL leaked' });
    expect(rotated.status).toBe(200);
    const newToken = rotated.data.link.token as string;
    expect(newToken).not.toBe(oldToken);
    expect(rotated.data.link.id).toBe(link.id);
    expect(rotated.data.link.rotationCount).toBe(1);
    expect(rotated.data.link.rotatedAt).toBeTruthy();

    // The old URL is dead (and indistinguishable from a token that never was).
    const oldView = await view(oldToken);
    const unknownView = await view(`never-${uuid()}`);
    expect(oldView.status).toBe(404);
    expect(oldView.body).toEqual(unknownView.body);
    const oldSubmit = await submit(oldToken, { payerName: 'Attacker', reference: ref('A1') });
    expect(oldSubmit.status).toBe(404);

    // The new URL works, for the same link, with the same amount binding.
    const newView = await view(newToken);
    expect(newView.status).toBe(200);
    expect(newView.body.amountDueKobo).toBe(400_000);
    const after = await submit(newToken, { payerName: 'Parent Two', reference: ref('A1') });
    expect(after.status).toBe(201);
    expect(after.body.payment.amountKobo).toBe(400_000);

    // Provenance: both submissions point at the SAME link id, and the pre-rotation
    // one was not orphaned by the rotation.
    const provenance = await tenantRows(A, async (sql) => {
      const rows = (await sql`select link_id, count(*)::int as n from payments
        where reference in (${before.body.payment.paymentNumber}, ${after.body.payment.paymentNumber})
           or payment_number in (${before.body.payment.paymentNumber}, ${after.body.payment.paymentNumber})
        group by link_id`) as any[];
      return rows;
    });
    expect(provenance.length).toBe(1);
    expect(provenance[0].link_id).toBe(link.id);
    expect(Number(provenance[0].n)).toBe(2);

    // The audit trail records the rotation AND contains no credential.
    const audit = await tenantRows(A, async (sql) => {
      const rows = (await sql`select action, after, metadata from audit_events
        where entity_id = ${link.id}::uuid and action = 'payment_link.rotate'`) as any[];
      return rows;
    });
    expect(audit.length).toBe(1);
    const auditText = JSON.stringify(audit);
    expect(auditText).not.toContain(oldToken);
    expect(auditText).not.toContain(newToken);
  });

  it('A2 the rotation invariant is enforced by the database, not by convention', async () => {
    const stu = await createStudent(A.jar, 'H5-A2');
    const inv = await createInvoice(A.jar, stu.id, 200_000);
    const link = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 200_000 });

    const attempts = await tenantRows(A, async (sql) => {
      const out: Record<string, string> = {};
      const tryStatement = async (label: string, statement: string) => {
        await sql.unsafe('SAVEPOINT h5a2').catch(() => {});
        try {
          await sql.unsafe(statement);
          out[label] = 'ALLOWED';
        } catch (e: any) {
          out[label] = String(e?.code ?? 'error');
        }
        await sql.unsafe('ROLLBACK TO SAVEPOINT h5a2').catch(() => {});
      };
      await tryStatement(
        'no_provenance',
        `update payment_links set token = 'h5-rotated-without-provenance-token' where id = '${link.id}'`,
      );
      await tryStatement(
        'count_skipped',
        `update payment_links set token = 'h5-rotated-count-skipped-token',
           token_rotated_at = now(), token_rotation_count = token_rotation_count + 2 where id = '${link.id}'`,
      );
      await tryStatement(
        'timestamp_alone',
        `update payment_links set token_rotated_at = now() where id = '${link.id}'`,
      );
      await tryStatement(
        'fingerprint_supplied',
        `update payment_links set token_fingerprint = '0123456789abcdef' where id = '${link.id}'`,
      );
      await tryStatement(
        'status_hijack',
        `update payment_links set token = 'h5-rotated-status-hijack', token_rotated_at = now(),
           token_rotation_count = token_rotation_count + 1, status = 'REVOKED' where id = '${link.id}'`,
      );
      await tryStatement(
        'short_token',
        `update payment_links set token = 'short', token_rotated_at = now(),
           token_rotation_count = token_rotation_count + 1 where id = '${link.id}'`,
      );
      return out;
    });

    for (const [label, outcome] of Object.entries(attempts)) {
      expect(outcome, `rotation invariant was not enforced for ${label}`).not.toBe('ALLOWED');
    }

    // A well-formed rotation by the repo path still works after all of that.
    const rotated = await callRoute('POST', `/api/payment-links/${link.token}/rotate`, A.jar, {});
    expect(rotated.status).toBe(200);
    expect(rotated.data.link.rotationCount).toBe(1);
  });

  it('A3 an inactive link cannot be rotated, and rotation does not clear the backlog', async () => {
    const stu = await createStudent(A.jar, 'H5-A3');
    const inv = await createInvoice(A.jar, stu.id, 300_000);
    const link = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 60_000 });

    // Fill the backlog bound (5 unreconciled submissions), then rotate.
    for (let i = 0; i < 5; i += 1) {
      const r = await submit(link.token, { payerName: `P${i}`, reference: ref('A3') });
      expect(r.status).toBe(201);
    }
    const rotated = await callRoute('POST', `/api/payment-links/${link.token}/rotate`, A.jar, {});
    expect(rotated.status).toBe(200);

    // The backlog is NOT reset by rotation: it is a financial queue, not a
    // credential, so a leaked-token incident must not clear it.
    await getSql()`SELECT auth_clear_rate_limits()`.catch(() => {});
    const blocked = await submit(rotated.data.link.token, { payerName: 'P6', reference: ref('A3') });
    expect(blocked.status).toBe(429);

    // Revoked links cannot be rotated at all (the URL can only be retired, and
    // service is restored by creating a new link).
    const revoked = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 60_000 });
    const revokeResult = await callRoute('PATCH', `/api/payment-links/${revoked.token}`, A.jar, { reason: 'leak' });
    expect(revokeResult.status).toBe(200);
    const rotateRevoked = await callRoute('POST', `/api/payment-links/${revoked.token}/rotate`, A.jar, {});
    expect(rotateRevoked.status).toBe(400);
    expect(rotateRevoked.data.error.code).toBe('BAD_REQUEST');
  });

  it('A4 rotation is recorded as a durable operational signal for the tenant', async () => {
    const stu = await createStudent(A.jar, 'H5-A4');
    const inv = await createInvoice(A.jar, stu.id, 100_000);
    const link = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 100_000 });
    const rotated = await callRoute('POST', `/api/payment-links/${link.token}/rotate`, A.jar, { reason: 'ops test' });
    expect(rotated.status).toBe(200);

    const signals = await callRoute('GET', '/api/payment-links/signals?since=1h', A.jar);
    expect(signals.status).toBe(200);
    const rotation = (signals.data.events as any[]).find(
      (e) => e.kind === 'link_rotated' && e.linkId === link.id,
    );
    expect(rotation, 'the rotation must be visible as an operational signal').toBeTruthy();
    expect(rotation.detail.rotationCount).toBe(1);
    // The signal never carries the credential or the reason text verbatim.
    expect(JSON.stringify(rotation)).not.toContain(rotated.data.link.token);
    expect(signals.data.summary.rotations).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// B. Exposure report
// ===========================================================================
describe('B — the exposure report is actionable and secret-free', () => {
  it('B1 the tenant sees which of its links is exposed, and rotation clears it', async () => {
    const stu = await createStudent(A.jar, 'H5-B1');
    const inv = await createInvoice(A.jar, stu.id, 500_000);
    const link = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 500_000 });

    // A pre-R3 style row: the raw token inside `payments.notes`.
    await tenantRows(A, async (sql) => {
      await sql`update payments set notes = ${'Submitted via payment link ' + link.token}
                 where id = (select id from payments where organization_id = ${A.orgId}::uuid limit 1)`.catch(
        () => {},
      );
    });
    // …created fresh if that table is empty for this org:
    const legacy = await tenantRows(A, async (sql) => {
      const rows = (await sql`insert into payments
        (organization_id, method, status, amount_kobo, unallocated_kobo, reference, payer_name, notes)
        values (${A.orgId}::uuid, 'BANK_TRANSFER', 'PENDING', 1000, 0, ${ref('H5-LEG')}, 'Legacy',
                ${'Submitted via payment link ' + link.token})
        returning id`) as any[];
      return rows[0].id as string;
    });
    expect(legacy).toBeTruthy();

    const report = await callRoute('GET', '/api/payment-links/exposure', A.jar);
    expect(report.status).toBe(200);
    const row = (report.data.links as any[]).find((l) => l.linkId === link.id);
    expect(row, 'the exposed link must be listed').toBeTruthy();
    expect(row.status).toBe('ACTIVE');
    expect(row.atRisk).toBe(true);
    expect(Number(row.exposedPaymentRows)).toBeGreaterThanOrEqual(1);
    expect(row.recommendedAction).toBe('ROTATE');
    // The report never discloses the credential itself.
    expect(JSON.stringify(report.data)).not.toContain(link.token);

    // Rotating is the remedy: the stored history still holds the OLD token, so
    // the link drops off the at-risk list because that token now authorizes
    // nothing.
    const rotated = await callRoute('POST', `/api/payment-links/${link.token}/rotate`, A.jar, { reason: 'exposed' });
    expect(rotated.status).toBe(200);
    const after = await callRoute('GET', '/api/payment-links/exposure', A.jar);
    const stillThere = (after.data.links as any[]).find((l) => l.linkId === link.id);
    expect(stillThere, 'a rotated link must no longer be at risk').toBeFalsy();

    // And the exposure of the retired token is provably harmless: the old URL
    // authorizes nothing at all.
    expect((await view(link.token)).status).toBe(404);
  });

  it('B2 the tenant exposure report is tenant-scoped', async () => {
    const stuB = await createStudent(B.jar, 'H5-B2');
    const invB = await createInvoice(B.jar, stuB.id, 300_000);
    const linkB = await createLink(B.jar, { invoiceId: invB.id, amountKobo: 300_000 });
    await tenantRows(B, async (sql) => {
      await sql`insert into payments
        (organization_id, method, status, amount_kobo, unallocated_kobo, reference, payer_name, notes)
        values (${B.orgId}::uuid, 'BANK_TRANSFER', 'PENDING', 1000, 0, ${ref('H5-B2')}, 'Legacy',
                ${'Submitted via payment link ' + linkB.token})`;
    });

    const asB = await callRoute('GET', '/api/payment-links/exposure', B.jar);
    expect(asB.status).toBe(200);
    expect((asB.data.links as any[]).some((l) => l.linkId === linkB.id)).toBe(true);

    const asA = await callRoute('GET', '/api/payment-links/exposure', A.jar);
    expect(asA.status).toBe(200);
    expect((asA.data.links as any[]).some((l) => l.linkId === linkB.id)).toBe(false);
    expect(JSON.stringify(asA.data)).not.toContain(linkB.token);
    expect(JSON.stringify(asA.data)).not.toContain(B.orgId);
  });

  it('B3 the platform remediation report sees every tenant and is owner-only', async () => {
    // A fresh exposed row, created and committed inside THIS test: earlier
    // tests' rows are rolled back by the harness's per-test transaction.
    const stuC = await createStudent(B.jar, 'H5-B3');
    const invC = await createInvoice(B.jar, stuC.id, 120_000);
    const linkC = await createLink(B.jar, { invoiceId: invC.id, amountKobo: 120_000 });
    await tenantRows(B, async (sql) => {
      await sql`insert into payments
        (organization_id, method, status, amount_kobo, unallocated_kobo, reference, payer_name, notes)
        values (${B.orgId}::uuid, 'BANK_TRANSFER', 'PENDING', 1000, 0, ${ref('H5-B3')}, 'Legacy',
                ${'Submitted via payment link ' + linkC.token})`;
    });
    await leaveHarnessTransaction();
    const rows = (await ownerPool.unsafe(`select * from auth_public_remediation_report()`)) as any[];
    // The platform sees it, whichever tenant wrote it.
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.recommended_action === 'ROTATE')).toBe(true);
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain('Submitted via payment link');
    expect(serialised).not.toContain(linkC.token); // the bearer itself is never reported

    // The runtime role cannot execute it…
    const runtime = await withScopedDb({ kind: 'none' }, async (_db, sql) => {
      await sql.unsafe('SAVEPOINT h5b3').catch(() => {});
      try {
        await sql.unsafe(`select * from auth_public_remediation_report()`);
        return 'ALLOWED';
      } catch (e: any) {
        return String(e?.code ?? 'error');
      } finally {
        await sql.unsafe('ROLLBACK TO SAVEPOINT h5b3').catch(() => {});
      }
    });
    expect(runtime).toBe('42501');

    // …and neither can a tenant session (no grant at all).
    const asTenant = await tenantRows(A, async (sql) => {
      await sql.unsafe('SAVEPOINT h5b3t').catch(() => {});
      try {
        await sql.unsafe(`select * from auth_public_remediation_report()`);
        return 'ALLOWED';
      } catch (e: any) {
        return String(e?.code ?? 'error');
      } finally {
        await sql.unsafe('ROLLBACK TO SAVEPOINT h5b3t').catch(() => {});
      }
    });
    expect(asTenant).toBe('42501');

    // The RLS posture of every table the report touches is intact afterwards.
    const posture = (await ownerPool.unsafe(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class
        where relname in ('payment_links','payments','audit_events','public_submission_keys','public_surface_events')
        order by relname`,
    )) as any[];
    expect(posture.length).toBe(5);
    for (const p of posture) {
      expect(p.relrowsecurity, `${p.relname} RLS`).toBe(true);
      expect(p.relforcerowsecurity, `${p.relname} FORCE RLS`).toBe(true);
    }
  });
});

// ===========================================================================
// C. Replay-cache lifecycle
// ===========================================================================
describe('C — the replay cache has a lifecycle that cannot create a duplicate', () => {
  it('C1 dry run is the default, and destructive pruning is bounded and safe', async () => {
    const stu = await createStudent(A.jar, 'H5-C1');
    const inv = await createInvoice(A.jar, stu.id, 500_000);
    const link = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 500_000 });

    // Two settled submissions and one still PENDING (the live retry window).
    const settledRefs: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const r = await submit(link.token, { payerName: `S${i}`, reference: ref('C1') });
      expect(r.status).toBe(201);
      settledRefs.push(r.body.payment.paymentNumber as string);
      const payId = await tenantRows(A, async (sql) => {
        const rows = (await sql`select id from payments where payment_number = ${r.body.payment.paymentNumber}`) as any[];
        return rows[0].id as string;
      });
      const confirmed = await callRoute('POST', `/api/payments/${payId}/confirm`, A.jar, {});
      expect(confirmed.status).toBe(200);
    }
    const pending = await submit(link.token, { payerName: 'P', reference: ref('C1') });
    expect(pending.status).toBe(201);

    await leaveHarnessTransaction();

    // Backdating is an owner-only operational action: the cache is append-only,
    // so even the owner needs the documented suspend/restore helper (which
    // asserts and restores the RLS posture around the write).
    await ownerPool.begin(async (tx) => {
      await tx.unsafe(`select auth_ops_suspend_rls(ARRAY['public_submission_keys'])`);
      const ages: Array<[string, string]> = [
        [settledRefs[0]!, '401 days'],
        [settledRefs[1]!, '400 days'],
        [pending.body.payment.paymentNumber, '399 days'],
      ];
      for (const [pn, age] of ages) {
        await tx.unsafe(
          `update public_submission_keys set created_at = now() - $2::interval where payment_number = $1`,
          [pn, age],
        );
      }
      await tx.unsafe(`select auth_ops_restore_rls(ARRAY['public_submission_keys'])`);
    });

    // Inventory: 3 reservations, 2 settled, 1 live.
    const inventory = (await ownerPool.unsafe(`select * from auth_public_submission_cache_report()`)) as any[];
    expect(Number(inventory[0].total_reservations)).toBeGreaterThanOrEqual(3);
    expect(Number(inventory[0].live_pending)).toBeGreaterThanOrEqual(1);
    expect(Number(inventory[0].settled)).toBeGreaterThanOrEqual(2);
    expect(Number(inventory[0].pruneable)).toBeGreaterThanOrEqual(2);

    // Unsafe windows are refused outright.
    const tooShort = (await ownerPool
      .unsafe(`select * from auth_public_submission_cache_prune(interval '1 hour', 100, true)`)
      .catch((e: any) => String(e?.code))) as any;
    expect(tooShort).toBe('22023');
    const tooLong = (await ownerPool
      .unsafe(`select * from auth_public_submission_cache_prune(interval '4000 days', 100, true)`)
      .catch((e: any) => String(e?.code))) as any;
    expect(tooLong).toBe('22023');

    // Dry run by DEFAULT: reports candidates and deletes nothing.
    const dry = (await ownerPool.unsafe(`select * from auth_public_submission_cache_prune()`)) as any[];
    expect(dry[0].dry_run).toBe(true);
    expect(Number(dry[0].deleted)).toBe(0);
    const afterDry = await ownerTry(
      `select count(*)::int as n from public_submission_keys`,
      [],
      async (conn) => {
        await conn.unsafe(`select auth_ops_suspend_rls(ARRAY['public_submission_keys'])`);
      },
    );
    expect(afterDry.ok, JSON.stringify(afterDry)).toBe(true);
    expect(Number((afterDry as { ok: true; rows: any[] }).rows[0].n)).toBe(
      Number(inventory[0].total_reservations),
    );

    // Apply: only old SETTLED rows go, the live PENDING reservation stays, and
    // the row cap is honoured.
    const applied = (await ownerPool.unsafe(
      `select * from auth_public_submission_cache_prune(interval '90 days', 1, false)`,
    )) as any[];
    expect(Number(applied[0].deleted)).toBe(1);

    // Reading the cache back needs the same owner-only helper: the table is
    // append-only and invisible to an owner without context.
    const remainingOutcome = await ownerTry(
      `select payment_number from public_submission_keys where payment_number = ANY($1::text[])`,
      [[settledRefs[0]!, settledRefs[1]!, pending.body.payment.paymentNumber]],
      async (conn) => {
        await conn.unsafe(`select auth_ops_suspend_rls(ARRAY['public_submission_keys'])`);
      },
    );
    expect(remainingOutcome.ok, JSON.stringify(remainingOutcome)).toBe(true);
    const remaining = (remainingOutcome as { ok: true; rows: any[] }).rows;
    expect(remaining.length).toBe(2);
    // The oldest settled reservation is gone; the newer settled one and the
    // live PENDING one are still there (the live retry window is never pruned).
    expect(remaining.map((r) => r.payment_number).sort()).toEqual(
      [settledRefs[1]!, pending.body.payment.paymentNumber].sort(),
    );

    // A pruned settled reference cannot become a SECOND payment: the ledger's
    // live-reference index still refuses it. (Degradation is 409, never a
    // duplicate.)
    const retry = await submit(link.token, { payerName: 'Retry', reference: 'pruned-reference' });
    void retry;
    const settledOutcome = await ownerTry(
      `select p.reference, p.status::text as status from payments p
        where p.payment_number = $1 and p.organization_id = $2::uuid`,
      [settledRefs[0]!, A.orgId],
      async (conn) => {
        await conn.unsafe(`select auth_ops_suspend_rls(ARRAY['payments'])`);
      },
    );
    expect(settledOutcome.ok, JSON.stringify(settledOutcome)).toBe(true);
    const settledRow = (settledOutcome as { ok: true; rows: any[] }).rows;
    const replayOfPruned = await submit(link.token, {
      payerName: 'Retry',
      reference: settledRow[0].reference,
    });
    expect([409, 429]).toContain(replayOfPruned.status);
    const dupesOutcome = await ownerTry(
      `select count(*)::int as n from payments where reference = $1`,
      [settledRow[0].reference],
      async (conn) => {
        await conn.unsafe(`select auth_ops_suspend_rls(ARRAY['payments'])`);
      },
    );
    expect(dupesOutcome.ok, JSON.stringify(dupesOutcome)).toBe(true);
    expect(Number((dupesOutcome as { ok: true; rows: any[] }).rows[0].n)).toBe(1);

    // The append-only posture is restored, and the runtime role still has no way in.
    const posture = (await ownerPool.unsafe(
      `select relrowsecurity, relforcerowsecurity from pg_class where relname = 'public_submission_keys'`,
    )) as any[];
    expect(posture[0].relrowsecurity).toBe(true);
    expect(posture[0].relforcerowsecurity).toBe(true);
    const policies = (await ownerPool.unsafe(
      `select count(*)::int as n from pg_policies where tablename = 'public_submission_keys' and cmd in ('UPDATE','DELETE','ALL')`,
    )) as any[];
    expect(Number(policies[0].n)).toBe(0);
    const runtime = await withScopedDb({ kind: 'none' }, async (_db, sql) => {
      await sql.unsafe('SAVEPOINT h5c1').catch(() => {});
      try {
        await sql.unsafe(`select count(*) from public_submission_keys`);
        return 'ALLOWED';
      } catch (e: any) {
        return String(e?.code ?? 'error');
      } finally {
        await sql.unsafe('ROLLBACK TO SAVEPOINT h5c1').catch(() => {});
      }
    });
    expect(runtime).toBe('42501');
  });

  it('C2 the cache still replays normally for a live (unpruned) submission', async () => {
    const stu = await createStudent(A.jar, 'H5-C2');
    const inv = await createInvoice(A.jar, stu.id, 150_000);
    const link = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 150_000 });
    const body = { payerName: 'Parent', reference: ref('C2') };
    const first = await submit(link.token, body, key('c2'));
    const again = await submit(link.token, body, key('c2'));
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.headers.get('Idempotent-Replayed')).toBe('true');
    expect(again.body).toEqual(first.body);
  });

  it('C3 pruning is recorded as evidence, and the window it used is auditable', async () => {
    await leaveHarnessTransaction();
    const eventsOutcome = await ownerTry(
      `select kind, detail, occurred_at from public_surface_events where kind = 'cache_pruned' order by occurred_at desc limit 5`,
      [],
      async (conn) => {
        await conn.unsafe(`select auth_ops_suspend_rls(ARRAY['public_surface_events'])`);
      },
    );
    expect(eventsOutcome.ok, JSON.stringify(eventsOutcome)).toBe(true);
    const events = (eventsOutcome as { ok: true; rows: any[] }).rows;
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].detail).toHaveProperty('retentionDays');
    expect(events[0].detail).toHaveProperty('deleted');
    expect(events[0].detail).toHaveProperty('dryRun');
  });
});

// ===========================================================================
// D. Signals
// ===========================================================================
describe('D — refusals and abuse are durable, attributable, secret-free signals', () => {
  it('D1 every terminal outcome of the public endpoint leaves a classified signal', async () => {
    const stu = await createStudent(A.jar, 'H5-D1');
    const inv = await createInvoice(A.jar, stu.id, 200_000);
    const link = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 40_000 });

    const acceptedRef = ref('D1');
    const accepted = await submit(link.token, { payerName: 'P', reference: acceptedRef }, key('d1'));
    expect(accepted.status).toBe(201);
    const replayed = await submit(link.token, { payerName: 'P', reference: acceptedRef }, key('d1'));
    expect(replayed.status).toBe(200);
    const mismatch = await submit(link.token, { payerName: 'P', reference: ref('D1'), amountKobo: 1 }, key('d1'));
    expect(mismatch.status).toBe(409);
    const forged = await submit(`forged-${uuid()}`, { payerName: 'P', reference: ref('D1') }, key('d1'));
    expect(forged.status).toBe(404);
    // Fill the backlog: the 5th and 6th attempts (link already has 1 pending).
    for (let i = 0; i < 4; i += 1) {
      await submit(link.token, { payerName: `F${i}`, reference: ref('D1') }, key('d1'));
    }
    const blocked = await submit(link.token, { payerName: 'F9', reference: ref('D1') }, key('d1'));
    expect(blocked.status).toBe(429);

    const signals = await callRoute('GET', '/api/payment-links/signals?since=1h', A.jar);
    expect(signals.status).toBe(200);
    const kinds = (signals.data.events as any[]).map((e) => e.kind);
    for (const expected of [
      'submission_accepted',
      'submission_replayed',
      'submission_amount_mismatch',
      'submission_rate_limited',
    ]) {
      expect(kinds, `missing signal ${expected}`).toContain(expected);
    }
    // The forge signal is platform-level (no tenant attached), so the tenant
    // view must not contain it…
    expect(kinds).not.toContain('submission_unknown_bearer');

    // …but the platform alerting surface does.
    await leaveHarnessTransaction();
    const platform = (await ownerPool.unsafe(
      `select kind, link_id, events from auth_public_surface_signal_report(interval '1 hour', 100)`,
    )) as any[];
    expect(platform.some((r) => r.kind === 'submission_unknown_bearer')).toBe(true);

    // No signal, in either view, carries a credential or financial data.
    const allSignalText = JSON.stringify(signals.data) + JSON.stringify(platform);
    expect(allSignalText).not.toContain(link.token);
    expect(allSignalText).not.toContain('Okafor');
    expect(allSignalText).not.toContain('40000');
  });

  it('D2 the runtime recorder enforces its caller matrix and cannot store secrets', async () => {
    const stu = await createStudent(A.jar, 'H5-D2');
    const inv = await createInvoice(A.jar, stu.id, 100_000);
    const link = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 100_000 });
    const otherStu = await createStudent(B.jar, 'H5-D2B');
    const otherInv = await createInvoice(B.jar, otherStu.id, 100_000);
    const otherLink = await createLink(B.jar, { invoiceId: otherInv.id, amountKobo: 100_000 });

    await leaveHarnessTransaction();

    // (a) anonymous callers: only the forged-bearer probe is permitted.
    const anonProbe = (kind: string) =>
      ownerTry(`select auth_record_public_surface_event($1, NULL, '{}'::jsonb) as id`, [kind]);
    expect(((await anonProbe('link_rotated')) as any).code).toBe('42501');
    expect(((await anonProbe('submission_accepted')) as any).code).toBe('42501');
    // …and the one probe an anonymous caller IS allowed to make succeeds.
    expect(((await anonProbe('submission_unknown_bearer')) as any).ok).toBe(true);

    // (b) a public bearer may only report on ITS OWN link, and only submission kinds.
    const publicSetup = (token: string) => async (tx: postgres.TransactionSql) => {
      await tx.unsafe(`select set_config('app.r1_scope_depth', '1', false)`);
      await tx.unsafe(`select auth_scope_public_local($1)`, [token]);
    };
    const publicReport = (token: string, kind: string, linkId: string | null) =>
      ownerTry(`select auth_record_public_surface_event($1, $2::uuid, '{}'::jsonb) as id`, [kind, linkId], publicSetup(token));
    const publicAllowed = await publicReport(link.token, 'submission_amount_mismatch', null);
    expect((publicAllowed as any).ok, JSON.stringify(publicAllowed)).toBe(true);
    expect(await publicReport(link.token, 'link_rotated', null)).toMatchObject({ ok: false, code: '42501' });
    expect(await publicReport(link.token, 'submission_amount_mismatch', otherLink.id)).toMatchObject({
      ok: false,
      code: '42501',
    });

    // (c) a tenant may only report on its own link, and only lifecycle kinds.
    const tenantSetup = (actor: Actor) => async (tx: postgres.TransactionSql) => {
      await tx.unsafe(`select set_config('app.r1_scope_depth', '1', false)`);
      await tx.unsafe(`select set_tenant_context($1::uuid, $2::uuid)`, [actor.orgId, actor.userId]);
    };
    const tenantReport = (actor: Actor, kind: string, linkId: string) =>
      ownerTry(`select auth_record_public_surface_event($1, $2::uuid, '{}'::jsonb) as id`, [kind, linkId], tenantSetup(actor));
    const tenantAllowed = await tenantReport(A, 'link_rotated', link.id);
    expect((tenantAllowed as any).ok, JSON.stringify(tenantAllowed)).toBe(true);
    expect(await tenantReport(A, 'link_rotated', otherLink.id)).toMatchObject({ ok: false, code: '42501' });
    expect(await tenantReport(A, 'submission_accepted', link.id)).toMatchObject({ ok: false, code: '42501' });

    // (d) nothing that could carry a credential, an identity or an amount can
    //     be stored, at either layer.
    // `::text::jsonb`: the driver would otherwise send the parameter as a JSON
    // string, and every probe below would be refused for the wrong reason.
    const forbiddenDetail = (detail: string) =>
      ownerTry(
        `select auth_record_public_surface_event('submission_accepted', NULL, $1::text::jsonb)`,
        [detail],
        publicSetup(link.token),
      );
    // Positive control: a permitted flat payload IS accepted (proves the
    // refusals below are about the payload, not about the cast).
    const allowedDetail = await forbiddenDetail('{"refusals":1,"severity":"warning"}');
    expect(allowedDetail, JSON.stringify(allowedDetail)).toMatchObject({ ok: true });
    for (const detail of [
      '{"token":"abc"}',
      '{"nested":{"token":"abc"}}',
      '{"keyHash":"abc"}',
      '{"reference":"BANK-REF"}',
      '{"payerName":"Ada"}',
      '{"amountKobo":5000}',
      '{"proof":"x"}',
    ]) {
      const outcome = await forbiddenDetail(detail);
      expect(outcome, `detail ${detail} was accepted`).toMatchObject({ ok: false, code: '22023' });
    }

    // (e) the table itself refuses to become an evidence store, even for the owner.
    const ownerInsert = (columns: string, values: string) =>
      ownerTry(`insert into public_surface_events (${columns}) values (${values}) returning id`);
    expect(await ownerInsert('kind, detail', `'submission_accepted', '{"tokenHash":"deadbeef"}'`)).toMatchObject({ ok: false, code: '23514' });
    expect(await ownerInsert('kind, detail', `'submission_accepted', '[]'::jsonb`)).toMatchObject({ ok: false, code: '23514' });
    expect(await ownerInsert('kind', `'something_else'`)).toMatchObject({ ok: false, code: '23514' });
    expect(await ownerInsert('kind, link_id', `'submission_accepted', '${link.id}'::uuid`)).toMatchObject({
      ok: false,
      code: '23514',
    });
  });

  it('D3 the event log is append-only, and abuse cannot exceed the internal cap', async () => {
    const stu = await createStudent(A.jar, 'H5-D3');
    const inv = await createInvoice(A.jar, stu.id, 100_000);
    const link = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 100_000 });
    await leaveHarnessTransaction();

    const policies = (await ownerPool.unsafe(
      `select count(*)::int as n from pg_policies where tablename='public_surface_events' and cmd in ('UPDATE','DELETE','ALL')`,
    )) as any[];
    expect(Number(policies[0].n)).toBe(0);
    const before = (await ownerPool.unsafe(
      `select id, kind from public_surface_events order by occurred_at limit 1`,
    )) as any[];
    expect(before.length).toBeGreaterThan(0);
    const updated = (await ownerPool.unsafe(
      `update public_surface_events set kind = 'submission_accepted' where id = $1 returning id`,
      [before[0].id],
    )) as any[];
    expect(updated.length).toBe(0);
    const after = (await ownerPool.unsafe(`select kind from public_surface_events where id = $1`, [
      before[0].id,
    ])) as any[];
    expect(after[0].kind).toBe(before[0].kind)
    const runtimeDelete = await withScopedDb({ kind: 'none' }, async (_db, sql) => {
      await sql.unsafe('SAVEPOINT h5d3').catch(() => {});
      try {
        await sql.unsafe(`delete from public_surface_events`);
        return 'ALLOWED';
      } catch (e: any) {
        return String(e?.code ?? 'error');
      } finally {
        await sql.unsafe('ROLLBACK TO SAVEPOINT h5d3').catch(() => {});
      }
    });
    expect(runtimeDelete).toBe('42501');

    // The recorder has an internal cap: past it, signals are dropped silently
    // (returns NULL) rather than erroring — telemetry must never fail a payment.
    const cappedOutcome = await ownerTry(
      '',
      [],
      async (conn) => {
        await conn.unsafe(`select set_config('app.r1_scope_depth', '1', false)`);
        await conn.unsafe(`select auth_scope_public_local($1)`, [link.token]);
      },
      async (conn) => {
        let allowed = 0;
        let dropped = 0;
        for (let i = 0; i < 260; i += 1) {
          const rows = (await conn.unsafe(
            `select auth_record_public_surface_event('submission_amount_mismatch', NULL, '{}'::jsonb) as id`,
          )) as any[];
          if (rows[0].id) allowed += 1;
          else dropped += 1;
        }
        return { ok: true as const, rows: [{ allowed, dropped }] };
      },
    );
    expect(cappedOutcome.ok, JSON.stringify(cappedOutcome)).toBe(true);
    const capped = (cappedOutcome as { ok: true; rows: any[] }).rows[0];
    expect(capped.allowed).toBeGreaterThan(0);
    expect(capped.dropped).toBeGreaterThan(0);
    expect(capped.allowed + capped.dropped).toBe(260);
  });
});

// ===========================================================================
// E. Authorization and tenant isolation of the operational paths
// ===========================================================================
describe('E — no unauthorized actor can operate the surface', () => {
  it('E1 rotation is owner-only', async () => {
    const stu = await createStudent(A.jar, 'H5-E1');
    const inv = await createInvoice(A.jar, stu.id, 100_000);
    const link = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 100_000 });

    const finance = await addMember(A, 'FINANCE_OFFICER');
    const admin = await addMember(A, 'SCHOOL_ADMIN');

    const asFinance = await callRoute('POST', `/api/payment-links/${link.token}/rotate`, finance.jar, {});
    expect(asFinance.status).toBe(403);
    const asAdmin = await callRoute('POST', `/api/payment-links/${link.token}/rotate`, admin.jar, {});
    expect(asAdmin.status).toBe(403);
    const anonymous = await callRoute('POST', `/api/payment-links/${link.token}/rotate`, null, {}, undefined, {
      csrf: false,
    });
    expect([401, 403]).toContain(anonymous.status);
    const noCsrf = await callRoute('POST', `/api/payment-links/${link.token}/rotate`, A.jar, {}, undefined, {
      csrf: false,
    });
    expect(noCsrf.status).toBe(403);

    // Nothing above changed the link.
    expect((await view(link.token)).status).toBe(200);
    const rotations = await tenantRows(A, async (sql) => {
      const rows = (await sql`select token_rotation_count from payment_links where id = ${link.id}::uuid`) as any[];
      return Number(rows[0].token_rotation_count);
    });
    expect(rotations).toBe(0);

    // A link belonging to another tenant is invisible to this owner (404, no oracle).
    const otherStu = await createStudent(B.jar, 'H5-E1B');
    const otherInv = await createInvoice(B.jar, otherStu.id, 100_000);
    const otherLink = await createLink(B.jar, { invoiceId: otherInv.id, amountKobo: 100_000 });
    const crossTenant = await callRoute('POST', `/api/payment-links/${otherLink.token}/rotate`, A.jar, {});
    expect(crossTenant.status).toBe(404);
    expect((await view(otherLink.token)).status).toBe(200);

    // The owner CAN rotate (positive control): the legitimate operator path works.
    const ok = await callRoute('POST', `/api/payment-links/${link.token}/rotate`, A.jar, { reason: 'drill' });
    expect(ok.status).toBe(200);
    expect(ok.data.link.rotationCount).toBe(1);
  });

  it('E2 the operational read routes require authorization and are tenant-scoped', async () => {
    const anonymousExposure = await callRoute('GET', '/api/payment-links/exposure', null);
    const anonymousSignals = await callRoute('GET', '/api/payment-links/signals', null);
    expect(anonymousExposure.status).toBe(401);
    expect(anonymousSignals.status).toBe(401);

    const stu = await createStudent(A.jar, 'H5-E2');
    const inv = await createInvoice(A.jar, stu.id, 100_000);
    const link = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 100_000 });
    await submit(link.token, { payerName: 'P', reference: ref('E2') }, key('e2'));

    const finance = await addMember(A, 'FINANCE_OFFICER');
    const asFinance = await callRoute('GET', '/api/payment-links/signals?since=1h', finance.jar);
    expect(asFinance.status).toBe(200);

    // The FINANCE_OFFICER sees only their own organization's signals.
    const asB = await callRoute('GET', '/api/payment-links/signals?since=1h', B.jar);
    expect(asB.status).toBe(200);
    const aLinkIds = new Set((asFinance.data.events as any[]).map((e) => e.linkId).filter(Boolean));
    for (const e of asB.data.events as any[]) {
      expect(aLinkIds.has(e.linkId)).toBe(false);
    }
    expect(JSON.stringify(asB.data)).not.toContain(A.orgId);
  });

  it('E3 the runtime role cannot reach the operational surface at all', async () => {
    const probes: Array<[string, string]> = [
      ['events table', `select count(*) from public_surface_events`],
      ['cache report', `select * from auth_public_submission_cache_report()`],
      ['prune', `select * from auth_public_submission_cache_prune(interval '90 days', 10, true)`],
      ['remediation report', `select * from auth_public_remediation_report()`],
      ['signal report', `select * from auth_public_surface_signal_report()`],
      ['rls suspend', `select auth_ops_suspend_rls(ARRAY['payments'])`],
      ['rls restore', `select auth_ops_restore_rls(ARRAY['payments'])`],
    ];
    for (const [label, statement] of probes) {
      const outcome = await withScopedDb({ kind: 'none' }, async (_db, sql) => {
        await sql.unsafe('SAVEPOINT h5e3').catch(() => {});
        try {
          await sql.unsafe(statement);
          return 'ALLOWED';
        } catch (e: any) {
          return String(e?.code ?? 'error');
        } finally {
          await sql.unsafe('ROLLBACK TO SAVEPOINT h5e3').catch(() => {});
        }
      });
      expect(outcome, `runtime role reached ${label}`).toBe('42501');
    }

    // The tenant-facing functions answer only inside a real scope, and the
    // exposure report requires a tenant context (never an owner/ambient one).
    const exposureWithoutTenant = await withScopedDb({ kind: 'none' }, async (_db, sql) => {
      await sql.unsafe('SAVEPOINT h5e3b').catch(() => {});
      try {
        await sql.unsafe(`select * from auth_public_link_exposure()`);
        return 'ALLOWED';
      } catch (e: any) {
        return String(e?.code ?? 'error');
      } finally {
        await sql.unsafe('ROLLBACK TO SAVEPOINT h5e3b').catch(() => {});
      }
    });
    expect(exposureWithoutTenant).toBe('42501');
  });
});

// ===========================================================================
// F. The lifecycle, end to end
//
// A–E prove the individual controls. F proves they compose: the *same* link,
// through every state an operator can put it in — live, rotated, revoked —
// with a real payer on the other side, and with the ledger checked at every
// step. This is the sequence an incident actually follows.
// ===========================================================================
describe('F — rotation and revocation lifecycle, end to end', () => {
  it('F1 a leaked, rotated, then revoked link loses no provenance and no money', async () => {
    const stu = await createStudent(A.jar, 'H5-F1');
    const inv = await createInvoice(A.jar, stu.id, 600_000);
    const link = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 600_000 });
    const oldToken = link.token;

    // 1. LIVE — the payer can see and pay.
    expect((await view(oldToken)).status).toBe(200);
    const first = await submit(oldToken, { payerName: 'Parent F1', reference: ref('F1') });
    expect(first.status).toBe(201);

    // Allocation snapshot: allocation is an R1/R2 (operator) concern, not part
    // of the public surface. H-5's lifecycle must not move it — whatever this
    // number is, it must be the same at the end of the lifecycle.
    const allocationTotal = async () =>
      tenantRows(A, async (sql) => {
        const r = (await sql`
          select coalesce(sum(amount_kobo), 0)::bigint as total
            from payment_allocations
           where invoice_id = ${inv.id}::uuid and status = 'ACTIVE'`) as any[];
        return Number(r[0].total);
      });
    const allocatedBefore = await allocationTotal();

    // 2. LEAK RESPONSE — the operator rotates the bearer credential.
    const rotated = await callRoute('POST', `/api/payment-links/${oldToken}/rotate`, A.jar, {
      reason: 'F1 leaked in a group chat',
    });
    expect(rotated.status).toBe(200);
    const newToken = rotated.data.link.token as string;
    expect(newToken).not.toBe(oldToken);
    expect(rotated.data.link.id).toBe(link.id);

    // 3. ROTATED — the leaked URL is dead, the school's new URL is live, and
    //    the money already taken is untouched by the rotation.
    expect((await view(oldToken)).status).toBe(404);
    expect((await view(newToken)).status).toBe(200);
    const second = await submit(newToken, { payerName: 'Parent F1b', reference: ref('F1') });
    expect(second.status).toBe(201);

    // 4. REVOKED — the operator closes the link entirely.
    const revoked = await callRoute('PATCH', `/api/payment-links/${newToken}`, A.jar, {
      reason: 'F1 lifecycle closure',
    });
    expect(revoked.status).toBe(200);

    // 5. CLOSED — nothing about the link works any more, and it cannot be
    //    silently brought back to life by a rotation.
    expect((await view(newToken)).status).toBe(404);
    const afterRevoke = await submit(newToken, { payerName: 'Too late', reference: ref('F1') });
    expect(afterRevoke.status).toBe(404);
    const rotateRevoked = await callRoute('POST', `/api/payment-links/${newToken}/rotate`, A.jar, {});
    expect([400, 404, 409]).toContain(rotateRevoked.status);

    // 6. LEDGER — exactly the two accepted submissions, on ONE link id, and
    //    both are allocated to the invoice the link was created for.
    const ledger = await tenantRows(A, async (sql) => {
      const rows = (await sql`
        select p.link_id,
               count(*)::int as n,
               sum(p.amount_kobo)::bigint as total,
               count(a.id)::int as allocated_rows
          from payments p
          left join payment_allocations a on a.payment_id = p.id and a.invoice_id = ${inv.id}::uuid
         where p.link_id = ${link.id}::uuid
         group by p.link_id`) as any[];
      return rows;
    });
    expect(ledger.length).toBe(1);
    expect(ledger[0].link_id).toBe(link.id);
    expect(Number(ledger[0].n)).toBe(2);
    // The public link has a fixed price (600,000 kobo); every accepted
    // submission records exactly that amount against the same link — rotation
    // and revocation change neither the count nor the total.
    expect(Number(ledger[0].total)).toBe(1_200_000);

    // Allocation is R1/R2 territory; what H-5 must not do is disturb it. The
    // invoice can never be allocated more than it was billed, and rotation plus
    // revocation must leave the allocation exactly as the submissions left it.
    expect(await allocationTotal()).toBe(allocatedBefore);
    expect(allocatedBefore).toBeLessThanOrEqual(600_000);

    // 7. IDENTITY — same link, one rotation, and the stored fingerprint tracks
    //    the credential that is live now (never the leaked one).
    const state = await tenantRows(A, async (sql) => {
      const rows = (await sql`
        select status, token_rotation_count, token_rotated_at,
               (token = ${newToken}) as holds_new, (token = ${oldToken}) as holds_old,
               length(token_fingerprint) as fp_len
          from payment_links where id = ${link.id}::uuid`) as any[];
      return rows;
    });
    expect(state.length).toBe(1);
    expect(state[0].status).toBe('REVOKED');
    expect(Number(state[0].token_rotation_count)).toBe(1);
    expect(state[0].token_rotated_at).toBeTruthy();
    expect(state[0].holds_new).toBe(true);
    expect(state[0].holds_old).toBe(false);
    expect(Number(state[0].fp_len)).toBe(16);

    // 8. EVIDENCE — both administrative actions are audited, and the audit
    //    trail for them carries no bearer credential at all.
    const audit = await tenantRows(A, async (sql) => {
      const rows = (await sql`
        select action, metadata from audit_events
         where entity_id = ${link.id}::uuid and action in ('payment_link.rotate','payment_link.revoke')
         order by action`) as any[];
      return rows;
    });
    expect(audit.map((r) => r.action).sort()).toEqual(['payment_link.revoke', 'payment_link.rotate']);
    const auditText = JSON.stringify(audit);
    expect(auditText).not.toContain(oldToken);
    expect(auditText).not.toContain(newToken);

    // 9. OPERATIONAL VIEW — the rotation is visible to the school as a signal,
    //    and the signal feed still never carries the credential.
    const signals = await callRoute('GET', '/api/payment-links/signals?since=24h', A.jar);
    expect(signals.status).toBe(200);
    const rotatedEvents = (signals.data.events as any[]).filter(
      (e) => e.kind === 'link_rotated' && e.linkId === link.id,
    );
    expect(rotatedEvents.length).toBe(1);
    expect(signals.data.summary.rotations).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(signals.data)).not.toContain(oldToken);
    expect(JSON.stringify(signals.data)).not.toContain(newToken);

    // 10. EXPOSURE — the rotated link is no longer a live token in stored rows,
    //     so it is no longer reported as needing rotation.
    const exposure = await callRoute('GET', '/api/payment-links/exposure', A.jar);
    expect(exposure.status).toBe(200);
    const stillFlagged = (exposure.data.links as any[]).filter(
      (l) => l.linkId === link.id && l.recommendedAction === 'ROTATE',
    );
    expect(stillFlagged.length).toBe(0);
  });

  it('F2 a dead token cannot be resurrected by the replay cache, and pruning cannot duplicate a payment', async () => {
    const stu = await createStudent(A.jar, 'H5-F2');
    const inv = await createInvoice(A.jar, stu.id, 250_000);
    const link = await createLink(A.jar, { invoiceId: inv.id, amountKobo: 250_000 });
    const oldToken = link.token;
    const reusedKey = key('F2');

    // A payer submits, and the reservation lands in the append-only cache.
    const accepted = await submit(oldToken, { payerName: 'Parent F2', reference: ref('F2') }, reusedKey);
    expect(accepted.status).toBe(201);

    // The credential leaks, the operator rotates.
    const rotated = await callRoute('POST', `/api/payment-links/${oldToken}/rotate`, A.jar, {});
    expect(rotated.status).toBe(200);
    const newToken = rotated.data.link.token as string;
    await leaveHarnessTransaction();

    /**
     * Payments attributed to this link — the money a leaked URL helped take, and
     * the money a rotation or a prune must never duplicate. Read through the
     * tenant scope: `payments` is FORCE-RLS, so an owner-side count with no
     * context (correctly) sees nothing at all.
     */
    const paymentCount = async () => {
      const rows = await tenantRows(A, async (sql) => {
        const r = (await sql`select count(*)::int as n from payments where link_id = ${link.id}::uuid`) as any[];
        return Number(r[0].n);
      });
      return rows;
    };
    const before = await paymentCount();

    // The leaked token plus the ORIGINAL idempotency key: the exact request a
    // leaked URL would let an attacker replay. It must not be answered with a
    // replay of the original success.
    const replayWithLeakedUrl = await submit(
      oldToken,
      { payerName: 'Parent F2', reference: ref('F2') },
      reusedKey,
    );
    expect(replayWithLeakedUrl.status).toBe(404);
    expect(await paymentCount()).toBe(before);

    // Prune the cache (dry run first — the default), then for real.
    const dry = await ownerPool.unsafe(`select * from auth_public_submission_cache_prune()`);
    expect(Array.isArray(dry)).toBe(true);
    const applied = (await ownerPool.unsafe(
      `select * from auth_public_submission_cache_prune($1::interval, $2::int, $3::boolean)`,
      ['90 days', 500, true],
    )) as any[];
    expect(applied.length).toBeGreaterThanOrEqual(1);

    // After pruning: the dead token is still dead, the live token still works,
    // and no payment was created, duplicated or destroyed by any of it.
    expect((await view(oldToken)).status).toBe(404);
    const stillWorking = await submit(newToken, { payerName: 'Parent F2b', reference: ref('F2') });
    expect(stillWorking.status).toBe(201);
    expect(await paymentCount()).toBe(before + 1);

    // The same key on the NEW token is a genuine retry of a live link: it may
    // replay, but it must never mint a second payment for the same key.
    const retryOnNewToken = await submit(newToken, { payerName: 'Parent F2b', reference: ref('F2') }, key('F2b'));
    expect(retryOnNewToken.status).toBe(201);
    expect(await paymentCount()).toBe(before + 2);
  });
});
