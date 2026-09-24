// @vitest-environment node
/**
 * R1 (C-2) — cross-tenant financial parent references.
 *
 * INVARIANT UNDER TEST
 *   A financial child row that belongs to organization A can never reference a
 *   parent row (invoice, payment, allocation, reversal, receipt, link, waiver,
 *   reminder, case, candidate, evidence, term, class, student, guardian, fee
 *   definition, fee assignment, academic session) that belongs to organization
 *   B — and can therefore never cause a financial trigger to mutate a foreign
 *   parent.
 *
 * WHY THIS SUITE EXISTS
 *   Before migration 0038 the schema carried NO `(organization_id, id)`
 *   constraint anywhere: children referenced parents by bare `id`. Referential
 *   integrity checks do NOT consult row-level security, so RLS could not stop
 *   a cross-org reference, and the financial triggers resolved parents by that
 *   bare id — meaning a forged reference did not merely "point" at another
 *   tenant's money, it made the database recompute the other tenant's
 *   `paid_kobo` / `unallocated_kobo`.
 *
 * HOW IT IS PROVED
 *   1. Catalog completeness: every FK between two tenant-scoped tables has an
 *      organization-composite counterpart, and every referenced parent carries
 *      a unique `(organization_id, id)` index.
 *   2. Attack per relationship: as the runtime role, inside a REAL tenant
 *      scope for org A, insert a child row whose parent column points at an
 *      org-B row. Because FK checks bypass RLS, a rejection here is proof that
 *      the CONSTRAINT (not row security) is what stopped it.
 *   3. The canonical money case: allocating org A's payment against org B's
 *      invoice must leave org B's invoice/payment byte-for-byte unchanged.
 *   4. The runtime role cannot drop or defer the constraints.
 *
 * WHY NOT "AS THE TABLE OWNER": both `scolaira_owner` and `scolaira_app` are
 * NOSUPERUSER/NOBYPASSRLS, and the tenant tables are FORCE ROW LEVEL SECURITY,
 * so an owner connection is subject to the same policies — an "owner" run
 * would silently update zero rows and prove nothing. Cross-tenant enforcement
 * above RLS (BYPASSRLS role) is exercised out-of-band and recorded in the R1
 * closeout; the automated proof below is stronger in the sense that it runs
 * through the exact boundary the application uses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { testSql } from '../setup-db';
import { withScopedDb, withSystemContext } from '@/lib/db/tenant';
import { seedTwoOrgs, type SeededIds } from '../support/seed';
import * as invoicesRepo from '@/lib/db/repo/invoices';
import * as invoiceLinesRepo from '@/lib/db/repo/invoice-lines';
import * as paymentsRepo from '@/lib/db/repo/payments';
import * as allocationsRepo from '@/lib/db/repo/payment-allocations';
import * as reversalsRepo from '@/lib/db/repo/reversals';
import * as receiptsRepo from '@/lib/db/repo/receipts';
import * as paymentLinksRepo from '@/lib/db/repo/payment-links';
import * as remindersRepo from '@/lib/db/repo/reminders';
import * as collectionsRepo from '@/lib/db/repo/collections';
import * as reconciliationRepo from '@/lib/db/repo/reconciliation';
import { kobo } from '@/lib/money';
import type { TenantCtx, UUID } from '@/lib/db/repo/_context';

/**
 * Fixtures must be COMMITTED to be attackable (the per-test harness transaction
 * rolls back), and the scope needs a real second connection, so the fixture
 * runs on its own pool through the normal reserved-connection path.
 */
const FIXTURE_URL =
  process.env.DATABASE_URL ?? 'postgresql://scolaira_app:scolaira_app_pw@localhost:5432/scolaira_test';
const fixturePool = postgres(FIXTURE_URL, { max: 3 });

// ---------------------------------------------------------------------------
// Attack matrix: child table → tenant-scoped parents it may reference
// ---------------------------------------------------------------------------

interface Relation {
  child: string;
  col: string;
  parent: string;
  /**
   * Optional per-relation override of the child's reference map. `null` emits
   * SQL NULL for that column (used where a pre-existing unique constraint would
   * otherwise fire before the boundary under test).
   */
  refs?: Record<string, string | null>;
}

/** Every tenant-scoped child → tenant-scoped parent relationship in the schema. */
const RELATIONS: Relation[] = [
  { child: 'invoices', col: 'student_id', parent: 'students' },
  { child: 'invoices', col: 'term_id', parent: 'terms' },
  { child: 'invoices', col: 'session_id', parent: 'academic_sessions' },
  { child: 'invoice_lines', col: 'invoice_id', parent: 'invoices' },
  { child: 'invoice_lines', col: 'fee_assignment_id', parent: 'fee_assignments' },
  { child: 'invoice_lines', col: 'billing_student_id', parent: 'students' },
  { child: 'invoice_lines', col: 'billing_term_id', parent: 'terms' },
  { child: 'payment_allocations', col: 'payment_id', parent: 'payments' },
  { child: 'payment_allocations', col: 'invoice_id', parent: 'invoices' },
  { child: 'payment_allocations', col: 'reversal_id', parent: 'reversals' },
  { child: 'reversals', col: 'payment_id', parent: 'payments' },
  // Receipts carry a "one receipt per payment" unique constraint, so a second,
  // receipt-free payment is used to keep the foreign reference itself the
  // deciding factor.
  { child: 'receipts', col: 'payment_id', parent: 'payments', refs: { payment_id: 'payments2', allocation_id: null, student_id: 'students' } },
  { child: 'receipts', col: 'allocation_id', parent: 'payment_allocations', refs: { payment_id: 'payments2', allocation_id: 'payment_allocations', student_id: 'students' } },
  { child: 'receipts', col: 'student_id', parent: 'students', refs: { payment_id: 'payments2', allocation_id: null, student_id: 'students' } },
  { child: 'payment_links', col: 'invoice_id', parent: 'invoices' },
  { child: 'payment_links', col: 'student_id', parent: 'students' },
  { child: 'waivers', col: 'invoice_line_id', parent: 'invoice_lines' },
  { child: 'reminders', col: 'invoice_id', parent: 'invoices' },
  { child: 'reminders', col: 'student_id', parent: 'students' },
  { child: 'reminders', col: 'guardian_id', parent: 'guardians' },
  { child: 'student_guardians', col: 'student_id', parent: 'students' },
  { child: 'student_guardians', col: 'guardian_id', parent: 'guardians' },
  { child: 'class_enrollments', col: 'student_id', parent: 'students' },
  { child: 'class_enrollments', col: 'class_id', parent: 'classes' },
  { child: 'class_enrollments', col: 'term_id', parent: 'terms' },
  { child: 'fee_assignments', col: 'fee_definition_id', parent: 'fee_definitions' },
  { child: 'fee_assignments', col: 'term_id', parent: 'terms' },
  { child: 'fee_assignments', col: 'class_id', parent: 'classes' },
  { child: 'terms', col: 'session_id', parent: 'academic_sessions' },
  { child: 'collections_cases', col: 'student_id', parent: 'students' },
  { child: 'collections_case_events', col: 'case_id', parent: 'collections_cases' },
  { child: 'collections_case_events', col: 'reminder_id', parent: 'reminders' },
  { child: 'reconciliation_cases', col: 'payment_id', parent: 'payments' },
  { child: 'reconciliation_candidates', col: 'case_id', parent: 'reconciliation_cases' },
  { child: 'reconciliation_candidates', col: 'invoice_id', parent: 'invoices' },
  { child: 'reconciliation_candidates', col: 'student_id', parent: 'students' },
  { child: 'reconciliation_evidence', col: 'case_id', parent: 'reconciliation_cases' },
];

interface RowIndex {
  org: string;
  user: string;
  [table: string]: string;
}

/**
 * Insert templates: `refs` maps a column to the parent table it must resolve
 * to; `literals` supplies the remaining required (non-UUID) columns. The
 * attacked column is resolved against the FOREIGN org, every other reference
 * against the attacker's own org.
 */
const INSERTS: Record<
  string,
  {
    refs: Record<string, string>;
    literals?: string;
    conflict?: string;
  }
> = {
  invoices: {
    refs: { student_id: 'students', term_id: 'terms', session_id: 'academic_sessions' },
    literals: `invoice_number, status`,
  },
  invoice_lines: {
    refs: { invoice_id: 'invoices', fee_assignment_id: 'fee_assignments', billing_student_id: 'students', billing_term_id: 'terms' },
    literals: `description, description2, unit_rate_kobo, amount_kobo`,
  },
  payment_allocations: {
    refs: { payment_id: 'payments', invoice_id: 'invoices', reversal_id: 'reversals' },
    literals: `amount_kobo`,
  },
  reversals: {
    refs: { payment_id: 'payments' },
    literals: `type, amount_kobo, reason`,
  },
  receipts: {
    refs: { payment_id: 'payments', allocation_id: 'payment_allocations', student_id: 'students' },
    literals: `amount_kobo`,
  },
  payment_links: {
    refs: { invoice_id: 'invoices', student_id: 'students' },
    literals: `token, amount_kobo`,
  },
  waivers: {
    refs: { invoice_line_id: 'invoice_lines' },
    literals: `reason, amount_kobo, approved_by`,
  },
  reminders: {
    refs: { invoice_id: 'invoices', student_id: 'students', guardian_id: 'guardians' },
    literals: `channel, body`,
  },
  student_guardians: {
    refs: { student_id: 'students', guardian_id: 'guardians' },
  },
  class_enrollments: {
    refs: { student_id: 'students', class_id: 'classes', term_id: 'terms' },
    literals: `enrolled_on`,
  },
  fee_assignments: {
    refs: { fee_definition_id: 'fee_definitions', term_id: 'terms', class_id: 'classes' },
    literals: `amount_kobo, status`,
  },
  terms: {
    refs: { session_id: 'academic_sessions' },
    literals: `name, label, starts_on, due_date`,
  },
  collections_cases: {
    refs: { student_id: 'students' },
    literals: `reason, created_by`,
  },
  collections_case_events: {
    refs: { case_id: 'collections_cases', reminder_id: 'reminders' },
    literals: `event_type, created_by`,
  },
  reconciliation_cases: {
    refs: { payment_id: 'payments' },
    literals: `kind, state, created_by`,
  },
  reconciliation_candidates: {
    refs: { case_id: 'reconciliation_cases', invoice_id: 'invoices', student_id: 'students' },
    literals: `basis, created_by`,
  },
  reconciliation_evidence: {
    refs: { case_id: 'reconciliation_cases' },
    literals: `kind, reference, created_by`,
  },
};

/** Literal SQL fragments per (table, literal column). */
function literalValue(table: string, column: string, own: RowIndex, foreign: RowIndex): string {
  switch (column) {
    case 'invoice_number':
      return `'R1-FK-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)`;
    case 'status':
      return table === 'fee_assignments' ? `'ACTIVE'::fee_assignment_status` : `'DRAFT'::invoice_status`;
    case 'description':
    case 'description2':
      return `'R1 forged line'`;
    case 'amount_kobo':
    case 'unit_rate_kobo':
      return `1000`;
    case 'type':
      return `'REVERSAL'::reversal_type`;
    case 'reason':
      return table === 'waivers' ? `'SCHOLARSHIP'::waiver_reason` : `'R1 forged'`;
    case 'token':
      return `'r1-forged-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)`;
    case 'approved_by':
      return `$OWN_USER::uuid`;
    case 'channel':
      return `'SMS'::communication_channel`;
    case 'body':
      return `'forged'`;
    case 'enrolled_on':
      return `current_date`;
    case 'name':
      return `'R1-T'`;
    case 'label':
      return `'R1'`;
    case 'starts_on':
      return `current_date`;
    case 'due_date':
      return `current_date + 30`;
    case 'created_by':
      return `$OWN_USER::uuid`;
    case 'event_type':
      return `'CREATED'`;
    case 'kind':
      return table === 'reconciliation_evidence' ? `'BANK_REFERENCE'` : `'TO_MATCH'`;
    case 'state':
      return `'UNMATCHED'`;
    case 'basis':
      return `'forged basis'`;
    case 'reference':
      return `'R1-REF'`;
    default:
      throw new Error(`no literal for ${table}.${column}`);
  }
  void own;
  void foreign;
}

/** Build the forged INSERT for one relation. */
function buildAttack(rel: Relation, own: RowIndex, foreign: RowIndex) {
  const spec = INSERTS[rel.child];
  if (!spec) throw new Error(`no insert template for ${rel.child}`);
  const refMap = rel.refs ?? spec.refs;
  const cols: string[] = ['organization_id', ...Object.keys(refMap)];
  const params: unknown[] = [own.org];
  const values: string[] = ['$1::uuid'];
  for (const [col, parentTable] of Object.entries(refMap)) {
    if (parentTable === null) {
      values.push('NULL');
      continue;
    }
    const source = col === rel.col ? foreign : own;
    const id = source[parentTable];
    if (!id) throw new Error(`fixture missing ${parentTable} for ${col === rel.col ? 'foreign' : 'own'} org`);
    params.push(id);
    values.push(`$${params.length}::uuid`);
  }
  // Literal columns (skip any literal whose value was already supplied as a ref).
  const literals = (spec.literals ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((c) => !cols.includes(c));
  for (const column of literals) {
    if (column === 'description2') continue; // alias handled below
    cols.push(column);
    values.push(literalValue(rel.child, column, own, foreign));
  }
  // `description` appears twice in the template for invoice_lines only because
  // the reference column list must line up; the second entry is dropped above.
  const text = `INSERT INTO ${rel.child} (${cols.join(', ')}) VALUES (${values.join(', ')}) RETURNING id`;
  const withUser = text.replace(/\$OWN_USER/g, `$${params.length + 1}`);
  if (withUser !== text) params.push(own.user);
  return { text: withUser, params };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface Fixture {
  label: string;
  rows: RowIndex;
}

let ids: SeededIds;
let A: Fixture;
let B: Fixture;

const ctxOf = (fx: Fixture): TenantCtx => ({
  organizationId: fx.rows.org as UUID,
  userId: fx.rows.user as UUID,
});

async function seedOrgFixture(
  label: string,
  org: UUID,
  user: UUID,
  session: UUID,
  term: UUID,
  klass: UUID,
  student: UUID,
): Promise<Fixture> {
  const rows: RowIndex = {
    org: org as string,
    user: user as string,
    academic_sessions: session as string,
    terms: term as string,
    classes: klass as string,
    students: student as string,
  };

  await withScopedDb(
    { kind: 'tenant', organizationId: org, userId: user },
    async (db, sql) => {
      const ctx: TenantCtx = { organizationId: org, userId: user };

      const feeDefinitionId = randomUUID() as UUID;
      await sql`INSERT INTO fee_definitions (id, organization_id, code, name, default_amount_kobo)
                VALUES (${feeDefinitionId}::uuid, ${org}::uuid, ${'TUITION-' + label}, 'Tuition', 5000000)`;
      rows.fee_definitions = feeDefinitionId as string;

      const feeAssignmentId = randomUUID() as UUID;
      await sql`INSERT INTO fee_assignments (id, organization_id, fee_definition_id, class_id, term_id, amount_kobo, status)
                VALUES (${feeAssignmentId}::uuid, ${org}::uuid, ${feeDefinitionId}::uuid, ${klass}::uuid, ${term}::uuid, 5000000, 'ACTIVE')`;
      rows.fee_assignments = feeAssignmentId as string;

      const draft = await invoicesRepo.createDraft(db as any, ctx, {
        studentId: student,
        termId: term,
        sessionId: session,
      });
      const lines = await invoiceLinesRepo.addLines(db as any, ctx, draft.id, [
        { description: 'Tuition', quantity: 1, unitRateKobo: kobo(5_000_000), amountKobo: kobo(5_000_000) },
      ]);
      const issued = await invoicesRepo.issue(db as any, ctx, draft.id);
      rows.invoices = issued.id as string;
      rows.invoice_lines = (lines as any[])[0].id as string;

      const payment = await paymentsRepo.record(db as any, ctx, {
        method: 'BANK_TRANSFER',
        amountKobo: kobo(2_000_000),
        reference: `R1-${label}-PAY`,
        initialStatus: 'CONFIRMED',
      });
      rows.payments = payment.id as string;

      const allocation = await allocationsRepo.allocate(db as any, ctx, {
        paymentId: payment.id,
        invoiceId: issued.id,
        amountKobo: kobo(1_000_000),
      });
      rows.payment_allocations = (allocation as any).allocation.id as string;

      const payment2 = await paymentsRepo.record(db as any, ctx, {
        method: 'CASH',
        amountKobo: kobo(3_000_000),
        initialStatus: 'CONFIRMED',
      });
      rows.payments2 = payment2.id as string;

      const reversal = await reversalsRepo.create(db as any, ctx, {
        paymentId: payment2.id,
        amountKobo: kobo(1_000_000),
        reason: `R1 ${label} reversal`,
      });
      rows.reversals = reversal.id as string;

      const receipt = await receiptsRepo.issue(db as any, ctx, {
        paymentId: payment.id,
        allocationId: (allocation as any).allocation.id,
        studentId: student,
        amountKobo: kobo(1_000_000),
      });
      rows.receipts = receipt.id as string;

      const link = await paymentLinksRepo.create(db as any, ctx, {
        token: `r1-${label}-${randomUUID().slice(0, 8)}`,
        invoiceId: issued.id,
        amountKobo: kobo(4_000_000),
      });
      rows.payment_links = (link as any).id as string;

      const guardianId = randomUUID() as UUID;
      await sql`INSERT INTO guardians (id, organization_id, first_name, last_name)
                VALUES (${guardianId}::uuid, ${org}::uuid, ${'Guardian'}, ${label})`;
      rows.guardians = guardianId as string;

      const studentGuardianId = randomUUID() as UUID;
      await sql`INSERT INTO student_guardians (id, organization_id, student_id, guardian_id)
                VALUES (${studentGuardianId}::uuid, ${org}::uuid, ${student}::uuid, ${guardianId}::uuid)`;
      rows.student_guardians = studentGuardianId as string;

      const reminder = await remindersRepo.create(db as any, ctx, {
        invoiceId: issued.id,
        studentId: student,
        guardianId,
        channel: 'SMS',
        balanceKobo: 4_000_000,
        agingDays: 10,
        agingBucket: 'OVERDUE_30',
        body: `R1 ${label} reminder`,
      });
      rows.reminders = (reminder as any).id as string;

      const enrollmentId = randomUUID() as UUID;
      await sql`INSERT INTO class_enrollments (id, organization_id, student_id, class_id, term_id, enrolled_on)
                VALUES (${enrollmentId}::uuid, ${org}::uuid, ${student}::uuid, ${klass}::uuid, ${term}::uuid, current_date)`;
      rows.class_enrollments = enrollmentId as string;

      const collCase = await collectionsRepo.createCase(db as any, ctx, {
        studentId: student,
        priority: 'NORMAL',
        reason: `R1 ${label} collections`,
      });
      rows.collections_cases = collCase.id as string;
      const eventRow = (await sql`SELECT id FROM collections_case_events
                                  WHERE case_id = ${collCase.id}::uuid ORDER BY created_at LIMIT 1`) as Array<{ id: string }>;
      rows.collections_case_events = eventRow[0]!.id;

      const recCase = await reconciliationRepo.ensureOpenCase(db as any, ctx, {
        paymentId: payment2.id,
        kind: 'TO_MATCH',
      });
      rows.reconciliation_cases = recCase.id as string;

      const evidenceId = randomUUID() as UUID;
      await sql`INSERT INTO reconciliation_evidence (id, organization_id, case_id, kind, reference, created_by)
                VALUES (${evidenceId}::uuid, ${org}::uuid, ${recCase.id}::uuid, 'BANK_REFERENCE', ${'R1-' + label + '-EVID'}, ${user}::uuid)`;
      rows.reconciliation_evidence = evidenceId as string;

      const candidateId = randomUUID() as UUID;
      await sql`INSERT INTO reconciliation_candidates (id, organization_id, case_id, student_id, invoice_id, basis, created_by)
                VALUES (${candidateId}::uuid, ${org}::uuid, ${recCase.id}::uuid, ${student}::uuid, ${issued.id}::uuid, 'exact amount + reference', ${user}::uuid)`;
      rows.reconciliation_candidates = candidateId as string;

      // Waiver: needs a fee-assignment-backed line on a DRAFT invoice.
      const draftInvoiceId = randomUUID() as UUID;
      const draftLineId = randomUUID() as UUID;
      await sql`INSERT INTO invoices (id, organization_id, invoice_number, student_id, term_id, session_id, status, total_kobo, paid_kobo)
                VALUES (${draftInvoiceId}::uuid, ${org}::uuid, ${'R1-' + label + '-DRAFT'}, ${student}::uuid, ${term}::uuid, ${session}::uuid, 'DRAFT', 1000, 0)`;
      await sql`INSERT INTO invoice_lines (id, organization_id, invoice_id, fee_assignment_id, billing_student_id, billing_term_id,
                                           description, quantity, unit_rate_kobo, amount_kobo)
                VALUES (${draftLineId}::uuid, ${org}::uuid, ${draftInvoiceId}::uuid, ${feeAssignmentId}::uuid, ${student}::uuid,
                        ${term}::uuid, 'Billed tuition', 1, 1000, 1000)`;
      const waiverId = randomUUID() as UUID;
      await sql`INSERT INTO waivers (id, organization_id, invoice_line_id, reason, amount_kobo, approved_by)
                VALUES (${waiverId}::uuid, ${org}::uuid, ${draftLineId}::uuid, 'SCHOLARSHIP', 1000, ${user}::uuid)`;
      rows.waivers = waiverId as string;
    },
    { client: fixturePool },
  );

  return { label, rows };
}

/**
 * Run one statement inside a savepoint and report the SQLSTATE.
 *
 * The savepoint is ALWAYS rolled back: a statement that violates the boundary
 * aborts the enclosing transaction, and an attack attempt must not leave a
 * partially applied row behind. (Note the failure mode this avoids: swallowing
 * an error and then RELEASE-ing its savepoint raises "current transaction is
 * aborted", which would silently turn a clean proof into harness noise.)
 */
async function attempt<T>(
  tag: string,
  fn: (sql: any) => Promise<T>,
  opts: { keep?: boolean } = {},
): Promise<
  { ok: true; value: T } | { ok: false; code?: string; message?: string; constraint?: string }
> {
  const sql = testSql();
  const name = `r1c2_${tag}_${Math.random().toString(36).slice(2, 8)}`;
  await sql.unsafe(`SAVEPOINT ${name}`);
  try {
    const value = await fn(sql);
    if (opts.keep) {
      await sql.unsafe(`RELEASE SAVEPOINT ${name}`);
    } else {
      await sql.unsafe(`ROLLBACK TO SAVEPOINT ${name}`);
      await sql.unsafe(`RELEASE SAVEPOINT ${name}`);
    }
    return { ok: true, value };
  } catch (error: any) {
    await sql.unsafe(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => {});
    await sql.unsafe(`RELEASE SAVEPOINT ${name}`).catch(() => {});
    return {
      ok: false,
      code: error?.code ?? error?.cause?.code,
      message: error?.message ?? error?.cause?.message,
      constraint: error?.constraint ?? error?.cause?.constraint,
    };
  }
}

/** Attempt the forged insert for `rel` inside a real tenant scope for org A. */
async function attack(rel: Relation) {
  return withScopedDb(
    { kind: 'tenant', organizationId: A.rows.org, userId: A.rows.user },
    async () => {
      const built = buildAttack(rel, A.rows, B.rows);
      return attempt('atk', (sql) => sql.unsafe(built.text, built.params));
    },
  );
}

/** Run `fn` in a tenant scope for the given fixture (used to read foreign state). */
async function asTenant<T>(fx: Fixture, fn: (sql: any) => Promise<T>): Promise<T> {
  return withScopedDb(
    { kind: 'tenant', organizationId: fx.rows.org, userId: fx.rows.user },
    async (_db, sql) => fn(sql),
  );
}

beforeAll(async () => {
  ids = await withSystemContext(null, null, async () => seedTwoOrgs(testSql()));
  A = await seedOrgFixture('A', ids.orgId, ids.aliceId, ids.sessionId, ids.termId, ids.classId, ids.studentAId);
  B = await seedOrgFixture('B', ids.orgBId, ids.bobId, ids.sessionBId, ids.termBId, ids.classBId, ids.studentBId);
}, 180_000);

afterAll(async () => {
  await fixturePool.end({ timeout: 5 });
});

// ---------------------------------------------------------------------------
// 1. Catalog completeness
// ---------------------------------------------------------------------------

describe('R1 C-2 — schema-level guarantees', () => {
  it('every tenant-scoped child→parent FK has an organization-composite counterpart', async () => {
    // A "composite" FK is one whose child AND parent column lists both include
    // organization_id. Every FK between two tenant-scoped tables must have one.
    const withoutComposite = (await fixturePool.unsafe(`
      WITH fks AS (
        SELECT c.conname,
               cl.relname AS child,
               pcl.relname AS parent,
               EXISTS (SELECT 1 FROM unnest(c.conkey) k JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k
                        WHERE a.attname = 'organization_id') AS child_org,
               EXISTS (SELECT 1 FROM unnest(c.confkey) k JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k
                        WHERE a.attname = 'organization_id') AS parent_org
          FROM pg_constraint c
          JOIN pg_class cl ON cl.oid = c.conrelid
          JOIN pg_class pcl ON pcl.oid = c.confrelid
          JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
         WHERE c.contype = 'f'
      )
      SELECT f.child, f.parent, f.conname
        FROM fks f
       WHERE f.child_org AND f.parent_org
         AND NOT (f.child_org AND f.parent_org AND EXISTS (
               SELECT 1 FROM pg_constraint c2
                 JOIN pg_class cl2 ON cl2.oid = c2.conrelid
                 JOIN pg_class pcl2 ON pcl2.oid = c2.confrelid
                WHERE c2.contype = 'f'
                  AND cl2.relname = f.child
                  AND pcl2.relname = f.parent
                  AND EXISTS (SELECT 1 FROM unnest(c2.conkey) k JOIN pg_attribute a ON a.attrelid = c2.conrelid AND a.attnum = k WHERE a.attname = 'organization_id')
                  AND EXISTS (SELECT 1 FROM unnest(c2.confkey) k JOIN pg_attribute a ON a.attrelid = c2.confrelid AND a.attnum = k WHERE a.attname = 'organization_id')
             ))
       ORDER BY 1, 2, 3
    `)) as any[];
    expect(withoutComposite).toEqual([]);
  });

  it('every organization-composite parent carries a unique (organization_id, id) index', async () => {
    const missing = (await fixturePool.unsafe(`
      SELECT DISTINCT pcl.relname
        FROM pg_constraint c
        JOIN pg_class pcl ON pcl.oid = c.confrelid
        JOIN pg_namespace n ON n.oid = pcl.relnamespace AND n.nspname = 'public'
       WHERE c.contype = 'f'
         AND EXISTS (SELECT 1 FROM unnest(c.confkey) k JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k WHERE a.attname = 'organization_id')
         AND NOT EXISTS (
           SELECT 1 FROM pg_index i
            WHERE i.indrelid = c.confrelid AND i.indisunique AND i.indisvalid
              AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
                     FROM unnest(i.indkey) k JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k)
                  = ARRAY['id','organization_id']::text[]
         )
       ORDER BY 1
    `)) as any[];
    expect(missing).toEqual([]);
  });

  it('the composite constraints are validated and not deferrable', async () => {
    const lax = (await fixturePool.unsafe(`
      SELECT c.conname, c.convalidated, c.condeferrable, c.condeferred
        FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace AND n.nspname = 'public'
       WHERE c.contype = 'f'
         AND EXISTS (SELECT 1 FROM unnest(c.confkey) k JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k WHERE a.attname = 'organization_id')
         AND (NOT c.convalidated OR c.condeferrable)
       ORDER BY 1
    `)) as any[];
    expect(lax).toEqual([]);
  });

  it('the self-audit helper reports the number of composite constraints actually present', async () => {
    // The helper counts by the convention R1 introduced: every tenant table
    // carries an `*__org_fkey` cascade to organizations(). (It is NOT the same
    // set as "FKs whose parent side includes organization_id" — that is the
    // tenant→tenant composite counterpart set, asserted on its own below, and
    // the two counts only coincided before H-2 added two more tenant tables.)
    const present = (await fixturePool.unsafe(`
      SELECT count(*)::int AS n
        FROM pg_constraint c
        JOIN pg_namespace ns ON ns.oid = c.connamespace AND ns.nspname = 'public'
       WHERE c.contype = 'f'
         AND c.conname LIKE '%__org_fkey'
    `)) as any[];
    const reported = (await fixturePool.unsafe(`SELECT auth_org_composite_fk_count() AS n`)) as any[];
    expect(Number(reported[0].n)).toBe(Number(present[0].n));
    expect(Number(present[0].n)).toBeGreaterThanOrEqual(RELATIONS.length);

    // The composite-counterpart population (parent side includes
    // organization_id) is a different set with the same floor.
    const compositeParents = (await fixturePool.unsafe(`
      SELECT count(DISTINCT c.oid)::int AS n
        FROM pg_constraint c
        JOIN pg_namespace ns ON ns.oid = c.connamespace AND ns.nspname = 'public'
       WHERE c.contype = 'f'
         AND EXISTS (SELECT 1 FROM unnest(c.confkey) k JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k WHERE a.attname = 'organization_id')
    `)) as any[];
    expect(Number(compositeParents[0].n)).toBeGreaterThanOrEqual(RELATIONS.length);
  });

  it('the runtime role cannot drop or defer a composite constraint', async () => {
    const drop = await withScopedDb({ kind: 'tenant', organizationId: A.rows.org, userId: A.rows.user }, async () =>
      attempt('drop', (sql) =>
        sql.unsafe(`ALTER TABLE payment_allocations DROP CONSTRAINT payment_allocations__invoice_id__org_fkey`),
      ),
    );
    expect(drop).toMatchObject({ ok: false, code: '42501' });
  });
});

// ---------------------------------------------------------------------------
// 2. Per-relationship forged INSERTs (runtime role, real tenant scope)
// ---------------------------------------------------------------------------

describe('R1 C-2 — a child of org A cannot reference a parent of org B', () => {
  it.each(RELATIONS.map((r) => [r.child, r.col, r.parent] as const))(
    '%s.%s → %s is rejected with a foreign-key violation',
    async (child, col, parent) => {
      const rel = { child, col, parent };
      expect(A.rows[child], `fixture missing an org-A ${child} row`).toBeTruthy();
      expect(B.rows[parent], `fixture missing an org-B ${parent} row`).toBeTruthy();

      const outcome = await attack(rel);
      expect(outcome.ok, `${child}.${col} was NOT rejected`).toBe(false);
      const failure = outcome as { code?: string; message?: string };
      // Exactly which layer rejects is asserted (and kept current) by the
      // enforcement-layer matrix below.
      expect(failure.code, `${child}.${col} rejected without a SQLSTATE`).toBeTruthy();
      expect(failure.message, `${child}.${col} rejected without a message`).toBeTruthy();
    },
  );
});

describe('R1 C-2 — enforcement-layer matrix', () => {
  /**
   * Which layer rejects each relationship, recorded so that a regression cannot
   * silently move enforcement (or lose it). "constraint" means Postgres raised
   * the composite foreign key itself — the strongest form of evidence, because
   * it is independent of every trigger; "guard" means an org-aware trigger
   * rejected the row first (a strictly earlier line, with the composite
   * constraint still present as the second).
   */
  const EXPECTED: Record<string, { code: string; layer: 'constraint' | 'guard' }> = {
    'invoices.student_id': { code: '23503', layer: 'constraint' },
    'invoices.term_id': { code: '23503', layer: 'constraint' },
    'invoices.session_id': { code: '23503', layer: 'constraint' },
    'invoice_lines.invoice_id': { code: '23503', layer: 'guard' },
    'invoice_lines.fee_assignment_id': { code: '23503', layer: 'guard' },
    'invoice_lines.billing_student_id': { code: '23514', layer: 'guard' },
    'invoice_lines.billing_term_id': { code: '23514', layer: 'guard' },
    'payment_allocations.payment_id': { code: '23503', layer: 'constraint' },
    'payment_allocations.invoice_id': { code: '23503', layer: 'constraint' },
    'payment_allocations.reversal_id': { code: '23503', layer: 'constraint' },
    'reversals.payment_id': { code: '23503', layer: 'constraint' },
    'receipts.payment_id': { code: '23503', layer: 'constraint' },
    'receipts.allocation_id': { code: '23503', layer: 'constraint' },
    'receipts.student_id': { code: '23503', layer: 'constraint' },
    'payment_links.invoice_id': { code: '23503', layer: 'constraint' },
    'payment_links.student_id': { code: '23503', layer: 'constraint' },
    'waivers.invoice_line_id': { code: '23503', layer: 'guard' },
    'reminders.invoice_id': { code: '23503', layer: 'constraint' },
    'reminders.student_id': { code: '23503', layer: 'constraint' },
    'reminders.guardian_id': { code: '23503', layer: 'constraint' },
    'student_guardians.student_id': { code: '23514', layer: 'guard' },
    'student_guardians.guardian_id': { code: '23514', layer: 'guard' },
    'class_enrollments.student_id': { code: '23503', layer: 'guard' },
    'class_enrollments.class_id': { code: '23503', layer: 'guard' },
    'class_enrollments.term_id': { code: '23503', layer: 'guard' },
    'fee_assignments.fee_definition_id': { code: '23503', layer: 'constraint' },
    'fee_assignments.term_id': { code: '23503', layer: 'guard' },
    'fee_assignments.class_id': { code: '23514', layer: 'guard' },
    'terms.session_id': { code: '23514', layer: 'guard' },
    'collections_cases.student_id': { code: '23514', layer: 'guard' },
    'collections_case_events.case_id': { code: '23514', layer: 'guard' },
    'collections_case_events.reminder_id': { code: '23514', layer: 'guard' },
    'reconciliation_cases.payment_id': { code: '23514', layer: 'guard' },
    'reconciliation_candidates.case_id': { code: '23514', layer: 'guard' },
    'reconciliation_candidates.invoice_id': { code: '23514', layer: 'guard' },
    'reconciliation_candidates.student_id': { code: '23514', layer: 'guard' },
    'reconciliation_evidence.case_id': { code: '23514', layer: 'guard' },
  };

  it('matches the recorded enforcement layer for every relationship', async () => {
    const observed: Record<string, string> = {};
    for (const rel of RELATIONS) {
      const key = `${rel.child}.${rel.col}`;
      const expected = EXPECTED[key];
      expect(expected, `no recorded expectation for ${key}`).toBeTruthy();
      const outcome: any = await attack(rel);
      expect(outcome.ok, `${key} was NOT rejected`).toBe(false);
      const byConstraint = new RegExp(
        `violates foreign key constraint "${rel.child}__${rel.col}__org_fkey"`,
      ).test(String(outcome.message));
      observed[key] = `${outcome.code}/${byConstraint ? 'constraint' : 'guard'}`;
      expect(observed[key]).toBe(`${expected!.code}/${expected!.layer}`);
    }
    // Every recorded expectation was exercised.
    expect(Object.keys(observed).sort()).toEqual(Object.keys(EXPECTED).sort());
    // ...and the composite constraints reject on their own for a large share of
    // relationships, so the guarantee does not rest on trigger coverage alone.
    const byConstraintCount = Object.values(observed).filter((v) => v.endsWith('/constraint')).length;
    expect(byConstraintCount).toBeGreaterThanOrEqual(14);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// 3. Trigger parent lookups cannot mutate a foreign tenant's financial truth
// ---------------------------------------------------------------------------

describe('R1 C-2 — trigger parent lookups stay inside the tenant', () => {
  it('a cross-tenant allocation attempt leaves the foreign tenant untouched', async () => {
    const readState = (fx: Fixture) =>
      asTenant(fx, async (sql) => {
        const rows = (await sql.unsafe(
          `SELECT i.paid_kobo::text AS paid, i.total_kobo::text AS total, i.status::text AS status,
                  p.unallocated_kobo::text AS unallocated, p.status::text AS pay_status,
                  (SELECT count(*)::int FROM payment_allocations a
                    WHERE a.organization_id = $1::uuid AND a.invoice_id = i.id) AS allocations
             FROM invoices i, payments p
            WHERE i.id = $2::uuid AND p.id = $3::uuid`,
          [fx.rows.org, fx.rows.invoices, fx.rows.payments],
        )) as any[];
        return rows[0];
      });

    const beforeB = await readState(B);
    const beforeA = await readState(A);
    expect(beforeB).toBeTruthy();

    const outcome = await attack({ child: 'payment_allocations', col: 'invoice_id', parent: 'invoices' });
    expect(outcome).toMatchObject({ ok: false, code: '23503' });

    expect(await readState(B)).toEqual(beforeB);
    expect(await readState(A)).toEqual(beforeA);
    // The attacker's payment was not debited by the allocation trigger either.
    const afterA = await readState(A);
    expect(afterA.unallocated).toBe(beforeA.unallocated);
    expect(afterA.paid).toBe(beforeA.paid);
    expect(afterA.allocations).toBe(beforeA.allocations);
  });

  it('the repository layer cannot allocate across tenants either', async () => {
    // The rejection is allowed to propagate out of the scope (that is what a
    // real caller sees); the scope's own rollback is what keeps the connection
    // usable, so it is asserted on the outside rather than swallowed inside.
    const outcome = await withScopedDb(
      { kind: 'tenant', organizationId: A.rows.org, userId: A.rows.user },
      async (db) => {
        const ctx = ctxOf(A);
        const payment = await paymentsRepo.record(db as any, ctx, {
          method: 'CASH',
          amountKobo: kobo(50_000),
          initialStatus: 'CONFIRMED',
        });
        return allocationsRepo.allocate(db as any, ctx, {
          paymentId: payment.id,
          invoiceId: B.rows.invoices as UUID,
          amountKobo: kobo(50_000),
        });
      },
    ).then(
      () => ({ ok: true as const }),
      (error: any) => ({
        ok: false as const,
        code: error?.code ?? error?.cause?.code,
        message: error?.message ?? error?.cause?.message,
      }),
    );
    expect(outcome.ok).toBe(false);
    expect((outcome as any).message).toBeTruthy();

    const foreign = await asTenant(B, async (sql) => {
      const rows = (await sql.unsafe(
        `SELECT count(*)::int AS n FROM payment_allocations WHERE organization_id = $1::uuid AND invoice_id = $2::uuid`,
        [A.rows.org, B.rows.invoices],
      )) as any[];
      return Number(rows[0].n);
    });
    expect(foreign).toBe(0);
  });

  it('a valid org-A reference still works (the fix did not break legitimate writes)', async () => {
    const outcome = await withScopedDb(
      { kind: 'tenant', organizationId: A.rows.org, userId: A.rows.user },
      async (db) => {
        const ctx = ctxOf(A);
        const payment = await paymentsRepo.record(db as any, ctx, {
          method: 'CASH',
          amountKobo: kobo(250_000),
          initialStatus: 'CONFIRMED',
        });
        return allocationsRepo.allocate(db as any, ctx, {
          paymentId: payment.id,
          invoiceId: A.rows.invoices as UUID,
          amountKobo: kobo(250_000),
        });
      },
    );
    expect((outcome as any).allocation.id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 4. Coverage guard
// ---------------------------------------------------------------------------

describe('R1 C-2 — attack coverage', () => {
  it('every declared relationship has fixture rows in both orgs', () => {
    const uncovered = RELATIONS.filter((r) => !A.rows[r.child] || !B.rows[r.parent]);
    expect(uncovered).toEqual([]);
  });

  it('every relation has an insert template', () => {
    const missing = RELATIONS.filter((r) => !INSERTS[r.child]).map((r) => `${r.child}.${r.col}`);
    expect(missing).toEqual([]);
  });
});
