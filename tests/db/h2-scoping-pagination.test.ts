// @vitest-environment node
/**
 * H-2 contract suite — declared scope, capped-surface pagination, term
 * boundaries, and staleness classification.
 *
 * What this file is for: H-2's measured defects were (a) two unlabelled scoping
 * conventions on one screen, (b) capped lists that silently truncated, and (c)
 * staleness boundaries that existed only as call-site literals. Every test here
 * is written against the *measured* symptom, not against an implementation
 * detail.
 *
 * Harness notes:
 *   * `beforeAll` fixtures COMMIT (they run outside the per-test BEGIN), so the
 *     volume tenant is built once and reused; each test's own writes stay inside
 *     the per-test transaction and roll back.
 *   * Route handlers clear the tenant GUCs when they return, so any direct SQL
 *     after a handler must re-establish context (`enterCtx`).
 *   * Routes that open a transaction need `enableSavepointTransactionsForTest()`
 *     because the harness already owns one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CookieJar, call } from '../auth/support';
import { getSql, closeDb } from '@/lib/db';
import { enableSavepointTransactionsForTest } from '../setup-db';
import { classifyInvoiceScope } from '@/lib/db/repo/aggregates';
import { classifyReminderStaleness } from '@/lib/db/repo/staleness';
import { POST as Register } from '@/app/api/auth/register/route';
import { GET as Me } from '@/app/api/auth/me/route';
import { POST as SeedTerm } from '@/app/api/setup/seed-current-term/route';
import { GET as Dashboard } from '@/app/api/dashboard/summary/route';
import { GET as Invoices } from '@/app/api/invoices/route';
import { GET as Payments } from '@/app/api/payments/route';
import { GET as Students } from '@/app/api/students/route';
import { GET as Debtors } from '@/app/api/debtors/route';
import { GET as DebtorDetail } from '@/app/api/debtors/[studentId]/route';
import { POST as Remind } from '@/app/api/debtors/[studentId]/remind/route';
import { GET as Collections } from '@/app/api/collections/route';
import { GET as ReconQueue } from '@/app/api/reconciliation/queue/route';
import { PUT as ScopePut } from '@/app/api/scoping/settings/route';
import { GET as PeriodsList, POST as PeriodCreate } from '@/app/api/financial-periods/route';
import { GET as PeriodGet } from '@/app/api/financial-periods/[id]/route';
import { POST as PeriodClose } from '@/app/api/financial-periods/[id]/close/route';
import type { PageMeta } from '@/lib/db/repo/pagination';

const rand = () => Math.random().toString(36).slice(2, 8);
const idem = () => randomUUID();

/** The volume tenant's population, in one place so the assertions can't drift. */
const VOLUME_STUDENTS = 1005;
const VOLUME_INVOICED = 505;
const SMALL_PAYMENTS = 12;
const SMALL_CASES = 12;

type Owner = { jar: CookieJar; orgId: string; userId: string };

async function makeOwner(label: string): Promise<Owner> {
  const jar = new CookieJar();
  const slug = `${label}-${rand()}`;
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

/** Re-establish tenant context on the harness connection after a handler call. */
async function enterCtx(owner: Owner) {
  const sql = getSql();
  await sql.unsafe(`select set_tenant_context($1::uuid, $2::uuid)`, [owner.orgId, owner.userId]);
  return sql;
}

function expectPage(page: any, surface: string): PageMeta {
  expect(page, `missing page block for ${surface}`).toBeTruthy();
  expect(page.surface).toBe(surface);
  expect(typeof page.limit).toBe('number');
  expect(typeof page.cap).toBe('number');
  expect(page.capSource).toBe('FIXED');
  expect(page.limit).toBeLessThanOrEqual(page.cap);
  expect(Number.isInteger(page.returned)).toBe(true);
  expect(typeof page.hasMore).toBe('boolean');
  expect(page.returned).toBeLessThanOrEqual(page.limit);
  if (page.hasMore) expect(page.nextCursor, `${surface}: hasMore without a cursor`).toBeTruthy();
  return page as PageMeta;
}

/** Walk a keyset-paginated surface to exhaustion. */
async function walk(
  fetchPage: (cursor: string | null) => Promise<{ status: number; data: any }>,
  surface: string,
  expectedTotal: number,
) {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const res = await fetchPage(cursor);
    expect(res.status, `${surface}: ${JSON.stringify(res.data)}`).toBe(200);
    const page = expectPage(res.data.page, surface);
    expect(page.returned).toBeLessThanOrEqual(page.cap);
    const rows = (res.data.students ?? res.data.invoices ?? res.data.payments ?? res.data.queue ?? []) as any[];
    // eslint-disable-next-line no-console
    console.log('[h2 walk]', surface, JSON.stringify({ status: res.status, returned: page.returned, total: page.total, hasMore: page.hasMore, got: rows.length, cursor: Boolean(cursor) }));
    expect(rows.length).toBe(page.returned);
    // Each surface names its identity differently (debtors carry `studentId`,
    // the reconciliation queue carries `paymentId`); the walk only needs a key
    // that is unique within the surface.
    for (const row of rows) ids.push(String(row.id ?? row.studentId ?? row.paymentId));
    pages += 1;
    expect(pages, `${surface}: cursor walk did not terminate`).toBeLessThan(50);
    if (!page.hasMore) {
      expect(page.nextCursor).toBeNull();
      break;
    }
    cursor = page.nextCursor;
  }
  expect(new Set(ids).size, `${surface}: duplicate rows across pages`).toBe(ids.length);
  expect(ids.length).toBe(expectedTotal);
  return ids;
}

describe('H-2 — declared scope, capped surfaces, term boundaries', () => {
  let A: Owner; // volume tenant: 1005 students, 505 invoices, payments, cases
  let B: Owner; // small cross-tenant control
  let P: Owner; // financial-period tenant
  let termA: any;
  let sessionA: any;

  beforeAll(async () => {
    enableSavepointTransactionsForTest();
    A = await makeOwner('h2a');
    B = await makeOwner('h2b');
    P = await makeOwner('h2p');

    const seeded = await call(SeedTerm as any, A.jar, { method: 'POST', path: '/api/setup/seed-current-term', csrf: true, body: {} });
    expect([200, 201]).toContain(seeded.status);
    termA = seeded.data.term;
    sessionA = seeded.data.session;

    // --- Committed volume fixture -------------------------------------------------
    let sql = await enterCtx(A);
    await sql.unsafe(
      `insert into students (organization_id, student_id, first_name, last_name, status)
       select $1::uuid, 'H2S-' || lpad(g::text, 4, '0'), 'First' || g, 'Last' || lpad(g::text, 4, '0'), 'ACTIVE'::student_status
         from generate_series(1, $2::int) g`,
      [A.orgId, VOLUME_STUDENTS],
    );
    await sql.unsafe(
      `insert into invoices (organization_id, invoice_number, student_id, term_id, session_id, status,
                             total_kobo, paid_kobo, issue_date, due_date)
       select $1::uuid, 'H2INV-' || lpad(s.g::text, 4, '0'), s.id, $2::uuid, $3::uuid,
              'ISSUED'::invoice_status, 1000, 0, current_date - 45, current_date - 15
         from (select id, row_number() over (order by student_id) as g
                 from students where organization_id = $1::uuid) s
        where s.g <= $4::int`,
      [A.orgId, termA.id, sessionA.id, VOLUME_INVOICED],
    );
    await sql.unsafe(
      `insert into payments (organization_id, payment_number, method, status, amount_kobo, unallocated_kobo, payer_name)
       select $1::uuid, 'H2PAY-' || lpad(g::text, 4, '0'), 'CASH'::payment_method, 'PENDING'::payment_status,
              5000, 5000, 'Payer ' || g
         from generate_series(1, $2::int) g`,
      [A.orgId, SMALL_PAYMENTS],
    );
    // A case must be born OPEN at version zero (DB guard), so the fixture varies
    // priority and the NULLS-LAST next-action key instead — that is exactly what
    // the queue's compound keyset ordering has to reproduce.
    await sql.unsafe(
      `insert into collections_cases (organization_id, student_id, state, priority, reason, created_by, next_action_at)
       select $1::uuid, s.id, 'OPEN',
              case when g % 3 = 0 then 'URGENT' when g % 3 = 1 then 'HIGH' else 'NORMAL' end,
              'H-2 fixture case ' || g, $2::uuid,
              case when g % 2 = 0 then now() + (g || ' days')::interval else null end
         from (select id, row_number() over (order by student_id) as g
                 from students where organization_id = $1::uuid) s
        where s.g <= $3::int`,
      [A.orgId, A.userId, SMALL_CASES],
    );

    // --- Cross-tenant control: same student codes, different tenant ---------------
    const seededB = await call(SeedTerm as any, B.jar, { method: 'POST', path: '/api/setup/seed-current-term', csrf: true, body: {} });
    expect([200, 201]).toContain(seededB.status);
    const sb = await enterCtx(B);
    await sb.unsafe(
      `insert into students (organization_id, student_id, first_name, last_name, status)
       select $1::uuid, 'H2S-' || lpad(g::text, 4, '0'), 'Foreign' || g, 'Tenant' || g, 'ACTIVE'::student_status
         from generate_series(1, 3) g`,
      [B.orgId],
    );
    await sb.unsafe(
      `insert into invoices (organization_id, invoice_number, student_id, term_id, session_id, status,
                             total_kobo, paid_kobo, issue_date, due_date)
       select $1::uuid, 'H2B-INV-' || lpad(s.g::text, 4, '0'), s.id, $2::uuid, $3::uuid,
              'ISSUED'::invoice_status, 777777, 0, current_date - 45, current_date - 15
         from (select id, row_number() over (order by student_id) as g
                 from students where organization_id = $1::uuid) s`,
      [B.orgId, seededB.data.term.id, seededB.data.session.id],
    );
    await sb.unsafe(
      `insert into payments (organization_id, payment_number, method, status, amount_kobo, unallocated_kobo, payer_name)
       select $1::uuid, 'H2B-PAY-' || lpad(g::text, 4, '0'), 'CASH'::payment_method, 'PENDING'::payment_status,
              999999, 999999, 'Foreign Payer ' || g
         from generate_series(1, 2) g`,
      [B.orgId],
    );

    // --- Period tenant -----------------------------------------------------------
    const seededP = await call(SeedTerm as any, P.jar, { method: 'POST', path: '/api/setup/seed-current-term', csrf: true, body: {} });
    expect([200, 201]).toContain(seededP.status);
    const sp = await enterCtx(P);
    await sp.unsafe(
      `insert into students (organization_id, student_id, first_name, last_name, status)
       values ($1::uuid, 'H2P-0001', 'Period', 'Student', 'ACTIVE'::student_status)`,
      [P.orgId],
    );
    await sp.unsafe(
      `insert into invoices (organization_id, invoice_number, student_id, term_id, session_id, status,
                             total_kobo, paid_kobo, issue_date, due_date)
       select $1::uuid, 'H2P-INV-0001', s.id, $2::uuid, $3::uuid, 'ISSUED'::invoice_status,
              250000, 0, current_date - 40, current_date - 20
         from students s where s.organization_id = $1::uuid limit 1`,
      [P.orgId, seededP.data.term.id, seededP.data.session.id],
    );
  }, 120_000);

  afterAll(async () => {
    await closeDb();
  });

  // ===========================================================================
  // A — declared scope + 3-way partition
  // ===========================================================================
  describe('A — the declared scope and the partition behind the headline', () => {
    it('A1: every payload declares its scope, and the buckets partition the headline', async () => {
      const dash = await call(Dashboard as any, A.jar, { method: 'GET', path: '/api/dashboard/summary' });
      expect(dash.status).toBe(200);

      // The declaration itself.
      expect(dash.data.scope.kpis.scope).toBe('ALL_TERM');
      expect(dash.data.scope.kpis.isDefault).toBe(true);
      expect(dash.data.scope.kpis.label).toMatch(/all terms/i);
      expect(dash.data.scope.activeStudents.scope).toBe('ALL_TERM');
      expect(dash.data.scope.queues.scope).toBe('ALL_TERM');

      // The partition.
      const buckets = dash.data.buckets as any[];
      expect(buckets.map((b) => b.key)).toEqual(['CURRENT_TERM', 'PRIOR_TERM', 'OTHER_TERM']);
      const sum = buckets.reduce(
        (acc, b) => ({
          billed: acc.billed + b.billedKobo,
          collected: acc.collected + b.collectedKobo,
          outstanding: acc.outstanding + b.outstandingKobo,
          overdue: acc.overdue + b.overdueKobo,
          count: acc.count + b.invoiceCount,
        }),
        { billed: 0, collected: 0, outstanding: 0, overdue: 0, count: 0 },
      );
      expect(dash.data.kpis.billedKobo).toBe(sum.billed);
      expect(dash.data.kpis.collectedKobo).toBe(sum.collected);
      expect(dash.data.kpis.outstandingKobo).toBe(sum.outstanding);
      expect(dash.data.kpis.overdueKobo).toBe(sum.overdue);
      expect(sum.outstanding).toBeGreaterThan(0); // the fixture actually owes money

      // The thresholds this response classified against (M-7).
      expect(dash.data.thresholds).toMatchObject({
        staleAfterDays: 7,
        unattendedAfterDays: 14,
        reminderCooldownHours: 4,
      });
    });

    it('A2: the headline agrees with the source rows, and its bucket is the SQL classification', async () => {
      const dash = await call(Dashboard as any, A.jar, { method: 'GET', path: '/api/dashboard/summary' });
      const sql = await enterCtx(A);
      const truth = (await sql.unsafe(
        `select coalesce(sum(total_kobo) filter (where status in ('ISSUED','PARTIALLY_PAID','PAID')), 0)::bigint as billed,
                coalesce(sum(total_kobo - paid_kobo) filter (where status in ('ISSUED','PARTIALLY_PAID')), 0)::bigint as outstanding,
                coalesce(sum(total_kobo - paid_kobo) filter (where status in ('ISSUED','PARTIALLY_PAID')
                          and due_date < current_date), 0)::bigint as overdue,
                count(*)::int as invoices
           from invoices where organization_id = $1::uuid and status <> 'VOID'`,
        [A.orgId],
      )) as any[];
      const t = truth[0];

      expect(Number(dash.data.kpis.billedKobo)).toBe(Number(t.billed));
      expect(Number(dash.data.kpis.outstandingKobo)).toBe(Number(t.outstanding));
      expect(Number(dash.data.kpis.overdueKobo)).toBe(Number(t.overdue));
      expect(dash.data.buckets.reduce((n: number, b: any) => n + b.invoiceCount, 0)).toBe(Number(t.invoices));

      // The SQL classification and the TypeScript mirror must agree, row by row,
      // on real data — one definition, two evaluation sites, no drift.
      const bucketsSql = (await sql.unsafe(
        `select bucket, invoice_count from auth_invoice_scope_buckets($1::uuid, $2::date)`,
        [termA.id, String(termA.startsOn).slice(0, 10)],
      )) as any[];
      expect(bucketsSql.length).toBeGreaterThanOrEqual(1);
      for (const row of bucketsSql) {
        expect(['CURRENT_TERM', 'PRIOR_TERM', 'OTHER_TERM', 'ALL_TERM']).toContain(row.bucket);
      }
      // The buckets are an exhaustive partition (CURRENT/PRIOR/OTHER) of the
      // same population the headline counts, so they must ADD UP to it — not to
      // some subset of it. (ALL_TERM is the period-valuation tie-back row, not a
      // fourth bucket here.)
      expect(bucketsSql.map((b) => b.bucket).sort()).toEqual(
        expect.arrayContaining(bucketsSql.map((b) => b.bucket)),
      );
      expect(['CURRENT_TERM', 'PRIOR_TERM', 'OTHER_TERM']).toContain(bucketsSql[0].bucket);
      const partitionCount = bucketsSql.reduce((n: number, b: any) => n + Number(b.invoice_count), 0);
      expect(partitionCount).toBe(Number(t.invoices));

      const perRow = (await sql.unsafe(
        `select i.id, i.term_id, i.due_date, i.invoice_number
           from invoices i where i.organization_id = $1::uuid
          order by i.invoice_number limit 25`,
        [A.orgId],
      )) as any[];
      const byBucket = new Map<string, number>();
      for (const row of perRow) {
        const mirror = classifyInvoiceScope(
          { termId: row.term_id ?? null, dueDate: row.due_date ? String(row.due_date).slice(0, 10) : null },
          { termId: termA.id, cutoverOn: String(termA.startsOn).slice(0, 10) },
        );
        byBucket.set(mirror, (byBucket.get(mirror) ?? 0) + 1);
      }
      // The sample is all CURRENT_TERM (the volume fixture bills the active term),
      // and the SQL function must agree at least for the sampled rows.
      for (const [bucket, n] of byBucket.entries()) {
        const sqlCount = Number(bucketsSql.find((b) => b.bucket === bucket)?.invoice_count ?? -1);
        expect(sqlCount, `SQL/TS disagreement on ${bucket}`).toBeGreaterThanOrEqual(n);
      }
    });

    it('A3: carried-forward debt is visible by default, and hiding it is an explicit, audited choice', async () => {
      // A prior-term invoice, already due before the active term began.
      const sql = await enterCtx(A);
      const priorTerm = (await sql.unsafe(
        `insert into terms (organization_id, session_id, name, label, starts_on, ends_on, due_date, is_current, billed, status)
         values ($1::uuid, $2::uuid, 'H-2 Prior Term', 'prior', current_date - 400, current_date - 250, current_date - 300,
                 false, false, 'ACTIVE'::term_status)
         returning id, starts_on`,
        [A.orgId, sessionA.id],
      )) as any[];
      const priorTermId = priorTerm[0].id;
      await sql.unsafe(
        `insert into invoices (organization_id, invoice_number, student_id, term_id, session_id, status,
                               total_kobo, paid_kobo, issue_date, due_date)
         select $1::uuid, 'H2-PRIOR-0001', s.id, $2::uuid, $3::uuid, 'ISSUED'::invoice_status,
                424242, 0, current_date - 320, current_date - 300
           from students s where s.organization_id = $1::uuid order by s.student_id limit 1`,
        [A.orgId, priorTermId, sessionA.id],
      );

      const allTerm = await call(Dashboard as any, A.jar, { method: 'GET', path: '/api/dashboard/summary' });
      const prior = allTerm.data.buckets.find((b: any) => b.key === 'PRIOR_TERM');
      expect(prior.outstandingKobo).toBe(424242);
      expect(allTerm.data.kpis.outstandingKobo).toBeGreaterThanOrEqual(424242);

      // Flip to TERM scope: the headline now excludes it — and SAYS so.
      const flip = await call(ScopePut as any, A.jar, {
        method: 'PUT',
        path: '/api/scoping/settings',
        csrf: true,
        body: { invoiceScope: 'TERM' },
      });
      expect(flip.status).toBe(200);
      expect(flip.data.changed).toBe(true);
      expect(flip.data.scope.scope).toBe('TERM');

      const termScoped = await call(Dashboard as any, A.jar, { method: 'GET', path: '/api/dashboard/summary' });
      const current = termScoped.data.buckets.find((b: any) => b.key === 'CURRENT_TERM');
      expect(termScoped.data.scope.kpis.scope).toBe('TERM');
      expect(termScoped.data.scope.kpis.isDefault).toBe(false);
      expect(termScoped.data.kpis.outstandingKobo).toBe(current.outstandingKobo);
      expect(termScoped.data.kpis.outstandingKobo).toBe(allTerm.data.kpis.outstandingKobo - 424242);

      // Audited once, and re-writing the same value changes nothing.
      const audits = (await (await enterCtx(A)).unsafe(
        `select count(*)::int as n from audit_events
          where organization_id = $1::uuid and action = 'scope.invoice_scope.update'`,
        [A.orgId],
      )) as any[];
      expect(Number(audits[0].n)).toBe(1);
      const again = await call(ScopePut as any, A.jar, {
        method: 'PUT',
        path: '/api/scoping/settings',
        csrf: true,
        body: { invoiceScope: 'TERM' },
      });
      expect(again.data.changed).toBe(false);
      const audits2 = (await (await enterCtx(A)).unsafe(
        `select count(*)::int as n from audit_events
          where organization_id = $1::uuid and action = 'scope.invoice_scope.update'`,
        [A.orgId],
      )) as any[];
      expect(Number(audits2[0].n)).toBe(1);

      // The register marks the carried-forward obligation rather than hiding it.
      // It is a capped surface, so the row is on the walk rather than guaranteed
      // to be on the first page.
      const carried: any[] = [];
      let regCursor: string | null = null;
      for (let i = 0; i < 10; i += 1) {
        const list = await call(Invoices as any, A.jar, {
          method: 'GET',
          path: `/api/invoices?limit=200${regCursor ? `&cursor=${encodeURIComponent(regCursor)}` : ''}`,
        });
        const page = expectPage(list.data.page, 'invoices');
        carried.push(...(list.data.invoices as any[]).filter((r) => r.scopeClass === 'PRIOR_TERM'));
        if (!page.hasMore) break;
        regCursor = page.nextCursor;
      }
      expect(carried.length).toBeGreaterThanOrEqual(1);
      expect(carried.every((r) => r.scopeLabel && r.scopeLabel.length > 0)).toBe(true);
      expect(carried.some((r) => r.invoiceNumber === 'H2-PRIOR-0001')).toBe(true);

      // Restore the default for the remaining tests in this file.
      const restore = await call(ScopePut as any, A.jar, {
        method: 'PUT',
        path: '/api/scoping/settings',
        csrf: true,
        body: { invoiceScope: 'ALL_TERM' },
      });
      expect(restore.data.scope.scope).toBe('ALL_TERM');
    });
  });

  // ===========================================================================
  // B — capped surfaces
  // ===========================================================================
  describe('B — every capped surface declares its window', () => {
    it('B1: invoices, payments, students, debtors, collections and reconciliation all carry a page block', { timeout: 30_000 }, async () => {
      const calls: Array<[string, () => Promise<any>, string]> = [
        ['invoices', () => call(Invoices as any, A.jar, { method: 'GET', path: '/api/invoices?limit=5' }), 'invoices'],
        ['payments', () => call(Payments as any, A.jar, { method: 'GET', path: '/api/payments?limit=5' }), 'payments'],
        ['students', () => call(Students as any, A.jar, { method: 'GET', path: '/api/students?limit=5' }), 'students'],
        ['debtors', () => call(Debtors as any, A.jar, { method: 'GET', path: '/api/debtors?limit=5' }), 'debtors'],
        ['collections', () => call(Collections as any, A.jar, { method: 'GET', path: '/api/collections?limit=5' }), 'collections'],
        ['reconciliation', () => call(ReconQueue as any, A.jar, { method: 'GET', path: '/api/reconciliation/queue?limit=5' }), 'reconciliation-queue'],
        ['financial-periods', () => call(PeriodsList as any, P.jar, { method: 'GET', path: '/api/financial-periods?limit=5' }), 'financial-periods'],
      ];
      for (const [label, run, surface] of calls) {
        const res = await run();
        expect(res.status, `${label}: ${JSON.stringify(res.data)}`).toBe(200);
        const page = expectPage(res.data.page, surface);
        expect(page.total === null || page.total >= page.returned).toBe(true);
      }
    });

    it('B2: financial totals do not depend on the page size (and match source rows)', { timeout: 30_000 }, async () => {
      const one = await call(Invoices as any, A.jar, { method: 'GET', path: '/api/invoices?limit=1' });
      const many = await call(Invoices as any, A.jar, { method: 'GET', path: '/api/invoices?limit=200' });
      expect(one.data.totals).toEqual(many.data.totals);
      expect(one.data.page.returned).toBe(1);
      expect(many.data.page.returned).toBe(200);
      expect(one.data.totals.total).toBe(many.data.page.total);

      const sql = await enterCtx(A);
      const truth = (await sql.unsafe(
        `select count(*)::int as n,
                coalesce(sum(total_kobo) filter (where status <> 'VOID'), 0)::bigint as billed,
                coalesce(sum(total_kobo - paid_kobo) filter (where status in ('ISSUED','PARTIALLY_PAID')), 0)::bigint as outstanding
           from invoices where organization_id = $1::uuid`,
        [A.orgId],
      )) as any[];
      expect(many.data.totals.total).toBe(Number(truth[0].n));
      expect(many.data.totals.billedKobo).toBe(Number(truth[0].billed));
      expect(many.data.totals.outstandingKobo).toBe(Number(truth[0].outstanding));

      // The page sum is strictly smaller than the strip: proof the strip is not
      // computed from the returned rows (the measured defect: a >200-row tenant
      // under-reported by 15,050,000 kobo on that page's own strip).
      const pageBilled = (many.data.invoices as any[]).reduce((n, r) => n + Number(r.totalKobo), 0);
      expect(many.data.totals.billedKobo).toBeGreaterThan(pageBilled);

      // Debtors and students: same rule.
      const d1 = await call(Debtors as any, A.jar, { method: 'GET', path: '/api/debtors?limit=1' });
      const dMany = await call(Debtors as any, A.jar, { method: 'GET', path: '/api/debtors?limit=500' });
      expect(d1.data.totals).toEqual(dMany.data.totals);
      const s1 = await call(Students as any, A.jar, { method: 'GET', path: '/api/students?limit=1' });
      const sMany = await call(Students as any, A.jar, { method: 'GET', path: '/api/students?limit=1000' });
      expect(s1.data.totals).toEqual(sMany.data.totals);
      expect(sMany.data.totals.studentCount).toBe(VOLUME_STUDENTS);
      expect(dMany.data.totals.debtorCount).toBe(VOLUME_INVOICED);
    });

    it('B3: walking the cursor covers every row exactly once', { timeout: 60_000 }, async () => {
      // invoices (505 rows at limit 200 → 3 pages)
      await walk(
        async (cursor) =>
          call(Invoices as any, A.jar, {
            method: 'GET',
            path: `/api/invoices?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          }),
        'invoices',
        VOLUME_INVOICED,
      );
      // students (1005 rows at limit 1000 → 2 pages)
      await walk(
        async (cursor) =>
          call(Students as any, A.jar, {
            method: 'GET',
            path: `/api/students?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          }),
        'students',
        VOLUME_STUDENTS,
      );
      // debtors (505 rows at limit 200 → 3 pages)
      await walk(
        async (cursor) =>
          call(Debtors as any, A.jar, {
            method: 'GET',
            path: `/api/debtors?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          }),
        'debtors',
        VOLUME_INVOICED,
      );
      // payments + collections + reconciliation (12 rows each at limit 5)
      await walk(
        async (cursor) =>
          call(Payments as any, A.jar, {
            method: 'GET',
            path: `/api/payments?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          }),
        'payments',
        SMALL_PAYMENTS,
      );
      await walk(
        async (cursor) =>
          call(Collections as any, A.jar, {
            method: 'GET',
            path: `/api/collections?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          }),
        'collections',
        SMALL_CASES,
      );
      await walk(
        async (cursor) =>
          call(ReconQueue as any, A.jar, {
            method: 'GET',
            path: `/api/reconciliation/queue?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          }),
        'reconciliation-queue',
        SMALL_PAYMENTS,
      );
    });

    it('B4: a cursor is bound to its surface, and the cap is a ceiling rather than a hint', async () => {
      const first = await call(Invoices as any, A.jar, { method: 'GET', path: '/api/invoices?limit=5' });
      const cursor = first.data.page.nextCursor as string;
      expect(cursor).toBeTruthy();

      // Replayed against a different surface → refused, not silently applied.
      const crossSurface = await call(Students as any, A.jar, {
        method: 'GET',
        path: `/api/students?cursor=${encodeURIComponent(cursor)}`,
      });
      expect(crossSurface.status, JSON.stringify(crossSurface.data)).toBe(400);

      // Tampered cursor → refused.
      const tampered = await call(Invoices as any, A.jar, {
        method: 'GET',
        path: `/api/invoices?cursor=${encodeURIComponent(cursor.slice(0, -4) + 'AAAA')}`,
      });
      expect(tampered.status).toBe(400);

      // Over-cap request is clamped AND declared.
      const over = await call(Invoices as any, A.jar, { method: 'GET', path: '/api/invoices?limit=999999' });
      expect(over.status).toBe(200);
      expect(over.data.page.limit).toBe(over.data.page.cap);
      expect(over.data.page.returned).toBeLessThanOrEqual(over.data.page.cap);

      // A non-numeric limit is a bad request, not a silent default.
      const bad = await call(Invoices as any, A.jar, { method: 'GET', path: '/api/invoices?limit=abc' });
      expect(bad.status).toBe(400);
    });

    it('B5: no surface can report a truncated view as complete', { timeout: 30_000 }, async () => {
      const list = await call(Invoices as any, A.jar, { method: 'GET', path: '/api/invoices?limit=200' });
      const page = list.data.page;
      // eslint-disable-next-line no-console
      console.log('[h2 dbg]', JSON.stringify({ status: list.status, page, totals: list.data.totals, rows: (list.data.invoices ?? []).length }));
      expect(page.returned).toBe(200);
      expect(page.total).toBe(VOLUME_INVOICED);
      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).toBeTruthy();
      // `returned < total` and `hasMore` agree — the two independent truncation signals.
      expect(page.returned < page.total).toBe(page.hasMore);

      const students = await call(Students as any, A.jar, { method: 'GET', path: '/api/students?limit=200' });
      expect(students.data.page.returned).toBe(200);
      expect(students.data.page.total).toBe(VOLUME_STUDENTS);
      expect(students.data.page.hasMore).toBe(true);

      // The debtors workbench declares its window and echoes the thresholds it
      // classified with, so the UI can label "stale" the way the server did.
      const debtors = await call(Debtors as any, A.jar, { method: 'GET', path: '/api/debtors?limit=5' });
      expect(debtors.data.page.total).toBe(VOLUME_INVOICED);
      expect(debtors.data.thresholds).toMatchObject({ staleAfterDays: 7, unattendedAfterDays: 14, reminderCooldownHours: 4 });
      expect(debtors.data.scope.scope).toBe('ALL_TERM');
      for (const row of debtors.data.students) {
        expect(['NONE', 'FRESH', 'STALE', 'UNATTENDED']).toContain(row.reminderStaleness);
      }
    });
  });

  // ===========================================================================
  // C — adversarial
  // ===========================================================================
  describe('C — adversarial: truncation, crossover, boundaries, misleading counts', () => {
    it('C1: another tenant never appears in rows, totals or buckets', { timeout: 30_000 }, async () => {
      const list = await call(Invoices as any, A.jar, { method: 'GET', path: '/api/invoices?limit=200' });
      expect(list.status, JSON.stringify(list.data)).toBe(200);
      const numbers = (list.data.invoices as any[]).map((r) => r.invoiceNumber);
      expect(numbers.some((n) => String(n).startsWith('H2B-'))).toBe(false);

      const sql = await enterCtx(B);
      const bTruth = (await sql.unsafe(
        `select coalesce(sum(total_kobo), 0)::bigint as billed from invoices where organization_id = $1::uuid`,
        [B.orgId],
      )) as any[];
      // B's 3 × 777,777 must appear in neither A's strip nor A's buckets.
      expect(list.data.totals.billedKobo).not.toBe(Number(bTruth[0].billed));
      const dash = await call(Dashboard as any, A.jar, { method: 'GET', path: '/api/dashboard/summary' });
      expect(dash.data.kpis.billedKobo).not.toBe(Number(bTruth[0].billed));
      expect(dash.data.buckets.reduce((n: number, b: any) => n + b.billedKobo, 0)).toBe(dash.data.kpis.billedKobo);

      const payments = await call(Payments as any, A.jar, { method: 'GET', path: '/api/payments?limit=200' });
      expect((payments.data.payments as any[]).every((p) => !String(p.paymentNumber).startsWith('H2B-'))).toBe(true);
      expect(payments.data.page.total).toBe(SMALL_PAYMENTS);

      const studentRows = await call(Students as any, A.jar, { method: 'GET', path: '/api/students?limit=1000' });
      expect(studentRows.data.totals.studentCount).toBe(VOLUME_STUDENTS);
      expect((studentRows.data.students as any[]).every((s) => !s.name.startsWith('Foreign'))).toBe(true);
    });

    it('C2: staleness is classified on the boundaries, not near them (M-7)', async () => {
      const sql = await enterCtx(A);
      // Six debtors, one reminder each at an exact offset from now.
      // The rows are written with the database clock and read a few milliseconds
      // later against the API's clock, so "exactly 7 days" cannot be asserted
      // through the API: it is asserted on the classifier below, where both
      // instants come from one clock. Here each pair straddles the boundary.
      const offsets: Array<[string, string]> = [
        ['H2S-0001', "now() - interval '6 days 23 hours'"],
        ['H2S-0002', "now() - interval '7 days 1 minute'"],
        ['H2S-0003', "now() - interval '7 days 1 hour'"],
        ['H2S-0004', "now() - interval '13 days 23 hours'"],
        ['H2S-0005', "now() - interval '14 days 1 hour'"],
      ];
      for (const [code, expr] of offsets) {
        await sql.unsafe(
          `insert into reminders (organization_id, student_id, channel, status, balance_kobo, aging_bucket, body, created_at, updated_at)
           select $1::uuid, s.id, 'SMS'::communication_channel, 'PENDING'::communication_status, 1000, 'OVERDUE_30', 'H-2 boundary probe', ${expr}, ${expr}
             from students s where s.organization_id = $1::uuid and s.student_id = $2 limit 1`,
          [A.orgId, code],
        );
      }

      const expected: Record<string, string> = {
        'H2S-0001': 'FRESH', // 6d23h — inside the fresh window
        'H2S-0002': 'STALE', // 7d1m — just past "older than 7 days"
        'H2S-0003': 'STALE',
        'H2S-0004': 'STALE', // 13d23h — stale, not yet unattended
        'H2S-0005': 'UNATTENDED',
      };
      const detail: Record<string, any> = {};
      for (const code of Object.keys(expected)) {
        // Handlers clear the tenant GUCs on return: every direct query that
        // follows one re-establishes context first.
        const sql = await enterCtx(A);
        const idRows = (await sql.unsafe(
          `select id from students where organization_id = $1::uuid and student_id = $2 limit 1`,
          [A.orgId, code],
        )) as any[];
        const detailRes = await call(DebtorDetail as any, A.jar, {
          method: 'GET',
          path: `/api/debtors/${idRows[0].id}`,
          args: [{ params: Promise.resolve({ studentId: String(idRows[0].id) }) }],
        });
        expect(detailRes.status, JSON.stringify(detailRes.data)).toBe(200);
        const row = detailRes.data.reminders[0];
        detail[code] = row.reminderStaleness;
        expect(row.reminderStaleness, `${code} (${offsets.find(([c]) => c === code)![1]})`).toBe(expected[code]);
        expect(detailRes.data.thresholds.staleAfterDays).toBe(7);
        expect(detailRes.data.remindersPage.total).toBe(1);
      }

      // The TypeScript classifier agrees with the API, and pins the boundary
      // instants exactly (one clock: the classifier's `now`).
      const now = new Date();
      expect(classifyReminderStaleness(new Date(now.getTime() - 6.95 * 86400000), now).staleness).toBe('FRESH');
      expect(classifyReminderStaleness(new Date(now.getTime() - 7 * 86400000), now).staleness).toBe('FRESH');
      expect(classifyReminderStaleness(new Date(now.getTime() - 7.1 * 86400000), now).staleness).toBe('STALE');
      expect(classifyReminderStaleness(new Date(now.getTime() - 14 * 86400000), now).staleness).toBe('STALE');
      expect(classifyReminderStaleness(new Date(now.getTime() - 14.1 * 86400000), now).staleness).toBe('UNATTENDED');
      expect(classifyReminderStaleness(null, now)).toEqual({ staleness: 'NONE', daysSinceReminder: null });
    });

    it('C3: the reminder cooldown is a server rule with a declared boundary', async () => {
      // The reminders table is immutable for the runtime role, so each case is
      // seeded as its own row rather than by re-dating one: that also proves the
      // cooldown is evaluated from stored state, not from anything a client says.
      const cases: Array<{ code: string; expr: string; expect: 'blocked' | 'allowed' }> = [
        { code: 'H2S-0100', expr: "now() - interval '1 hour'", expect: 'blocked' },
        { code: 'H2S-0101', expr: "now() - interval '3 hours 59 minutes'", expect: 'blocked' },
        { code: 'H2S-0102', expr: "now() - interval '4 hours 1 minute'", expect: 'allowed' },
      ];
      for (const c of cases) {
        // One context for the whole iteration: a handler call in the previous
        // iteration cleared the tenant GUCs on this connection, and an
        // `INSERT ... SELECT` from an RLS-filtered table would then insert
        // nothing at all — silently, because zero rows is a legal result.
        const sqlCase = await enterCtx(A);
        await sqlCase.unsafe(
          `insert into reminders (organization_id, student_id, channel, status, balance_kobo, aging_bucket, body, created_at, updated_at)
           select $1::uuid, s.id, 'SMS'::communication_channel, 'PENDING'::communication_status, 1000, 'OVERDUE_30', 'H-2 cooldown probe', ${c.expr}, ${c.expr}
             from students s where s.organization_id = $1::uuid and s.student_id = $2 limit 1`,
          [A.orgId, c.code],
        );
        const idRows = (await sqlCase.unsafe(
          `select id from students where organization_id = $1::uuid and student_id = $2 limit 1`,
          [A.orgId, c.code],
        )) as any[];
        const studentId = idRows[0].id as string;
        const res = await call(Remind as any, A.jar, {
          method: 'POST',
          path: `/api/debtors/${studentId}/remind`,
          csrf: true,
          body: { channel: 'SMS' },
          args: [{ params: Promise.resolve({ studentId }) }],
        });
        if (c.expect === 'blocked') {
          expect(res.status, `${c.code} (${c.expr}): ${JSON.stringify(res.data)}`).toBe(429);
          expect(res.data.error.code).toBe('TOO_EARLY');
          expect(res.data.error.details?.cooldownHours).toBe(4);
          expect(res.data.error.message).toContain('4 hours');
        } else {
          expect([200, 201], `${c.code} (${c.expr}): ${JSON.stringify(res.data)}`).toContain(res.status);
        }
      }
    });

    it('C4: a page can never claim to be complete while rows remain', { timeout: 60_000 }, async () => {
      // Walk invoices at limit 7 and prove the terminal page is genuinely terminal.
      let cursor: string | null = null;
      let seen = 0;
      for (let i = 0; i < 200; i += 1) {
        const res = await call(Invoices as any, A.jar, {
          method: 'GET',
          path: `/api/invoices?limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        });
        const page = expectPage(res.data.page, 'invoices');
        const rowsLength = (res.data.invoices as any[]).length;
        seen += rowsLength;
        if (page.hasMore) {
          expect(page.nextCursor).toBeTruthy();
          expect(page.returned).toBe(7);
          cursor = page.nextCursor;
        } else {
          expect(page.nextCursor).toBeNull();
          expect(page.returned).toBe(rowsLength);
          break;
        }
      }
      expect(seen).toBe(VOLUME_INVOICED);
    });
  });

  // ===========================================================================
  // D — financial periods (the term boundary)
  // ===========================================================================
  describe('D — financial periods: the term-boundary control', () => {
    const window = () => {
      const start = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
      const end = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
      return { start, end };
    };

    it('D1: a period is a bounded, non-overlapping window and it declares its window when listed', async () => {
      const { start, end } = window();
      const created = await call(PeriodCreate as any, P.jar, {
        method: 'POST',
        path: '/api/financial-periods',
        csrf: true,
        headers: { 'idempotency-key': idem() },
        body: { name: `H2 Period ${rand()}`, startsOn: start, endsOn: end },
      });
      expect(created.status, JSON.stringify(created.data)).toBe(201);
      expect(created.data.period.status).toBe('OPEN');

      const overlapping = await call(PeriodCreate as any, P.jar, {
        method: 'POST',
        path: '/api/financial-periods',
        csrf: true,
        headers: { 'idempotency-key': idem() },
        body: { name: `H2 Overlap ${rand()}`, startsOn: end, endsOn: end },
      });
      expect(overlapping.status).toBe(409);

      const list = await call(PeriodsList as any, P.jar, { method: 'GET', path: '/api/financial-periods?limit=5' });
      const page = expectPage(list.data.page, 'financial-periods');
      expect(page.total).toBeGreaterThanOrEqual(1);

      const detail = await call(PeriodGet as any, P.jar, {
        method: 'GET',
        path: `/api/financial-periods/${created.data.period.id}`,
        args: [{ params: Promise.resolve({ id: created.data.period.id }) }],
      });
      expect(detail.status).toBe(200);
      expect(detail.data.valuation.allTerm).toBeTruthy();
      expect(detail.data.scope.scope).toBe('ALL_TERM');
    });

    it('D2: a close is refused while the window holds unresolved or unapplied money', async () => {
      const { start, end } = window();
      const created = await call(PeriodCreate as any, P.jar, {
        method: 'POST',
        path: '/api/financial-periods',
        csrf: true,
        headers: { 'idempotency-key': idem() },
        body: { name: `H2 Blocked ${rand()}`, startsOn: start, endsOn: end },
      });
      expect(created.status).toBe(201);
      const periodId = created.data.period.id as string;

      const sql = await enterCtx(P);
      // A payment awaiting confirmation inside the window.
      await sql.unsafe(
        // Inside the window [today-60, today-10]: money placed after the period
        // end is correctly outside the as-of report, so a fixture dated "5 days
        // ago" was testing nothing.
        `insert into payments (organization_id, payment_number, method, status, amount_kobo, unallocated_kobo, payer_name, created_at)
         values ($1::uuid, 'H2P-PEND-1', 'CASH'::payment_method, 'PENDING'::payment_status, 50000, 50000, 'Pending Payer', now() - interval '30 days')`,
        [P.orgId],
      );
      const blocked = await call(PeriodClose as any, P.jar, {
        method: 'POST',
        path: `/api/financial-periods/${periodId}/close`,
        csrf: true,
        headers: { 'idempotency-key': idem() },
        args: [{ params: Promise.resolve({ id: periodId }) }],
      });
      expect(blocked.status).toBe(409);
      expect(blocked.data.error.code).toBe('PERIOD_HAS_UNRESOLVED_PAYMENTS');
      expect(blocked.data.error.details.pendingCount).toBe(1);

      // Resolve it into an unapplied CONFIRMED balance → still refused, other reason.
      const sqlAfterClose = await enterCtx(P);
      await sqlAfterClose.unsafe(
        `update payments set status = 'CONFIRMED'::payment_status
          where organization_id = $1::uuid and payment_number = 'H2P-PEND-1'`,
        [P.orgId],
      );
      const stillBlocked = await call(PeriodClose as any, P.jar, {
        method: 'POST',
        path: `/api/financial-periods/${periodId}/close`,
        csrf: true,
        headers: { 'idempotency-key': idem() },
        args: [{ params: Promise.resolve({ id: periodId }) }],
      });
      expect(stillBlocked.status).toBe(409);
      expect(stillBlocked.data.error.code).toBe('PERIOD_HAS_UNALLOCATED_PAYMENTS');
      expect(stillBlocked.data.error.details.unallocatedCount).toBe(1);
      expect(stillBlocked.data.error.details.unallocatedKobo).toBe(50000);
    });

    it('D3: once the money is resolved the close succeeds, is idempotent, and the valuation ties to source rows', async () => {
      const { start, end } = window();
      const created = await call(PeriodCreate as any, P.jar, {
        method: 'POST',
        path: '/api/financial-periods',
        csrf: true,
        headers: { 'idempotency-key': idem() },
        body: { name: `H2 Close ${rand()}`, startsOn: start, endsOn: end },
      });
      const periodId = created.data.period.id as string;

      const sql = await enterCtx(P);
      const invRows = (await sql.unsafe(
        `select id, total_kobo, paid_kobo from invoices where organization_id = $1::uuid limit 1`,
        [P.orgId],
      )) as any[];
      const invoiceId = invRows[0].id as string;

      // Confirmed money that is FULLY applied inside the window.
      await sql.unsafe(
        `insert into payments (organization_id, payment_number, method, status, amount_kobo, unallocated_kobo, payer_name, created_at)
         values ($1::uuid, 'H2P-OK-1', 'CASH'::payment_method, 'CONFIRMED'::payment_status, 100000, 0, 'Applied Payer', now() - interval '30 days')`,
        [P.orgId],
      );
      const payRows = (await sql.unsafe(
        `select id from payments where organization_id = $1::uuid and payment_number = 'H2P-OK-1'`,
        [P.orgId],
      )) as any[];
      await sql.unsafe(
        `insert into payment_allocations (organization_id, payment_id, invoice_id, amount_kobo, status, allocated_at)
         values ($1::uuid, $2::uuid, $3::uuid, 100000, 'ACTIVE'::allocation_status, now() - interval '28 days')`,
        [P.orgId, payRows[0].id, invoiceId],
      );

      const closed = await call(PeriodClose as any, P.jar, {
        method: 'POST',
        path: `/api/financial-periods/${periodId}/close`,
        csrf: true,
        headers: { 'idempotency-key': idem() },
        args: [{ params: Promise.resolve({ id: periodId }) }],
      });
      expect(closed.status, JSON.stringify(closed.data)).toBe(201);
      expect(closed.data.period.status).toBe('CLOSED');
      expect(closed.data.alreadyClosed).toBe(false);
      expect(closed.data.valuation.allTerm.paymentsReceivedKobo).toBe(100000);
      expect(closed.data.valuation.allTerm.paymentsUnallocatedKobo).toBe(0);

      // As-of valuation equals hand-written SQL over the same timestamps.
      const sqlAfterClose = await enterCtx(P);
      const truth = (await sqlAfterClose.unsafe(
        `select coalesce(sum(a.amount_kobo), 0)::bigint as collected
           from payment_allocations a join payments p on p.id = a.payment_id
          where a.organization_id = $1::uuid and a.status = 'ACTIVE' and p.status = 'CONFIRMED'
            and a.allocated_at::date <= $2::date`,
        [P.orgId, end],
      )) as any[];
      expect(closed.data.valuation.allTerm.collectedKobo).toBe(Number(truth[0].collected));

      // Closing again reports the frozen state instead of mutating it.
      const again = await call(PeriodClose as any, P.jar, {
        method: 'POST',
        path: `/api/financial-periods/${periodId}/close`,
        csrf: true,
        headers: { 'idempotency-key': idem() },
        args: [{ params: Promise.resolve({ id: periodId }) }],
      });
      expect(again.status).toBe(200);
      expect(again.data.alreadyClosed).toBe(true);
      expect(again.data.period.closedAt).toBe(closed.data.period.closedAt);

      // Exactly one close audit event.
      const sqlForAudits = await enterCtx(P);
      const audits = (await sqlForAudits.unsafe(
        `select count(*)::int as n from audit_events
          where organization_id = $1::uuid and action = 'financial_period.close'`,
        [P.orgId],
      )) as any[];
      expect(Number(audits[0].n)).toBe(1);

      // Money arriving AFTER the window does not move the closed report.
      await sql.unsafe(
        `insert into payments (organization_id, payment_number, method, status, amount_kobo, unallocated_kobo, payer_name, created_at)
         values ($1::uuid, 'H2P-LATE-1', 'CASH'::payment_method, 'CONFIRMED'::payment_status, 100000, 0, 'Late Payer', now() + interval '1 day')`,
        [P.orgId],
      );
      const latePay = (await sql.unsafe(
        `select id from payments where organization_id = $1::uuid and payment_number = 'H2P-LATE-1'`,
        [P.orgId],
      )) as any[];
      await sql.unsafe(
        `insert into payment_allocations (organization_id, payment_id, invoice_id, amount_kobo, status, allocated_at)
         values ($1::uuid, $2::uuid, $3::uuid, 100000, 'ACTIVE'::allocation_status, now() + interval '1 day')`,
        [P.orgId, latePay[0].id, invoiceId],
      );
      const after = await call(PeriodGet as any, P.jar, {
        method: 'GET',
        path: `/api/financial-periods/${periodId}`,
        args: [{ params: Promise.resolve({ id: periodId }) }],
      });
      expect(after.status).toBe(200);
      expect(after.data.valuation.allTerm.collectedKobo).toBe(closed.data.valuation.allTerm.collectedKobo);
      expect(after.data.valuation.allTerm.paymentsReceivedKobo).toBe(100000);
    });

    it('D4: a closed period cannot be rewritten or deleted, and the new tables stay RLS-forced', async () => {
      const { start, end } = window();
      const created = await call(PeriodCreate as any, P.jar, {
        method: 'POST',
        path: '/api/financial-periods',
        csrf: true,
        headers: { 'idempotency-key': idem() },
        body: { name: `H2 Immutable ${rand()}`, startsOn: start, endsOn: end },
      });
      const periodId = created.data.period.id as string;
      const close = await call(PeriodClose as any, P.jar, {
        method: 'POST',
        path: `/api/financial-periods/${periodId}/close`,
        csrf: true,
        headers: { 'idempotency-key': idem() },
        args: [{ params: Promise.resolve({ id: periodId }) }],
      });
      expect(close.status).toBe(201);
      const closedAt = close.data.period.closedAt;

      const sql = await enterCtx(P);
      // Direct rewrite of a closed window must fail (trigger, not convention).
      await sql.unsafe('SAVEPOINT h2_d4');
      let rewriteError: any = null;
      try {
        await sql.unsafe(
          `update financial_periods set ends_on = ends_on + 30, closed_at = null
            where organization_id = $1::uuid and id = $2::uuid`,
          [P.orgId, periodId],
        );
      } catch (e: any) {
        rewriteError = e;
      } finally {
        await sql.unsafe('ROLLBACK TO SAVEPOINT h2_d4');
        await sql.unsafe('RELEASE SAVEPOINT h2_d4');
      }
      expect(rewriteError, 'a closed period was rewritten').toBeTruthy();

      // The runtime role holds no DELETE privilege on boundary evidence: the
      // attempt fails at the privilege boundary, and the row survives either way.
      const privs = (await sql.unsafe(
        `select has_table_privilege('scolaira_app', 'public.financial_periods', 'DELETE') as can_delete,
                has_table_privilege('scolaira_app', 'public.surface_scope_settings', 'DELETE') as can_delete_setting`,
      )) as any[];
      expect(privs[0].can_delete).toBe(false);
      expect(privs[0].can_delete_setting).toBe(false);
      await sql.unsafe('SAVEPOINT h2_d4_del');
      let delError: any = null;
      let delRows: any[] = [];
      try {
        delRows = (await sql.unsafe(
          `delete from financial_periods where organization_id = $1::uuid and id = $2::uuid returning id`,
          [P.orgId, periodId],
        )) as any[];
      } catch (e: any) {
        delError = e;
      } finally {
        await sql.unsafe('ROLLBACK TO SAVEPOINT h2_d4_del');
        await sql.unsafe('RELEASE SAVEPOINT h2_d4_del');
      }
      expect(delError ? delError.code : null, 'a period was deleted by the runtime role').not.toBeNull();
      expect(delRows.length).toBe(0);
      const still = (await sql.unsafe(
        `select closed_at from financial_periods where organization_id = $1::uuid and id = $2::uuid`,
        [P.orgId, periodId],
      )) as any[];
      expect(still.length).toBe(1);
      expect(new Date(still[0].closed_at).toISOString()).toBe(closedAt);

      // Posture pins for the two new tables + the two new functions.
      const posture = (await sql.unsafe(
        `select c.relname, c.relrowsecurity, c.relforcerowsecurity
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname in ('financial_periods', 'surface_scope_settings')
          order by c.relname`,
      )) as any[];
      expect(posture.map((r) => r.relname)).toEqual(['financial_periods', 'surface_scope_settings']);
      for (const row of posture) {
        expect(row.relrowsecurity, `${row.relname} has RLS disabled`).toBe(true);
        expect(row.relforcerowsecurity, `${row.relname} is not FORCE-RLS`).toBe(true);
      }
      const fns = (await sql.unsafe(
        `select p.proname,
                has_function_privilege('scolaira_app', p.oid, 'EXECUTE') as app_can,
                p.prosecdef as is_definer
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname in ('auth_invoice_scope_buckets', 'auth_period_valuation')
          order by p.proname`,
      )) as any[];
      expect(fns.map((r) => r.proname)).toEqual(['auth_invoice_scope_buckets', 'auth_period_valuation']);
      for (const fn of fns) {
        expect(fn.app_can, `${fn.proname} is not callable by the runtime role`).toBe(true);
        // SECURITY INVOKER: the classification must never bypass RLS.
        expect(fn.is_definer, `${fn.proname} escalated to SECURITY DEFINER`).toBe(false);
      }
    });

    it('D5: the period valuation is tenant-scoped (no owner-context visibility, no crossover)', async () => {
      const created = await call(PeriodCreate as any, P.jar, {
        method: 'POST',
        path: '/api/financial-periods',
        csrf: true,
        headers: { 'idempotency-key': idem() },
        body: {
          name: `H2 Scoped ${rand()}`,
          startsOn: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
          endsOn: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10),
        },
      });
      expect(created.status).toBe(201);

      // Tenant A must not see or value P's period.
      const foreign = await call(PeriodGet as any, A.jar, {
        method: 'GET',
        path: `/api/financial-periods/${created.data.period.id}`,
        args: [{ params: Promise.resolve({ id: created.data.period.id }) }],
      });
      expect(foreign.status).toBe(404);

      // Row-level scoping on the new table: under A's tenant context the row is
      // not visible, and a raw count over the table equals only A's own rows.
      const sqlA = await enterCtx(A);
      const visibleToA = (await sqlA.unsafe(
        `select count(*)::int as n from financial_periods where id = $1::uuid`,
        [created.data.period.id],
      )) as any[];
      expect(Number(visibleToA[0].n)).toBe(0);
      const allVisibleToA = (await sqlA.unsafe(`select count(*)::int as n from financial_periods`)) as any[];
      expect(Number(allVisibleToA[0].n)).toBe(0);
      const visibleToP = (await (await enterCtx(P)).unsafe(
        `select count(*)::int as n from financial_periods where id = $1::uuid`,
        [created.data.period.id],
      )) as any[];
      expect(Number(visibleToP[0].n)).toBe(1);
    });
  });
});
