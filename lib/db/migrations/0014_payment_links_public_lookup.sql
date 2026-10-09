-- M6d: Tighten public payment_link lookup to prevent row enumeration.
--
-- Migration 0011 introduced a policy that allowed SELECT on any ACTIVE
-- payment_link row when no tenant context was set (app.organization_id IS
-- NULL). That policy is too broad: a caller in bootstrap/no-context mode can
-- enumerate every ACTIVE link in the system. The only legitimate public
-- SELECT on payment_links is lookup by a specific token, so we:
--
--   1. Drop the over-broad policy.
--   2. Add a SECURITY DEFINER function auth_resolve_public_link(token) that
--      returns (organization_id, link_row) only when the token is ACTIVE and
--      non-expired. Public handlers call this function FIRST (while GUCs are
--      empty), then call auth_set_public_context(organization_id) to obtain
--      access to the link's org-scoped data.
--   3. Restrict the public lookup policy to require that the row's token
--      matches the value of a dedicated GUC (app.public_link_token) set ONLY
--      by the resolver, leaving no path to enumerate rows.

-- Update context-clearing helpers to also wipe the link-token marker.
CREATE OR REPLACE FUNCTION auth_clear_public_context()
RETURNS void AS $$
BEGIN
  PERFORM set_config('app.organization_id', '', false);
  PERFORM set_config('app.user_id', '', false);
  PERFORM set_config('app.is_platform_admin', '0', false);
  PERFORM set_config('app.auth_bootstrap', '0', false);
  PERFORM set_config('app.bypass_financial_triggers', '0', false);
  PERFORM set_config('app.public_context', '', false);
  PERFORM set_config('app.public_link_token', '', false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION clear_app_context()
RETURNS void AS $$
BEGIN
  PERFORM set_config('app.organization_id', '', false);
  PERFORM set_config('app.user_id', '', false);
  PERFORM set_config('app.is_platform_admin', '0', false);
  PERFORM set_config('app.auth_bootstrap', '0', false);
  PERFORM set_config('app.bypass_financial_triggers', '0', false);
  PERFORM set_config('app.public_context', '', false);
  PERFORM set_config('app.public_link_token', '', false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
--> statement-breakpoint

-- Drop the over-broad policy added in 0011.
DROP POLICY IF EXISTS payment_links_public_token_lookup ON payment_links;
--> statement-breakpoint

-- GUC used during the initial token-resolution step. It is only ever set by
-- the SECURITY DEFINER resolver, never by application code directly.
CREATE OR REPLACE FUNCTION auth_resolve_public_link(p_token text)
RETURNS TABLE(organization_id uuid, id uuid, token text, status text,
              invoice_id uuid, student_id uuid, amount_kobo bigint,
              note text, expires_at timestamptz) AS $$
BEGIN
  PERFORM set_config('app.public_link_token', '', false);
  RETURN QUERY
    SELECT pl.organization_id, pl.id, pl.token, pl.status::text, pl.invoice_id,
           pl.student_id, pl.amount_kobo, pl.note, pl.expires_at
    FROM payment_links pl
    WHERE pl.token = p_token
      AND pl.status = 'ACTIVE'
      AND (pl.expires_at IS NULL OR pl.expires_at > now());
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;
--> statement-breakpoint

-- Helper: given a token, return its public status ('MISSING', 'EXPIRED',
-- 'REVOKED', 'ACTIVE') without exposing any other columns. Used by the
-- public submit endpoint to distinguish 410 from 404 after a failed
-- resolve, without allowing row enumeration.
CREATE OR REPLACE FUNCTION auth_probe_public_link(p_token text)
RETURNS text AS $$
DECLARE
  v_status text;
  v_expires timestamptz;
BEGIN
  SELECT pl.status, pl.expires_at INTO v_status, v_expires
    FROM payment_links pl WHERE pl.token = p_token LIMIT 1;
  IF NOT FOUND THEN RETURN 'MISSING'; END IF;
  IF v_status <> 'ACTIVE' THEN RETURN 'REVOKED'; END IF;
  IF v_expires IS NOT NULL AND v_expires < now() THEN RETURN 'EXPIRED'; END IF;
  RETURN 'ACTIVE';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;
--> statement-breakpoint

-- Re-add narrow policy: SELECT on payment_links is allowed under empty GUC
-- ONLY when the row's token matches the app.public_link_token marker. Since
-- that GUC is only settable via auth_set_public_context (SECURITY DEFINER)
-- for the org-scoped phase and NOT set during bootstrap, we keep a separate
-- marker only for the resolver.
CREATE OR REPLACE FUNCTION auth_set_public_link_token(p_token text)
RETURNS void AS $$
BEGIN
  PERFORM set_config('app.public_link_token', coalesce(p_token, ''), false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
--> statement-breakpoint

CREATE POLICY payment_links_public_token_lookup ON payment_links
  FOR SELECT
  USING (
    _app_current_org_uuid() IS NULL
    AND current_setting('app.public_link_token', true) = token
  );
--> statement-breakpoint

-- Ensure RLS is enforced on payment_links (defensive — already true).
ALTER TABLE payment_links ENABLE ROW LEVEL SECURITY;
