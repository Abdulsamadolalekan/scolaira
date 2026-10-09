// @vitest-environment node
/**
 * Phase 3 — the guardian write path, at the database layer.
 *
 * Until this phase `guardians` and `student_guardians` had RLS, indexes and an
 * enum but no writer anywhere in the product: the debtors register, the reminder
 * composer and the statement all READ guardian data and fell back to '—'. A
 * school could see that a parent was missing and had no way to supply one, which
 * made every collection reminder unaddressable. These tests cover the write path
 * that closes that gap, and they cover it where it is actually enforced — under
 * the runtime role, with real RLS, the M9 tenant guard trigger, and the real
 * unique indexes.
 *
 * The invariants under test are the ones the module header claims, so a change
 * that quietly weakens one is a red test rather than a silent regression:
 *
 *   G1  a guardian is a named contact (first + last name required)
 *   G2  at most ONE primary guardian per student — app-enforced AND,
 *       since migration 0051, database-enforced
 *   G3  a student and a guardian must belong to the caller's organization
 *   G4  a (student, guardian) pair is unique; re-linking updates instead of failing
 *   G5  soft-deleted guardians are excluded from every read
 *
 * The G2 database test is the important one. Before 0051 the database accepted
 * two primaries for one student — measured, not assumed — which made
 * `resolvePrimaryContact()` (the function collections uses to decide WHO TO
 * TELEPHONE) non-deterministic. That test inserts directly through SQL, bypassing
 * the repository entirely, because a guarantee that only holds when callers
 * behave is not a guarantee.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { enableSavepointTransactionsForTest, testDb, testSql } from '../setup-db';
import { seedTwoOrgs } from '../support/seed';
import { withSystemContext } from '@/lib/db/tenant';
import { guardians, studentGuardians } from '@/lib/db/schema';
import * as guardianRepo from '@/lib/db/repo/guardians';
import * as remindersRepo from '@/lib/db/repo/reminders';
import { RepoInvariantError } from '@/lib/db/repo/_context';
import type { TenantCtx, UUID } from '@/lib/db/repo/_context';

// The repository's link()/setPrimary()/softDelete() open their own transaction,
// which cannot nest inside the harness's per-test BEGIN. The savepoint shim maps
// them onto nested savepoints so isolation still holds.
beforeEach(() => enableSavepointTransactionsForTest());

/**
 * Establish a REAL tenant context and return the matching application ctx.
 *
 * The repo always sends `ctx.organizationId` explicitly, but the database will
 * not accept the row on that alone: `trg_set_org_from_context()` OVERWRITES
 * `organization_id` from the ambient GUC and raises `not_null_violation` when no
 * context is set. That trigger is the reason a caller cannot write into another
 * tenant by simply naming it, so the tests must do what the app does — set the
 * context, then call the repo — rather than assert a weaker path.
 */
async function activate(organizationId: UUID, userId: UUID): Promise<TenantCtx> {
  await testSql()`SELECT set_tenant_context(${organizationId}::uuid, ${userId}::uuid)`;
  return { organizationId, userId };
}

/** Run `fn` expecting the database to refuse it, without poisoning the test txn. */
async function expectPgFailure(fn: () => Promise<unknown>, codes: string[] = []): Promise<any> {
  const savepoint = `g_${randomUUID().replaceAll('-', '')}`;
  const sql = testSql();
  await sql.unsafe(`SAVEPOINT ${savepoint}`);
  let error: any;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }
  await sql.unsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await sql.unsafe(`RELEASE SAVEPOINT ${savepoint}`);
  expect(error, 'expected the database to refuse this operation').toBeTruthy();
  if (codes.length > 0) {
    const code = error.code ?? error.cause?.code ?? error.originalError?.code;
    expect(codes).toContain(code);
  }
  return error;
}

describe('Phase 3 — G1: a guardian is a named contact', () => {
  it('refuses a guardian with no name, including whitespace-only', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);

    await expect(
      guardianRepo.create(testDb(), ctx, { firstName: '   ', lastName: 'Bello' }),
    ).rejects.toBeInstanceOf(RepoInvariantError);
    await expect(
      guardianRepo.create(testDb(), ctx, { firstName: 'Ngozi', lastName: '' }),
    ).rejects.toBeInstanceOf(RepoInvariantError);
  });

  it('trims names, normalises the phone and lowercases the email', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);

    const created = await guardianRepo.create(testDb(), ctx, {
      firstName: '  Ngozi  ',
      lastName: '  Okonkwo ',
      phone: '+234 (803) 555-0142',
      email: '  NGOZI@Example.COM ',
    });

    expect(created.firstName).toBe('Ngozi');
    expect(created.lastName).toBe('Okonkwo');
    expect(created.phone).toBe('+2348035550142');
    expect(created.email).toBe('ngozi@example.com');
  });

  it('ALLOWS a guardian with no phone and no email, and reports that honestly', async () => {
    // Deliberate: a school may know a name before it knows a number. Blocking
    // this would push schools back to paper. The absence is reported instead.
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const created = await guardianRepo.create(testDb(), await activate(ids.orgId, ids.aliceId), {
      firstName: 'Musa',
      lastName: 'Danjuma',
      phone: null,
      email: null,
    });

    expect(created.id).toBeTruthy();
    expect(guardianRepo.hasContact(created)).toBe(false);
    expect(guardianRepo.hasContact({ phone: '0803', email: null })).toBe(true);
    expect(guardianRepo.hasContact({ phone: null, email: 'a@b.co' })).toBe(true);
    expect(guardianRepo.hasContact({ phone: '   ', email: '  ' })).toBe(false);
  });

  it('normalises phones without rejecting unusual input', () => {
    expect(guardianRepo.normalisePhone('0803 555 0142')).toBe('08035550142');
    expect(guardianRepo.normalisePhone('(0803)-555-0142')).toBe('08035550142');
    expect(guardianRepo.normalisePhone('+234 803 555 0142')).toBe('+2348035550142');
  });
});

describe('Phase 3 — G2: exactly one primary guardian per student', () => {
  it('promotes the requested guardian and demotes the previous one', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);
    const db = testDb();

    const mother = await guardianRepo.create(db, ctx, {
      firstName: 'Ada',
      lastName: 'Eze',
      phone: '08030000001',
    });
    const father = await guardianRepo.create(db, ctx, {
      firstName: 'Chidi',
      lastName: 'Eze',
      phone: '08030000002',
    });

    await guardianRepo.link(db, ctx, {
      studentId: ids.studentAId,
      guardianId: mother.id,
      isPrimary: true,
    });
    await guardianRepo.link(db, ctx, {
      studentId: ids.studentAId,
      guardianId: father.id,
      isPrimary: true,
    });

    const linked = await guardianRepo.listForStudent(db, ctx, ids.studentAId);
    expect(linked.filter((g) => g.isPrimary)).toHaveLength(1);
    expect(linked.find((g) => g.isPrimary)!.id).toBe(father.id);
    // Primary sorts first — the order the UI relies on.
    expect(linked[0]!.id).toBe(father.id);
  });

  it('setPrimary leaves exactly one primary', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);
    const db = testDb();

    const a = await guardianRepo.create(db, ctx, { firstName: 'A', lastName: 'One' });
    const b = await guardianRepo.create(db, ctx, { firstName: 'B', lastName: 'Two' });
    const c = await guardianRepo.create(db, ctx, { firstName: 'C', lastName: 'Three' });
    await guardianRepo.link(db, ctx, {
      studentId: ids.studentAId,
      guardianId: a.id,
      isPrimary: true,
    });
    await guardianRepo.link(db, ctx, { studentId: ids.studentAId, guardianId: b.id });
    await guardianRepo.link(db, ctx, { studentId: ids.studentAId, guardianId: c.id });

    await guardianRepo.setPrimary(db, ctx, { studentId: ids.studentAId, guardianId: c.id });

    const linked = await guardianRepo.listForStudent(db, ctx, ids.studentAId);
    expect(linked.filter((g) => g.isPrimary).map((g) => g.id)).toEqual([c.id]);
  });

  it('THE DATABASE refuses a second primary even when the repository is bypassed', async () => {
    // This is the migration-0051 guarantee. Before it, this insert succeeded and
    // left the student with two primaries (measured: primaries = 2).
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    await testSql()`SELECT set_tenant_context(${ids.orgId}::uuid, ${ids.aliceId}::uuid)`;

    const g1 = randomUUID();
    const g2 = randomUUID();
    await testSql()`
      INSERT INTO guardians (id, first_name, last_name) VALUES
        (${g1}::uuid, 'Raw', 'One'), (${g2}::uuid, 'Raw', 'Two')
    `;
    await testSql()`
      INSERT INTO student_guardians (organization_id, student_id, guardian_id, relationship, is_primary)
      VALUES (${ids.orgId}::uuid, ${ids.studentAId}::uuid, ${g1}::uuid, 'PARENT', true)
    `;

    await expectPgFailure(
      () => testSql()`
        INSERT INTO student_guardians (organization_id, student_id, guardian_id, relationship, is_primary)
        VALUES (${ids.orgId}::uuid, ${ids.studentAId}::uuid, ${g2}::uuid, 'PARENT', true)
      `,
      ['23505'],
    );

    const primaries = await testSql()`
      SELECT count(*)::int AS n FROM student_guardians
       WHERE student_id = ${ids.studentAId}::uuid AND is_primary
    `;
    expect((primaries as unknown as Array<{ n: number }>)[0]!.n).toBe(1);
  });

  it('still allows each of two different students to have their own primary', async () => {
    // The partial index is per student, not global — a regression here would be
    // as damaging as the one it fixes.
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);
    const db = testDb();
    const g = await guardianRepo.create(db, ctx, {
      firstName: 'Shared',
      lastName: 'Contact',
      phone: '08030000009',
    });

    await guardianRepo.link(db, ctx, {
      studentId: ids.studentAId,
      guardianId: g.id,
      isPrimary: true,
    });
    await testSql()`
      INSERT INTO students (id, student_id, first_name, last_name, status)
      VALUES (${randomUUID()}::uuid, 'STU-A02', 'Second', 'Child', 'ACTIVE')
    `;
    const second = await testSql()`
      SELECT id FROM students WHERE student_id = 'STU-A02'
    `;
    await guardianRepo.link(db, ctx, {
      studentId: (second as unknown as Array<{ id: string }>)[0]!.id as UUID,
      guardianId: g.id,
      isPrimary: true,
    });

    const primaries = await testSql()`
      SELECT count(*)::int AS n FROM student_guardians WHERE is_primary
    `;
    expect((primaries as unknown as Array<{ n: number }>)[0]!.n).toBe(2);
  });
});

describe('Phase 3 — G4: linking is idempotent', () => {
  it('re-linking the same pair updates instead of throwing', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);
    const db = testDb();
    const g = await guardianRepo.create(db, ctx, { firstName: 'Idem', lastName: 'Potent' });

    const first = await guardianRepo.link(db, ctx, {
      studentId: ids.studentAId,
      guardianId: g.id,
      relationship: 'PARENT',
    });
    const second = await guardianRepo.link(db, ctx, {
      studentId: ids.studentAId,
      guardianId: g.id,
      relationship: 'SPONSOR',
    });

    expect(second.id).toBe(first.id);
    expect(second.relationship).toBe('SPONSOR');

    const rows = await testSql()`
      SELECT count(*)::int AS n FROM student_guardians
       WHERE student_id = ${ids.studentAId}::uuid AND guardian_id = ${g.id}::uuid
    `;
    expect((rows as unknown as Array<{ n: number }>)[0]!.n).toBe(1);
  });

  it('unlinking a pair that was never linked is an error, not a silent success', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);
    const db = testDb();
    const g = await guardianRepo.create(db, ctx, { firstName: 'Not', lastName: 'Linked' });

    await expect(
      guardianRepo.unlink(db, ctx, { studentId: ids.studentAId, guardianId: g.id }),
    ).rejects.toBeInstanceOf(RepoInvariantError);
  });

  it('unlinking keeps the guardian record itself', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);
    const db = testDb();
    const g = await guardianRepo.create(db, ctx, { firstName: 'Kept', lastName: 'Record' });
    await guardianRepo.link(db, ctx, { studentId: ids.studentAId, guardianId: g.id });

    await guardianRepo.unlink(db, ctx, { studentId: ids.studentAId, guardianId: g.id });

    expect(await guardianRepo.get(db, ctx, g.id)).not.toBeNull();
    expect(await guardianRepo.listForStudent(db, ctx, ids.studentAId)).toHaveLength(0);
  });
});

describe('Phase 3 — G5: soft delete', () => {
  it('hides the guardian everywhere and removes the links', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);
    const db = testDb();
    const g = await guardianRepo.create(db, ctx, {
      firstName: 'Gone',
      lastName: 'Away',
      phone: '08030000003',
    });
    await guardianRepo.link(db, ctx, {
      studentId: ids.studentAId,
      guardianId: g.id,
      isPrimary: true,
    });

    await guardianRepo.softDelete(db, ctx, g.id);

    expect(await guardianRepo.get(db, ctx, g.id)).toBeNull();
    expect((await guardianRepo.listForOrg(db, ctx)).map((x) => x.id)).not.toContain(g.id);
    expect(await guardianRepo.listForStudent(db, ctx, ids.studentAId)).toHaveLength(0);
    expect(await guardianRepo.resolvePrimaryContact(db, ctx, ids.studentAId)).toBeNull();

    // The row survives for audit purposes — a receipt that recorded this name
    // must stay explainable.
    const raw = await testSql()`
      SELECT deleted_at FROM guardians WHERE id = ${g.id}::uuid
    `;
    expect((raw as unknown as Array<{ deleted_at: Date | null }>)[0]!.deleted_at).not.toBeNull();
  });

  it('deleting an already-deleted guardian is an error', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);
    const db = testDb();
    const g = await guardianRepo.create(db, ctx, { firstName: 'Twice', lastName: 'Deleted' });

    await guardianRepo.softDelete(db, ctx, g.id);
    await expect(guardianRepo.softDelete(db, ctx, g.id)).rejects.toBeInstanceOf(RepoInvariantError);
  });
});

describe('Phase 3 — G3: tenant isolation', () => {
  it('cannot see or reach another organization\u2019s guardian', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctxA = await activate(ids.orgId, ids.aliceId);
    const db = testDb();

    const guardianA = await guardianRepo.create(db, ctxA, {
      firstName: 'OrgA',
      lastName: 'Guardian',
    });

    // Under org B's context, org A's guardian does not exist.
    const ctxB = await activate(ids.orgBId, ids.bobId);
    expect(await guardianRepo.get(db, ctxB, guardianA.id)).toBeNull();
    expect((await guardianRepo.listForOrg(db, ctxB)).map((x) => x.id)).not.toContain(guardianA.id);

    // And org B cannot LINK org A's guardian to its own student.
    await expect(
      guardianRepo.link(db, ctxB, { studentId: ids.studentBId, guardianId: guardianA.id }),
    ).rejects.toBeInstanceOf(RepoInvariantError);
  });

  it('cannot link another organization\u2019s student', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctxA = await activate(ids.orgId, ids.aliceId);
    const db = testDb();
    const guardianA = await guardianRepo.create(db, ctxA, { firstName: 'Own', lastName: 'Only' });

    // Org A's guardian, org B's student — refused (G3), and the M9 trigger would
    // refuse the row even if the repository did not.
    await testSql()`SELECT set_tenant_context(${ids.orgBId}::uuid, ${ids.bobId}::uuid)`;
    await expect(
      guardianRepo.link(db, await activate(ids.orgBId, ids.bobId), {
        studentId: ids.studentAId,
        guardianId: guardianA.id,
      }),
    ).rejects.toBeInstanceOf(RepoInvariantError);
  });

  it('the M9 trigger refuses a cross-tenant link even in raw SQL', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    await testSql()`SELECT set_tenant_context(${ids.orgBId}::uuid, ${ids.bobId}::uuid)`;
    const g = randomUUID();
    await testSql()`INSERT INTO guardians (id, first_name, last_name) VALUES (${g}::uuid, 'B', 'Guardian')`;

    // Org B's guardian pointed at org A's student: the trigger catches the
    // mismatch between the link's organization and the student's.
    await expectPgFailure(
      () => testSql()`
        INSERT INTO student_guardians (organization_id, student_id, guardian_id, relationship)
        VALUES (${ids.orgBId}::uuid, ${ids.studentAId}::uuid, ${g}::uuid, 'PARENT')
      `,
      ['23514'],
    );
  });

  it('countStudentsWithoutContact counts only this organization', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctxA = await activate(ids.orgId, ids.aliceId);
    const db = testDb();

    // Org A: studentA has one reachable contact → not counted.
    const reachable = await guardianRepo.create(db, ctxA, {
      firstName: 'Has',
      lastName: 'Phone',
      phone: '08030000004',
    });
    await guardianRepo.link(db, ctxA, { studentId: ids.studentAId, guardianId: reachable.id });

    expect(await guardianRepo.countStudentsWithoutContact(db, ctxA)).toBe(0);

    // Org B's student has no guardian at all, but org A's count must not see it.
    await testSql()`SELECT set_tenant_context(${ids.orgBId}::uuid, ${ids.bobId}::uuid)`;
    expect(
      await guardianRepo.countStudentsWithoutContact(db, await activate(ids.orgBId, ids.bobId)),
    ).toBe(1);
  });
});

describe('Phase 3 — resolvePrimaryContact (the collections-critical resolution)', () => {
  it('returns null when the student has no guardian at all', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    expect(
      await guardianRepo.resolvePrimaryContact(
        testDb(),
        await activate(ids.orgId, ids.aliceId),
        ids.studentAId,
      ),
    ).toBeNull();
  });

  it('prefers the primary guardian when the primary has contact details', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);
    const db = testDb();
    const primary = await guardianRepo.create(db, ctx, {
      firstName: 'Prim',
      lastName: 'Ary',
      phone: '08030000005',
    });
    const other = await guardianRepo.create(db, ctx, {
      firstName: 'Oth',
      lastName: 'Er',
      phone: '08030000006',
    });
    await guardianRepo.link(db, ctx, { studentId: ids.studentAId, guardianId: other.id });
    await guardianRepo.link(db, ctx, {
      studentId: ids.studentAId,
      guardianId: primary.id,
      isPrimary: true,
    });

    expect((await guardianRepo.resolvePrimaryContact(db, ctx, ids.studentAId))!.id).toBe(
      primary.id,
    );
  });

  it('falls past a contactless primary to a guardian who CAN be reached', async () => {
    // The point of the preference order: a reminder must reach a person, so a
    // reachable secondary beats an unreachable primary.
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);
    const db = testDb();
    const silentPrimary = await guardianRepo.create(db, ctx, {
      firstName: 'Si',
      lastName: 'Lent',
      phone: null,
      email: null,
    });
    const reachable = await guardianRepo.create(db, ctx, {
      firstName: 'Re',
      lastName: 'Ach',
      phone: '08030000007',
    });
    await guardianRepo.link(db, ctx, {
      studentId: ids.studentAId,
      guardianId: silentPrimary.id,
      isPrimary: true,
    });
    await guardianRepo.link(db, ctx, { studentId: ids.studentAId, guardianId: reachable.id });

    expect((await guardianRepo.resolvePrimaryContact(db, ctx, ids.studentAId))!.id).toBe(
      reachable.id,
    );
  });

  it('still returns a contactless guardian rather than null, so "nobody" means nobody', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);
    const db = testDb();
    const silent = await guardianRepo.create(db, ctx, { firstName: 'No', lastName: 'Number' });
    await guardianRepo.link(db, ctx, { studentId: ids.studentAId, guardianId: silent.id });

    const resolved = await guardianRepo.resolvePrimaryContact(db, ctx, ids.studentAId);
    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(silent.id);
    expect(guardianRepo.hasContact(resolved!)).toBe(false);
  });
});

describe('Phase 3 — the reverse view', () => {
  it('lists every student a guardian is responsible for', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);
    const db = testDb();
    const g = await guardianRepo.create(db, ctx, { firstName: 'Multi', lastName: 'Child' });
    await guardianRepo.link(db, ctx, { studentId: ids.studentAId, guardianId: g.id });

    const kids = await guardianRepo.listStudentsForGuardian(db, ctx, g.id);
    expect(kids).toHaveLength(1);
    expect(kids[0]!.studentId).toBe(ids.studentAId);
    expect(kids[0]!.studentCode).toBe('STU-A01');
  });

  it('does not leak students of another organization', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctxA = await activate(ids.orgId, ids.aliceId);
    const db = testDb();
    const g = await guardianRepo.create(db, ctxA, { firstName: 'Solo', lastName: 'Org' });
    await guardianRepo.link(db, ctxA, { studentId: ids.studentAId, guardianId: g.id });

    await testSql()`SELECT set_tenant_context(${ids.orgBId}::uuid, ${ids.bobId}::uuid)`;
    expect(
      await guardianRepo.listStudentsForGuardian(db, await activate(ids.orgBId, ids.bobId), g.id),
    ).toHaveLength(0);
  });
});

describe('Phase 3 — updates', () => {
  it('clears a field on explicit null and leaves absent fields alone', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);
    const db = testDb();
    const g = await guardianRepo.create(db, ctx, {
      firstName: 'Patch',
      lastName: 'Me',
      phone: '08030000008',
      email: 'patch@example.com',
    });

    const updated = await guardianRepo.update(db, ctx, g.id, { phone: null });
    expect(updated.phone).toBeNull();
    expect(updated.email).toBe('patch@example.com'); // untouched
    expect(updated.firstName).toBe('Patch'); // untouched
  });

  it('refuses to blank a name through an update', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);
    const db = testDb();
    const g = await guardianRepo.create(db, ctx, { firstName: 'Keep', lastName: 'Name' });

    await expect(guardianRepo.update(db, ctx, g.id, { firstName: '  ' })).rejects.toBeInstanceOf(
      RepoInvariantError,
    );
  });

  it('cannot update another organization\u2019s guardian', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctxA = await activate(ids.orgId, ids.aliceId);
    const db = testDb();
    const g = await guardianRepo.create(db, ctxA, { firstName: 'Mine', lastName: 'Only' });

    await testSql()`SELECT set_tenant_context(${ids.orgBId}::uuid, ${ids.bobId}::uuid)`;
    await expect(
      guardianRepo.update(db, await activate(ids.orgBId, ids.bobId), g.id, { firstName: 'Stolen' }),
    ).rejects.toBeInstanceOf(RepoInvariantError);
  });
});

describe('Phase 3 — RLS is still forced on both tables', () => {
  it('keeps row level security enabled and forced', async () => {
    // A migration that added an index must not have disturbed the M4/M9 posture.
    const rows = await testSql()`
      SELECT relname, relrowsecurity, relforcerowsecurity
        FROM pg_class
       WHERE relname IN ('guardians', 'student_guardians') AND relkind = 'r'
    `;
    const list = rows as unknown as Array<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>;
    expect(list).toHaveLength(2);
    for (const r of list) {
      expect(r.relrowsecurity, `${r.relname} RLS enabled`).toBe(true);
      expect(r.relforcerowsecurity, `${r.relname} RLS forced`).toBe(true);
    }
  });

  it('keeps the pair unique index that makes re-import idempotent', async () => {
    const rows = await testSql()`
      SELECT indexname FROM pg_indexes
       WHERE tablename = 'student_guardians' AND indexname = 'student_guardians_pair_idx'
    `;
    expect((rows as unknown as unknown[]).length).toBe(1);
  });

  it('has the one-primary index from migration 0051', async () => {
    const rows = await testSql()`
      SELECT indexdef FROM pg_indexes
       WHERE tablename = 'student_guardians' AND indexname = 'student_guardians_one_primary_idx'
    `;
    const list = rows as unknown as Array<{ indexdef: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.indexdef).toContain('UNIQUE');
    expect(list[0]!.indexdef).toContain('WHERE is_primary');
  });

  it('leaves no stray guardian rows behind', async () => {
    const rows = await testSql()`SELECT count(*)::int AS n FROM guardians`;
    expect((rows as unknown as Array<{ n: number }>)[0]!.n).toBe(0);
  });

  it('keeps the guardians table columns unchanged by this phase', () => {
    // The phase adds no columns; if someone adds one, this test should be
    // updated deliberately rather than silently.
    const cols = Object.keys(guardians);
    expect(cols).toEqual(
      expect.arrayContaining([
        'id',
        'organizationId',
        'firstName',
        'lastName',
        'email',
        'phone',
        'address',
        'createdAt',
        'updatedAt',
        'deletedAt',
      ]),
    );
    const linkCols = Object.keys(studentGuardians);
    expect(linkCols).toEqual(
      expect.arrayContaining([
        'id',
        'organizationId',
        'studentId',
        'guardianId',
        'relationship',
        'isPrimary',
        'createdAt',
        'updatedAt',
      ]),
    );
  });
});

describe('Phase 3 — the debtors register sees the responsible contact (cross-feature)', () => {
  /**
   * The point of the whole phase: a school must be able to see WHO to ring about
   * an outstanding balance. The debtors register is the only other reader of
   * guardian data in the product (`lib/db/repo/reminders.ts`), and it resolves
   * through `student_guardians` with `is_primary = true`.
   *
   * This test exists because two features have to agree: creating a guardian must
   * make it visible to collections, and soft-deleting one must remove it. A
   * guardian that is deleted but still named as the person responsible for a debt
   * would be worse than no contact at all.
   */
  async function debtorRowFor(ids: { orgId: UUID; aliceId: UUID }, studentId: UUID) {
    const ctx = await activate(ids.orgId, ids.aliceId);
    const rows = await remindersRepo.listDebtors(testDb(), ctx);
    return rows.find((r) => r.studentId === studentId) ?? null;
  }

  it('names the primary guardian once one exists, and stops naming them after deletion', async () => {
    const ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
    const ctx = await activate(ids.orgId, ids.aliceId);
    const db = testDb();

    // The seeded student has no invoice, so the register has nothing to rank —
    // which is the honest "no outstanding balance" state.
    expect(await debtorRowFor(ids, ids.studentAId)).toBeNull();

    const guardian = await guardianRepo.create(db, ctx, {
      firstName: 'Reach',
      lastName: 'Able',
      phone: '08031234567',
    });
    await guardianRepo.link(db, ctx, {
      studentId: ids.studentAId,
      guardianId: guardian.id,
      isPrimary: true,
    });

    // Resolvable by the same preference order the register uses.
    const resolved = await guardianRepo.resolvePrimaryContact(db, ctx, ids.studentAId);
    expect(resolved!.id).toBe(guardian.id);
    expect(guardianRepo.hasContact(resolved!)).toBe(true);

    // After deletion the link is gone, so the register cannot name a deleted
    // person as the responsible contact.
    await guardianRepo.softDelete(db, ctx, guardian.id);
    expect(await guardianRepo.resolvePrimaryContact(db, ctx, ids.studentAId)).toBeNull();
    const remaining = await testSql()`
      SELECT count(*)::int AS n FROM student_guardians
       WHERE guardian_id = ${guardian.id}::uuid
    `;
    expect((remaining as unknown as Array<{ n: number }>)[0]!.n).toBe(0);
  });
});
