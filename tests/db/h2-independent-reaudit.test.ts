// @vitest-environment node
/**
 * H-2 — INDEPENDENT RE-AUDIT.
 *
 * This suite does not re-run the implementation tests and does not import their
 * helpers. It starts from the questions an auditor asks when handed the H-2
 * claims, and tries to falsify each one from the outside — reaching the database
 * directly, and the HTTP surface as an ordinary authenticated tenant:
 *
 *   claim 1  The declared headline and the partition behind it agree with the
 *            source rows, under an SQL formulation written here, not in the app.
 *   claim 2  A closed window's report does not move when later money arrives,
 *            and the figures tie back to ledger timestamps.
 *   claim 3  Every capped surface declares its window: pages are bounded, a
 *            non-terminal page always hands over a cursor, and a walk covers
 *            exactly the declared total.
 *   claim 4  A cursor is client input: a wrong-shaped one is REFUSED (400), not
 *            passed to SQL (500).
 *   claim 5  The new SQL surface is read-only and least-privilege, and the new
 *            tables are tenant-isolated with the runtime role unable to delete.
 *   claim 6  Non-overlap is a DATABASE control: it holds even when the API is
 *            bypassed entirely.
 *
 * A finding is recorded as an assertion failure, not as a comment.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { CookieJar, call } from '../auth/support';
import { getSql, closeDb } from '@/lib/db';
import { enableSavepointTransactionsForTest } from '../setup-db';
import { POST as Register } from '@/app/api/auth/register/route';
import { GET as Me } from '@/app/api/auth/me/route';
import { POST as SeedTerm } from '@/app/api/setup/seed-current-term/route';
import { GET as Invoices } from '@/app/api/invoices/route';
import { GET as Debtors } from '@/app/api/debtors/route';
import { GET as Dashboard } from '@/app/api/dashboard/summary/route';
import { GET as PeriodsList, POST as PeriodCreate } from '@/app/api/financial-periods/route';
import { POST as PeriodClose } from '@/app/api/financial-periods/[id]/close/route';

const uuid = () => randomUUID();
const key = () => randomUUID();
const ownerPool = postgres(process.env.DATABASE_MIGRATION_URL!, { max: 2 });

type Actor = { jar: CookieJar; orgId: string; userId: string };
type Probe = { ok: true; rows: any[] } | { ok: false; code: string; message: string };

/** Owner-side probe on its own connection; never leaves state behind. */
async function asOwner(statement: string, args: any[] = []): Promise<Probe> {
  const conn: any = await (ownerPool as any).reserve();
  try {
    await conn.unsafe('BEGIN');
    try {
      const rows = (await conn.unsafe(statement, args)) as any[];
      return { ok: true, rows };
    } catch (e: any) {
      return { ok: false, code: String(e?.code), message: String(e?.message ?? '') };
    }
  } finally {
    await conn.unsafe('ROLLBACK').catch(() => {});
    conn.release();
  }
}

/** Direct SQL as the tenant, on the harness connection. */
async function tenantSql(actor: Actor) {
  const sql = getSql();
  await sql.unsafe('select set_tenant_context($1::uuid, $2::uuid)', [actor.orgId, actor.userId]);
  return sql;
}

async function register(label: string): Promise<Actor> {
  const jar = new CookieJar();
  const slug = `${label}-${uuid().slice(0, 8)}`;
  const res = await call(Register as any, jar, {
    method: 'POST',
    path: '/api/auth/register',
    body: {
      email: `${slug}@example.com`,
      password: 'Str0ng!Passw0rd-For-Test',
      firstName: 'Re',
      lastName: 'Audit',
      organizationName: `School ${slug}`,
      organizationSlug: slug,
    },
  });
  expect(res.status, JSON.stringify(res.data)).toBe(201);
  const me = await call(Me as any, jar, { method: 'GET', path: '/api/auth/me' });
  expect(me.status).toBe(200);
  return { jar, orgId: me.data.activeOrganizationId as string, userId: me.data.user.id as string };
}

/** The window shape D-style evidence uses: fully closed, in the past. */
function pastWindow() {
  const start = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  const end = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
  return { start, end };
}

const PAGE_SURFACES: Array<{ surface: string; path: (cursor: string | null) => string; rows: string }> = [
  { surface: 'invoices', path: (c) => `/api/invoices?limit=200${c ? `&cursor=${encodeURIComponent(c)}` : ''}`, rows: 'invoices' },
  { surface: 'debtors', path: (c) => `/api/debtors?limit=200${c ? `&cursor=${encodeURIComponent(c)}` : ''}`, rows: 'students' },
];

let A: Actor;
let termId: string;
let cutoverOn: string;

beforeAll(async () => {
  enableSavepointTransactionsForTest();
  // The volume tenant: enough rows that every surface has to paginate.
  const actor = await register('h2ra');
  const seeded = await call(SeedTerm as any, actor.jar, { method: 'POST', path: '/api/setup/seed-current-term', csrf: true });
  // The dev/test-only seed answers 200 for the term it already knows and 201
  // when it creates one; both mean "the tenant now has a current term".
  expect([200, 201], JSON.stringify(seeded.data)).toContain(seeded.status);
  const sessionId = seeded.data.session.id as string;
  termId = seeded.data.term.id as string;
  cutoverOn = String(seeded.data.term.startsOn).slice(0, 10);

  const sql = await tenantSql(actor);
  await sql.unsafe(
    `insert into students (organization_id, student_id, first_name, last_name, status)
     select $1::uuid, 'RA-' || lpad(g::text, 4, '0'), 'Ra' || g, 'Audit' || lpad(g::text, 4, '0'), 'ACTIVE'::student_status
       from generate_series(1, 260) g`,
    [actor.orgId],
  );
  // 260 invoices: current-term, prior-term (due before the cut-over) and a
  // spread of due dates either side of it.
  await sql.unsafe(
    `insert into invoices (organization_id, invoice_number, student_id, term_id, session_id, status,
                           total_kobo, paid_kobo, issue_date, due_date)
     select $1::uuid, 'RAINV-' || lpad(g::text, 4, '0'), s.id, $2::uuid, $3::uuid,
            'ISSUED'::invoice_status, 1000 * g, 0,
            current_date - (g % 40)::int, current_date - (g % 40)::int + 10
       from (select id, row_number() over (order by student_id) as g from students where organization_id = $1::uuid) s`,
    [actor.orgId, termId, sessionId],
  );
  // One invoice that is unambiguously carried forward: another term, long past.
  await sql.unsafe(
    `insert into terms (organization_id, session_id, name, label, starts_on, ends_on, due_date, is_current, billed, status)
     values ($1::uuid, $2::uuid, 'RA Prior', 'prior', current_date - 400, current_date - 250, current_date - 300,
             false, false, 'ACTIVE'::term_status) returning id`,
    [actor.orgId, sessionId],
  );
  const priorTerm = (await sql.unsafe(
    `select id from terms where organization_id = $1::uuid and name = 'RA Prior' limit 1`,
    [actor.orgId],
  )) as any[];
  await sql.unsafe(
    `insert into invoices (organization_id, invoice_number, student_id, term_id, session_id, status,
                           total_kobo, paid_kobo, issue_date, due_date)
     select $1::uuid, 'RAINV-PRIOR', s.id, $2::uuid, $3::uuid, 'ISSUED'::invoice_status, 424242, 0,
            current_date - 320, current_date - 300
       from students s where s.organization_id = $1::uuid order by s.student_id limit 1`,
    [actor.orgId, priorTerm[0].id, sessionId],
  );
  A = actor;
});

afterAll(async () => {
  await closeDb();
  await ownerPool.end({ timeout: 5 });
});

describe('H-2 re-audit A — the headline, the partition and the source rows', () => {
  it('an SQL formulation written outside the app reproduces every bucket', async () => {
    const sql = await tenantSql(A);
    // Re-derived from the ledger with a hand-written CASE: current term wins,
    // otherwise a due date before the cut-over is carried forward.
    const truth = (await sql.unsafe(
      `with classified as (
         select case
                  when i.term_id = $1::uuid then 'CURRENT_TERM'
                  when i.due_date is not null and i.due_date < $2::date then 'PRIOR_TERM'
                  else 'OTHER_TERM'
                end as bucket,
                i.status, i.total_kobo, i.paid_kobo
           from invoices i
          where i.organization_id = $3::uuid
       )
       select bucket,
              count(*) filter (where status <> 'VOID')::int as invoice_count,
              coalesce(sum(total_kobo) filter (where status in ('ISSUED','PARTIALLY_PAID','PAID')), 0)::bigint as billed_kobo,
              coalesce(sum(total_kobo - paid_kobo) filter (where status in ('ISSUED','PARTIALLY_PAID')), 0)::bigint as outstanding_kobo
         from classified group by bucket order by bucket`,
      [termId, cutoverOn, A.orgId],
    )) as any[];

    const fn = (await sql.unsafe(`select * from auth_invoice_scope_buckets($1::uuid, $2::date) order by bucket`, [
      termId,
      cutoverOn,
    ])) as any[];

    expect(fn.map((r) => r.bucket).sort()).toEqual(truth.map((r) => r.bucket).sort());
    for (const t of truth) {
      const got = fn.find((r) => r.bucket === t.bucket);
      expect(got, `bucket ${t.bucket} missing from the function`).toBeTruthy();
      expect(Number(got.invoice_count), `${t.bucket} invoice_count`).toBe(Number(t.invoice_count));
      expect(Number(got.billed_kobo), `${t.bucket} billed_kobo`).toBe(Number(t.billed_kobo));
      expect(Number(got.outstanding_kobo), `${t.bucket} outstanding_kobo`).toBe(Number(t.outstanding_kobo));
    }
    // The carried-forward population is non-empty: a partition that cannot be
    // distinguished from "everything" would pass the comparison above vacuously.
    expect(Number(fn.find((r) => r.bucket === 'PRIOR_TERM')?.invoice_count ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it('the HTTP headline equals the sum of its own buckets and of the source rows', async () => {
    const dash = await call(Dashboard as any, A.jar, { method: 'GET', path: '/api/dashboard/summary' });
    expect(dash.status).toBe(200);
    const buckets = dash.data.buckets as any[];
    const sum = (k: string) => buckets.reduce((n, b) => n + Number(b[k] ?? 0), 0);
    expect(sum('billedKobo')).toBe(Number(dash.data.kpis.billedKobo));
    expect(sum('outstandingKobo')).toBe(Number(dash.data.kpis.outstandingKobo));
    expect(sum('overdueKobo')).toBe(Number(dash.data.kpis.overdueKobo));

    const sql = await tenantSql(A);
    const rows = (await sql.unsafe(
      `select coalesce(sum(total_kobo) filter (where status in ('ISSUED','PARTIALLY_PAID','PAID')), 0)::bigint as billed,
              coalesce(sum(total_kobo - paid_kobo) filter (where status in ('ISSUED','PARTIALLY_PAID')), 0)::bigint as outstanding,
              count(*) filter (where status <> 'VOID')::int as invoices
         from invoices where organization_id = $1::uuid`,
      [A.orgId],
    )) as any[];
    expect(Number(dash.data.kpis.billedKobo)).toBe(Number(rows[0].billed));
    expect(Number(dash.data.kpis.outstandingKobo)).toBe(Number(rows[0].outstanding));
    // The partition is exhaustive over the source rows: no invoice is counted
    // twice and none is dropped.
    expect(sum('invoiceCount')).toBe(Number(rows[0].invoices));
  });

  it('the register labels the carried-forward invoice as such (the display-date bug)', async () => {
    // The label is derived from a comparison of DAYS. It shipped comparing a
    // display-formatted date against an ISO cut-over, which put every carried
    // invoice in OTHER_TERM; this asserts the corrected pairing survives.
    let cursor: string | null = null;
    const seen: any[] = [];
    for (let i = 0; i < 10; i += 1) {
      const res = await call(Invoices as any, A.jar, {
        method: 'GET',
        path: `/api/invoices?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      });
      expect(res.status, JSON.stringify(res.data)).toBe(200);
      seen.push(...(res.data.invoices as any[]));
      if (!res.data.page.hasMore) break;
      cursor = res.data.page.nextCursor;
    }
    const prior = seen.find((r) => r.invoiceNumber === 'RAINV-PRIOR');
    expect(prior, 'the carried-forward invoice is missing from the register').toBeTruthy();
    expect(prior.scopeClass).toBe('PRIOR_TERM');
    expect(typeof prior.scopeLabel).toBe('string');
    expect(prior.scopeLabel.length).toBeGreaterThan(0);
  });
});

describe('H-2 re-audit B — a closed window is evidence, not a moving target', () => {
  it('later money does not move the closed report, and the figures tie to timestamps', async () => {
    const { start, end } = pastWindow();
    const created = await call(PeriodCreate as any, A.jar, {
      method: 'POST',
      path: '/api/financial-periods',
      csrf: true,
      headers: { 'idempotency-key': key() },
      body: { name: `RA Window ${uuid().slice(0, 6)}`, startsOn: start, endsOn: end },
    });
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    const periodId = created.data.period.id as string;

    const sql = await tenantSql(A);
    // The as-of report counts money applied to invoices ISSUED within the
    // window (issue_date <= period end), so the evidence has to be dated that
    // way too — an invoice issued after the window end is correctly outside it.
    const invoice = (await sql.unsafe(
      `select id, total_kobo, paid_kobo from invoices
        where organization_id = $1::uuid and issue_date <= (current_date - 20)
        order by invoice_number limit 1`,
      [A.orgId],
    )) as any[];
    // Money inside the window, fully applied.
    await sql.unsafe(
      `insert into payments (organization_id, payment_number, method, status, amount_kobo, unallocated_kobo,
                             payer_name, created_at)
       values ($1::uuid, $2::text, 'CASH'::payment_method, 'CONFIRMED'::payment_status, 1000, 0, 'RA Payer',
               now() - interval '30 days')`,
      [A.orgId, `RAPAY-${uuid().slice(0, 6)}`],
    );
    const pay = (await sql.unsafe(
      `select id from payments where organization_id = $1::uuid order by created_at desc limit 1`,
      [A.orgId],
    )) as any[];
    await sql.unsafe(
      `insert into payment_allocations (organization_id, payment_id, invoice_id, amount_kobo, status, allocated_at)
       values ($1::uuid, $2::uuid, $3::uuid, 1000, 'ACTIVE'::allocation_status, now() - interval '28 days')`,
      [A.orgId, pay[0].id, invoice[0].id],
    );

    const closed = await call(PeriodClose as any, A.jar, {
      method: 'POST',
      path: `/api/financial-periods/${periodId}/close`,
      csrf: true,
      headers: { 'idempotency-key': key() },
      args: [{ params: Promise.resolve({ id: periodId }) }],
    });
    expect(closed.status, JSON.stringify(closed.data)).toBe(201);
    const closedAt = closed.data.period.closedAt;

    // Independent tie-back: the allocation is inside the window, hand-written
    // as-of SQL over the same timestamp says so, and the report agrees.
    const sqlAfter = await tenantSql(A);
    const truth = (await sqlAfter.unsafe(
      `select coalesce(sum(a.amount_kobo), 0)::bigint as collected
         from payment_allocations a
         join payments p on p.id = a.payment_id
         join invoices i on i.id = a.invoice_id
        where a.organization_id = $1::uuid and a.status = 'ACTIVE' and p.status = 'CONFIRMED'
          and a.allocated_at::date <= $2::date
          and coalesce(i.issue_date, i.created_at::date) <= $2::date`,
      [A.orgId, end],
    )) as any[];
    expect(closed.data.valuation.allTerm.collectedKobo).toBe(Number(truth[0].collected));

    // Money that arrives AFTER the window, allocated after the window.
    await sqlAfter.unsafe(
      `insert into payments (organization_id, payment_number, method, status, amount_kobo, unallocated_kobo,
                             payer_name, created_at)
       values ($1::uuid, $2::text, 'CASH'::payment_method, 'CONFIRMED'::payment_status, 999000, 0, 'RA Late',
               now() + interval '1 day')`,
      [A.orgId, `RAPAY-LATE-${uuid().slice(0, 6)}`],
    );
    const late = (await sqlAfter.unsafe(
      `select id from payments where organization_id = $1::uuid order by created_at desc limit 1`,
      [A.orgId],
    )) as any[];
    const secondInvoice = (await sqlAfter.unsafe(
      `select id, total_kobo from invoices
        where organization_id = $1::uuid and issue_date <= (current_date - 20)
        order by invoice_number offset 1 limit 1`,
      [A.orgId],
    )) as any[];
    await sqlAfter.unsafe(
      `insert into payment_allocations (organization_id, payment_id, invoice_id, amount_kobo, status, allocated_at)
       values ($1::uuid, $2::uuid, $3::uuid, $4::int, 'ACTIVE'::allocation_status, now() + interval '1 day')`,
      [A.orgId, late[0].id, secondInvoice[0].id, Number(secondInvoice[0].total_kobo)],
    );

    const replayed = await call(PeriodClose as any, A.jar, {
      method: 'POST',
      path: `/api/financial-periods/${periodId}/close`,
      csrf: true,
      headers: { 'idempotency-key': key() },
      args: [{ params: Promise.resolve({ id: periodId }) }],
    });
    expect(replayed.status).toBe(200);
    expect(replayed.data.alreadyClosed).toBe(true);
    expect(replayed.data.period.closedAt).toBe(closedAt);
    expect(replayed.data.valuation.allTerm).toEqual(closed.data.valuation.allTerm);
  });
});

describe('H-2 re-audit C — pages declare their window, and cursors are input', () => {
  it('every page block is bounded, honest about overflow, and walks exactly once', async () => {
    for (const spec of PAGE_SURFACES) {
      let cursor: string | null = null;
      const ids: string[] = [];
      let declaredTotal: number | null = null;
      for (let i = 0; i < 20; i += 1) {
        const res = await call(spec.surface === 'invoices' ? (Invoices as any) : (Debtors as any), A.jar, {
          method: 'GET',
          path: spec.path(cursor),
        });
        expect(res.status, `${spec.surface}: ${JSON.stringify(res.data)}`).toBe(200);
        const page = res.data.page;
        const rows = (res.data[spec.rows] as any[]) ?? [];
        expect(page.surface).toBe(spec.surface);
        expect(page.returned).toBe(rows.length);
        expect(page.returned).toBeLessThanOrEqual(page.limit);
        expect(page.limit).toBeLessThanOrEqual(page.cap);
        expect(page.capSource).toBe('FIXED');
        if (page.hasMore) {
          expect(page.nextCursor, `${spec.surface}: hasMore without a cursor`).toBeTruthy();
          expect(page.returned).toBe(page.limit);
        } else {
          expect(page.nextCursor).toBeNull();
        }
        declaredTotal = page.total === null ? declaredTotal : Number(page.total);
        for (const r of rows) ids.push(String(r.id ?? r.studentId));
        if (!page.hasMore) break;
        cursor = page.nextCursor;
      }
      expect(new Set(ids).size, `${spec.surface}: duplicate keys across pages`).toBe(ids.length);
      expect(declaredTotal, `${spec.surface}: page.total`).toBe(ids.length);
    }
  });

  it('a wrong-shaped cursor is refused as bad input rather than handed to SQL', async () => {
    const isoKeyed = Buffer.from(
      JSON.stringify({ v: 1, s: 'invoices', k: ['2026-09-24T00:00:00.000Z', uuid()] }),
      'utf8',
    ).toString('base64url');
    const wrongType = Buffer.from(JSON.stringify({ v: 1, s: 'invoices', k: ['not-a-number', uuid()] }), 'utf8').toString(
      'base64url',
    );
    const foreignSurface = Buffer.from(JSON.stringify({ v: 1, s: 'payments', k: ['1', uuid()] }), 'utf8').toString(
      'base64url',
    );
    const cases: Array<[string, string]> = [
      ['ISO-string key', isoKeyed],
      ['non-numeric key', wrongType],
      ['foreign surface', foreignSurface],
      ['not base64 at all', '!!!not-a-cursor!!!'],
    ];
    for (const [label, cursor] of cases) {
      const res = await call(Invoices as any, A.jar, {
        method: 'GET',
        path: `/api/invoices?limit=5&cursor=${encodeURIComponent(cursor)}`,
      });
      expect(res.status, `${label} → ${JSON.stringify(res.data)}`).toBe(400);
      expect(res.data.error.code).toBe('BAD_REQUEST');
    }
  });
});

describe('H-2 re-audit D — the new surface is read-only, least-privilege and isolated', () => {
  it('the two new functions are app-callable, invoker-rights and contain no write', async () => {
    const probed = await asOwner(`
      SELECT p.proname,
             p.provolatile,
             p.prosecdef,
             pg_get_functiondef(p.oid) AS def,
             has_function_privilege('scolaira_app', p.oid, 'EXECUTE') AS app_can
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('auth_invoice_scope_buckets', 'auth_period_valuation')
       ORDER BY p.proname`);
    expect(probed.ok).toBe(true);
    const rows = (probed as any).rows as any[];
    expect(rows.map((r) => r.proname)).toEqual(['auth_invoice_scope_buckets', 'auth_period_valuation']);
    for (const r of rows) {
      expect(r.app_can, `${r.proname} must be callable by the runtime role`).toBe(true);
      expect(r.prosecdef, `${r.proname} must not be SECURITY DEFINER`).toBe(false);
      expect(['s', 'i'], `${r.proname} volatility`).toContain(r.provolatile);
      expect(
        /insert\s+into|update\s+public\.|delete\s+from|truncate/i.test(r.def),
        `${r.proname} contains a write`,
      ).toBe(false);
      expect(/current_setting\('app\.organization_id'/i.test(r.def), `${r.proname} must be tenant-scoped`).toBe(true);
    }
  });

  it('the new tables are FORCE-RLS and the runtime role cannot delete from them', async () => {
    const probed = await asOwner(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              has_table_privilege('scolaira_app', c.oid, 'DELETE') AS app_delete
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname IN ('financial_periods', 'surface_scope_settings')
        ORDER BY c.relname`,
    );
    expect(probed.ok).toBe(true);
    const rows = (probed as any).rows as any[];
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.relrowsecurity, `${r.relname} RLS`).toBe(true);
      expect(r.relforcerowsecurity, `${r.relname} FORCE RLS`).toBe(true);
      expect(r.app_delete, `${r.relname} DELETE privilege`).toBe(false);
    }
  });

  it('another tenant cannot see or name these rows', async () => {
    const other = await register('h2rax');
    const otherTerm = await call(SeedTerm as any, other.jar, {
      method: 'POST',
      path: '/api/setup/seed-current-term',
      csrf: true,
    });
    expect([200, 201]).toContain(otherTerm.status);

    // This test owns its period: the harness rolls the per-test transaction
    // back, so nothing another test created is still there to be read.
    const { start, end } = pastWindow();
    const created = await call(PeriodCreate as any, A.jar, {
      method: 'POST',
      path: '/api/financial-periods',
      csrf: true,
      headers: { 'idempotency-key': key() },
      body: { name: `RA Isolated ${uuid().slice(0, 6)}`, startsOn: start, endsOn: end },
    });
    expect([201, 409], JSON.stringify(created.data)).toContain(created.status);
    const mine = await call(PeriodsList as any, A.jar, { method: 'GET', path: '/api/financial-periods?limit=5' });
    const myIds = ((mine.data.periods as any[]) ?? []).map((p) => p.id);
    expect(myIds.length).toBeGreaterThanOrEqual(1);

    const theirs = await call(PeriodsList as any, other.jar, { method: 'GET', path: '/api/financial-periods?limit=50' });
    expect(theirs.status).toBe(200);
    for (const id of myIds) {
      expect(((theirs.data.periods as any[]) ?? []).map((p) => p.id)).not.toContain(id);
    }

    // The other tenant's connection cannot read them directly either, and
    // naming one by id does not leak its existence.
    const otherSql = await tenantSql(other);
    const sneaked = (await otherSql.unsafe(
      `select count(*)::int as n from financial_periods where id = $1::uuid`,
      [myIds[0]],
    )) as any[];
    expect(Number(sneaked[0].n)).toBe(0);
  });
});

describe('H-2 re-audit E — the boundary control is in the database', () => {
  it('overlapping windows are refused by the schema, with the API bypassed', async () => {
    const { start, end } = pastWindow();
    const created = await call(PeriodCreate as any, A.jar, {
      method: 'POST',
      path: '/api/financial-periods',
      csrf: true,
      headers: { 'idempotency-key': key() },
      body: { name: `RA Overlap Base ${uuid().slice(0, 6)}`, startsOn: start, endsOn: end },
    });
    expect([201, 409]).toContain(created.status);

    // Written straight to the table as the runtime role: the trigger still has
    // to refuse it (23P01 from the exclusion constraint).
    const sql = await tenantSql(A);
    let refused: any = null;
    try {
      await sql.unsafe(
        `insert into financial_periods (organization_id, name, starts_on, ends_on)
         values ($1::uuid, $2::text, $3::date, $4::date)`,
        [A.orgId, `RA Sneak ${uuid().slice(0, 6)}`, end, end],
      );
    } catch (e: any) {
      refused = e;
    }
    expect(refused, 'the database accepted an overlapping period').toBeTruthy();
    expect(String(refused.code ?? refused.cause?.code)).toBe('23P01');
  });
});
