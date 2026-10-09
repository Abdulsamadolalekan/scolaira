-- M10 final-audit hardening for database context authority.
--
-- Reconciliation policies must not accept the public payment-link context as a
-- tenant session, and the platform branch must not be forgeable by setting a
-- known platform-admin UUID in ordinary GUCs. Platform entry now carries an
-- HMAC token bound to the current backend, while authenticated tenant access
-- requires a non-empty authenticated user context.

CREATE OR REPLACE FUNCTION auth_platform_token_for(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_secret text;
BEGIN
  SELECT v INTO v_secret FROM app_meta WHERE k = 'tenant_ctx_secret';
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'tenant_ctx_secret not initialized';
  END IF;
  RETURN encode(
    hmac('platform|' || p_user_id::text || '|' || pg_backend_pid()::text,
         v_secret, 'sha256'),
    'hex'
  );
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_platform_token_for(uuid) FROM PUBLIC, scolaira_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_is_platform_admin_authorized()
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id uuid;
  v_ok boolean;
  v_token text;
BEGIN
  IF current_setting('app.is_platform_admin', true) IS DISTINCT FROM '1' THEN
    RETURN false;
  END IF;
  v_id := NULLIF(current_setting('app.platform_admin_id', true), '')::uuid;
  v_token := NULLIF(current_setting('app.platform_token', true), '');
  IF v_id IS NULL OR v_token IS NULL THEN
    RETURN false;
  END IF;
  IF v_token IS DISTINCT FROM auth_platform_token_for(v_id) THEN
    RETURN false;
  END IF;

  PERFORM set_config('app.auth_bootstrap', '1', true);
  SELECT is_platform_admin INTO v_ok FROM users WHERE id = v_id;
  PERFORM set_config('app.auth_bootstrap', '0', true);
  RETURN v_ok IS NOT DISTINCT FROM true;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_enter_system_context()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM set_config('app.organization_id', '', false);
  PERFORM set_config('app.user_id', '', false);
  PERFORM set_config('app.acting_role', '', false);
  PERFORM set_config('app.is_platform_admin', '0', false);
  PERFORM set_config('app.platform_admin_id', '', false);
  PERFORM set_config('app.platform_token', '', false);
  PERFORM set_config('app.auth_bootstrap', '1', false);
  PERFORM set_config('app.bypass_financial_triggers', '0', false);
  PERFORM set_config('app.tenant_token', '', false);
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION clear_app_context()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM set_config('app.organization_id', '', false);
  PERFORM set_config('app.user_id', '', false);
  PERFORM set_config('app.is_platform_admin', '0', false);
  PERFORM set_config('app.platform_admin_id', '', false);
  PERFORM set_config('app.platform_token', '', false);
  PERFORM set_config('app.auth_bootstrap', '0', false);
  PERFORM set_config('app.bypass_financial_triggers', '0', false);
  PERFORM set_config('app.public_context', '', false);
  PERFORM set_config('app.public_link_token', '', false);
  PERFORM set_config('app.tenant_token', '', false);
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_set_public_context(p_org uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_org IS NULL THEN
    RAISE EXCEPTION 'auth_set_public_context: org must not be null';
  END IF;
  PERFORM set_config('app.organization_id', p_org::text, false);
  PERFORM set_config('app.user_id', '', false);
  PERFORM set_config('app.is_platform_admin', '0', false);
  PERFORM set_config('app.platform_admin_id', '', false);
  PERFORM set_config('app.platform_token', '', false);
  PERFORM set_config('app.auth_bootstrap', '0', false);
  PERFORM set_config('app.bypass_financial_triggers', '0', false);
  PERFORM set_config('app.public_context', '1', false);
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_clear_public_context()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM set_config('app.organization_id', '', false);
  PERFORM set_config('app.user_id', '', false);
  PERFORM set_config('app.is_platform_admin', '0', false);
  PERFORM set_config('app.platform_admin_id', '', false);
  PERFORM set_config('app.platform_token', '', false);
  PERFORM set_config('app.auth_bootstrap', '0', false);
  PERFORM set_config('app.bypass_financial_triggers', '0', false);
  PERFORM set_config('app.public_context', '', false);
  PERFORM set_config('app.public_link_token', '', false);
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION set_tenant_context(p_organization_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role membership_role;
  v_is_member boolean := false;
BEGIN
  PERFORM set_config('app.platform_token', '', false);

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

  PERFORM set_config('app.auth_bootstrap', '1', false);
  BEGIN
    SELECT "role" INTO v_role
      FROM organization_members
     WHERE organization_id = p_organization_id
       AND user_id = p_user_id
       AND status = 'ACTIVE';
    v_is_member := FOUND;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.organization_id', '', false);
    PERFORM set_config('app.user_id', '', false);
    PERFORM set_config('app.acting_role', '', false);
    PERFORM set_config('app.is_platform_admin', '0', false);
    PERFORM set_config('app.platform_admin_id', '', false);
    PERFORM set_config('app.platform_token', '', false);
    PERFORM set_config('app.auth_bootstrap', '0', false);
    PERFORM set_config('app.bypass_financial_triggers', '0', false);
    PERFORM set_config('app.tenant_token', '', false);
    RAISE;
  END;
  PERFORM set_config('app.auth_bootstrap', '0', false);

  IF NOT v_is_member THEN
    PERFORM set_config('app.organization_id', '', false);
    PERFORM set_config('app.user_id', '', false);
    PERFORM set_config('app.acting_role', '', false);
    PERFORM set_config('app.is_platform_admin', '0', false);
    PERFORM set_config('app.platform_admin_id', '', false);
    PERFORM set_config('app.platform_token', '', false);
    PERFORM set_config('app.auth_bootstrap', '0', false);
    PERFORM set_config('app.bypass_financial_triggers', '0', false);
    PERFORM set_config('app.tenant_token', '', false);
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
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION set_tenant_context_for_system(p_organization_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
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
  PERFORM set_config('app.platform_token', '', false);
  PERFORM set_config('app.auth_bootstrap', '0', false);
  PERFORM set_config('app.bypass_financial_triggers', '0', false);
  PERFORM set_config('app.tenant_token', '', false);
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION enter_platform_context(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_admin boolean;
  v_is_admin boolean := false;
BEGIN
  PERFORM set_config('app.platform_token', '', false);
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Cannot enter platform context without user_id';
  END IF;
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
    PERFORM set_config('app.platform_token', '', false);
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
  PERFORM set_config('app.platform_token', auth_platform_token_for(p_user_id), false);
END;
$$;
--> statement-breakpoint

DROP POLICY IF EXISTS reconciliation_cases_tenant_isolation ON reconciliation_cases;
CREATE POLICY reconciliation_cases_tenant_isolation ON reconciliation_cases FOR ALL
USING (
  auth_is_platform_admin_authorized()
  OR (
    auth_is_tenant_authorized()
    AND NULLIF(current_setting('app.user_id', true), '') IS NOT NULL
    AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  )
)
WITH CHECK (
  auth_is_platform_admin_authorized()
  OR (
    auth_is_tenant_authorized()
    AND NULLIF(current_setting('app.user_id', true), '') IS NOT NULL
    AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  )
);
--> statement-breakpoint

DROP POLICY IF EXISTS reconciliation_evidence_tenant_isolation ON reconciliation_evidence;
CREATE POLICY reconciliation_evidence_tenant_isolation ON reconciliation_evidence FOR ALL
USING (
  auth_is_platform_admin_authorized()
  OR (
    auth_is_tenant_authorized()
    AND NULLIF(current_setting('app.user_id', true), '') IS NOT NULL
    AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  )
)
WITH CHECK (
  auth_is_platform_admin_authorized()
  OR (
    auth_is_tenant_authorized()
    AND NULLIF(current_setting('app.user_id', true), '') IS NOT NULL
    AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  )
);
--> statement-breakpoint

DROP POLICY IF EXISTS reconciliation_candidates_tenant_isolation ON reconciliation_candidates;
CREATE POLICY reconciliation_candidates_tenant_isolation ON reconciliation_candidates FOR ALL
USING (
  auth_is_platform_admin_authorized()
  OR (
    auth_is_tenant_authorized()
    AND NULLIF(current_setting('app.user_id', true), '') IS NOT NULL
    AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  )
)
WITH CHECK (
  auth_is_platform_admin_authorized()
  OR (
    auth_is_tenant_authorized()
    AND NULLIF(current_setting('app.user_id', true), '') IS NOT NULL
    AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  )
);
