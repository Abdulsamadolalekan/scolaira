-- M6d (part 6): auth_probe_public_link also needs to set app.public_link_token
-- GUC internally so it can read the target row under RLS (same reason as
-- auth_resolve_public_link — function owner does not have BYPASSRLS).

CREATE OR REPLACE FUNCTION auth_probe_public_link(p_token text)
RETURNS text AS $$
DECLARE
  v_status text;
  v_expires timestamptz;
BEGIN
  PERFORM set_config('app.public_link_token', p_token, true);
  SELECT pl.status::text, pl.expires_at INTO v_status, v_expires
    FROM payment_links pl WHERE pl.token = p_token LIMIT 1;
  PERFORM set_config('app.public_link_token', '', true);
  IF NOT FOUND THEN RETURN 'MISSING'; END IF;
  IF v_status <> 'ACTIVE' THEN RETURN 'REVOKED'; END IF;
  IF v_expires IS NOT NULL AND v_expires < now() THEN RETURN 'EXPIRED'; END IF;
  RETURN 'ACTIVE';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;
