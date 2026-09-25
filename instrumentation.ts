/**
 * Next.js instrumentation hook (runs when the server starts).
 *
 * H-6: this is where a deployment states, once and in machine-readable form,
 * which build it is and which schema it expects. Before it, the only startup
 * line was free text about `NODE_ENV`, and nothing anywhere recorded what the
 * process believed it should be running against — so a deployment serving an
 * older build against a newer schema, or the reverse, left no trace at all
 * (`/api/ready` detects this at request time; this line makes it visible at
 * boot, and ties the two together in the logs).
 *
 * Deliberately provider-neutral, and deliberately tiny: no secrets, no
 * connection string, no dependency I/O (a boot hook must never fail a boot).
 * Anything that could block or throw is done without awaiting a result.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  try {
    const { buildInfo } = await import('./lib/ops/build-info');
    const { EXPECTED_MIGRATION_COUNT, LATEST_MIGRATION_TAG } =
      await import('./lib/ops/migration-manifest');
    const { logEvent } = await import('./lib/ops/log');
    const { authSecretUsable } = await import('./lib/ops/auth-config-state');

    logEvent('startup_configuration', {
      ...buildInfo(),
      expectedMigrations: EXPECTED_MIGRATION_COUNT,
      expectedMigrationTag: LATEST_MIGRATION_TAG,
      databaseConfigured: Boolean(process.env.DATABASE_URL),
      // NOT `Boolean(process.env.SCOLAIRA_SESSION_SECRET)`: presence is not
      // usability, and a boot line that calls a 9-character secret "configured"
      // while `/api/ready` refuses it is a self-contradicting signal. This asks
      // the same question the readiness probe asks.
      authSecretConfigured: authSecretUsable({
        SCOLAIRA_SESSION_SECRET: process.env.SCOLAIRA_SESSION_SECRET,
      }),
    });
  } catch (error) {
    // A boot hook that throws would take the whole deployment down. Say that the
    // signal failed and carry on; `/api/ready` remains the authority.
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        event: 'startup_configuration_failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
