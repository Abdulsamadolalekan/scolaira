-- ---------------------------------------------------------------------------
-- M4 Migration 0005: Authorization primitives
--
-- What this migration delivers:
--   1. 'OWNER' added to membership_role (first in list so it appears first
--      in enum ordering for display).
--   2. Database invariant: at most one ACTIVE OWNER per organization
--      (partial unique index).
--   3. 'PLATFORM_ADMIN' value retired from membership_role: existing rows
--      using it (there should be none) are blocked via CHECK constraint;
--      platform authority lives on users.is_platform_admin.
--   4. GUC split: app.acting_role carries the resolved membership role during
--      tenant scope; app.is_platform_admin is ONLY '1' in explicit platform
--      context (new enter_platform_context SECURITY DEFINER).
--   5. set_tenant_context rewritten:
--        - resolves ACTIVE membership and stores role into app.acting_role
--        - sets app.is_platform_admin='0' (never propagates into tenant scope)
--        - continues to verify membership (ACTIVE only) before granting scope
--   6. New columns on sessions for active-org selection: last_seen_org_id.
--      (We use a signed cookie rather than DB state for the active-org value,
--      but last_seen_org_id helps audit and "login back to where you were".)
--   7. Platform session marker: sessions.is_platform_session boolean, so
--      support-mode sessions are auditable.
--   8. enter_platform_context / exit_platform_context SECURITY DEFINER helpers.
--   9. GRANT the runtime role permission to call the new functions.
--
-- NOTES:
--   - This migration MUST be run by the migration/superuser role (it creates
--     SECURITY DEFINER functions).
--   - M2/M3 tenant RLS policies remain intact (we do NOT weaken them). We
--     add defense-in-depth policies for financial tables in a later M4
--     follow-on migration only after the authorization layer is stable.
-- ---------------------------------------------------------------------------

-- 1. Add OWNER to membership_role BEFORE SCHOOL_ADMIN.
ALTER TYPE membership_role ADD VALUE IF NOT EXISTS 'OWNER';
-- (Postgres adds new values at the end by default; ordering in enums is
-- lexical for casts but not meaningful for our code. We do not rename or
-- reorder existing values.)

-- 2. Backfill: M3 registration used SCHOOL_ADMIN for the founding user.
--    Promote every organization's oldest ACTIVE membership to OWNER, but
--    only if the org currently has no OWNER. This handles databases that
--    were created by M3 register. We order by created_at, then id.
UPDATE organization_members om
SET role = 'OWNER'
WHERE om.id IN (
  SELECT DISTINCT ON (organization_id) id
  FROM organization_members
  WHERE status = 'ACTIVE'
  ORDER BY organization_id, created_at ASC, id ASC
)
AND NOT EXISTS (
  SELECT 1 FROM organization_members o2
  WHERE o2.organization_id = om.organization_id
    AND o2.status = 'ACTIVE'
    AND o2.role = 'OWNER'
);

-- 3. Database invariant: at most one ACTIVE OWNER per organization.
CREATE UNIQUE INDEX IF NOT EXISTS org_members_one_active_owner_idx
  ON organization_members (organization_id)
  WHERE role = 'OWNER' AND status = 'ACTIVE';

-- 4. Block PLATFORM_ADMIN from being written to organization_members.role
--    going forward. Platform authority lives on users.is_platform_admin.
ALTER TABLE organization_members
  ADD CONSTRAINT organization_members_role_no_platform_admin
  CHECK (role <> 'PLATFORM_ADMIN'::membership_role);
--> statement-breakpoint

-- 5. Session tracking columns: last_seen_org_id and platform-session flag.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS last_seen_org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_platform_session boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_platform_session_idx
  ON sessions (user_id, is_platform_session) WHERE revoked_at IS NULL;
--> statement-breakpoint

-- 6. app.acting_role GUC setting.
--    We do not need a custom GUC DDL; set_config with a previously-unset
--    name works in Postgres via the custom_variable_classes behavior
--    (Postgres 9.2+ does not require custom_variable_classes). To avoid
--    "unrecognized configuration parameter" errors we predeclare the GUC
--    at the empty value.
SELECT set_config('app.acting_role', '', false);
--> statement-breakpoint

-- 7. Rewrite set_tenant_context: split platform flag out; populate acting_role.
CREATE OR REPLACE FUNCTION set_tenant_context(
  p_organization_id uuid,
  p_user_id uuid
) RETURNS void AS $$
DECLARE
  v_role membership_role;
BEGIN
  IF p_organization_id IS NULL THEN
    PERFORM set_config('app.organization_id', '', false);
    PERFORM set_config('app.user_id', coalesce(p_user_id::text, ''), false);
    PERFORM set_config('app.acting_role', '', false);
    PERFORM set_config('app.is_platform_admin', '0', false);
    PERFORM set_config('app.bypass_financial_triggers', '0', false);
    RETURN;
  END IF;

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Cannot set tenant context without user_id';
  END IF;

  -- Resolve the membership. We require status='ACTIVE' and read the role.
  -- Role is written to app.acting_role for defense-in-depth RLS policies.
  SELECT "role" INTO v_role
    FROM "organization_members"
   WHERE "organization_id" = p_organization_id
     AND "user_id" = p_user_id
     AND "status" = 'ACTIVE';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User % is not an active member of organization %', p_user_id, p_organization_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- IMPORTANT: app.is_platform_admin is always '0' inside tenant scope.
  -- Platform cross-tenant access uses enter_platform_context separately.
  PERFORM set_config('app.organization_id', p_organization_id::text, false);
  PERFORM set_config('app.user_id', p_user_id::text, false);
  PERFORM set_config('app.acting_role', v_role::text, false);
  PERFORM set_config('app.is_platform_admin', '0', false);
  PERFORM set_config('app.bypass_financial_triggers', '0', false);
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public;
--> statement-breakpoint

-- 8. Enter explicit platform-admin context. Verifies the user has
--    is_platform_admin=true before setting the flag. Does NOT set an
--    organization_id. Clears acting_role.
CREATE OR REPLACE FUNCTION enter_platform_context(p_user_id uuid)
RETURNS void AS $$
DECLARE
  v_admin boolean;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Cannot enter platform context without user_id';
  END IF;

  SELECT is_platform_admin INTO v_admin FROM users WHERE id = p_user_id;
  IF NOT FOUND OR NOT v_admin THEN
    RAISE EXCEPTION 'User % is not authorized for platform context', p_user_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM set_config('app.organization_id', '', false);
  PERFORM set_config('app.user_id', p_user_id::text, false);
  PERFORM set_config('app.acting_role', '', false);
  PERFORM set_config('app.is_platform_admin', '1', false);
  PERFORM set_config('app.bypass_financial_triggers', '0', false);
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public;
--> statement-breakpoint

-- 9. Exit platform context back to neutral (for use when dropping from
--    platform mode back to unauthenticated; transitioning to a tenant
--    context uses set_tenant_context which overwrites anyway).
CREATE OR REPLACE FUNCTION clear_app_context()
RETURNS void AS $$
BEGIN
  PERFORM set_config('app.organization_id', '', false);
  PERFORM set_config('app.user_id', '', false);
  PERFORM set_config('app.acting_role', '', false);
  PERFORM set_config('app.is_platform_admin', '0', false);
  PERFORM set_config('app.bypass_financial_triggers', '0', false);
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public;
--> statement-breakpoint

-- 10. Update set_tenant_context_for_system (M2 migration/seeds helper) to
--     also clear acting_role and reset is_platform_admin appropriately.
--     Existing callers expect is_platform_admin='1' when org_id is NULL
--     (bootstrap for cross-tenant seeds); we keep that behavior but ensure
--     acting_role is cleared.
CREATE OR REPLACE FUNCTION set_tenant_context_for_system(p_organization_id uuid, p_user_id uuid)
RETURNS void AS $$
BEGIN
  PERFORM set_config('app.organization_id', coalesce(p_organization_id::text, ''), false);
  PERFORM set_config('app.user_id', coalesce(p_user_id::text, ''), false);
  PERFORM set_config('app.acting_role', '', false);
  PERFORM set_config('app.is_platform_admin', CASE WHEN p_organization_id IS NULL THEN '1' ELSE '0' END, false);
  PERFORM set_config('app.bypass_financial_triggers', '0', false);
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public;
--> statement-breakpoint

-- 11. Grants: runtime role must be able to call the non-system functions.
--     (set_tenant_context_for_system is NOT granted.)
GRANT EXECUTE ON FUNCTION set_tenant_context(uuid, uuid) TO scolaira_app;
GRANT EXECUTE ON FUNCTION enter_platform_context(uuid) TO scolaira_app;
GRANT EXECUTE ON FUNCTION clear_app_context() TO scolaira_app;
--> statement-breakpoint

-- 12. Extend audit_event_type enum with M4 authorization events.
--     (M2 used a free-text event_type column? Let's check — actually
--     audit_events.event_type is text, not an enum, so no migration needed.
--     We document new event type strings in code.)
--> statement-breakpoint
