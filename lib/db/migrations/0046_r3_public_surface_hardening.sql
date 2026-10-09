-- R3 — public payment surface hardening (H-3).
--
-- WHY THIS MIGRATION EXISTS
--
--   R1 (C-3) established *who* a public payment-link bearer is: an anonymous
--   bearer, resolved from the link row, with the only mutation going through
--   `auth_public_submit_payment(token, …)`. This migration addresses *what that
--   surface is allowed to do*.
--
-- MEASURED BEFORE THIS MIGRATION (runtime role, real fixtures, committed rows)
--
--   [P1] link fixed at 500 000 kobo; the caller submitted amountKobo = 100
--        → 201, and payments.amount_kobo = 100.
--        The payer's claim took precedence over the link's authoritative
--        amount, so any amount at all could be recorded as a payment.
--
--   [P2] the same reference twice → the second call returned 409 (R2's live
--        reference guard). There was no submission idempotency boundary: a
--        retry was a *conflict*, never a replay of the original submission.
--
--   [P3] eight distinct submissions in a row → eight 201s. Nothing bounded how
--        many PENDING rows one link could inject into the bursar's
--        reconciliation queue ([P8] = 10 accumulated PENDING rows).
--
--   [P4] 10 payments carried the RAW BEARER TOKEN in `payments.notes`
--        ("Submitted via payment link <token>") and 10 audit rows carried it in
--        `metadata.linkToken`. Any database copy, backup, log export or support
--        screenshot containing those rows is a live credential for that link.
--
--   [P5] GET /api/p/<token>/view returned the token itself, the student's FULL
--        last name, the student's internal identifier and the invoice's
--        total/paid amounts — a family's payment history to anyone holding the
--        URL.
--
--   [P6] an input the database rejected (whitespace-only payer name) produced
--        400 {"message":"submission payer name must not be empty"} — the
--        catch-all error path echoed the database's own message verbatim.
--
--   [P7] a public bearer could INSERT into `payments` DIRECTLY (migration
--        0012's permissive `payments_public_insert` policy applied to every
--        role): a CASH PENDING row with an arbitrary amount, no audit row, no
--        amount binding, no idempotency, no bounds. Migration 0043's claim that
--        "public context has no direct write privilege to any table" was not
--        actually true; the policy was never narrowed.
--
-- REMEDIATION
--
--   1. AMOUNT BINDING (authoritative, server-side). `auth_public_amount_due()`
--      is the ONE implementation of "what this link is asking for": the link's
--      fixed amount when set, otherwise the linked invoice's outstanding
--      balance (0/NULL when there is nothing to pay). The entry point calls it
--      inside the transaction and refuses any submission whose amount does not
--      equal it (22023). A caller's number is a CLAIM that must agree with the
--      database's decision, never an input to it — and the web form sends no
--      amount at all, so the recorded amount is always the database's.
--
--   2. SUBMISSION IDEMPOTENCY. `public_submission_keys` records one row per
--      accepted submission, keyed on the hashed Idempotency-Key AND on the
--      submission's identity (link + bank reference). A retry returns the
--      ORIGINAL outcome instead of creating a second PENDING row. Only hashes
--      are stored: the raw client key never reaches the database, and the
--      bearer token never reaches this table. Append-only by policy — there is
--      no UPDATE or DELETE policy, so not even the owner can rewrite an
--      outcome.
--
--   3. BOUNDED SUBMISSIONS. Per link: at most 5 submissions may be left
--      awaiting the bursar's confirmation, and at most 10 accepted submissions
--      per hour, both enforced through the existing `auth_rate_limit_hit`
--      counter. The application additionally applies a platform-wide budget per
--      minute/hour BEFORE it resolves the token, so a flood of forged tokens is
--      bounded too. Exceeding a bound fails closed: 53400 → HTTP 429.
--
--   4. NO BEARER SECRET IN STORED ROW DATA. `payments.notes` records the link's
--      identifier; audit metadata records `linkId` plus a non-reversible, keyed
--      `linkFingerprint` (HMAC-SHA256, 16 hex characters) so a submission can
--      still be correlated with a link without the token ever being persisted.
--      Link management actions (`payment_link.create` / `.revoke`) record the
--      link id too — the pre-R3 audit rows carried the raw token as well.
--
--   5. THE DIRECT WRITE PATH IS CLOSED. `payments_public_insert` (and the
--      overlapping `payments_public_insert2` left by 0040),
--      `payments_public_owner_link_count` and `audit_events_public_insert` are
--      narrowed to `TO scolaira_owner`, to the exact shape the entry point
--      writes (BANK_TRANSFER, PENDING, own organization, valid public proof)
--      and, for the count policy, to the single link named in
--      `app.public_link_id`. Public context held by the runtime role therefore
--      has NO permissive write policy on the ledger at all.
--
--   NOTHING HERE CHANGES FINANCIAL TRUTH: the ledger's semantics, triggers,
--   reconciliation and collections control planes are untouched; the only
--   change to a financial table is an additive, nullable `payments.link_id`
--   provenance column with an organization-composite foreign key.
--   `public_submission_keys` is explicitly NOT a ledger — it is a replay cache
--   for one unauthenticated endpoint and is never consulted for balances,
--   allocations or invoice state.
--
-- HISTORICAL NOTE (deliberate, documented residual risk): rows written before
--   this migration still contain the raw token in `payments.notes` /
--   `audit_events.metadata`. Those tables are append-only financial/audit
--   history, so they are NOT rewritten here. The remedy is operational —
--   revoke or rotate the affected links (a revoked link's token authorizes
--   nothing) — and `auth_public_stale_token_exposure()` (§6) reports the exact
--   scope, owner-only, so an operator can decide.
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 1. The single authoritative amount rule for a payment link.
--    Called by the entry point (which refuses to record anything else) and by
--    the application's link page, so the number the payer is shown and the
--    number the database records can never disagree.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.auth_public_amount_due(p_token text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_org       uuid;
  v_invoice   uuid;
  v_link_amt  bigint;
  v_remaining bigint;
  v_prev_org  text;
  v_prev_ctx  text;
  v_prev_prf  text;
  v_prev_tok  text;
BEGIN
  IF p_token IS NULL OR length(p_token) = 0 THEN
    RETURN NULL;
  END IF;

  -- Capture the caller's context; every path below restores it.
  v_prev_org := current_setting('app.organization_id', true);
  v_prev_ctx := current_setting('app.public_context', true);
  v_prev_prf := current_setting('app.public_proof', true);
  v_prev_tok := current_setting('app.public_link_token', true);

  -- The bearer is resolved on a NEUTRAL identity state: the link-lookup policy
  -- is `_app_current_org_uuid() IS NULL AND token = app.public_link_token`, so
  -- any ambient organization must be cleared first (an ambient value must not
  -- be able to steer — or block — this lookup).
  PERFORM set_config('app.organization_id', '', true);
  PERFORM set_config('app.public_context', '', true);
  PERFORM set_config('app.public_proof', '', true);
  PERFORM set_config('app.public_link_token', p_token, true);

  SELECT r.organization_id, r.invoice_id, r.amount_kobo
    INTO v_org, v_invoice, v_link_amt
    FROM auth_resolve_public_link(p_token) r
   LIMIT 1;

  -- A fixed-amount link is authoritative by itself.
  IF v_org IS NULL OR v_link_amt IS NOT NULL OR v_invoice IS NULL THEN
    PERFORM set_config('app.organization_id', coalesce(v_prev_org, ''), true);
    PERFORM set_config('app.public_context', coalesce(v_prev_ctx, ''), true);
    PERFORM set_config('app.public_proof', coalesce(v_prev_prf, ''), true);
    PERFORM set_config('app.public_link_token', coalesce(v_prev_tok, ''), true);
    RETURN v_link_amt;
  END IF;

  -- Otherwise the outstanding balance of the linked invoice decides. The read
  -- runs under the public context derived from the token, so the proof-gated
  -- public policy — not this function — authorizes it.
  BEGIN
    PERFORM set_config('app.organization_id', v_org::text, true);
    PERFORM set_config('app.public_context', '1', true);
    PERFORM set_config('app.public_link_token', p_token, true);
    PERFORM set_config('app.public_proof', auth_public_proof_for(p_token, v_org), true);

    SELECT greatest(0, i.total_kobo - i.paid_kobo) INTO v_remaining
      FROM invoices i
     WHERE i.id = v_invoice
       AND i.organization_id = v_org
       AND i.status IN ('ISSUED', 'PARTIALLY_PAID', 'PAID')
     LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.organization_id', coalesce(v_prev_org, ''), true);
    PERFORM set_config('app.public_context', coalesce(v_prev_ctx, ''), true);
    PERFORM set_config('app.public_proof', coalesce(v_prev_prf, ''), true);
    PERFORM set_config('app.public_link_token', coalesce(v_prev_tok, ''), true);
    RAISE;
  END;

  PERFORM set_config('app.organization_id', coalesce(v_prev_org, ''), true);
  PERFORM set_config('app.public_context', coalesce(v_prev_ctx, ''), true);
  PERFORM set_config('app.public_proof', coalesce(v_prev_prf, ''), true);
  PERFORM set_config('app.public_link_token', coalesce(v_prev_tok, ''), true);

  RETURN v_remaining;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_public_amount_due(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_public_amount_due(text) TO scolaira_app;
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 2. Link provenance on the ledger, and the parent index it needs.
--
--    `payments.link_id` is NULLABLE and additive: existing rows are untouched,
--    no value is reinterpreted, and nothing about the ledger's meaning changes.
--    It exists so that (a) a payment can be traced to the exact link that
--    produced it without parsing free text, and (b) the entry point can bound
--    how many submissions one link may leave unresolved in the bursar's queue.
--    The composite foreign key is the R1 pattern (C-2): a payment can never
--    reference another organization's link.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX payment_links_org_id_uidx ON payment_links (organization_id, id);
--> statement-breakpoint
ALTER TABLE payments ADD COLUMN link_id uuid;
--> statement-breakpoint
ALTER TABLE payments
  ADD CONSTRAINT payments__link_id__org_fkey
  FOREIGN KEY (organization_id, link_id) REFERENCES payment_links (organization_id, id);
--> statement-breakpoint
CREATE INDEX payments_org_link_status_idx ON payments (organization_id, link_id, status);
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 3. The public submission replay cache.
--    Not a ledger. Written and read only by auth_public_submit_payment.
--    Append-only: no UPDATE/DELETE policy exists.
-- ---------------------------------------------------------------------------

CREATE TABLE public_submission_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  link_id         uuid NOT NULL,
  key_hash        text NOT NULL,
  reference_hash  text NOT NULL,
  payment_id      uuid NOT NULL,
  payment_number  text NOT NULL,
  amount_kobo     bigint NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING',
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT public_submission_keys_status_check CHECK (status = 'PENDING'),
  CONSTRAINT public_submission_keys_key_hash_check CHECK (length(key_hash) = 64),
  CONSTRAINT public_submission_keys_reference_hash_check CHECK (length(reference_hash) = 64),
  CONSTRAINT public_submission_keys__link_id__org_fkey
    FOREIGN KEY (organization_id, link_id) REFERENCES payment_links (organization_id, id),
  CONSTRAINT public_submission_keys__payment_id__org_fkey
    FOREIGN KEY (organization_id, payment_id) REFERENCES payments (organization_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX public_submission_keys_link_key_idx
  ON public_submission_keys (link_id, key_hash);
--> statement-breakpoint
CREATE UNIQUE INDEX public_submission_keys_link_reference_idx
  ON public_submission_keys (link_id, reference_hash);
--> statement-breakpoint
ALTER TABLE public_submission_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public_submission_keys FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The entry point runs as the owner with a valid bearer proof in context, so
-- these policies admit exactly that path and nothing else: the runtime role is
-- not the owner and holds no grant, and an owner-side call without the proof is
-- refused.
DROP POLICY IF EXISTS public_submission_keys_public_insert ON public_submission_keys;
CREATE POLICY public_submission_keys_public_insert ON public_submission_keys
  FOR INSERT TO scolaira_owner
  WITH CHECK (
    auth_is_public_context_authorized()
    AND _app_current_org_uuid() IS NOT NULL
    AND organization_id = _app_current_org_uuid()
    AND status = 'PENDING'
  );
--> statement-breakpoint
DROP POLICY IF EXISTS public_submission_keys_public_select ON public_submission_keys;
CREATE POLICY public_submission_keys_public_select ON public_submission_keys
  FOR SELECT TO scolaira_owner
  USING (
    auth_is_public_context_authorized()
    AND _app_current_org_uuid() IS NOT NULL
    AND organization_id = _app_current_org_uuid()
  );
--> statement-breakpoint
-- The runtime role never touches this table directly; it reaches it only
-- through the SECURITY DEFINER entry point.
REVOKE ALL ON public_submission_keys FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON public_submission_keys FROM scolaira_app;
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 4. The submission entry point, second generation.
--
--    The superseded signature is DROPPED, not left as an overload: a callable
--    pre-R3 path would bypass every control added here.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS auth_public_submit_payment(text, bigint, text, text, text, text);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.auth_public_submit_payment(p_token text, p_idempotency_key text, p_amount_kobo bigint, p_reference text, p_payer_name text, p_payer_phone text DEFAULT NULL::text, p_payer_email text DEFAULT NULL::text)
 RETURNS TABLE(payment_id uuid, payment_number text, amount_kobo bigint, status text, replayed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_org          uuid;
  v_link         uuid;
  v_invoice      uuid;
  v_due          bigint;
  v_payment_id   uuid;
  v_number       text;
  v_key_hash     text;
  v_ref_hash     text;
  v_secret       text;
  v_fingerprint  text;
  v_allowed      boolean;
  v_retry        integer;
  v_stored       record;
  v_prev_link     text;
  v_prev_org      text;
  v_prev_ctx      text;
  v_prev_proof    text;
  v_prev_user     text;
  v_prev_boot     text;
  v_prev_bypass   text;
  v_prev_link_id  text;
BEGIN
  -- --- caller-independent input validation ---------------------------------
  -- The token is checked first so an unusable bearer is refused with 28000
  -- regardless of anything else the caller sent.
  IF p_token IS NULL OR length(p_token) = 0 THEN
    RAISE EXCEPTION 'payment link is not active or has expired' USING ERRCODE = '28000';
  END IF;
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) < 8 THEN
    RAISE EXCEPTION 'submission key must be at least 8 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF p_amount_kobo IS NOT NULL AND p_amount_kobo <= 0 THEN
    RAISE EXCEPTION 'submission amount must be positive' USING ERRCODE = 'check_violation';
  END IF;
  IF p_reference IS NULL OR btrim(p_reference) = '' THEN
    RAISE EXCEPTION 'submission reference must not be empty' USING ERRCODE = 'check_violation';
  END IF;
  IF p_payer_name IS NULL OR btrim(p_payer_name) = '' THEN
    RAISE EXCEPTION 'submission payer name must not be empty' USING ERRCODE = 'check_violation';
  END IF;

  -- --- capture the caller's identity variables -----------------------------
  v_prev_link    := current_setting('app.public_link_token', true);
  v_prev_org     := current_setting('app.organization_id', true);
  v_prev_ctx     := current_setting('app.public_context', true);
  v_prev_proof   := current_setting('app.public_proof', true);
  v_prev_user    := current_setting('app.user_id', true);
  v_prev_boot    := current_setting('app.auth_bootstrap', true);
  v_prev_bypass  := current_setting('app.bypass_financial_triggers', true);
  v_prev_link_id := current_setting('app.public_link_id', true);

  BEGIN
    -- --- 1. resolve the bearer on a NEUTRAL identity state ------------------
    PERFORM set_config('app.public_link_id', '', true);
    PERFORM set_config('app.organization_id', '', true);
    PERFORM set_config('app.public_context', '', true);
    PERFORM set_config('app.public_proof', '', true);
    PERFORM set_config('app.user_id', '', true);
    PERFORM set_config('app.auth_bootstrap', '', true);
    PERFORM set_config('app.bypass_financial_triggers', '', true);
    PERFORM set_config('app.public_link_token', p_token, true);

    SELECT pl.organization_id, pl.id, pl.invoice_id
      INTO v_org, v_link, v_invoice
      FROM payment_links pl
     WHERE pl.token = p_token
       AND pl.status = 'ACTIVE'
       AND (pl.expires_at IS NULL OR pl.expires_at > now())
     LIMIT 1;

    IF v_org IS NULL THEN
      RAISE EXCEPTION 'payment link is not active or has expired' USING ERRCODE = '28000';
    END IF;

    -- --- 2. adopt the public context derived from the LINK ------------------
    PERFORM set_config('app.organization_id', v_org::text, true);
    PERFORM set_config('app.public_context', '1', true);
    PERFORM set_config('app.public_proof', auth_public_proof_for(p_token, v_org), true);
    PERFORM set_config('app.acting_role', '', true);
    PERFORM set_config('app.is_platform_admin', '0', true);
    PERFORM set_config('app.platform_admin_id', '', true);
    PERFORM set_config('app.platform_token', '', true);
    PERFORM set_config('app.tenant_token', '', true);

    -- --- 3. the linked invoice must belong to the LINK's organization -------
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

    -- --- 4. AMOUNT BINDING --------------------------------------------------
    -- The database decides the amount; the caller's number is only a claim that
    -- must agree with it. A missing claim (the normal case for the web form) is
    -- filled in from the authoritative rule.
    v_due := auth_public_amount_due(p_token);
    IF v_due IS NULL THEN
      RAISE EXCEPTION 'the amount due on this link could not be determined' USING ERRCODE = '22023';
    END IF;
    IF v_due <= 0 THEN
      RAISE EXCEPTION 'this payment link has nothing left to pay' USING ERRCODE = '22023';
    END IF;
    IF p_amount_kobo IS NOT NULL AND p_amount_kobo <> v_due THEN
      RAISE EXCEPTION 'submitted amount does not match the amount due on this link' USING ERRCODE = '22023';
    END IF;

    -- --- 5. BOUNDED SUBMISSIONS per link ------------------------------------
    SELECT rl.allowed, rl.retry_after_seconds INTO v_allowed, v_retry
      FROM auth_rate_limit_hit('public-submit:link:' || v_link::text || ':hour', 10, interval '1 hour') rl;
    IF NOT v_allowed THEN
      RAISE EXCEPTION 'this payment link has received too many submissions in the last hour'
        USING ERRCODE = '53400';
    END IF;

    -- Unresolved backlog: a link may leave at most 5 submissions awaiting the
    -- bursar's confirmation. This is the bound that protects the reconciliation
    -- queue itself, and it only clears when staff actually process the queue.
    PERFORM set_config('app.public_link_id', v_link::text, true);
    IF (SELECT count(*) FROM payments p
         WHERE p.link_id = v_link
           AND p.organization_id = v_org
           AND p.status = 'PENDING') >= 5 THEN
      RAISE EXCEPTION 'this payment link has unreconciled submissions awaiting confirmation; contact the school office'
        USING ERRCODE = '53400';
    END IF;

    -- --- 6. non-reversible link fingerprint for audit correlation -----------
    SELECT v INTO v_secret FROM app_meta WHERE k = 'tenant_ctx_secret';
    IF v_secret IS NULL THEN
      RAISE EXCEPTION 'tenant_ctx_secret not initialized';
    END IF;
    v_fingerprint := substr(encode(hmac('link-fp|' || p_token, v_secret, 'sha256'), 'hex'), 1, 16);

    -- --- 7. submission identity --------------------------------------------
    -- Two uniques: the client's Idempotency-Key and the submission's identity
    -- (this link + this bank reference). Whichever fires first, the caller gets
    -- the SAME outcome back — a retry can never become a second PENDING row.
    v_key_hash := encode(sha256(convert_to(btrim(p_idempotency_key), 'UTF8')), 'hex');
    v_ref_hash := encode(sha256(convert_to(v_link::text || '|' || btrim(p_reference), 'UTF8')), 'hex');

    v_payment_id := gen_random_uuid();
    v_number     := next_doc_number('PMT');

    -- Same SUBMISSION (this link + this bank reference): replay the original
    -- outcome. This is the retry case — a lost response, a double click, a
    -- second device — and it must never become a second PENDING row.
    SELECT k.payment_id, k.payment_number, k.amount_kobo, k.status
      INTO v_stored
      FROM public_submission_keys k
     WHERE k.link_id = v_link AND k.reference_hash = v_ref_hash
     LIMIT 1;
    IF FOUND THEN
      RETURN QUERY SELECT v_stored.payment_id, v_stored.payment_number,
                          v_stored.amount_kobo, v_stored.status::text, true;
      RETURN;
    END IF;

    -- Same KEY, different submission: the key has been repurposed. Refusing is
    -- the only safe answer — replaying the first outcome would silently discard
    -- a genuinely different claim, and accepting it would create the duplicate
    -- the key exists to prevent.
    SELECT k.payment_id, k.payment_number, k.amount_kobo, k.status
      INTO v_stored
      FROM public_submission_keys k
     WHERE k.link_id = v_link AND k.key_hash = v_key_hash
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'this submission key was already used for a different submission'
        USING ERRCODE = '23000';
    END IF;

    -- --- 8. record the payment and reserve its identity atomically ----------
    -- The payment, its audit row and its identity reservation are one unit. If
    -- a concurrent identical submission wins the race between the checks above
    -- and this insert, the block's implicit savepoint rolls our rows back (the
    -- attempt leaves nothing behind) and the winner is replayed below.
    BEGIN
      INSERT INTO payments (
        id, organization_id, payment_number, method, status,
        amount_kobo, unallocated_kobo, link_id,
        reference, payer_name, payer_phone, payer_email, notes
      ) VALUES (
        v_payment_id, v_org, v_number, 'BANK_TRANSFER', 'PENDING',
        v_due, 0, v_link,
        btrim(p_reference),
        btrim(p_payer_name),
        NULLIF(btrim(coalesce(p_payer_phone, '')), ''),
        NULLIF(btrim(coalesce(p_payer_email, '')), ''),
        'Submitted via payment link ' || v_link::text
      );

      INSERT INTO audit_events (
        organization_id, actor_type, action, entity_type, entity_id, after, metadata, request_id
      ) VALUES (
        v_org, 'USER'::audit_actor_type, 'payment.pending', 'payment', v_payment_id,
        jsonb_build_object(
          'paymentNumber', v_number,
          'amountKobo', v_due,
          'channel', 'payment_link'
        ),
        jsonb_build_object(
          'channel', 'payment_link',
          'linkId', v_link,
          'linkFingerprint', v_fingerprint,
          'invoiceId', v_invoice
        ),
        NULL
      );

      INSERT INTO public_submission_keys (
        organization_id, link_id, key_hash, reference_hash,
        payment_id, payment_number, amount_kobo, status
      ) VALUES (
        v_org, v_link, v_key_hash, v_ref_hash,
        v_payment_id, v_number, v_due, 'PENDING'
      )
      ON CONFLICT DO NOTHING;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'submission identity already reserved' USING ERRCODE = 'R3001';
      END IF;

      RETURN QUERY SELECT v_payment_id, v_number, v_due, 'PENDING'::text, false;
      RETURN;
    EXCEPTION WHEN SQLSTATE 'R3001' THEN
      NULL; -- fall through: another transaction reserved this submission first
    END;

    -- The winner of that race: replay exactly what it recorded.
    SELECT k.payment_id, k.payment_number, k.amount_kobo, k.status
      INTO v_stored
      FROM public_submission_keys k
     WHERE k.link_id = v_link AND k.reference_hash = v_ref_hash
     LIMIT 1;
    IF FOUND THEN
      RETURN QUERY SELECT v_stored.payment_id, v_stored.payment_number,
                          v_stored.amount_kobo, v_stored.status::text, true;
      RETURN;
    END IF;

    SELECT k.payment_id, k.payment_number, k.amount_kobo, k.status
      INTO v_stored
      FROM public_submission_keys k
     WHERE k.link_id = v_link AND k.key_hash = v_key_hash
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'this submission key was already used for a different submission'
        USING ERRCODE = '23000';
    END IF;

    RAISE EXCEPTION 'could not establish submission identity; please retry' USING ERRCODE = '40001';
  EXCEPTION WHEN OTHERS THEN
    -- Restore the caller's context before propagating, so a rejected
    -- submission leaves the connection exactly as it found it.
    PERFORM set_config('app.public_link_token', coalesce(v_prev_link, ''), true);
    PERFORM set_config('app.public_link_id', coalesce(v_prev_link_id, ''), true);
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
  PERFORM set_config('app.public_link_id', coalesce(v_prev_link_id, ''), true);
  PERFORM set_config('app.organization_id', coalesce(v_prev_org, ''), true);
  PERFORM set_config('app.public_context', coalesce(v_prev_ctx, ''), true);
  PERFORM set_config('app.public_proof', coalesce(v_prev_proof, ''), true);
  PERFORM set_config('app.user_id', coalesce(v_prev_user, ''), true);
  PERFORM set_config('app.auth_bootstrap', coalesce(v_prev_boot, ''), true);
  PERFORM set_config('app.bypass_financial_triggers', coalesce(v_prev_bypass, ''), true);
  RETURN;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_public_submit_payment(text, text, bigint, text, text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_public_submit_payment(text, text, bigint, text, text, text, text) TO scolaira_app;
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 5. The direct public write path is closed.
--    These policies are what the entry point itself satisfies; narrowing them
--    to the owner role removes the runtime role's ability to write the ledger
--    from public context (measured: it could).
-- ---------------------------------------------------------------------------

-- The pre-R3 migration left TWO overlapping public insert policies on
-- `payments` (0040 recreated `payments_public_insert2`). Both are removed:
-- a single owner-only policy is the whole of the public write surface.
DROP POLICY IF EXISTS payments_public_insert ON payments;
DROP POLICY IF EXISTS payments_public_insert2 ON payments;
CREATE POLICY payments_public_insert ON payments
  FOR INSERT TO scolaira_owner
  WITH CHECK (
    auth_is_public_context_authorized()
    AND _app_current_org_uuid() IS NOT NULL
    AND organization_id = _app_current_org_uuid()
    AND status = 'PENDING'
    AND method = 'BANK_TRANSFER'
    AND payment_number IS NOT NULL
    AND unallocated_kobo = 0
  );
--> statement-breakpoint
-- Owner-only, proof-gated and confined to the single link named in
-- app.public_link_id: this exists so the entry point can count its own
-- unreconciled backlog without gaining any general read access to the ledger.
DROP POLICY IF EXISTS payments_public_owner_link_count ON payments;
CREATE POLICY payments_public_owner_link_count ON payments
  FOR SELECT TO scolaira_owner
  USING (
    auth_is_public_context_authorized()
    AND _app_current_org_uuid() IS NOT NULL
    AND organization_id = _app_current_org_uuid()
    AND link_id IS NOT NULL
    AND link_id = NULLIF(current_setting('app.public_link_id', true), '')::uuid
  );
--> statement-breakpoint
DROP POLICY IF EXISTS audit_events_public_insert ON audit_events;
CREATE POLICY audit_events_public_insert ON audit_events
  FOR INSERT TO scolaira_owner
  WITH CHECK (
    auth_is_public_context_authorized()
    AND _app_current_org_uuid() IS NOT NULL
    AND organization_id = _app_current_org_uuid()
  );
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 6. Operator visibility for the historical exposure (§ header note).
--    Read-only, owner-only (not executable by the runtime role) and scoped to
--    ACTIVE links: it reports which stored rows still carry a bearer token, so
--    the remedy stays a decision (revoke/rotate) rather than a data mutation.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.auth_public_stale_token_exposure()
 RETURNS TABLE(table_name text, rows_with_token bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  WITH links AS (SELECT token FROM payment_links WHERE status = 'ACTIVE')
  SELECT 'payments'::text, count(*)::bigint
    FROM payments p JOIN links l ON p.notes LIKE '%' || l.token || '%'
  UNION ALL
  SELECT 'audit_events'::text, count(*)::bigint
    FROM audit_events a JOIN links l ON a.metadata::text LIKE '%' || l.token || '%';
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_public_stale_token_exposure() FROM PUBLIC, scolaira_app;
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 7. Self-audit.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_bad text;
  v_count int;
  v_fail boolean;
BEGIN
  -- The superseded entry point must be gone, not overloaded.
  IF to_regprocedure('auth_public_submit_payment(text,bigint,text,text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION '[R3/H-3] the pre-R3 submission entry point is still callable';
  END IF;
  IF to_regprocedure('auth_public_submit_payment(text,text,bigint,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION '[R3/H-3] the submission entry point is missing';
  END IF;
  IF has_function_privilege('scolaira_app', 'auth_public_submit_payment(text,text,bigint,text,text,text,text)', 'EXECUTE') IS NOT TRUE THEN
    RAISE EXCEPTION '[R3/H-3] the submission entry point must be executable by the runtime role';
  END IF;
  IF has_function_privilege('scolaira_app', 'auth_public_amount_due(text)', 'EXECUTE') IS NOT TRUE THEN
    RAISE EXCEPTION '[R3/H-3] the amount resolver must be executable by the runtime role';
  END IF;
  IF has_function_privilege('scolaira_app', 'auth_public_stale_token_exposure()', 'EXECUTE') IS TRUE THEN
    RAISE EXCEPTION '[R3/H-3] the exposure report must not be executable by the runtime role';
  END IF;

  -- The replay cache: RLS on, forced, unreachable, and append-only by policy.
  SELECT string_agg(p.privilege_type, ',' ORDER BY p.privilege_type) INTO v_bad
    FROM information_schema.table_privileges p
   WHERE p.table_schema = 'public' AND p.table_name = 'public_submission_keys'
     AND p.grantee IN ('scolaira_app', 'PUBLIC');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '[R3/H-3] public_submission_keys leaks runtime privileges: %', v_bad;
  END IF;
  SELECT count(*) INTO v_count FROM pg_class
   WHERE relname = 'public_submission_keys' AND relrowsecurity AND relforcerowsecurity;
  IF v_count <> 1 THEN
    RAISE EXCEPTION '[R3/H-3] public_submission_keys must have RLS enabled and forced';
  END IF;
  SELECT count(*) INTO v_count FROM pg_policies
   WHERE tablename = 'public_submission_keys' AND cmd IN ('UPDATE', 'DELETE', 'ALL');
  IF v_count <> 0 THEN
    RAISE EXCEPTION '[R3/H-3] public_submission_keys must be append-only (no UPDATE/DELETE policy)';
  END IF;

  -- Every public write/read policy R3 touches must be owner-only.
  SELECT string_agg(policyname, ',' ORDER BY policyname) INTO v_bad
    FROM pg_policies
   WHERE (
           (tablename = 'payments' AND policyname IN ('payments_public_insert', 'payments_public_owner_link_count'))
        OR (tablename = 'audit_events' AND policyname = 'audit_events_public_insert')
         )
     AND NOT (roles = ARRAY['scolaira_owner']::name[]);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '[R3/H-3] a public policy applies to non-owner roles: %', v_bad;
  END IF;
  SELECT string_agg(policyname || '=' || coalesce(roles::text, '?'), ',' ORDER BY policyname) INTO v_bad
    FROM pg_policies
   WHERE tablename = 'payments' AND policyname LIKE 'payments_public%';
  IF v_bad IS DISTINCT FROM 'payments_public_insert={scolaira_owner},payments_public_owner_link_count={scolaira_owner}' THEN
    RAISE EXCEPTION '[R3/H-3] unexpected payments public policies: %', coalesce(v_bad, 'none');
  END IF;

  -- Link provenance must be present and tenant-composite.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conname = 'payments__link_id__org_fkey'
       AND c.conrelid = 'payments'::regclass AND c.contype = 'f'
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
              FROM unnest(c.conkey) k JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k)
           = ARRAY['link_id', 'organization_id']::text[]
  ) THEN
    RAISE EXCEPTION '[R3/H-3] payments.link_id is missing its organization-composite foreign key';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'payments'::regclass AND c.contype = 'f' AND c.conname = 'payments_link_id_fkey'
  ) THEN
    RAISE EXCEPTION '[R3/H-3] payments.link_id must not carry a non-composite foreign key';
  END IF;

  -- The composite parent must exist, or the new FK could not have been created.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
     WHERE c.relname = 'payment_links' AND i.indisunique AND i.indisvalid
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
              FROM unnest(i.indkey) k JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k)
           = ARRAY['id', 'organization_id']::text[]
  ) THEN
    RAISE EXCEPTION '[R3/H-3] payment_links is missing the (organization_id, id) unique index';
  END IF;

  -- Fail closed: an unknown bearer authorizes nothing, at either entry point.
  v_fail := false;
  BEGIN
    PERFORM * FROM auth_public_submit_payment('r3-self-audit-nonexistent', 'r3-self-audit-key', 100, 'REF', 'Payer');
  EXCEPTION WHEN OTHERS THEN
    v_fail := (SQLSTATE = '28000');
  END;
  IF NOT v_fail THEN
    RAISE EXCEPTION '[R3/H-3] a submission with an unknown token must fail closed with 28000';
  END IF;
  IF auth_public_amount_due('r3-self-audit-nonexistent') IS NOT NULL THEN
    RAISE EXCEPTION '[R3/H-3] the amount resolver answered for an unknown token';
  END IF;

  RAISE NOTICE '[R3/H-3] public surface hardened: amount binding, submission idempotency, bounded submissions, token-free row data, owner-only public writes';
END $$;
