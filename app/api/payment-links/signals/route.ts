/**
 * GET /api/payment-links/signals — the school's own view of what is happening
 * on its payment links (H-5).
 *
 * Until H-5 the answer was "nothing": refusals (rate limit, backlog bound,
 * amount mismatch, key reuse, reference conflict) were returned to the payer and
 * then forgotten, and the school learned about abuse only if a parent phoned.
 * The events behind this route are append-only, secret-free by constraint (no
 * token, no key, no reference, no payer identity, no amount), and scoped to the
 * calling tenant by the function itself.
 *
 * Query: `?since=24h&limit=200` (hours/minutes accepted; clamped server-side).
 * Authorization: `payment_link.read`.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { withAuthorizedRoute } from '@/lib/authz';

export const runtime = 'nodejs';

const QuerySchema = z.object({
  since: z.string().max(16).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** Only an interval literal is ever passed to the database; never raw text. */
function interval(input: string | undefined): string {
  const match = /^(\d{1,4})\s*(m|min|minute|minutes|h|hour|hours|d|day|days)$/.exec(
    (input ?? '24h').trim().toLowerCase(),
  );
  if (!match) return '24 hours';
  const value = Number(match[1]);
  const unit = match[2] ?? 'h';
  const unitSql = unit.startsWith('m') ? 'minutes' : unit.startsWith('h') ? 'hours' : 'days';
  const capped = Math.min(value, unitSql === 'minutes' ? 10080 : unitSql === 'hours' ? 720 : 30);
  return `${capped} ${unitSql}`;
}

export const GET = withAuthorizedRoute(
  { action: 'payment_link.read', method: 'GET', querySchema: QuerySchema },
  async (_req, { db, query }) => {
    const q = query as { since?: string; limit?: number };
    const since = interval(q.since);
    const limit = q.limit ?? 200;

    // The interval is built from a validated, clamped literal above — never
    // from raw caller text.
    const rows = (await db.execute(sql`
      select occurred_at, kind, link_id, detail
        from auth_public_surface_events(${sql.raw(`interval '${since}'`)}, ${limit})
    `)) as unknown as Array<Record<string, unknown>>;

    const events = (rows ?? []).map((r) => ({
      occurredAt: r.occurred_at as string,
      kind: r.kind as string,
      linkId: (r.link_id as string | null) ?? null,
      // The detail is structured telemetry only (counts, retention windows,
      // rotation numbers) — the table and the recorder both refuse anything
      // that could carry a credential, a payer identity or an amount.
      detail: (r.detail as Record<string, unknown>) ?? {},
    }));

    return NextResponse.json({
      since,
      events,
      // A coarse, actionable summary so the UI does not have to know the
      // severity rules.
      summary: {
        total: events.length,
        refusals: events.filter((e) => e.kind !== 'submission_accepted' && e.kind !== 'submission_replayed').length,
        accepted: events.filter((e) => e.kind === 'submission_accepted').length,
        replayed: events.filter((e) => e.kind === 'submission_replayed').length,
        rateLimited: events.filter((e) => e.kind === 'submission_rate_limited').length,
        unknownBearer: events.filter((e) => e.kind === 'submission_unknown_bearer').length,
        rotations: events.filter((e) => e.kind === 'link_rotated').length,
      },
    });
  },
);
