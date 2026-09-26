/**
 * Monetary value helpers for SCOLAIRA.
 *
 * ABSOLUTE RULE (never violated):
 *   - Internal storage: integer kobo (BIGINT) = non-negative in financial-event
 *     tables (payments, invoice_lines, allocations).
 *   - Signed kobo is used ONLY for derived balances and accounting arithmetic
 *     (e.g. invoice outstanding = billed - paid).
 *   - API boundary: Naira strings with exactly two decimals ("150000.00").
 *   - NO floating point arithmetic anywhere.
 *
 * These functions are the ONLY place kobo/naira parsing, formatting, and
 * arithmetic live. Every other module consumes them.
 */

// ---------- Types ----------

/** Non-negative kobo (canonical financial-event unit). Brands catch mix-ups. */
export type Kobo = number & { readonly __kobo: unique symbol };

/** Signed kobo — allowed ONLY for derived balances and deltas. */
export type SignedKobo = number & { readonly __signed_kobo: unique symbol };

/** Naira API string, e.g. "150000.00". */
export type NairaString = string & { readonly __naira: unique symbol };

/** Regex for positive naira strings (up to 14 whole digits). */
const NAIRA_REGEX = /^(0|[1-9]\d{0,14})\.\d{2}$/;
/** Regex that also accepts a leading minus (for delta/balance APIs if ever exposed). */
const SIGNED_NAIRA_REGEX = /^-?(0|[1-9]\d{0,14})\.\d{2}$/;

// ---------- Constants ----------

export const ZERO_KOBO = 0 as Kobo;
const KOBO_PER_NAIRA = 100;
/** Maximum kobo representable as a safe integer ≈ ₦90 trillion — ample headroom. */
const MAX_KOBO = Number.MAX_SAFE_INTEGER; // 2^53 - 1

// ---------- Internal guards ----------

function isSafeInt(n: number): boolean {
  return Number.isFinite(n) && Number.isInteger(n);
}

function assertNonNegativeKobo(k: number, where = 'kobo'): asserts k is Kobo {
  if (!isSafeInt(k) || k < 0) {
    throw new Error(`Invalid non-negative kobo for ${where}: ${k}.`);
  }
  if (k > MAX_KOBO) {
    throw new Error(`Kobo value ${k} exceeds MAX_SAFE_INTEGER for ${where}.`);
  }
}

function assertSignedKobo(k: number, where = 'signed_kobo'): asserts k is SignedKobo {
  if (!isSafeInt(k)) {
    throw new Error(`Invalid signed kobo for ${where}: ${k}.`);
  }
  if (Math.abs(k) > MAX_KOBO) {
    throw new Error(`Signed kobo value ${k} exceeds MAX_SAFE_INTEGER for ${where}.`);
  }
}

// ---------- Construction ----------

/** Safely cast an integer to Kobo. Throws if negative or non-integer. */
export function kobo(n: number): Kobo {
  assertNonNegativeKobo(n, 'kobo()');
  return n as Kobo;
}

/** Cast to signed kobo (for derived balances). */
export function signedKobo(n: number): SignedKobo {
  assertSignedKobo(n, 'signedKobo()');
  return n as SignedKobo;
}

/** Zero kobo constant. */
export const zero = ZERO_KOBO;

// ---------- Parsing / formatting ----------

/** Parse a Naira string into non-negative kobo. */
export function parseNaira(s: string): Kobo {
  const trimmed = s.trim();
  if (!NAIRA_REGEX.test(trimmed)) {
    throw new Error(`Invalid naira amount: ${JSON.stringify(s)}; expected e.g. "150000.00".`);
  }
  const [nairaPart, koboPart] = trimmed.split('.') as [string, string];
  const naira = Number(nairaPart);
  const kob = Number(koboPart);
  if (!Number.isInteger(naira) || !Number.isInteger(kob)) {
    throw new Error(`Invalid naira amount: ${JSON.stringify(s)}.`);
  }
  const total = naira * KOBO_PER_NAIRA + kob;
  if (!Number.isSafeInteger(total)) {
    throw new Error(`Naira amount exceeds safe integer range: ${s}.`);
  }
  return total as Kobo;
}

/** Parse a signed naira string (for balance deltas only). */
export function parseSignedNaira(s: string): SignedKobo {
  const trimmed = s.trim();
  if (!SIGNED_NAIRA_REGEX.test(trimmed)) {
    throw new Error(`Invalid signed naira amount: ${JSON.stringify(s)}.`);
  }
  const negative = trimmed.startsWith('-');
  const body = negative ? trimmed.slice(1) : trimmed;
  const positive = parseNaira(body);
  return (negative ? -positive : positive) as SignedKobo;
}

/** Format non-negative kobo into a Naira string with two decimals (no symbol, no commas). */
export function formatKobo(k: number): NairaString {
  assertNonNegativeKobo(k, 'formatKobo');
  const naira = Math.floor(k / KOBO_PER_NAIRA);
  const kob = k % KOBO_PER_NAIRA;
  return `${naira.toString()}.${kob.toString().padStart(2, '0')}` as NairaString;
}

/** Format signed kobo as a signed naira string. */
export function formatSignedKobo(k: number): string {
  assertSignedKobo(k, 'formatSignedKobo');
  if (k < 0) return '-' + formatKobo(-k as unknown as Kobo);
  return formatKobo(k as unknown as Kobo);
}

/** Format kobo for UI display with thousands separators and ₦. */
export function formatKoboDisplay(k: number): string {
  const nairaString = formatKobo(k);
  const [whole, dec] = nairaString.split('.') as [string, string];
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `₦${withCommas}.${dec}`;
}

/** Format signed kobo for display (leading − for negatives). */
export function formatSignedKoboDisplay(k: number): string {
  assertSignedKobo(k, 'formatSignedKoboDisplay');
  if (k < 0) {
    return '−' + formatKoboDisplay(-k as unknown as Kobo);
  }
  return formatKoboDisplay(k as unknown as Kobo);
}

// ---------- Arithmetic (non-negative Kobo) ----------

/** Add two non-negative kobo amounts. */
export function add(a: Kobo, b: Kobo): Kobo {
  assertNonNegativeKobo(a, 'add.lhs');
  assertNonNegativeKobo(b, 'add.rhs');
  const total = a + b;
  if (!Number.isSafeInteger(total)) {
    throw new Error(`Kobo addition overflows safe integer: ${a} + ${b}.`);
  }
  return total as Kobo;
}

/** Sum an array of non-negative kobo. */
export function sum(items: readonly Kobo[]): Kobo {
  let total = 0;
  for (const v of items) {
    assertNonNegativeKobo(v, 'sum.item');
    total += v;
    if (!Number.isSafeInteger(total)) {
      throw new Error(`Kobo sum overflows safe integer.`);
    }
  }
  return total as Kobo;
}

/**
 * Subtract b from a, returning a non-negative kobo.
 * Throws INVARIANT_VIOLATION-style Error if b > a (to avoid accidental negatives
 * in ledger logic that never expects them).
 */
export function subtract(a: Kobo, b: Kobo): Kobo {
  assertNonNegativeKobo(a, 'subtract.lhs');
  assertNonNegativeKobo(b, 'subtract.rhs');
  if (b > a) {
    throw new Error(`Kobo subtraction would produce negative: ${a} - ${b}.`);
  }
  return (a - b) as Kobo;
}

/**
 * Subtract that clamps at zero rather than throwing.
 * Useful for "remaining after allocation" where 0 is correct floor.
 */
export function saturatingSubtract(a: Kobo, b: Kobo): Kobo {
  assertNonNegativeKobo(a, 'saturatingSubtract.lhs');
  assertNonNegativeKobo(b, 'saturatingSubtract.rhs');
  const r = a - b;
  return (r < 0 ? 0 : r) as Kobo;
}

/** Multiply kobo by a non-negative integer factor (e.g. quantity). */
export function multiply(a: Kobo, factor: number): Kobo {
  assertNonNegativeKobo(a, 'multiply.lhs');
  if (!Number.isInteger(factor) || factor < 0) {
    throw new Error(`multiply factor must be non-negative integer, got ${factor}.`);
  }
  const result = a * factor;
  if (!Number.isSafeInteger(result)) {
    throw new Error(`Kobo multiplication overflows safe integer: ${a} * ${factor}.`);
  }
  return result as Kobo;
}

/** Compare two non-negative kobo: -1 / 0 / 1. */
export function compare(a: Kobo, b: Kobo): -1 | 0 | 1 {
  assertNonNegativeKobo(a, 'compare.lhs');
  assertNonNegativeKobo(b, 'compare.rhs');
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// ---------- Arithmetic for signed kobo (balances/deltas) ----------

export function addSigned(a: SignedKobo, b: SignedKobo): SignedKobo {
  assertSignedKobo(a, 'addSigned.lhs');
  assertSignedKobo(b, 'addSigned.rhs');
  const total = a + b;
  if (!Number.isSafeInteger(total)) {
    throw new Error(`Signed kobo addition overflows safe integer: ${a} + ${b}.`);
  }
  return total as SignedKobo;
}

export function subtractSigned(a: SignedKobo, b: SignedKobo): SignedKobo {
  return addSigned(a, (-b) as SignedKobo);
}

// ---------- Constructors from naira parts ----------

/** Build kobo from whole naira and kobo parts (avoids float arithmetic). */
export function fromNairaParts(naira: number, kob: number): Kobo {
  if (!Number.isInteger(naira) || naira < 0) {
    throw new Error(`naira part must be non-negative integer, got ${naira}.`);
  }
  if (!Number.isInteger(kob) || kob < 0 || kob >= KOBO_PER_NAIRA) {
    throw new Error(`kobo part must be integer 0..99, got ${kob}.`);
  }
  const total = naira * KOBO_PER_NAIRA + kob;
  if (!Number.isSafeInteger(total)) {
    throw new Error(`Kobo construction overflows safe integer.`);
  }
  return total as Kobo;
}

/** Convenience: ₦ thousands separator util (used for display only). */
export function formatNairaWithCommas(n: number | string): string {
  const str = typeof n === 'number' ? n.toString() : n;
  return str.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
