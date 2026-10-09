/**
 * H-8 e2e fixtures.
 *
 * Decision D-3: the H-6 seed (`scripts/seed-e2e.ts`) is FROZEN and is not
 * edited. Everything this suite needs beyond the seed is created here, from the
 * test process, against the seeded throwaway database — including the
 * membership-less platform identity, which is deliberately NOT part of the seed
 * because a membership-less platform administrator can never hold a session (a
 * boundary pinned in tests/auth/h8-platform-boundary.test.ts) and would therefore
 * be useless as a journey identity.
 *
 * This file also reads the audit trail. Reading it requires TENANT context — the
 * audit table has no bootstrap branch — so `auditRowsFor` acts as an ACTIVE
 * member of the organization whose trail is being read (the seeded second
 * organization has one).
 */
import postgres from 'postgres';

/**
 * The OWNER connection to the E2E database, and only to the E2E database.
 *
 * Deliberately NOT falling back to `DATABASE_MIGRATION_URL`: that variable
 * points at the vitest database in a normal developer shell, and reading the
 * wrong database produces a plausible-looking "row not found" instead of an
 * error — measured: a fixture insert failed with a foreign-key violation because
 * it was running against `scolaira_test`.
 */
const OWNER_URL =
  process.env.E2E_DATABASE_MIGRATION_URL ??
  process.env.E2E_OWNER_DATABASE_URL ??
  'postgresql://scolaira_owner:scolaira_owner_pw@localhost:5432/scolaira_e2e';

if (!/\/scolaira_e2e(\?|$)/.test(OWNER_URL)) {
  throw new Error(
    `e2e fixture refusing to run against a non-E2E database: ${OWNER_URL.replace(/:[^:@/]*@/, ':***@')}`,
  );
}

let sql: postgres.Sql | null = null;

function db(): postgres.Sql {
  if (!sql) {
    sql = postgres(OWNER_URL, { max: 1, onnotice: () => {}, idle_timeout: 5 });
  }
  return sql;
}

export async function closeFixtureConnection(): Promise<void> {
  if (sql) {
    await sql.end({ timeout: 5 });
    sql = null;
  }
}

/** Run `fn` in the bootstrap context the seed uses for identity rows. */
async function inBootstrap<T>(fn: (tx: postgres.Sql) => Promise<T>): Promise<T> {
  const conn = db();
  await conn`SELECT auth_enter_system_context()`;
  await conn`SELECT set_config('app.auth_bootstrap','1',false)`;
  try {
    return await fn(conn);
  } finally {
    await conn`SELECT clear_app_context()`;
  }
}

export interface SupportTarget {
  organizationId: string;
  name: string;
  /** An ACTIVE member of that organization, used to read its audit trail. */
  memberUserId: string;
}

/**
 * The organization that the seeded platform administrator is NOT a member of —
 * the one support mode exists for.
 */
export async function discoverSupportTarget(platformAdminEmail: string): Promise<SupportTarget> {
  return inBootstrap(async (conn) => {
    const rows = (await conn.unsafe(
      `select o.id, o.name,
              (select om.user_id from organization_members om
                where om.organization_id = o.id and om.status = 'ACTIVE' limit 1) as member_user_id
         from organizations o
        where o.id not in (
          select om2.organization_id from organization_members om2
           join users u on u.id = om2.user_id
          where u.email = $1 and om2.status = 'ACTIVE'
        )
        order by o.name
        limit 1`,
      [platformAdminEmail],
    )) as unknown as Array<{ id: string; name: string; member_user_id: string | null }>;
    const row = rows[0];
    if (!row || !row.member_user_id) {
      throw new Error('H-8 fixture: no support target organization found in the seeded database');
    }
    return { organizationId: row.id, name: row.name, memberUserId: row.member_user_id };
  });
}

/** Audit rows for one organization and action, read in that tenant's context. */
export async function auditRowsFor(
  organizationId: string,
  memberUserId: string,
  action: string,
): Promise<Array<{ action: string; reason: string | null; metadata: Record<string, unknown> }>> {
  const conn = db();
  await conn.unsafe(`SELECT set_tenant_context($1::uuid, $2::uuid)`, [
    organizationId,
    memberUserId,
  ]);
  try {
    return (await conn.unsafe(
      `select action, reason, metadata from audit_events
        where organization_id = $1 and action = $2 order by created_at`,
      [organizationId, action],
    )) as unknown as Array<{
      action: string;
      reason: string | null;
      metadata: Record<string, unknown>;
    }>;
  } finally {
    await conn`SELECT clear_app_context()`;
  }
}

/** Invitation count for an organization, read in that tenant's context. */
export async function invitationCountFor(
  organizationId: string,
  memberUserId: string,
): Promise<number> {
  const conn = db();
  await conn.unsafe(`SELECT set_tenant_context($1::uuid, $2::uuid)`, [
    organizationId,
    memberUserId,
  ]);
  try {
    const rows = (await conn.unsafe(
      `select count(*)::int as n from member_invitations where organization_id = $1`,
      [organizationId],
    )) as unknown as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  } finally {
    await conn`SELECT clear_app_context()`;
  }
}

export interface MembershiplessPlatformAdmin {
  userId: string;
  email: string;
}

/**
 * D-3 fixture: a platform administrator with no membership anywhere.
 *
 * Created here rather than in the frozen seed so the seed keeps its exact
 * content, and removed by `dropMembershiplessPlatformAdmin` so repeated runs do
 * not accumulate identities.
 */
export async function createMembershiplessPlatformAdmin(): Promise<MembershiplessPlatformAdmin> {
  const email = `h8-no-membership-${Date.now()}@platform.fixture`;
  return inBootstrap(async (conn) => {
    const rows = (await conn.unsafe(
      `insert into users (id, email, first_name, last_name, is_platform_admin, created_at, updated_at)
       values (gen_random_uuid(), $1, 'H8', 'NoMembership', true, now(), now())
       returning id`,
      [email],
    )) as unknown as Array<{ id: string }>;
    return { userId: rows[0]!.id, email };
  });
}

export async function dropMembershiplessPlatformAdmin(userId: string): Promise<void> {
  await inBootstrap(async (conn) => {
    await conn.unsafe(
      `update sessions set revoked_at = now() where user_id = $1 and revoked_at is null`,
      [userId],
    );
    await conn.unsafe(`delete from password_credentials where user_id = $1`, [userId]);
    await conn.unsafe(`delete from organization_members where user_id = $1`, [userId]);
    await conn.unsafe(`delete from users where id = $1`, [userId]);
  });
}

/** Grant or remove a second membership, so the shell's switcher has something to switch to. */
export async function setMembership(
  organizationId: string,
  userId: string,
  action: 'add' | 'remove',
): Promise<void> {
  await inBootstrap(async (conn) => {
    if (action === 'add') {
      await conn.unsafe(
        `insert into organization_members (organization_id, user_id, role, status, joined_at, created_at, updated_at)
         values ($1::uuid, $2::uuid, 'STAFF', 'ACTIVE', now(), now(), now())
         on conflict do nothing`,
        [organizationId, userId],
      );
    } else {
      await conn.unsafe(
        `delete from organization_members where organization_id = $1::uuid and user_id = $2::uuid`,
        [organizationId, userId],
      );
    }
  });
}

/** What the database knows about the D-3 fixture identity. */
export async function describeMembershipless(
  userId: string,
): Promise<{ isPlatformAdmin: boolean; memberships: number }> {
  return inBootstrap(async (conn) => {
    const rows = (await conn.unsafe(
      `select u.is_platform_admin,
              (select count(*)::int from organization_members om where om.user_id = u.id) as memberships
         from users u where u.id = $1`,
      [userId],
    )) as unknown as Array<{ is_platform_admin: boolean; memberships: number }>;
    const row = rows[0];
    if (!row) throw new Error('H-8 fixture: identity disappeared');
    return { isPlatformAdmin: row.is_platform_admin, memberships: row.memberships };
  });
}
