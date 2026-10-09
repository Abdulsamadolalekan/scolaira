/**
 * POST /api/onboarding/students/import/validate — the dry run.
 *
 * Reads the school's CSV, checks every row against their real classes and their
 * real roll, and returns a full preview: what would be created, what is wrong,
 * and what deserves attention. IT WRITES NOTHING. No student, guardian,
 * enrolment, invoice, payment or audit event is created by this endpoint, and
 * that is asserted by a test rather than promised by a comment.
 *
 * The work is done by `planImport`, the SAME function the commit endpoint uses.
 * A cheaper "preview-only" validator would eventually disagree with the real
 * thing, and the school would approve one import and receive another.
 *
 * AUTHORIZATION
 *   `student.create` — the permission that would be needed to do the work, not a
 *   weaker read permission. Someone who may not create students should not be
 *   able to enumerate what a file would do to the roll.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { withAuthorizedRoute, AuthzError, AuthzErrorCode } from '@/lib/authz';
import { students } from '@/lib/db/schema';
import * as classRepo from '@/lib/db/repo/classes';
import * as termRepo from '@/lib/db/repo/terms';
import { parseCsv, CsvParseError } from '@/lib/onboarding/csv';
import {
  IMPORT_LIMITS,
  issuesToCsv,
  mapHeaders,
  planImport,
  type ImportReference,
} from '@/lib/onboarding/student-import';

export const runtime = 'nodejs';

const BodySchema = z
  .object({
    /** The raw CSV text. Sent as JSON so CSRF and body handling stay uniform. */
    csv: z.string().min(1),
    /** Term the school is enrolling into. Required: enrolment needs a term. */
    termId: z.string().uuid(),
    /** Date used for rows that carry no admission date (DECISION-12). */
    enrolledOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
      .nullish(),
  })
  .strict();

export const POST = withAuthorizedRoute(
  { action: 'student.create', method: 'POST', bodySchema: BodySchema },
  async (_req, { db, ctx, body }) => {
    const data = BodySchema.parse(body);

    // Bounded before parsing: a 40 MB upload should be refused cheaply rather
    // than parsed into memory and then refused.
    if (data.csv.length > IMPORT_LIMITS.maxBytes) {
      throw new AuthzError(
        AuthzErrorCode.BAD_REQUEST,
        `The file is too large (${Math.round(data.csv.length / 1024)} KB). The importer accepts up to ${Math.round(
          IMPORT_LIMITS.maxBytes / 1024,
        )} KB per upload — split the file and import it in parts.`,
        400,
      );
    }

    const term = await termRepo.get(db, ctx, data.termId as never);
    if (!term) throw new AuthzError(AuthzErrorCode.NOT_FOUND, 'Term not found.', 404);

    let parsed;
    try {
      parsed = parseCsv(data.csv);
    } catch (e) {
      if (e instanceof CsvParseError)
        throw new AuthzError(AuthzErrorCode.BAD_REQUEST, e.message, 400);
      throw e;
    }

    // ── Reference data, read inside the caller's tenant scope ──────────────
    // Only ACTIVE (non-archived) classes are offered as import targets, because
    // the enrolment rule in the existing student-create path refuses enrolments
    // into an archived class. Matching against them here would produce a row the
    // commit is then obliged to reject.
    const allClasses = await classRepo.listForOrg(db, ctx);
    const classes = allClasses
      .filter((c) => !c.deletedAt)
      .map((c) => ({
        id: c.id,
        name: c.name,
        arm: c.arm,
        label: c.arm ? `${c.name} ${c.arm}` : c.name,
      }));

    // Columns are located by NAME, not by position: a school's export may order
    // its columns however it likes, and reading `cells[0]` as the admission
    // number would quietly validate the wrong column.
    const mapping = mapHeaders(parsed.headers);
    const idColumn = mapping.index.studentId;
    const surnameColumn = mapping.index.lastName;

    // Admission numbers already in use. ONE indexed query rather than a lookup
    // per row — a 1000-row file must not become 1000 round trips.
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
      const rows = await db
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

    // Possible-duplicate names (DECISION-10). Matched on the surnames present in
    // the file so the query stays small, then keyed on first|last|dob.
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
      const rows = await db
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
            or(...surnames.map((s) => ilike(students.lastName, s))),
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

    return NextResponse.json({
      plan: {
        rows: plan.rows,
        issues: plan.issues,
        summary: plan.summary,
      },
      /** Ready to import: nothing wrong with any row. */
      canCommit: plan.summary.rowsWithErrors === 0 && plan.summary.importable > 0,
      /**
       * Every problem as a CSV, so correcting and re-uploading is mechanical.
       *
       * This deliberately includes WARNINGS, not only errors. Measured defect: the
       * first version filtered to `severity === 'ERROR'`, so a file whose only
       * problem was a phone number that could not be dialled produced a report
       * containing nothing but a header row — the school downloaded a file that
       * appeared to say "no problems" while the screen listed four. The severity
       * column already distinguishes them, and the school needs the warnings to
       * decide, so both are written out.
       */
      errorReportCsv: plan.issues.length > 0 ? issuesToCsv(plan.issues) : null,
      term: reference.term,
      classes,
    });
  },
);
