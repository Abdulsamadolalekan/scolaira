// @vitest-environment node
/**
 * R1 (C-3) — public (payment-link) authorization context.
 *
 * PRE-R1 DEFECT (proved live against the frozen tree)
 *   `auth_set_public_context(organization_id)` accepted an ORGANIZATION ID from
 *   the caller, set the public-context marker and the tenant GUCs at SESSION
 *   scope, and returned. With no bearer token at all:
 *
 *     SELECT auth_set_public_context('<orgB>');      -- "OK"
 *     SELECT count(*) FROM invoices;                 -- 1  (org B's invoice)
 *     SELECT auth_is_tenant_authorized();             -- true
 *
 *   The public marker was therefore a self-asserted tenant selector, and it was
 *   the marker — not the credential — that authorised the read.
 *
 * WHAT THIS SUITE PROVES NOW
 *   `withPublicScope(token)` resolves the bearer token in the database, which
 *   mints a proof bound to (token, organization, backend pid). Every public
 *   policy requires that proof. There is no code path that accepts a caller
 *   supplied organization id, and claiming the marker by hand authorizes
 *   nothing:
 *
 *     forged marker + forged org + real token + no proof  -> 0 rows
 *     revoked/expired/malformed token                     -> 28000, fail closed
 *     valid token                                         -> only that link's org
 *     valid token while naming another org                -> rejected
 *     tenant session trying to mint a public context      -> no effect
 *     authenticated session tokens                        -> cannot be forged
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { testSql } from '../setup-db';
import { withScopedDb, withPublicScope, probePublicLinkStatus, isPublicLinkUnusable } from '@/lib/db/tenant';
import { seedTwoOrgs, type SeededIds } from '../support/seed';
import * as invoicesRepo from '@/lib/db/repo/invoices';
import * as invoiceLinesRepo from '@/lib/db/repo/invoice-lines';
import * as paymentLinksRepo from '@/lib/db/repo/payment-links';
import { kobo } from '@/lib/money';
import type { TenantCtx, UUID } from '@/lib/db/repo/_context';

const FIXTURE_URL =
  process.env.DATABASE_URL ?? 'postgresql://scolaira_app:scolaira_app_pw@localhost:5432/scolaira_test';
const fixturePool = postgres(FIXTURE_URL, { max: 3 });

interface OrgFixture {
  org: UUID;
  user: UUID;
  student: UUID;
  invoice: UUID;
  link: string;
  revokedLink: string;
  expiredLink: string;
}

let ids: SeededIds;
let A: OrgFixture;
let B: OrgFixture;

async function seedLinkOrg(
  org: UUID,
  user: UUID,
  session: UUID,
  term: UUID,
  student: UUID,
  label: string,
): Promise<OrgFixture> {
  return withScopedDb(
    { kind: 'tenant', organizationId: org, userId: user },
    async (db, sql) => {
      const ctx: TenantCtx = { organizationId: org, userId: user };
      const draft = await invoicesRepo.createDraft(db as any, ctx, {
        studentId: student,
        termId: term,
        sessionId: session,
      });
      await invoiceLinesRepo.addLines(db as any, ctx, draft.id, [
        { description: 'Tuition', quantity: 1, unitRateKobo: kobo(1_000_000), amountKobo: kobo(1_000_000) },
      ]);
      const issued = await invoicesRepo.issue(db as any, ctx, draft.id);

      const token = `r1-pub-${label}-${randomUUID().slice(0, 10)}`;
      await paymentLinksRepo.create(db as any, ctx, {
        token,
        invoiceId: issued.id,
        amountKobo: kobo(1_000_000),
        note: `R1 ${label} link`,
      });

      const revokedToken = `r1-pub-rev-${label}-${randomUUID().slice(0, 8)}`;
      const revoked = await paymentLinksRepo.create(db as any, ctx, {
        token: revokedToken,
        invoiceId: issued.id,
        amountKobo: kobo(1_000_000),
      });
      await sql`UPDATE payment_links SET status = 'REVOKED', revoked_at = now(), revoked_by = ${user}::uuid
                 WHERE id = ${(revoked as any).id}::uuid`;

      const expiredToken = `r1-pub-exp-${label}-${randomUUID().slice(0, 8)}`;
      await paymentLinksRepo.create(db as any, ctx, {
        token: expiredToken,
        invoiceId: issued.id,
        amountKobo: kobo(1_000_000),
        expiresAt: new Date(Date.now() - 86_400_000),
      });

      return {
        org,
        user,
        student,
        invoice: issued.id as UUID,
        link: token,
        revokedLink: revokedToken,
        expiredLink: expiredToken,
      };
    },
    { client: fixturePool },
  );
}

/** Statements as an unauthenticated runtime connection (no scope, no context). */
function neutral<T>(fn: (sql: any) => Promise<T>): Promise<T> {
  return withScopedDb({ kind: 'none' }, async (_db, sql) => fn(sql));
}

async function attempt<T>(
  tag: string,
  fn: (sql: any) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; code?: string; message?: string }> {
  const sql = testSql();
  const name = `r1c3_${tag}_${Math.random().toString(36).slice(2, 8)}`;
  await sql.unsafe(`SAVEPOINT ${name}`);
  try {
    const value = await fn(sql);
    await sql.unsafe(`ROLLBACK TO SAVEPOINT ${name}`);
    await sql.unsafe(`RELEASE SAVEPOINT ${name}`);
    return { ok: true, value };
  } catch (error: any) {
    await sql.unsafe(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => {});
    await sql.unsafe(`RELEASE SAVEPOINT ${name}`).catch(() => {});
    return {
      ok: false,
      code: error?.code ?? error?.cause?.code,
      message: error?.message ?? error?.cause?.message,
    };
  }
}

/** Count the payments a legitimate tenant session can see (tenant scope). */
async function countInOrg(org: UUID): Promise<number> {
  const fx = org === A.org ? A : B;
  return withScopedDb({ kind: 'tenant', organizationId: fx.org, userId: fx.user }, async (_db, sql) => {
    const rows = (await sql.unsafe(`SELECT count(*)::int AS n FROM payments`)) as any[];
    return Number(rows[0].n);
  });
}

beforeAll(async () => {
  ids = await withScopedDb({ kind: 'system' }, async (_db, sql) => seedTwoOrgs(sql as any), {
    client: fixturePool,
  });
  A = await seedLinkOrg(ids.orgId, ids.aliceId, ids.sessionId, ids.termId, ids.studentAId, 'a');
  B = await seedLinkOrg(ids.orgBId, ids.bobId, ids.sessionBId, ids.termBId, ids.studentBId, 'b');
}, 180_000);

afterAll(async () => {
  await fixturePool.end({ timeout: 5 });
});

describe('R1 C-3 — the public marker is not a tenant selector', () => {
  it('an unauthenticated connection sees no tenant data at all', async () => {
    const counts = await neutral(async (sql) => {
      const rows = (await sql.unsafe(
        `SELECT (SELECT count(*)::int FROM invoices) AS invoices,
                (SELECT count(*)::int FROM payments) AS payments,
                (SELECT count(*)::int FROM students) AS students`,
      )) as any[];
      return rows[0];
    });
    expect(counts).toEqual({ invoices: 0, payments: 0, students: 0 });
  });

  it('forging the marker + organization + a REAL token is not enough (no proof)', async () => {
    const result = await neutral(async (sql) => {
      await sql.unsafe(
        `SELECT set_config('app.public_context', '1', true),
                set_config('app.organization_id', $1, true),
                set_config('app.public_link_token', $2, true),
                set_config('app.public_proof', 'forged-proof', true),
                set_config('app.is_platform_admin', '0', true)`,
        [B.org, B.link],
      );
      const rows = (await sql.unsafe(
        `SELECT (SELECT count(*)::int FROM invoices) AS invoices,
                (SELECT count(*)::int FROM students) AS students,
                auth_is_public_context_authorized() AS authorized`,
      )) as any[];
      return rows[0];
    });
    expect(result.invoices).toBe(0);
    expect(result.students).toBe(0);
    expect(result.authorized).toBe(false);
  });

  it('the self-asserted entry point is not callable by the runtime role', async () => {
    const calls: Array<[string, string, unknown[]]> = [
      ['auth_set_public_context', 'SELECT auth_set_public_context($1::uuid)', [B.org]],
      ['auth_set_public_link_token', 'SELECT auth_set_public_link_token($1::text)', [B.link]],
      ['auth_public_proof_for', 'SELECT auth_public_proof_for($1::text, $2::uuid)', [B.link, B.org]],
    ];
    for (const [fn, text, params] of calls) {
      const outcome = await neutral(async () => attempt(fn, (s) => s.unsafe(text, params)));
      expect(outcome.ok, `${fn} was callable as the runtime role`).toBe(false);
      // 42501 = insufficient_privilege (EXECUTE revoked from the runtime role).
      expect((outcome as any).code, `${fn} rejected with an unexpected SQLSTATE`).toBe('42501');
    }
  });

  it('a tenant session cannot mint public context for another organization', async () => {
    const result = await withScopedDb({ kind: 'tenant', organizationId: A.org, userId: A.user }, async (_db, sql) => {
      const before = (await sql.unsafe(
        `SELECT count(*)::int AS n FROM invoices WHERE organization_id = $1::uuid`,
        [B.org],
      )) as any[];
      // Every lever an application-level attacker has WITHOUT possessing the
      // other tenant's bearer token: claim the marker, claim the organization,
      // synthesize a proof.
      await sql.unsafe(
        `SELECT set_config('app.public_context', '1', true),
                set_config('app.organization_id', $1, true),
                set_config('app.public_proof', 'forged-proof', true)`,
        [B.org],
      );
      const after = (await sql.unsafe(
        `SELECT (SELECT count(*)::int FROM invoices WHERE organization_id = $1::uuid) AS foreign_rows,
                (SELECT count(*)::int FROM invoices WHERE organization_id = $2::uuid) AS own_rows,
                auth_is_public_context_authorized() AS public_ok,
                auth_is_tenant_authorized() AS tenant_ok`,
        [B.org, A.org],
      )) as Array<{ foreign_rows: number; own_rows: number; public_ok: boolean; tenant_ok: boolean }>;
      return { before: Number(before[0].n), after: after[0]! };
    });
    // The other tenant stays invisible before AND after the forgery, the
    // forged marker never becomes an authorized public context, and the tenant
    // authorization that the forgery destroyed is not replaced by anything.
    expect(result.before).toBe(0);
    expect(Number(result.after.foreign_rows)).toBe(0);
    expect(result.after.public_ok).toBe(false);
    expect(result.after.tenant_ok).toBe(false);
    expect(Number(result.after.own_rows)).toBe(0);
  });
});

describe('R1 C-3 — a valid bearer token authorises exactly its own link', () => {
  it('the link owner sees its own organization', async () => {
    const seen = await withPublicScope(A.link, async (_db, sql) => {
      const rows = (await sql.unsafe(
        `SELECT (SELECT count(*)::int FROM invoices) AS invoices,
                (SELECT count(*)::int FROM students) AS students,
                (SELECT count(*)::int FROM invoices WHERE organization_id = $1::uuid) AS foreign_invoices,
                (SELECT count(*)::int FROM students WHERE organization_id = $1::uuid) AS foreign_students,
                auth_is_public_context_authorized() AS authorized`,
        [B.org],
      )) as any[];
      return rows[0];
    });
    expect(seen.authorized).toBe(true);
    expect(Number(seen.invoices)).toBeGreaterThan(0);
    expect(Number(seen.students)).toBeGreaterThan(0);
    // ...and nothing from the other tenant.
    expect(Number(seen.foreign_invoices)).toBe(0);
    expect(Number(seen.foreign_students)).toBe(0);
  });

  it('a public token cannot read another tenant\'s rows by naming them', async () => {
    const result = await withPublicScope(A.link, async (_db, sql) => {
      const byId = (await sql.unsafe(`SELECT count(*)::int AS n FROM invoices WHERE id = $1::uuid`, [B.invoice])) as any[];
      const students = (await sql.unsafe(`SELECT count(*)::int AS n FROM students WHERE id = $1::uuid`, [B.student])) as any[];
      const links = (await sql.unsafe(`SELECT count(*)::int AS n FROM payment_links WHERE token = $1`, [B.link])) as any[];
      return { byId: Number(byId[0].n), students: Number(students[0].n), links: Number(links[0].n) };
    });
    expect(result.byId).toBe(0);
    expect(result.students).toBe(0);
    expect(result.links).toBe(0);
  });

  it('a public token cannot write financial truth or escalate to a tenant', async () => {
    const beforeB = await countInOrg(B.org);
    const outcome = await withPublicScope(A.link, async () => ({
      // Writes that would create authoritative money: the policy WITH CHECK
      // must reject them outright.
      confirmed: await attempt('confirmed', (s) =>
        s.unsafe(
          `INSERT INTO payments (organization_id, payment_number, method, status, amount_kobo, unallocated_kobo)
           VALUES ($1::uuid, $2, 'CASH', 'CONFIRMED', 100, 100)`,
          [A.org, `R1-CONF-${randomUUID().slice(0, 8)}`],
        ),
      ),
      foreignPending: await attempt('foreign', (s) =>
        s.unsafe(
          `INSERT INTO payments (organization_id, payment_number, method, status, amount_kobo, unallocated_kobo)
           VALUES ($1::uuid, $2, 'CASH', 'PENDING', 100, 100)`,
          [B.org, `R1-FOR-${randomUUID().slice(0, 8)}`],
        ),
      ),
      // Writes without a policy for public traffic affect NO rows (row
      // security filters them out rather than raising), which is equally
      // fail-closed — so they are judged on affected rows.
      invoiceUpdate: await attempt('upd', (s) =>
        s.unsafe(`UPDATE invoices SET paid_kobo = paid_kobo WHERE invoice_number IS NOT NULL RETURNING id`),
      ),
      linkUpdate: await attempt('linkupd', (s) =>
        s.unsafe(`UPDATE payment_links SET status = 'ACTIVE' WHERE token IS NOT NULL RETURNING id`),
      ),
      studentUpdate: await attempt('stuupd', (s) =>
        s.unsafe(`UPDATE students SET last_name = last_name WHERE student_id IS NOT NULL RETURNING id`),
      ),
      // Reads of internal ledgers: zero rows visible.
      readAudit: await attempt('audit', (s) => s.unsafe(`SELECT count(*)::int AS n FROM audit_events`)),
      readAllocations: await attempt('alloc', (s) => s.unsafe(`SELECT count(*)::int AS n FROM payment_allocations`)),
      readPayments: await attempt('pays', (s) => s.unsafe(`SELECT count(*)::int AS n FROM payments`)),
      readReceipts: await attempt('recs', (s) => s.unsafe(`SELECT count(*)::int AS n FROM receipts`)),
      readLinks: await attempt('links', (s) => s.unsafe(`SELECT count(*)::int AS n FROM payment_links`)),
    }));

    console.log('R1PUB', JSON.stringify({
      confirmed: outcome.confirmed, foreignPending: outcome.foreignPending,
      invoiceUpdate: Array.isArray((outcome.invoiceUpdate as any).value) ? (outcome.invoiceUpdate as any).value.length : (outcome.invoiceUpdate as any).code,
      linkUpdate: Array.isArray((outcome.linkUpdate as any).value) ? (outcome.linkUpdate as any).value.length : (outcome.linkUpdate as any).code,
      studentUpdate: Array.isArray((outcome.studentUpdate as any).value) ? (outcome.studentUpdate as any).value.length : (outcome.studentUpdate as any).code,
    }));
    // Confirmed money cannot be created through the public surface.
    expect(outcome.confirmed.ok).toBe(false);
    // An attempt to name ANOTHER tenant cannot land there: the tenant of a row
    // is decided by the binding trigger from the authorized context, never by
    // the caller's column value. So the only acceptable outcomes are
    // "rejected" or "written into the link's own tenant" — never into org B.
    expect(await countInOrg(B.org)).toBe(beforeB);
    // Public context cannot mutate invoices, links or students.
    for (const key of ['invoiceUpdate', 'linkUpdate', 'studentUpdate'] as const) {
      const result = outcome[key] as { ok: true; value: unknown[] } | { ok: false };
      if (result.ok) {
        expect((result.value as unknown[]).length, `${key} mutated rows`).toBe(0);
      }
    }
    // ...nor read the internal ledger.
    for (const key of ['readAudit', 'readAllocations', 'readPayments', 'readReceipts', 'readLinks'] as const) {
      const result = outcome[key] as { ok: true; value: Array<{ n: number }> } | { ok: false };
      if (result.ok) {
        expect(Number(result.value[0]?.n), `${key} exposed rows`).toBe(0);
      }
    }
  });

  it('the sanctioned entry point records the PENDING submission and returns its identifiers', async () => {
    const outcome = await withPublicScope(A.link, async (_db, sql) => {
      const before = (await sql.unsafe(`select count(*)::int as n from payments`)) as any[];
      // R3 (H-3): the amount recorded is the database's authoritative amount
      // due for this link (`auth_public_amount_due`), and the caller's claim
      // must agree with it. The claim here IS that derived value, which is the
      // normal production case (the form sends no amount at all).
      const rows = (await sql.unsafe(
        `select payment_id, payment_number, amount_kobo, status
           from auth_public_submit_payment($1, $2, auth_public_amount_due($1), $3, 'Parent Payer', $4, $5)`,
        [
          A.link,
          `r1-ctx-${randomUUID().slice(0, 8)}`,
          `R1REF-${randomUUID().slice(0, 8)}`,
          null,
          null,
        ],
      )) as any[];
      const after = (await sql.unsafe(`select count(*)::int as n from payments`)) as any[];
      return { before: Number(before[0].n), row: rows[0], after: Number(after[0].n) };
    });

    expect(outcome.row?.payment_number).toMatch(/^PMT-\d{4}-\d{6}$/);
    expect(Number(outcome.row?.amount_kobo)).toBe(1_000_000);
    expect(outcome.row?.status).toBe('PENDING');
    // Public context could not read the ledger before or after the write —
    // that is the point of the entry point returning the identifiers.
    expect(outcome.before).toBe(0);
    expect(outcome.after).toBe(0);

    // A legitimate tenant session of the link's organization sees exactly the
    // row the entry point reported, in PENDING state, with no unallocated
    // balance (authoritative money is created by the bursar, not by a link).
    const stored = await withScopedDb(
      { kind: 'tenant', organizationId: A.org, userId: A.user },
      async (_db, sql) => {
        const rows = (await sql.unsafe(
          `SELECT status::text AS status, amount_kobo, unallocated_kobo, organization_id
             FROM payments WHERE payment_number = $1`,
          [outcome.row!.payment_number],
        )) as any[];
        return rows[0];
      },
    );
    expect(stored?.status).toBe('PENDING');
    expect(Number(stored?.amount_kobo)).toBe(1_000_000);
    expect(Number(stored?.unallocated_kobo)).toBe(0);
    expect(stored?.organization_id).toBe(A.org);

    // The submission is audited against the link's tenant.
    const audited = await withScopedDb(
      { kind: 'tenant', organizationId: A.org, userId: A.user },
      async (_db, sql) => {
        const rows = (await sql.unsafe(
          `SELECT count(*)::int AS n FROM audit_events
            WHERE action = 'payment.pending' AND entity_id = $1::uuid AND organization_id = $2::uuid`,
          [outcome.row!.payment_id, A.org],
        )) as any[];
        return Number(rows[0].n);
      },
    );
    expect(audited).toBe(1);
  });

  it('public context has no direct write privilege, and no RETURNING read-back', async () => {
    const outcome = await withPublicScope(A.link, async () => ({
      // A bare INSERT is still authorized by the proof-gated policy…
      plainInsert: await attempt('plain', (s) =>
        s.unsafe(
          `INSERT INTO payments (organization_id, method, status, amount_kobo, reference, payer_name)
           VALUES ($1::uuid, 'CASH', 'PENDING', 1000, $2, 'X')`,
          [A.org, `R1-PLAIN-${randomUUID().slice(0, 8)}`],
        ),
      ),
      // …but reading anything back out of the ledger the same way is refused,
      // which is exactly why the submission goes through the entry point.
      returningInsert: await attempt('returning', (s) =>
        s.unsafe(
          `INSERT INTO payments (organization_id, method, status, amount_kobo, reference, payer_name)
           VALUES ($1::uuid, 'CASH', 'PENDING', 1000, $2, 'X') RETURNING id`,
          [A.org, `R1-RET-${randomUUID().slice(0, 8)}`],
        ),
      ),
      directSelect: await attempt('select', (s) => s.unsafe(`SELECT count(*)::int AS n FROM payments`)),
    }));
    // R3 (H-3) — STRENGTHENED. Before R3 this bare INSERT was authorized
    // (0012's proof-gated `payments_public_insert`/`payments_public_insert2`
    // policies applied to every role), which meant a public bearer could write
    // to the ledger without an amount binding, without bounds, without an audit
    // row and without idempotency. 0046 narrowed those policies to the owner
    // role, so public context — the runtime role — has no write path at all.
    expect(outcome.plainInsert.ok).toBe(false);
    expect(outcome.returningInsert.ok).toBe(false);
    const read = outcome.directSelect as { ok: true; value: Array<{ n: number }> };
    expect(Number(read.value[0]!.n)).toBe(0);
  });

  it('the entry point derives the organization from the token, not from the caller', async () => {
    // There is no organization parameter to attack. What matters is that the
    // payment lands in the LINK's tenant and that org B is untouched.
    const before = await countInOrg(B.org);
    const created = await withPublicScope(A.link, async (_db, sql) => {
      const rows = (await sql.unsafe(
        `select payment_id from auth_public_submit_payment($1, $2, auth_public_amount_due($1), $3, 'Parent Payer')`,
        [A.link, `r1-org-${randomUUID().slice(0, 8)}`, `R1-ORG-${randomUUID().slice(0, 8)}`],
      )) as any[];
      return rows[0]?.payment_id as string;
    });
    expect(created).toBeTruthy();
    expect(await countInOrg(B.org)).toBe(before);

    const inLinkOrg = await withScopedDb(
      { kind: 'tenant', organizationId: A.org, userId: A.user },
      async (_db, sql) => {
        const rows = (await sql.unsafe(`SELECT count(*)::int AS n FROM payments WHERE id = $1::uuid AND organization_id = $2::uuid`, [
          created,
          A.org,
        ])) as any[];
        return Number(rows[0].n);
      },
    );
    expect(inLinkOrg).toBe(1);
  });

  it('the entry point refuses unusable bearers with 28000', async () => {
    for (const token of [A.revokedLink, A.expiredLink, 'no-such-token-000', '']) {
      const outcome = await neutral(async () =>
        attempt('entry', (s) =>
          s.unsafe(`select * from auth_public_submit_payment($1, $2, 100, 'R', 'P')`, [
            token,
            `r1-unusable-${randomUUID().slice(0, 8)}`,
          ]),
        ),
      );
      expect(outcome.ok, `entry point accepted a bearer it must refuse: ${token}`).toBe(false);
      expect((outcome as any).code).toBe('28000');
    }
  });

});

describe('R1 C-3 — unusable tokens fail closed', () => {
  it.each([
    ['revoked', 'revokedLink'],
    ['expired', 'expiredLink'],
  ] as const)('a %s token cannot establish any context (28000)', async (_label, key) => {
    const token = A[key];
    let failure: any;
    try {
      await withPublicScope(token, async () => 'reached');
    } catch (error) {
      failure = error;
    }
    expect(failure, `withPublicScope(${key}) unexpectedly succeeded`).toBeTruthy();
    expect(isPublicLinkUnusable(failure)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['unknown', 'no-such-token-000'],
    ['malformed', "' OR 1=1 --"],
    ['oversized', 'x'.repeat(600)],
    ['whitespace', '   '],
  ])('a %s token cannot establish any context', async (_label, token) => {
    let failure: any;
    try {
      await withPublicScope(token, async () => 'reached');
    } catch (error) {
      failure = error;
    }
    expect(failure, `withPublicScope(${_label}) unexpectedly succeeded`).toBeTruthy();
    expect(isPublicLinkUnusable(failure) || failure?.code === '22P02').toBe(true);
  });

  it('the token status probe distinguishes missing / revoked / expired / live', async () => {
    expect(await probePublicLinkStatus(A.link)).toBe('ACTIVE');
    expect(await probePublicLinkStatus(A.revokedLink)).toBe('REVOKED');
    expect(await probePublicLinkStatus(A.expiredLink)).toBe('EXPIRED');
    expect(await probePublicLinkStatus('no-such-token-000')).toBe('MISSING');
  });

  it('a revoked or expired token cannot be replayed after re-issue of a fresh one', async () => {
    // Replay: the same bearer used again after revocation must stay unusable,
    // and the freshly issued link must work — proving the decision follows the
    // credential, not a cached/ambient context.
    const fresh = await withScopedDb({ kind: 'tenant', organizationId: A.org, userId: A.user }, async (_db, sql) => {
      const token = `r1-pub-fresh-${randomUUID().slice(0, 10)}`;
      await paymentLinksRepo.create(_db as any, { organizationId: A.org, userId: A.user }, {
        token,
        invoiceId: A.invoice,
        amountKobo: kobo(100_000),
      });
      void sql;
      return token;
    });

    expect(isPublicLinkUnusable(await withPublicScope(A.revokedLink, async () => null).catch((e) => e))).toBe(true);
    const seen = await withPublicScope(fresh, async (_db, sql) => {
      const rows = (await sql.unsafe(`SELECT count(*)::int AS n FROM invoices WHERE organization_id = $1::uuid`, [A.org])) as any[];
      return Number(rows[0].n);
    });
    expect(seen).toBeGreaterThan(0);
  });
});
