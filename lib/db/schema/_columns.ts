/**
 * Reusable column builders for SCOLAIRA.
 *
 * Every tenant-owned table has (id, organization_id, created_at, updated_at)
 * with consistent types. These helpers keep the schema tight and prevent drift.
 *
 * FOREIGN KEYS are intentionally NOT created here — tables import their peer
 * references explicitly. That avoids circular-import hell between schema files.
 */
import { uuid, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Standard primary key (UUID — populated via gen_random_uuid(); we use v7 in application code). */
export const pk = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`)
    .notNull();

/** created_at and updated_at timestamps (timestamptz, UTC default now()). */
export const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

/**
 * Soft-delete column (nullable). Financial records do NOT use this;
 * it is only for reference-data tables that may be hidden without audit impact
 * (classes, guardians, fee_definitions).
 */
export const softDeletable = () => ({
  deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
});

// Re-export pgEnum for convenience (not a column helper, but used by every table file).
export { pgEnum };
