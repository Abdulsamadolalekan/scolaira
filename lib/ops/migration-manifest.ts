/**
 * The migration set this build expects to find in the database.
 *
 * The readiness probe answers a deployment question — "is this database
 * migrated to the version this build ships?" — so the expectation has to travel
 * WITH the build. Reading `lib/db/migrations/` at runtime would work from a
 * repo checkout and fail in a standalone/container image where the SQL files
 * are not part of the runtime artefact; a constant is compiled in and is
 * therefore always available.
 *
 * A constant can drift, so it is not trusted: `migration-manifest.test.ts`
 * reads the migrations directory and fails if this file does not describe it
 * exactly (count and latest tag). Drift is a red test, not a stale deployment.
 */

/** Number of `.sql` migrations that must be applied for this build to be ready. */
export const EXPECTED_MIGRATION_COUNT = 49;

/** Tag (filename without extension) of the newest migration this build ships. */
export const LATEST_MIGRATION_TAG = '0049_h6_release_evidence';
