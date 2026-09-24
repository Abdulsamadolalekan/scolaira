#!/usr/bin/env tsx
/**
 * scripts/public-surface-ops.ts — H-5 operator console for the public payment
 * surface.
 *
 * Run as the OWNER role (`DATABASE_MIGRATION_URL`). Every subcommand is
 * read-only except `prune --apply`, and every subcommand reports what it did in
 * terms an operator can act on, in one of two shapes:
 *
 *   report    which links still carry a live token in stored rows (with the
 *             recommended action) + how much the append-only replay cache holds
 *             + what the surface has been doing lately
 *   signals   abuse/refusal aggregation with severity, for alerting
 *   prune     replay-cache retention: dry-run by default, destructive only with
 *             --apply
 *
 * Exit codes (so a monitor, cron or CI job can act without parsing text):
 *   0  nothing to see
 *   1  warnings present
 *   2  critical signals present
 *   3  the command could not run (e.g. a precondition failed)
 *
 * Usage:
 *   npx tsx scripts/public-surface-ops.ts report [--json]
 *   npx tsx scripts/public-surface-ops.ts signals [--since 1h] [--json] [--quiet]
 *   npx tsx scripts/public-surface-ops.ts prune [--retention 90d] [--limit 5000] [--apply] [--json]
 *
 * NOTE ON ROTATION: rotation is deliberately NOT offered here. It is an
 * authorized, audited, tenant-scoped action (`POST /api/payment-links/:token/rotate`,
 * owner-only, `payment_link.rotate`), because it retires a credential payers are
 * currently using. A database-side rotation would bypass the authorization
 * boundary and the audit trail; this console therefore only REPORTS which links
 * need it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';

for (const file of ['.env', '.env.local']) {
  try {
    const body = readFileSync(resolve(process.cwd(), file), 'utf8');
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        val = val.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    /* ok */
  }
}

const args = process.argv.slice(2);
const command = (args[0] ?? 'report').toLowerCase();
const json = args.includes('--json');
const quiet = args.includes('--quiet');
const apply = args.includes('--apply');

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

const EXIT_OK = 0;
const EXIT_WARNING = 1;
const EXIT_CRITICAL = 2;
const EXIT_ERROR = 3;

function print(payload: unknown, text: string) {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (!quiet) console.log(text);
}

/**
 * Interval literals are never interpolated from raw caller text: the shape is
 * matched, the unit is mapped to a fixed SQL word, and the value is clamped —
 * so the database receives one of three known forms.
 *
 * The clamp is context-aware: a LOOKBACK (how far back to read signals) is
 * capped at 30 days; a RETENTION window is capped at ten years, matching the
 * bound the prune itself enforces. Clamping a retention window down to 30 days
 * would silently delete far more than the operator asked for.
 */
function intervalLiteral(
  input: string | undefined,
  fallback: string,
  kind: 'lookback' | 'retention' = 'lookback',
): string {
  if (!input) return fallback;
  const match = /^(\d{1,4})\s*(m|min|minute|minutes|h|hour|hours|d|day|days)$/.exec(input.trim().toLowerCase());
  if (!match) {
    throw new Error(`unrecognised interval "${input}" (examples: 30m, 4h, 7d)`);
  }
  const value = Number(match[1]);
  const unit = match[2] ?? 'h';
  const unitSql = unit.startsWith('m') ? 'minutes' : unit.startsWith('h') ? 'hours' : 'days';
  const ceiling =
    kind === 'retention' ? (unitSql === 'minutes' ? 1440 : unitSql === 'hours' ? 24 : 3650) : unitSql === 'minutes' ? 10080 : unitSql === 'hours' ? 720 : 30;
  return `${Math.min(value, ceiling)} ${unitSql}`;
}

async function main() {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('Set DATABASE_MIGRATION_URL (owner role) before running this console.');
    process.exit(EXIT_ERROR);
  }

  const sql = postgres(url, {
    max: 1,
    onconnect: async (client: any) => {
      await client.simple(`SET search_path = pg_catalog, public;`);
    },
  } as any);

  try {
    // Preconditions: the console must fail loudly rather than answer from a
    // database where the operational contract is not installed.
    const installed = (await sql.unsafe(
      `select to_regprocedure('auth_public_remediation_report()') is not null as report_fn,
              to_regprocedure('auth_public_submission_cache_report()') is not null as cache_fn,
              to_regprocedure('auth_public_submission_cache_prune(interval,integer,boolean)') is not null as prune_fn,
              to_regprocedure('auth_public_surface_signal_report(interval,integer)') is not null as signal_fn,
              to_regclass('public.public_surface_events') is not null as events_table,
              (select max(tag) from drizzle.__drizzle_migrations) as last_migration`,
    )) as any[];
    const pre = installed[0];
    if (!pre?.report_fn || !pre?.cache_fn || !pre?.prune_fn || !pre?.signal_fn || !pre?.events_table) {
      console.error('[ops] H-5 operational functions are not installed (migration 0047 missing).');
      process.exit(EXIT_ERROR);
    }

    if (command === 'report') {
      const remediation = (await sql.unsafe(`select * from auth_public_remediation_report()`)) as any[];
      const cache = (await sql.unsafe(`select * from auth_public_submission_cache_report()`)) as any[];
      const signals = (await sql.unsafe(`select * from auth_public_surface_signal_report(interval '24 hours', 50)`)) as any[];
      const atRisk = remediation.filter((r: any) => r.recommended_action === 'ROTATE');
      const payload = { lastMigration: pre.last_migration, remediation, cache: cache[0] ?? null, signals };
      const lines = [
        `[ops] schema: ${pre.last_migration}`,
        `[ops] links needing rotation: ${atRisk.length}`,
        ...remediation
          .slice(0, 20)
          .map(
            (r: any) =>
              `      ${r.recommended_action.padEnd(6)} ${r.link_id} (${r.status}) org=${r.organization_id} ` +
              `payments=${r.exposed_payment_rows} audit=${r.exposed_audit_rows} last=${r.last_exposed_at ?? '-'}`,
          ),
        `[ops] replay cache: total=${cache[0]?.total_reservations ?? 0} live_pending=${cache[0]?.live_pending ?? 0} ` +
          `settled=${cache[0]?.settled ?? 0} pruneable=${cache[0]?.pruneable ?? 0} oldest=${cache[0]?.oldest_created_at ?? '-'} ` +
          `retention=${cache[0]?.retention_days ?? 90}d`,
        `[ops] signals (24h): ${signals.length === 0 ? 'none' : ''}`,
        ...signals
          .slice(0, 20)
          .map(
            (s: any) =>
              `      ${String(s.severity).toUpperCase().padEnd(8)} ${s.kind} link=${s.link_id ?? '-'} events=${s.events} ` +
              `window=${s.current_window_count ?? '-'} last=${s.last_seen}`,
          ),
      ];
      print(payload, lines.join('\n'));

      if (signals.some((s: any) => s.severity === 'critical')) process.exit(EXIT_CRITICAL);
      if (signals.some((s: any) => s.severity === 'warning')) process.exit(EXIT_WARNING);
      process.exit(EXIT_OK);
    }

    if (command === 'signals') {
      const since = intervalLiteral(flag('--since'), '1 hour');
      const rows = (await sql.unsafe(
        `select * from auth_public_surface_signal_report($1::interval, 200)`,
        [since],
      )) as any[];
      print(
        { since, count: rows.length, signals: rows },
        rows.length === 0
          ? `[ops] no public-surface signals in the last ${since}`
          : rows
              .map(
                (s: any) =>
                  `${String(s.severity).toUpperCase().padEnd(8)} ${s.kind} link=${s.link_id ?? '-'} ` +
                  `events=${s.events} window=${s.current_window_count ?? '-'} first=${s.first_seen} last=${s.last_seen}`,
              )
              .join('\n'),
      );
      if (rows.some((s: any) => s.severity === 'critical')) process.exit(EXIT_CRITICAL);
      if (rows.some((s: any) => s.severity === 'warning')) process.exit(EXIT_WARNING);
      process.exit(EXIT_OK);
    }

    if (command === 'prune') {
      const retention = intervalLiteral(flag('--retention'), '90 days', 'retention');
      const limit = Number(flag('--limit') ?? 5000);
      if (!Number.isFinite(limit) || limit < 1 || limit > 50000) {
        console.error('[ops] --limit must be an integer between 1 and 50000');
        process.exit(EXIT_ERROR);
      }
      const dryRun = !apply;
      const result = (await sql.unsafe(
        `select * from auth_public_submission_cache_prune($1::interval, $2::integer, $3::boolean)`,
        [retention, limit, dryRun],
      )) as any[];
      const row = result[0] ?? {};
      print(
        { retention: row.retention_days, dryRun: row.dry_run, candidates: row.candidates, deleted: row.deleted, limit: row.limit_applied },
        `[ops] replay-cache retention ${row.retention_days}d: candidates=${row.candidates} deleted=${row.deleted} ` +
          (row.dry_run ? '(dry run — re-run with --apply to delete)' : '(applied)'),
      );
      process.exit(EXIT_OK);
    }

    console.error(`[ops] unknown command "${command}" (expected: report | signals | prune)`);
    process.exit(EXIT_ERROR);
  } catch (e) {
    console.error('[ops] failed:', e instanceof Error ? e.message : String(e));
    process.exit(EXIT_ERROR);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

main().catch((e) => {
  console.error('[ops] failed:', e instanceof Error ? e.message : String(e));
  process.exit(EXIT_ERROR);
});
