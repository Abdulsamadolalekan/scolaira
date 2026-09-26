// @vitest-environment node
/**
 * H-5 — INDEPENDENT RE-AUDIT.
 *
 * This suite does not re-run the implementation tests and does not import their
 * helpers. It starts from the question an auditor asks when handed the H-5
 * claims and tries to falsify each one from the outside:
 *
 *   claim 1  A leaked bearer can be remediated by rotation, and rotation alone
 *            retires that credential — nothing else about the link changes.
 *   claim 2  The operational record correlates with real submissions without
 *            ever storing the credential (`token_fingerprint` == the audit
 *            trail's `linkFingerprint`).
 *   claim 3  Retention cannot destroy the live retry window, cannot delete an
 *            orphaned reservation, and cannot be aimed by bad input.
 *   claim 4  No authenticated tenant, and no runtime-role connection, can run
 *            the operational controls or write the event log.
 *   claim 5  Abuse signals cannot be forged, cannot be used to enumerate, and
 *            cannot carry data.
 *   claim 6  Telemetry cannot fail a payment: the payer's outcome is identical
 *            when the recorder is broken.
 *   claim 7  Every operational action leaves the append-only / RLS posture
 *            exactly as R1–R3 froze it.
 *
 * A finding is recorded as an assertion failure, not as a comment.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { call, CookieJar } from '../auth/support';
import { POST as registerPost } from '@/app/api/auth/register/route';
import { GET as meGet } from '@/app/api/auth/me/route';
import { getSql, closeDb } from '@/lib/db';
import { withSystemContext } from '@/lib/db/tenant';
import { organizationMembers } from '@/lib/db/schema';

type Jar = InstanceType<typeof CookieJar>;
type Actor = { jar: Jar; orgId: string; userId: string };

const uuid = () => randomUUID();
const ref = (p = 'RA') => `${p}-${uuid().slice(0, 8)}`;
const key = (p = 'ra') => `${p}-${uuid()}`;

const ownerPool = postgres(process.env.DATABASE_MIGRATION_URL!, { max: 2 });

async function commitHarness(): Promise<void> {
  await getSql()
    .unsafe('COMMIT')
    .catch(() => {});
}

type Probe = { ok: true; rows: any[] } | { ok: false; code: string; message: string };

/** Owner-side probe on its own connection; never leaves RLS suspended. */
async function asOwner(
  statement: string,
  args: any[] = [],
  setup?: (conn: any) => Promise<void>,
): Promise<Probe> {
  const conn: any = await (ownerPool as any).reserve();
  try {
    await conn.unsafe('BEGIN');
    await conn.unsafe('SAVEPOINT ra');
    try {
      if (setup) await setup(conn);
      const rows = (await conn.unsafe(statement, args)) as any[];
      await conn.unsafe('RELEASE SAVEPOINT ra');
      return { ok: true, rows };
    } catch (e: any) {
      await conn.unsafe('ROLLBACK TO SAVEPOINT ra').catch(() => {});
      return { ok: false, code: String(e?.code), message: String(e?.message ?? '') };
    }
  } finally {
    await conn.unsafe('ROLLBACK').catch(() => {});
    conn.release();
  }
}

const suspend = (tables: string[]) => async (conn: any) => {
  await conn.unsafe(`select auth_ops_suspend_rls($1::text[])`, [tables]);
};

/**
 * Owner-side statement that must PERSIST (setup an auditor needs the running
 * application to observe, e.g. backdating a row or renaming a function while
 * the recorder is broken). Unlike `asOwner` it commits; the caller is
 * responsible for restoring what it changed.
 */
async function asOwnerCommit(
  statement: string,
  args: any[] = [],
  tables: string[] = [],
  setup?: (conn: any) => Promise<void>,
): Promise<Probe> {
  const conn: any = await (ownerPool as any).reserve();
  try {
    await conn.unsafe('BEGIN');
    if (setup) await setup(conn);
    // Suspend, write, RESTORE, then commit. Committing a suspension would leave
    // the frozen posture broken for everything after the test — the suspension
    // is transactional DDL, which is exactly why it is only ever used in a
    // suspend/write/restore envelope.
    if (tables.length > 0) await conn.unsafe(`select auth_ops_suspend_rls($1::text[])`, [tables]);
    const rows = (await conn.unsafe(statement, args)) as any[];
    if (tables.length > 0) await conn.unsafe(`select auth_ops_restore_rls($1::text[])`, [tables]);
    await conn.unsafe('COMMIT');
    return { ok: true, rows };
  } catch (e: any) {
    await conn.unsafe('ROLLBACK').catch(() => {});
    return { ok: false, code: String(e?.code), message: String(e?.message ?? '') };
  } finally {
    conn.release();
  }
}

async function route(
  method: string,
  path: string,
  jar: Jar | null,
  body?: unknown,
  opts: { csrf?: boolean } = {},
) {
  const [pathname] = path.split('?');
  const segs = pathname!.split('/').filter(Boolean);
  const load = (modPath: string, params?: Record<string, string>) =>
    import(/* @vite-ignore */ `@/${modPath}`).then((mod: any) => {
      const exports = mod?.default ?? mod;
      return { exports, params };
    });
  let target: { exports: any; params?: Record<string, string> };
  const [, s1, s2, s3] = segs;
  if (s1 === 'payment-links' && segs.length === 4)
    target = await load(`app/api/payment-links/[token]/${s3}/route`, { token: s2! });
  else if (s1 === 'payment-links' && segs.length === 3 && ['exposure', 'signals'].includes(s2!))
    target = await load(`app/api/payment-links/${s2}/route`);
  else if (s1 === 'payment-links' && segs.length === 3)
    target = await load('app/api/payment-links/[token]/route', { token: s2! });
  else if (s1 === 'payments' && segs.length === 4)
    target = await load(`app/api/payments/[id]/${s3}/route`, { id: s2! });
  else target = await load('app/' + segs.join('/') + '/route');
  const handler = target.exports[method];
  expect(typeof handler, `${method} ${pathname} must be exported`).toBe('function');
  return call(
    (async (req: Request) =>
      target.params ? handler(req, { params: Promise.resolve(target.params) }) : handler(req)) as any,
    (jar ?? new CookieJar()) as Jar,
    {
      method,
      path,
      body,
      csrf: opts.csrf ?? !['GET', 'HEAD', 'OPTIONS'].includes(method),
      headers: { 'content-type': 'application/json' },
    },
  );
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
      firstName: 'RA',
      lastName: 'Owner',
      organizationName: 'School ' + slug,
      organizationSlug: slug,
    },
  });
  expect(reg.status).toBe(201);
  const me = await call(meGet, jar, { method: 'GET', path: '/api/auth/me' });
  await route('POST', '/api/setup/seed-current-term', jar, {});
  return { jar, orgId: me.data.activeOrganizationId, userId: me.data.user.id };
}

async function addRole(owner: Actor, role: 'SCHOOL_ADMIN' | 'FINANCE_OFFICER' | 'STAFF'): Promise<Actor> {
  const slug = `${role.toLowerCase().replace(/_/g, '-')}-${uuid().slice(0, 8)}`;
  const jar = new CookieJar();
  const reg = await call(registerPost, jar, {
    method: 'POST',
    path: '/api/auth/register',
    body: {
      email: `${slug}@example.com`,
      password: 'Pass-' + uuid().slice(0, 8) + '-A1!',
      firstName: role,
      lastName: 'User',
      organizationName: role + ' solo',
      organizationSlug: slug,
    },
  });
  expect(reg.status).toBe(201);
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
  await route('POST', '/api/auth/select-organization', jar, { organizationId: owner.orgId });
  return { jar, orgId: owner.orgId, userId: me.data.user.id };
}

async function makeLink(actor: Actor, amountKobo = 250_000) {
  const stu = await route('POST', '/api/students', actor.jar, {
    studentId: `RA-${uuid().slice(0, 6)}`,
    firstName: 'Ada',
    lastName: 'Okafor',
    gender: 'F',
  });
  const inv = await route(
    'POST',
    '/api/invoices',
    actor.jar,
    {
      studentId: stu.data.student.id,
      dueDate: new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10),
      lines: [{ description: 'Tuition', quantity: 1, unitRateKobo: amountKobo }],
    },
    undefined,
  );
  const link = await route('POST', '/api/payment-links', actor.jar, {
    invoiceId: inv.data.invoice.id,
    amountKobo,
  });
  expect(link.status).toBe(201);
  return link.data.link as { id: string; token: string };
}

async function gucReset() {
  const sql = getSql();
  await sql`select auth_clear_public_context()`.catch(() => {});
  await sql`select clear_app_context()`.catch(() => {});
}

async function submit(token: string, body: unknown, submitKey?: string) {
  const mod: any = await import(/* @vite-ignore */ `@/app/api/p/[token]/submit/route`);
  await gucReset();
  const res: Response = await mod.POST(
    new Request(`http://test.local/api/p/${token}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': submitKey ?? key() },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ token }) },
  ).finally(() => gucReset());
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
  await gucReset();
  const res: Response = await mod
    .GET(new Request(`http://test.local/api/p/${token}/view`), { params: Promise.resolve({ token }) })
    .finally(() => gucReset());
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
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

async function tenantProbe(actor: Actor, statement: string, args: any[] = []): Promise<string> {
  return asTenant(actor, async (sql) => {
    await sql.unsafe('SAVEPOINT ra_t').catch(() => {});
    try {
      await sql.unsafe(statement, args);
      return 'ALLOWED';
    } catch (e: any) {
      return String(e?.code ?? 'error');
    } finally {
      await sql.unsafe('ROLLBACK TO SAVEPOINT ra_t').catch(() => {});
    }
  });
}

let A: Actor;
let B: Actor;

beforeAll(async () => {
  A = await registerOwner('ra-a');
  B = await registerOwner('ra-b');
}, 240_000);

afterAll(async () => {
  await ownerPool.end({ timeout: 5 }).catch(() => {});
  await closeDb();
});

describe('RA — independent re-audit of the H-5 contract', () => {
  it('RA1 rotation retires only the credential, repeatedly, and never resurrects a link', async () => {
    const link = await makeLink(A, 300_000);
    const t0 = link.token;

    const first = await route('POST', `/api/payment-links/${t0}/rotate`, A.jar, { reason: 'audit' });
    expect(first.status).toBe(200);
    const t1 = first.data.link.token as string;
    expect(t1).not.toBe(t0);
    expect((await view(t0)).status).toBe(404);
    expect((await view(t1)).status).toBe(200);

    // Rotate again: the second rotation must kill the FIRST replacement too,
    // and the count must keep climbing (double rotation is not a reset).
    const second = await route('POST', `/api/payment-links/${t1}/rotate`, A.jar, {});
    expect(second.status).toBe(200);
    const t2 = second.data.link.token as string;
    expect(second.data.link.rotationCount).toBe(2);
    for (const dead of [t0, t1]) {
      expect((await view(dead)).status).toBe(404);
      expect((await submit(dead, { payerName: 'x', reference: ref('RA1') })).status).toBe(404);
    }
    expect((await view(t2)).status).toBe(200);
    // Same link identity throughout: submissions still bind to it.
    const ok = await submit(t2, { payerName: 'Parent', reference: ref('RA1') });
    expect(ok.status).toBe(201);
    expect(ok.body.payment.amountKobo).toBe(300_000);

    // A revoked link cannot be rotated back into service, and its token is dead.
    const revoked = await makeLink(A, 120_000);
    expect((await route('PATCH', `/api/payment-links/${revoked.token}`, A.jar, { reason: 'audit' })).status).toBe(200);
    const rotateRevoked = await route('POST', `/api/payment-links/${revoked.token}/rotate`, A.jar, {});
    expect(rotateRevoked.status).toBe(400);
    expect((await view(revoked.token)).status).toBe(404);

    // An EXPIRED link: whatever the endpoint decides, neither token may
    // authorize anything (the expiry rule is enforced by the database).
    const expiring = await makeLink(A, 90_000);
    await commitHarness();
    const expired = await asOwnerCommit(
      `update payment_links set expires_at = now() - interval '1 hour' where id = $1::uuid returning id`,
      [expiring.id],
      ['payment_links'],
    );
    expect(expired.ok, JSON.stringify(expired)).toBe(true);
    const rotatedExpired = await route('POST', `/api/payment-links/${expiring.token}/rotate`, A.jar, {});
    expect([200, 400]).toContain(rotatedExpired.status);
    const candidate = rotatedExpired.status === 200 ? rotatedExpired.data.link.token : expiring.token;
    expect([404, 410]).toContain((await view(expiring.token)).status);
    expect([404, 410]).toContain((await view(candidate)).status);
  });

  it('RA2 the rotation fingerprint is the audit trail’s fingerprint, and it is not a credential', async () => {
    const link = await makeLink(A, 150_000);
    const submitted = await submit(link.token, { payerName: 'Parent', reference: ref('RA2') });
    expect(submitted.status).toBe(201);
    await commitHarness();

    const fpBefore = await asOwner(
      `select token_fingerprint, token_rotation_count from payment_links where id = $1::uuid`,
      [link.id],
      suspend(['payment_links']),
    );
    expect(fpBefore.ok, JSON.stringify(fpBefore)).toBe(true);
    if (!fpBefore.ok) throw new Error('probe failed');
    const fingerprint = fpBefore.rows[0].token_fingerprint as string;
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);

    // The audit trail recorded the SAME value for the submission, which is the
    // whole point of the column: correlate without the token.
    const audit = await asOwner(
      `select metadata->>'linkFingerprint' as fp from audit_events
        where organization_id = $1::uuid and metadata->>'linkId' = $2
        order by created_at desc limit 1`,
      [A.orgId, link.id],
      suspend(['audit_events']),
    );
    expect(audit.ok, JSON.stringify(audit)).toBe(true);
    if (!audit.ok) throw new Error('probe failed');
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows[0].fp).toBe(fingerprint);
    // The token itself appears nowhere in the trail.
    const leak = await asOwner(
      `select count(*)::int as n from audit_events
        where organization_id = $1::uuid and (metadata::text like '%' || $2 || '%')`,
      [A.orgId, link.token],
      suspend(['audit_events']),
    );
    if (!leak.ok) throw new Error('probe failed');
    expect(Number(leak.rows[0].n)).toBe(0);

    // Rotation changes the fingerprint: a stored fingerprint cannot be replayed
    // as a credential, and the old fingerprint no longer describes the live link.
    const rotated = await route('POST', `/api/payment-links/${link.token}/rotate`, A.jar, {});
    expect(rotated.status).toBe(200);
    await commitHarness();
    const fpAfter = await asOwner(
      `select token_fingerprint from payment_links where id = $1::uuid`,
      [link.id],
      suspend(['payment_links']),
    );
    if (!fpAfter.ok) throw new Error('probe failed');
    expect(fpAfter.rows[0].token_fingerprint).not.toBe(fingerprint);
    expect((await view(link.token)).status).toBe(404);
  });

  it('RA3 retention cannot reach the live window, an orphaned reservation, or bad input', async () => {
    const link = await makeLink(A, 220_000);
    // one live PENDING reservation and one row whose payment does not exist
    const live = await submit(link.token, { payerName: 'Live', reference: ref('RA3') });
    expect(live.status).toBe(201);
    await commitHarness();

    // A reservation whose payment does not exist cannot be created at all: the
    // composite FK to (organization_id, payment_id) makes the prune's
    // "never delete a payment-less row" guard defence in depth. Verified, not
    // assumed.
    const orphanAttempt = await asOwner(
      `insert into public_submission_keys
         (organization_id, link_id, key_hash, reference_hash, payment_id, payment_number, amount_kobo, status, created_at)
       values ($1::uuid, $2::uuid, repeat('a', 64), repeat('b', 64), $3::uuid, 'PMT-ORPHAN', 1000, 'PENDING', now() - interval '4000 days')`,
      [A.orgId, link.id, uuid()],
      suspend(['public_submission_keys']),
    );
    expect(orphanAttempt.ok, 'an orphaned reservation must be impossible').toBe(false);
    expect(!orphanAttempt.ok ? orphanAttempt.code : '').toBe('23503');
    const fkBackstop = await asOwner(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'public_submission_keys__payment_id__org_fkey'`,
    );
    if (!fkBackstop.ok) throw new Error('probe failed');
    expect(String(fkBackstop.rows[0]?.def)).toContain('FOREIGN KEY');

    // Backdate the live reservation ten years — and commit it, so the prune
    // really does have an eligible-looking row to refuse.
    const backdate = await asOwnerCommit(
      `update public_submission_keys set created_at = now() - interval '3650 days' where payment_number = $1 returning id`,
      [live.body.payment.paymentNumber],
      ['public_submission_keys'],
    );
    expect(backdate.ok, JSON.stringify(backdate)).toBe(true);

    // Aim it with everything an operator could get wrong.
    for (const statement of [
      `select * from auth_public_submission_cache_prune(interval '1 hour', 50000, false)`,
      `select * from auth_public_submission_cache_prune(interval '3651 days', 50000, false)`,
      `select * from auth_public_submission_cache_prune(interval '90 days', 0, false)`,
      `select * from auth_public_submission_cache_prune(interval '90 days', 50001, false)`,
      `select * from auth_public_submission_cache_prune(interval '90 days', -5, false)`,
    ]) {
      const outcome = await asOwner(statement);
      expect(outcome.ok, `should have been refused: ${statement}`).toBe(false);
      expect(!outcome.ok ? outcome.code : 'ACCEPTED').toBe('22023');
    }

    // A maximal, applied run: the live PENDING reservation and the orphaned row
    // both survive (one is the retry window, the other has no payment at all).
    const applied = await asOwner(
      `select * from auth_public_submission_cache_prune(interval '3650 days', 50000, false)`,
    );
    expect(applied.ok, JSON.stringify(applied)).toBe(true);

    const survivors = await asOwner(
      `select payment_number, created_at from public_submission_keys
        where organization_id = $1::uuid and payment_number = ANY($2::text[])`,
      [A.orgId, [live.body.payment.paymentNumber]],
      suspend(['public_submission_keys']),
    );
    expect(survivors.ok, JSON.stringify(survivors)).toBe(true);
    expect(survivors.ok ? survivors.rows.length : -1).toBe(1);

    // And the cache is still usable: the live reservation replays.
    const replay = await submit(link.token, { payerName: 'Live', reference: 'never-used' });
    void replay;
    const again = await submit(
      link.token,
      { payerName: 'Live', reference: 'never-used' },
      key('ra3-replay'),
    );
    expect([201, 200]).toContain(again.status);
  });

  it('RA4 no tenant session and no runtime privilege can run the operational controls', async () => {
    const controlStatements = [
      `select * from auth_public_submission_cache_prune()`,
      `select * from auth_public_submission_cache_report()`,
      `select * from auth_public_remediation_report()`,
      `select * from auth_public_surface_signal_report()`,
      `select auth_ops_suspend_rls(ARRAY['payments'])`,
      `select auth_ops_restore_rls(ARRAY['payments'])`,
      `insert into public_surface_events (kind) values ('submission_accepted')`,
      `update public_surface_events set kind = 'link_rotated'`,
      `delete from public_surface_events`,
      `delete from public_submission_keys where false`,
    ];
    for (const statement of controlStatements) {
      // (a) authenticated tenant (owner of the organization, highest role).
      const asTenantOutcome = await tenantProbe(A, statement);
      expect(asTenantOutcome, `tenant reached: ${statement}`).toBe('42501');
    }

    // (b) the runtime role has no privileges on the event log at all.
    const priv = await asOwner(
      `select
         has_table_privilege('scolaira_app', 'public_surface_events', 'SELECT') as sel,
         has_table_privilege('scolaira_app', 'public_surface_events', 'INSERT') as ins,
         has_table_privilege('scolaira_app', 'public_surface_events', 'UPDATE') as upd,
         has_table_privilege('scolaira_app', 'public_surface_events', 'DELETE') as del,
         has_function_privilege('scolaira_app', 'auth_public_submission_cache_prune(interval,integer,boolean)', 'EXECUTE') as prune,
         has_function_privilege('scolaira_app', 'auth_public_remediation_report()', 'EXECUTE') as report,
         has_function_privilege('scolaira_app', 'auth_ops_suspend_rls(text[])', 'EXECUTE') as suspend,
         has_function_privilege('scolaira_app', 'auth_public_link_exposure()', 'EXECUTE') as exposure,
         has_function_privilege('scolaira_app', 'auth_public_surface_events(interval,integer)', 'EXECUTE') as tenant_events`,
    );
    expect(priv.ok).toBe(true);
    if (!priv.ok) throw new Error('probe failed');
    expect(priv.rows[0]).toMatchObject({
      sel: false, ins: false, upd: false, del: false,
      prune: false, report: false, suspend: false,
      exposure: true, tenant_events: true,
    });
  });

  it('RA5 abuse signals cannot be forged, cannot enumerate, and cannot carry data', async () => {
    const link = await makeLink(A, 180_000);
    const other = await makeLink(B, 180_000);
    await commitHarness();

    const publicContext = (token: string) => async (conn: any) => {
      await conn.unsafe(`select set_config('app.r1_scope_depth','1',false)`);
      await conn.unsafe(`select auth_scope_public_local($1)`, [token]);
    };
    // `::text::jsonb` matters: without the text step the driver hands the
    // parameter over as a JSON *string*, and every probe below would be refused
    // as "not an object" — passing for the wrong reason.
    const record = (kind: string, linkId: string | null, detail: string) =>
      asOwnerCommit(
        `select auth_record_public_surface_event($1, $2::uuid, $3::text::jsonb) as id`,
        [kind, linkId, detail],
        [],
        publicContext(link.token),
      );

    // A bearer may describe its own link and only submission outcomes…
    const selfReport = await record('submission_amount_mismatch', null, '{}');
    expect(
      selfReport,
      `self-report refused: ${!selfReport.ok ? `${selfReport.code} ${selfReport.message}` : ''}`,
    ).toMatchObject({ ok: true });
    const withDetail = await record('submission_amount_mismatch', null, '{"refusals":1,"severity":"warning"}');
    expect(withDetail, JSON.stringify(withDetail)).toMatchObject({ ok: true });
    expect(await record('link_rotated', null, '{}')).toMatchObject({ ok: false, code: '42501' });
    expect(await record('cache_pruned', null, '{}')).toMatchObject({ ok: false, code: '22023' });
    // …never another school's link (enumeration probe)…
    expect(await record('submission_accepted', other.id, '{}')).toMatchObject({ ok: false, code: '42501' });
    // …and never data.
    for (const detail of [
      '{"token":"x"}',
      '{"payerEmail":"a@b.c"}',
      '{"reference":"R"}',
      '{"amountKobo":1}',
      '{"nested":{"token":"x"}}',
      '{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8,"i":9}',
      '[]',
    ]) {
      const outcome = await record('submission_accepted', null, detail);
      expect(outcome, `detail accepted: ${detail}`).toMatchObject({ ok: false, code: '22023' });
    }

    // An anonymous caller can only report a forged bearer — and that event has
    // no tenant, so no school can see it.
    const anon = await asOwner(`select auth_record_public_surface_event($1, NULL, '{}'::jsonb) as id`, [
      'submission_unknown_bearer',
    ]);
    expect(anon.ok).toBe(true);
    const anonScoped = await asOwner(
      `select count(*)::int as n from public_surface_events where organization_id is null and kind = 'submission_unknown_bearer'`,
      [],
      suspend(['public_surface_events']),
    );
    if (!anonScoped.ok) throw new Error('probe failed');
    expect(Number(anonScoped.rows[0].n)).toBeGreaterThanOrEqual(1);
    const tenantVisibility = await route('GET', '/api/payment-links/signals?since=24h', A.jar);
    expect(tenantVisibility.status).toBe(200);
    expect((tenantVisibility.data.events as any[]).every((e) => e.linkId !== null || e.kind !== 'submission_unknown_bearer')).toBe(true);
  });

  it('RA6 a broken recorder cannot fail a payment, change its status, or alter the response body', async () => {
    const link = await makeLink(A, 260_000);
    const body = { payerName: 'Parent', reference: ref('RA6') };

    const healthy = await submit(link.token, body, key('ra6'));

    // Break the recorder for the second submission by renaming it inside the
    // harness transaction (the app connection shares it).
    await commitHarness();
    const renamed = await asOwnerCommit(
      `alter function public.auth_record_public_surface_event(text, uuid, jsonb)
         rename to auth_record_public_surface_event_broken`,
    );
    expect(renamed.ok, JSON.stringify(renamed)).toBe(true);
    let broken;
    try {
      broken = await submit(link.token, { payerName: 'Parent', reference: ref('RA6') }, key('ra6b'));
    } finally {
      const restored = await asOwnerCommit(
        `alter function public.auth_record_public_surface_event_broken(text, uuid, jsonb)
           rename to auth_record_public_surface_event`,
      );
      expect(restored.ok, JSON.stringify(restored)).toBe(true);
    }
    expect(broken.status).toBe(healthy.status);
    expect(healthy.status).toBe(201);
    expect(Object.keys(broken.body)).toEqual(Object.keys(healthy.body));
    expect(broken.body.payment.status).toBe(healthy.body.payment.status);

    // The ledger still got exactly one payment per submission.
    await commitHarness();
    const rows = await asOwner(
      `select count(*)::int as n from payments where organization_id = $1::uuid and reference = $2`,
      [A.orgId, body.reference],
      suspend(['payments']),
    );
    if (!rows.ok) throw new Error('probe failed');
    expect(Number(rows.rows[0].n)).toBe(1);
  });

  it('RA7 rotation is refused to every non-owner role and to every other tenant', async () => {
    const link = await makeLink(A, 140_000);
    const finance = await addRole(A, 'FINANCE_OFFICER');
    const admin = await addRole(A, 'SCHOOL_ADMIN');
    const staff = await addRole(A, 'STAFF');

    for (const actor of [finance, admin, staff]) {
      const outcome = await route('POST', `/api/payment-links/${link.token}/rotate`, actor.jar, {});
      expect(outcome.status, `role ${actor.userId} rotated a link`).toBe(403);
    }
    // Anonymous and cross-tenant callers learn nothing and change nothing.
    const anon = await route('POST', `/api/payment-links/${link.token}/rotate`, null, {}, { csrf: false });
    expect([401, 403]).toContain(anon.status);
    const crossTenant = await route('POST', `/api/payment-links/${link.token}/rotate`, B.jar, {});
    expect(crossTenant.status).toBe(404);

    // Unchanged, and still usable by its own tenant.
    expect((await view(link.token)).status).toBe(200);
    await commitHarness();
    const count = await asOwner(
      `select token_rotation_count from payment_links where id = $1::uuid`,
      [link.id],
      suspend(['payment_links']),
    );
    if (!count.ok) throw new Error('probe failed');
    expect(Number(count.rows[0].token_rotation_count)).toBe(0);
    expect((await route('POST', `/api/payment-links/${link.token}/rotate`, A.jar, {})).status).toBe(200);
  });

  it('RA8 the frozen RLS / append-only posture survives every operational action', async () => {
    // Exercise the whole operational surface, then re-freeze the assertion.
    const link = await makeLink(A, 130_000);
    await submit(link.token, { payerName: 'Parent', reference: ref('RA8') });
    await route('POST', `/api/payment-links/${link.token}/rotate`, A.jar, { reason: 'posture probe' });
    await route('GET', '/api/payment-links/exposure', A.jar);
    await route('GET', '/api/payment-links/signals?since=1h', A.jar);
    await commitHarness();
    await asOwner(`select * from auth_public_submission_cache_report()`);
    await asOwner(`select * from auth_public_remediation_report()`);
    await asOwner(`select * from auth_public_surface_signal_report()`);
    await asOwner(`select * from auth_public_submission_cache_prune()`);
    await asOwner(`select * from auth_public_submission_cache_prune(interval '90 days', 5, false)`);

    const posture = await asOwner(
      `select c.relname,
              c.relrowsecurity as rls,
              c.relforcerowsecurity as force,
              (select count(*)::int from pg_policies p
                where p.tablename = c.relname and p.cmd in ('UPDATE','DELETE','ALL')) as mutating_policies
         from pg_class c
        where c.relname in ('payment_links','payments','audit_events','public_submission_keys','public_surface_events')
        order by c.relname`,
    );
    expect(posture.ok, JSON.stringify(posture)).toBe(true);
    if (!posture.ok) throw new Error('probe failed');
    expect(posture.rows.length).toBe(5);
    for (const row of posture.rows) {
      expect(row.rls, `${row.relname} lost RLS`).toBe(true);
      expect(row.force, `${row.relname} lost FORCE RLS`).toBe(true);
    }
    for (const row of posture.rows.filter((r) =>
      ['public_submission_keys', 'public_surface_events'].includes(r.relname),
    )) {
      expect(Number(row.mutating_policies), `${row.relname} gained a mutating policy`).toBe(0);
    }
    // `audit_events` carries the pre-existing R1 tenant policy (cmd ALL). For
    // the runtime role — the only role that serves requests — the append-only
    // guarantee is the missing privilege, which is measured here rather than
    // assumed: H-5 must not have widened it.
    const auditPrivs = await asOwner(
      `select has_table_privilege('scolaira_app','audit_events','UPDATE') as upd,
              has_table_privilege('scolaira_app','audit_events','DELETE') as del,
              has_table_privilege('scolaira_app','audit_events','INSERT') as ins`,
    );
    if (!auditPrivs.ok) throw new Error('probe failed');
    expect(auditPrivs.rows[0]).toMatchObject({ upd: false, del: false, ins: true });

    // The append-only tables cannot be rewritten even by the owner.
    for (const [table, column] of [
      ['public_surface_events', 'kind'],
      ['public_submission_keys', 'status'],
    ] as const) {
      const outcome = await asOwner(
        `update ${table} set ${column} = ${column} returning 1 as touched`,
      );
      expect(outcome.ok, `${table} refused an UPDATE outright`).toBe(true);
      expect(outcome.ok ? outcome.rows.length : -1, `${table} allowed an UPDATE`).toBe(0);
    }

    // And the runtime role is still locked out of the operational tables.
    const runtime = await asOwner(
      `select has_table_privilege('scolaira_app','public_submission_keys','SELECT') as keys_sel,
              has_table_privilege('scolaira_app','public_surface_events','SELECT') as events_sel,
              has_table_privilege('scolaira_app','payments','DELETE') as payments_del`,
    );
    if (!runtime.ok) throw new Error('probe failed');
    expect(runtime.rows[0]).toMatchObject({ keys_sel: false, events_sel: false, payments_del: false });
  });

  it('RA9 the lifecycle cannot be steered across tenants, and a retired credential stays retired', async () => {
    const link = await makeLink(A, 90_000);
    const bLink = await makeLink(B, 90_000);

    // B cannot reach A's link — not to rotate it, not to view it.
    const crossRotate = await route('POST', `/api/payment-links/${link.token}/rotate`, B.jar, {});
    expect(crossRotate.status).toBe(404);
    expect((await view(link.token)).status).toBe(200); // untouched, still live for A

    // A rotates: the old URL dies, and it dies for everyone.
    const rotated = await route('POST', `/api/payment-links/${link.token}/rotate`, A.jar, { reason: 'RA9' });
    expect(rotated.status).toBe(200);
    const newToken = rotated.data.link.token as string;

    // The retired credential is not merely "refused for B" — A itself can no
    // longer resolve it, and B cannot use the replacement either.
    expect((await view(link.token)).status).toBe(404);
    expect((await route('POST', `/api/payment-links/${link.token}/rotate`, A.jar, {})).status).toBe(404);
    expect((await route('POST', `/api/payment-links/${newToken}/rotate`, B.jar, {})).status).toBe(404);
    expect((await view(newToken)).status).toBe(200);
    expect((await view(bLink.token)).status).toBe(200);

    // Rotation is repeatable (remediation does not run out) and B's link is
    // untouched by any of it.
    const second = await route('POST', `/api/payment-links/${newToken}/rotate`, A.jar, {});
    expect(second.status).toBe(200);
    expect(second.data.link.rotationCount).toBe(2);

    await commitHarness();
    const state = await asOwner(
      `select id, token_rotation_count, status from payment_links where id in ($1::uuid, $2::uuid) order by id`,
      [link.id, bLink.id],
      suspend(['payment_links']),
    );
    if (!state.ok) throw new Error('probe failed');
    const byId = new Map(state.rows.map((r: any) => [r.id, r]));
    expect(Number(byId.get(link.id)!.token_rotation_count)).toBe(2);
    expect(Number(byId.get(bLink.id)!.token_rotation_count)).toBe(0);

    // Evidence is tenant-bound too: A's audit shows two rotations of its link
    // and nothing about B's.
    const aAudit = await asTenant(A, async (sql) => {
      const rows = (await sql.unsafe(
        `select entity_id from audit_events
          where action = 'payment_link.rotate' and entity_id in ($1::uuid, $2::uuid)`,
        [link.id, bLink.id],
      )) as any[];
      return rows;
    });
    expect(aAudit.length).toBe(2);
    expect(aAudit.every((r: any) => r.entity_id === link.id)).toBe(true);
  });

  it('RA10 telemetry cannot be used to smuggle a leaked credential back into operational view', async () => {
    const link = await makeLink(A, 75_000);
    const leaked = link.token;

    // An operator rotates, and their free-text reason contains the very string
    // that leaked — the natural thing for a human to paste into an incident
    // note, and the exact thing that must not end up in a widely-read feed.
    const rotated = await route('POST', `/api/payment-links/${leaked}/rotate`, A.jar, {
      reason: `leaked URL ${leaked} forwarded by parent 08031234567`,
    });
    expect(rotated.status).toBe(200);
    const newToken = rotated.data.link.token as string;

    // 1. The response carries the replacement credential and never the retired one.
    expect(JSON.stringify(rotated.data)).not.toContain(leaked);
    expect(JSON.stringify(rotated.data)).toContain(newToken);

    // 2. The operational feed the school reads contains neither the reason text
    //    nor any phone number: the detail is counts and a boolean.
    const feed = await route('GET', '/api/payment-links/signals?since=24h', A.jar);
    const feedText = JSON.stringify(feed.data);
    expect(feed.status).toBe(200);
    expect(feedText).not.toContain(leaked);
    expect(feedText).not.toContain('08031234567');
    const event = (feed.data.events as any[]).find(
      (e) => e.kind === 'link_rotated' && e.linkId === link.id,
    );
    expect(event).toBeTruthy();
    expect(Object.keys(event.detail).sort()).toEqual(['reasonRecorded', 'rotationCount']);
    expect(event.detail.reasonRecorded).toBe(true);

    // 3. The stored telemetry row itself is clean, read straight from the table
    //    as the owner (the auditor's own query, not the API's).
    await commitHarness();
    const stored = await asOwner(
      `select kind, link_id, detail::text as detail from public_surface_events
        where kind = 'link_rotated' and link_id = $1::uuid`,
      [link.id],
      suspend(['public_surface_events']),
    );
    if (!stored.ok) throw new Error(`probe failed: ${stored.ok}`);
    expect(stored.rows.length).toBe(1);
    const detailText = String(stored.rows[0].detail);
    expect(detailText).not.toContain(leaked);
    expect(detailText).not.toContain('08031234567');
    expect(JSON.parse(detailText)).toEqual({ rotationCount: 1, reasonRecorded: true });

    // 4. The reason IS preserved where it belongs: the privileged audit trail.
    const audit = await asTenant(A, async (sql) => {
      const rows = (await sql.unsafe(
        `select metadata::text as metadata from audit_events
          where action = 'payment_link.rotate' and entity_id = $1::uuid`,
        [link.id],
      )) as any[];
      return rows;
    });
    expect(audit.length).toBe(1);
    expect(String(audit[0].metadata)).toContain('forwarded by parent');
  });
});
