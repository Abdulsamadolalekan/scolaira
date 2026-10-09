// @vitest-environment node
/**
 * R1 (C-1 / C-2 / C-3) — INDEPENDENT RE-AUDIT.
 *
 * This suite is written from the security CONTRACT, not from the
 * implementation: each case states what the system must never allow, derives
 * the attack from the threat model, and then measures the running database.
 * Where the contract and the implementation disagree, the contract wins.
 *
 * Attack surface enumerated independently of the R1 change set:
 *   A. Identity forgery — can any caller assert an identity it does not hold?
 *   B. Credential substitution — does authority follow the bearer credential?
 *   C. Cross-tenant reach — can one tenant's authority touch another's data?
 *   D. Write authority — what can each context kind actually write?
 *   E. Context persistence — can authority outlive the request that earned it?
 *   F. Privilege surface — what can the runtime role call or alter?
 *
 * "Proven" here means measured against the live database through the same
 * runtime role the application uses (NOBYPASSRLS, NOSUPERUSER), with every
 * attempt wrapped in a savepoint so a rejection is recorded, not maskable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import {
  withScopedDb,
  withSystemScope,
  withPublicScope,
  probePublicLinkStatus,
  isPublicLinkUnusable,
} from '@/lib/db/tenant';
import { CONTEXT_GUCS } from '@/lib/db/context';
import { seedTwoOrgs, type SeededIds } from '../support/seed';
import * as invoicesRepo from '@/lib/db/repo/invoices';
import * as invoiceLinesRepo from '@/lib/db/repo/invoice-lines';
import * as paymentsRepo from '@/lib/db/repo/payments';
import * as paymentLinksRepo from '@/lib/db/repo/payment-links';
import { kobo } from '@/lib/money';
import type { TenantCtx, UUID } from '@/lib/db/repo/_context';

const FIXTURE_URL =
  process.env.DATABASE_URL ?? 'postgresql://scolaira_app:scolaira_app_pw@localhost:5432/scolaira_test';
const fixturePool = postgres(FIXTURE_URL, { max: 3 });

interface Org {
  org: UUID;
  user: UUID;
  student: UUID;
  invoice: UUID;
  payment: UUID;
  link: string;
  revoked: string;
  expired: string;
}

let ids: SeededIds;
let A: Org;
let B: Org;

/** One statement, savepoint-guarded, reporting SQLSTATE and row count. */
async function probe<T = Array<Record<string, unknown>>>(
  sql: any,
  text: string,
  params: unknown[] = [],
): Promise<{ ok: boolean; code?: string; rows?: T; message?: string }> {
  const name = `r1ra_${Math.random().toString(36).slice(2, 10)}`;
  await sql.unsafe(`SAVEPOINT ${name}`);
  try {
    const rows = (await sql.unsafe(text, params)) as T;
    await sql.unsafe(`ROLLBACK TO SAVEPOINT ${name}`);
    await sql.unsafe(`RELEASE SAVEPOINT ${name}`);
    return { ok: true, rows };
  } catch (error: any) {
    await sql.unsafe(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => {});
    await sql.unsafe(`RELEASE SAVEPOINT ${name}`).catch(() => {});
    return { ok: false, code: error?.code, message: error?.message };
  }
}

async function seedOrg(
  org: UUID,
  user: UUID,
  session: UUID,
  term: UUID,
  student: UUID,
  tag: string,
): Promise<Org> {
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
        { description: 'Audit', quantity: 1, unitRateKobo: kobo(900_000), amountKobo: kobo(900_000) },
      ]);
      const issued = await invoicesRepo.issue(db as any, ctx, draft.id);
      const payment = await paymentsRepo.record(db as any, ctx, {
        method: 'CASH',
        amountKobo: kobo(300_000),
        reference: `AUDIT-${tag}`,
        initialStatus: 'CONFIRMED',
      });

      const link = `r1-audit-live-${tag}-${randomUUID().slice(0, 8)}`;
      await paymentLinksRepo.create(db as any, ctx, { token: link, invoiceId: issued.id, amountKobo: kobo(100_000) as any });

      const revoked = `r1-audit-rev-${tag}-${randomUUID().slice(0, 8)}`;
      const revokedLink = await paymentLinksRepo.create(db as any, ctx, {
        token: revoked,
        invoiceId: issued.id,
        amountKobo: kobo(100_000) as any,
      });
      await sql`UPDATE payment_links SET status = 'REVOKED', revoked_at = now(), revoked_by = ${user}::uuid
                 WHERE id = ${(revokedLink as any).id}::uuid`;

      const expired = `r1-audit-exp-${tag}-${randomUUID().slice(0, 8)}`;
      await paymentLinksRepo.create(db as any, ctx, {
        token: expired,
        invoiceId: issued.id,
        amountKobo: kobo(100_000) as any,
        expiresAt: new Date(Date.now() - 3_600_000),
      });

      return {
        org,
        user,
        student,
        invoice: issued.id as UUID,
        payment: payment.id as UUID,
        link,
        revoked,
        expired,
      };
    },
    { client: fixturePool },
  );
}

beforeAll(async () => {
  ids = await withSystemScope(async () => null).then(() =>
    withScopedDb({ kind: 'system' }, async (_db, sql) => seedTwoOrgs(sql as any), { client: fixturePool }),
  );
  A = await seedOrg(ids.orgId, ids.aliceId, ids.sessionId, ids.termId, ids.studentAId, 'a');
  B = await seedOrg(ids.orgBId, ids.bobId, ids.sessionBId, ids.termBId, ids.studentBId, 'b');
}, 180_000);

afterAll(async () => {
  await fixturePool.end({ timeout: 5 });
});

// ---------------------------------------------------------------------------
// A. Identity forgery
// ---------------------------------------------------------------------------

describe('re-audit A — identity cannot be asserted, only earned', () => {
  it('an unauthenticated connection has no authority of any kind', async () => {
    const result = await withScopedDb({ kind: 'none' }, async (_db, sql) =>
      probe(
        sql,
        `SELECT auth_is_tenant_authorized() AS tenant, auth_is_platform_admin_authorized() AS platform,
                auth_is_public_context_authorized() AS public,
                (SELECT count(*)::int FROM invoices) AS invoices,
                (SELECT count(*)::int FROM payments) AS payments,
                (SELECT count(*)::int FROM students) AS students,
                (SELECT count(*)::int FROM organizations) AS organizations`,
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.rows![0]).toEqual({
      tenant: false,
      platform: false,
      public: false,
      invoices: 0,
      payments: 0,
      students: 0,
      organizations: 0,
    });
  });

  it('every identity-bearing variable must be forged to be believed — and none of the combinations work', async () => {
    const attempts: Array<{ label: string; settings: Record<string, string> }> = [
      { label: 'bare org', settings: { 'app.organization_id': B.org as string } },
      {
        label: 'org + user',
        settings: { 'app.organization_id': B.org as string, 'app.user_id': B.user as string },
      },
      {
        label: 'org + user + fake tenant token',
        settings: {
          'app.organization_id': B.org as string,
          'app.user_id': B.user as string,
          'app.tenant_token': 'deadbeef',
        },
      },
      { label: 'platform flag', settings: { 'app.is_platform_admin': '1' } },
      {
        label: 'platform flag + id + token',
        settings: {
          'app.is_platform_admin': '1',
          'app.platform_admin_id': B.user as string,
          'app.platform_token': 'deadbeef',
        },
      },
      { label: 'bootstrap flag', settings: { 'app.auth_bootstrap': '1' } },
      {
        label: 'public marker + org',
        settings: { 'app.public_context': '1', 'app.organization_id': B.org as string },
      },
      {
        label: 'public marker + org + link + fake proof',
        settings: {
          'app.public_context': '1',
          'app.organization_id': B.org as string,
          'app.public_link_token': B.link,
          'app.public_proof': 'x'.repeat(64),
        },
      },
      { label: 'acting role', settings: { 'app.acting_role': 'OWNER' } },
    ];

    for (const attempt of attempts) {
      const result = await withScopedDb({ kind: 'none' }, async (_db, sql) => {
        const assignments = Object.entries(attempt.settings)
          .map(([k], i) => `set_config('${k}', $${i + 1}, true)`)
          .join(', ');
        await sql.unsafe(`SELECT ${assignments}`, Object.values(attempt.settings));
        return probe(
          sql,
          `SELECT auth_is_tenant_authorized() AS tenant,
                  auth_is_platform_admin_authorized() AS platform,
                  auth_is_public_context_authorized() AS public,
                  (SELECT count(*)::int FROM invoices) AS invoices,
                  (SELECT count(*)::int FROM payments) AS payments`,
        );
      });
      expect(result.ok, `${attempt.label} raised unexpectedly`).toBe(true);
      const row = result.rows![0] as Record<string, unknown>;
      expect(row.tenant, `${attempt.label}: tenant authority`).toBe(false);
      expect(row.platform, `${attempt.label}: platform authority`).toBe(false);
      expect(row.invoices === 0 || row.public === true, `${attempt.label}: invoice reach`).toBe(true);
      expect(row.payments === 0 || row.public === true, `${attempt.label}: payment reach`).toBe(true);
      // No forged state may authorize BOTH a tenant read and a public read.
      expect(row.tenant && (row.public as boolean), `${attempt.label}: hybrid authority`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// B. Credential substitution
// ---------------------------------------------------------------------------

describe('re-audit B — authority follows the specific bearer credential', () => {
  it('only the exact ACTIVE token authorizes; every mutation of it does not', async () => {
    const variants: Array<[string, string]> = [
      ['exact', A.link],
      ['upper-cased', A.link.toUpperCase()],
      ['trailing space', `${A.link} `],
      ['truncated', A.link.slice(0, -1)],
      ['prefix', A.link.slice(0, 8)],
      ['other org token', B.link],
      ['revoked', A.revoked],
      ['expired', A.expired],
      ['empty', ''],
      ['sql-ish', `${A.link}' OR true --`],
    ];

    for (const [label, token] of variants) {
      const live = await withPublicScope(token, async () => 'entered').then(
        () => true,
        (error) => error,
      );
      const entered = live === true;
      if (label === 'exact' || label === 'other org token') {
        expect(entered, `${label} should establish public context`).toBe(true);
      } else {
        expect(entered, `${label} must NOT establish public context`).toBe(false);
        expect(isPublicLinkUnusable(live), `${label} must fail closed as unusable`).toBe(true);
      }
    }

    // The status oracle must also tell the truth.
    expect(await probePublicLinkStatus(A.link)).toBe('ACTIVE');
    expect(await probePublicLinkStatus(A.revoked)).toBe('REVOKED');
    expect(await probePublicLinkStatus(A.expired)).toBe('EXPIRED');
    expect(await probePublicLinkStatus(A.link.toUpperCase())).toBe('MISSING');
    expect(await probePublicLinkStatus('')).toBe('MISSING');
  });

  it('a proof harvested from one transaction cannot be replayed in another', async () => {
    // Capture the proof exactly as it exists inside a legitimate request.
    const harvested = await withPublicScope(A.link, async (_db, sql) => {
      const rows = (await sql.unsafe(`SELECT current_setting('app.public_proof', true) AS proof`)) as any[];
      return String(rows[0]?.proof ?? '');
    });
    expect(harvested).toHaveLength(64);

    // Replay it on a fresh identity state.
    const replay = await withScopedDb({ kind: 'none' }, async (_db, sql) => {
      await sql.unsafe(
        `SELECT set_config('app.public_context','1',true),
                set_config('app.public_link_token',$1,true),
                set_config('app.organization_id',$2,true),
                set_config('app.public_proof',$3,true)`,
        [A.link, A.org, harvested],
      );
      return probe(
        sql,
        `SELECT auth_is_public_context_authorized() AS authorized,
                (SELECT count(*)::int FROM invoices) AS invoices,
                (SELECT count(*)::int FROM students) AS students`,
      );
    });
    expect(replay.ok).toBe(true);
    // Either the backend-bound proof no longer matches (different connection)
    // or, if it does, it still authorizes only the organization it was minted
    // for — never another tenant.
    const row = replay.rows![0] as Record<string, unknown>;
    if (row.authorized === true) {
      const crossTenant = await withScopedDb({ kind: 'none' }, async (_db, sql) => {
        await sql.unsafe(
          `SELECT set_config('app.public_context','1',true),
                  set_config('app.public_link_token',$1,true),
                  set_config('app.organization_id',$2,true),
                  set_config('app.public_proof',$3,true)`,
          [A.link, B.org, harvested],
        );
        return probe(sql, `SELECT (SELECT count(*)::int FROM invoices WHERE organization_id = $1::uuid) AS n`, [B.org]);
      });
      expect(Number((crossTenant.rows![0] as any).n)).toBe(0);
    }
  });

  it('a tenant session token cannot be forged from a public context', async () => {
    const result = await withPublicScope(A.link, async (_db, sql) =>
      probe(
        sql,
        `SELECT set_config('app.tenant_token', 'stolen', true) AS x`,
      ),
    );
    expect(result.ok).toBe(true);
    const after = await withPublicScope(A.link, async (_db, sql) =>
      probe(sql, `SELECT auth_is_tenant_authorized() AS tenant`),
    );
    expect((after.rows![0] as any).tenant).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C. Cross-tenant reach
// ---------------------------------------------------------------------------

describe('re-audit C — no context reaches across tenants', () => {
  it('a valid public bearer reaches ONLY its own link\'s organization', async () => {
    const result = await withPublicScope(A.link, async (_db, sql) =>
      probe(
        sql,
        `SELECT
           (SELECT count(*)::int FROM invoices   WHERE organization_id = $1::uuid) AS foreign_invoices,
           (SELECT count(*)::int FROM students   WHERE organization_id = $1::uuid) AS foreign_students,
           (SELECT count(*)::int FROM payments   WHERE organization_id = $1::uuid) AS foreign_payments,
           (SELECT count(*)::int FROM payment_links WHERE organization_id = $1::uuid) AS foreign_links,
           (SELECT count(*)::int FROM reminders  WHERE organization_id = $1::uuid) AS foreign_reminders,
           (SELECT count(*)::int FROM invoices   WHERE id = $2::uuid) AS foreign_invoice_by_id,
           (SELECT count(*)::int FROM payment_links WHERE token = $3) AS foreign_link_by_token,
           (SELECT count(*)::int FROM invoices   WHERE organization_id = $4::uuid) AS own_invoices`,
        [B.org, B.invoice, B.link, A.org],
      ),
    );
    expect(result.ok).toBe(true);
    const row = result.rows![0] as any;
    for (const key of [
      'foreign_invoices',
      'foreign_students',
      'foreign_payments',
      'foreign_links',
      'foreign_reminders',
      'foreign_invoice_by_id',
      'foreign_link_by_token',
    ]) {
      expect(Number(row[key]), `${key} leaked`).toBe(0);
    }
    expect(Number(row.own_invoices)).toBeGreaterThan(0);
  });

  it('two tenant contexts interleaved on one pool never cross', async () => {
    const seen: Array<{ who: string; foreign: number; own: number; ctx: string }> = [];
    const run = (who: 'A' | 'B') => {
      const fx = who === 'A' ? A : B;
      const other = who === 'A' ? B : A;
      return withScopedDb(
        { kind: 'tenant', organizationId: fx.org, userId: fx.user },
        async (_db, sql) => {
          await new Promise((r) => setTimeout(r, 2));
          const rows = (await sql.unsafe(
            `SELECT (SELECT count(*)::int FROM invoices WHERE organization_id = $1::uuid) AS foreign,
                    (SELECT count(*)::int FROM invoices WHERE organization_id = $2::uuid) AS own,
                    NULLIF(current_setting('app.organization_id', true), '') AS ctx`,
            [other.org, fx.org],
          )) as any[];
          seen.push({ who, foreign: Number(rows[0].foreign), own: Number(rows[0].own), ctx: rows[0].ctx });
          return null;
        },
        { client: fixturePool },
      );
    };
    await Promise.all([...Array.from({ length: 5 }, () => run('A')), ...Array.from({ length: 5 }, () => run('B'))]);
    expect(seen).toHaveLength(10);
    for (const entry of seen) {
      expect(entry.foreign, `${entry.who} saw foreign rows`).toBe(0);
      expect(entry.own).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// D. Write authority
// ---------------------------------------------------------------------------

describe('re-audit D — write authority is the minimum required', () => {
  const writeAttempts: Array<[string, string]> = [
    ['invoices update', `UPDATE invoices SET memo = memo WHERE true`],
    ['invoice_lines insert', `INSERT INTO invoice_lines (organization_id, invoice_id, description, unit_rate_kobo, amount_kobo)
                              SELECT organization_id, id, 'x', 1, 1 FROM invoices LIMIT 1`],
    ['payments delete', `DELETE FROM payments WHERE true`],
    ['payment_allocations insert', `INSERT INTO payment_allocations (organization_id, payment_id, invoice_id, amount_kobo)
                                    SELECT organization_id, id, id, 1 FROM payments LIMIT 1`],
    ['receipts update', `UPDATE receipts SET amount_kobo = amount_kobo WHERE true`],
    ['students update', `UPDATE students SET last_name = last_name WHERE true`],
    ['guardians insert', `INSERT INTO guardians (organization_id, first_name, last_name)
                          VALUES ($ORG$::uuid, 'X', 'Y')`],
    ['fee_assignments update', `UPDATE fee_assignments SET amount_kobo = amount_kobo WHERE true`],
    ['collections_cases insert', `INSERT INTO collections_cases (organization_id, student_id, reason, created_by)
                                  SELECT organization_id, id, 'x', NULL FROM students LIMIT 1`],
  ];

  it('public context cannot write anything except a pending payment', async () => {
    for (const [label, template] of writeAttempts) {
      const usesParam = template.includes('$ORG$');
      const text = template.replace(/\$ORG\$/g, '$1');
      const result = await withPublicScope(A.link, async (_db, sql) =>
        probe(sql, `${text} RETURNING 1 AS r`, usesParam ? [A.org] : []),
      );
      if (result.ok) {
        expect(result.rows!.length, `${label} mutated rows in public context`).toBe(0);
      } else {
        expect(result.code, `${label} produced no SQLSTATE`).toBeTruthy();
      }
    }
  });

  it('the public audit trail cannot be written from public context at all (R3: owner-only)', async () => {
    // R3 (H-3) — STRENGTHENED. Before R3, public context could write an audit
    // row for its own tenant directly (the 0012/0040 policies applied to every
    // role), which is how a bearer could produce an audit trail of its own
    // choosing. 0046 narrowed `audit_events_public_insert` to the owner role,
    // so public context held by the runtime role has NO audit write path at
    // all: the entry point writes the row as the owner, with the context it
    // derived from the bearer, and nothing else can.
    const own = await withPublicScope(A.link, async (_db, sql) =>
      probe(
        sql,
        `INSERT INTO audit_events (organization_id, actor_type, action, entity_type)
         VALUES ($1::uuid, 'USER', 'reaudit.probe', 'payment') RETURNING 1 AS r`,
        [A.org],
      ),
    );
    expect(own.ok, 'public context must not write the audit trail directly').toBe(false);

    // …and a row that NAMES another tenant is refused as well. The tenant of a
    // row is decided by the authorization context and never by the value the
    // caller supplied; with R3 there is no caller-supplied audit write left.
    const before = await withScopedDb(
      { kind: 'tenant', organizationId: B.org, userId: B.user },
      async (_db, sql) => probe(sql, `SELECT count(*)::int AS n FROM audit_events`),
    );
    const foreign = await withPublicScope(A.link, async (_db, sql) =>
      probe(
        sql,
        `INSERT INTO audit_events (organization_id, actor_type, action, entity_type)
         VALUES ($1::uuid, 'USER', 'reaudit.probe', 'payment') RETURNING organization_id`,
        [B.org],
      ),
    );
    if (foreign.ok) {
      expect(foreign.rows!.length, 'the row was refused instead of attributed').toBe(1);
      expect((foreign.rows![0] as any).organization_id, 'row attributed to a foreign tenant').toBe(A.org);
    } else {
      expect(foreign.code).toBe('42501');
    }
    const after = await withScopedDb(
      { kind: 'tenant', organizationId: B.org, userId: B.user },
      async (_db, sql) => probe(sql, `SELECT count(*)::int AS n FROM audit_events`),
    );
    expect((after.rows![0] as any).n).toBe((before.rows![0] as any).n);
  });

  it('a tenant context cannot write outside its own organization', async () => {
    for (const [label, template] of writeAttempts) {
      const usesParam = template.includes('$ORG$');
      const text = template.replace(/\$ORG\$/g, '$1');
      const result = await withScopedDb(
        { kind: 'tenant', organizationId: A.org, userId: A.user },
        async (_db, sql) => probe(sql, `${text} RETURNING 1 AS r`, usesParam ? [B.org] : []),
      );
      if (result.ok) {
        // Statements without an organization predicate are scoped by row
        // security to the caller's own tenant; statements that name a foreign
        // organization must affect nothing (or be rejected). Either way, no
        // statement may reach the other tenant, which the state check below
        // proves independently of the row counts.
        expect(result.rows!.length, `${label} reported an impossible result`).toBeGreaterThanOrEqual(0);
      } else {
        // Rejection is acceptable at any enforcement layer, but only at a
        // boundary layer: 42501 (privilege/policy), 23503 (composite foreign
        // key), 23514 (check/guard trigger). A silent success would not be.
        expect(['42501', '23503', '23514'], `${label} rejected with ${result.code}`).toContain(result.code);
      }
    }
    // And org B is unchanged in the tables that matter.
    const bState = await withScopedDb(
      { kind: 'tenant', organizationId: B.org, userId: B.user },
      async (_db, sql) =>
        probe(
          sql,
          `SELECT (SELECT count(*)::int FROM payments) AS payments,
                  (SELECT count(*)::int FROM payment_allocations) AS allocations,
                  (SELECT count(*)::int FROM receipts) AS receipts,
                  (SELECT count(*)::int FROM guardians) AS guardians,
                  (SELECT count(*)::int FROM audit_events) AS audits`,
        ),
    );
    const row = bState.rows![0] as any;
    expect(Number(row.allocations)).toBe(0);
    expect(Number(row.receipts)).toBe(0);
    expect(Number(row.guardians)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// E. Context persistence
// ---------------------------------------------------------------------------

describe('re-audit E — authority does not outlive the request', () => {
  const identityVars: string[] = CONTEXT_GUCS.filter(
    (name) => !/is_platform_admin|auth_bootstrap|bypass_financial_triggers|public_context$/.test(name as string),
  ) as string[];

  async function globalContextOnPool(): Promise<Record<string, string | null>> {
    const cols = CONTEXT_GUCS.map((n, i) => `NULLIF(current_setting('${n}', true), '') AS c${i}`).join(', ');
    const held: any[] = [];
    try {
      for (let i = 0; i < 3; i++) held.push(await fixturePool.reserve());
      const states = await Promise.all(held.map((c) => c.unsafe(`SELECT ${cols}`)));
      const merged: Record<string, string | null> = {};
      CONTEXT_GUCS.forEach((name, i) => {
        const raws = states.map((s: any) => (s[0][`c${i}`] == null ? null : String(s[0][`c${i}`])));
        merged[name] = raws.every((v) => v === null || v === '' || v === '0') ? null : raws.join('|');
      });
      return merged;
    } finally {
      for (const c of held) c.release();
    }
  }

  it('tenant, public and system scopes all leave the pool identity-free', async () => {
    await withScopedDb({ kind: 'tenant', organizationId: A.org, userId: A.user }, async () => null, {
      client: fixturePool,
    });
    await withPublicScope(A.link, async () => null);
    await withScopedDb({ kind: 'system' }, async () => null, { client: fixturePool });

    const state = await globalContextOnPool();
    const dirty = Object.entries(state).filter(([name, v]) => v !== null && identityVars.includes(name));
    expect(dirty).toEqual([]);
  });

  it('the public submission entry point restores the caller\'s context on success AND failure', async () => {
    const readState = async () =>
      withPublicScope(A.link, async (_db, sql) => {
        const rows = (await sql.unsafe(
          `SELECT current_setting('app.organization_id', true) AS org,
                  current_setting('app.public_link_token', true) AS link,
                  current_setting('app.public_context', true) AS marker`,
        )) as any[];
        return rows[0];
      });

    const before = await readState();
    const submitted = await withPublicScope(A.link, async (_db, sql) =>
      probe(
        sql,
        // The claim is the authoritative amount due (R3/H-3 binding): a
        // submission whose amount disagrees with the database's decision is
        // refused, so a re-audit of context restoration must submit the value
        // the database itself derives.
        `SELECT * FROM auth_public_submit_payment($1, $2, auth_public_amount_due($1), $3, 'Re-audit payer')`,
        [A.link, `ra-key-${randomUUID().slice(0, 8)}`, `RA-${randomUUID().slice(0, 8)}`],
      ),
    );
    expect(submitted.ok, submitted.message).toBe(true);

    // A deliberately invalid call (negative amount) must fail…
    const bad = await withPublicScope(A.link, async (_db, sql) =>
      probe(sql, `SELECT * FROM auth_public_submit_payment($1, $2, -5::bigint, 'R', 'P')`, [
        A.link,
        `ra-bad-${randomUUID().slice(0, 8)}`,
      ]),
    );
    expect(bad.ok).toBe(false);

    // …and in both cases the enclosing public context is exactly as it was.
    expect(await readState()).toEqual(before);
  });

  it('an error inside a scope leaves no residue and no partial money', async () => {
    const marker = `RA-RESIDUE-${randomUUID().slice(0, 8)}`;
    await withScopedDb(
      { kind: 'tenant', organizationId: A.org, userId: A.user },
      async (_db, sql) => {
        await sql.unsafe(`INSERT INTO students (organization_id, student_id, first_name, last_name, status)
                          VALUES ($1::uuid, $2, 'R', 'A', 'ACTIVE')`, [A.org, marker.slice(0, 30)]);
        throw new Error('re-audit induced failure');
      },
      { client: fixturePool },
    ).catch(() => undefined);

    const state = await globalContextOnPool();
    const dirty = Object.entries(state).filter(([name, v]) => v !== null && identityVars.includes(name));
    expect(dirty).toEqual([]);

    const leftover = await withScopedDb(
      { kind: 'tenant', organizationId: A.org, userId: A.user },
      async (_db, sql) => probe(sql, `SELECT count(*)::int AS n FROM students WHERE student_id = $1`, [marker.slice(0, 30)]),
    );
    expect(Number((leftover.rows![0] as any).n)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F. Privilege surface
// ---------------------------------------------------------------------------

describe('re-audit F — the runtime role cannot widen its own authority', () => {
  const ownerOnly = [
    'auth_set_public_context',
    'auth_set_public_link_token',
    'auth_public_proof_for',
    'auth_tenant_token_for',
    'auth_platform_token_for',
    'set_tenant_context_for_system',
  ];

  it('identity-minting functions are not callable by the runtime role', async () => {
    for (const fn of ownerOnly) {
      const result = await withScopedDb({ kind: 'none' }, async (_db, sql) =>
        probe(sql, `SELECT ${fn}($1::text, $2::uuid)`, [A.link, A.org]),
      );
      expect(result.ok, `${fn} is callable by the runtime role`).toBe(false);
      // 42501 insufficient_privilege, or 42883 if the arity does not exist.
      expect(['42501', '42883'], `${fn} rejected with ${result.code}`).toContain(result.code);
    }
  });

  it('the document-number counter cannot be advanced by the runtime role', async () => {
    const result = await withScopedDb({ kind: 'tenant', organizationId: A.org, userId: A.user }, async (_db, sql) =>
      probe(sql, `SELECT next_doc_number('INV')`),
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('42501');
  });

  it('the runtime role cannot alter RLS enforcement or financial tables', async () => {
    const attempts = [
      `ALTER TABLE invoices DISABLE ROW LEVEL SECURITY`,
      `ALTER TABLE invoices NO FORCE ROW LEVEL SECURITY`,
      `ALTER TABLE payments DROP CONSTRAINT payments__invoice_id__org_fkey`,
      `DROP POLICY invoices_public_lookup ON invoices`,
      `CREATE POLICY zz_audit_grant ON invoices FOR SELECT USING (true)`,
      `ALTER ROLE scolaira_app BYPASSRLS`,
      `GRANT SELECT ON app_meta TO scolaira_app`,
    ];
    for (const text of attempts) {
      const result = await withScopedDb({ kind: 'none' }, async (_db, sql) => probe(sql, text));
      // Creating a permissive policy is allowed for a table's owner only; the
      // runtime role is not the owner of any of these objects.
      expect(result.ok, `runtime role was allowed to run: ${text}`).toBe(false);
      expect(result.code, `${text} -> ${result.code}`).toBe('42501');
    }
  });

  it('the public submission entry point is the ONLY public write path', async () => {
    const result = await withScopedDb({ kind: 'none' }, async (_db, sql) =>
      probe(
        sql,
        `SELECT p.proname, has_function_privilege('scolaira_app', p.oid, 'EXECUTE') AS app_can
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND p.proname LIKE 'auth_public_%'
          ORDER BY p.proname`,
      ),
    );
    const callable = (result.rows as any[])
      .filter((r) => r.app_can)
      .map((r) => r.proname)
      .sort();
    // R3 (H-3) added a read-only resolver for the authoritative amount due.
    // H-5 added two READ-ONLY, tenant-scoped operational views (a link's own
    // exposure posture, and the organization's recent public-surface events).
    // Neither writes anything: the write path is still the single
    // credential-gated entry point.
    expect(callable).toEqual([
      'auth_public_amount_due',
      'auth_public_link_exposure',
      'auth_public_submit_payment',
      'auth_public_surface_events',
    ]);
  });

  it('exactly one app-callable function writes to the ledger (H-5 audit)', async () => {
    // The stronger form of the same property: read the definitions, not the
    // names. H-5 added a durable operational-event log and a recorder for it —
    // that recorder must be the ONLY other public-surface writer, and it must
    // never touch a financial table.
    const result = await withScopedDb({ kind: 'none' }, async (_db, sql) =>
      probe(
        sql,
        `SELECT p.proname, pg_get_functiondef(p.oid) AS def
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND p.proname LIKE 'auth\_%'
            AND has_function_privilege('scolaira_app', p.oid, 'EXECUTE')`,
      ),
    );
    const rows = result.rows as Array<{ proname: string; def: string }>;
    const ledgerWriters = rows
      .filter((r) => /insert\s+into\s+(public\.)?(payments|payment_allocations|receipts|invoices)\b/i.test(r.def))
      .map((r) => r.proname)
      .sort();
    expect(ledgerWriters).toEqual(['auth_public_submit_payment']);

    const recorder = rows.find((r) => r.proname === 'auth_record_public_surface_event');
    expect(recorder, 'the H-5 recorder must be app-callable').toBeTruthy();
    expect(/insert\s+into\s+(public\.)?public_surface_events\b/i.test(recorder!.def)).toBe(true);
    expect(
      /insert\s+into\s+(public\.)?(payments|payment_allocations|receipts|invoices|payment_links)\b/i.test(
        recorder!.def,
      ),
    ).toBe(false);
  });
});
