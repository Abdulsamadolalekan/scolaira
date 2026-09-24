/**
 * Authorization error — the single error type raised by the authorization
 * layer. `code` is stable; HTTP handlers map to status codes.
 */
import 'server-only';

export const AuthzErrorCode = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  CSRF_MISSING: 'CSRF_MISSING',
  CSRF_INVALID: 'CSRF_INVALID',
  NOT_FOUND: 'NOT_FOUND',
  BAD_REQUEST: 'BAD_REQUEST',
  RATE_LIMITED: 'RATE_LIMITED',
  CONFLICT: 'CONFLICT',
  // Business-rule conflicts that callers must be able to branch on without
  // parsing prose: a period window that overlaps another, and the two measured
  // reasons a close is refused. They travel in the same error envelope as the
  // authorization codes so every surface keeps one error channel.
  PERIOD_OVERLAP: 'PERIOD_OVERLAP',
  PERIOD_HAS_UNRESOLVED_PAYMENTS: 'PERIOD_HAS_UNRESOLVED_PAYMENTS',
  PERIOD_HAS_UNALLOCATED_PAYMENTS: 'PERIOD_HAS_UNALLOCATED_PAYMENTS',
} as const;
export type AuthzErrorCode = typeof AuthzErrorCode[keyof typeof AuthzErrorCode];

export class AuthzError extends Error {
  readonly code: AuthzErrorCode;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: AuthzErrorCode, message: string, status = 403, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
    this.name = 'AuthzError';
  }
}
