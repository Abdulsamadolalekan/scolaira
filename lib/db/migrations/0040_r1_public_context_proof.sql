-- R1 (C-3) — public context must be BEARER-AUTHORIZED.
--
-- BEFORE (proved against a disposable database with the runtime principal):
--
--   SELECT auth_set_public_context('<any organization uuid>');   -- no token at all
--   SELECT count(*) FROM invoices;                                -- returns that org's rows
--
--   Two independent defects produced a complete cross-tenant RLS bypass:
--
--     1. auth_is_tenant_authorized() (migration 0013) returned true whenever
--        app.public_context = '1' AND app.organization_id was set. The marker
--        was self-asserted: nothing tied it to a bearer credential.
--     2. auth_set_public_context(uuid) — SECURITY DEFINER, EXECUTE granted to
--        scolaira_app — accepted a caller-supplied organization id and set the
--        marker for it. The runtime role could therefore mint public authority
--        for ANY tenant with a single statement.
--
--   The narrow read/insert policies added in 0011/0014
--   (organizations_public_lookup, students_public_lookup,
--   invoices_public_lookup, payments_public_insert) had the same shape: they
--   trusted `app.organization_id` alone, so a raw
--   `set_config('app.organization_id', …)` was sufficient.
--
-- AFTER
--
--   Public authority is derived from, and bound to, the bearer token:
--
--     token → auth_scope_public_local(token)  (SECURITY DEFINER)
--               • resolves the link itself (ACTIVE + not expired);
--               • sets app.organization_id from the LINK ROW, never from the
--                 caller;
--               • sets app.public_link_token to that token;
--               • mints app.public_proof = HMAC('public|token|org|backend_pid')
--                 with the server-side secret the runtime role cannot read.
--
--     authorization → auth_is_tenant_authorized() / auth_is_public_context_authorized()
--               recompute the proof and compare. A forged marker, a forged
--               organization id, a token from a different organization, or a
--               proof replayed on another connection all fail.
--
--   The arbitrary-organization entry points are revoked from the runtime role.
--
--   Scope of the proof: one request, one transaction, one backend. Revocation
--   and expiry are checked when the scope is established (the link is resolved
--   every time) — a public scope cannot be established for a revoked or
--   expired link, and cannot be extended beyond the transaction that created
--   it.

-- ---------------------------------------------------------------------------
-- 1. Proof minting (never executable by the runtime role)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_public_proof_for(p_token text, p_org uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_secret text;
  v_pid int;
BEGIN
  IF p_token IS NULL OR p_org IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT v INTO v_secret FROM app_meta WHERE k = 'tenant_ctx_secret';
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'tenant_ctx_secret not initialized';
  END IF;
  v_pid := pg_backend_pid();
  RETURN encode(
    hmac('public|' || p_token || '|' || p_org::text || '|' || v_pid::text, v_secret, 'sha256'),
    'hex'
  );
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_public_proof_for(text, uuid) FROM PUBLIC, scolaira_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Public authorization predicate — used by policies and readable by tests
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_is_public_context_authorized()
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_marker text;
  v_org    uuid;
  v_link   text;
  v_proof  text;
  v_user   text;
BEGIN
  v_marker := NULLIF(current_setting('app.public_context', true), '');
  IF v_marker IS DISTINCT FROM '1' THEN
    RETURN false;
  END IF;
  v_org   := NULLIF(current_setting('app.organization_id', true), '')::uuid;
  v_link  := NULLIF(current_setting('app.public_link_token', true), '');
  v_proof := NULLIF(current_setting('app.public_proof', true), '');
  v_user  := NULLIF(current_setting('app.user_id', true), '');
  -- Public context is anonymous by definition.
  IF v_org IS NULL OR v_link IS NULL OR v_proof IS NULL OR v_user IS NOT NULL THEN
    RETURN false;
  END IF;
  -- The proof is bound to (token, org, backend) and can only be minted by the
  -- SECURITY DEFINER above, which is not executable by the runtime role.
  RETURN v_proof IS NOT DISTINCT FROM auth_public_proof_for(v_link, v_org);
END;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_is_public_context_authorized() TO scolaira_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. The single sanctioned entry point: resolve the token, then establish
--    public context from the LINK ROW (transaction-local).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_scope_public_local(p_token text)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org uuid;
BEGIN
  IF NOT auth_r1_scope_active() THEN
    RAISE EXCEPTION 'auth_scope_public_local() is transaction-local by contract and must be called inside a SCOLAIRA scope (lib/db/scope.ts)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_token IS NULL OR length(p_token) = 0 THEN
    RAISE EXCEPTION 'auth_scope_public_local: token must not be empty'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Whitelist ONLY this token for the duration of the transaction so the
  -- payment_links policy (token = app.public_link_token AND no organization
  -- context) can return at most the row this bearer token identifies. The
  -- organization is read from that row — there is no parameter through which a
  -- caller can name a tenant.
  PERFORM set_config('app.public_link_token', p_token, true);
  SELECT pl.organization_id INTO v_org
    FROM payment_links pl
   WHERE pl.token = p_token
     AND pl.status = 'ACTIVE'
     AND (pl.expires_at IS NULL OR pl.expires_at > now())
   LIMIT 1;

  IF v_org IS NULL THEN
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
    PERFORM set_config('app.auth_bootstrap', '0', true);
    -- SQLSTATE 28000 (invalid_authorization_specification) is reserved for
    -- "this bearer token does not authorize anything", so callers can tell it
    -- apart from an RLS denial or any other database error.
    RAISE EXCEPTION 'payment link is not active or has expired'
      USING ERRCODE = '28000';
  END IF;

  PERFORM set_config('app.organization_id', v_org::text, true);
  PERFORM set_config('app.user_id', '', true);
  PERFORM set_config('app.acting_role', '', true);
  PERFORM set_config('app.is_platform_admin', '0', true);
  PERFORM set_config('app.platform_admin_id', '', true);
  PERFORM set_config('app.platform_token', '', true);
  PERFORM set_config('app.tenant_token', '', true);
  PERFORM set_config('app.bypass_financial_triggers', '0', true);
  PERFORM set_config('app.public_context', '1', true);
  PERFORM set_config('app.public_link_token', p_token, true);
  PERFORM set_config('app.public_proof', auth_public_proof_for(p_token, v_org), true);
  PERFORM set_config('app.auth_bootstrap', '0', true);
  RETURN v_org;
END;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_scope_public_local(text) TO scolaira_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Revoke the self-asserted entry points from the runtime role.
--    (Owner keeps them for maintenance; the runtime role — the thing an
--    attacker controls — loses them.)
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION auth_set_public_context(uuid) FROM PUBLIC, scolaira_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_set_public_link_token(text) FROM PUBLIC, scolaira_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Tenant authorization: the public branch now requires a valid proof.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_is_tenant_authorized()
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org    uuid;
  v_user   uuid;
  v_tok    text;
  v_expect text;
BEGIN
  -- Public (payment-link) context: bearer-authorized, never self-asserted.
  IF NULLIF(current_setting('app.public_context', true), '') = '1' THEN
    IF NOT auth_is_public_context_authorized() THEN
      RETURN false;
    END IF;
    v_org := NULLIF(current_setting('app.organization_id', true), '')::uuid;
    RETURN v_org IS NOT NULL;
  END IF;

  -- Authenticated tenant context: HMAC token bound to (org, user, backend).
  v_org  := NULLIF(current_setting('app.organization_id', true), '')::uuid;
  v_user := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v_tok  := NULLIF(current_setting('app.tenant_token', true), '');
  IF v_org IS NULL OR v_user IS NULL OR v_tok IS NULL THEN RETURN false; END IF;
  v_expect := auth_tenant_token_for(v_org, v_user);
  RETURN v_tok IS NOT DISTINCT FROM v_expect;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. Public read/insert policies: proof-bound instead of GUC-trusting.
--    Each of these previously granted access on the strength of
--    app.organization_id alone.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS organizations_public_lookup ON organizations;
CREATE POLICY organizations_public_lookup ON organizations
  FOR SELECT
  USING (
    auth_is_public_context_authorized()
    AND id = _app_current_org_uuid()
  );
--> statement-breakpoint

DROP POLICY IF EXISTS students_public_lookup ON students;
CREATE POLICY students_public_lookup ON students
  FOR SELECT
  USING (
    auth_is_public_context_authorized()
    AND organization_id = _app_current_org_uuid()
    AND status = 'ACTIVE'
  );
--> statement-breakpoint

DROP POLICY IF EXISTS invoices_public_lookup ON invoices;
CREATE POLICY invoices_public_lookup ON invoices
  FOR SELECT
  USING (
    auth_is_public_context_authorized()
    AND organization_id = _app_current_org_uuid()
    AND status IN ('ISSUED','PARTIALLY_PAID','PAID')
  );
--> statement-breakpoint

DROP POLICY IF EXISTS payments_public_insert ON payments;
CREATE POLICY payments_public_insert ON payments
  FOR INSERT
  WITH CHECK (
    auth_is_public_context_authorized()
    AND organization_id = _app_current_org_uuid()
    AND status = 'PENDING'
    AND payment_number IS NOT NULL
  );
--> statement-breakpoint

DROP POLICY IF EXISTS payments_public_insert2 ON payments;
CREATE POLICY payments_public_insert2 ON payments
  FOR INSERT
  WITH CHECK (
    auth_is_public_context_authorized()
    AND organization_id = _app_current_org_uuid()
    AND status = 'PENDING'
  );
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. The token-lookup policy on payment_links is kept (it IS the bearer
--    credential), but the link-token marker is now only settable by the
--    SECURITY DEFINER resolvers, transaction-locally, and additionally
--    requires that no organization context is active. Confirm the marker
--    helper is not runtime-callable.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION auth_set_public_link_token(text) FROM PUBLIC, scolaira_app;
