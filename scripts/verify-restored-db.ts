#!/usr/bin/env tsx
/**
 * scripts/verify-restored-db.ts — H-9 operator tool: verify a restored database.
 *
 * Run after a restore, before the restored database is trusted. Answers one
 * question: *is the data in front of me internally consistent and correctly
 * protected?* It is not a backup tool and it does not prove a backup exists —
 * see `docs/ops/restore.md`, which states plainly that no backup mechanism
 * exists yet.
 *
 *   npm run db:verify -- --platform-admin ops@example.com
 *   npm run db:verify -- --json > restore-verification.json
 *
 * Credentials: `DATABASE_MIGRATION_URL` (the operator/owner credential, the same
 * one `db:migrate` and `scripts/public-surface-ops.ts` use). The tool is
 * READ-ONLY: every statement it can issue is a SELECT (enforced in
 * `lib/ops/restore-verification.ts`, and asserted by test).
 *
 * Scope: financial checks need to read across tenants, so they run in platform
 * context and require the id or email of a REAL platform administrator
 * (`--platform-admin`). Without it the tool still runs the catalog checks
 * (migration state, required objects, RLS posture, runtime privileges) and
 * reports the data checks as SKIPPED — it never reports unchecked data as
 * verified.
 *
 * No new privilege is created by this tool: it uses the platform context the
 * database already mints for a platform administrator (H-8), and asserts only
 * what the runtime role is already entitled to see.
 */
import postgres from 'postgres';
import { withScopedDb } from '@/lib/db/tenant';
import { verifyRestoredDatabase, formatReport } from '@/lib/ops/restore-verification';
import type { UUID } from '@/lib/db/repo/_context';

interface Args {
  json: boolean;
  platformAdmin: string | null;
  databaseUrl: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, platformAdmin: null, databaseUrl: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') args.json = true;
    else if (a === '--platform-admin') args.platformAdmin = argv[++i] ?? null;
    else if (a === '--database-url') args.databaseUrl = argv[++i] ?? null;
    else if (a === '--help' || a === '-h') {
      console.log(
        [
          'usage: npm run db:verify -- [--platform-admin <uuid|email>] [--json] [--database-url <url>]',
          '',
          '  --platform-admin  a real platform administrator, so financial checks can read',
          '                    across tenants in the platform context the database mints.',
          '                    Without it, data checks are reported SKIPPED, never PASS.',
          '  --json            machine-readable report (for an evidence artefact).',
          '  --database-url    override DATABASE_MIGRATION_URL.',
          '',
          'Read-only. Exits non-zero unless every check passed.',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

/** Resolve the platform administrator to an id, telling the operator what failed. */
async function resolvePlatformAdmin(
  identifier: string,
  scopeOptions: { client: postgres.Sql; label: string },
): Promise<UUID> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
  // Bootstrap scope: the platform administrator is looked up before any
  // platform context exists, and `users` is RLS-protected, so the lookup runs
  // through the same scope-isolated connection the application uses.
  const rows = await withScopedDb(
    { kind: 'seed', organizationId: null, userId: null },
    async (_db, sql) =>
      (isUuid
        ? await sql`SELECT id, email, is_platform_admin FROM users WHERE id = ${identifier}`
        : await sql`SELECT id, email, is_platform_admin FROM users WHERE email = ${identifier.toLowerCase()}`) as Array<{
        id: string;
        email: string;
        is_platform_admin: boolean;
      }>,
    scopeOptions,
  );
  const row = rows[0];
  if (!row) throw new Error(`no user found for "${identifier}"`);
  if (!row.is_platform_admin) {
    throw new Error(
      `"${row.email}" is not a platform administrator, so platform context cannot be minted for it`,
    );
  }
  return row.id as UUID;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = args.databaseUrl ?? process.env.DATABASE_MIGRATION_URL;
  if (!url) {
    console.error(
      'DATABASE_MIGRATION_URL is not set. This tool needs the operator (owner) credential; ' +
        'see docs/OPERATIONS.md.',
    );
    process.exit(2);
  }

  // ONE pool, built from the operator's own credential, is passed to every
  // scope below. Without this the checks would silently run on the application
  // pool's database instead of the one being verified — the same class of
  // mistake as pointing a fixture at the wrong database and believing it.
  const operatorPool = postgres(url, { max: 1 }) as unknown as postgres.Sql;
  const databaseName = decodeURIComponent(new URL(url).pathname.replace(/^\//, '')) || '(unnamed)';
  const scopeOptions = { client: operatorPool, label: 'restore-verification' };
  let report;
  try {
    if (args.platformAdmin) {
      const adminId = await resolvePlatformAdmin(args.platformAdmin, scopeOptions);
      report = await withScopedDb(
        { kind: 'platform', userId: adminId },
        async (_db, scoped) => {
          const organizations =
            (await scoped`SELECT count(*)::int AS n FROM organizations`) as Array<{
              n: number;
            }>;
          const count = Number(organizations[0]?.n ?? 0);
          return verifyRestoredDatabase(
            (statement) => scoped.unsafe(statement) as Promise<Array<Record<string, unknown>>>,
            {
              scope: `database "${databaseName}", platform (${count} organization${count === 1 ? '' : 's'})`,
              dataReadable: true,
            },
          );
        },
        scopeOptions,
      );
    } else {
      report = await withScopedDb(
        { kind: 'none' },
        async (_db, scoped) =>
          verifyRestoredDatabase(
            (statement) => scoped.unsafe(statement) as Promise<Array<Record<string, unknown>>>,
            {
              scope: `database "${databaseName}", catalog only (no --platform-admin supplied)`,
              dataReadable: false,
              skipReason:
                'no --platform-admin was supplied, so no tenant data was read and no financial ' +
                'invariant was checked; re-run with --platform-admin <uuid|email> to verify the data',
            },
          ),
        scopeOptions,
      );
    }
  } finally {
    await operatorPool.end({ timeout: 5 }).catch(() => {});
  }

  if (args.json) {
    console.log(JSON.stringify({ ...report, generatedAt: new Date().toISOString() }, null, 2));
  } else {
    console.log(formatReport(report));
  }

  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(
    `restore verification could not run: ${(error as Error)?.message ?? String(error)}`,
  );
  process.exit(2);
});
