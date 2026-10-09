// @vitest-environment node
/**
 * H-8 — `member_invitations` row-level security.
 *
 * The invitation table is tenant data: an invitation belongs to exactly one
 * organization and is invisible everywhere else. This suite attacks that claim
 * the way the R1 suites attack the financial tables — with real contexts, real
 * forged GUCs, and real cross-tenant writes.
 *
 * It also records the ONE deliberate deviation, so it can never be mistaken for
 * an accident: this table carries a bootstrap branch (like `organizations`) and
 * no other tenant table does, because acceptance has to resolve a token before
 * any tenant context exists. The three other candidate doors were measured and
 * rejected (see the migration's comment); here the consequence is pinned: a
 * bootstrap context CAN read these rows, and it still cannot reach any other
 * tenant table through this table's routes.
 */
import { describe, it, expect } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { testDb, testSql } from '../setup-db';
import { memberInvitations } from '@/lib/db/schema/invitations';
import { withSystemContext } from '@/lib/db/tenant';
import { memberInvitationColumns } from '../support/h8-fixtures';
import { seedTwoOrgs } from '../support/seed';
import type { SeededIds } from '../support/seed';

const ORG_A_INVITE = '11111111-2222-3333-4444-555555555551';
const ORG_B_INVITE = '11111111-2222-3333-4444-555555555552';

function tokenHash(seed: string): string {
  // A deterministic 64-hex value; this suite is about visibility, not hashing.
  return seed
    .repeat(64)
    .slice(0, 64)
    .replace(/[^a-f0-9]/g, 'a');
}

async function seedInvitations(ids: SeededIds) {
  await withSystemContext(null, null, async () => {
    const sql = testSql();
    await sql.unsafe(
      `insert into member_invitations
         (id, organization_id, email, role, token_hash, status, invited_by, invited_at, expires_at, created_at, updated_at)
       values
         ($1, $2, 'a-invitee@example.com', 'STAFF', $3, 'PENDING', $4, now(), now() + interval '7 days', now(), now()),
         ($5, $6, 'b-invitee@example.com', 'FINANCE_OFFICER', $7, 'PENDING', $8, now(), now() + interval '7 days', now(), now())`,
      [
        ORG_A_INVITE,
        ids.orgId,
        tokenHash('a'),
        ids.aliceId,
        ORG_B_INVITE,
        ids.orgBId,
        tokenHash('b'),
        ids.bobId,
      ] as never[],
    );
  });
}

/**
 * Run `fn` expecting the database to refuse it, without poisoning the harness's
 * per-test transaction: a failed statement aborts the surrounding transaction, so
 * the attempt is wrapped in a SAVEPOINT that is rolled back afterwards.
 */
async function expectDbRefusal(fn: () => Promise<unknown>): Promise<boolean> {
  const sql = testSql();
  const sp = `sp_h8_${Math.random().toString(36).slice(2, 10)}`;
  await sql.unsafe(`SAVEPOINT ${sp}`);
  let refused = false;
  try {
    await fn();
  } catch {
    refused = true;
    await sql.unsafe(`ROLLBACK TO SAVEPOINT ${sp}`);
  }
  await sql.unsafe(`RELEASE SAVEPOINT ${sp}`);
  return refused;
}

async function countVisible(): Promise<number> {
  const rows = await testSql().unsafe(`select count(*)::int as n from member_invitations`);
  return (rows as unknown as Array<{ n: number }>)[0]!.n;
}

describe('H-8 — invitation visibility is per-tenant', () => {
  it('tenant A sees only its own invitation; tenant B sees only its own', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    await seedInvitations(ids);

    await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;
    const asA = await testDb()
      .select({ id: memberInvitations.id, org: memberInvitations.organizationId })
      .from(memberInvitations);
    expect(asA.map((r) => r.id)).toEqual([ORG_A_INVITE]);
    expect(asA.every((r) => r.org === ids.orgId)).toBe(true);

    await testSql()`SELECT set_tenant_context(${ids.orgBId}::uuid, ${ids.bobId}::uuid)`;
    const asB = await testDb()
      .select({ id: memberInvitations.id, org: memberInvitations.organizationId })
      .from(memberInvitations);
    expect(asB.map((r) => r.id)).toEqual([ORG_B_INVITE]);
    expect(asB.every((r) => r.org === ids.orgBId)).toBe(true);
  });

  it('a specific row cannot be fetched across tenants, even by primary key', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    await seedInvitations(ids);

    await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;
    const stolen = await testDb()
      .select()
      .from(memberInvitations)
      .where(eq(memberInvitations.id, ORG_B_INVITE));
    expect(stolen).toEqual([]);
  });

  it('with no context at all, the table is empty', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    await seedInvitations(ids);

    await testSql()`RESET ALL`;
    expect(await countVisible()).toBe(0);
  });

  it('forged GUCs authorize nothing', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    await seedInvitations(ids);

    // Exactly what an attacker with SQL access would try: name the organization
    // and assert the platform flag, without the HMAC proofs the database mints.
    const sql = testSql();
    await sql`SELECT set_config('app.organization_id', ${ids.orgId}, true)`;
    await sql`SELECT set_config('app.user_id', ${ids.aliceId}, true)`;
    await sql`SELECT set_config('app.is_platform_admin', '1', true)`;
    await sql`SELECT set_config('app.platform_admin_id', ${ids.aliceId}, true)`;
    await sql`SELECT set_config('app.platform_token', 'forged', true)`;
    await sql`SELECT set_config('app.tenant_token', 'forged', true)`;
    await sql`SELECT set_config('app.auth_bootstrap', '0', true)`;

    expect(await countVisible()).toBe(0);
  });

  it('a tenant cannot insert an invitation into another organization (WITH CHECK)', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    await seedInvitations(ids);
    await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;

    let rejected = false;
    try {
      await testDb()
        .insert(memberInvitations)
        .values({
          organizationId: ids.orgBId,
          email: 'smuggled@example.com',
          role: 'STAFF',
          tokenHash: tokenHash('c'),
          invitedBy: ids.aliceId,
          invitedAt: new Date(),
          expiresAt: new Date(Date.now() + 86_400_000),
        } as never);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  it('a tenant cannot move another organization’s invitation out of PENDING', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    await seedInvitations(ids);
    await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;

    const changed = await testDb()
      .update(memberInvitations)
      .set({ status: 'REVOKED', revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(memberInvitations.id, ORG_B_INVITE))
      .returning({ id: memberInvitations.id });
    expect(changed).toEqual([]);

    // ...and B's row is untouched.
    await testSql()`SELECT set_tenant_context(${ids.orgBId}::uuid, ${ids.bobId}::uuid)`;
    const row = await testDb()
      .select({ status: memberInvitations.status })
      .from(memberInvitations)
      .where(eq(memberInvitations.id, ORG_B_INVITE));
    expect(row[0]!.status).toBe('PENDING');
  });

  it('the bootstrap context can read these rows — the documented exception, pinned', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    await seedInvitations(ids);

    // Reached only through withSystemScope(); it is what makes token acceptance
    // possible before any membership exists. Asserted rather than left implicit:
    // if a future change removes the branch, this test fails and the reader is
    // sent to the migration comment explaining why it is there.
    const visible = await withSystemContext(null, null, async () => countVisible());
    expect(visible).toBe(2);
  });
});

describe('H-8 — the table’s own guard rails', () => {
  it('enforces one PENDING invitation per (organization, email)', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    await seedInvitations(ids);

    const rejected = await withSystemContext(null, null, () =>
      expectDbRefusal(() =>
        testSql().unsafe(
          `insert into member_invitations
             (organization_id, email, role, token_hash, invited_at, expires_at)
           values ($1, 'a-invitee@example.com', 'STAFF', $2, now(), now() + interval '7 days')`,
          [ids.orgId, tokenHash('d')] as never[],
        ),
      ),
    );
    expect(rejected).toBe(true);
  });

  it('enforces a unique token hash and a 64-hex shape', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    await seedInvitations(ids);

    const { dupRejected, shapeRejected } = await withSystemContext(null, null, async () => ({
      dupRejected: await expectDbRefusal(() =>
        testSql().unsafe(
          `insert into member_invitations (organization_id, email, role, token_hash, invited_at, expires_at)
           values ($1, 'second@example.com', 'STAFF', $2, now(), now() + interval '7 days')`,
          [ids.orgId, tokenHash('a')] as never[],
        ),
      ),
      shapeRejected: await expectDbRefusal(() =>
        testSql().unsafe(
          `insert into member_invitations (organization_id, email, role, token_hash, invited_at, expires_at)
           values ($1, 'third@example.com', 'STAFF', 'NOT-A-HASH', now(), now() + interval '7 days')`,
          [ids.orgId] as never[],
        ),
      ),
    }));
    expect(dupRejected).toBe(true);
    expect(shapeRejected).toBe(true);
  });

  it('refuses OWNER and an expiry that precedes the invite', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const { ownerRejected, expiryRejected } = await withSystemContext(null, null, async () => ({
      ownerRejected: await expectDbRefusal(() =>
        testSql().unsafe(
          `insert into member_invitations (organization_id, email, role, token_hash, invited_at, expires_at)
           values ($1, 'owner@example.com', 'OWNER', $2, now(), now() + interval '7 days')`,
          [ids.orgId, tokenHash('e')] as never[],
        ),
      ),
      expiryRejected: await expectDbRefusal(() =>
        testSql().unsafe(
          `insert into member_invitations (organization_id, email, role, token_hash, invited_at, expires_at)
           values ($1, 'past@example.com', 'STAFF', $2, now(), now() - interval '1 day')`,
          [ids.orgId, tokenHash('f')] as never[],
        ),
      ),
    }));
    expect(ownerRejected).toBe(true);
    expect(expiryRejected).toBe(true);
  });

  it('has RLS enabled AND forced, with the runtime role holding DML only', async () => {
    const sql = testSql();
    const rls = (await sql.unsafe(
      `select relrowsecurity, relforcerowsecurity from pg_class where relname = 'member_invitations'`,
    )) as unknown as Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    expect(rls[0]!.relrowsecurity).toBe(true);
    expect(rls[0]!.relforcerowsecurity).toBe(true);

    // Required DML is present. (Not an exact set: `scripts/migrate.ts` re-grants
    // DELETE on ALL TABLES after every migration run, so a table-level DELETE
    // revoke does not survive the run that applies it — measured after a 0 -> 50
    // run. Row-level deletes are blocked by policy instead, asserted below.)
    const grants = (await sql.unsafe(
      `select privilege_type from information_schema.role_table_grants
        where table_name = 'member_invitations' and grantee = 'scolaira_app'`,
    )) as unknown as Array<{ privilege_type: string }>;
    for (const required of ['INSERT', 'SELECT', 'UPDATE']) {
      expect(grants.map((g) => g.privilege_type)).toContain(required);
    }

    // R1 (0044) revoked the non-DML privileges because TRUNCATE is not subject
    // to row-level security, and the migration runner does not re-grant them:
    // this table must not carry them.
    for (const priv of ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) {
      const held = (await sql.unsafe(
        `select has_table_privilege('scolaira_app', 'member_invitations', $1) as held`,
        [priv] as never[],
      )) as unknown as Array<{ held: boolean }>;
      expect({ priv, held: held[0]!.held }).toEqual({ priv, held: false });
    }

    // Deleting is impossible at the row level, which is what the DELETE grant
    // cannot override.
    const denying = (await sql.unsafe(
      `select pg_get_expr(polqual, polrelid) as qual from pg_policy
        where polrelid = 'member_invitations'::regclass and polname = 'member_invitations_no_delete'`,
    )) as unknown as Array<{ qual: string }>;
    expect(denying[0]?.qual).toBe('false');
  });

  it('a tenant delete removes nothing (denied by policy, not by luck)', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    await seedInvitations(ids);
    await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;

    const deleted = await testDb()
      .delete(memberInvitations)
      .where(eq(memberInvitations.organizationId, ids.orgId))
      .returning({ id: memberInvitations.id });
    expect(deleted).toEqual([]);

    const still = await testDb()
      .select({ id: memberInvitations.id })
      .from(memberInvitations)
      .where(eq(memberInvitations.organizationId, ids.orgId));
    expect(still.map((r) => r.id)).toEqual([ORG_A_INVITE]);
  });
});

describe('H-8 — the schema Drizzle knows matches the schema the database has', () => {
  it('every mapped column exists in the database', async () => {
    for (const column of memberInvitationColumns) {
      const rows = (await testSql().unsafe(
        `select count(*)::int as n from information_schema.columns
          where table_name = 'member_invitations' and column_name = $1`,
        [column] as never[],
      )) as unknown as Array<{ n: number }>;
      expect({ column, n: rows[0]!.n }).toEqual({ column, n: 1 });
    }
  });

  it('accepting through the schema writes the columns the API expects', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    await seedInvitations(ids);

    await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;
    const updated = await testDb()
      .update(memberInvitations)
      .set({
        status: 'ACCEPTED',
        acceptedAt: new Date(),
        acceptedBy: ids.aliceId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(memberInvitations.organizationId, ids.orgId),
          eq(memberInvitations.id, ORG_A_INVITE),
        ),
      )
      .returning({ id: memberInvitations.id, status: memberInvitations.status });
    expect(updated).toEqual([{ id: ORG_A_INVITE, status: 'ACCEPTED' }]);
  });
});
