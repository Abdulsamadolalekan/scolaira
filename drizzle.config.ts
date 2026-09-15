import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit configuration for SCOLAIRA.
 *
 * Connection string comes from DATABASE_URL env var.
 * In M0 we only configure the tooling path; schema + migrations are introduced in M2.
 */
export default defineConfig({
  out: './lib/db/migrations',
  schema: './lib/db/schema/index.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/scolaira',
  },
  verbose: true,
  strict: true,
});
