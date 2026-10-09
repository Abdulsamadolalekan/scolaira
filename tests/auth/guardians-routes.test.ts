// @vitest-environment node
/**
 * Phase 3 — guardian routes, HTTP contract.
 *
 * The database suite (`tests/db/guardians.test.ts`) proves the invariants; this
 * suite proves the product surface that a school actually uses: who may call it,
 * what it refuses, what it does twice if it is asked twice, and whether one
 * school can reach another school's contacts.
 *
 * The workflow under test is the one the audit found missing entirely — a school
 * being able to record WHO IS RESPONSIBLE FOR A CHILD, and have that contact
 * resolved deterministically when money is outstanding. Before this phase there
 * was no insert into `guardians` or `student_guardians` anywhere in `app/`,
 * `lib/`, `scripts/` or `e2e/`, so every collection reminder had no addressee.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { call, CookieJar } from './support';
import { POST as registerPost } from '@/app/api/auth/register/route';
import { GET as meGet } from '@/app/api/auth/me/route';
import { POST as selectOrganizationPost } from '@/app/api/auth/select-organization/route';
import { GET as guardiansGet, POST as guardiansPost } from '@/app/api/guardians/route';
import {
  GET as guardianGet,
  PATCH as guardianPatch,
  DELETE as guardianDelete,
} from '@/app/api/guardians/[id]/route';
import {
  GET as studentGuardiansGet,
  POST as studentGuardiansPost,
} from '@/app/api/students/[id]/guardians/route';
import {
  PATCH as linkPatch,
  DELETE as linkDelete,
} from '@/app/api/students/[id]/guardians/[guardianId]/route';
import { getSql } from '@/lib/db';
import {
  testDb,
  enableSavepointTransactionsForTest,
  disableSavepointTransactionsForTest,
} from '../setup-db';
import { withSystemContext } from '@/lib/db/tenant';
import { auditEvents } from '@/lib/db/schema';
import type { TenantCtx, UUID } from '@/lib/db/repo/_context';

function unique(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function key(): string {
  return randomUUID();
}

/** A school with one student, signed in as its owner. */
async function schoolWithStudent(): Promise<{ jar: CookieJar; ctx: TenantCtx; studentId: UUID }> {
  const jar = new CookieJar();
  await call(registerPost as never, jar, {
    method: 'POST',
    path: '/api/auth/register',
    body: {
      email: `${unique('g').toLowerCase()}@example.test`,
      password: 'Guardian-route-password-A1!',
      firstName: 'G',
      lastName: 'Owner',
      organizationName: unique('G School'),
      organizationSlug: unique('g-school').toLowerCase(),
    },
  });
  const me = await call(meGet as never, jar, { method: 'GET', path: '/api/auth/me' });
  expect(me.status).toBe(200);
  const organizationId = me.data.activeOrganizationId as UUID;
  const userId = me.data.user.id as UUID;
  const studentId = randomUUID() as UUID;

  await withSystemContext(organizationId, userId, async () => {
    const sql = getSql();
    await sql`INSERT INTO students (id, student_id, first_name, last_name, status)
              VALUES (${studentId}::uuid, 'G-ROUTE', 'Route', 'Child', 'ACTIVE')`;
  });

  await getSql()`SELECT set_tenant_context(${organizationId}::uuid, ${userId}::uuid)`;
  return { jar, ctx: { organizationId, userId }, studentId };
}

/** A STAFF member of the same school — authenticated, but without guardian.manage. */
async function staffSessionFor(ctx: TenantCtx): Promise<CookieJar> {
  const jar = new CookieJar();
  await call(registerPost as never, jar, {
    method: 'POST',
    path: '/api/auth/register',
    body: {
      email: `${unique('g-staff').toLowerCase()}@example.test`,
      password: 'Guardian-staff-password-A1!',
      firstName: 'G',
      lastName: 'Staff',
      organizationName: unique('G Staff School'),
      organizationSlug: unique('g-staff-school').toLowerCase(),
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

function dynamic(
  handler: Function,
  jar: CookieJar,
  method: string,
  path: string,
  params: Record<string, string>,
  body?: unknown,
  headers: HeadersInit = {},
  csrf = true,
) {
  return call(handler as never, jar, {
    method,
    path,
    body,
    headers,
    csrf,
    args: [{ params: Promise.resolve(params) }],
  });
}

describe('Phase 3 — guardian routes', () => {
  afterEach(() => disableSavepointTransactionsForTest());

  describe('access control', () => {
    it('refuses an unauthenticated caller', async () => {
      const anonymous = new CookieJar();
      const res = await call(guardiansGet as never, anonymous, {
        method: 'GET',
        path: '/api/guardians',
      });
      expect([401, 403]).toContain(res.status);
    });

    it('refuses an authenticated member whose role cannot manage guardians', async () => {
      enableSavepointTransactionsForTest();
      const { ctx } = await schoolWithStudent();
      const staff = await staffSessionFor(ctx);
      const res = await call(guardiansGet as never, staff, {
        method: 'GET',
        path: '/api/guardians',
      });
      expect(res.status).toBe(403);
    });

    it('refuses a write without a CSRF token', async () => {
      enableSavepointTransactionsForTest();
      const { jar } = await schoolWithStudent();
      const res = await call(guardiansPost as never, jar, {
        method: 'POST',
        path: '/api/guardians',
        csrf: false,
        body: { firstName: 'No', lastName: 'Csrf' },
      });
      expect(res.status).toBe(403);
    });
  });

  describe('creating a guardian', () => {
    it('creates and returns the guardian, normalising the phone', async () => {
      enableSavepointTransactionsForTest();
      const { jar } = await schoolWithStudent();
      const res = await call(guardiansPost as never, jar, {
        method: 'POST',
        path: '/api/guardians',
        csrf: true,
        headers: { 'Idempotency-Key': key() },
        body: { firstName: 'Ngozi', lastName: 'Okonkwo', phone: '0803 555 0142' },
      });

      expect(res.status).toBe(201);
      expect(res.data.guardian.firstName).toBe('Ngozi');
      expect(res.data.guardian.phone).toBe('08035550142');
      expect(res.data.guardian.organizationId).toBeTruthy();
    });

    it('rejects a guardian with no name', async () => {
      enableSavepointTransactionsForTest();
      const { jar } = await schoolWithStudent();
      const res = await call(guardiansPost as never, jar, {
        method: 'POST',
        path: '/api/guardians',
        csrf: true,
        headers: { 'Idempotency-Key': key() },
        body: { firstName: '', lastName: 'Nameless' },
      });
      expect(res.status).toBe(400);
    });

    it('does not create the guardian twice when the same key is replayed', async () => {
      // Duplicate protection matters here: the realistic failure is a parent
      // form submitted twice over a slow connection, not a malicious replay.
      enableSavepointTransactionsForTest();
      const { jar } = await schoolWithStudent();
      const idem = key();
      const body = { firstName: 'Replay', lastName: 'Once', phone: '08030000111' };

      const first = await call(guardiansPost as never, jar, {
        method: 'POST',
        path: '/api/guardians',
        csrf: true,
        headers: { 'Idempotency-Key': idem },
        body,
      });
      const second = await call(guardiansPost as never, jar, {
        method: 'POST',
        path: '/api/guardians',
        csrf: true,
        headers: { 'Idempotency-Key': idem },
        body,
      });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.data.guardian.id).toBe(first.data.guardian.id);

      const list = await call(guardiansGet as never, jar, {
        method: 'GET',
        path: '/api/guardians',
      });
      const samePhone = list.data.guardians.filter(
        (g: { phone: string }) => g.phone === '08030000111',
      );
      expect(samePhone).toHaveLength(1);
    });

    it('records an audit event for the creation', async () => {
      enableSavepointTransactionsForTest();
      const { jar, ctx } = await schoolWithStudent();
      const res = await call(guardiansPost as never, jar, {
        method: 'POST',
        path: '/api/guardians',
        csrf: true,
        headers: { 'Idempotency-Key': key() },
        body: { firstName: 'Audit', lastName: 'Me' },
      });
      expect(res.status).toBe(201);

      // A finished request resets the connection's tenant GUCs, so the read that
      // proves the audit trail must re-establish the context it is auditing in.
      await getSql()`SELECT set_tenant_context(${ctx.organizationId}::uuid, ${ctx.userId}::uuid)`;
      const events = await testDb()
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.entityId, res.data.guardian.id));
      expect(events.length).toBeGreaterThan(0);
      expect(events[0]!.action).toBe('guardian.create');
      expect(events[0]!.organizationId).toBe(ctx.organizationId);
    });

    it('lists guardians and reports how many cannot be reached', async () => {
      enableSavepointTransactionsForTest();
      const { jar } = await schoolWithStudent();
      await call(guardiansPost as never, jar, {
        method: 'POST',
        path: '/api/guardians',
        csrf: true,
        headers: { 'Idempotency-Key': key() },
        body: { firstName: 'Has', lastName: 'Phone', phone: '08030000222' },
      });
      await call(guardiansPost as never, jar, {
        method: 'POST',
        path: '/api/guardians',
        csrf: true,
        headers: { 'Idempotency-Key': key() },
        body: { firstName: 'No', lastName: 'Phone' },
      });

      const res = await call(guardiansGet as never, jar, { method: 'GET', path: '/api/guardians' });
      expect(res.status).toBe(200);
      expect(res.data.total).toBe(2);
      expect(res.data.withoutContact).toBe(1);
    });
  });

  describe('linking a guardian to a student', () => {
    it('creates and links in one step, and makes the first guardian primary', async () => {
      // A student with exactly one guardian and no primary is a state that only
      // creates ambiguity later, when a reminder must choose somebody.
      enableSavepointTransactionsForTest();
      const { jar, studentId } = await schoolWithStudent();
      const res = await dynamic(
        studentGuardiansPost,
        jar,
        'POST',
        `/api/students/${studentId}/guardians`,
        { id: studentId },
        { firstName: 'Ada', lastName: 'Eze', phone: '08030000333', relationship: 'PARENT' },
        { 'Idempotency-Key': key() },
      );

      expect(res.status).toBe(201);
      expect(res.data.guardians).toHaveLength(1);
      expect(res.data.guardians[0].isPrimary).toBe(true);
      expect(res.data.guardians[0].relationship).toBe('PARENT');
    });

    it('links an existing guardian by id without creating a new one', async () => {
      enableSavepointTransactionsForTest();
      const { jar, studentId } = await schoolWithStudent();
      const created = await call(guardiansPost as never, jar, {
        method: 'POST',
        path: '/api/guardians',
        csrf: true,
        headers: { 'Idempotency-Key': key() },
        body: { firstName: 'Existing', lastName: 'Guardian', phone: '08030000444' },
      });

      const linked = await dynamic(
        studentGuardiansPost,
        jar,
        'POST',
        `/api/students/${studentId}/guardians`,
        { id: studentId },
        { guardianId: created.data.guardian.id, relationship: 'GUARDIAN' },
        { 'Idempotency-Key': key() },
      );
      expect(linked.status).toBe(201);
      expect(linked.data.guardians[0].id).toBe(created.data.guardian.id);
      expect(linked.data.guardians[0].relationship).toBe('GUARDIAN');

      const list = await call(guardiansGet as never, jar, {
        method: 'GET',
        path: '/api/guardians',
      });
      expect(list.data.total).toBe(1);
    });

    it('reports the resolved primary contact, and says plainly when there is none', async () => {
      enableSavepointTransactionsForTest();
      const { jar, studentId } = await schoolWithStudent();

      const empty = await dynamic(
        studentGuardiansGet,
        jar,
        'GET',
        `/api/students/${studentId}/guardians`,
        { id: studentId },
      );
      expect(empty.status).toBe(200);
      expect(empty.data.primaryContact).toBeNull();
      expect(empty.data.hasReachableContact).toBe(false);

      await dynamic(
        studentGuardiansPost,
        jar,
        'POST',
        `/api/students/${studentId}/guardians`,
        { id: studentId },
        { firstName: 'Contact', lastName: 'Able', phone: '08030000555' },
        { 'Idempotency-Key': key() },
      );

      const after = await dynamic(
        studentGuardiansGet,
        jar,
        'GET',
        `/api/students/${studentId}/guardians`,
        { id: studentId },
      );
      expect(after.data.primaryContact.lastName).toBe('Able');
      expect(after.data.hasReachableContact).toBe(true);
    });

    it('distinguishes a guardian WHO EXISTS from one who can actually be reached', async () => {
      // The distinction Phase 6 depends on: never claim a reminder can be sent
      // when there is no phone and no email.
      enableSavepointTransactionsForTest();
      const { jar, studentId } = await schoolWithStudent();
      await dynamic(
        studentGuardiansPost,
        jar,
        'POST',
        `/api/students/${studentId}/guardians`,
        { id: studentId },
        { firstName: 'Silent', lastName: 'Contact' },
        { 'Idempotency-Key': key() },
      );

      const res = await dynamic(
        studentGuardiansGet,
        jar,
        'GET',
        `/api/students/${studentId}/guardians`,
        { id: studentId },
      );
      expect(res.data.guardians).toHaveLength(1);
      expect(res.data.primaryContact).not.toBeNull();
      expect(res.data.hasReachableContact).toBe(false);
    });

    it('404s for a student in another school', async () => {
      enableSavepointTransactionsForTest();
      const a = await schoolWithStudent();
      const b = await schoolWithStudent();
      const res = await dynamic(
        studentGuardiansGet,
        a.jar,
        'GET',
        `/api/students/${b.studentId}/guardians`,
        { id: b.studentId },
      );
      expect(res.status).toBe(404);
    });
  });

  describe('changing the responsible contact', () => {
    it('promotes a second guardian and demotes the first', async () => {
      enableSavepointTransactionsForTest();
      const { jar, studentId } = await schoolWithStudent();
      const first = await dynamic(
        studentGuardiansPost,
        jar,
        'POST',
        `/api/students/${studentId}/guardians`,
        { id: studentId },
        { firstName: 'First', lastName: 'Primary', phone: '08030000666' },
        { 'Idempotency-Key': key() },
      );
      expect(first.data.guardians[0].isPrimary).toBe(true);

      const second = await dynamic(
        studentGuardiansPost,
        jar,
        'POST',
        `/api/students/${studentId}/guardians`,
        { id: studentId },
        { firstName: 'Second', lastName: 'Parent', phone: '08030000777' },
        { 'Idempotency-Key': key() },
      );
      expect(second.data.guardians.filter((g: { isPrimary: boolean }) => g.isPrimary)).toHaveLength(
        1,
      );

      const secondId = second.data.guardians.find(
        (g: { lastName: string }) => g.lastName === 'Parent',
      ).id;
      const promoted = await dynamic(
        linkPatch,
        jar,
        'PATCH',
        `/api/students/${studentId}/guardians/${secondId}`,
        { id: studentId, guardianId: secondId },
        { isPrimary: true },
        { 'Idempotency-Key': key() },
      );

      expect(promoted.status).toBe(200);
      const primaries = promoted.data.guardians.filter((g: { isPrimary: boolean }) => g.isPrimary);
      expect(primaries).toHaveLength(1);
      expect(primaries[0].lastName).toBe('Parent');
    });

    it('changes the relationship of an existing link', async () => {
      enableSavepointTransactionsForTest();
      const { jar, studentId } = await schoolWithStudent();
      const linked = await dynamic(
        studentGuardiansPost,
        jar,
        'POST',
        `/api/students/${studentId}/guardians`,
        { id: studentId },
        { firstName: 'Rel', lastName: 'Ated', relationship: 'PARENT' },
        { 'Idempotency-Key': key() },
      );
      const guardianId = linked.data.guardians[0].id;

      const patched = await dynamic(
        linkPatch,
        jar,
        'PATCH',
        `/api/students/${studentId}/guardians/${guardianId}`,
        { id: studentId, guardianId },
        { relationship: 'SPONSOR' },
        { 'Idempotency-Key': key() },
      );
      expect(patched.status).toBe(200);
      expect(patched.data.guardians[0].relationship).toBe('SPONSOR');
    });

    it('promotes a remaining guardian when the primary is unlinked', async () => {
      // Otherwise a student could keep guardians but lose the responsible
      // contact, which is the exact ambiguity this phase removes.
      enableSavepointTransactionsForTest();
      const { jar, studentId } = await schoolWithStudent();
      await dynamic(
        studentGuardiansPost,
        jar,
        'POST',
        `/api/students/${studentId}/guardians`,
        { id: studentId },
        { firstName: 'Primary', lastName: 'Gone', phone: '08030000888' },
        { 'Idempotency-Key': key() },
      );
      const second = await dynamic(
        studentGuardiansPost,
        jar,
        'POST',
        `/api/students/${studentId}/guardians`,
        { id: studentId },
        { firstName: 'Secondary', lastName: 'Stays', phone: '08030000999' },
        { 'Idempotency-Key': key() },
      );
      const primaryId = second.data.guardians.find(
        (g: { lastName: string }) => g.lastName === 'Gone',
      ).id;

      const removed = await dynamic(
        linkDelete,
        jar,
        'DELETE',
        `/api/students/${studentId}/guardians/${primaryId}`,
        { id: studentId, guardianId: primaryId },
        undefined,
        { 'Idempotency-Key': key() },
      );
      expect(removed.status).toBe(200);
      expect(removed.data.promotedGuardianId).toBeTruthy();
      const remaining = removed.data.guardians;
      expect(remaining).toHaveLength(1);
      expect(remaining[0].lastName).toBe('Stays');
      expect(remaining[0].isPrimary).toBe(true);
    });
  });

  describe('editing and removing a guardian record', () => {
    it('updates contact details and clears a field on explicit null', async () => {
      enableSavepointTransactionsForTest();
      const { jar } = await schoolWithStudent();
      const created = await call(guardiansPost as never, jar, {
        method: 'POST',
        path: '/api/guardians',
        csrf: true,
        headers: { 'Idempotency-Key': key() },
        body: {
          firstName: 'Edit',
          lastName: 'Me',
          phone: '08030001010',
          email: 'edit@example.com',
        },
      });
      const id = created.data.guardian.id;

      const patched = await dynamic(
        guardianPatch,
        jar,
        'PATCH',
        `/api/guardians/${id}`,
        { id },
        { phone: null },
        { 'Idempotency-Key': key() },
      );
      expect(patched.status).toBe(200);
      expect(patched.data.guardian.phone).toBeNull();
      expect(patched.data.guardian.email).toBe('edit@example.com');
    });

    it('shows the children a guardian is responsible for', async () => {
      enableSavepointTransactionsForTest();
      const { jar, studentId } = await schoolWithStudent();
      const created = await call(guardiansPost as never, jar, {
        method: 'POST',
        path: '/api/guardians',
        csrf: true,
        headers: { 'Idempotency-Key': key() },
        body: { firstName: 'Multi', lastName: 'Child', phone: '08030001111' },
      });
      const id = created.data.guardian.id;
      await dynamic(
        studentGuardiansPost,
        jar,
        'POST',
        `/api/students/${studentId}/guardians`,
        { id: studentId },
        { guardianId: id },
        { 'Idempotency-Key': key() },
      );

      const detail = await dynamic(guardianGet, jar, 'GET', `/api/guardians/${id}`, { id });
      expect(detail.status).toBe(200);
      expect(detail.data.students).toHaveLength(1);
      expect(detail.data.students[0].studentId).toBe(studentId);
    });

    it('deletes a guardian and unlinks them from every child', async () => {
      enableSavepointTransactionsForTest();
      const { jar, studentId } = await schoolWithStudent();
      const created = await call(guardiansPost as never, jar, {
        method: 'POST',
        path: '/api/guardians',
        csrf: true,
        headers: { 'Idempotency-Key': key() },
        body: { firstName: 'Delete', lastName: 'Me' },
      });
      const id = created.data.guardian.id;
      await dynamic(
        studentGuardiansPost,
        jar,
        'POST',
        `/api/students/${studentId}/guardians`,
        { id: studentId },
        { guardianId: id },
        { 'Idempotency-Key': key() },
      );

      const deleted = await dynamic(
        guardianDelete,
        jar,
        'DELETE',
        `/api/guardians/${id}`,
        { id },
        undefined,
        { 'Idempotency-Key': key() },
      );
      expect(deleted.status).toBe(200);
      expect(deleted.data.ok).toBe(true);
      expect(deleted.data.unlinkedStudentCount).toBe(1);

      const after = await dynamic(
        studentGuardiansGet,
        jar,
        'GET',
        `/api/students/${studentId}/guardians`,
        { id: studentId },
      );
      expect(after.data.guardians).toHaveLength(0);
      expect(after.data.primaryContact).toBeNull();
    });
  });

  describe('tenant isolation over HTTP', () => {
    it('hides another school\u2019s guardian from reads, edits and deletes', async () => {
      enableSavepointTransactionsForTest();
      const a = await schoolWithStudent();
      const b = await schoolWithStudent();

      const created = await call(guardiansPost as never, a.jar, {
        method: 'POST',
        path: '/api/guardians',
        csrf: true,
        headers: { 'Idempotency-Key': key() },
        body: { firstName: 'OrgA', lastName: 'Private', phone: '08030001212' },
      });
      const idA = created.data.guardian.id;

      const readB = await dynamic(guardianGet, b.jar, 'GET', `/api/guardians/${idA}`, { id: idA });
      expect(readB.status).toBe(404);

      const patchB = await dynamic(
        guardianPatch,
        b.jar,
        'PATCH',
        `/api/guardians/${idA}`,
        { id: idA },
        { firstName: 'Stolen' },
        { 'Idempotency-Key': key() },
      );
      expect(patchB.status).toBe(404);

      const deleteB = await dynamic(
        guardianDelete,
        b.jar,
        'DELETE',
        `/api/guardians/${idA}`,
        { id: idA },
        undefined,
        { 'Idempotency-Key': key() },
      );
      expect(deleteB.status).toBe(404);

      // Org B's own list must not contain it either.
      const listB = await call(guardiansGet as never, b.jar, {
        method: 'GET',
        path: '/api/guardians',
      });
      expect(listB.data.guardians.map((g: { id: string }) => g.id)).not.toContain(idA);

      // And org A still sees it intact.
      const readA = await dynamic(guardianGet, a.jar, 'GET', `/api/guardians/${idA}`, { id: idA });
      expect(readA.status).toBe(200);
      expect(readA.data.guardian.firstName).toBe('OrgA');
    });

    it('cannot attach another school\u2019s guardian to its own student', async () => {
      enableSavepointTransactionsForTest();
      const a = await schoolWithStudent();
      const b = await schoolWithStudent();
      const created = await call(guardiansPost as never, a.jar, {
        method: 'POST',
        path: '/api/guardians',
        csrf: true,
        headers: { 'Idempotency-Key': key() },
        body: { firstName: 'Foreign', lastName: 'Guardian' },
      });

      const res = await dynamic(
        studentGuardiansPost,
        b.jar,
        'POST',
        `/api/students/${b.studentId}/guardians`,
        { id: b.studentId },
        { guardianId: created.data.guardian.id },
        { 'Idempotency-Key': key() },
      );
      expect(res.status).toBe(404);
    });
  });
});
