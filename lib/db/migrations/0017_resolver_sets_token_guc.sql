-- M6d (part 5): SECURITY DEFINER resolver must set app.public_link_token GUC
-- BEFORE querying payment_links so that the tenant_isolation and
-- payment_links_public_token_lookup policies permit the single-row lookup.
-- The function owner (scolaira_app) does NOT have BYPASSRLS, so even inside
-- a SECURITY DEFINER body RLS still applies.

CREATE OR REPLACE FUNCTION auth_resolve_public_link(p_token text)
RETURNS TABLE(organization_id uuid, id uuid, token text, status text,
              invoice_id uuid, student_id uuid, amount_kobo bigint,
              note text, expires_at timestamptz) AS $$
BEGIN
  -- Whitelist ONLY the supplied token for the duration of this function.
  PERFORM set_config('app.public_link_token', p_token, true);
  RETURN QUERY
    SELECT pl.organization_id, pl.id, pl.token::text, pl.status::text, pl.invoice_id,
           pl.student_id, pl.amount_kobo, pl.note, pl.expires_at
    FROM payment_links pl
    WHERE pl.token = p_token
      AND pl.status = 'ACTIVE'
      AND (pl.expires_at IS NULL OR pl.expires_at > now());
  PERFORM set_config('app.public_link_token', '', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;
