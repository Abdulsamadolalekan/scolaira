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
