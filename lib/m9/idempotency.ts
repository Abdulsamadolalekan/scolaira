import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { AuthzError, AuthzErrorCode } from '@/lib/authz';
import type { TenantCtx, TenantScopedDb } from '@/lib/db/repo/_context';

type StoredIdempotency = {
  scope: string;
  request_method: string | null;
  request_path: string | null;
  request_hash: string | null;
  response_status: number | null;
  response_body: unknown;
};

/**
 * Shared idempotency boundary for M9 academic mutations.
 *
 * Existing M5–M8 mutation callers may still use the compatibility mode with
 * no key. New M9 mutation routes pass `required: true`, so a client cannot
 * accidentally perform an untracked academic write. The raw INSERT uses
 * ON CONFLICT DO NOTHING so a concurrent retry cannot abort the caller's
 * transaction before it can read the committed winner.
 */
export function requestHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex');
}

export function getIdempotencyKey(req: Request): string | null {
  const value = req.headers.get('idempotency-key')?.trim() ?? '';
  if (!value) return null;
  if (value.length > 128) {
    throw new AuthzError(AuthzErrorCode.BAD_REQUEST, 'Idempotency-Key must be 128 characters or fewer.', 400);
  }
  return value;
}

export async function begin(
  db: TenantScopedDb,
  ctx: TenantCtx,
  req: Request,
  options: { scope: string; path: string; payload: unknown; required?: boolean },
): Promise<{ key: string | null; replay: NextResponse | null }> {
  const key = getIdempotencyKey(req);
  if (!key && options.required) {
    throw new AuthzError(AuthzErrorCode.BAD_REQUEST, 'Idempotency-Key header is required for this mutation.', 400);
  }
  if (!key) return { key: null, replay: null };

  const hash = requestHash(options.payload);
  const inserted = await db.execute(sql`
    INSERT INTO idempotency_keys (
      organization_id, user_id, key, scope, request_method, request_path,
      request_hash, locked_at, expires_at
    ) VALUES (
      ${ctx.organizationId}::uuid, ${ctx.userId}::uuid, ${key}, ${options.scope},
      ${req.method}, ${options.path}, ${hash}, now(), now() + interval '24 hours'
    )
    ON CONFLICT (organization_id, user_id, key) DO NOTHING
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  if (inserted.length > 0) return { key, replay: null };

  const rows = await db.execute(sql`
    SELECT scope, request_method, request_path, request_hash, response_status, response_body
      FROM idempotency_keys
     WHERE organization_id = ${ctx.organizationId}::uuid
       AND user_id = ${ctx.userId}::uuid
       AND key = ${key}
     LIMIT 1
  `) as unknown as StoredIdempotency[];
  const existing = rows[0];
  if (!existing) {
    // This should only be reachable for an expired/externally removed key;
    // surface a safe retry rather than executing an untracked mutation.
    return {
      key,
      replay: NextResponse.json(
        { error: { code: 'IDEMPOTENCY_IN_PROGRESS', message: 'This request is already in progress.' } },
        { status: 409 },
      ),
    };
  }
  const requestShapeMatches = existing.scope === options.scope
    && existing.request_method === req.method
    && existing.request_path === options.path;
  if (!requestShapeMatches || (existing.request_hash && existing.request_hash !== hash)) {
    return {
      key,
      replay: NextResponse.json(
        { error: { code: 'IDEMPOTENCY_KEY_REUSED', message: 'This Idempotency-Key was used with a different request.' } },
        { status: 409 },
      ),
    };
  }
  if (existing.response_status && existing.response_body) {
    const replay = NextResponse.json(existing.response_body, { status: existing.response_status });
    replay.headers.set('Idempotent-Replayed', 'true');
    return { key, replay };
  }
  return {
    key,
    replay: NextResponse.json(
      { error: { code: 'IDEMPOTENCY_IN_PROGRESS', message: 'This request is already in progress.' } },
      { status: 409 },
    ),
  };
}

export async function complete(
  db: TenantScopedDb,
  ctx: TenantCtx,
  key: string | null,
  status: number,
  body: unknown,
): Promise<void> {
  if (!key) return;
  await db.execute(sql`
    UPDATE idempotency_keys
       SET response_status = ${status},
           response_body = ${JSON.stringify(body)}::jsonb,
           locked_at = NULL,
           recovered_at = now()
     WHERE organization_id = ${ctx.organizationId}::uuid
       AND user_id = ${ctx.userId}::uuid
       AND key = ${key}
  `);
}
