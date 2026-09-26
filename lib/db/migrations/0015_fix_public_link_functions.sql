-- M6d (part 3): Fix return-type mismatches in SECURITY DEFINER helpers
-- (status is an enum, not plain text; cast to text so RETURNS TABLE matches).

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

CREATE OR REPLACE FUNCTION auth_probe_public_link(p_token text)
RETURNS text AS $$
DECLARE
  v_status text;
  v_expires timestamptz;
BEGIN
  SELECT pl.status::text, pl.expires_at INTO v_status, v_expires
    FROM payment_links pl WHERE pl.token = p_token LIMIT 1;
  IF NOT FOUND THEN RETURN 'MISSING'; END IF;
  IF v_status <> 'ACTIVE' THEN RETURN 'REVOKED'; END IF;
  IF v_expires IS NOT NULL AND v_expires < now() THEN RETURN 'EXPIRED'; END IF;
  RETURN 'ACTIVE';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;
