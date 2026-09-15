/**
 * Next.js instrumentation hook (runs when the server starts).
 *
 * Used in later milestones for Sentry initialization, environment
 * validation, database connection warm-up, and audit logger wiring.
 *
 * M0 is intentionally a no-op; real startup checks are introduced when the
 * corresponding infrastructure lands.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // eslint-disable-next-line no-console
    console.info(`[scolaira] instrumentation register: environment=${process.env.NODE_ENV}`);
  }
}
