/**
 * Database client (M0 stub).
 *
 * The real Postgres client via `postgres` and Drizzle are wired in M2.
 * Importing this module is marked server-only today to set the invariant
 * that DB access never happens in the client bundle.
 */
import '../security/server-only';

export type Database = never;

/**
 * Returns the singleton DB client.
 *
 * In M0 this throws because no database is configured yet; callers in later
 * milestones will replace this with a real Drizzle instance.
 */
export function getDb(): Database {
  throw new Error('Database is not configured yet (M0). M2 will initialize the Postgres client.');
}
