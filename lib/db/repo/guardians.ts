/**
 * Guardians repository.
 *
 * WHY THIS EXISTS
 *   The `guardians` and `student_guardians` tables have existed since 0000_init,
 *   with RLS policies, indexes and a relationship enum — but until now NOTHING in
 *   the product could write to them. The debtors register, the reminder composer
 *   and the statement all READ guardian data (and fall back to '—'), so a school
 *   could see that a parent was missing but had no way to supply one. That made
 *   every collection reminder unaddressable.
 *
 *   This module is the missing write path. It adds no tables and no columns; it
 *   uses what the schema already declares.
 *
 * FINANCIAL POSITION
 *   Guardians have NO financial authority. They are contact records. Nothing in
 *   this module touches invoices, payments, allocations, receipts or the
 *   reconciliation state machine, and none of those invariants are affected by
 *   anything here. A guardian is who you telephone; it is never who owes.
 *
 * INVARIANTS ENFORCED HERE
 *   G1. A guardian requires a first name and a last name.
 *   G2. At most ONE primary guardian per student. Setting a new primary clears
 *       the previous one in the SAME transaction, so a student can never be
 *       observed with two primaries.
 *   G3. A student and guardian must belong to the caller's organization. The
 *       link is refused otherwise — the composite lookup does the check rather
 *       than trusting either id.
 *   G4. A (student, guardian) pair is unique — enforced by the DB index
 *       `student_guardians_pair_idx`; this module treats a repeat link as a
 *       no-op update rather than an error, so a re-import is idempotent.
 *   G5. Soft-deleted guardians are excluded from every read.
 *
 * WHAT IS DELIBERATELY NOT ENFORCED
 *   A guardian may be created with no phone and no email. That is real: a school
 *   may know a name before it knows a number. Blocking it would push schools back
 *   to paper. Instead `contactability` is REPORTED (see `hasContact`), so the
 *   surfaces that need a destination can say so honestly rather than pretending
 *   the contact exists.
 */
import { and, eq, isNull, asc, desc, sql } from 'drizzle-orm';
import { guardians, studentGuardians, students } from '../schema';
import type { TenantCtx, TenantScopedDb, UUID } from './_context';
import { RepoInvariantError } from './_context';

export type Guardian = typeof guardians.$inferSelect;
export type NewGuardian = typeof guardians.$inferInsert;
export type StudentGuardian = typeof studentGuardians.$inferSelect;

export type GuardianRelationship = 'PARENT' | 'GUARDIAN' | 'SPONSOR' | 'OTHER';

export type GuardianPatch = Partial<
  Pick<Guardian, 'firstName' | 'lastName' | 'phone' | 'email' | 'address'>
>;

/** A guardian as seen from a student, with the link's own attributes. */
export interface StudentGuardianView extends Guardian {
  relationship: GuardianRelationship;
  isPrimary: boolean;
  linkId: UUID;
}

const GUARDIAN_FIELDS = ['firstName', 'lastName', 'phone', 'email', 'address'] as const;

// Phone numbers arrive from schools in every shape: 0803…, +234803…, 234 803 …,
// with spaces, dashes and parentheses. We normalise to a single stored form so
// that "does this guardian already exist?" and "can we dial this?" are both
// answerable. We do NOT reject unusual input — we store what we were given and
// expose the normalised form alongside it for matching.
export function normalisePhone(raw: string): string {
  return raw.replace(/[^\d+]/g, '');
}

function requireName(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RepoInvariantError(`${label} is required.`);
  }
  return value.trim();
}

/** True when the guardian has at least one channel a reminder could reach. */
export function hasContact(g: Pick<Guardian, 'phone' | 'email'>): boolean {
  return Boolean((g.phone && g.phone.trim()) || (g.email && g.email.trim()));
}

type Db = TenantScopedDb;

/**
 * Serialise guardian-promotion work for one student.
 *
 * `setPrimary` and a primary `link` both mean "clear the current primary, then
 * promote". Under READ COMMITTED two concurrent requests could interleave so
 * that both promotions commit — the partial unique index added in migration
 * 0051 would then reject the second with a 23505, which is correct but arrives
 * at the user as an unexplainable error. Taking a row lock on the student makes
 * the second request wait, then run its demote/promote against the committed
 * state, so the outcome is simply last-writer-wins with exactly one primary.
 *
 * The lock is taken on the student row because that is the thing the invariant
 * is scoped to. A student is a tenant-scoped row, so the lookup is org-scoped
 * exactly like every other read here.
 */
async function lockStudent(db: Db, ctx: TenantCtx, studentId: UUID): Promise<void> {
  const rows = await db
    .select({ id: students.id })
    .from(students)
    .where(and(eq(students.id, studentId), eq(students.organizationId, ctx.organizationId)))
    .for('update');
  if (!rows[0]) throw new RepoInvariantError('Student not found.');
}

export async function create(
  db: Db,
  ctx: TenantCtx,
  input: Omit<NewGuardian, 'organizationId' | 'id'>,
): Promise<Guardian> {
  const firstName = requireName(input.firstName, 'Guardian first name'); // G1
  const lastName = requireName(input.lastName, 'Guardian last name');
  const rows = await db
    .insert(guardians)
    .values({
      ...input,
      firstName,
      lastName,
      phone: input.phone ? normalisePhone(input.phone) : null,
      email: input.email ? input.email.trim().toLowerCase() : null,
      organizationId: ctx.organizationId,
    })
    .returning();
  return rows[0]!;
}

export async function get(db: Db, ctx: TenantCtx, id: UUID): Promise<Guardian | null> {
  const rows = await db
    .select()
    .from(guardians)
    .where(
      and(
        eq(guardians.id, id),
        eq(guardians.organizationId, ctx.organizationId),
        isNull(guardians.deletedAt), // G5
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listForOrg(db: Db, ctx: TenantCtx): Promise<Guardian[]> {
  return db
    .select()
    .from(guardians)
    .where(and(eq(guardians.organizationId, ctx.organizationId), isNull(guardians.deletedAt)))
    .orderBy(asc(guardians.lastName), asc(guardians.firstName));
}

/**
 * Patch a subset of guardian contact fields. Absent keys are left alone;
 * an explicit null clears a field.
 */
export async function update(
  db: Db,
  ctx: TenantCtx,
  id: UUID,
  patch: GuardianPatch,
): Promise<Guardian> {
  const cleaned: Record<string, unknown> = {};
  for (const k of GUARDIAN_FIELDS) {
    if (k in patch) cleaned[k] = (patch as Record<string, unknown>)[k];
  }
  if ('firstName' in cleaned)
    cleaned.firstName = requireName(cleaned.firstName, 'Guardian first name');
  if ('lastName' in cleaned) cleaned.lastName = requireName(cleaned.lastName, 'Guardian last name');
  if (typeof cleaned.phone === 'string') cleaned.phone = normalisePhone(cleaned.phone);
  if (typeof cleaned.email === 'string') {
    cleaned.email = (cleaned.email as string).trim().toLowerCase() || null;
  }
  if (Object.keys(cleaned).length === 0) {
    const current = await get(db, ctx, id);
    if (!current) throw new RepoInvariantError('Guardian not found.');
    return current;
  }
  cleaned.updatedAt = new Date();
  const rows = await db
    .update(guardians)
    .set(cleaned as never)
    .where(
      and(
        eq(guardians.id, id),
        eq(guardians.organizationId, ctx.organizationId),
        isNull(guardians.deletedAt),
      ),
    )
    .returning();
  if (!rows[0]) throw new RepoInvariantError('Guardian not found.');
  return rows[0];
}

/**
 * Soft-delete a guardian and every link to them.
 *
 * Soft rather than hard because the audit trail and any issued receipt that
 * recorded a guardian's name must remain explainable. A guardian is never
 * removed from history, only from the current contact list.
 */
export async function softDelete(db: Db, ctx: TenantCtx, id: UUID): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await (tx as Db)
      .update(guardians)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(guardians.id, id),
          eq(guardians.organizationId, ctx.organizationId),
          isNull(guardians.deletedAt),
        ),
      )
      .returning();
    if (!rows[0]) throw new RepoInvariantError('Guardian not found.');
    await (tx as Db)
      .delete(studentGuardians)
      .where(
        and(
          eq(studentGuardians.guardianId, id),
          eq(studentGuardians.organizationId, ctx.organizationId),
        ),
      );
  });
}

/** All guardians linked to one student, primary first then surname. */
export async function listForStudent(
  db: Db,
  ctx: TenantCtx,
  studentId: UUID,
): Promise<StudentGuardianView[]> {
  const rows = await db
    .select({
      id: guardians.id,
      organizationId: guardians.organizationId,
      firstName: guardians.firstName,
      lastName: guardians.lastName,
      email: guardians.email,
      phone: guardians.phone,
      address: guardians.address,
      createdAt: guardians.createdAt,
      updatedAt: guardians.updatedAt,
      deletedAt: guardians.deletedAt,
      relationship: studentGuardians.relationship,
      isPrimary: studentGuardians.isPrimary,
      linkId: studentGuardians.id,
    })
    .from(studentGuardians)
    .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
    .where(
      and(
        eq(studentGuardians.studentId, studentId),
        eq(studentGuardians.organizationId, ctx.organizationId),
        isNull(guardians.deletedAt), // G5
      ),
    )
    .orderBy(desc(studentGuardians.isPrimary), asc(guardians.lastName), asc(guardians.firstName));
  return rows as StudentGuardianView[];
}

/** Every student linked to one guardian — the reverse view. */
export async function listStudentsForGuardian(
  db: Db,
  ctx: TenantCtx,
  guardianId: UUID,
): Promise<Array<{ studentId: UUID; studentCode: string; firstName: string; lastName: string }>> {
  return db
    .select({
      studentId: students.id,
      studentCode: students.studentId,
      firstName: students.firstName,
      lastName: students.lastName,
    })
    .from(studentGuardians)
    .innerJoin(students, eq(students.id, studentGuardians.studentId))
    .where(
      and(
        eq(studentGuardians.guardianId, guardianId),
        eq(studentGuardians.organizationId, ctx.organizationId),
        isNull(students.deletedAt),
      ),
    )
    .orderBy(asc(students.lastName), asc(students.firstName));
}

/**
 * Link an existing guardian to a student.
 *
 * Idempotent by design (G4): re-linking a pair that already exists updates the
 * relationship/primary flag instead of throwing, so a CSV re-import or a
 * double-submitted form cannot produce an error the user has to interpret.
 */
export async function link(
  db: Db,
  ctx: TenantCtx,
  input: {
    studentId: UUID;
    guardianId: UUID;
    relationship?: GuardianRelationship;
    isPrimary?: boolean;
  },
): Promise<StudentGuardian> {
  const relationship = input.relationship ?? 'PARENT';
  const wantPrimary = input.isPrimary ?? false;

  return db.transaction(async (tx) => {
    const scoped = tx as Db;

    // G3 — both sides must be in this organization. We verify by reading within
    // tenant scope rather than trusting the ids we were handed.
    const student = await scoped
      .select({ id: students.id })
      .from(students)
      .where(
        and(
          eq(students.id, input.studentId),
          eq(students.organizationId, ctx.organizationId),
          isNull(students.deletedAt),
        ),
      )
      .limit(1);
    if (!student[0]) throw new RepoInvariantError('Student not found.');

    const guardian = await scoped
      .select({ id: guardians.id })
      .from(guardians)
      .where(
        and(
          eq(guardians.id, input.guardianId),
          eq(guardians.organizationId, ctx.organizationId),
          isNull(guardians.deletedAt),
        ),
      )
      .limit(1);
    if (!guardian[0]) throw new RepoInvariantError('Guardian not found.');

    // G2 — a new primary demotes any existing primary for this student first.
    // The student row is locked so two concurrent promotions cannot interleave
    // into two primaries (which migration 0051's index would reject).
    if (wantPrimary) {
      await lockStudent(scoped, ctx, input.studentId);
      await scoped
        .update(studentGuardians)
        .set({ isPrimary: false, updatedAt: new Date() })
        .where(
          and(
            eq(studentGuardians.studentId, input.studentId),
            eq(studentGuardians.organizationId, ctx.organizationId),
          ),
        );
    }

    const inserted = await scoped
      .insert(studentGuardians)
      .values({
        organizationId: ctx.organizationId,
        studentId: input.studentId,
        guardianId: input.guardianId,
        relationship,
        isPrimary: wantPrimary,
      })
      .onConflictDoUpdate({
        target: [studentGuardians.studentId, studentGuardians.guardianId],
        set: { relationship, isPrimary: wantPrimary, updatedAt: new Date() },
      })
      .returning();
    return inserted[0]!;
  });
}

/** Remove a link. The guardian row itself is untouched. */
export async function unlink(
  db: Db,
  ctx: TenantCtx,
  input: { studentId: UUID; guardianId: UUID },
): Promise<void> {
  const rows = await db
    .delete(studentGuardians)
    .where(
      and(
        eq(studentGuardians.studentId, input.studentId),
        eq(studentGuardians.guardianId, input.guardianId),
        eq(studentGuardians.organizationId, ctx.organizationId),
      ),
    )
    .returning({ id: studentGuardians.id });
  if (!rows[0]) throw new RepoInvariantError('That guardian is not linked to that student.');
}

/** Promote one linked guardian to primary, demoting any other (G2). */
export async function setPrimary(
  db: Db,
  ctx: TenantCtx,
  input: { studentId: UUID; guardianId: UUID },
): Promise<void> {
  await db.transaction(async (tx) => {
    const scoped = tx as Db;
    const existing = await scoped
      .select({ id: studentGuardians.id })
      .from(studentGuardians)
      .where(
        and(
          eq(studentGuardians.studentId, input.studentId),
          eq(studentGuardians.guardianId, input.guardianId),
          eq(studentGuardians.organizationId, ctx.organizationId),
        ),
      )
      .limit(1);
    if (!existing[0]) throw new RepoInvariantError('That guardian is not linked to that student.');

    // Lock before demoting so concurrent promotions serialise (see lockStudent).
    await lockStudent(scoped, ctx, input.studentId);

    await scoped
      .update(studentGuardians)
      .set({ isPrimary: false, updatedAt: new Date() })
      .where(
        and(
          eq(studentGuardians.studentId, input.studentId),
          eq(studentGuardians.organizationId, ctx.organizationId),
        ),
      );
    await scoped
      .update(studentGuardians)
      .set({ isPrimary: true, updatedAt: new Date() })
      .where(eq(studentGuardians.id, existing[0].id));
  });
}

/**
 * The contact a collection reminder should be addressed to.
 *
 * Preference order — primary first, then any guardian WITH contact details,
 * then any guardian at all. Returns null when the student has no guardian, so
 * callers must handle "we have nobody to call" explicitly rather than sending
 * into the void.
 *
 * This intentionally does NOT fall back to the student's own row: the student
 * table holds no phone number for a child, and inventing one would be worse
 * than reporting the absence.
 */
export async function resolvePrimaryContact(
  db: Db,
  ctx: TenantCtx,
  studentId: UUID,
): Promise<StudentGuardianView | null> {
  const all = await listForStudent(db, ctx, studentId);
  if (all.length === 0) return null;
  return (
    all.find((g) => g.isPrimary && hasContact(g)) ??
    all.find((g) => hasContact(g)) ??
    all[0] ??
    null
  );
}

/** Count students in this org that have no guardian with any contact detail. */
export async function countStudentsWithoutContact(db: Db, ctx: TenantCtx): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(students)
    .where(
      and(
        eq(students.organizationId, ctx.organizationId),
        isNull(students.deletedAt),
        sql`NOT EXISTS (
          SELECT 1 FROM ${studentGuardians} sg
            JOIN ${guardians} g ON g.id = sg.guardian_id
           WHERE sg.student_id = ${students.id}
             AND g.deleted_at IS NULL
             AND ((g.phone IS NOT NULL AND btrim(g.phone) <> '')
               OR (g.email IS NOT NULL AND btrim(g.email) <> ''))
        )`,
      ),
    );
  return Number(rows[0]?.n ?? 0);
}
