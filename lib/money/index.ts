/**
 * Monetary value helpers for SCOLAIRA.
 *
 * PRINCIPLE (canonical, never violated):
 *   - Internal representation: integer kobo (BIGINT at DB layer, number in JS within
 *     MAX_SAFE_INTEGER bounds — kobo for Naira has safe range up to ~₦90 trillion).
 *   - External / API representation: Naira string with exactly two decimals,
 *     e.g. "150000.00".
 *
 * These functions are the ONLY way money is parsed or formatted at API boundaries.
 * Never do `Number(nairaString) * 100`, never use floating point arithmetic, and
 * never format money ad-hoc in components.
 *
 * M0 foundation only — additional arithmetic and allocation utilities are added
 * in later milestones when financial logic is implemented.
 */

/** A kobo amount is an integer >= 0 in most contexts. Branded nominal type. */
export type Kobo = number & { readonly __kobo: unique symbol };

/** A naira string value is a string matching /^\d{1,15}\.\d{2}$/. */
export type NairaString = string & { readonly __naira: unique symbol };

/** Regex for valid Naira strings (positive, two decimals, no leading zeros). */
const NAIRA_REGEX = /^(0|[1-9]\d{0,14})\.\d{2}$/;

/**
 * Parse a Naira string into integer kobo.
 *
 * Throws if the string is not a valid Naira amount. Accepts strings produced by
 * `formatKobo` and any reasonable human input with two decimals.
 */
export function parseNaira(s: string): Kobo {
  const trimmed = s.trim();
  if (!NAIRA_REGEX.test(trimmed)) {
    throw new Error(`Invalid naira amount: ${JSON.stringify(s)}; expected e.g. "150000.00".`);
  }
  const [nairaPart, koboPart] = trimmed.split('.');
  if (!nairaPart || !koboPart) {
    throw new Error(`Invalid naira amount: ${JSON.stringify(s)}.`);
  }
  const naira = Number(nairaPart);
  const kob = Number(koboPart);
  if (!Number.isInteger(naira) || !Number.isInteger(kob)) {
    throw new Error(`Invalid naira amount: ${JSON.stringify(s)}.`);
  }
  const total = naira * 100 + kob;
  if (!Number.isSafeInteger(total)) {
    throw new Error(`Naira amount exceeds safe integer range: ${s}.`);
  }
  return total as Kobo;
}

/**
 * Format integer kobo into a Naira string with two decimals.
 *
 * Always use this for API output and UI display (via the React wrapper in M1).
 * Does NOT prepend the ₦ symbol — that's a presentation-layer decision.
 */
export function formatKobo(k: number): NairaString {
  if (!Number.isFinite(k) || !Number.isInteger(k) || k < 0) {
    // Negative values are not valid in payment amounts; reversals are modeled
    // as separate records per FINANCIAL_INVARIANTS F2.
    throw new Error(`Cannot format invalid kobo amount: ${k}.`);
  }
  const naira = Math.floor(k / 100);
  const kob = k % 100;
  const str = `${naira.toString()}.${kob.toString().padStart(2, '0')}`;
  return str as NairaString;
}

/**
 * Format kobo for display with thousands separators and ₦ symbol.
 *
 * Use in UI contexts only. For API output use `formatKobo` (no symbol, no commas).
 */
export function formatKoboDisplay(k: number): string {
  const nairaString = formatKobo(k);
  const [whole, dec] = nairaString.split('.') as [string, string];
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `₦${withCommas}.${dec}`;
}

/**
 * Safely add two kobo amounts (no floating point).
 * Full arithmetic suite (subtract/multiply/divide with safeguards) added when
 * allocation logic is implemented in Phase 1 / Slice 5.
 */
export function addKobo(a: Kobo, b: Kobo): Kobo {
  const total = a + b;
  if (!Number.isSafeInteger(total)) {
    throw new Error(`Kobo addition exceeds safe integer: ${a} + ${b}.`);
  }
  return total as Kobo;
}

/**
 * Zero helper.
 */
export const ZERO_KOBO = 0 as Kobo;
