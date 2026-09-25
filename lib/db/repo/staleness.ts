/**
 * H-2 / M-7 — the ONE definition of follow-up staleness.
 *
 * Before H-2 these boundaries existed as call-site literals: the dashboard SQL
 * said `interval '7 days'` and `interval '14 days'`, and the reminder route
 * passed a bare `4` hours into the repository. Nothing in any response said
 * what "stale" meant, so a client could not label it and a test could not sit on
 * the boundary. They live here now, are echoed in the payloads that use them,
 * and are tested at 6d/7d/7d1h and 14d/15d.
 *
 * Semantics are deliberately "older than" (strict), matching the SQL they
 * replace: exactly 7 days is still FRESH; exactly 14 days is STALE.
 */

export const FOLLOWUP_THRESHOLDS = {
  /** A reminder older than this is stale: the family was chased, then dropped. */
  staleAfterDays: 7,
  /** A 90+ day balance with no reminder inside this window is unattended. */
  unattendedAfterDays: 14,
  /** Server-side floor between two reminders for the same invoice/student pair. */
  reminderCooldownHours: 4,
} as const;

export type ReminderStaleness = 'NONE' | 'FRESH' | 'STALE' | 'UNATTENDED';

export interface StalenessVerdict {
  staleness: ReminderStaleness;
  daysSinceReminder: number | null;
}

const MS_PER_DAY = 86_400_000;

/** Classify a last-reminder timestamp against the shared thresholds. */
export function classifyReminderStaleness(
  lastReminderAt: Date | string | null | undefined,
  now: Date = new Date(),
): StalenessVerdict {
  if (!lastReminderAt) return { staleness: 'NONE', daysSinceReminder: null };
  const at = typeof lastReminderAt === 'string' ? new Date(lastReminderAt) : lastReminderAt;
  const ageMs = now.getTime() - at.getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return { staleness: 'FRESH', daysSinceReminder: 0 };
  }
  const days = ageMs / MS_PER_DAY;
  const daysSinceReminder = Math.floor(days);
  if (days > FOLLOWUP_THRESHOLDS.unattendedAfterDays) {
    return { staleness: 'UNATTENDED', daysSinceReminder };
  }
  if (days > FOLLOWUP_THRESHOLDS.staleAfterDays) {
    return { staleness: 'STALE', daysSinceReminder };
  }
  return { staleness: 'FRESH', daysSinceReminder };
}

/**
 * The threshold block every payload that classifies staleness must carry, so a
 * client renders "stale" the same way the server decided it.
 */
export function followupThresholdsPayload() {
  return {
    staleAfterDays: FOLLOWUP_THRESHOLDS.staleAfterDays,
    unattendedAfterDays: FOLLOWUP_THRESHOLDS.unattendedAfterDays,
    reminderCooldownHours: FOLLOWUP_THRESHOLDS.reminderCooldownHours,
  };
}
