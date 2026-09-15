import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ScolairaApiError } from './index';

describe('ScolairaApiError', () => {
  it('serializes to the standard ApiErrorShape', () => {
    const err = ScolairaApiError.invariantViolation('Allocation exceeds outstanding.', {
      invoiceId: 'abc',
    });
    expect(err.status).toBe(409);
    expect(err.code).toBe(ERROR_CODES.INVARIANT_VIOLATION);
    const json = err.toJSON('req-1');
    expect(json.error.code).toBe('INVARIANT_VIOLATION');
    expect(json.error.message).toMatch(/allocation/i);
    expect(json.error.detail).toEqual({ invoiceId: 'abc' });
    expect(json.error.requestId).toBe('req-1');
  });

  it('builds common errors with correct statuses', () => {
    expect(ScolairaApiError.unauthenticated().status).toBe(401);
    expect(ScolairaApiError.forbidden().status).toBe(403);
    expect(ScolairaApiError.notFound().status).toBe(404);
    expect(ScolairaApiError.badRequest('x').status).toBe(400);
    expect(ScolairaApiError.expired('x').status).toBe(410);
    expect(ScolairaApiError.unprocessable('x').status).toBe(422);
    expect(ScolairaApiError.rateLimited().status).toBe(429);
    expect(ScolairaApiError.internal().status).toBe(500);
  });
});
