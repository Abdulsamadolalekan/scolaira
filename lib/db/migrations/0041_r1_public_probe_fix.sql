-- R1 (C-3) — public-link bearer resolution: correctness of the status probe
-- and defensible failure classification.
--
-- FINDING (found by the R1 adversarial suite `tests/db/r1-public-context.test.ts`,
-- not by inspection)
--
--   `auth_probe_public_link(p_token)` returned 'ACTIVE' for tokens that do not
--   exist:
--
--       SELECT auth_probe_public_link('no-such-token-000');   -- 'ACTIVE'
--
--   Root cause: the function read the link row with `SELECT ... INTO`, then
--   cleared the `app.public_link_token` GUC with a further `PERFORM set_config`
--   and only afterwards consulted `FOUND`. Under the PG >= 11 definition used
--   by this repository, `FOUND` reflects the most recent SQL statement — the
--   later `PERFORM set_config(...)` succeeds and therefore reports a row, so
--   the "not found" branch was unreachable. The function's contract ("MISSING"
--   for an unknown bearer) was silently false.
--
--   Impact: the probe is a status oracle for the public surface. It never
--   granted authorization (it is not part of any authorization predicate), and
--   the public routes stayed fail-closed because they only distinguish
--   EXPIRED → 410 from everything else → 404. But a security oracle that
--   misreports "this link is live" for an arbitrary string is a defect in the
--   C-3 boundary and had to be fixed, not documented away.
--
--   Secondary findings fixed here for the same boundary:
--     * `auth_probe_public_link` / `auth_resolve_public_link` overwrote
--       `app.public_link_token` with '' on the way out, discarding a value that
--       an enclosing public scope had legitimately set. Both now save and
--       restore the previous value.
--     * `auth_scope_public_local(NULL | '')` raised
--       insufficient_privilege (42501). "This bearer does not authorize
--       anything" is exactly the condition the environment already reserves
--       28000 for, so an absent/empty token now fails closed with the SAME
--       SQLSTATE as a revoked or expired one.
--     * The three functions gain an explicit
--       `SET search_path = pg_catalog, public` (SECURITY DEFINER hardening,
--       matching migrations 0034/0038/0039/0040). Behaviour is otherwise
--       unchanged: no signature, no return type, no grant changes.
--
-- This migration only replaces function bodies. It does not touch tables, RLS
-- policies, triggers, grants, or any financial state.

-- ---------------------------------------------------------------------------
-- 1. Status probe: report the truth, and leave the GUC as it found it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth_probe_public_link(p_token text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_status    text;
  v_expires   timestamptz;
  v_prev      text;
  v_row_found boolean;
BEGIN
  IF p_token IS NULL OR length(p_token) = 0 THEN
    RETURN 'MISSING';
  END IF;

  -- Whitelist this ONE token so the payment_links policy (token =
  -- app.public_link_token, no organization context) can expose the row, then
  -- restore whatever the caller had — a probe must not clobber an enclosing
  -- public scope's whitelist.
  v_prev := current_setting('app.public_link_token', true);
  PERFORM set_config('app.public_link_token', p_token, true);

  SELECT pl.status::text, pl.expires_at INTO v_status, v_expires
    FROM payment_links pl
   WHERE pl.token = p_token
   LIMIT 1;

  -- Read FOUND immediately: any later statement would redefine it.
  v_row_found := FOUND;

  PERFORM set_config('app.public_link_token', coalesce(v_prev, ''), true);

  IF NOT v_row_found THEN
    RETURN 'MISSING';
  END IF;
  IF v_status IS DISTINCT FROM 'ACTIVE' THEN
    RETURN 'REVOKED';
  END IF;
  IF v_expires IS NOT NULL AND v_expires <= now() THEN
    RETURN 'EXPIRED';
  END IF;
  RETURN 'ACTIVE';
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Bearer resolution: identical semantics, GUC-restoring and search_path
--    hardened. Signature and return type are unchanged.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth_resolve_public_link(p_token text)
RETURNS TABLE (
  organization_id uuid,
  id              uuid,
  token           text,
  status          text,
  invoice_id      uuid,
  student_id      uuid,
  amount_kobo     bigint,
  note            text,
  expires_at      timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_prev text;
BEGIN
  IF p_token IS NULL OR length(p_token) = 0 THEN
    RETURN;
  END IF;

  v_prev := current_setting('app.public_link_token', true);
  PERFORM set_config('app.public_link_token', p_token, true);

  RETURN QUERY
    SELECT pl.organization_id, pl.id, pl.token::text, pl.status::text, pl.invoice_id,
           pl.student_id, pl.amount_kobo, pl.note, pl.expires_at
      FROM payment_links pl
     WHERE pl.token = p_token
       AND pl.status = 'ACTIVE'
       AND (pl.expires_at IS NULL OR pl.expires_at > now());

  PERFORM set_config('app.public_link_token', coalesce(v_prev, ''), true);
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Public scope entry point: an absent bearer fails closed in the same class
--    as a revoked or expired one (28000), not as a privilege error.
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
    -- Same class as an unusable link: this bearer authorizes nothing.
    RAISE EXCEPTION 'auth_scope_public_local: token must not be empty'
      USING ERRCODE = '28000';
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
  PERFORM set_config('app.public_proof', auth_public_proof_for(p_token, v_org), true);
  RETURN v_org;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Self-audit: the probe must lie about nothing.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF auth_probe_public_link('r1-self-audit-nonexistent-' || gen_random_uuid()::text) <> 'MISSING' THEN
    RAISE EXCEPTION '[R1/C-3] auth_probe_public_link must report MISSING for an unknown token';
  END IF;
  IF auth_probe_public_link(NULL) <> 'MISSING' OR auth_probe_public_link('') <> 'MISSING' THEN
    RAISE EXCEPTION '[R1/C-3] auth_probe_public_link must report MISSING for an absent token';
  END IF;
  RAISE NOTICE '[R1/C-3] public-link probe verified: unknown/absent token -> MISSING';
END $$;
