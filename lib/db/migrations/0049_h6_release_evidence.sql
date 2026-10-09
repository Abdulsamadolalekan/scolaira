-- =============================================================================
-- 0049_h6_release_evidence.sql
-- H-6: release evidence — the running process can prove which schema it is on.
--
-- Measured defect (docs/readiness/H6_SCOPE_MAP.md, register §4 + §11 R6):
--   * `GET /api/health` returned `{"status":"ok"}` for every condition tested,
--     including an unreachable database, a 47-of-48 schema and a broken auth
--     configuration — a deployment with a half-applied schema reported healthy;
--   * the runtime role therefore had no way to ask the database which
--     migrations are applied: `scolaira_app` has USAGE on schema `drizzle` but
--     NO SELECT on `drizzle.__drizzle_migrations` (measured: usage = true,
--     select = false). The migration journal is owner-only and stays that way.
--
-- This migration adds ONE narrow, read-only SECURITY DEFINER so the readiness
-- probe can compare the schema the process expects against the schema the
-- database actually has:
--
--   ops_migration_state() -> jsonb { applied, latest }
--
-- Narrowness is the point:
--   * it returns two numbers/nulls — no table access, no rows, no GUC writes,
--     no context entry, no arguments;
--   * it cannot be used to read any application data;
--   * EXECUTE is revoked from PUBLIC and granted only to the runtime role;
--   * it does not widen the pre-existing identity-visibility door (see the H-6
--     closeout §2): it grants strictly less than the app-callable
--     `auth_enter_system_context()` that already exists, and it sets nothing.
--
-- It also records a self-audit NOTICE, like 0047/0048, so an operator applying
-- this migration sees the state it produced.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The migration-state reader.
--
--    `applied` is the number of journal rows; `latest` is the most recently
--    applied tag. Comparisons against what the build ships happen in the app
--    (lib/ops/migration-manifest.ts), so this function never encodes a
--    version — a function that "knows" the expected count would be a new
--    source of drift and would itself have to be migrated on every change.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ops_migration_state()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_applied integer;
  v_latest  text;
BEGIN
  SELECT count(*)::integer, max(tag)
    INTO v_applied, v_latest
    FROM drizzle.__drizzle_migrations;

  RETURN jsonb_build_object(
    'applied', coalesce(v_applied, 0),
    'latest',  v_latest
  );
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION ops_migration_state() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ops_migration_state() TO scolaira_app;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 2. Self-audit: report what the readiness surface can now see, and refuse to
--    finish silently if the journal is not readable through the new definer
--    (which would make every deployment report "schema unverifiable").
-- -----------------------------------------------------------------------------
DO $audit$
DECLARE
  v_state jsonb;
  v_ok    boolean;
BEGIN
  SELECT ops_migration_state() INTO v_state;
  -- The definer must be usable by the runtime role, not only by its owner.
  SELECT has_function_privilege('scolaira_app', 'ops_migration_state()', 'EXECUTE') INTO v_ok;
  IF NOT coalesce(v_ok, false) THEN
    RAISE EXCEPTION '[H-6] ops_migration_state() is not executable by the runtime role';
  END IF;

  RAISE NOTICE '[H-6] migration journal readable by the readiness probe: applied=% latest=%',
    v_state->>'applied', v_state->>'latest';
  RAISE NOTICE '[H-6] readiness can prove database, schema and auth configuration; /api/health is liveness only';
END
$audit$;
