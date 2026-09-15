/**
 * Idempotency key helpers.
 *
 * M0 defines the shape and validation; the idempotency_key table and
 * server-side persistence are introduced when mutations exist (M3/M4).
 *
 * Rules per API_CONTRACTS.md:
 *  - Client sends `Idempotency-Key: <uuid>` on POST/PATCH/PUT/DELETE.
 *  - Key is scoped per (organization_id, user_id) for authenticated requests.
 *  - Retries within 24h (API) or 30 days (webhooks) return the original response.
 *  - Different body with same key returns 409 IDEMPOTENCY_KEY_REUSE.
 */

import { randomUUID } from 'node:crypto';
import { ScolairaApiError } from '../errors';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidIdempotencyKey(key: string | null | undefined): boolean {
  return typeof key === 'string' && UUID_REGEX.test(key);
}

export function assertValidIdempotencyKey(key: string | null | undefined): string {
  if (!isValidIdempotencyKey(key)) {
    throw ScolairaApiError.badRequest('Invalid or missing Idempotency-Key. Expected a UUID.');
  }
  return key as string;
}

/** Generate a new client-side idempotency key (used by UI helpers). */
export function generateIdempotencyKey(): string {
  return randomUUID();
}
