// @vitest-environment node
/**
 * Phase 2 — opening balances, HTTP contract.
 *
 * The database tests prove the invariants. This suite proves the SURFACE a school
 * touches, which is where the different failures live:
 *
 *   · who may read, record, review, post and reverse (a STAFF member is refused at
 *     every one of the five, because `invoice.*` is the boundary and STAFF has none
 *     of it);
 *   · CSRF on every mutation;
 *   · a body sent without JSON, a foreign student, a wrong term — each answered
 *     with a sentence, not a 500;
 *   · that recording a figure writes NO invoice, which is the property that makes
 *     the register safe to hand to a school before it is understood;
 *   · that posting REQUIRES an `Idempotency-Key`, and that a replay of the same key
 *     does not mint a second invoice — the exact double-charge a slow connection
 *     would otherwise cause;
 *   · that the read model reports what the ledger says, not what the register
 *     remembers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { call, CookieJar } from './support';
import { POST as registerPost } from '@/app/api/auth/register/route';
import { GET as meGet } from '@/app/api/auth/me/route';
import { POST as selectOrganizationPost } from '@/app/api/auth/select-organization/route';
import { GET as listGet, POST as recordPost } from '@/app/api/opening-balances/route';
import { POST as reviewPost } from '@/app/api/opening-balances/[id]/review/route';
import { POST as postPost } from '@/app/api/opening-balances/[id]/post/route';
import { POST as reversePost } from '@/app/api/opening-balances/[id]/reverse/route';
import { getSql } from '@/lib/db';
import { invoices } from '@/lib/db/schema';
import { count, eq } from 'drizzle-orm';
import { testDb } from '../setup-db';
import {
  enableSavepointTransactionsForTest,
  disableSavepointTransactionsForTest,
} from '../setup-db';
import { withSystemContext } from '@/lib/db/tenant';
import type { TenantCtx, UUID } from '@/lib/db/repo/_context';

const AS_AT = '2026-06-30'; // after the prior term, before the active term began
const ACTIVE_STARTS = '2026-09-08';

function unique(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

interface School {
  jar: CookieJar;
  ctx: TenantCtx;
  studentId: UUID;
  activeTermId: UUID;
  priorTermId: UUID;
}

/**
 * A school with the shape Phase 2 needs: a current ACTIVE term being billed, a
 * CLOSED prior term of an earlier session to carry in from, and one child.
 */
async function newSchool(): Promise<School> {
  const jar = new CookieJar();
  await call(registerPost as never, jar, {
    method: 'POST',
    path: '/api/auth/register',
    body: {
      email: `${unique('ob2').toLowerCase()}@example.test`,
      password: 'Opening-balance-owner-password-A1!',
      firstName: 'O',
      lastName: 'Owner',
      organizationName: unique('OB2 School'),
      organizationSlug: unique('ob2-school').toLowerCase(),
    },
  });
  const me = await call(meGet as never, jar, { method: 'GET', path: '/api/auth/me' });
  expect(me.status).toBe(200);
  const organizationId = me.data.activeOrganizationId as UUID;
  const userId = me.data.user.id as UUID;

  const priorSessionId = randomUUID();
  const currentSessionId = randomUUID();
  const priorTermId = randomUUID();
  const activeTermId = randomUUID();
  const classId = randomUUID();
  const studentId = randomUUID();

  await withSystemContext(organizationId, userId, async () => {
    const sql = getSql();
    await sql`INSERT INTO academic_sessions (id, name, starts_on, ends_on, is_current, status)
              VALUES (${priorSessionId}::uuid, '2025/2026', '2025-09-01', '2026-07-31', false, 'CLOSED')`;
    await sql`INSERT INTO terms (id, session_id, name, label, starts_on, ends_on, due_date, is_current, status)
              VALUES (${priorTermId}::uuid, ${priorSessionId}::uuid, 'Third Term', '3rd',
                      '2026-01-13', '2026-04-10', '2026-03-31', false, 'CLOSED')`;
    await sql`INSERT INTO academic_sessions (id, name, starts_on, ends_on, is_current, status)
              VALUES (${currentSessionId}::uuid, '2026/2027', '2026-09-01', '2027-07-30', true, 'ACTIVE')`;
    await sql`INSERT INTO terms (id, session_id, name, label, starts_on, ends_on, due_date, is_current, status)
              VALUES (${activeTermId}::uuid, ${currentSessionId}::uuid, 'First Term', '1st',
                      ${ACTIVE_STARTS}, '2026-12-15', '2026-12-01', true, 'ACTIVE')`;
    await sql`INSERT INTO classes (id, name, sort_order) VALUES (${classId}::uuid, 'Primary 4', 0)`;
    await sql`INSERT INTO students (id, student_id, first_name, last_name, status)
              VALUES (${studentId}::uuid, 'OB2-001', 'Ada', 'Eze', 'ACTIVE')`;
  });

  await getSql()`SELECT set_tenant_context(${organizationId}::uuid, ${userId}::uuid)`;
  return {
    jar,
    ctx: { organizationId, userId },
    studentId: studentId as UUID,
    activeTermId: activeTermId as UUID,
    priorTermId: priorTermId as UUID,
  };
}

/** A STAFF member of the same school: signed in, and entitled to none of this. */
async function staffSessionFor(ctx: TenantCtx): Promise<CookieJar> {
  const jar = new CookieJar();
  await call(registerPost as never, jar, {
    method: 'POST',
    path: '/api/auth/register',
    body: {
      email: `${unique('ob2-staff').toLowerCase()}@example.test`,
      password: 'Opening-balance-staff-password-A1!',
      firstName: 'O',
      lastName: 'Staff',
      organizationName: unique('OB2 Staff School'),
      organizationSlug: unique('ob2-staff-school').toLowerCase(),
    },
  });
  const me = await call(meGet as never, jar, { method: 'GET', path: '/api/auth/me' });
  const userId = me.data.user.id as UUID;
  await withSystemContext(null, null, async () => {
    const sql = getSql();
    await sql`INSERT INTO organization_members (id, organization_id, user_id, role, status, joined_at)
              VALUES (${randomUUID()}::uuid, ${ctx.organizationId}::uuid, ${userId}::uuid, 'STAFF', 'ACTIVE', now())`;
  });
  const selected = await call(selectOrganizationPost as never, jar, {
    method: 'POST',
    path: '/api/auth/select-organization',
    body: { organizationId: ctx.organizationId },
    csrf: true,
  });
  expect(selected.status).toBe(200);
  return jar;
}

async function invoiceCount(ctx: TenantCtx): Promise<number> {
  await getSql()`SELECT set_tenant_context(${ctx.organizationId}::uuid, ${ctx.userId}::uuid)`;
  const rows = await testDb()
    .select({ n: count() })
    .from(invoices)
    .where(eq(invoices.organizationId, ctx.organizationId));
  return Number(rows[0]?.n ?? 0);
}

function record(
  school: School,
  over: Record<string, unknown> = {},
  init: Record<string, unknown> = {},
) {
  return call(recordPost as never, school.jar, {
    method: 'POST',
    path: '/api/opening-balances',
    csrf: true,
    body: {
      studentId: school.studentId,
      category: 'HISTORICAL_BALANCE',
      amountKobo: 45_000_000,
      asAt: AS_AT,
      termId: school.priorTermId,
      sourceNote: 'Old receipt book, page 14',
      ...over,
    },
    ...init,
  });
}

async function recorded(school: School, over: Record<string, unknown> = {}) {
  const res = await record(school, over);
  expect(res.status, JSON.stringify(res.data)).toBe(201);
  return res.data.openingBalance.id as string;
}

function review(school: School, id: string, body: unknown, init: Record<string, unknown> = {}) {
  return call(reviewPost as never, school.jar, {
    method: 'POST',
    path: `/api/opening-balances/${id}/review`,
    args: [{ params: Promise.resolve({ id }) }],
    body,
    csrf: true,
    ...init,
  });
}

function post(school: School, id: string, init: Record<string, unknown> = {}) {
  return call(postPost as never, school.jar, {
    method: 'POST',
    path: `/api/opening-balances/${id}/post`,
    args: [{ params: Promise.resolve({ id }) }],
    body: {},
    headers: { 'idempotency-key': randomUUID() },
    csrf: true,
    ...init,
  });
}

function reverse(school: School, id: string, body: unknown, init: Record<string, unknown> = {}) {
  return call(reversePost as never, school.jar, {
    method: 'POST',
    path: `/api/opening-balances/${id}/reverse`,
    args: [{ params: Promise.resolve({ id }) }],
    body,
    csrf: true,
    ...init,
  });
}

describe('Phase 2 — opening-balance routes', () => {
  beforeEach(() => enableSavepointTransactionsForTest());
  afterEach(() => disableSavepointTransactionsForTest());

  // ── Who may touch it ────────────────────────────────────────────────────

  it('refuses an unauthenticated read and an unauthenticated record', async () => {
    const jar = new CookieJar();
    const read = await call(listGet as never, jar, {
      method: 'GET',
      path: '/api/opening-balances',
    });
    expect(read.status).toBe(401);
    const write = await call(recordPost as never, jar, {
      method: 'POST',
      path: '/api/opening-balances',
      body: {},
      csrf: true,
    });
    expect(write.status).toBe(401);
  });

  it('refuses a STAFF member on every one of the five endpoints', async () => {
    const school = await newSchool();
    const staff = await staffSessionFor(school.ctx);
    const id = await recorded(school);

    const read = await call(listGet as never, staff, {
      method: 'GET',
      path: '/api/opening-balances',
    });
    expect(read.status).toBe(403);
    const write = await call(recordPost as never, staff, {
      method: 'POST',
      path: '/api/opening-balances',
      body: {
        studentId: school.studentId,
        category: 'HISTORICAL_BALANCE',
        amountKobo: 1_000,
        asAt: AS_AT,
        sourceNote: 'A staff member should not be able to write this',
      },
      csrf: true,
    });
    expect(write.status).toBe(403);
    const reviewed = await call(reviewPost as never, staff, {
      method: 'POST',
      path: `/api/opening-balances/${id}/review`,
      args: [{ params: Promise.resolve({ id }) }],
      body: { decision: 'APPROVE' },
      csrf: true,
    });
    expect(reviewed.status).toBe(403);
    const posted = await call(postPost as never, staff, {
      method: 'POST',
      path: `/api/opening-balances/${id}/post`,
      args: [{ params: Promise.resolve({ id }) }],
      body: {},
      headers: { 'idempotency-key': randomUUID() },
      csrf: true,
    });
    expect(posted.status).toBe(403);
    const reversed = await call(reversePost as never, staff, {
      method: 'POST',
      path: `/api/opening-balances/${id}/reverse`,
      args: [{ params: Promise.resolve({ id }) }],
      body: { reason: 'Should never be allowed' },
      csrf: true,
    });
    expect(reversed.status).toBe(403);
  });

  it('refuses a record without the CSRF token', async () => {
    const school = await newSchool();
    const res = await call(recordPost as never, school.jar, {
      method: 'POST',
      path: '/api/opening-balances',
      body: {
        studentId: school.studentId,
        category: 'HISTORICAL_BALANCE',
        amountKobo: 45_000_000,
        asAt: AS_AT,
        sourceNote: 'No CSRF token on this one',
      },
    });
    expect(res.status).toBe(403);
  });

  it('does not let a school touch another school’s figure', async () => {
    const a = await newSchool();
    const b = await newSchool();
    const idInA = await recorded(a);

    const read = await call(listGet as never, b.jar, {
      method: 'GET',
      path: '/api/opening-balances',
    });
    expect(read.status).toBe(200);
    expect(read.data.rows.length).toBe(0);
    expect(read.data.summary.count).toBe(0);

    const stolen = await review(b, idInA, { decision: 'APPROVE' });
    expect(stolen.status).toBe(404);
    const stolenPost = await post(b, idInA);
    expect(stolenPost.status).toBe(404);
    // And school A's row is exactly as it was.
    await getSql()`SELECT set_tenant_context(${a.ctx.organizationId}::uuid, ${a.ctx.userId}::uuid)`;
    const after = await call(listGet as never, a.jar, {
      method: 'GET',
      path: '/api/opening-balances',
    });
    expect(after.data.rows[0].status).toBe('DRAFT');
  });

  it('refuses to record against a child from another school', async () => {
    const a = await newSchool();
    const b = await newSchool();
    const res = await record(b, { studentId: a.studentId, sourceNote: 'Someone else’s child' });
    expect(res.status).toBe(400);
    expect(res.data.error.message).toMatch(/not in this school/i);
  });

  // ── Recording ───────────────────────────────────────────────────────────

  it('records a figure and writes no invoice, no charge, nothing', async () => {
    const school = await newSchool();
    const before = await invoiceCount(school.ctx);
    const res = await record(school);
    expect(res.status, JSON.stringify(res.data)).toBe(201);
    expect(res.data.openingBalance.status).toBe('DRAFT');
    expect(res.data.openingBalance.amountKobo).toBe(45_000_000);
    expect(res.data.openingBalance.signedAmountKobo).toBe(45_000_000);
    expect(res.data.note).toMatch(/approved/i);
    expect(await invoiceCount(school.ctx)).toBe(before);
  });

  it('derives a credit as a negative effect and keeps the magnitude positive', async () => {
    const school = await newSchool();
    const res = await record(school, {
      category: 'CREDIT_OVERPAYMENT',
      amountKobo: 25_000_000,
      sourceNote: 'Paid twice in March, per the bank statement',
    });
    expect(res.status).toBe(201);
    expect(res.data.openingBalance.amountKobo).toBe(25_000_000);
    expect(res.data.openingBalance.signedAmountKobo).toBe(-25_000_000);
  });

  it('answers a bad body with a sentence, in the field’s own words', async () => {
    const school = await newSchool();
    const noSource = await record(school, { sourceNote: 'x' });
    expect(noSource.status).toBe(400);
    expect(noSource.data.error.message).toMatch(/where this figure came from/i);

    const zero = await record(school, { amountKobo: 0 });
    expect(zero.status).toBe(400);
    expect(zero.data.error.message).toMatch(/above zero|whole number/i);

    const fraction = await record(school, { amountKobo: 45_000.5 });
    expect(fraction.status).toBe(400);

    const badDate = await record(school, { asAt: 'last December' });
    expect(badDate.status).toBe(400);

    const activeTerm = await record(school, {
      termId: school.activeTermId,
      sourceNote: 'Trying to book history on the live term',
    });
    expect(activeTerm.status).toBe(400);
    expect(activeTerm.data.error.message).toMatch(/current term/i);

    const unknownField = await call(recordPost as never, school.jar, {
      method: 'POST',
      path: '/api/opening-balances',
      csrf: true,
      body: {
        studentId: school.studentId,
        category: 'HISTORICAL_BALANCE',
        amountKobo: 1000,
        asAt: AS_AT,
        sourceNote: 'An unexpected field must be refused',
        totalFudge: 42,
      },
    });
    expect(unknownField.status).toBe(400);
  });

  it('honours an Idempotency-Key on recording, so a double tap is one row', async () => {
    const school = await newSchool();
    const k = randomUUID();
    const first = await record(school, {}, { headers: { 'idempotency-key': k } });
    expect(first.status).toBe(201);
    const second = await record(school, {}, { headers: { 'idempotency-key': k } });
    expect(second.response.headers.get('idempotent-replayed')).toBe('true');
    expect(second.data.openingBalance.id).toBe(first.data.openingBalance.id);

    await getSql()`SELECT set_tenant_context(${school.ctx.organizationId}::uuid, ${school.ctx.userId}::uuid)`;
    const listed = await call(listGet as never, school.jar, {
      method: 'GET',
      path: '/api/opening-balances',
    });
    expect(listed.data.rows.length).toBe(1);
  });

  // ── Review ──────────────────────────────────────────────────────────────

  it('approves, and reports honestly that the reviewer was the recorder', async () => {
    const school = await newSchool();
    const id = await recorded(school);
    const res = await review(school, id, { decision: 'APPROVE', note: 'Checked against the file' });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data.openingBalance.status).toBe('APPROVED');
    expect(res.data.openingBalance.selfReviewed).toBe(true);
  });

  it('requires a reason to reject, and a JSON body at all', async () => {
    const school = await newSchool();
    const id = await recorded(school);
    const blank = await review(school, id, { decision: 'REJECT', note: '  ' });
    expect(blank.status).toBe(400);
    expect(blank.data.error.message).toMatch(/reason/i);

    const rejected = await review(school, id, {
      decision: 'REJECT',
      note: 'This is the wrong child',
    });
    expect(rejected.status).toBe(200);
    expect(rejected.data.openingBalance.status).toBe('REJECTED');
  });

  it('answers a review sent with no body instead of a bare 400 "Invalid request"', async () => {
    const school = await newSchool();
    const id = await recorded(school);
    const res = await call(reviewPost as never, school.jar, {
      method: 'POST',
      path: `/api/opening-balances/${id}/review`,
      args: [{ params: Promise.resolve({ id }) }],
      csrf: true,
    });
    expect(res.status).toBe(400);
    expect(res.data.error.message).toMatch(/decision/i);
  });

  // ── Posting ─────────────────────────────────────────────────────────────

  it('refuses to post before approval, and requires an Idempotency-Key when it is time', async () => {
    const school = await newSchool();
    const id = await recorded(school);

    const early = await post(school, id);
    expect(early.status).toBe(400);
    expect(early.data.error.message).toMatch(/approved/i);
    expect(await invoiceCount(school.ctx)).toBe(0);

    await review(school, id, { decision: 'APPROVE' });
    const noKey = await call(postPost as never, school.jar, {
      method: 'POST',
      path: `/api/opening-balances/${id}/post`,
      args: [{ params: Promise.resolve({ id }) }],
      body: {},
      csrf: true,
    });
    expect(noKey.status).toBe(400);
    expect(noKey.data.error.message).toMatch(/Idempotency-Key header is required/i);
    expect(await invoiceCount(school.ctx)).toBe(0);
  });

  it('posts to the prior term as a real invoice, and the read model reports it', async () => {
    const school = await newSchool();
    const id = await recorded(school);
    await review(school, id, { decision: 'APPROVE' });

    const res = await post(school, id);
    expect(res.status, JSON.stringify(res.data)).toBe(201);
    expect(res.data.invoice.number).toMatch(/^INV-\d{4}-\d{6}$/);
    expect(res.data.invoice.totalKobo).toBe(45_000_000);
    expect(res.data.invoice.dueDate).toBe(AS_AT);
    expect(res.data.note).toMatch(/prior-term debt/i);
    expect(await invoiceCount(school.ctx)).toBe(1);

    const listed = await call(listGet as never, school.jar, {
      method: 'GET',
      path: '/api/opening-balances',
    });
    expect(listed.status).toBe(200);
    const row = listed.data.rows.find((r: { id: string }) => r.id === id);
    expect(row.status).toBe('POSTED');
    expect(row.outstandingKobo).toBe(45_000_000);
    expect(row.postedInvoiceNumber).toBe(res.data.invoice.number);
    expect(listed.data.summary.postedKobo).toBe(45_000_000);
    expect(listed.data.summary.outstandingKobo).toBe(45_000_000);
    expect(listed.data.summary.collectedAgainstCarryInKobo).toBe(0);
    // The register tells the school which term it may still carry in from.
    expect(listed.data.priorTerms.map((t: { id: string }) => t.id)).toContain(school.priorTermId);
    expect(listed.data.currentTerm.id).toBe(school.activeTermId);
  });

  it('replays a posted request without minting a second invoice', async () => {
    const school = await newSchool();
    const id = await recorded(school);
    await review(school, id, { decision: 'APPROVE' });
    const k = randomUUID();
    const first = await post(school, id, { headers: { 'idempotency-key': k } });
    expect(first.status).toBe(201);
    expect(await invoiceCount(school.ctx)).toBe(1);

    const again = await post(school, id, { headers: { 'idempotency-key': k } });
    expect(again.response.headers.get('idempotent-replayed')).toBe('true');
    expect(again.data.invoice.id).toBe(first.data.invoice.id);
    expect(await invoiceCount(school.ctx)).toBe(1);
  });

  it('refuses to charge the same child twice for the same past term, and leaves nothing behind', async () => {
    const school = await newSchool();
    const first = await recorded(school);
    await review(school, first, { decision: 'APPROVE' });
    expect((await post(school, first)).status).toBe(201);

    const second = await recorded(school, { sourceNote: 'Also in the class file' });
    await review(school, second, { decision: 'APPROVE' });
    const clash = await post(school, second);
    expect(clash.status).toBe(409);
    expect(clash.data.error.message).toMatch(/already has a posted opening balance/i);

    // The atomicity claim, at the surface: one invoice, and the second figure is
    // still an approved-but-unposted row rather than a phantom posting.
    expect(await invoiceCount(school.ctx)).toBe(1);
    const listed = await call(listGet as never, school.jar, {
      method: 'GET',
      path: '/api/opening-balances',
    });
    const rows = listed.data.rows as Array<{ id: string; status: string }>;
    expect(rows.find((r) => r.id === second)!.status).toBe('APPROVED');
    expect(listed.data.summary.postedKobo).toBe(45_000_000);
  });

  it('refuses to post a credit, and says what would have been corrupted', async () => {
    const school = await newSchool();
    const id = await recorded(school, {
      category: 'CREDIT_OVERPAYMENT',
      amountKobo: 20_000_000,
      sourceNote: 'Overpaid in error, to be refunded',
    });
    await review(school, id, { decision: 'APPROVE' });
    const res = await post(school, id);
    expect(res.status).toBe(400);
    expect(res.data.error.message).toMatch(/cannot be posted/i);
    expect(await invoiceCount(school.ctx)).toBe(0);

    const listed = await call(listGet as never, school.jar, {
      method: 'GET',
      path: '/api/opening-balances',
    });
    expect(listed.data.rows[0].postBlockedBecause).toMatch(
      /never received|no signed opening balance/i,
    );
  });

  it('reverses a posting that no money has touched, and keeps both records', async () => {
    const school = await newSchool();
    const id = await recorded(school);
    await review(school, id, { decision: 'APPROVE' });
    const posted = await post(school, id);
    expect(posted.status).toBe(201);

    const res = await reverse(school, id, { reason: 'The family settled this outside SCOLAIRA' });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data.openingBalance.status).toBe('REVERSED');

    const listed = await call(listGet as never, school.jar, {
      method: 'GET',
      path: '/api/opening-balances',
    });
    const row = listed.data.rows.find((r: { id: string }) => r.id === id);
    expect(row.status).toBe('REVERSED');
    expect(row.postedInvoiceStatus).toBe('VOID');
    expect(row.outstandingKobo).toBe(0);
    expect(listed.data.summary.outstandingKobo).toBe(0);
    // The invoice still exists — voided, not deleted.
    expect(await invoiceCount(school.ctx)).toBe(1);
  });

  it('requires a reason to reverse, and refuses to reverse something never posted', async () => {
    const school = await newSchool();
    const draft = await recorded(school);
    const noBody = await call(reversePost as never, school.jar, {
      method: 'POST',
      path: `/api/opening-balances/${draft}/reverse`,
      args: [{ params: Promise.resolve({ id: draft }) }],
      csrf: true,
    });
    expect(noBody.status).toBe(400);
    expect(noBody.data.error.message).toMatch(/reason/i);

    const tooEarly = await reverse(school, draft, { reason: 'Trying before approval' });
    expect(tooEarly.status).toBe(400);
    expect(tooEarly.data.error.message).toMatch(/only a posted opening balance/i);
  });

  // ── The read model ──────────────────────────────────────────────────────

  it('filters rows to one child while keeping the school totals school-wide', async () => {
    const school = await newSchool();
    const mine = await recorded(school, { sourceNote: 'From the old file, this child' });
    void mine;

    const filtered = await call(listGet as never, school.jar, {
      method: 'GET',
      path: `/api/opening-balances?studentId=${school.studentId}`,
    });
    expect(filtered.status).toBe(200);
    expect(filtered.data.rows.length).toBe(1);

    const unfiltered = await call(listGet as never, school.jar, {
      method: 'GET',
      path: '/api/opening-balances',
    });
    expect(unfiltered.data.summary.count).toBe(filtered.data.rows.length);

    const bogus = await call(listGet as never, school.jar, {
      method: 'GET',
      path: '/api/opening-balances?studentId=not-a-uuid',
    });
    expect(bogus.status).toBe(400);
  });

  it('exposes the four categories with their postability, so no surface guesses', async () => {
    const school = await newSchool();
    const res = await call(listGet as never, school.jar, {
      method: 'GET',
      path: '/api/opening-balances',
    });
    expect(res.status).toBe(200);
    expect(res.data.categories).toEqual([
      { value: 'CURRENT_TERM_UNBILLED', label: 'This term, not yet billed', postable: false },
      { value: 'HISTORICAL_BALANCE', label: 'Owed from before', postable: true },
      { value: 'CREDIT_OVERPAYMENT', label: 'Credit / overpayment', postable: false },
      { value: 'UNVERIFIED', label: 'Unverified', postable: false },
    ]);
    expect(res.data.summary.hasPriorTerm).toBe(true);
    expect(res.data.summary.hasCurrentTerm).toBe(true);
  });
});
