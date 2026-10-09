/**
 * POST /api/onboarding/students/import/commit — the real import.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * FINANCIAL SAFETY — WHAT THIS ENDPOINT CANNOT DO
 * ════════════════════════════════════════════════════════════════════════════
 *   This endpoint writes to exactly THREE tables and nothing else:
 *
 *     students              — the roll
 *     guardians             — the named contacts
 *     student_guardians     — the links between them
 *     class_enrollments     — which class, in which term
 *
 *   It does NOT create invoices, invoice lines, payments, allocations, receipts,
 *   reversals, ledger entries, waivers or financial periods. There is no code
 *   path here that touches any of them, and a test asserts that a completed
 *   import leaves every financial table exactly as it was. Importing the roll
 *   brings students in to BE billed; it must never bill them.
 *
 *   The one financial-adjacent thing it does is create `class_enrollments`, which
 *   is what the existing term-billing run reads to decide who to bill. That is
 *   deliberate and it is the same thing `POST /api/students` already does when a
 *   student is admitted with an `initialEnrollment`. Creating an enrolment is not
 *   creating a charge; it is recording who is in the class.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE SAFETY PROPERTIES, AND HOW EACH IS PROVIDED
 * ════════════════════════════════════════════════════════════════════════════
 *
 *   1. ALL OR NOTHING. Every row is written inside ONE transaction. A failure on
 *      row 397 of 400 leaves zero students behind — not 396. `recover from failed
 *      imports without corrupting data` is therefore not a feature bolted on; it
 *      is the absence of a partial state.
 *
 *   2. THE REVIEW IS BINDING. The client submits the plan hash it was shown. The
 *      endpoint re-parses the file, re-validates it against the CURRENT database,
 *      and compares the hash. If the file changed, or if the roll changed while
 *      the school was reviewing, the hash differs and the import is refused with
 *      409. What was approved is what runs, or nothing runs.
 *
 *   3. NO PARTIAL SURPRISES FROM CONCURRENCY. `lockForBilling` takes the same
 *      term lock the billing run uses, and unique indexes on
 *      (organization_id, student_id) and (student_id, term_id) back the
 *      application checks at the database level. Two simultaneous imports of the
 *      same file cannot both succeed.
 *
 *   4. REPLAY IS SAFE. An Idempotency-Key is REQUIRED, and a replay returns the
 *      stored result instead of importing again — so a dropped response over a
 *      slow connection does not create a second roll.
 *
 *   5. THE RECORD IS COMPLETE. One `student.import` summary event records who
 *      imported what, and one `student.create` event per student matches exactly
 *      what `POST /api/students` writes for a hand-entered admission. An auditor
 *      asking "when was this child added, and by whom" gets the same answer
 *      whichever door the student came through.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode } from '@/lib/authz';
import { students, auditEvents } from '@/lib/db/schema';
import * as studentRepo from '@/lib/db/repo/students';
import * as classRepo from '@/lib/db/repo/classes';
import * as termRepo from '@/lib/db/repo/terms';
import * as enrollmentRepo from '@/lib/db/repo/enrollments';
import * as guardianRepo from '@/lib/db/repo/guardians';
import * as auditRepo from '@/lib/db/repo/audit-events';
import { begin as beginIdempotency, complete as completeIdempotency } from '@/lib/m9/idempotency';
import { parseCsv, CsvParseError } from '@/lib/onboarding/csv';
import {
  IMPORT_LIMITS,
  mapHeaders,
  planImport,
  type ImportReference,
} from '@/lib/onboarding/student-import';

export const runtime = 'nodejs';

const BodySchema = z
  .object({
    csv: z.string().min(1),
    termId: z.string().uuid(),
    enrolledOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
      .nullish(),
    /** The plan hash the school approved. The import is refused if it differs. */
    planHash: z.string().min(1),
    /** A school may proceed with warnings about possible duplicates; it may not
     *  proceed past an error, because errors mean the plan has no row to write. */
    acknowledgedWarnings: z.boolean().optional(),
  })
  .strict();

export const POST = withAuthorizedRoute(
  { action: 'student.create', method: 'POST', bodySchema: BodySchema },
  async (req, { db, ctx, requestId, body }) => {
    const data = BodySchema.parse(body);

    if (data.csv.length > IMPORT_LIMITS.maxBytes) {
      throw new AuthzError(
        AuthzErrorCode.BAD_REQUEST,
        `The file is too large. The importer accepts up to ${Math.round(IMPORT_LIMITS.maxBytes / 1024)} KB per upload.`,
        400,
      );
    }

    let parsed;
    try {
      parsed = parseCsv(data.csv);
    } catch (e) {
      if (e instanceof CsvParseError)
        throw new AuthzError(AuthzErrorCode.BAD_REQUEST, e.message, 400);
      throw e;
    }

    return db.transaction(async (tx) => {
      const idem = await beginIdempotency(tx, ctx, req, {
        scope: 'student.import',
        path: '/api/onboarding/students/import/commit',
        // The plan hash is part of the payload: replaying the SAME approved file
        // is idempotent, but submitting a DIFFERENT file under a reused key is
        // correctly rejected by the idempotency layer as a different request.
        payload: { planHash: data.planHash, termId: data.termId, csv: data.csv },
        required: true,
      });
      if (idem.replay) return idem.replay;

      // The term lock is taken HERE, before validation, so the reference data the
      // plan is checked against cannot change between the check and the writes.
      // It is the same lock the billing run takes, so an import and a billing run
      // cannot interleave.
      const term = await termRepo.lockForBilling(tx, ctx, data.termId as never);
      if (!term) throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Term not found.', 404);

      // ── Reference data, re-read INSIDE the transaction ────────────────────
      const allClasses = await classRepo.listForOrg(tx, ctx);
      const classes = allClasses
        .filter((c) => !c.deletedAt)
        .map((c) => ({
          id: c.id,
          name: c.name,
          arm: c.arm,
          label: c.arm ? `${c.name} ${c.arm}` : c.name,
        }));

      const mapping = mapHeaders(parsed.headers);
      const idColumn = mapping.index.studentId;
      const surnameColumn = mapping.index.lastName;

      const candidateIds =
        idColumn === undefined
          ? []
          : [
              ...new Set(
                parsed.rows
                  .slice(0, IMPORT_LIMITS.maxRows + 1)
                  .map((row) => (row.cells[idColumn] ?? '').trim().toUpperCase())
                  .filter(Boolean),
              ),
            ];
      const existingStudents = new Map<string, { name: string; status: string }>();
      if (candidateIds.length > 0) {
        const rows = await tx
          .select({
            studentId: students.studentId,
            firstName: students.firstName,
            lastName: students.lastName,
            status: students.status,
          })
          .from(students)
          .where(
            and(
              eq(students.organizationId, ctx.organizationId),
              sql`upper(${students.studentId}) IN (${sql.join(
                candidateIds.map((v) => sql`${v}`),
                sql`, `,
              )})`,
            ),
          );
        for (const r of rows) {
          existingStudents.set(r.studentId.toUpperCase(), {
            name: `${r.firstName} ${r.lastName}`.trim(),
            status: r.status,
          });
        }
      }

      const existingByNameDob = new Map<string, string>();
      const surnames =
        surnameColumn === undefined
          ? []
          : [
              ...new Set(
                parsed.rows
                  .map((row) => (row.cells[surnameColumn] ?? '').trim())
                  .filter((v) => v.length > 0 && v.length <= 120),
              ),
            ].slice(0, 200);
      if (surnames.length > 0) {
        const rows = await tx
          .select({
            firstName: students.firstName,
            lastName: students.lastName,
            dateOfBirth: students.dateOfBirth,
          })
          .from(students)
          .where(
            and(
              eq(students.organizationId, ctx.organizationId),
              isNull(students.deletedAt),
              sql`lower(${students.lastName}) IN (${sql.join(
                surnames.map((s) => sql`${s.toLowerCase()}`),
                sql`, `,
              )})`,
            ),
          )
          .limit(2000);
        for (const r of rows) {
          if (!r.dateOfBirth) continue;
          existingByNameDob.set(
            `${r.firstName.toLowerCase()}|${r.lastName.toLowerCase()}|${r.dateOfBirth}`,
            `${r.firstName} ${r.lastName}`,
          );
        }
      }

      const reference: ImportReference = {
        classes,
        existingStudents,
        existingByNameDob,
        term: {
          id: term.id,
          name: term.name,
          startsOn: String(term.startsOn),
          status: term.status,
        },
      };

      const plan = planImport(parsed, reference, { enrolledOnOverride: data.enrolledOn ?? null });

      // ── PROPERTY 2: the review is binding ─────────────────────────────────
      if (plan.summary.planHash !== data.planHash) {
        throw new AuthzError(
          AuthzErrorCode.CONFLICT,
          'This file no longer matches the preview you approved — the file changed, or the school\u2019s records changed while you were reviewing. ' +
            'Review the import again before confirming. Nothing has been imported.',
          409,
        );
      }

      if (plan.summary.rowsWithErrors > 0) {
        throw new AuthzError(
          AuthzErrorCode.BAD_REQUEST,
          `This file has ${plan.summary.rowsWithErrors} row${plan.summary.rowsWithErrors === 1 ? '' : 's'} with errors and cannot be imported. ` +
            'Correct them and upload again. Nothing has been imported.',
          400,
        );
      }
      if (plan.summary.importable === 0) {
        throw new AuthzError(
          AuthzErrorCode.BAD_REQUEST,
          'There is nothing to import in this file. Nothing has been imported.',
          400,
        );
      }

      // ── Writes ────────────────────────────────────────────────────────────
      const createdStudents: Array<{ id: string; studentId: string; name: string; line: number }> =
        [];
      const createdEnrollments: Array<{ id: string; studentId: string; classId: string }> = [];
      const createdGuardians: Array<{ id: string; name: string }> = [];
      const perStudentIds: string[] = [];
      const perEnrollmentIds: string[] = [];
      const perGuardianIds: string[] = [];

      for (const row of plan.rows) {
        const student = await studentRepo.create(tx, ctx, {
          studentId: row.studentId,
          firstName: row.firstName,
          lastName: row.lastName,
          middleName: row.middleName,
          gender: row.gender,
          dateOfBirth: row.dateOfBirth,
          admissionDate: row.admissionDate ?? row.enrolledOn,
          status: 'ACTIVE',
        });
        createdStudents.push({
          id: student.id,
          studentId: student.studentId,
          name: `${student.firstName} ${student.lastName}`.trim(),
          line: row.line,
        });
        perStudentIds.push(student.id);

        if (row.classId && row.enrolledOn) {
          const enrollment = await enrollmentRepo.create(tx, ctx, {
            studentId: student.id,
            classId: row.classId as never,
            termId: term.id,
            enrolledOn: row.enrolledOn,
          });
          createdEnrollments.push({
            id: enrollment.id,
            studentId: student.id,
            classId: row.classId,
          });
          perEnrollmentIds.push(enrollment.id);
        }

        if (row.guardian) {
          const guardian = await guardianRepo.create(tx, ctx, {
            firstName: row.guardian.firstName,
            lastName: row.guardian.lastName,
            phone: row.guardian.phone,
            email: row.guardian.email,
            address: null,
          });
          // A student's FIRST guardian becomes primary, exactly as the guardian
          // panel does it, so a reminder always resolves to somebody.
          await guardianRepo.link(tx, ctx, {
            studentId: student.id,
            guardianId: guardian.id,
            relationship: row.guardian.relationship,
            isPrimary: true,
          });
          createdGuardians.push({
            id: guardian.id,
            name: `${guardian.firstName} ${guardian.lastName}`.trim(),
          });
          perGuardianIds.push(guardian.id);
        }
      }

      // ── Audit ─────────────────────────────────────────────────────────────
      // Per-student events first, in one statement, so the trail a hand-entered
      // admission produces is the trail an imported one produces.
      if (createdStudents.length > 0) {
        const now = sql`clock_timestamp()`;
        await tx.insert(auditEvents).values(
          createdStudents.map((s) => ({
            organizationId: ctx.organizationId,
            actorType: (ctx.userId ? 'USER' : 'SYSTEM') as 'USER' | 'SYSTEM',
            actorUserId: ctx.userId,
            action: 'student.create',
            entityType: 'student',
            entityId: s.id as never,
            before: null,
            after: {
              studentId: s.studentId,
              name: s.name,
              source: 'csv-import',
              sourceLine: s.line,
            } as never,
            reason: null,
            metadata: { requestId, import: true } as never,
            requestId,
            correlationId: null,
            ipAddress: null,
            createdAt: now as never,
          })),
        );
      }

      await auditRepo.record(tx, ctx, {
        action: 'student.import',
        entityType: 'organization',
        entityId: ctx.organizationId,
        after: {
          termId: term.id,
          termName: term.name,
          studentsCreated: createdStudents.length,
          enrollmentsCreated: createdEnrollments.length,
          guardiansCreated: createdGuardians.length,
          blankRows: plan.summary.blankRows,
          rowsWithWarnings: plan.summary.rowsWithWarnings,
          unrecognisedColumns: plan.summary.unrecognisedColumns,
          planHash: plan.summary.planHash,
          sourceBytes: data.csv.length,
        },
        metadata: { requestId, source: 'csv-import' },
      });

      const result = {
        imported: {
          students: createdStudents.length,
          enrollments: createdEnrollments.length,
          guardians: createdGuardians.length,
          blankRowsSkipped: plan.summary.blankRows,
        },
        students: createdStudents.map(({ id, studentId, name }) => ({ id, studentId, name })),
        term: { id: term.id, name: term.name },
        warnings: plan.issues.filter((i) => i.severity === 'WARNING'),
        notes: plan.summary.notes,
      };
      await completeIdempotency(tx, ctx, idem.key, 201, result);
      return NextResponse.json(result, { status: 201 });
    });
  },
);
