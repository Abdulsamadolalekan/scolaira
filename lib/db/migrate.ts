/**
 * Database migration runner.
 *
 * M0 stub. Replaced in M2 with `drizzle-orm/postgres-js/migrator` integration.
 */
import '../security/server-only';

// eslint-disable-next-line no-console
console.warn('[db] migrate() is a stub — M2 will run real Drizzle migrations.');

export async function migrate(): Promise<void> {
  // No-op in M0.
}
