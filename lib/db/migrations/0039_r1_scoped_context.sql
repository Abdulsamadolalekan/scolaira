-- R1 (C-1) — transaction-scoped authorization context.
--
-- BEFORE
--   Authorization context was written with `set_config(..., is_local => false)`
--   i.e. SESSION scope, on whatever pooled connection happened to serve the
--   statement. Correctness therefore depended on the pool being pinned to a
--   single connection and on application cleanup running. The readiness audit
--   (C-1) proved that a session-scoped context set by one request remains
--   readable by the next statement that lands on that connection.
--
-- AFTER
--   Every context-bearing operation runs inside `runScoped()`
--   (lib/db/scope.ts), which reserves an exclusive connection, opens a
--   transaction on it, and calls the `auth_scope_*_local` functions below.
--   Those write with `is_local => true`, so POSTGRES ITSELF reverts the entire
--   context when the transaction ends. Cleanup is then a verification step
--   rather than the thing that provides safety.
--
--   The scope sets the transaction-local marker `app.r1_scope_depth`. The
--   legacy session-scoped entry points are redefined to be SCOPE-AWARE: they
--   write at the transaction-local layer when a scope is active and at the
--   session layer otherwise. That keeps every existing caller correct (no
--   silent no-op where a transaction-local overlay would mask a session write)
--   without weakening the guarantee.
--
-- NOTHING HERE WEAKENS AUTHORIZATION. Membership validation and HMAC token
-- minting are unchanged; only the *layer* at which the resulting GUCs are
-- written has changed.

-- ---------------------------------------------------------------------------
-- Scope marker + layer selection
-- ---------------------------------------------------------------------------

-- True when the current transaction is a SCOLAIRA scope (set by runScoped).
CREATE OR REPLACE FUNCTION auth_r1_scope_active()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT NULLIF(current_setting('app.r1_scope_depth', true), '') IS NOT NULL
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Scope entry points (unconditionally transaction-local).
-- ---------------------------------------------------------------------------

-- Pre-authentication system context: bootstrap visibility over identity tables
-- only (users, organizations, organization_members, sessions, credentials,
-- password resets). Used by the session trust gate.
CREATE OR REPLACE FUNCTION auth_scope_system_local()
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT auth_r1_scope_active() THEN
    RAISE EXCEPTION 'auth_scope_system_local() is transaction-local by contract and must be called inside a SCOLAIRA scope (lib/db/scope.ts)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.organization_id', '', true);
  PERFORM set_config('app.user_id', '', true);
  PERFORM set_config('app.acting_role', '', true);
  PERFORM set_config('app.is_platform_admin', '0', true);
  PERFORM set_config('app.platform_admin_id', '', true);
  PERFORM set_config('app.platform_token', '', true);
  PERFORM set_config('app.tenant_token', '', true);
  PERFORM set_config('app.bypass_financial_triggers', '0', true);
  PERFORM set_config('app.public_context', '', true);
  PERFORM set_config('app.public_link_token', '', true);
  PERFORM set_config('app.public_proof', '', true);
  PERFORM set_config('app.auth_bootstrap', '1', true);
END;
$$;
--> statement-breakpoint

-- Seed/test context. Mirrors the historical auth_test_system_context():
--   * NULL organization -> bootstrap + platform selector with no valid
--     platform_admin_id (so auth_is_platform_admin_authorized() stays false)
--     and no tenant token. Restricted to the schema owner, exactly as before.
--   * non-NULL organization -> validated tenant membership (delegates).
-- Not reachable from any request handler.
CREATE OR REPLACE FUNCTION auth_scope_seed_local(p_organization_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_organization_id IS NULL THEN
    IF NOT (pg_has_role(current_user, 'scolaira_owner', 'MEMBER')
            OR (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)) THEN
      RAISE EXCEPTION 'seed context with NULL organization is restricted to the schema owner'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM set_config('app.organization_id', '', true);
    PERFORM set_config('app.user_id', coalesce(p_user_id::text, ''), true);
    PERFORM set_config('app.acting_role', '', true);
    PERFORM set_config('app.is_platform_admin', '1', true);
    PERFORM set_config('app.platform_admin_id', coalesce(p_user_id::text, ''), true);
    PERFORM set_config('app.platform_token', '', true);
    PERFORM set_config('app.tenant_token', '', true);
    PERFORM set_config('app.bypass_financial_triggers', '0', true);
    PERFORM set_config('app.public_context', '', true);
    PERFORM set_config('app.public_link_token', '', true);
    PERFORM set_config('app.public_proof', '', true);
    PERFORM set_config('app.auth_bootstrap', '1', true);
    RETURN;
  END IF;
  PERFORM auth_scope_tenant_local(p_organization_id, p_user_id);
END;
$$;
--> statement-breakpoint

-- Validated tenant context. Identical verification and token minting to
-- set_tenant_context(), but transaction-local. The tenant token is bound to
-- pg_backend_pid(), which is now guaranteed to be the same backend that runs
-- the protected queries (before R1 the token and the queries could land on
-- different pooled connections).
CREATE OR REPLACE FUNCTION auth_scope_tenant_local(p_organization_id uuid, p_user_id uuid)
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
  IF NOT auth_r1_scope_active() THEN
    RAISE EXCEPTION 'auth_scope_tenant_local() is transaction-local by contract and must be called inside a SCOLAIRA scope (lib/db/scope.ts)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_organization_id IS NULL THEN
    PERFORM set_config('app.organization_id', '', true);
    PERFORM set_config('app.user_id', coalesce(p_user_id::text, ''), true);
    PERFORM set_config('app.acting_role', '', true);
    PERFORM set_config('app.is_platform_admin', '0', true);
    PERFORM set_config('app.platform_admin_id', '', true);
    PERFORM set_config('app.platform_token', '', true);
    PERFORM set_config('app.tenant_token', '', true);
    PERFORM set_config('app.bypass_financial_triggers', '0', true);
    PERFORM set_config('app.public_context', '', true);
    PERFORM set_config('app.public_link_token', '', true);
    PERFORM set_config('app.public_proof', '', true);
    PERFORM set_config('app.auth_bootstrap', '0', true);
    RETURN;
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Cannot set tenant context without user_id';
  END IF;

  -- Bootstrap visibility is required to read organization_members, which has
  -- FORCE ROW LEVEL SECURITY. It grants nothing beyond the identity tables.
  PERFORM set_config('app.auth_bootstrap', '1', true);
  BEGIN
    SELECT "role" INTO v_role
      FROM organization_members
     WHERE organization_id = p_organization_id
       AND user_id = p_user_id
       AND status = 'ACTIVE';
    v_is_member := FOUND;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.auth_bootstrap', '0', true);
    PERFORM set_config('app.organization_id', '', true);
    PERFORM set_config('app.user_id', '', true);
    PERFORM set_config('app.acting_role', '', true);
    PERFORM set_config('app.is_platform_admin', '0', true);
    PERFORM set_config('app.platform_admin_id', '', true);
    PERFORM set_config('app.platform_token', '', true);
    PERFORM set_config('app.tenant_token', '', true);
    RAISE;
  END;
  PERFORM set_config('app.auth_bootstrap', '0', true);

  IF NOT v_is_member THEN
    PERFORM set_config('app.organization_id', '', true);
    PERFORM set_config('app.user_id', '', true);
    PERFORM set_config('app.acting_role', '', true);
    PERFORM set_config('app.is_platform_admin', '0', true);
    PERFORM set_config('app.platform_admin_id', '', true);
    PERFORM set_config('app.platform_token', '', true);
    PERFORM set_config('app.tenant_token', '', true);
    RAISE EXCEPTION 'User % is not an active member of organization %', p_user_id, p_organization_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM set_config('app.organization_id', p_organization_id::text, true);
  PERFORM set_config('app.user_id', p_user_id::text, true);
  PERFORM set_config('app.acting_role', v_role::text, true);
  PERFORM set_config('app.is_platform_admin', '0', true);
  PERFORM set_config('app.platform_admin_id', '', true);
  PERFORM set_config('app.tenant_token', auth_tenant_token_for(p_organization_id, p_user_id), true);
  PERFORM set_config('app.bypass_financial_triggers', '0', true);
  PERFORM set_config('app.public_context', '', true);
  PERFORM set_config('app.public_link_token', '', true);
  PERFORM set_config('app.public_proof', '', true);
  PERFORM set_config('app.auth_bootstrap', '0', true);
END;
$$;
--> statement-breakpoint

-- Platform-support context, transaction-local. Token is bound to the backend.
CREATE OR REPLACE FUNCTION auth_scope_platform_local(p_user_id uuid)
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
  IF NOT auth_r1_scope_active() THEN
    RAISE EXCEPTION 'auth_scope_platform_local() is transaction-local by contract and must be called inside a SCOLAIRA scope (lib/db/scope.ts)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Cannot enter platform context without user_id';
  END IF;
  PERFORM set_config('app.auth_bootstrap', '1', true);
  SELECT is_platform_admin INTO v_admin FROM users WHERE id = p_user_id;
  v_is_admin := FOUND;
  PERFORM set_config('app.auth_bootstrap', '0', true);
  IF NOT v_is_admin OR NOT v_admin THEN
    PERFORM set_config('app.organization_id', '', true);
    PERFORM set_config('app.user_id', '', true);
    PERFORM set_config('app.acting_role', '', true);
    PERFORM set_config('app.is_platform_admin', '0', true);
    PERFORM set_config('app.platform_admin_id', '', true);
    PERFORM set_config('app.platform_token', '', true);
    PERFORM set_config('app.tenant_token', '', true);
    RAISE EXCEPTION 'User % is not authorized for platform context', p_user_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.organization_id', '', true);
  PERFORM set_config('app.user_id', p_user_id::text, true);
  PERFORM set_config('app.acting_role', '', true);
  PERFORM set_config('app.is_platform_admin', '1', true);
  PERFORM set_config('app.platform_admin_id', p_user_id::text, true);
  PERFORM set_config('app.platform_token', auth_platform_token_for(p_user_id), true);
  PERFORM set_config('app.tenant_token', '', true);
  PERFORM set_config('app.bypass_financial_triggers', '0', true);
  PERFORM set_config('app.public_context', '', true);
  PERFORM set_config('app.public_link_token', '', true);
  PERFORM set_config('app.public_proof', '', true);
  PERFORM set_config('app.auth_bootstrap', '0', true);
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Scope-aware legacy entry points (same signatures; layer chosen by marker).
-- ---------------------------------------------------------------------------

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
  v_local boolean := auth_r1_scope_active();
BEGIN
  IF v_local THEN
    PERFORM auth_scope_tenant_local(p_organization_id, p_user_id);
    RETURN;
  END IF;

  PERFORM set_config('app.platform_token', '', false);

  IF p_organization_id IS NULL THEN
    PERFORM set_config('app.organization_id', '', false);
    PERFORM set_config('app.user_id', coalesce(p_user_id::text, ''), false);
    PERFORM set_config('app.acting_role', '', false);
    PERFORM set_config('app.is_platform_admin', '0', false);
    PERFORM set_config('app.platform_admin_id', '', false);
    PERFORM set_config('app.tenant_token', '', false);
    PERFORM set_config('app.bypass_financial_triggers', '0', false);
    PERFORM set_config('app.public_context', '', false);
    PERFORM set_config('app.public_link_token', '', false);
    PERFORM set_config('app.public_proof', '', false);
    PERFORM set_config('app.auth_bootstrap', '0', false);
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
    PERFORM set_config('app.auth_bootstrap', '0', false);
    PERFORM set_config('app.organization_id', '', false);
    PERFORM set_config('app.user_id', '', false);
    PERFORM set_config('app.acting_role', '', false);
    PERFORM set_config('app.is_platform_admin', '0', false);
    PERFORM set_config('app.platform_admin_id', '', false);
    PERFORM set_config('app.platform_token', '', false);
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
    PERFORM set_config('app.tenant_token', '', false);
    RAISE EXCEPTION 'User % is not an active member of organization %', p_user_id, p_organization_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM set_config('app.organization_id', p_organization_id::text, false);
  PERFORM set_config('app.user_id', p_user_id::text, false);
  PERFORM set_config('app.acting_role', v_role::text, false);
  PERFORM set_config('app.is_platform_admin', '0', false);
  PERFORM set_config('app.platform_admin_id', '', false);
  PERFORM set_config('app.tenant_token', auth_tenant_token_for(p_organization_id, p_user_id), false);
  PERFORM set_config('app.bypass_financial_triggers', '0', false);
  PERFORM set_config('app.public_context', '', false);
  PERFORM set_config('app.public_link_token', '', false);
  PERFORM set_config('app.public_proof', '', false);
  PERFORM set_config('app.auth_bootstrap', '0', false);
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
DECLARE
  v_local boolean := auth_r1_scope_active();
BEGIN
  IF p_organization_id IS NULL
     AND NOT (pg_has_role(current_user, 'scolaira_owner', 'MEMBER')
              OR (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION 'set_tenant_context_for_system(NULL, NULL) is restricted to the schema owner'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.organization_id', coalesce(p_organization_id::text, ''), v_local);
  PERFORM set_config('app.user_id', coalesce(p_user_id::text, ''), v_local);
  PERFORM set_config('app.acting_role', '', v_local);
  PERFORM set_config('app.is_platform_admin',
    CASE WHEN p_organization_id IS NULL THEN '1' ELSE '0' END, v_local);
  PERFORM set_config('app.platform_admin_id',
    CASE WHEN p_organization_id IS NULL THEN coalesce(p_user_id::text, '') ELSE '' END, v_local);
  PERFORM set_config('app.platform_token', '', v_local);
  PERFORM set_config('app.auth_bootstrap', '0', v_local);
  PERFORM set_config('app.bypass_financial_triggers', '0', v_local);
  PERFORM set_config('app.tenant_token', '', v_local);
  PERFORM set_config('app.public_context', '', v_local);
  PERFORM set_config('app.public_link_token', '', v_local);
  PERFORM set_config('app.public_proof', '', v_local);
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_enter_system_context()
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_local boolean := auth_r1_scope_active();
BEGIN
  PERFORM set_tenant_context_for_system(NULL, NULL);
  -- Historical behaviour: bootstrap visibility accompanies system context.
  PERFORM set_config('app.auth_bootstrap', '1', v_local);
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
  v_local boolean := auth_r1_scope_active();
BEGIN
  IF v_local THEN
    PERFORM auth_scope_platform_local(p_user_id);
    RETURN;
  END IF;
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
    PERFORM set_config('app.tenant_token', '', false);
    RAISE EXCEPTION 'User % is not authorized for platform context', p_user_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.organization_id', '', false);
  PERFORM set_config('app.user_id', p_user_id::text, false);
  PERFORM set_config('app.acting_role', '', false);
  PERFORM set_config('app.is_platform_admin', '1', false);
  PERFORM set_config('app.platform_admin_id', p_user_id::text, false);
  PERFORM set_config('app.platform_token', auth_platform_token_for(p_user_id), false);
  PERFORM set_config('app.tenant_token', '', false);
  PERFORM set_config('app.bypass_financial_triggers', '0', false);
  PERFORM set_config('app.public_context', '', false);
  PERFORM set_config('app.public_link_token', '', false);
  PERFORM set_config('app.public_proof', '', false);
  PERFORM set_config('app.auth_bootstrap', '0', false);
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_test_system_context(p_org uuid, p_user uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_local boolean := auth_r1_scope_active();
BEGIN
  IF p_org IS NULL THEN
    PERFORM set_tenant_context_for_system(NULL, NULL);
    -- Test seeding needs bootstrap visibility so withSystemContext(NULL, NULL)
    -- can insert cross-tenant users/orgs/members. No tenant token, no valid
    -- platform_admin_id.
    PERFORM set_config('app.auth_bootstrap', '1', v_local);
    PERFORM set_config('app.platform_admin_id', '', v_local);
  ELSE
    IF v_local THEN
      PERFORM auth_scope_tenant_local(p_org, p_user);
    ELSE
      PERFORM set_tenant_context(p_org, p_user);
    END IF;
  END IF;
END;
$$;
--> statement-breakpoint

-- clear_app_context clears at the ACTIVE layer, and additionally removes any
-- session-scoped leftovers, so "clear" is effective both inside and outside a
-- scope. It now covers every variable in the R1 registry (including
-- app.public_proof and the legacy marker variables).
CREATE OR REPLACE FUNCTION clear_app_context()
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM set_config('app.organization_id', '', true);
  PERFORM set_config('app.user_id', '', true);
  PERFORM set_config('app.acting_role', '', true);
  PERFORM set_config('app.is_platform_admin', '0', true);
  PERFORM set_config('app.platform_admin_id', '', true);
  PERFORM set_config('app.platform_token', '', true);
  PERFORM set_config('app.auth_bootstrap', '0', true);
  PERFORM set_config('app.bypass_financial_triggers', '0', true);
  PERFORM set_config('app.tenant_token', '', true);
  PERFORM set_config('app.public_context', '', true);
  PERFORM set_config('app.public_link_token', '', true);
  PERFORM set_config('app.public_proof', '', true);
  PERFORM set_config('app.r1_scope_depth', '', true);

  PERFORM set_config('app.organization_id', '', false);
  PERFORM set_config('app.user_id', '', false);
  PERFORM set_config('app.acting_role', '', false);
  PERFORM set_config('app.is_platform_admin', '0', false);
  PERFORM set_config('app.platform_admin_id', '', false);
  PERFORM set_config('app.platform_token', '', false);
  PERFORM set_config('app.auth_bootstrap', '0', false);
  PERFORM set_config('app.bypass_financial_triggers', '0', false);
  PERFORM set_config('app.tenant_token', '', false);
  PERFORM set_config('app.public_context', '', false);
  PERFORM set_config('app.public_link_token', '', false);
  PERFORM set_config('app.public_proof', '', false);
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_clear_public_context()
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_local boolean := auth_r1_scope_active();
BEGIN
  PERFORM set_config('app.organization_id', '', v_local);
  PERFORM set_config('app.user_id', '', v_local);
  PERFORM set_config('app.acting_role', '', v_local);
  PERFORM set_config('app.is_platform_admin', '0', v_local);
  PERFORM set_config('app.platform_admin_id', '', v_local);
  PERFORM set_config('app.platform_token', '', v_local);
  PERFORM set_config('app.auth_bootstrap', '0', v_local);
  PERFORM set_config('app.bypass_financial_triggers', '0', v_local);
  PERFORM set_config('app.tenant_token', '', v_local);
  PERFORM set_config('app.public_context', '', v_local);
  PERFORM set_config('app.public_link_token', '', v_local);
  PERFORM set_config('app.public_proof', '', v_local);
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Grants: scope entry points are the runtime-callable surface, exactly like
-- the session-scoped originals they mirror.
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION auth_r1_scope_active() TO scolaira_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_scope_system_local() TO scolaira_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_scope_seed_local(uuid, uuid) TO scolaira_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_scope_tenant_local(uuid, uuid) TO scolaira_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_scope_platform_local(uuid) TO scolaira_app;
