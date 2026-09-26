-- R1 (C-3) — the public teller submission gets an explicit, credential-gated
-- database entry point (and loses its direct table-write privileges).
--
-- WHY THIS MIGRATION EXISTS
--
--   Migration 0042 stopped public context from being treated as tenant context.
--   That is correct — but it exposed a real coupling: the public submit route
--   performed
--
--       INSERT INTO payments (…) VALUES (…) RETURNING id, payment_number, …
--
--   and under row-level security an INSERT … RETURNING additionally requires
--   the inserted row to be visible under the table's SELECT policies. A public
--   bearer has no SELECT policy on `payments` (correctly — a link must not be
--   able to enumerate other parents' submissions), so the legitimate public
--   submission started failing with 42501 while the direct `INSERT` without
--   RETURNING still worked.
--
--   Before 0042 the route only "worked" because public context implicitly
--   satisfied the tenant SELECT policy — i.e. the very over-authorization 0042
--   removed. The route's read-back was therefore never actually authorized.
--
-- REMEDIATION
--
--   The public mutation moves into one SECURITY DEFINER function that:
--     * accepts the BEARER TOKEN as its authority (no organization, no user,
--       no context parameter — nothing self-asserted);
--     * resolves the link itself, under the token whitelist policy, on a
--       neutral identity state, and fails closed with SQLSTATE 28000 when the
--       link is missing, revoked or expired;
--     * validates the linked invoice belongs to the link's organization and is
--       in a payable state;
--     * mints the R1 public proof for (token, organization, backend) and then
--       inserts the PENDING payment plus its audit row through the SAME
--       proof-gated policies that already guarded the public surface — the
--       function does not bypass RLS, it satisfies it;
--     * returns the generated id/number/amount/status explicitly, so no
--       `RETURNING` (and therefore no SELECT visibility) is needed;
--     * restores the caller's context variables on both the success and the
--       error path.
--
--   Net effect: PUBLIC CONTEXT NOW HAS NO DIRECT WRITE PRIVILEGE TO ANY TABLE.
--   The only unauthenticated mutation in the product is a single auditable
--   call whose authority is the bearer token itself. The proof stays bound to
--   (token, organization, backend) and expires with the transaction.
--
-- PRIVILEGE TIGHTENING IN THE SAME MIGRATION
--
--   `next_doc_number(text)` was executable by PUBLIC and by the runtime role,
--   although only owner-side SECURITY DEFINER triggers call it. It is a write
--   to a shared per-organization counter, so leaving it callable let the
--   runtime role inflate document numbering. EXECUTE is revoked from PUBLIC and
--   from scolaira_app; the SECURITY DEFINER triggers keep working because they
--   run with the owner's privileges.
--
-- Nothing in this migration changes financial truth, ledger semantics,
-- reconciliation, collections, existing triggers, or any existing policy's
-- meaning: it adds one function, tightens one EXECUTE grant, and leaves every
-- `*_public_*` policy in force as defence in depth.

-- ---------------------------------------------------------------------------
-- 1. Credential-gated public submission entry point.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth_public_submit_payment(
  p_token       text,
  p_amount_kobo bigint,
  p_reference   text,
  p_payer_name  text,
  p_payer_phone text DEFAULT NULL,
  p_payer_email text DEFAULT NULL
)
RETURNS TABLE (
  payment_id     uuid,
  payment_number text,
  amount_kobo    bigint,
  status         text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org          uuid;
  v_invoice      uuid;
  v_student      uuid;
  v_link_amount  bigint;
  v_payment_id   uuid;
  v_number       text;
  v_prev_link    text;
  v_prev_org     text;
  v_prev_ctx     text;
  v_prev_proof   text;
  v_prev_user    text;
  v_prev_boot    text;
  v_prev_bypass  text;
BEGIN
  -- --- caller-independent input validation -------------------------------
  IF p_token IS NULL OR length(p_token) = 0 THEN
    RAISE EXCEPTION 'payment link is not active or has expired' USING ERRCODE = '28000';
  END IF;
  IF p_amount_kobo IS NULL OR p_amount_kobo <= 0 THEN
    RAISE EXCEPTION 'submission amount must be positive' USING ERRCODE = 'check_violation';
  END IF;
  IF p_reference IS NULL OR btrim(p_reference) = '' THEN
    RAISE EXCEPTION 'submission reference must not be empty' USING ERRCODE = 'check_violation';
  END IF;
  IF p_payer_name IS NULL OR btrim(p_payer_name) = '' THEN
    RAISE EXCEPTION 'submission payer name must not be empty' USING ERRCODE = 'check_violation';
  END IF;

  -- --- capture the caller's identity variables ---------------------------
  v_prev_link   := current_setting('app.public_link_token', true);
  v_prev_org    := current_setting('app.organization_id', true);
  v_prev_ctx    := current_setting('app.public_context', true);
  v_prev_proof  := current_setting('app.public_proof', true);
  v_prev_user   := current_setting('app.user_id', true);
  v_prev_boot   := current_setting('app.auth_bootstrap', true);
  v_prev_bypass := current_setting('app.bypass_financial_triggers', true);

  BEGIN
    -- --- 1. resolve the bearer on a NEUTRAL identity state ---------------
    -- The link lookup policy is `_app_current_org_uuid() IS NULL AND token =
    -- app.public_link_token`, so any ambient organization must be cleared
    -- first: an ambient value must not be able to steer this lookup.
    PERFORM set_config('app.organization_id', '', true);
    PERFORM set_config('app.public_context', '', true);
    PERFORM set_config('app.public_proof', '', true);
    PERFORM set_config('app.user_id', '', true);
    PERFORM set_config('app.auth_bootstrap', '', true);
    PERFORM set_config('app.bypass_financial_triggers', '', true);
    PERFORM set_config('app.public_link_token', p_token, true);

    SELECT pl.organization_id, pl.invoice_id, pl.student_id, pl.amount_kobo
      INTO v_org, v_invoice, v_student, v_link_amount
      FROM payment_links pl
     WHERE pl.token = p_token
       AND pl.status = 'ACTIVE'
       AND (pl.expires_at IS NULL OR pl.expires_at > now())
     LIMIT 1;

    IF v_org IS NULL THEN
      RAISE EXCEPTION 'payment link is not active or has expired' USING ERRCODE = '28000';
    END IF;

    -- --- 2. adopt the public context derived from the LINK --------------
    -- Same shape the R1 runtime uses: organization from the link row, an
    -- anonymous identity, and a proof bound to (token, organization, backend).
    -- The INSERTs below are authorized by the existing proof-gated public
    -- policies — the function satisfies RLS, it does not bypass it.
    PERFORM set_config('app.organization_id', v_org::text, true);
    PERFORM set_config('app.public_link_token', p_token, true);
    PERFORM set_config('app.public_context', '1', true);
    PERFORM set_config('app.public_proof', auth_public_proof_for(p_token, v_org), true);
    PERFORM set_config('app.acting_role', '', true);
    PERFORM set_config('app.is_platform_admin', '0', true);
    PERFORM set_config('app.platform_admin_id', '', true);
    PERFORM set_config('app.platform_token', '', true);
    PERFORM set_config('app.tenant_token', '', true);

    -- --- 3b. the linked invoice must belong to the LINK's organization ----
    -- Checked here, under the context just adopted: the invoices table is row
    -- secured, so the row is only visible because the bearer token authorized
    -- this exact organization. A link pointing at another tenant's invoice
    -- therefore fails as "not payable" without ever naming that tenant.
    IF v_invoice IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM invoices i
         WHERE i.id = v_invoice
           AND i.organization_id = v_org
           AND i.status IN ('ISSUED', 'PARTIALLY_PAID', 'PAID')
      ) THEN
        RAISE EXCEPTION 'payment link invoice is not payable' USING ERRCODE = 'check_violation';
      END IF;
    END IF;

    -- --- 4. record the pending payment ----------------------------------
    -- The identifier and the document number are produced here so that the
    -- result can be returned WITHOUT a RETURNING clause: under row security a
    -- RETURNING row must also be visible to SELECT, which public context
    -- deliberately is not.
    v_payment_id := gen_random_uuid();
    v_number     := next_doc_number('PMT');

    INSERT INTO payments (
      id, organization_id, payment_number, method, status,
      amount_kobo, unallocated_kobo,
      reference, payer_name, payer_phone, payer_email, notes
    ) VALUES (
      v_payment_id, v_org, v_number, 'BANK_TRANSFER', 'PENDING',
      p_amount_kobo, 0,
      btrim(p_reference),
      btrim(p_payer_name),
      NULLIF(btrim(coalesce(p_payer_phone, '')), ''),
      NULLIF(btrim(coalesce(p_payer_email, '')), ''),
      'Submitted via payment link ' || p_token
    );

    INSERT INTO audit_events (
      organization_id, actor_type, action, entity_type, entity_id, after, metadata, request_id
    ) VALUES (
      v_org, 'USER'::audit_actor_type, 'payment.pending', 'payment', v_payment_id,
      jsonb_build_object(
        'paymentNumber', v_number,
        'amountKobo', p_amount_kobo,
        'channel', 'payment_link'
      ),
      jsonb_build_object('linkToken', p_token, 'invoiceId', v_invoice),
      NULL
    );

    RETURN QUERY SELECT v_payment_id, v_number, p_amount_kobo, 'PENDING'::text;
  EXCEPTION WHEN OTHERS THEN
    -- Restore the caller's context before propagating, so a rejected
    -- submission leaves the connection exactly as it found it.
    PERFORM set_config('app.public_link_token', coalesce(v_prev_link, ''), true);
    PERFORM set_config('app.organization_id', coalesce(v_prev_org, ''), true);
    PERFORM set_config('app.public_context', coalesce(v_prev_ctx, ''), true);
    PERFORM set_config('app.public_proof', coalesce(v_prev_proof, ''), true);
    PERFORM set_config('app.user_id', coalesce(v_prev_user, ''), true);
    PERFORM set_config('app.auth_bootstrap', coalesce(v_prev_boot, ''), true);
    PERFORM set_config('app.bypass_financial_triggers', coalesce(v_prev_bypass, ''), true);
    RAISE;
  END;

  -- Restore the caller's context on the success path as well.
  PERFORM set_config('app.public_link_token', coalesce(v_prev_link, ''), true);
  PERFORM set_config('app.organization_id', coalesce(v_prev_org, ''), true);
  PERFORM set_config('app.public_context', coalesce(v_prev_ctx, ''), true);
  PERFORM set_config('app.public_proof', coalesce(v_prev_proof, ''), true);
  PERFORM set_config('app.user_id', coalesce(v_prev_user, ''), true);
  PERFORM set_config('app.auth_bootstrap', coalesce(v_prev_boot, ''), true);
  PERFORM set_config('app.bypass_financial_triggers', coalesce(v_prev_bypass, ''), true);
  RETURN;
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_public_submit_payment(text, bigint, text, text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_public_submit_payment(text, bigint, text, text, text, text) TO scolaira_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Runtime privilege tightening: document numbering is owner-side only.
-- ---------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION next_doc_number(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION next_doc_number(text) FROM scolaira_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Self-audit.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_app_can    boolean;
  v_submit_ok  boolean;
BEGIN
  IF has_function_privilege('scolaira_app', 'next_doc_number(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '[R1/C-3] next_doc_number must not be executable by the runtime role';
  END IF;
  IF has_function_privilege('scolaira_app', 'auth_public_submit_payment(text,bigint,text,text,text,text)', 'EXECUTE') IS NOT TRUE THEN
    RAISE EXCEPTION '[R1/C-3] the public submission entry point must be executable by the runtime role';
  END IF;
  -- The entry point must not be reachable without the bearer token: an
  -- unusable token has to fail closed with 28000.
  BEGIN
    PERFORM * FROM auth_public_submit_payment('r1-self-audit-nonexistent-token', 100, 'REF', 'Payer');
    v_submit_ok := true;
  EXCEPTION WHEN OTHERS THEN
    v_submit_ok := (SQLSTATE = '28000');
  END;
  IF NOT v_submit_ok THEN
    RAISE EXCEPTION '[R1/C-3] public submission with an unknown token must fail closed with 28000';
  END IF;
  v_app_can := has_function_privilege('scolaira_app', 'auth_public_submit_payment(text,bigint,text,text,text,text)', 'EXECUTE');
  RAISE NOTICE '[R1/C-3] public submission entry point installed; next_doc_number app-executable=%, submit app-executable=%', false, v_app_can;
END $$;
