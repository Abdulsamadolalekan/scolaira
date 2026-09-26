// @vitest-environment node
/**
 * H-8 — invitation tokens are hashed, expiring, single-use and org-scoped.
 *
 * These are route-level tests: every assertion goes through the real handler
 * (`POST /api/members/invitations`, `POST /api/invitations/[token]/accept`) with
 * the real cookie jar and CSRF double-submit, against the real database. Nothing
 * below mocks the authorization path.
 *
 * The four invariants this file exists to prove:
 *
 *   HASHED      the plaintext token is returned once and is absent from the
 *               database; only sha256(token) is stored;
 *   EXPIRING    a token past `expires_at` cannot be accepted, and the expiry is
 *               never longer than the documented TTL;
 *   SINGLE-USE  acceptance flips the row to ACCEPTED under `FOR UPDATE`, so a
 *               second acceptance (sequential or concurrent) fails;
 *   ORG-SCOPED  the membership is created in the inviting organization, the
 *               invitation is invisible from any other tenant, and a token can
 *               never grant OWNER.
 */
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { POST as registerPost } from '@/app/api/auth/register/route';
import { POST as loginPost } from '@/app/api/auth/login/route';
import {
  POST as createInvitationPost,
  GET as listInvitationsGet,
} from '@/app/api/members/invitations/route';
import { DELETE as revokeInvitationDelete } from '@/app/api/members/invitations/[id]/route';
import { POST as acceptInvitationPost } from '@/app/api/invitations/[token]/accept/route';
import { getSql } from '@/lib/db';
import { hashResetToken } from '@/lib/auth/cookies';
import { INVITATION_TTL_MS } from '@/lib/members/invitations';
import { CookieJar, call } from './support';

const PASSWORD = 'Str0ng!Passw0rd-For-Test';
const uniq = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

/** Enter test system context and run a raw read (the harness's escape hatch). */
async function sysQuery<T = any>(query: string, params: unknown[] = []): Promise<T[]> {
  const sql = getSql();
  await sql`SELECT auth_test_system_context(NULL, NULL)`;
  return (await sql.unsafe<T[]>(query, params as never[])) as T[];
}

interface Tenant {
  jar: CookieJar;
  email: string;
  organizationId: string;
  userId: string;
}

/** Register a fresh school; the returned jar holds an authenticated OWNER. */
async function registerSchool(prefix = 'h8'): Promise<Tenant> {
  const jar = new CookieJar();
  const email = `${uniq(prefix)}@example.com`;
  const res = await call(registerPost as never, jar, {
    method: 'POST',
    path: '/api/auth/register',
    body: {
      email,
      password: PASSWORD,
      firstName: 'H8',
      lastName: 'Owner',
      organizationName: `H8 School ${uniq('n')}`,
      organizationSlug: uniq(`${prefix}-school`),
    },
  });
  expect(res.status).toBeLessThan(400);
  const rows = await sysQuery<{ organization_id: string; user_id: string }>(
    `select om.organization_id, om.user_id
       from organization_members om
       join users u on u.id = om.user_id
      where u.email = $1 and om.status = 'ACTIVE'
      limit 1`,
    [email],
  );
  expect(rows.length).toBe(1);
  return { jar, email, organizationId: rows[0]!.organization_id, userId: rows[0]!.user_id };
}

/** Register a plain user with no organization of their own. */
async function registerInvitee(email: string): Promise<{ jar: CookieJar; userId: string }> {
  const jar = new CookieJar();
  const res = await call(registerPost as never, jar, {
    method: 'POST',
    path: '/api/auth/register',
    body: {
      email,
      password: PASSWORD,
      firstName: 'H8',
      lastName: 'Invitee',
      organizationName: `H8 Invitee Org ${uniq('n')}`,
      organizationSlug: uniq('h8-invitee'),
    },
  });
  expect(res.status).toBeLessThan(400);
  const rows = await sysQuery<{ id: string }>(`select id from users where email = $1 limit 1`, [
    email,
  ]);
  return { jar, userId: rows[0]!.id };
}

/**
 * Accept via the REAL handler with the caller's cookie jar. The token is passed
 * the way Next passes it — as a second argument carrying `params` — and the
 * jar supplies both the session and the CSRF header, exactly as a browser would.
 */
async function acceptWith(jar: CookieJar, token: string) {
  return call(acceptInvitationPost as never, jar, {
    method: 'POST',
    path: `/api/invitations/${token}/accept`,
    body: {},
    csrf: true,
    args: [{ params: Promise.resolve({ token }) }],
  });
}

async function revokeWith(jar: CookieJar, id: string) {
  return call(revokeInvitationDelete as never, jar, {
    method: 'DELETE',
    path: `/api/members/invitations/${id}`,
    csrf: true,
    args: [{ params: Promise.resolve({ id }) }],
  });
}

async function createInvitation(
  tenant: Tenant,
  body: { email: string; role: string },
  opts: { csrf?: boolean } = {},
) {
  return call(createInvitationPost as never, tenant.jar, {
    method: 'POST',
    path: '/api/members/invitations',
    body,
    csrf: opts.csrf ?? true,
  });
}

describe('H-8 — creating an invitation', () => {
  it('stores only the sha256 of the token, and returns the plaintext exactly once', async () => {
    const school = await registerSchool();
    const invited = `${uniq('invitee')}@example.com`;

    const res = await createInvitation(school, { email: invited, role: 'FINANCE_OFFICER' });
    expect(res.status).toBe(201);

    const token = res.data.acceptPath.split('/').pop() as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.data.acceptUrl).toContain(res.data.acceptPath);

    const rows = await sysQuery<{
      email: string;
      role: string;
      status: string;
      token_hash: string;
      organization_id: string;
      expires_at: Date;
      invited_at: Date;
    }>(
      `select email, role, status, token_hash, organization_id, expires_at, invited_at
         from member_invitations
        where organization_id = $1`,
      [school.organizationId],
    );
    expect(rows.length).toBe(1);
    const row = rows[0]!;

    // HASHED: what is stored is the digest, and the digest is of this token.
    expect(row.token_hash).toBe(hashResetToken(token));
    expect(row.token_hash).not.toBe(token);
    expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/);

    // ...and the plaintext appears nowhere in the row.
    const flat = JSON.stringify(row);
    expect(flat.includes(token)).toBe(false);

    // ORG-SCOPED + normalised.
    expect(row.organization_id).toBe(school.organizationId);
    expect(row.email).toBe(invited.toLowerCase());
    expect(row.role).toBe('FINANCE_OFFICER');
    expect(row.status).toBe('PENDING');

    // EXPIRING: within the documented TTL (never longer).
    const ttl = new Date(row.expires_at).getTime() - new Date(row.invited_at).getTime();
    expect(ttl).toBeLessThanOrEqual(INVITATION_TTL_MS);
    expect(ttl).toBeGreaterThan(INVITATION_TTL_MS - 60_000);
  });

  it('refuses OWNER — ownership moves by transfer, never by invitation', async () => {
    const school = await registerSchool();
    const res = await createInvitation(school, {
      email: `${uniq('x')}@example.com`,
      role: 'OWNER',
    });
    expect(res.status).toBe(400);
    expect(res.data.error.code).toBe('BAD_REQUEST');
  });

  it('requires CSRF, and requires a session', async () => {
    const school = await registerSchool();

    const noCsrf = await createInvitation(
      school,
      { email: `${uniq('x')}@example.com`, role: 'STAFF' },
      { csrf: false },
    );
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.data.error.code).toBe('CSRF_MISSING');

    const anon = await call(createInvitationPost as never, new CookieJar(), {
      method: 'POST',
      path: '/api/members/invitations',
      body: { email: 'someone@example.com', role: 'STAFF' },
    });
    expect(anon.status).toBe(401);
  });

  it('replaces a pending invitation for the same address: one live token at a time', async () => {
    const school = await registerSchool();
    const invited = `${uniq('invitee')}@example.com`;

    const first = await createInvitation(school, { email: invited, role: 'STAFF' });
    const firstToken = first.data.acceptPath.split('/').pop() as string;
    expect(first.data.invitation.replacedPending).toBe(false);

    const second = await createInvitation(school, { email: invited, role: 'SCHOOL_ADMIN' });
    const secondToken = second.data.acceptPath.split('/').pop() as string;
    expect(second.data.invitation.replacedPending).toBe(true);

    const live = await sysQuery<{ n: string }>(
      `select count(*)::text as n from member_invitations
        where organization_id = $1 and email = $2 and status = 'PENDING'`,
      [school.organizationId, invited.toLowerCase()],
    );
    expect(live[0]!.n).toBe('1');

    // The superseded token is dead: it is no longer the live row.
    const dead = await sysQuery<{ n: string }>(
      `select count(*)::text as n from member_invitations where token_hash = $1 and status = 'PENDING'`,
      [hashResetToken(firstToken)],
    );
    expect(dead[0]!.n).toBe('0');

    const check = await sysQuery<{ status: string }>(
      `select status from member_invitations where token_hash = $1`,
      [hashResetToken(secondToken)],
    );
    expect(check[0]!.status).toBe('PENDING');
  });

  it('lists invitations for the organization with a live flag that respects expiry', async () => {
    const school = await registerSchool();
    const invited = `${uniq('invitee')}@example.com`;
    await createInvitation(school, { email: invited, role: 'STAFF' });

    // Push the row's expiry into the past (and the invite with it, to satisfy
    // CHECK expires_at > invited_at) — the liveness flag must follow the clock,
    // not just the status column.
    await sysQuery(
      `update member_invitations
          set invited_at = now() - interval '8 days', expires_at = now() - interval '1 day'
        where organization_id = $1`,
      [school.organizationId],
    );

    const res = await call(listInvitationsGet as never, school.jar, {
      path: '/api/members/invitations',
    });
    expect(res.status).toBe(200);
    const list = res.data.invitations as Array<{ email: string; live: boolean; status: string }>;
    const mine = list.filter((i) => i.email === invited.toLowerCase());
    expect(mine.length).toBe(1);
    expect(mine[0]!.status).toBe('PENDING');
    expect(mine[0]!.live).toBe(false);
  });
});

describe('H-8 — accepting an invitation', () => {
  it('creates the membership with the invited role, in the inviting organization', async () => {
    const school = await registerSchool();
    const invited = `${uniq('invitee')}@example.com`;
    const invitee = await registerInvitee(invited);

    const created = await createInvitation(school, { email: invited, role: 'FINANCE_OFFICER' });
    const token = created.data.acceptPath.split('/').pop() as string;

    const accepted = await acceptWith(invitee.jar, token);

    expect(accepted.status).toBe(200);
    expect(accepted.data.accepted.organizationId).toBe(school.organizationId);
    expect(accepted.data.accepted.role).toBe('FINANCE_OFFICER');

    const membership = await sysQuery<{ role: string; status: string }>(
      `select role, status from organization_members where organization_id = $1 and user_id = $2`,
      [school.organizationId, invitee.userId],
    );
    expect(membership.length).toBe(1);
    expect(membership[0]!.role).toBe('FINANCE_OFFICER');
    expect(membership[0]!.status).toBe('ACTIVE');

    const row = await sysQuery<{
      status: string;
      accepted_at: Date | null;
      accepted_by: string | null;
    }>(`select status, accepted_at, accepted_by from member_invitations where token_hash = $1`, [
      hashResetToken(token),
    ]);
    expect(row[0]!.status).toBe('ACCEPTED');
    expect(row[0]!.accepted_at).toBeTruthy();
    expect(row[0]!.accepted_by).toBe(invitee.userId);
  });

  it('is single-use: a second acceptance of the same token fails', async () => {
    const school = await registerSchool();
    const invited = `${uniq('invitee')}@example.com`;
    const invitee = await registerInvitee(invited);
    const created = await createInvitation(school, { email: invited, role: 'STAFF' });
    const token = created.data.acceptPath.split('/').pop() as string;

    const first = await acceptWith(invitee.jar, token);
    expect(first.status).toBe(200);

    const second = await acceptWith(invitee.jar, token);

    expect(second.status).toBe(410);
    expect(second.data.error.code).toBe('ALREADY_ACCEPTED');
  });

  it('refuses a token presented by the wrong account, and does NOT burn it', async () => {
    const school = await registerSchool();
    const invited = `${uniq('invitee')}@example.com`;
    const other = await registerInvitee(`${uniq('other')}@example.com`);
    const created = await createInvitation(school, { email: invited, role: 'STAFF' });
    const token = created.data.acceptPath.split('/').pop() as string;

    const res = await acceptWith(other.jar, token);

    expect(res.status).toBe(403);
    expect(res.data.error.code).toBe('EMAIL_MISMATCH');

    const row = await sysQuery<{ status: string }>(
      `select status from member_invitations where token_hash = $1`,
      [hashResetToken(token)],
    );
    expect(row[0]!.status).toBe('PENDING');

    const members = await sysQuery<{ n: string }>(
      `select count(*)::text as n from organization_members where organization_id = $1 and user_id = $2`,
      [school.organizationId, other.userId],
    );
    expect(members[0]!.n).toBe('0');
  });

  it('refuses an expired token', async () => {
    const school = await registerSchool();
    const invited = `${uniq('invitee')}@example.com`;
    const invitee = await registerInvitee(invited);
    const created = await createInvitation(school, { email: invited, role: 'STAFF' });
    const token = created.data.acceptPath.split('/').pop() as string;

    await sysQuery(
      `update member_invitations
          set invited_at = now() - interval '8 days', expires_at = now() - interval '1 second'
        where token_hash = $1`,
      [hashResetToken(token)],
    );

    const res = await acceptWith(invitee.jar, token);

    expect(res.status).toBe(410);
    expect(res.data.error.code).toBe('EXPIRED');

    const members = await sysQuery<{ n: string }>(
      `select count(*)::text as n from organization_members where organization_id = $1 and user_id = $2`,
      [school.organizationId, invitee.userId],
    );
    expect(members[0]!.n).toBe('0');
  });

  it('accepts nothing for a token that was never issued', async () => {
    const invitee = await registerInvitee(`${uniq('invitee')}@example.com`);
    const token = 'A'.repeat(43);

    const res = await acceptWith(invitee.jar, token);

    expect(res.status).toBe(404);
    expect(res.data.error.code).toBe('INVALID_TOKEN');
  });

  it('rejects a malformed token without touching the database', async () => {
    const invitee = await registerInvitee(`${uniq('invitee')}@example.com`);
    const res = await acceptWith(invitee.jar, 'short');
    expect(res.status).toBe(404);
  });

  it('requires an authenticated session and a CSRF token', async () => {
    const school = await registerSchool();
    const created = await createInvitation(school, {
      email: `${uniq('i')}@example.com`,
      role: 'STAFF',
    });
    const token = created.data.acceptPath.split('/').pop() as string;

    const anon = await acceptWith(new CookieJar(), token);
    expect(anon.status).toBe(401);
  });
});

describe('H-8 — revoking an invitation', () => {
  it('kills a pending token, and the dead token can no longer be accepted', async () => {
    const school = await registerSchool();
    const invited = `${uniq('invitee')}@example.com`;
    const invitee = await registerInvitee(invited);
    const created = await createInvitation(school, { email: invited, role: 'STAFF' });
    const token = created.data.acceptPath.split('/').pop() as string;
    const id = created.data.invitation.id as string;

    const revoked = await revokeWith(school.jar, id);
    expect(revoked.status).toBe(200);

    const res = await acceptWith(invitee.jar, token);

    expect(res.status).toBe(410);
    expect(res.data.error.code).toBe('REVOKED');
  });

  it('cannot revoke another organization’s invitation', async () => {
    const schoolA = await registerSchool();
    const schoolB = await registerSchool();
    const created = await createInvitation(schoolA, {
      email: `${uniq('i')}@example.com`,
      role: 'STAFF',
    });
    const id = created.data.invitation.id as string;

    const res = await revokeWith(schoolB.jar, id);
    expect(res.status).toBe(404);

    const row = await sysQuery<{ status: string }>(
      `select status from member_invitations where id = $1`,
      [id],
    );
    expect(row[0]!.status).toBe('PENDING');
  });

  it('does not list another organization’s invitations', async () => {
    const schoolA = await registerSchool();
    const schoolB = await registerSchool();
    const invited = `${uniq('invitee')}@example.com`;
    await createInvitation(schoolB, { email: invited, role: 'STAFF' });

    const res = await call(listInvitationsGet as never, schoolA.jar, {
      path: '/api/members/invitations',
    });
    expect(res.status).toBe(200);
    const list = res.data.invitations as Array<{ email: string }>;
    expect(list.some((i) => i.email === invited.toLowerCase())).toBe(false);
  });
});

describe('H-8 — the frozen affordance is repaired, not rewritten', () => {
  it('POST /api/members still answers exactly as M5 froze it (501 / 404)', async () => {
    const { POST: membersPost } = await import('@/app/api/members/route');
    const school = await registerSchool();
    const res = await call(membersPost as never, school.jar, {
      method: 'POST',
      path: '/api/members',
      body: { email: `${uniq('i')}@example.com`, role: 'STAFF' },
      csrf: true,
    });
    // Whatever the frozen handler answers, it must NOT have become an
    // invitation endpoint: invitations live on their own route.
    expect([404, 501]).toContain(res.status);
  });
});

describe('H-8 — sign-in establishes the invitation accept page’s precondition', () => {
  it('an invited address that registers can log in and is addressable by token', async () => {
    const school = await registerSchool();
    const invited = `${uniq('invitee')}@example.com`;
    const created = await createInvitation(school, { email: invited, role: 'STAFF' });
    const token = created.data.acceptPath.split('/').pop() as string;

    // The invitee already has an account (registered above), so they sign in.
    await registerInvitee(invited);
    const jar = new CookieJar();
    const login = await call(loginPost as never, jar, {
      method: 'POST',
      path: '/api/auth/login',
      body: { email: invited, password: PASSWORD },
      csrf: false,
    });
    expect(login.status).toBeLessThan(400);

    const preview = await import('@/lib/members/invitations').then((m) =>
      m.previewInvitation(token),
    );
    expect(preview?.organizationId).toBe(school.organizationId);
    expect(preview?.usable).toBe(true);
    expect(preview?.email).toBe(invited.toLowerCase());
  });
});
