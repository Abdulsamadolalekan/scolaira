/**
 * H-2 — explicit pagination for every capped list.
 *
 * Measured defect (register M-6): invoices 200, payments 200, payment-links 100,
 * debtors 500, collections 50, audit 50, students unbounded — every one of them
 * returned a silently truncated page with no count, no cursor and no signal.
 * One surface summed that page into its own headline strip.
 *
 * Contract every list surface now honours:
 *
 *   * a STATED cap, with where the cap comes from (`capSource`);
 *   * an opaque keyset `cursor` (base64url JSON, 1..512 chars) returned as
 *     `nextCursor` when more rows exist — never an offset, so a row inserted
 *     between two pages cannot shift the window;
 *   * `total` = the number of rows matching the same filters, computed from the
 *     database, never from the page;
 *   * `returned` + `hasMore`, so "N of M" is renderable without arithmetic.
 */
import { sql, type SQL } from 'drizzle-orm';
import { AuthzError, AuthzErrorCode } from '@/lib/authz/errors';
import type { UUID } from './_context';

export type CapSource = 'FIXED' | 'ORG_POLICY';

export interface SurfaceLimit {
  /** Limit applied when the caller does not ask for one. */
  defaultLimit: number;
  /** Hard ceiling. A larger `limit` is clamped, and the payload says so. */
  cap: number;
  capSource: CapSource;
  /** Stable surface key: also binds a cursor to the surface that issued it. */
  surface: string;
}

/** The declared limit of every capped surface, in one place. */
export const SURFACE_LIMITS = {
  invoices: { surface: 'invoices', defaultLimit: 100, cap: 200, capSource: 'FIXED' },
  payments: { surface: 'payments', defaultLimit: 100, cap: 200, capSource: 'FIXED' },
  paymentLinks: { surface: 'payment-links', defaultLimit: 100, cap: 100, capSource: 'FIXED' },
  students: { surface: 'students', defaultLimit: 200, cap: 1000, capSource: 'FIXED' },
  debtors: { surface: 'debtors', defaultLimit: 200, cap: 500, capSource: 'FIXED' },
  collections: { surface: 'collections', defaultLimit: 50, cap: 100, capSource: 'FIXED' },
  reconciliation: { surface: 'reconciliation-queue', defaultLimit: 50, cap: 100, capSource: 'FIXED' },
  audit: { surface: 'audit-events', defaultLimit: 50, cap: 100, capSource: 'FIXED' },
  invoiceReminders: { surface: 'invoice-reminders', defaultLimit: 20, cap: 20, capSource: 'FIXED' },
  // H-2: a student's reminder history was a silent `.limit(15)`. It is the same
  // list surface as any other, so it declares its window too.
  studentReminders: { surface: 'student-reminders', defaultLimit: 15, cap: 50, capSource: 'FIXED' },
  financialPeriods: { surface: 'financial-periods', defaultLimit: 50, cap: 100, capSource: 'FIXED' },
} as const satisfies Record<string, SurfaceLimit>;

export const CURSOR_MAX_LENGTH = 512;

export interface PageMeta {
  surface: string;
  limit: number;
  cap: number;
  capSource: CapSource;
  returned: number;
  /**
   * Number of rows matching the same filters, from the database. `null` when a
   * surface cannot count cheaply (declared, never guessed) — `hasMore` and
   * `nextCursor` still tell the client exactly whether more exists.
   */
  total: number | null;
  hasMore: boolean;
  nextCursor: string | null;
}

/** Resolve a caller-supplied `limit` against a declared surface ceiling. */
export function resolveLimit(surface: SurfaceLimit, raw?: string | number | null): number {
  if (raw === undefined || raw === null || raw === '') return surface.defaultLimit;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new AuthzError(
      AuthzErrorCode.BAD_REQUEST,
      `limit must be a positive integer (1..${surface.cap}).`,
      400,
    );
  }
  return Math.min(n, surface.cap);
}

export function resolveLimitOrThrow(surface: SurfaceLimit, raw?: string | number | null): number {
  return resolveLimit(surface, raw);
}

const CURSOR_VERSION = 1;

/**
 * Encode a keyset position. Opaque to clients by contract; the surface key is
 * inside the payload so a cursor from one list cannot be replayed against
 * another (which would silently page the wrong ordering).
 */
export function encodeCursor(
  surface: string,
  values: ReadonlyArray<string | number | null | undefined>,
): string {
  const payload = { v: CURSOR_VERSION, s: surface, k: values.map((v) => (v ?? null)) };
  return Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function decodeCursor(surface: string, raw: string): Array<string | null> {
  if (raw.length === 0 || raw.length > CURSOR_MAX_LENGTH) {
    throw new AuthzError(AuthzErrorCode.BAD_REQUEST, 'Invalid cursor.', 400);
  }
  let parsed: any;
  try {
    const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
    parsed = JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'));
  } catch {
    throw new AuthzError(AuthzErrorCode.BAD_REQUEST, 'Invalid cursor.', 400);
  }
  if (!parsed || parsed.v !== CURSOR_VERSION || parsed.s !== surface || !Array.isArray(parsed.k)) {
    throw new AuthzError(
      AuthzErrorCode.BAD_REQUEST,
      `Cursor does not belong to this surface (${surface}).`,
      400,
    );
  }
  return parsed.k.map((v: unknown) => (v === null || v === undefined ? null : String(v)));
}

/** Build the mandatory `page` block. `total` always comes from the database. */
export function pageMeta(input: {
  surface: SurfaceLimit;
  limit: number;
  returned: number;
  total: number | null;
  nextCursor?: string | null;
  hasMore?: boolean;
}): PageMeta {
  const { surface, limit, returned, total } = input;
  const nextCursor = input.nextCursor ?? null;
  return {
    surface: surface.surface,
    limit,
    cap: surface.cap,
    capSource: surface.capSource,
    returned,
    total,
    hasMore: input.hasMore ?? (Boolean(nextCursor) || (total !== null && returned < total)),
    nextCursor,
  };
}

/**
 * The microsecond sort key for a `(timestamp, id)` keyset.
 *
 * A cursor has to reproduce the ordering the page was rendered with. Encoding
 * an ISO timestamp TRUNCATES microseconds, so rows created inside the same
 * millisecond collapse onto one key and the next page can skip them entirely —
 * measured on a 505-row bulk insert: page 1 returned 200 rows, page 2 returned
 * zero. The key is therefore the microsecond epoch as an integer string (the
 * same shape the reconciliation queue has used since M10), and the SQL ordering
 * is expressed on the identical expression so the two can never disagree.
 */
export function sortKeyUs(expr: SQL | unknown): SQL<string> {
  return sql<string>`floor(extract(epoch from ${expr}) * 1000000)::bigint`;
}

/**
 * A cursor key is client-supplied: it arrives base64-decoded and is then cast in
 * SQL. The casts are only safe once the shape is proven, so every consumer
 * declares the shape it expects and a malformed key is a 400 rather than a
 * database error surfacing as a 500.
 */
export type CursorKeyShape = 'bigint' | 'rank' | 'uuid';

const CURSOR_KEY_PATTERNS: Record<CursorKeyShape, RegExp> = {
  bigint: /^-?\d{1,19}$/,
  rank: /^\d{1,2}$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
};

export function assertCursorKeys(after: (string | null)[] | null, shapes: CursorKeyShape[]): void {
  if (!after) return;
  const bad =
    after.length !== shapes.length ||
    shapes.some((shape, i) => !CURSOR_KEY_PATTERNS[shape].test(String(after[i])));
  if (bad) {
    throw new AuthzError(
      AuthzErrorCode.BAD_REQUEST,
      'This cursor is not valid for this list. Start from the first page.',
      400,
    );
  }
}

/** Cursor helpers for the common `(timestamp desc, id desc)` ordering. */
export function cursorFromRow(surface: string, at: Date | string | null, id: UUID | string): string {
  const iso = at instanceof Date ? at.toISOString() : at;
  return encodeCursor(surface, [iso, id]);
}
