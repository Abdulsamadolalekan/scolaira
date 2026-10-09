/**
 * /api/students
 *   GET  — list students for org with balance summary.
 *   POST — create a student.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode } from '@/lib/authz';
import * as studentRepo from '@/lib/db/repo/students';
import * as enrollmentRepo from '@/lib/db/repo/enrollments';
import * as termRepo from '@/lib/db/repo/terms';
import * as classRepo from '@/lib/db/repo/classes';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';
import { students } from '@/lib/db/schema';
import { SURFACE_LIMITS, decodeCursor, encodeCursor, pageMeta, resolveLimit } from '@/lib/db/repo/pagination';

const CreateSchema = z.object({
  studentId: z.string().trim().min(1).max(32),
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().min(1).max(120),
  middleName: z.string().trim().max(120).optional(),
  gender: z.enum(['M','F','OTHER']).optional(),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  initialEnrollment: z.object({
    termId: z.string().uuid(),
    classId: z.string().uuid(),
    enrolledOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).optional(),
});

export const runtime = 'nodejs';

export const GET = withAuthorizedRoute(
  { action: 'student.read', method: 'GET' },
  async (req, { db, ctx }) => {
    // H-2/M-6: this list used to be UNBOUNDED — the only surface with no cap at
    // all. It now declares its cap, pages on a keyset cursor, and reports the
    // same-filter totals from source rows, because pages above it (the students
    // register) summed the returned rows into their own headline tiles.
    const url = new URL(req.url);
    const surface = SURFACE_LIMITS.students;
    const limit = resolveLimit(surface, url.searchParams.get('limit'));
    const cursorRaw = url.searchParams.get('cursor');
    const after = cursorRaw ? decodeCursor(surface.surface, cursorRaw) : null;

    const predicates = [eq(students.organizationId, ctx.organizationId)] as any[];
    if (after) {
      // Ordering is (last_name, first_name, id) — the register's own order.
      predicates.push(sql`(
        (${students.lastName}, ${students.firstName}, ${students.id}) >
        (${after[0]}::text, ${after[1]}::text, ${after[2]}::uuid)
      )`);
    }

    const rows = await db
      .select({
        id: students.id,
        studentId: students.studentId,
        firstName: students.firstName,
        lastName: students.lastName,
        gender: students.gender,
        status: students.status,
      })
      .from(students)
      .where(and(...predicates))
      .orderBy(students.lastName, students.firstName, students.id)
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const ids = page.map((r) => r.id);

    // Per-student balances for THIS PAGE only (the totals below cover every
    // student, so the register's tiles never depend on the page).
    const balances = ids.length
      ? ((await db.execute(sql`
          SELECT i.student_id AS id,
                 COALESCE(SUM(i.total_kobo),0)::bigint AS billed,
                 COALESCE(SUM(i.paid_kobo),0)::bigint AS paid
            FROM invoices i
           WHERE i.organization_id = ${ctx.organizationId}
             AND i.status <> 'VOID'
             AND i.student_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
           GROUP BY i.student_id
        `)) as Array<{ id: string; billed: string; paid: string }>)
      : [];
    const balMap = new Map<string, { billed: number; paid: number }>();
    for (const r of balances) balMap.set(r.id, { billed: Number(r.billed), paid: Number(r.paid) });

    // H-2: source-row totals for the whole (unpaginated) set, all-term by
    // definition — a student's balance is a fact, not a term opinion.
    const totalRows = (await db.execute(sql`
      SELECT count(*)::int AS student_count,
             count(*) FILTER (WHERE active_outstanding > 0)::int AS debtor_count,
             COALESCE(SUM(billed), 0)::bigint AS billed_kobo,
             COALESCE(SUM(paid), 0)::bigint AS paid_kobo,
             COALESCE(SUM(GREATEST(billed - paid, 0)), 0)::bigint AS outstanding_kobo
        FROM (
          SELECT s.id,
                 s.status = 'ACTIVE' AS is_active,
                 COALESCE(bl.billed, 0) AS billed,
                 COALESCE(bl.paid, 0) AS paid,
                 CASE WHEN s.status = 'ACTIVE' THEN GREATEST(COALESCE(bl.billed, 0) - COALESCE(bl.paid, 0), 0) ELSE 0 END AS active_outstanding
            FROM students s
            LEFT JOIN (
              SELECT i.student_id,
                     SUM(i.total_kobo) AS billed,
                     SUM(i.paid_kobo) AS paid
                FROM invoices i
               WHERE i.organization_id = ${ctx.organizationId}
                 AND i.status <> 'VOID'
               GROUP BY i.student_id
            ) bl ON bl.student_id = s.id
           WHERE s.organization_id = ${ctx.organizationId}
        ) t
    `)) as Array<Record<string, unknown>>;
    const t = totalRows[0] ?? {};

    const out = page.map((s) => {
      const b = balMap.get(s.id) ?? { billed: 0, paid: 0 };
      return {
        id: s.id,
        studentId: s.studentId,
        name: [s.firstName, s.lastName].filter(Boolean).join(' '),
        gender: s.gender,
        status: s.status,
        billedKobo: b.billed,
        paidKobo: b.paid,
        outstandingKobo: Math.max(0, b.billed - b.paid),
      };
    });

    const last = (page[page.length - 1] as any) ?? null;
    return NextResponse.json({
      students: out,
      totals: {
        studentCount: Number(t.student_count ?? 0),
        debtorCount: Number(t.debtor_count ?? 0),
        billedKobo: Number(t.billed_kobo ?? 0),
        paidKobo: Number(t.paid_kobo ?? 0),
        outstandingKobo: Number(t.outstanding_kobo ?? 0),
      },
      page: pageMeta({
        surface,
        limit,
        returned: out.length,
        total: Number(t.student_count ?? 0),
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeCursor(surface.surface, [
                String(last.lastName),
                String(last.firstName),
                String(last.id),
              ])
            : null,
      }),
      scope: { scope: 'ALL_TERM', label: 'Every term — a balance is not a term opinion' },
      asOf: new Date().toISOString(),
    });
  },
);

export const POST = withAuthorizedRoute(
  { action: 'student.create', method: 'POST', bodySchema: CreateSchema },
  async (req, { db, ctx, requestId, body }) => {
    const data = CreateSchema.parse(body);
    try {
      return await db.transaction(async (tx) => {
        const idem = await beginIdempotency(tx, ctx, req, {
          scope: 'student.create', path: '/api/students', payload: data, required: Boolean(data.initialEnrollment),
        });
        if (idem.replay) return idem.replay;
        const s = await studentRepo.create(tx, ctx, {
          studentId: data.studentId,
          firstName: data.firstName,
          lastName: data.lastName,
          middleName: data.middleName ?? null,
          gender: data.gender ?? null,
          dateOfBirth: data.dob ?? null,
          status: 'ACTIVE',
        });
        let enrollment = null;
        if (data.initialEnrollment) {
          const term = await termRepo.lockForBilling(tx, ctx, data.initialEnrollment.termId as any);
          if (!term) throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Term not found.', 404);
          if (term.status === 'PLANNED') throw new AuthzError(AuthzErrorCode.CONFLICT, 'Activate the term before enrolling students.', 409);
          if (term.status === 'CLOSED') throw new AuthzError(AuthzErrorCode.CONFLICT, 'Closed terms cannot receive enrollments.', 409);
          if (data.initialEnrollment.enrolledOn > new Date().toISOString().slice(0, 10)) {
            throw new AuthzError(AuthzErrorCode.BAD_REQUEST, 'Enrollment date cannot be in the future.', 400);
          }
          const schoolClass = await classRepo.get(tx, ctx, data.initialEnrollment.classId as any);
          if (!schoolClass) throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Class not found.', 404);
          if (schoolClass.deletedAt) throw new AuthzError(AuthzErrorCode.CONFLICT, 'Archived classes cannot receive enrollments.', 409);
          enrollment = await enrollmentRepo.create(tx, ctx, {
            studentId: s.id,
            classId: data.initialEnrollment.classId as any,
            termId: data.initialEnrollment.termId as any,
            enrolledOn: data.initialEnrollment.enrolledOn,
          });
        }
        await auditRepo.record(tx, ctx, {
          action: 'student.create', entityType: 'student', entityId: s.id,
          after: { studentId: s.studentId, name: `${s.firstName} ${s.lastName}`, initialEnrollmentId: enrollment?.id ?? null },
          metadata: { requestId },
        });
        if (enrollment) {
          await auditRepo.record(tx, ctx, {
            action: 'enrollment.create', entityType: 'class_enrollment', entityId: enrollment.id,
            after: { studentId: enrollment.studentId, classId: enrollment.classId, termId: enrollment.termId, enrolledOn: enrollment.enrolledOn },
            metadata: { requestId, atomicAdmission: true },
          });
        }
        const result = { student: s, enrollment };
        await completeIdempotency(tx, ctx, idem.key, 201, result);
        return NextResponse.json(result, { status: 201 });
      });
    } catch (e: any) {
      if (e?.code === '23505') {
        throw new AuthzError(AuthzErrorCode.CONFLICT, 'A student with that ID already exists.', 409);
      }
      throw e;
    }
  },
);
