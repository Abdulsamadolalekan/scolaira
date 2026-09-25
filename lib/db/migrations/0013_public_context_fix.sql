-- M6c: Make auth_is_tenant_authorized recognize public context.
--
-- The tenant-isolation policies introduced in M4 use auth_is_tenant_authorized()
-- to confirm a tenant-scoped session; that function returns FALSE when there is
-- no user_id (as in public /p/[token] submissions). The public context helpers
-- need to be explicitly recognized as authorized within their narrow scope.
--
-- We add a dedicated public-context marker GUC (app.public_context = '1') that
-- auth_is_tenant_authorized honours. The marker is ONLY set by
-- auth_set_public_context (SECURITY DEFINER) and cleared by
-- auth_clear_public_context; public clients cannot set it themselves.

CREATE OR REPLACE FUNCTION auth_set_public_context(p_org uuid)
RETURNS void AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'auth_set_public_context: org must not be null'; END IF;
  PERFORM set_config('app.organization_id', p_org::text, false);
  PERFORM set_config('app.user_id', '', false);
  PERFORM set_config('app.is_platform_admin', '0', false);
  PERFORM set_config('app.auth_bootstrap', '0', false);
  PERFORM set_config('app.bypass_financial_triggers', '0', false);
  PERFORM set_config('app.public_context', '1', false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_clear_public_context()
RETURNS void AS $$
BEGIN
  PERFORM set_config('app.organization_id', '', false);
  PERFORM set_config('app.user_id', '', false);
  PERFORM set_config('app.is_platform_admin', '0', false);
  PERFORM set_config('app.auth_bootstrap', '0', false);
  PERFORM set_config('app.bypass_financial_triggers', '0', false);
  PERFORM set_config('app.public_context', '', false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
--> statement-breakpoint

-- Also make clear_app_context clear the public marker.
CREATE OR REPLACE FUNCTION clear_app_context()
RETURNS void AS $$
BEGIN
  PERFORM set_config('app.organization_id', '', false);
  PERFORM set_config('app.user_id', '', false);
  PERFORM set_config('app.is_platform_admin', '0', false);
  PERFORM set_config('app.auth_bootstrap', '0', false);
  PERFORM set_config('app.bypass_financial_triggers', '0', false);
  PERFORM set_config('app.public_context', '', false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
--> statement-breakpoint

-- Update tenant-authorization to accept public context.
CREATE OR REPLACE FUNCTION auth_is_tenant_authorized()
RETURNS boolean AS $$
DECLARE
  v_org    uuid;
  v_user   uuid;
  v_tok    text;
  v_expect text;
  v_public text;
BEGIN
  v_org := NULLIF(current_setting('app.organization_id', true), '')::uuid;
  -- Public context: organization set, no user, marker = 1.
  v_public := NULLIF(current_setting('app.public_context', true), '');
  IF v_public = '1' AND v_org IS NOT NULL THEN
    RETURN true;
  END IF;
  v_user := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v_tok  := NULLIF(current_setting('app.tenant_token',  true), '');
  IF v_org IS NULL OR v_user IS NULL OR v_tok IS NULL THEN RETURN false; END IF;
  v_expect := auth_tenant_token_for(v_org, v_user);
  RETURN v_tok IS NOT DISTINCT FROM v_expect;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public;
--> statement-breakpoint
