-- R1 (C-3) — a public payment-link bearer is NOT a tenant identity.
--
-- FINDING (found by the R1 adversarial suite `tests/db/r1-public-context.test.ts`)
--
--   In public (payment-link) context, `auth_is_tenant_authorized()` returned
--   TRUE. Because every legacy `*_tenant_isolation` policy is an `ALL` policy
--   of the form
--
--       auth_is_platform_admin_authorized()
--     OR (auth_is_tenant_authorized() AND organization_id = app.organization_id)
--
--   a holder of ONE valid payment-link token satisfied the tenant branch and
--   therefore obtained full row access — SELECT, INSERT, UPDATE and DELETE — to
--   every tenant-scoped table of that organization: invoices, invoice_lines,
--   students, payments, payment_allocations, receipts, guardians, waivers,
--   fee_assignments, fee_definitions, terms, classes, academic_sessions,
--   audit_events, payment_links, reminders, ...
--
--   Measured before this migration (runtime role, public scope, one legitimate
--   token, no session):
--       UPDATE invoices SET paid_kobo = paid_kobo … RETURNING id   -> 1 row
--       UPDATE students  SET last_name = last_name … RETURNING id  -> 1 row
--       INSERT INTO payments (… status='CONFIRMED' …)              -> accepted
--
--   ROOT CAUSE (historical, migration 0013)
--     `auth_is_tenant_authorized()` was extended to `RETURN true` whenever the
--     public marker was set and an organization was present, so that the
--     public read policies of the time could read through the tenant policy.
--     Migration 0040 (R1) correctly bound the *marker* to a bearer proof, but
--     kept this "public context is a tenant" shortcut, which is what made one
--     stolen/leaked link token equivalent to full tenant membership.
--
--   WHY IT IS SAFE TO REMOVE THE SHORTCUT
--     Nothing else depends on it. The public surface is authorized by its own
--     proof-gated policies (`*_public_lookup`, `payments_public_insert`)
--     against `auth_is_public_context_authorized()`, by `payment_links_public_
--     token_lookup`, and by the SECURITY DEFINER resolvers. No application
--     code, trigger or function in the schema consults
--     `auth_is_tenant_authorized()` for public traffic.
--
-- SECOND FINDING FIXED HERE
--     `audit_events_public_insert` checked only `app.organization_id` and no
--     credential at all, so ANY connection able to set that GUC could insert
--     audit rows attributed to that organization. It now additionally requires
--     `auth_is_public_context_authorized()` (i.e. the bearer proof), which is
--     exactly what the public submit route legitimately satisfies.
--
-- This migration does not touch tables, constraints, triggers, financial
-- state, or any authorization predicate other than the two objects below.

-- ---------------------------------------------------------------------------
-- 1. Public context is anonymous bearer authorization — never tenant membership.
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
  -- R1 (C-3): public (payment-link) context is NOT tenant context. It must
  -- never satisfy a tenant policy; it is authorized exclusively by the
  -- proof-gated public policies. Returning true here previously handed a
  -- single link token the full privileges of the organization.
  IF NULLIF(current_setting('app.public_context', true), '') = '1' THEN
    RETURN false;
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
-- 2. The public audit trail insert requires the bearer proof too.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS audit_events_public_insert ON audit_events;
--> statement-breakpoint
CREATE POLICY audit_events_public_insert ON audit_events
  FOR INSERT
  WITH CHECK (
    auth_is_public_context_authorized()
    AND _app_current_org_uuid() IS NOT NULL
    AND organization_id = _app_current_org_uuid()
  );
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Self-audit: the shortcut must be gone, and the public audit path must
--    require a credential.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_tenant_src text;
  v_public_check text;
BEGIN
  SELECT prosrc INTO v_tenant_src FROM pg_proc WHERE proname = 'auth_is_tenant_authorized';
  IF v_tenant_src IS NULL THEN
    RAISE EXCEPTION '[R1/C-3] auth_is_tenant_authorized() is missing';
  END IF;
  IF position('public_context' in v_tenant_src) <> 0
     AND position('RETURN false' in v_tenant_src) = 0 THEN
    RAISE EXCEPTION '[R1/C-3] public context must not authorize tenant access';
  END IF;

  SELECT coalesce(with_check, qual) INTO v_public_check
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'audit_events'
     AND policyname = 'audit_events_public_insert';
  IF v_public_check IS NULL OR position('auth_is_public_context_authorized' in v_public_check) = 0 THEN
    RAISE EXCEPTION '[R1/C-3] audit_events_public_insert must require the public bearer proof';
  END IF;

  RAISE NOTICE '[R1/C-3] verified: public context is not tenant context; public audit insert is proof-gated';
END $$;
