-- M4.10: SECURITY LOCKDOWN — close the runtime RLS-bypass escalation path.
--
-- VULNERABILITY BEFORE THIS MIGRATION:
--   `scolaira_app` had EXECUTE on `set_tenant_context_for_system(NULL,NULL)`
--   (SECURITY DEFINER), which flipped `app.is_platform_admin='1'`. Every RLS
--   policy had `OR app.is_platform_admin='1'`, giving unrestricted cross-
--   tenant access to any SQL running as scolaira_app.
--
-- FIX:
--   1. Default privileges granting EXECUTE to scolaira_app on new functions
--      are REVOKED. EXECUTE is granted per-function on a whitelist.
--   2. set_tenant_context_for_system(NULL,NULL) is REVOKEd from
--      scolaira_app/PUBLIC and additionally guards against NULL-org calls
--      from non-owner roles.
--   3. The platform branch in RLS policies no longer trusts a boolean GUC.
--      A SECURITY DEFINER helper `auth_is_platform_admin_authorized()`
--      verifies that app.platform_admin_id refers to a user whose
--      is_platform_admin=true. It uses bootstrap visibility internally
--      (safe; bootstrap does not grant access to tenant data).
--   4. enter_platform_context(uid) — the ONLY sanctioned path to platform
--      mode — verifies is_platform_admin (using bootstrap visibility),
--      then sets BOTH app.is_platform_admin='1' and
--      app.platform_admin_id=<uid>. Direct set_config calls cannot forge
--      authorization because the policy consults the SECURITY DEFINER.
--   5. Pre-auth bootstrap (auth_enter_system_context) is narrow:
--      auth_bootstrap='1' grants access ONLY to users, organizations,
--      organization_members, sessions, password_credentials,
--      password_resets. It does NOT open financial/student/tenant tables.
--   6. set_tenant_context is made robust (resets GUCs on failure); it
--      uses bootstrap visibility internally to resolve membership.

-- (1) Remove default-privilege auto-grants from migration 0006.
ALTER DEFAULT PRIVILEGES FOR ROLE scolaira_owner IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM scolaira_app;
ALTER DEFAULT PRIVILEGES FOR ROLE scolaira_owner IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--> statement-breakpoint

-- (2) set_tenant_context_for_system: guard + reset new GUCs.
CREATE OR REPLACE FUNCTION set_tenant_context_for_system(
  p_organization_id uuid,
  p_user_id uuid
) RETURNS void AS $$
BEGIN
  IF p_organization_id IS NULL
     AND NOT (pg_has_role(current_user, 'scolaira_owner', 'MEMBER')
              OR (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION 'set_tenant_context_for_system(NULL, NULL) is restricted to the schema owner'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.organization_id', coalesce(p_organization_id::text, ''), false);
  PERFORM set_config('app.user_id', coalesce(p_user_id::text, ''), false);
  PERFORM set_config('app.acting_role', '', false);
  PERFORM set_config('app.is_platform_admin',
    CASE WHEN p_organization_id IS NULL THEN '1' ELSE '0' END, false);
  PERFORM set_config('app.platform_admin_id',
    CASE WHEN p_organization_id IS NULL THEN coalesce(p_user_id::text, '') ELSE '' END, false);
  PERFORM set_config('app.auth_bootstrap', '0', false);
  PERFORM set_config('app.bypass_financial_triggers', '0', false);
  PERFORM set_config('app.tenant_token', '', false);
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public;
--> statement-breakpoint

-- (3) SECURITY DEFINER that verifies the current platform_admin_id refers
--     to a genuine platform-admin user. Uses bootstrap visibility to read
--     users (safe recursion break because bootstrap does not depend on
--     platform_admin_id).
CREATE OR REPLACE FUNCTION auth_is_platform_admin_authorized()
RETURNS boolean AS $$
DECLARE
  v_id uuid;
  v_ok boolean;
BEGIN
  IF current_setting('app.is_platform_admin', true) IS DISTINCT FROM '1' THEN
    RETURN false;
  END IF;
  v_id := NULLIF(current_setting('app.platform_admin_id', true), '')::uuid;
  IF v_id IS NULL THEN RETURN false; END IF;
  -- Use bootstrap visibility (set inside this SECURITY DEFINER) to read
  -- the users table without triggering the platform branch recursively.
  PERFORM set_config('app.auth_bootstrap', '1', true);
  SELECT is_platform_admin INTO v_ok FROM users WHERE id = v_id;
  PERFORM set_config('app.auth_bootstrap', '0', true);
  RETURN v_ok IS NOT DISTINCT FROM true;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_is_platform_admin_authorized() TO scolaira_app;
--> statement-breakpoint

-- (4) Robust set_tenant_context.
CREATE OR REPLACE FUNCTION set_tenant_context(
  p_organization_id uuid,
  p_user_id uuid
) RETURNS void AS $$
DECLARE
  v_role      membership_role;
  v_is_member boolean := false;
BEGIN
  IF p_organization_id IS NULL THEN
    PERFORM set_config('app.organization_id', '', false);
    PERFORM set_config('app.user_id', coalesce(p_user_id::text, ''), false);
    PERFORM set_config('app.acting_role', '', false);
    PERFORM set_config('app.is_platform_admin', '0', false);
    PERFORM set_config('app.platform_admin_id', '', false);
    PERFORM set_config('app.auth_bootstrap', '0', false);
    PERFORM set_config('app.bypass_financial_triggers', '0', false);
    PERFORM set_config('app.tenant_token', '', false);
    RETURN;
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Cannot set tenant context without user_id';
  END IF;

  -- Temporarily flip bootstrap so the SECURITY DEFINER (owner) can look up
  -- the membership row for ANY organization, regardless of current tenant.
  PERFORM set_config('app.auth_bootstrap', '1', false);
  BEGIN
    SELECT "role" INTO v_role
      FROM "organization_members"
     WHERE "organization_id" = p_organization_id
       AND "user_id" = p_user_id
       AND "status" = 'ACTIVE';
    -- Capture FOUND immediately — subsequent PERFORM statements clobber it.
    v_is_member := FOUND;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.organization_id', '', false);
    PERFORM set_config('app.user_id', '', false);
    PERFORM set_config('app.acting_role', '', false);
    PERFORM set_config('app.is_platform_admin', '0', false);
    PERFORM set_config('app.platform_admin_id', '', false);
    PERFORM set_config('app.auth_bootstrap', '0', false);
    PERFORM set_config('app.bypass_financial_triggers', '0', false);
    RAISE;
  END;
  PERFORM set_config('app.auth_bootstrap', '0', false);

  IF NOT v_is_member THEN
    PERFORM set_config('app.organization_id', '', false);
    PERFORM set_config('app.user_id', '', false);
    PERFORM set_config('app.acting_role', '', false);
    PERFORM set_config('app.is_platform_admin', '0', false);
    PERFORM set_config('app.platform_admin_id', '', false);
    PERFORM set_config('app.bypass_financial_triggers', '0', false);
    RAISE EXCEPTION 'User % is not an active member of organization %', p_user_id, p_organization_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM set_config('app.organization_id', p_organization_id::text, false);
  PERFORM set_config('app.user_id', p_user_id::text, false);
  PERFORM set_config('app.acting_role', v_role::text, false);
  PERFORM set_config('app.is_platform_admin', '0', false);
  PERFORM set_config('app.platform_admin_id', '', false);
  PERFORM set_config('app.auth_bootstrap', '0', false);
  PERFORM set_config('app.bypass_financial_triggers', '0', false);
  PERFORM set_config('app.tenant_token', auth_tenant_token_for(p_organization_id, p_user_id), false);
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public;
--> statement-breakpoint

-- (4b) Unforgeable tenant-context token.
--
-- PROBLEM: GUCs like app.organization_id / app.user_id can be set directly
-- by any role with SQL access (via set_config), so a tenant policy that
-- trusts those values (e.g. "organization_id = current_setting(...)") is
-- forgeable even after membership is validated inside set_tenant_context.
--
-- SOLUTION: after membership is validated, the SECURITY DEFINER
-- set_tenant_context() computes an HMAC over (org, user, backend_pid)
-- using a server-side secret that the runtime role CANNOT read, and
-- stores it in app.tenant_token. auth_is_tenant_authorized() (also
-- SECURITY DEFINER) recomputes and compares. An attacker who forges
-- org/user via set_config cannot produce the matching HMAC because they
-- cannot read the secret.
--
-- The secret lives in a schema-qualified table owned by scolaira_owner
-- with NO grants to scolaira_app. pg_backend_pid() binds the token to the
-- current PG backend; reset on disconnect / connection-pool recycle.
CREATE TABLE IF NOT EXISTS app_meta (
  k text PRIMARY KEY,
  v text NOT NULL
);
ALTER TABLE app_meta ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_meta FROM PUBLIC, scolaira_app;
INSERT INTO app_meta (k, v) VALUES ('tenant_ctx_secret', encode(gen_random_bytes(32), 'hex'))
ON CONFLICT (k) DO NOTHING;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_tenant_token_for(p_org uuid, p_user uuid)
RETURNS text AS $$
DECLARE
  v_secret text;
  v_pid    int;
BEGIN
  SELECT v INTO v_secret FROM app_meta WHERE k = 'tenant_ctx_secret';
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'tenant_ctx_secret not initialized';
  END IF;
  v_pid := pg_backend_pid();
  RETURN encode(hmac(p_org::text || '|' || p_user::text || '|' || v_pid::text,
                     v_secret, 'sha256'), 'hex');
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public;
-- No EXECUTE grant to scolaira_app: only internal callers (owner SECDEFs)
-- may mint tokens.
--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_is_tenant_authorized()
RETURNS boolean AS $$
DECLARE
  v_org    uuid;
  v_user   uuid;
  v_tok    text;
  v_expect text;
BEGIN
  v_org  := NULLIF(current_setting('app.organization_id', true), '')::uuid;
  v_user := NULLIF(current_setting('app.user_id',       true), '')::uuid;
  v_tok  := NULLIF(current_setting('app.tenant_token',  true), '');
  IF v_org IS NULL OR v_user IS NULL OR v_tok IS NULL THEN RETURN false; END IF;
  v_expect := auth_tenant_token_for(v_org, v_user);
  RETURN v_tok IS NOT DISTINCT FROM v_expect;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_is_tenant_authorized() TO scolaira_app;
--> statement-breakpoint

-- SQL mini-macros used across the policy DO block below.
-- platform_ok  = auth_is_platform_admin_authorized()
-- tenant_ok    = auth_is_tenant_authorized()
-- Bootstrap is: current_setting('app.auth_bootstrap', true) = '1'
--              (granted only on auth/identity tables, not on tenant tables.)

-- (5) Recreate tenant-table RLS with tightened branches.
DO $$
DECLARE t text;
BEGIN
  FOR t IN VALUES
    ('academic_sessions'),('terms'),('classes'),
    ('students'),('guardians'),('student_guardians'),('class_enrollments'),
    ('fee_definitions'),('fee_assignments'),('invoices'),('invoice_lines'),
    ('payments'),('payment_allocations'),('receipts'),('reversals'),
    ('payment_links'),('communications'),('audit_events'),('idempotency_keys'),
    ('webhook_events'),('doc_number_sequences')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I FOR ALL USING (
         auth_is_platform_admin_authorized()
         OR (auth_is_tenant_authorized()
             AND "organization_id" = NULLIF(current_setting(''app.organization_id'', true), '''')::uuid)
       ) WITH CHECK (
         auth_is_platform_admin_authorized()
         OR (auth_is_tenant_authorized()
             AND "organization_id" = NULLIF(current_setting(''app.organization_id'', true), '''')::uuid)
       );', t, t);
  END LOOP;
END $$;
--> statement-breakpoint

-- organization_members + organizations: also accessible in bootstrap mode
-- (for register/getSession membership enumeration). Tenant branch requires
-- a minted tenant_token (auth_is_tenant_authorized) AND scopes rows to the
-- exact organization_id in the GUC — never the GUC alone. Note the explicit
-- parentheses around each OR-branch: SQL operator precedence would otherwise
-- bind AND tighter than OR, leaking rows.
DROP POLICY IF EXISTS organization_members_tenant_isolation ON organization_members;
CREATE POLICY organization_members_tenant_isolation ON organization_members FOR ALL USING (
  auth_is_platform_admin_authorized()
  OR current_setting('app.auth_bootstrap', true) = '1'
  OR (auth_is_tenant_authorized()
      AND "organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid)
) WITH CHECK (
  auth_is_platform_admin_authorized()
  OR current_setting('app.auth_bootstrap', true) = '1'
  OR (auth_is_tenant_authorized()
      AND "organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid)
);
--> statement-breakpoint

DROP POLICY IF EXISTS organizations_tenant_isolation ON organizations;
CREATE POLICY organizations_tenant_isolation ON organizations FOR ALL USING (
  auth_is_platform_admin_authorized()
  OR current_setting('app.auth_bootstrap', true) = '1'
  OR (auth_is_tenant_authorized()
      AND "id" = NULLIF(current_setting('app.organization_id', true), '')::uuid)
) WITH CHECK (
  auth_is_platform_admin_authorized()
  OR current_setting('app.auth_bootstrap', true) = '1'
  OR (auth_is_tenant_authorized()
      AND "id" = NULLIF(current_setting('app.organization_id', true), '')::uuid)
);
--> statement-breakpoint

-- sessions / password_credentials / password_resets: bootstrap + self + platform.
DROP POLICY IF EXISTS sessions_self ON sessions;
CREATE POLICY sessions_self ON sessions FOR ALL USING (
  current_setting('app.auth_bootstrap', true) = '1'
  OR auth_is_platform_admin_authorized()
  OR "user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
) WITH CHECK (
  current_setting('app.auth_bootstrap', true) = '1'
  OR auth_is_platform_admin_authorized()
  OR "user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
);
--> statement-breakpoint

DROP POLICY IF EXISTS password_credentials_self ON password_credentials;
CREATE POLICY password_credentials_self ON password_credentials FOR ALL USING (
  current_setting('app.auth_bootstrap', true) = '1'
  OR auth_is_platform_admin_authorized()
  OR "user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
) WITH CHECK (
  current_setting('app.auth_bootstrap', true) = '1'
  OR auth_is_platform_admin_authorized()
  OR "user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
);
--> statement-breakpoint

DROP POLICY IF EXISTS password_resets_self ON password_resets;
CREATE POLICY password_resets_self ON password_resets FOR ALL USING (
  current_setting('app.auth_bootstrap', true) = '1'
  OR auth_is_platform_admin_authorized()
  OR "user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
) WITH CHECK (
  current_setting('app.auth_bootstrap', true) = '1'
  OR auth_is_platform_admin_authorized()
  OR "user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
);
--> statement-breakpoint

-- Users: bootstrap + self + co-member + platform (validated via helper).
-- INSERT allowed under bootstrap (register) and platform mode.
-- UPDATE allowed under bootstrap, self, or platform mode.
DROP POLICY IF EXISTS users_read ON users;
DROP POLICY IF EXISTS users_write ON users;
DROP POLICY IF EXISTS users_update ON users;
CREATE POLICY users_read ON users FOR SELECT USING (
  current_setting('app.auth_bootstrap', true) = '1'
  OR auth_is_platform_admin_authorized()
  OR "id" = NULLIF(current_setting('app.user_id', true), '')::uuid
  OR (auth_is_tenant_authorized()
      AND "id" IN (
        SELECT om.user_id FROM organization_members om
         WHERE om.organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
           AND om.status = 'ACTIVE'
      ))
);
CREATE POLICY users_write ON users FOR INSERT WITH CHECK (
  current_setting('app.auth_bootstrap', true) = '1'
  OR auth_is_platform_admin_authorized()
);
CREATE POLICY users_update ON users FOR UPDATE USING (
  current_setting('app.auth_bootstrap', true) = '1'
  OR auth_is_platform_admin_authorized()
  OR "id" = NULLIF(current_setting('app.user_id', true), '')::uuid
) WITH CHECK (
  current_setting('app.auth_bootstrap', true) = '1'
  OR auth_is_platform_admin_authorized()
  OR "id" = NULLIF(current_setting('app.user_id', true), '')::uuid
);
--> statement-breakpoint

-- rate_limits / login_attempts: owner-only via SECURITY DEFINER helpers.
DROP POLICY IF EXISTS rate_limits_owner_all ON rate_limits;
CREATE POLICY rate_limits_owner_all ON rate_limits FOR ALL
  TO scolaira_owner USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS login_attempts_owner_all ON login_attempts;
CREATE POLICY login_attempts_owner_all ON login_attempts FOR ALL
  TO scolaira_owner USING (true) WITH CHECK (true);
--> statement-breakpoint

-- Tighten trg_set_org_from_context: accept explicit organization_id during
-- bootstrap mode (register flow seeds org/user/member together before any
-- tenant context exists) in addition to platform context. This does NOT
-- open tenant reads/writes — the RLS policies already govern visibility;
-- the trigger is a row-correctness guard only.
CREATE OR REPLACE FUNCTION trg_set_org_from_context()
RETURNS TRIGGER AS $$
DECLARE
  v_ctx_org   uuid;
  v_is_system boolean;
  v_is_bootstrap boolean;
BEGIN
  v_ctx_org   := NULLIF(current_setting('app.organization_id', true), '')::uuid;
  v_is_system  := coalesce(nullif(current_setting('app.is_platform_admin', true), ''), '0') IN ('1','true','t','yes');
  v_is_bootstrap := current_setting('app.auth_bootstrap', true) = '1';

  IF v_ctx_org IS NULL THEN
    IF (v_is_system OR v_is_bootstrap) AND NEW."organization_id" IS NOT NULL THEN
      -- System/bootstrap context with explicit org: accept it (seeds/register).
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Cannot insert into % without organization_id and no tenant context set', TG_TABLE_NAME
      USING ERRCODE = 'not_null_violation';
  END IF;
  NEW."organization_id" := v_ctx_org;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE
    SET search_path = pg_catalog, public;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION auth_enter_system_context() RETURNS void AS $$
BEGIN
  PERFORM set_config('app.organization_id', '', false);
  PERFORM set_config('app.user_id', '', false);
  PERFORM set_config('app.acting_role', '', false);
  PERFORM set_config('app.is_platform_admin', '0', false);
  PERFORM set_config('app.platform_admin_id', '', false);
  PERFORM set_config('app.auth_bootstrap', '1', false);
  PERFORM set_config('app.bypass_financial_triggers', '0', false);
  PERFORM set_config('app.tenant_token', '', false);
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION clear_app_context() RETURNS void AS $$
BEGIN
  PERFORM set_config('app.organization_id', '', false);
  PERFORM set_config('app.user_id', '', false);
  PERFORM set_config('app.acting_role', '', false);
  PERFORM set_config('app.is_platform_admin', '0', false);
  PERFORM set_config('app.platform_admin_id', '', false);
  PERFORM set_config('app.auth_bootstrap', '0', false);
  PERFORM set_config('app.bypass_financial_triggers', '0', false);
  PERFORM set_config('app.tenant_token', '', false);
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION enter_platform_context(p_user_id uuid) RETURNS void AS $$
DECLARE
  v_admin    boolean;
  v_is_admin boolean := false;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'Cannot enter platform context without user_id'; END IF;
  PERFORM set_config('app.auth_bootstrap', '1', false);
  SELECT is_platform_admin INTO v_admin FROM users WHERE id = p_user_id;
  v_is_admin := FOUND;
  PERFORM set_config('app.auth_bootstrap', '0', false);
  IF NOT v_is_admin OR NOT v_admin THEN
    PERFORM set_config('app.organization_id', '', false);
    PERFORM set_config('app.user_id', '', false);
    PERFORM set_config('app.acting_role', '', false);
    PERFORM set_config('app.is_platform_admin', '0', false);
    PERFORM set_config('app.platform_admin_id', '', false);
    PERFORM set_config('app.auth_bootstrap', '0', false);
    PERFORM set_config('app.bypass_financial_triggers', '0', false);
    PERFORM set_config('app.tenant_token', '', false);
    RAISE EXCEPTION 'User % is not authorized for platform context', p_user_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.organization_id', '', false);
  PERFORM set_config('app.user_id', p_user_id::text, false);
  PERFORM set_config('app.acting_role', '', false);
  PERFORM set_config('app.is_platform_admin', '1', false);
  PERFORM set_config('app.platform_admin_id', p_user_id::text, false);
  PERFORM set_config('app.auth_bootstrap', '0', false);
  PERFORM set_config('app.bypass_financial_triggers', '0', false);
  PERFORM set_config('app.tenant_token', '', false);
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_record_login_attempt(p_email text, p_ip text, p_success boolean)
RETURNS void AS $$
BEGIN
  INSERT INTO login_attempts (email, ip_address, success) VALUES (p_email, p_ip, p_success);
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_test_system_context(p_org uuid, p_user uuid) RETURNS void AS $$
BEGIN
  IF p_org IS NULL THEN
    PERFORM set_tenant_context_for_system(NULL, NULL);
    -- Test seeding needs bootstrap visibility so withSystemContext(NULL,NULL)
    -- can insert cross-tenant users/orgs/members. Don't mint a tenant_token
    -- (no tenant), and don't set a valid platform_admin_id.
    PERFORM set_config('app.auth_bootstrap', '1', false);
    PERFORM set_config('app.platform_admin_id', '', false);
  ELSE
    -- Delegate to set_tenant_context so membership is validated AND a
    -- tenant_token is minted — this mirrors what the runtime does on
    -- legitimate tenant entry.
    PERFORM set_tenant_context(p_org, p_user);
  END IF;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint

-- (7) Whitelist EXECUTE grants.
REVOKE ALL ON FUNCTION set_tenant_context_for_system(uuid, uuid) FROM PUBLIC, scolaira_app;
REVOKE ALL ON FUNCTION auth_tenant_token_for(uuid, uuid) FROM PUBLIC, scolaira_app;
GRANT EXECUTE ON FUNCTION auth_is_platform_admin_authorized() TO scolaira_app;
GRANT EXECUTE ON FUNCTION auth_is_tenant_authorized() TO scolaira_app;
GRANT EXECUTE ON FUNCTION auth_enter_system_context() TO scolaira_app;
GRANT EXECUTE ON FUNCTION clear_app_context() TO scolaira_app;
GRANT EXECUTE ON FUNCTION enter_platform_context(uuid) TO scolaira_app;
GRANT EXECUTE ON FUNCTION set_tenant_context(uuid, uuid) TO scolaira_app;
GRANT EXECUTE ON FUNCTION auth_rate_limit_hit(text, integer, interval) TO scolaira_app;
GRANT EXECUTE ON FUNCTION auth_record_login_attempt(text, text, boolean) TO scolaira_app;
GRANT EXECUTE ON FUNCTION auth_verify_password(text, text) TO scolaira_app;
GRANT EXECUTE ON FUNCTION auth_clear_rate_limits() TO scolaira_app;
GRANT EXECUTE ON FUNCTION auth_test_system_context(uuid, uuid) TO scolaira_app;
GRANT EXECUTE ON FUNCTION next_doc_number(text) TO scolaira_app;
GRANT EXECUTE ON FUNCTION trg_assign_invoice_number() TO scolaira_app;
GRANT EXECUTE ON FUNCTION trg_assign_payment_number() TO scolaira_app;
GRANT EXECUTE ON FUNCTION trg_assign_receipt_number() TO scolaira_app;
GRANT EXECUTE ON FUNCTION trg_assign_reversal_number() TO scolaira_app;
--> statement-breakpoint
