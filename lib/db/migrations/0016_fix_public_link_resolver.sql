-- M6d (part 4): Cast varchar token column to text to match RETURNS TABLE.

CREATE OR REPLACE FUNCTION auth_resolve_public_link(p_token text)
RETURNS TABLE(organization_id uuid, id uuid, token text, status text,
              invoice_id uuid, student_id uuid, amount_kobo bigint,
              note text, expires_at timestamptz) AS $$
BEGIN
  PERFORM set_config('app.public_link_token', '', false);
  RETURN QUERY
    SELECT pl.organization_id, pl.id, pl.token::text, pl.status::text, pl.invoice_id,
           pl.student_id, pl.amount_kobo, pl.note, pl.expires_at
    FROM payment_links pl
    WHERE pl.token = p_token
      AND pl.status = 'ACTIVE'
      AND (pl.expires_at IS NULL OR pl.expires_at > now());
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;
