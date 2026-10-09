-- M6: Public payment-link access support.
--
-- The public payment page (/p/[token]) runs as scolaira_app WITHOUT a membership.
-- It needs to:
--   1. Look up a payment_links row by token when no org context is set (bearer secret).
--   2. After resolving the link's org, set GUCs to allow reading that org's
--      organization name/address/phone and the linked invoice+student (read-only).
--   3. Insert a PENDING payment from the public form (no automatic allocation).
--
-- Two SECURITY DEFINER helpers provide entry/exit (no membership check):
--   auth_set_public_context(org_id)
--   auth_clear_public_context()
--
-- RLS additions are carefully guarded so that when app.organization_id is ''
-- (empty/unset), NO public access is granted except for the single payment_links
-- token lookup on ACTIVE links. All public-lookup policies explicitly cast to
-- uuid only after validating the GUC is non-empty, to avoid invalid-input-syntax
-- errors when the RLS test harness runs queries with no GUC set.

-- 1. Public context helpers.
CREATE OR REPLACE FUNCTION auth_set_public_context(p_org uuid)
RETURNS void AS $$
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'auth_set_public_context: org must not be null'; END IF;
  PERFORM set_config('app.organization_id', p_org::text, false);
  PERFORM set_config('app.user_id', '', false);
  PERFORM set_config('app.is_platform_admin', '0', false);
  PERFORM set_config('app.auth_bootstrap', '0', false);
  PERFORM set_config('app.bypass_financial_triggers', '0', false);
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
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_set_public_context(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_clear_public_context() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_set_public_context(uuid) TO scolaira_app;
GRANT EXECUTE ON FUNCTION auth_clear_public_context() TO scolaira_app;
--> statement-breakpoint

-- Helper: safely cast the current GUC org_id to uuid when present, else null.
CREATE OR REPLACE FUNCTION _app_current_org_uuid() RETURNS uuid AS $$
BEGIN
  IF NULLIF(current_setting('app.organization_id', true), '') IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN NULLIF(current_setting('app.organization_id', true), '')::uuid;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;
--> statement-breakpoint

-- 2. payment_links: when NO org context is set, allow SELECT of ACTIVE links by
-- token (public bearer lookup). The default tenant-isolation policy still
-- applies when an org context is set.
DROP POLICY IF EXISTS payment_links_public_token_lookup ON payment_links;
CREATE POLICY payment_links_public_token_lookup ON payment_links
  FOR SELECT
  USING (
    _app_current_org_uuid() IS NULL
    AND status = 'ACTIVE'
  );
--> statement-breakpoint

-- 3. Narrow read policies for ORGANIZATIONS / STUDENTS / INVOICES in public context.
-- These ONLY fire when app.organization_id is set to a valid uuid (i.e. after
-- auth_set_public_context has been called). They do not broaden access when
-- GUC is empty.
DROP POLICY IF EXISTS organizations_public_lookup ON organizations;
CREATE POLICY organizations_public_lookup ON organizations
  FOR SELECT
  USING (
    _app_current_org_uuid() IS NOT NULL
    AND id = _app_current_org_uuid()
  );
--> statement-breakpoint

DROP POLICY IF EXISTS students_public_lookup ON students;
CREATE POLICY students_public_lookup ON students
  FOR SELECT
  USING (
    _app_current_org_uuid() IS NOT NULL
    AND organization_id = _app_current_org_uuid()
    AND status = 'ACTIVE'
  );
--> statement-breakpoint

DROP POLICY IF EXISTS invoices_public_lookup ON invoices;
CREATE POLICY invoices_public_lookup ON invoices
  FOR SELECT
  USING (
    _app_current_org_uuid() IS NOT NULL
    AND organization_id = _app_current_org_uuid()
    AND status IN ('ISSUED','PARTIALLY_PAID','PAID')
  );
--> statement-breakpoint

-- 4. Public INSERT into payments is restricted to PENDING rows within the
-- current public-context organization. The default tenant_isolation policy
-- already enforces organization_id match via WITH CHECK; this additional
-- policy ensures inserts are rejected if status != PENDING and that a
-- missing recorded_by (unauthenticated payer) is accepted.
-- audit_events inserts are already permitted by the generic tenant policy
-- when organization_id matches; public_context sets no user_id so actor_type
-- must be 'USER' but recorded_by (on payments) is nullable.
DROP POLICY IF EXISTS payments_public_insert ON payments;
CREATE POLICY payments_public_insert ON payments
  FOR INSERT
  WITH CHECK (
    _app_current_org_uuid() IS NOT NULL
    AND organization_id = _app_current_org_uuid()
    AND status = 'PENDING'
    AND payment_number IS NOT NULL
  );
-- The trigger trg_assign_payment_number assigns payment_number from next_doc_number
-- BEFORE INSERT when it is NULL; we allow inserts with payment_number NULL by
-- also permitting NULL payment_number here so the trigger can fill it.
DROP POLICY IF EXISTS payments_public_insert2 ON payments;
CREATE POLICY payments_public_insert2 ON payments
  FOR INSERT
  WITH CHECK (
    _app_current_org_uuid() IS NOT NULL
    AND organization_id = _app_current_org_uuid()
    AND status = 'PENDING'
  );
-- (We keep BOTH as a belt-and-braces: the second is what allows payment_number NULL
-- before the trigger fires. Postgres combines WITH CHECK policies with OR.)
-- Simpler: drop the narrower one and keep only the permissive policy.
DROP POLICY IF EXISTS payments_public_insert ON payments;
--> statement-breakpoint
