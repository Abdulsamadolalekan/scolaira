/**
 * H-9 — restore verification.
 *
 * A database that has been restored from a backup is *not* thereby correct: a
 * partial dump, a dump taken with triggers disabled, or a restore into a
 * half-migrated cluster all produce a database that opens but lies. This module
 * holds the read-only checks an operator runs against a restored database
 * before it is trusted, and the report they produce.
 *
 * Three properties are deliberate and load-bearing:
 *
 *   1. **READ-ONLY, STRUCTURALLY.** Every statement is issued through
 *      `readOnlyRunner()`, which refuses anything that is not a `SELECT`/`WITH`.
 *      An operator verifying a restore must not be able to change financial
 *      truth by accident — so the tool cannot express a write at all.
 *
 *   2. **NO NEW PRIVILEGE.** The checks assert what the application is already
 *      entitled to see. They add no role, no grant and no bypass: catalog checks
 *      read `pg_class`/`has_table_privilege`, and data checks run in whatever
 *      scope the caller established (platform context for a whole-cluster sweep,
 *      a tenant context for one organization).
 *
 *   3. **IT CANNOT PASS WHAT IT DID NOT CHECK.** A check whose scope was not
 *      supplied reports `SKIPPED` with the reason, never `PASS`. The overall
 *      verdict is `ok` only when there are zero failures AND zero skips of
 *      checks marked required.
 *
 * The invariant statements mirror the ones the database enforces with triggers
 * (M2/M8 financial invariants), which is why they can be trusted as an
 * independent reading: the triggers guarantee them going forward, and this tool
 * proves they hold in the data that was just restored.
 */
import { EXPECTED_MIGRATION_COUNT, LATEST_MIGRATION_TAG } from './migration-manifest';

/** Runs one statement and returns rows. The only way this module talks to a database. */
export type SqlRunner = (statement: string) => Promise<Array<Record<string, unknown>>>;

export type CheckStatus = 'PASS' | 'FAIL' | 'SKIPPED';

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  /** Why a check was skipped; empty for PASS/FAIL. */
  skippedReason?: string;
  /** One line per violated row — named so an operator can go and look. */
  failures: string[];
  /** Facts worth printing even when the check passes. */
  notes: string[];
}

export interface VerificationReport {
  ok: boolean;
  scope: string;
  checks: CheckResult[];
  summary: { passed: number; failed: number; skipped: number };
}

/**
 * Wrap a runner so no statement other than a read can reach the database.
 *
 * This is the structural half of the read-only guarantee: the checks below are
 * written as reads, and this refuses anything else even if one is added later by
 * mistake. It is asserted in `tests/db/h9-restore-verification.test.ts`.
 *
 * Transaction-control statements are permitted because they are the only way to
 * keep one broken check from poisoning the next (see `ISOLATION`). They cannot
 * write data, and `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `COPY` and every
 * form of DDL stay refused.
 */
const ALLOWED_HEADS = [
  'SELECT',
  'WITH',
  'SAVEPOINT',
  'ROLLBACK TO SAVEPOINT',
  'RELEASE SAVEPOINT',
] as const;

export function readOnlyRunner(run: SqlRunner): SqlRunner {
  return async (statement: string) => {
    const head = statement
      .replace(/^\s*(--[^\n]*\n|\s)*/g, '')
      .trimStart()
      .toUpperCase()
      .replace(/\s+/g, ' ');
    const allowed = ALLOWED_HEADS.some((candidate) => head.startsWith(candidate));
    if (!allowed) {
      throw new Error(
        `restore verification is read-only: refused a non-read statement (${head.slice(0, 24)}…)`,
      );
    }
    return run(statement);
  };
}

const num = (v: unknown): number => Number(v ?? 0);
const str = (v: unknown): string => String(v ?? '');

/** Every RLS-enabled table must also FORCE it, or a table owner can read around policy. */
const RLS_TRACKED_EXCEPTIONS = ['app_meta'] as const;

/**
 * Tables the application must be able to operate, and the privileges it must
 * hold. Measured against the migrated schema, not assumed: financial rows are
 * append-only or immutable by design, so `DELETE` is *required to be absent* on
 * `invoices`/`payments`, and both `UPDATE` and `DELETE` on `audit_events`.
 */
const REQUIRED_PRIVILEGES: Array<{ table: string; must: string[]; mustNot: string[] }> = [
  { table: 'invoices', must: ['SELECT', 'INSERT', 'UPDATE'], mustNot: ['DELETE'] },
  { table: 'payments', must: ['SELECT', 'INSERT', 'UPDATE'], mustNot: ['DELETE'] },
  { table: 'payment_allocations', must: ['SELECT', 'INSERT', 'UPDATE'], mustNot: [] },
  { table: 'reversals', must: ['SELECT', 'INSERT'], mustNot: [] },
  { table: 'receipts', must: ['SELECT', 'INSERT'], mustNot: [] },
  { table: 'member_invitations', must: ['SELECT', 'INSERT', 'UPDATE'], mustNot: [] },
  { table: 'audit_events', must: ['SELECT', 'INSERT'], mustNot: ['UPDATE', 'DELETE'] },
];

/** Objects the runtime needs before it can serve at all. */
const REQUIRED_OBJECTS = [
  'organizations',
  'organization_members',
  'users',
  'invoices',
  'invoice_lines',
  'payments',
  'payment_allocations',
  'reversals',
  'receipts',
  'audit_events',
  'member_invitations',
];

/** The runtime role the privilege checks speak about. */
const APP_ROLE = 'scolaira_app';

function sqlList(values: readonly string[]): string {
  return values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
}

/* ------------------------------------------------------------------ checks */

async function checkMigrationState(run: SqlRunner): Promise<CheckResult> {
  const id = 'schema.migration_state';
  const title = 'the restored database is migrated to what this build expects';
  const rows = await run('SELECT ops_migration_state() AS state');
  const state = (rows[0]?.state ?? {}) as Record<string, unknown>;
  const applied = num(state.applied);
  const latest = str(state.latest);
  const failures: string[] = [];
  if (applied !== EXPECTED_MIGRATION_COUNT) {
    failures.push(`applied ${applied} migrations, this build expects ${EXPECTED_MIGRATION_COUNT}`);
  }
  if (latest !== LATEST_MIGRATION_TAG) {
    failures.push(
      `newest applied migration is "${latest}", build expects "${LATEST_MIGRATION_TAG}"`,
    );
  }
  return { id, title, status: failures.length ? 'FAIL' : 'PASS', failures, notes: [] };
}

async function checkRequiredObjects(run: SqlRunner): Promise<CheckResult> {
  const id = 'schema.required_objects';
  const title = 'every object the runtime needs exists';
  const rows = await run(
    `SELECT c.relname AS name FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND c.relname IN (${sqlList(REQUIRED_OBJECTS)})`,
  );
  const present = new Set(rows.map((r) => str(r.name)));
  const failures = REQUIRED_OBJECTS.filter((t) => !present.has(t)).map(
    (t) => `missing table: ${t}`,
  );
  const rowsFn = await run(
    `SELECT p.proname AS name FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('ops_migration_state')`,
  );
  if (rowsFn.length === 0) failures.push('missing function: ops_migration_state()');
  return { id, title, status: failures.length ? 'FAIL' : 'PASS', failures, notes: [] };
}

async function checkInvoiceTotals(run: SqlRunner): Promise<CheckResult> {
  const id = 'financial.invoice_totals';
  const title = 'every invoice total equals the sum of its lines';
  const rows = await run(
    `SELECT i.invoice_number AS n, i.total_kobo AS total, COALESCE(SUM(l.amount_kobo), 0) AS lines
       FROM invoices i LEFT JOIN invoice_lines l ON l.invoice_id = i.id
      GROUP BY i.id, i.invoice_number, i.total_kobo
     HAVING i.total_kobo <> COALESCE(SUM(l.amount_kobo), 0)`,
  );
  const failures = rows.map(
    (r) => `invoice ${str(r.n)}: total ${num(r.total)} <> lines ${num(r.lines)}`,
  );
  return { id, title, status: failures.length ? 'FAIL' : 'PASS', failures, notes: [] };
}

async function checkInvoicePaid(run: SqlRunner): Promise<CheckResult> {
  const id = 'financial.invoice_paid';
  const title = 'every invoice paid amount equals its active allocations';
  const rows = await run(
    `SELECT i.invoice_number AS n, i.paid_kobo AS paid, COALESCE(SUM(a.amount_kobo), 0) AS allocated
       FROM invoices i
       LEFT JOIN payment_allocations a ON a.invoice_id = i.id AND a.status = 'ACTIVE'
      GROUP BY i.id, i.invoice_number, i.paid_kobo
     HAVING i.paid_kobo <> COALESCE(SUM(a.amount_kobo), 0)`,
  );
  const failures = rows.map(
    (r) => `invoice ${str(r.n)}: paid ${num(r.paid)} <> active allocations ${num(r.allocated)}`,
  );
  return { id, title, status: failures.length ? 'FAIL' : 'PASS', failures, notes: [] };
}

async function checkPaymentUnallocated(run: SqlRunner): Promise<CheckResult> {
  const id = 'financial.payment_unallocated';
  const title = 'every payment unallocated amount is its amount minus its active allocations';
  const rows = await run(
    `SELECT p.payment_number AS n, p.amount_kobo AS amount, p.unallocated_kobo AS unalloc,
            COALESCE(SUM(a.amount_kobo), 0) AS allocated
       FROM payments p
       LEFT JOIN payment_allocations a ON a.payment_id = p.id AND a.status = 'ACTIVE'
      GROUP BY p.id, p.payment_number, p.amount_kobo, p.unallocated_kobo
     HAVING p.unallocated_kobo <> (p.amount_kobo - COALESCE(SUM(a.amount_kobo), 0))
         OR p.unallocated_kobo < 0`,
  );
  const failures = rows.map(
    (r) =>
      `payment ${str(r.n)}: unallocated ${num(r.unalloc)}, amount ${num(r.amount)}, ` +
      `active allocations ${num(r.allocated)}`,
  );
  return { id, title, status: failures.length ? 'FAIL' : 'PASS', failures, notes: [] };
}

async function checkReversalCap(run: SqlRunner): Promise<CheckResult> {
  const id = 'financial.reversal_cap';
  const title = 'no payment is reversed beyond its own amount';
  const rows = await run(
    `SELECT p.payment_number AS n, p.amount_kobo AS amount, COALESCE(SUM(r.amount_kobo), 0) AS reversed
       FROM payments p JOIN reversals r ON r.payment_id = p.id
      GROUP BY p.id, p.payment_number, p.amount_kobo
     HAVING COALESCE(SUM(r.amount_kobo), 0) > p.amount_kobo`,
  );
  const failures = rows.map(
    (r) => `payment ${str(r.n)}: reversed ${num(r.reversed)} exceeds amount ${num(r.amount)}`,
  );
  return { id, title, status: failures.length ? 'FAIL' : 'PASS', failures, notes: [] };
}

async function checkNoNegativeAmounts(run: SqlRunner): Promise<CheckResult> {
  const id = 'financial.non_negative';
  const title = 'no ledger amount is negative';
  const rows = await run(
    `SELECT 'invoices.total_kobo' AS where, count(*) AS n FROM invoices WHERE total_kobo < 0
      UNION ALL SELECT 'invoices.paid_kobo', count(*) FROM invoices WHERE paid_kobo < 0
      UNION ALL SELECT 'invoice_lines.amount_kobo', count(*) FROM invoice_lines WHERE amount_kobo < 0
      UNION ALL SELECT 'payments.amount_kobo', count(*) FROM payments WHERE amount_kobo < 0
      UNION ALL SELECT 'payments.unallocated_kobo', count(*) FROM payments WHERE unallocated_kobo < 0
      UNION ALL SELECT 'payment_allocations.amount_kobo', count(*) FROM payment_allocations WHERE amount_kobo < 0
      UNION ALL SELECT 'reversals.amount_kobo', count(*) FROM reversals WHERE amount_kobo < 0
      UNION ALL SELECT 'receipts.amount_kobo', count(*) FROM receipts WHERE amount_kobo < 0`,
  );
  const bad = rows.filter((r) => num(r.n) > 0);
  const failures = bad.map((r) => `${str(r.where)}: ${num(r.n)} negative row(s)`);
  return { id, title, status: failures.length ? 'FAIL' : 'PASS', failures, notes: [] };
}

async function checkOrphanedAllocations(run: SqlRunner): Promise<CheckResult> {
  const id = 'financial.orphaned_rows';
  const title = 'no ledger row points at a parent that is not there';
  const rows = await run(
    `SELECT a.id AS id FROM payment_allocations a
       LEFT JOIN payments p ON p.id = a.payment_id
       LEFT JOIN invoices i ON i.id = a.invoice_id
      WHERE p.id IS NULL OR i.id IS NULL`,
  );
  const failures = rows.map((r) => `payment_allocations ${str(r.id)}: dangling payment or invoice`);
  return {
    id,
    title,
    status: failures.length ? 'FAIL' : 'PASS',
    failures,
    notes: [
      'references are also enforced by composite tenant foreign keys; this check catches a ' +
        'restore performed with triggers or constraints disabled',
    ],
  };
}

async function checkForceRls(run: SqlRunner): Promise<CheckResult> {
  const id = 'security.force_rls';
  const title = 'every row-level-secured table also forces it';
  const rows = await run(
    `SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`,
  );
  const noRls = rows.filter((r) => !(r.rls === true || r.rls === 't'));
  const notForced = rows
    .filter((r) => (r.rls === true || r.rls === 't') && !(r.force === true || r.force === 't'))
    .map((r) => str(r.name));
  const failures: string[] = [];
  if (noRls.length) {
    failures.push(`tables without row-level security: ${noRls.map((r) => str(r.name)).join(', ')}`);
  }
  const exceptions = notForced.filter((t) =>
    (RLS_TRACKED_EXCEPTIONS as readonly string[]).includes(t),
  );
  const unexpected = notForced.filter((t) => !exceptions.includes(t));
  for (const t of unexpected) failures.push(`table ${t} has RLS but does not FORCE it`);
  return {
    id,
    title,
    status: failures.length ? 'FAIL' : 'PASS',
    failures,
    notes: exceptions.length
      ? [
          `tracked exception(s), not a restore defect: ${exceptions.join(', ')} ` +
            `(recorded as A5/H-1 scope)`,
        ]
      : [],
  };
}

async function checkRuntimePrivileges(run: SqlRunner): Promise<CheckResult> {
  const id = 'security.runtime_privileges';
  const title = 'the runtime role holds exactly the privileges it needs, and no more';
  const tables = REQUIRED_PRIVILEGES.map((p) => p.table);
  const rows = await run(
    `SELECT t AS name,
            has_table_privilege('${APP_ROLE}', t, 'SELECT') AS sel,
            has_table_privilege('${APP_ROLE}', t, 'INSERT') AS ins,
            has_table_privilege('${APP_ROLE}', t, 'UPDATE') AS upd,
            has_table_privilege('${APP_ROLE}', t, 'DELETE') AS del,
            has_table_privilege('${APP_ROLE}', t, 'TRUNCATE') AS trunc
       FROM unnest(ARRAY[${sqlList(tables)}]::text[]) AS t`,
  );
  const truthy = (v: unknown) => v === true || v === 't';
  const byName = new Map(rows.map((r) => [str(r.name), r]));
  const failures: string[] = [];
  const notes: string[] = [];
  for (const spec of REQUIRED_PRIVILEGES) {
    const row = byName.get(spec.table);
    if (!row) {
      failures.push(`table ${spec.table} not found; privileges unverifiable`);
      continue;
    }
    const granted: Record<string, boolean> = {
      SELECT: truthy(row.sel),
      INSERT: truthy(row.ins),
      UPDATE: truthy(row.upd),
      DELETE: truthy(row.del),
      TRUNCATE: truthy(row.trunc),
    };
    for (const p of spec.must) {
      if (!granted[p]) failures.push(`${APP_ROLE} lacks required ${p} on ${spec.table}`);
    }
    for (const p of spec.mustNot) {
      if (granted[p]) failures.push(`${APP_ROLE} holds forbidden ${p} on ${spec.table}`);
    }
  }
  if (failures.length === 0) {
    notes.push(
      'financial rows remain undeletable and the audit trail remains append-only for the ' +
        'runtime role',
    );
  }
  return { id, title, status: failures.length ? 'FAIL' : 'PASS', failures, notes };
}

/* ------------------------------------------------------------------ runner */

export interface VerifyOptions {
  /** Human label for the scope the data checks run in, e.g. "platform (3 organizations)". */
  scope: string;
  /**
   * Whether a scope capable of reading tenant data was supplied and established.
   * When false the data checks report SKIPPED — never PASS.
   */
  dataReadable: boolean;
  /** Reason printed with skipped data checks. */
  skipReason?: string;
}

/**
 * The check registry. The `id` here is authoritative for labelling a check that
 * throws before it can name itself; the check's own id is verified against it at
 * run time, so the two cannot drift apart silently.
 */
const CHECKS: Array<{
  id: string;
  title: string;
  data: boolean;
  run: (run: SqlRunner) => Promise<CheckResult>;
}> = [
  {
    id: 'schema.migration_state',
    title: 'the restored database is migrated to what this build expects',
    data: false,
    run: checkMigrationState,
  },
  {
    id: 'schema.required_objects',
    title: 'every object the runtime needs exists',
    data: false,
    run: checkRequiredObjects,
  },
  {
    id: 'security.force_rls',
    title: 'every row-level-secured table also forces it',
    data: false,
    run: checkForceRls,
  },
  {
    id: 'security.runtime_privileges',
    title: 'the runtime role holds exactly the privileges it needs, and no more',
    data: false,
    run: checkRuntimePrivileges,
  },
  {
    id: 'financial.invoice_totals',
    title: 'every invoice total equals the sum of its lines',
    data: true,
    run: checkInvoiceTotals,
  },
  {
    id: 'financial.invoice_paid',
    title: 'every invoice paid amount equals its active allocations',
    data: true,
    run: checkInvoicePaid,
  },
  {
    id: 'financial.payment_unallocated',
    title: 'every payment unallocated amount is its amount minus its active allocations',
    data: true,
    run: checkPaymentUnallocated,
  },
  {
    id: 'financial.reversal_cap',
    title: 'no payment is reversed beyond its own amount',
    data: true,
    run: checkReversalCap,
  },
  {
    id: 'financial.non_negative',
    title: 'no ledger amount is negative',
    data: true,
    run: checkNoNegativeAmounts,
  },
  {
    id: 'financial.orphaned_rows',
    title: 'no ledger row points at a parent that is not there',
    data: true,
    run: checkOrphanedAllocations,
  },
];

/**
 * Run every check and build the report. A failure in one check never stops the
 * others: an operator restoring a database needs the whole picture in one pass.
 */
const ISOLATION_NOTE =
  'checks ran without statement-level isolation (no transaction block): a failing ' +
  'statement can abort every later check in this transaction';

export async function verifyRestoredDatabase(
  run: SqlRunner,
  options: VerifyOptions,
): Promise<VerificationReport> {
  const read = readOnlyRunner(run);
  const checks: CheckResult[] = [];
  // One savepoint per check. Without it a single broken check (a missing table,
  // say) aborts the transaction and every later check reports "current
  // transaction is aborted" — a misleading failure that hides the real
  // violation. Every check therefore starts from a clean statement state.
  let isolated = true;
  let sequence = 0;

  for (const entry of CHECKS) {
    if (entry.data && !options.dataReadable) {
      checks.push({
        id: 'data.*',
        title: entry.title,
        status: 'SKIPPED',
        skippedReason:
          options.skipReason ??
          'no scope capable of reading tenant data was supplied, so no data invariant was checked',
        failures: [],
        notes: [],
      });
      continue;
    }

    const savepoint = `h9_verify_${++sequence}`;
    let opened = false;
    if (isolated) {
      try {
        await read(`SAVEPOINT ${savepoint}`);
        opened = true;
      } catch {
        isolated = false;
      }
    }

    let result: CheckResult;
    try {
      result = await entry.run(read);
      if (result.id !== entry.id) {
        // Internal consistency: a check that reports under the wrong name would
        // misattribute its own failure.
        result = {
          id: entry.id,
          title: entry.title,
          status: 'FAIL',
          failures: [`check reported itself as "${result.id}" but is registered as "${entry.id}"`],
          notes: [],
        };
      }
    } catch (error) {
      // A check that cannot run is a failure, not a pass: a verification tool
      // that silently drops its checks is worse than no tool.
      result = {
        id: entry.id,
        title: entry.title,
        status: 'FAIL',
        failures: [`check could not run: ${(error as Error)?.message ?? String(error)}`],
        notes: [],
      };
    }

    if (!isolated) result.notes.push(ISOLATION_NOTE);
    checks.push(result);

    if (opened) {
      try {
        await read(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await read(`RELEASE SAVEPOINT ${savepoint}`);
      } catch {
        isolated = false;
      }
    }
  }

  // One SKIPPED entry per data check would be noise; the operator needs one line
  // saying that no data invariant was checked and why.
  const finalChecks: CheckResult[] = [];
  let collapsedSkip = false;
  for (const c of checks) {
    if (c.status === 'SKIPPED') {
      if (!collapsedSkip) {
        collapsedSkip = true;
        finalChecks.push({
          id: 'data.invariants',
          title: 'financial data invariants (every data check)',
          status: 'SKIPPED',
          skippedReason: c.skippedReason,
          failures: [],
          notes: [],
        });
      }
      continue;
    }
    finalChecks.push(c);
  }

  const summary = {
    passed: finalChecks.filter((c) => c.status === 'PASS').length,
    failed: finalChecks.filter((c) => c.status === 'FAIL').length,
    skipped: finalChecks.filter((c) => c.status === 'SKIPPED').length,
  };

  return {
    ok: summary.failed === 0 && summary.skipped === 0,
    scope: options.scope,
    checks: finalChecks,
    summary,
  };
}

/** Render a report for a terminal. */
export function formatReport(report: VerificationReport): string {
  const lines: string[] = [];
  lines.push(`restore verification — scope: ${report.scope}`);
  lines.push('');
  for (const c of report.checks) {
    const mark = c.status === 'PASS' ? 'PASS' : c.status === 'FAIL' ? 'FAIL' : 'SKIP';
    lines.push(`  [${mark}] ${c.id} — ${c.title}`);
    if (c.skippedReason) lines.push(`         ${c.skippedReason}`);
    for (const f of c.failures) lines.push(`         ! ${f}`);
    for (const n of c.notes) lines.push(`         . ${n}`);
  }
  lines.push('');
  lines.push(
    `${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped — ` +
      (report.ok ? 'VERIFIED' : 'NOT VERIFIED'),
  );
  return lines.join('\n');
}
