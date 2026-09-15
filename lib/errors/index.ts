/**
 * SCOLAIRA error model.
 *
 * Every API error has:
 *  - an HTTP status code
 *  - a stable ERROR_CODE (so clients/front-end can branch on it)
 *  - a human-facing message (brief, factual, action-oriented)
 *  - optional detail (for validation errors etc.)
 *
 * This file is shared between server and client so error UI can render codes.
 * It must never depend on server-only modules.
 */

export const ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INVARIANT_VIOLATION: 'INVARIANT_VIOLATION',
  EXPIRED: 'EXPIRED',
  UNPROCESSABLE_ENTITY: 'UNPROCESSABLE_ENTITY',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  IDEMPOTENCY_KEY_REUSE: 'IDEMPOTENCY_KEY_REUSE',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ApiErrorShape {
  error: {
    code: ErrorCode;
    message: string;
    detail?: unknown;
    requestId?: string;
  };
}

/**
 * Thrown by service/route logic; caught by the global error handler to produce
 * a deterministic JSON response.
 */
export class ScolairaApiError extends Error {
  public readonly status: number;
  public readonly code: ErrorCode;
  public readonly detail?: unknown;

  constructor(status: number, code: ErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = 'ScolairaApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }

  toJSON(requestId?: string): ApiErrorShape {
    return {
      error: {
        code: this.code,
        message: this.message,
        detail: this.detail,
        requestId,
      },
    };
  }

  // --- Convenience factories ---
  static badRequest(message: string, detail?: unknown) {
    return new ScolairaApiError(400, ERROR_CODES.VALIDATION_ERROR, message, detail);
  }
  static unauthenticated(message = 'You must be signed in.') {
    return new ScolairaApiError(401, ERROR_CODES.UNAUTHENTICATED, message);
  }
  static forbidden(message = 'You do not have permission to perform this action.') {
    return new ScolairaApiError(403, ERROR_CODES.FORBIDDEN, message);
  }
  static notFound(message = 'Record not found.') {
    return new ScolairaApiError(404, ERROR_CODES.NOT_FOUND, message);
  }
  static conflict(code: ErrorCode, message: string, detail?: unknown) {
    return new ScolairaApiError(409, code, message, detail);
  }
  static invariantViolation(message: string, detail?: unknown) {
    return new ScolairaApiError(409, ERROR_CODES.INVARIANT_VIOLATION, message, detail);
  }
  static expired(message: string) {
    return new ScolairaApiError(410, ERROR_CODES.EXPIRED, message);
  }
  static unprocessable(message: string, detail?: unknown) {
    return new ScolairaApiError(422, ERROR_CODES.UNPROCESSABLE_ENTITY, message, detail);
  }
  static rateLimited(retryAfterSec = 60) {
    const err = new ScolairaApiError(
      429,
      ERROR_CODES.RATE_LIMITED,
      'Too many requests. Please wait a moment and try again.',
    );
    // Attach retry-after for the route handler to emit as a header.
    (err as ScolairaApiError & { retryAfter: number }).retryAfter = retryAfterSec;
    return err;
  }
  static internal(message = 'An unexpected error occurred.') {
    return new ScolairaApiError(500, ERROR_CODES.INTERNAL_ERROR, message);
  }
}
