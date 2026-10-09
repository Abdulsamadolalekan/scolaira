/**
 * Phase 2 — the pure rules of the opening-balance register.
 *
 * These are the pieces of the ledger contract that can be tested without a
 * database. The database enforces all of them too (migration 0052) — that is what
 * `tests/db/opening-balances.test.ts` is for — but a rule that only exists in SQL
 * produces a domain-violation string at the surface, so the repository carries the
 * same rules as sentences a school can act on. These tests pin the two halves
 * against each other on the parts that are wording.
 */
import { describe, expect, it } from 'vitest';
// @vitest-environment node
/*
 * Moved out of `lib/**` on purpose: the unit project runs in jsdom with the REAL
 * `server-only` module, which throws on import, and this repository module sits
 * behind that guard. These are pure-function tests, so they need no database — they
 * simply run in the node project, which stubs the guard, exactly as the workspace
 * config describes.
 */
import {
  MAX_AMOUNT_KOBO,
  OPENING_BALANCE_CATEGORIES,
  OPENING_BALANCE_CATEGORY_LABELS,
  OPENING_BALANCE_STATUSES,
  categoryIsPostable,
  signedAmountFor,
  validateRecord,
  type RecordInput,
} from '@/lib/db/repo/opening-balances';

function input(over: Partial<RecordInput> = {}): RecordInput {
  return {
    studentId: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f',
    category: 'HISTORICAL_BALANCE',
    amountKobo: 45_000,
    asAt: '2025-12-31',
    termId: null,
    sourceNote: 'Old receipt book, page 14',
    evidenceRef: null,
    ...over,
  };
}

describe('opening balance categories', () => {
  it('are exactly the four the audit asked to be separated', () => {
    expect(OPENING_BALANCE_CATEGORIES).toEqual([
      'CURRENT_TERM_UNBILLED',
      'HISTORICAL_BALANCE',
      'CREDIT_OVERPAYMENT',
      'UNVERIFIED',
    ]);
    expect(OPENING_BALANCE_STATUSES).toEqual([
      'DRAFT',
      'APPROVED',
      'REJECTED',
      'POSTED',
      'REVERSED',
    ]);
    for (const c of OPENING_BALANCE_CATEGORIES) {
      expect(OPENING_BALANCE_CATEGORY_LABELS[c]).toBeTruthy();
    }
  });

  it('permit only a historical balance to reach the ledger', () => {
    expect(OPENING_BALANCE_CATEGORIES.filter(categoryIsPostable)).toEqual(['HISTORICAL_BALANCE']);
    // Stated individually as well, because each of these refusals is a different
    // reason and each must stay a refusal.
    expect(categoryIsPostable('CREDIT_OVERPAYMENT')).toBe(false);
    expect(categoryIsPostable('UNVERIFIED')).toBe(false);
    expect(categoryIsPostable('CURRENT_TERM_UNBILLED')).toBe(false);
  });
});

describe('signed amount', () => {
  it('is derived from the category, and only a credit is negative', () => {
    expect(signedAmountFor('CREDIT_OVERPAYMENT', 25_000)).toBe(-25_000);
    expect(signedAmountFor('HISTORICAL_BALANCE', 25_000)).toBe(25_000);
    expect(signedAmountFor('CURRENT_TERM_UNBILLED', 25_000)).toBe(25_000);
    expect(signedAmountFor('UNVERIFIED', 25_000)).toBe(25_000);
  });

  it('keeps magnitude and sign consistent so the two can never disagree', () => {
    for (const category of OPENING_BALANCE_CATEGORIES) {
      const amount = 123_456_789;
      const signed = signedAmountFor(category, amount);
      expect(Math.abs(signed)).toBe(amount);
      expect(Math.sign(signed) === -1).toBe(category === 'CREDIT_OVERPAYMENT');
    }
  });
});

describe('validateRecord', () => {
  it('accepts a complete, sourced figure', () => {
    expect(validateRecord(input())).toEqual([]);
    expect(validateRecord(input({ category: 'CREDIT_OVERPAYMENT' }))).toEqual([]);
  });

  it('refuses zero, fractions and absurd amounts', () => {
    expect(validateRecord(input({ amountKobo: 0 })).join(' ')).toMatch(/greater than zero/);
    expect(validateRecord(input({ amountKobo: 45_000.5 })).join(' ')).toMatch(/whole number/);
    expect(validateRecord(input({ amountKobo: -5_000 })).join(' ')).toMatch(/greater than zero/);
    expect(
      validateRecord(input({ amountKobo: MAX_AMOUNT_KOBO + 1_000_000_000 })).join(' '),
    ).toMatch(/too large/);
  });

  it('refuses a figure with no stated source', () => {
    // This is the anti-fabrication control: a number nobody can point at is not a
    // record, and the register must say so rather than store it.
    expect(validateRecord(input({ sourceNote: '   ' })).join(' ')).toMatch(
      /where this figure came from/,
    );
    expect(validateRecord(input({ sourceNote: 'x' })).join(' ')).toMatch(
      /where this figure came from/,
    );
  });

  it('refuses a date that is not a plain ISO day', () => {
    expect(validateRecord(input({ asAt: '31/12/2025' })).join(' ')).toMatch(/YYYY-MM-DD/);
    expect(validateRecord(input({ asAt: '2025-12-31T00:00:00Z' })).join(' ')).toMatch(/YYYY-MM-DD/);
  });

  it('returns every problem at once, so one pass fixes the form', () => {
    const problems = validateRecord(
      input({ amountKobo: 0, asAt: 'nope', sourceNote: '', category: 'HISTORICAL_BALANCE' }),
    );
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });
});
