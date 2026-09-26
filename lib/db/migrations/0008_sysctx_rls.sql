-- M4.7b: tenant-table RLS policies must allow access when the GUC
-- app.is_platform_admin = '1' (system context for pre-auth flows and future
-- platform support operations).
--
-- is_platform_admin='1' is set ONLY by SECURITY DEFINER functions
-- (set_tenant_context_for_system / enter_platform_context), never by client
-- input, and withTenant() always resets it to '0' before running a handler.
-- Connection GUCs are reset on every new connection (lib/db/index.ts).
--
-- We also need tenant-scoped code to be able to READ users who are members
-- of the CURRENT organization (listMembers joins users). The users table is
-- NOT tenant-keyed directly (a user may be a member of multiple orgs), so we
-- allow reads of users who have an ACTIVE membership in the current tenant.
DO $$
DECLARE t text;
BEGIN
  FOR t IN VALUES
    ('organization_members'),('academic_sessions'),('terms'),('classes'),
    ('students'),('guardians'),('student_guardians'),('class_enrollments'),
    ('fee_definitions'),('fee_assignments'),('invoices'),('invoice_lines'),
    ('payments'),('payment_allocations'),('receipts'),('reversals'),
    ('payment_links'),('communications'),('audit_events'),('idempotency_keys'),
    ('webhook_events'),('doc_number_sequences')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I FOR ALL USING (
         current_setting(''app.is_platform_admin'', true) = ''1''
         OR "organization_id" = NULLIF(current_setting(''app.organization_id'', true), '''')::uuid
       ) WITH CHECK (
         current_setting(''app.is_platform_admin'', true) = ''1''
         OR "organization_id" = NULLIF(current_setting(''app.organization_id'', true), '''')::uuid
       );', t, t);
  END LOOP;
END $$;
--> statement-breakpoint

-- Organizations table uses id-based policy.
DROP POLICY IF EXISTS organizations_tenant_isolation ON organizations;
CREATE POLICY organizations_tenant_isolation ON organizations FOR ALL USING (
  current_setting('app.is_platform_admin', true) = '1'
  OR "id" = NULLIF(current_setting('app.organization_id', true), '')::uuid
) WITH CHECK (
  current_setting('app.is_platform_admin', true) = '1'
  OR "id" = NULLIF(current_setting('app.organization_id', true), '')::uuid
);
--> statement-breakpoint

-- Users policy: self can read/write themselves; platform admin can do
-- anything; and any member of the current tenant org can READ other users
-- who are members of that org (required for listing members / invitees).
-- Writes stay self-or-platform-only.
DROP POLICY IF EXISTS users_self_or_admin ON users;
CREATE POLICY users_read ON users FOR SELECT USING (
  current_setting('app.is_platform_admin', true) = '1'
  OR "id" = NULLIF(current_setting('app.user_id', true), '')::uuid
  OR EXISTS (
    SELECT 1 FROM organization_members om
     WHERE om.user_id = users.id
       AND om.organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
       AND om.status = 'ACTIVE'
  )
);
CREATE POLICY users_write ON users FOR INSERT
  WITH CHECK (current_setting('app.is_platform_admin', true) = '1');
CREATE POLICY users_update ON users FOR UPDATE
  USING (
    current_setting('app.is_platform_admin', true) = '1'
    OR "id" = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = '1'
    OR "id" = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
--> statement-breakpoint

-- Sessions policy (user-based). In system/platform context we allow access;
-- the M3 self-only policy already worked for authenticated reads, we extend
-- it to platform.
DROP POLICY IF EXISTS sessions_self ON sessions;
DROP POLICY IF EXISTS sessions_user_isolation ON sessions;
CREATE POLICY sessions_self ON sessions FOR ALL USING (
  current_setting('app.is_platform_admin', true) = '1'
  OR "user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
) WITH CHECK (
  current_setting('app.is_platform_admin', true) = '1'
  OR "user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
);
--> statement-breakpoint

-- Password credentials / password resets: used during login & password reset
-- (NULL user_id system context) and self-access; platform can access too.
DROP POLICY IF EXISTS password_credentials_self ON password_credentials;
CREATE POLICY password_credentials_self ON password_credentials FOR ALL USING (
  current_setting('app.is_platform_admin', true) = '1'
  OR "user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
  OR NULLIF(current_setting('app.user_id', true), '') IS NULL
) WITH CHECK (
  current_setting('app.is_platform_admin', true) = '1'
  OR "user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
  OR NULLIF(current_setting('app.user_id', true), '') IS NULL
);
--> statement-breakpoint
DROP POLICY IF EXISTS password_resets_self ON password_resets;
CREATE POLICY password_resets_self ON password_resets FOR ALL USING (
  current_setting('app.is_platform_admin', true) = '1'
  OR "user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
  OR NULLIF(current_setting('app.user_id', true), '') IS NULL
) WITH CHECK (
  current_setting('app.is_platform_admin', true) = '1'
  OR "user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
  OR NULLIF(current_setting('app.user_id', true), '') IS NULL
);
--> statement-breakpoint

-- Wrap set_tenant_context_for_system/clear helpers for the app role. (See below.)
CREATE OR REPLACE FUNCTION auth_enter_system_context() RETURNS void AS $$
BEGIN
  PERFORM set_tenant_context_for_system(NULL, NULL);
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_enter_system_context() TO scolaira_app;
--> statement-breakpoint

-- Fix set_tenant_context membership lookup: the lookup runs on a table with
-- FORCE RLS enabled; we must briefly enter platform-admin context before
-- reading organization_members so we can resolve the role, then drop back
-- to tenant scope (is_platform_admin='0'). Otherwise the function self-
-- deadlocks because we run as the app role with no org/user GUCs yet.
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

  -- Briefly enter platform-admin scope to resolve membership across RLS.
  PERFORM set_config('app.is_platform_admin', '1', false);

  SELECT "role" INTO v_role
    FROM "organization_members"
   WHERE "organization_id" = p_organization_id
     AND "user_id" = p_user_id
     AND "status" = 'ACTIVE';

  IF NOT FOUND THEN
    PERFORM set_config('app.organization_id', '', false);
    PERFORM set_config('app.user_id', '', false);
    PERFORM set_config('app.acting_role', '', false);
    PERFORM set_config('app.is_platform_admin', '0', false);
    RAISE EXCEPTION 'User % is not an active member of organization %', p_user_id, p_organization_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM set_config('app.organization_id', p_organization_id::text, false);
  PERFORM set_config('app.user_id', p_user_id::text, false);
  PERFORM set_config('app.acting_role', v_role::text, false);
  PERFORM set_config('app.is_platform_admin', '0', false);
  PERFORM set_config('app.bypass_financial_triggers', '0', false);
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint
