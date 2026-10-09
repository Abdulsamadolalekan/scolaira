-- H-5 — operational & observability hardening of the public payment surface.
--
-- WHY THIS MIGRATION EXISTS
--
--   R3 (0046) made the public surface *enforced*: amount binding, submission
--   idempotency, per-link bounds, token-free row data, owner-only public
--   writes. H-5 makes those same controls *operable*. Measured against the
--   shipped R3 schema, with real rows, before this migration:
--
--   [O1] The exposure report cannot be used.
--        `auth_public_stale_token_exposure()` is owner-only AND runs under
--        FORCE RLS with no context of its own, so the platform operator
--        (owner connection, no tenant context) gets `payments = 0,
--        audit_events = 0` — the report is silent on precisely the database it
--        is meant to describe. With a tenant context it reports that tenant's
--        count only, and in every case it returns COUNTS, never WHICH link is
--        implicated. Answering "which link must I rotate?" required hand-written
--        SQL in the measurement.
--
--   [O2] There is no rotation.
--        `payment_links` has no rotation provenance (no `token_rotated_at`, no
--        `token_rotation_count`, no fingerprint), there is no rotation route or
--        action, and the only shipped remedy for a leaked URL is PATCH
--        revocation, which disables the link: the payer's URL 404s and service
--        can only be restored by creating a DIFFERENT link row, splitting
--        provenance for any payment already attributed to the dead link id.
--
--   [O3] The replay cache cannot be operated at all.
--        Measured: the runtime role gets `42501` (by design); an owner
--        connection with no bearer proof sees `0` rows; with a bearer proof the
--        rows are there (3 reservations). So nobody can count what the
--        append-only cache holds, no prune function exists, and no index
--        supports age-based selection. The cache only grows.
--
--   [O4] Refusals leave no durable, attributable trace.
--        Measured: five accepted submissions then `429` (the <=5 PENDING
--        backlog bound) — and zero audit rows, zero events, nothing. The only
--        artifact is `rate_limits`: current-window counters keyed by opaque
--        strings with an expiry and no history, so "how many 429s yesterday,
--        on which link, is this an attack?" is unanswerable. An amount-mismatch
--        refusal (as shipped: 409) leaves nothing either.
--
--   [O5] The tenant sees nothing about its own links.
--        No tenant-visible exposure view, no tenant-visible abuse signal, no
--        place where the school learns "someone is hammering your link" or
--        "this link's URL is in your stored data and still live".
--
-- REMEDIATION
--
--   1. ROTATION (`§1`). `payment_links` gains `token_fingerprint` (16-hex
--      HMAC, the SAME construction the R3 entry point writes into audit
--      metadata, so the two correlate), `token_rotated_at` and
--      `token_rotation_count`. A guard trigger makes rotation a database
--      invariant, not an application convention: a token may change ONLY while
--      the link is ACTIVE, ONLY together with an incremented rotation counter
--      and a timestamp, and the provenance columns may not move on their own.
--      Rotation preserves the link's identity (id, invoice/student binding,
--      amount, expiry, provenance of every payment pointing at it) and simply
--      retires the old token.
--
--   2. AN ACTIONABLE EXPOSURE REPORT (`§4`, `§5`). Two functions over the same
--      measurement: `auth_public_link_exposure()` for the tenant (its own
--      links, explicitly org-filtered) and `auth_public_remediation_report()`
--      for the platform (all tenants, owner-only). Both report link identity,
--      status, exposure row counts and recommended action — never the token —
--      and both work regardless of the caller's ambient context, because the
--      owner-side one performs an explicit, asserted, transactional RLS
--      suspension instead of silently answering 0.
--
--   3. A CACHE LIFECYCLE (`§6`, `§7`). `auth_public_submission_cache_report()`
--      makes the cache countable; `auth_public_submission_cache_prune(...)`
--      retires settled reservations older than a retention window. It is
--      dry-run by default, refuses windows shorter than a day, caps how many
--      rows it will delete, NEVER deletes a reservation whose payment is still
--      PENDING (that row is the live retry window and the backlog evidence),
--      and cannot create a duplicate: the payments live-reference index still
--      refuses a repeat of a settled reference, so pruning degrades from
--      "replay the original outcome" to "409 conflict", never to a second row.
--      Append-only remains the at-rest posture: RLS is suspended only inside
--      the prune's own transaction, restored, and verified before it returns
--      (a failed verification rolls the whole thing back).
--
--   4. DURABLE, SECRET-FREE SIGNALS (`§2`, `§3`). `public_surface_events` is an
--      append-only operational log (RLS forced, no runtime privileges, no
--      UPDATE/DELETE policy) with CHECK constraints that make storing a token,
--      a submission key, a reference, a payer identity, a proof or an amount
--      impossible. One owner-owned recorder
--      (`auth_record_public_surface_event`) is the only writer, with a caller
--      matrix (public context may only report on its own bearer; a tenant only
--      on its own links; an anonymous caller only "unknown bearer"), an
--      internal event-rate cap so telemetry cannot be used for amplification,
--      and no ability to fail a payment: every recorder call site is
--      best-effort.
--
--   5. ALERTING SURFACES (`§8`, `§9`). `auth_public_surface_signal_report()`
--      aggregates events into severity-classified rows for the platform;
--      `auth_public_surface_events()` gives a tenant its own recent activity.
--      The operator CLI (`scripts/public-surface-ops.ts`) prints both plus the
--      cache inventory and remediation list, and exits with an alert code so a
--      cron/monitor can act on it.
--
--   NOTHING HERE CHANGES FINANCIAL TRUTH OR R3's CONTRACT. No ledger table is
--   altered beyond three derived/provenance columns on `payment_links`; no R3
--   function is replaced; the R3 entry point, its SQLSTATE contract, the
--   amount binding, the replay semantics and the owner-only public write
--   policies are untouched. Historical rows carrying raw tokens are still NOT
--   rewritten — H-5's remedy for them is a supported rotation, not a data
--   mutation.

-- ---------------------------------------------------------------------------
-- 1. Rotation support on payment_links.
--
--    `token_fingerprint` is derived, never supplied: a SECURITY DEFINER trigger
--    computes it from the row's own token with the same HMAC construction the
--    submission audit trail uses, so `audit_events.metadata.linkFingerprint`
--    and `payment_links.token_fingerprint` are directly comparable. Existing
--    rows are backfilled with the same value (a derived column, not a rewrite
--    of history).
-- ---------------------------------------------------------------------------

ALTER TABLE payment_links ADD COLUMN token_fingerprint varchar(16);
--> statement-breakpoint
ALTER TABLE payment_links ADD COLUMN token_rotated_at timestamptz;
--> statement-breakpoint
ALTER TABLE payment_links ADD COLUMN token_rotation_count integer NOT NULL DEFAULT 0;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_payment_link_fingerprint()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_secret text;
BEGIN
  -- An update that leaves the token alone keeps the fingerprint it already had
  -- (and may never invent one).
  IF TG_OP = 'UPDATE' AND NEW.token IS NOT DISTINCT FROM OLD.token THEN
    NEW.token_fingerprint := OLD.token_fingerprint;
    RETURN NEW;
  END IF;
  IF NEW.token IS NULL OR length(NEW.token) = 0 THEN
    RETURN NEW;
  END IF;
  SELECT v INTO v_secret FROM app_meta WHERE k = 'tenant_ctx_secret';
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'tenant_ctx_secret not initialized';
  END IF;
  NEW.token_fingerprint := substr(encode(hmac('link-fp|' || NEW.token, v_secret, 'sha256'), 'hex'), 1, 16);
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS payment_links_fingerprint_trg ON payment_links;
--> statement-breakpoint
CREATE TRIGGER payment_links_fingerprint_trg
  BEFORE INSERT OR UPDATE OF token ON payment_links
  FOR EACH ROW EXECUTE FUNCTION trg_payment_link_fingerprint();
--> statement-breakpoint

-- Backfill: every existing row gets the fingerprint of the token it holds now.
--
-- RLS is suspended FOR THIS UPGRADE STEP ONLY, and restored inside the same
-- block. `payment_links` is FORCE-RLS (R1/R3), so an owner-side UPDATE sees no
-- rows at all and the row that follows (`SET NOT NULL`) would fail on a
-- database that already has links — exactly the upgrade a production system
-- performs. The suspend is bounded, restored, and re-asserted by the §8
-- self-audit.
DO $$
DECLARE
  v_touched bigint;
  v_null    bigint;
BEGIN
  ALTER TABLE payment_links DISABLE ROW LEVEL SECURITY;
  BEGIN
    UPDATE payment_links
       SET token_fingerprint = substr(encode(hmac('link-fp|' || token,
                                  (SELECT v FROM app_meta WHERE k = 'tenant_ctx_secret'), 'sha256'), 'hex'), 1, 16);
    GET DIAGNOSTICS v_touched = ROW_COUNT;
    SELECT count(*) INTO v_null FROM payment_links WHERE token_fingerprint IS NULL;
  EXCEPTION WHEN OTHERS THEN
    ALTER TABLE payment_links ENABLE ROW LEVEL SECURITY;
    ALTER TABLE payment_links FORCE ROW LEVEL SECURITY;
    RAISE;
  END;
  ALTER TABLE payment_links ENABLE ROW LEVEL SECURITY;
  ALTER TABLE payment_links FORCE ROW LEVEL SECURITY;
  RAISE NOTICE '[H-5] fingerprinted % pre-existing payment link(s); % still NULL', v_touched, v_null;
END
$$;
--> statement-breakpoint

ALTER TABLE payment_links ALTER COLUMN token_fingerprint SET NOT NULL;
--> statement-breakpoint

DO $$
BEGIN
  ALTER TABLE payment_links DISABLE ROW LEVEL SECURITY;
  BEGIN
    ALTER TABLE payment_links
      ADD CONSTRAINT payment_links_token_fingerprint_check
      CHECK (token_fingerprint ~ '^[0-9a-f]{16}$');
    ALTER TABLE payment_links
      ADD CONSTRAINT payment_links_rotation_count_check
      CHECK (token_rotation_count >= 0);
    ALTER TABLE payment_links
      ADD CONSTRAINT payment_links_rotation_provenance_check
      CHECK (token_rotation_count = 0 OR token_rotated_at IS NOT NULL);
  EXCEPTION WHEN OTHERS THEN
    ALTER TABLE payment_links ENABLE ROW LEVEL SECURITY;
    ALTER TABLE payment_links FORCE ROW LEVEL SECURITY;
    RAISE;
  END;
  ALTER TABLE payment_links ENABLE ROW LEVEL SECURITY;
  ALTER TABLE payment_links FORCE ROW LEVEL SECURITY;
END
$$;
--> statement-breakpoint

-- The rotation invariant itself. Application code cannot forget it, and a
-- future route cannot accidentally mutate a bearer secret in place.
CREATE OR REPLACE FUNCTION trg_payment_link_token_rotation_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.token IS DISTINCT FROM OLD.token THEN
    IF OLD.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'a payment link token may only be rotated while the link is ACTIVE (current status %)', OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'rotation must not change the link status'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.token IS NULL OR length(NEW.token) < 16 THEN
      RAISE EXCEPTION 'a rotated token must be a fresh opaque string of at least 16 characters'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.token_rotated_at IS NULL OR NEW.token_rotation_count IS DISTINCT FROM OLD.token_rotation_count + 1 THEN
      RAISE EXCEPTION 'rotation must record its provenance (token_rotated_at and rotation count + 1)'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    -- A token-less update may not invent, rewind or otherwise move rotation
    -- provenance; the fingerprint is derived and may not be supplied.
    IF NEW.token_rotated_at IS DISTINCT FROM OLD.token_rotated_at
       OR NEW.token_rotation_count IS DISTINCT FROM OLD.token_rotation_count THEN
      RAISE EXCEPTION 'rotation provenance may only change together with the token'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.token_fingerprint IS DISTINCT FROM OLD.token_fingerprint THEN
      RAISE EXCEPTION 'token_fingerprint is derived and may not be supplied'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS payment_links_rotation_guard_trg ON payment_links;
--> statement-breakpoint
CREATE TRIGGER payment_links_rotation_guard_trg
  BEFORE UPDATE ON payment_links
  FOR EACH ROW EXECUTE FUNCTION trg_payment_link_token_rotation_guard();
--> statement-breakpoint

CREATE INDEX payment_links_token_fingerprint_idx ON payment_links (token_fingerprint);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. The operational event log.
--
--    Append-only, owner-only, RLS forced. The CHECK constraints are part of the
--    security contract: no credential, no submission key, no bank reference, no
--    payer identity, no proof and no financial amount can be stored here even
--    by a future code path that tries.
-- ---------------------------------------------------------------------------

CREATE TABLE public_surface_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations (id) ON DELETE CASCADE,
  link_id         uuid,
  kind            text NOT NULL,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT public_surface_events_kind_check CHECK (kind IN (
    'submission_accepted',
    'submission_replayed',
    'submission_rate_limited',
    'submission_backlog_blocked',
    'submission_amount_mismatch',
    'submission_key_reused',
    'submission_reference_conflict',
    'submission_unknown_bearer',
    'link_rotated',
    'cache_pruned'
  )),
  CONSTRAINT public_surface_events_detail_object_check CHECK (jsonb_typeof(detail) = 'object'),
  CONSTRAINT public_surface_events_detail_size_check CHECK (pg_column_size(detail) <= 1024),
  CONSTRAINT public_surface_events_detail_secret_free_check CHECK (
    NOT (detail ?| ARRAY[
      'token', 'tokenHash', 'tokenFingerprint', 'key', 'keyHash', 'idempotencyKey', 'idempotency_key',
      'reference', 'referenceHash', 'payerName', 'payerPhone', 'payerEmail', 'proof', 'secret',
      'amount', 'amountKobo', 'amount_kobo', 'paidKobo', 'unallocatedKobo', 'notes', 'email', 'phone'
    ])
  ),
  CONSTRAINT public_surface_events_org_required_check CHECK (
    organization_id IS NOT NULL
    OR kind IN ('submission_unknown_bearer', 'cache_pruned')
  ),
  CONSTRAINT public_surface_events_link_requires_org_check CHECK (
    link_id IS NULL OR organization_id IS NOT NULL
  ),
  -- A deleted link must not be able to destroy the operational record of what
  -- happened to it: the event survives, only the link pointer is cleared.
  CONSTRAINT public_surface_events__link_id__org_fkey
    FOREIGN KEY (organization_id, link_id) REFERENCES payment_links (organization_id, id)
    ON DELETE SET NULL (link_id)
);
--> statement-breakpoint

CREATE INDEX public_surface_events_org_time_idx ON public_surface_events (organization_id, occurred_at DESC);
--> statement-breakpoint
CREATE INDEX public_surface_events_kind_time_idx ON public_surface_events (kind, occurred_at DESC);
--> statement-breakpoint
CREATE INDEX public_surface_events_link_time_idx ON public_surface_events (link_id, occurred_at DESC);
--> statement-breakpoint

ALTER TABLE public_surface_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public_surface_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Owner-only, and the only role that may touch the table directly. Every
-- runtime access goes through the gated functions below; no grant is issued to
-- the application role, and no UPDATE/DELETE policy exists (append-only).
DROP POLICY IF EXISTS public_surface_events_owner_insert ON public_surface_events;
CREATE POLICY public_surface_events_owner_insert ON public_surface_events
  FOR INSERT TO scolaira_owner
  WITH CHECK (true);
--> statement-breakpoint
DROP POLICY IF EXISTS public_surface_events_owner_select ON public_surface_events;
CREATE POLICY public_surface_events_owner_select ON public_surface_events
  FOR SELECT TO scolaira_owner
  USING (true);
--> statement-breakpoint

REVOKE ALL ON public_surface_events FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON public_surface_events FROM scolaira_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. The sanctioned event writer.
--
--    Caller matrix (all three paths derive tenant identity from evidence, never
--    from a parameter):
--      * public context  — bearer proof required; may report only on the link
--                          the bearer resolves to, and only submission kinds;
--      * tenant context  — may report only on a link inside its own tenant,
--                          and only lifecycle kinds;
--      * no context      — may only report 'submission_unknown_bearer' (a probe
--                          against a token that resolves to nothing).
--    The internal event cap keeps telemetry from becoming an amplification
--    vector, and it fails *soft* (returns NULL) because logging must never
--    break a payment.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth_record_public_surface_event(
  p_kind    text,
  p_link_id uuid DEFAULT NULL,
  p_detail  jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org      uuid;
  v_link     uuid := p_link_id;
  v_tenant   boolean;
  v_public   boolean;
  v_id       uuid;
  v_allowed  boolean;
  v_token    text;
  v_prev_org   text;
  v_prev_ctx   text;
  v_prev_proof text;
  v_prev_user  text;
BEGIN
  -- NOTE: 'cache_pruned' is deliberately absent. That event is written by the
  -- prune itself (an owner-side maintenance path); no runtime caller may claim
  -- that a retention run happened.
  IF p_kind IS NULL OR p_kind NOT IN (
    'submission_accepted', 'submission_replayed', 'submission_rate_limited',
    'submission_backlog_blocked', 'submission_amount_mismatch', 'submission_key_reused',
    'submission_reference_conflict', 'submission_unknown_bearer', 'link_rotated'
  ) THEN
    RAISE EXCEPTION 'unknown public surface event kind: %', coalesce(p_kind, '(null)')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_detail IS NULL THEN
    p_detail := '{}'::jsonb;
  END IF;
  IF jsonb_typeof(p_detail) <> 'object' THEN
    RAISE EXCEPTION 'event detail must be a JSON object' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Second layer behind the table CHECK: structured telemetry only, never data.
  IF p_detail ?| ARRAY[
    'token', 'tokenHash', 'tokenFingerprint', 'key', 'keyHash', 'idempotencyKey', 'idempotency_key',
    'reference', 'referenceHash', 'payerName', 'payerPhone', 'payerEmail', 'proof', 'secret',
    'amount', 'amountKobo', 'amount_kobo', 'paidKobo', 'unallocatedKobo', 'notes', 'email', 'phone'
  ] THEN
    RAISE EXCEPTION 'event detail must not carry credentials, payer identity or amounts'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- FLAT scalars only. The key blacklist (and the table CHECK) inspect
  -- top-level keys, so a nested object could smuggle a credential or an amount
  -- in under a harmless-looking key — nesting is refused outright, and the
  -- payload is bounded so telemetry cannot become a store.
  IF (SELECT count(*) FROM jsonb_object_keys(p_detail)) > 8 THEN
    RAISE EXCEPTION 'event detail must not exceed 8 keys'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_each(p_detail) AS kv
     WHERE jsonb_typeof(kv.value) NOT IN ('string', 'number', 'boolean', 'null')
  ) THEN
    RAISE EXCEPTION 'event detail must be a flat object of scalar values'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_tenant := auth_is_tenant_authorized();
  v_public := auth_is_public_context_authorized();

  IF v_public THEN
    -- The bearer decides which link this caller may describe.
    --
    -- The token-lookup policy answers only while NO organization context is in
    -- force (`_app_current_org_uuid() IS NULL`), and tenant context is
    -- deliberately false in public mode — so the resolution has to run on a
    -- NEUTRALIZED identity state, exactly as the R3 entry point does it. The
    -- caller's own context is restored immediately afterwards: a refused
    -- telemetry call must not leave the caller's authorization context
    -- altered. (Measured with the H-5 suite: resolving "as the public scope"
    -- returned no row, so every signal was refused and — in a nested scope —
    -- left the transaction aborted.)
    v_token      := NULLIF(current_setting('app.public_link_token', true), '');
    v_prev_org   := current_setting('app.organization_id', true);
    v_prev_ctx   := current_setting('app.public_context', true);
    v_prev_proof := current_setting('app.public_proof', true);
    v_prev_user  := current_setting('app.user_id', true);

    PERFORM set_config('app.organization_id', '', true);
    PERFORM set_config('app.public_context', '', true);
    PERFORM set_config('app.public_proof', '', true);
    PERFORM set_config('app.user_id', '', true);
    PERFORM set_config('app.public_link_token', coalesce(v_token, ''), true);

    SELECT r.id, r.organization_id INTO v_link, v_org
      FROM auth_resolve_public_link(v_token) r
     LIMIT 1;

    PERFORM set_config('app.organization_id', coalesce(v_prev_org, ''), true);
    PERFORM set_config('app.public_context', coalesce(v_prev_ctx, ''), true);
    PERFORM set_config('app.public_proof', coalesce(v_prev_proof, ''), true);
    PERFORM set_config('app.user_id', coalesce(v_prev_user, ''), true);
    PERFORM set_config('app.public_link_token', coalesce(v_token, ''), true);

    IF v_org IS NULL THEN
      RAISE EXCEPTION 'public surface event refused: no usable bearer for this context'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_link_id IS NOT NULL AND p_link_id <> v_link THEN
      RAISE EXCEPTION 'public surface event refused: a bearer may only report on its own link'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_kind NOT IN (
      'submission_accepted', 'submission_replayed', 'submission_rate_limited',
      'submission_backlog_blocked', 'submission_amount_mismatch', 'submission_key_reused',
      'submission_reference_conflict'
    ) THEN
      RAISE EXCEPTION 'public surface event refused: kind % is not a submission signal', p_kind
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF v_tenant THEN
    IF p_link_id IS NULL THEN
      RAISE EXCEPTION 'a tenant caller must name the link it is reporting on'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- RLS (tenant policy on payment_links) decides visibility here; a link in
    -- another organization resolves to NULL and is refused below.
    SELECT l.organization_id INTO v_org FROM payment_links l WHERE l.id = p_link_id;
    IF v_org IS NULL OR v_org <> _app_current_org_uuid() THEN
      RAISE EXCEPTION 'public surface event refused: unknown link for this tenant'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_kind NOT IN ('link_rotated') THEN
      RAISE EXCEPTION 'public surface event refused: kind % is not a tenant lifecycle signal', p_kind
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    -- Anonymous: only the platform-level probe signal, with no tenant attached.
    IF p_kind <> 'submission_unknown_bearer' THEN
      RAISE EXCEPTION 'public surface event refused: anonymous callers may only report forged bearers'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_link := NULL;
    v_org := NULL;
  END IF;

  -- Telemetry is best-effort: past the cap it is silently dropped, never an
  -- error the payer or the operator can trip over.
  SELECT rl.allowed INTO v_allowed
    FROM auth_rate_limit_hit('public-surface-event:' || coalesce(v_link::text, v_org::text, 'anonymous'), 240, interval '1 hour') rl;
  IF v_allowed IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  INSERT INTO public_surface_events (organization_id, link_id, kind, detail)
  VALUES (v_org, v_link, p_kind, p_detail)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_record_public_surface_event(text, uuid, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_record_public_surface_event(text, uuid, jsonb) TO scolaira_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Tenant-facing reads (runtime-executable, explicitly org-filtered).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth_public_surface_events(
  p_since interval DEFAULT '24 hours',
  p_limit integer DEFAULT 200
)
RETURNS TABLE (
  occurred_at     timestamptz,
  kind            text,
  link_id         uuid,
  detail          jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT auth_is_tenant_authorized() THEN
    RAISE EXCEPTION 'public surface events require a tenant context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT e.occurred_at, e.kind, e.link_id, e.detail
      FROM public_surface_events e
     WHERE e.organization_id = _app_current_org_uuid()
       AND e.occurred_at >= now() - coalesce(p_since, interval '24 hours')
     ORDER BY e.occurred_at DESC
     LIMIT least(greatest(coalesce(p_limit, 200), 1), 500);
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_public_surface_events(interval, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_public_surface_events(interval, integer) TO scolaira_app;
--> statement-breakpoint

-- Which of MY links still carry a live token inside stored rows?
-- Returns identity and counts, never the token. The tenant can then rotate.
CREATE OR REPLACE FUNCTION auth_public_link_exposure()
RETURNS TABLE (
  link_id               uuid,
  status                text,
  at_risk               boolean,
  exposed_payment_rows  bigint,
  exposed_audit_rows    bigint,
  first_exposed_at      timestamptz,
  last_exposed_at       timestamptz,
  recommended_action    text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org uuid;
BEGIN
  IF NOT auth_is_tenant_authorized() THEN
    RAISE EXCEPTION 'the exposure report requires a tenant context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_org := _app_current_org_uuid();

  RETURN QUERY
    SELECT l.id,
           l.status::text,
           (l.status = 'ACTIVE') AS at_risk,
           e.payment_rows,
           e.audit_rows,
           e.first_at,
           e.last_at,
           CASE
             WHEN l.status = 'ACTIVE' THEN 'ROTATE'
             ELSE 'NONE'
           END
      FROM payment_links l
      CROSS JOIN LATERAL (
        SELECT count(*) FILTER (WHERE s.src = 'payment') AS payment_rows,
               count(*) FILTER (WHERE s.src = 'audit') AS audit_rows,
               min(s.created_at) AS first_at,
               max(s.created_at) AS last_at
          FROM (
            SELECT 'payment'::text AS src, p.created_at
              FROM payments p
             WHERE p.organization_id = l.organization_id
               AND p.notes IS NOT NULL
               -- strpos, not LIKE: a token may contain `_` or `%`, which would
               -- turn a LIKE pattern into a wildcard.
               AND strpos(p.notes, l.token) > 0
            UNION ALL
            SELECT 'audit'::text, a.created_at
              FROM audit_events a
             WHERE a.organization_id = l.organization_id
               AND a.metadata IS NOT NULL
               AND strpos(a.metadata::text, l.token) > 0
          ) s
      ) e
     WHERE l.organization_id = v_org
       AND l.token IS NOT NULL
       AND (e.payment_rows + e.audit_rows) > 0
     ORDER BY (l.status = 'ACTIVE') DESC, e.last_at DESC;
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_public_link_exposure() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_public_link_exposure() TO scolaira_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Owner-only operational reads (platform).
--
--    These must answer across tenants, so they suspend RLS transactionally:
--    asserted beforehand (the posture must already be enabled + forced — this
--    function never "fixes" a broken posture), restored and re-verified before
--    returning, and rolled back entirely by any error. The whitelist below is
--    checked, so this cannot be turned into a general-purpose RLS switch.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth_ops_suspend_rls(p_tables text[])
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_allowed text[] := ARRAY['payment_links', 'payments', 'audit_events', 'public_submission_keys', 'public_surface_events'];
  v_t text;
  v_bad text;
BEGIN
  IF p_tables IS NULL OR array_length(p_tables, 1) IS NULL THEN
    RAISE EXCEPTION 'auth_ops_suspend_rls requires at least one table' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT string_agg(DISTINCT t, ',') INTO v_bad FROM unnest(p_tables) AS t WHERE NOT (t = ANY (v_allowed));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'auth_ops_suspend_rls refuses tables outside the operational whitelist: %', v_bad
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Precondition: the posture we are about to suspend must be intact.
  SELECT string_agg(c.relname, ',') INTO v_bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = ANY (p_tables)
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'refusing to operate: RLS is not enabled AND forced on %', v_bad;
  END IF;

  FOREACH v_t IN ARRAY p_tables LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', v_t);
    EXCEPTION WHEN object_in_use THEN
      -- Postgres refuses a posture change on a table the CALLING statement
      -- already uses. That is a feature, not a bug (it is what keeps a caller
      -- from reading a table while its RLS is off), but the raw error is
      -- unhelpful, so it is restated in operational terms.
      RAISE EXCEPTION
        'this operation must run as a top-level statement: % is already in use by the calling query',
        v_t
        USING ERRCODE = 'object_in_use';
    END;
  END LOOP;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_ops_restore_rls(p_tables text[])
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_t text;
  v_bad text;
  v_left integer;
BEGIN
  FOREACH v_t IN ARRAY p_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', v_t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', v_t);
  END LOOP;

  -- (a) the declarative posture is back,
  SELECT string_agg(c.relname, ',') INTO v_bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = ANY (p_tables)
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'operational read left RLS disabled on %', v_bad;
  END IF;

  -- (b) the replay cache is append-only again (this is the destructive path the
  --     prune uses, so it gets a behavioural probe, not just a flag check),
  IF 'public_submission_keys' = ANY (p_tables) THEN
    DELETE FROM public_submission_keys WHERE false;
    SELECT count(*) INTO v_left FROM pg_policies
     WHERE tablename = 'public_submission_keys' AND cmd IN ('UPDATE', 'DELETE', 'ALL');
    IF v_left <> 0 THEN
      RAISE EXCEPTION 'the replay cache must remain append-only (found % UPDATE/DELETE policies)', v_left;
    END IF;
  END IF;
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_ops_suspend_rls(text[]) FROM PUBLIC, scolaira_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_ops_restore_rls(text[]) FROM PUBLIC, scolaira_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_public_remediation_report()
RETURNS TABLE (
  link_id               uuid,
  organization_id       uuid,
  status                text,
  exposed_payment_rows  bigint,
  exposed_audit_rows    bigint,
  first_exposed_at      timestamptz,
  last_exposed_at       timestamptz,
  recommended_action    text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM auth_ops_suspend_rls(ARRAY['payment_links', 'payments', 'audit_events']);
  BEGIN
    RETURN QUERY
      SELECT l.id,
             l.organization_id,
             l.status::text,
             e.payment_rows,
             e.audit_rows,
             e.first_at,
             e.last_at,
             CASE WHEN l.status = 'ACTIVE' THEN 'ROTATE' ELSE 'NONE' END
        FROM payment_links l
        CROSS JOIN LATERAL (
          SELECT count(*) FILTER (WHERE s.src = 'payment') AS payment_rows,
                 count(*) FILTER (WHERE s.src = 'audit') AS audit_rows,
                 min(s.created_at) AS first_at,
                 max(s.created_at) AS last_at
            FROM (
              SELECT 'payment'::text AS src, p.created_at
                FROM payments p
               WHERE p.organization_id = l.organization_id
                 AND p.notes IS NOT NULL
                 AND strpos(p.notes, l.token) > 0
              UNION ALL
              SELECT 'audit'::text, a.created_at
                FROM audit_events a
               WHERE a.organization_id = l.organization_id
                 AND a.metadata IS NOT NULL
                 AND strpos(a.metadata::text, l.token) > 0
            ) s
        ) e
       WHERE (e.payment_rows + e.audit_rows) > 0
       ORDER BY (l.status = 'ACTIVE') DESC, e.last_at DESC;
  EXCEPTION WHEN OTHERS THEN
    PERFORM auth_ops_restore_rls(ARRAY['payment_links', 'payments', 'audit_events']);
    RAISE;
  END;
  PERFORM auth_ops_restore_rls(ARRAY['payment_links', 'payments', 'audit_events']);
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_public_remediation_report() FROM PUBLIC, scolaira_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth_public_submission_cache_report()
RETURNS TABLE (
  total_reservations bigint,
  live_pending       bigint,
  settled            bigint,
  pruneable          bigint,
  oldest_created_at  timestamptz,
  newest_created_at  timestamptz,
  organizations      bigint,
  retention_days     integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_retention interval := interval '90 days';
BEGIN
  PERFORM auth_ops_suspend_rls(ARRAY['public_submission_keys', 'payments']);
  BEGIN
    RETURN QUERY
      SELECT count(*)::bigint,
             count(*) FILTER (WHERE p.status = 'PENDING')::bigint,
             count(*) FILTER (WHERE p.status IS NOT NULL AND p.status <> 'PENDING')::bigint,
             count(*) FILTER (
               WHERE k.created_at < now() - v_retention
                 AND p.status IS NOT NULL AND p.status <> 'PENDING'
             )::bigint,
             min(k.created_at),
             max(k.created_at),
             count(DISTINCT k.organization_id)::bigint,
             extract(day FROM v_retention)::integer
        FROM public_submission_keys k
        LEFT JOIN payments p
          ON p.id = k.payment_id AND p.organization_id = k.organization_id;
  EXCEPTION WHEN OTHERS THEN
    PERFORM auth_ops_restore_rls(ARRAY['public_submission_keys', 'payments']);
    RAISE;
  END;
  PERFORM auth_ops_restore_rls(ARRAY['public_submission_keys', 'payments']);
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_public_submission_cache_report() FROM PUBLIC, scolaira_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. Retention for the replay cache.
--
--    Deliberately conservative:
--      * dry-run unless explicitly told otherwise;
--      * refuses windows shorter than a day (a typo must not delete the live
--        retry window) and caps the window at 10 years;
--      * never deletes a reservation whose payment is still PENDING;
--      * never deletes a reservation whose payment row is missing;
--      * hard cap on rows per run;
--      * append-only at rest: RLS is suspended only inside this transaction and
--        is restored + verified (see auth_ops_restore_rls) before returning.
--    Deleting a settled reservation cannot create a financial duplicate: the
--    payments live-reference unique index still refuses a repeat of a settled
--    reference (the retry becomes 409, never a second row). A REJECTED/FAILED
--    payment is outside that index by design, so its reference becomes payable
--    again — which is the intended behaviour for a payment staff refused.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth_public_submission_cache_prune(
  p_retention interval DEFAULT '90 days',
  p_limit     integer  DEFAULT 5000,
  p_dry_run   boolean  DEFAULT true
)
RETURNS TABLE (
  candidates     bigint,
  deleted        bigint,
  dry_run        boolean,
  retention_days integer,
  limit_applied  integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_retention interval := coalesce(p_retention, interval '90 days');
  v_limit     integer := coalesce(p_limit, 5000);
  v_candidates bigint;
  v_deleted   bigint := 0;
BEGIN
  IF v_retention < interval '1 day' THEN
    RAISE EXCEPTION 'refusing to prune with a retention window shorter than one day'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_retention > interval '3650 days' THEN
    RAISE EXCEPTION 'refusing to prune with a retention window longer than ten years'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_limit IS NULL OR v_limit < 1 OR v_limit > 50000 THEN
    RAISE EXCEPTION 'refusing to prune: row limit must be between 1 and 50000'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM auth_ops_suspend_rls(ARRAY['public_submission_keys', 'payments']);
  BEGIN
    SELECT count(*) INTO v_candidates
      FROM public_submission_keys k
      JOIN payments p ON p.id = k.payment_id AND p.organization_id = k.organization_id
     WHERE k.created_at < now() - v_retention
       AND p.status <> 'PENDING';

    IF NOT coalesce(p_dry_run, true) THEN
      WITH doomed AS (
        SELECT k.id
          FROM public_submission_keys k
          JOIN payments p ON p.id = k.payment_id AND p.organization_id = k.organization_id
         WHERE k.created_at < now() - v_retention
           AND p.status <> 'PENDING'
         ORDER BY k.created_at
         LIMIT v_limit
      )
      DELETE FROM public_submission_keys k USING doomed d WHERE k.id = d.id;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    END IF;

    -- The retired rows are gone; the cache is append-only again from here on.
    PERFORM auth_ops_restore_rls(ARRAY['public_submission_keys', 'payments']);
  EXCEPTION WHEN OTHERS THEN
    PERFORM auth_ops_restore_rls(ARRAY['public_submission_keys', 'payments']);
    RAISE;
  END;

  RETURN QUERY SELECT v_candidates, v_deleted, coalesce(p_dry_run, true),
                      extract(day FROM v_retention)::integer, v_limit;

  -- Evidence: the run is recorded even when it deleted nothing. This runs as
  -- the owner (the prune is a maintenance path), so it writes the event
  -- directly rather than through the runtime recorder's caller matrix.
  BEGIN
    INSERT INTO public_surface_events (organization_id, link_id, kind, detail)
    VALUES (NULL, NULL, 'cache_pruned',
            jsonb_build_object(
              'candidates', v_candidates,
              'deleted', v_deleted,
              'retentionDays', extract(day FROM v_retention)::integer,
              'dryRun', coalesce(p_dry_run, true)
            ));
  EXCEPTION WHEN OTHERS THEN
    NULL; -- the record of the run must not fail the run itself
  END;
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_public_submission_cache_prune(interval, integer, boolean) FROM PUBLIC, scolaira_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. Alerting surface.
--    Severity-classified aggregation for the platform operator. Secret-free by
--    construction (the events it reads cannot carry a secret, see §2).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth_public_surface_signal_report(
  p_since interval DEFAULT '1 hour',
  p_limit integer  DEFAULT 50
)
RETURNS TABLE (
  severity             text,
  organization_id      uuid,
  link_id              uuid,
  kind                 text,
  events               bigint,
  first_seen           timestamptz,
  last_seen            timestamptz,
  current_window_count bigint,
  retry_after_seconds  integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
    WITH agg AS (
      SELECT e.organization_id AS org, e.link_id AS link, e.kind AS kind,
             count(*)::bigint AS n,
             min(e.occurred_at) AS first_at,
             max(e.occurred_at) AS last_at
        FROM public_surface_events e
       WHERE e.occurred_at >= now() - coalesce(p_since, interval '1 hour')
       GROUP BY 1, 2, 3
    )
    SELECT
      CASE
        WHEN a.kind = 'submission_unknown_bearer' AND a.n >= 5 THEN 'critical'
        WHEN a.kind IN ('submission_rate_limited', 'submission_backlog_blocked') THEN 'warning'
        WHEN a.n >= 50 THEN 'critical'
        WHEN a.kind = 'submission_amount_mismatch' AND a.n >= 5 THEN 'warning'
        WHEN a.kind = 'submission_reference_conflict' AND a.n >= 10 THEN 'warning'
        ELSE 'info'
      END,
      a.org, a.link, a.kind, a.n, a.first_at, a.last_at,
      CASE WHEN a.link IS NOT NULL THEN (
        SELECT rl.counter::bigint FROM rate_limits rl
         WHERE rl.key = 'public-submit:link:' || a.link::text || ':hour'
      ) END,
      CASE WHEN a.link IS NOT NULL THEN (
        SELECT greatest(0, extract(epoch FROM (rl.expires_at - now()))::integer) FROM rate_limits rl
         WHERE rl.key = 'public-submit:link:' || a.link::text || ':hour'
      ) END
      FROM agg a
     ORDER BY CASE
                WHEN a.kind = 'submission_unknown_bearer' AND a.n >= 5 THEN 0
                WHEN a.kind IN ('submission_rate_limited', 'submission_backlog_blocked') THEN 1
                ELSE 2
              END,
              a.last_at DESC
     LIMIT least(greatest(coalesce(p_limit, 50), 1), 500);
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION auth_public_surface_signal_report(interval, integer) FROM PUBLIC, scolaira_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 8. Self-audit.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_bad text;
  v_count int;
  v_link uuid;
  v_id uuid;
  v_fail boolean;
  v_events bigint;
BEGIN
  -- Rotation support must exist and be non-trivial.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'payment_links_rotation_guard_trg' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'payment_links_fingerprint_trg' AND NOT tgisinternal) THEN
    RAISE EXCEPTION '[H-5] payment link rotation triggers are missing';
  END IF;
  SELECT count(*) INTO v_count FROM payment_links WHERE token_fingerprint IS NULL;
  IF v_count <> 0 THEN
    RAISE EXCEPTION '[H-5] % payment link rows have no token fingerprint', v_count;
  END IF;

  -- The event log: RLS forced, owner-only, append-only, secret-free.
  SELECT string_agg(p.privilege_type, ',' ORDER BY p.privilege_type) INTO v_bad
    FROM information_schema.table_privileges p
   WHERE p.table_schema = 'public' AND p.table_name = 'public_surface_events'
     AND p.grantee IN ('scolaira_app', 'PUBLIC');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '[H-5] public_surface_events leaks runtime privileges: %', v_bad;
  END IF;
  SELECT count(*) INTO v_count FROM pg_class
   WHERE relname = 'public_surface_events' AND relrowsecurity AND relforcerowsecurity;
  IF v_count <> 1 THEN
    RAISE EXCEPTION '[H-5] public_surface_events must have RLS enabled and forced';
  END IF;
  SELECT count(*) INTO v_count FROM pg_policies
   WHERE tablename = 'public_surface_events' AND cmd IN ('UPDATE', 'DELETE', 'ALL');
  IF v_count <> 0 THEN
    RAISE EXCEPTION '[H-5] public_surface_events must be append-only (no UPDATE/DELETE policy)';
  END IF;
  SELECT string_agg(conname, ',') INTO v_bad FROM pg_constraint
   WHERE conrelid = 'public_surface_events'::regclass
     AND conname IN ('public_surface_events_detail_secret_free_check',
                     'public_surface_events_detail_object_check',
                     'public_surface_events_org_required_check');
  IF v_bad IS NULL OR (SELECT count(*) FROM pg_constraint
                        WHERE conrelid = 'public_surface_events'::regclass
                          AND conname IN ('public_surface_events_detail_secret_free_check',
                                          'public_surface_events_detail_object_check',
                                          'public_surface_events_org_required_check')) <> 3 THEN
    RAISE EXCEPTION '[H-5] public_surface_events is missing its content constraints: %', coalesce(v_bad, 'none');
  END IF;

  -- Operational-only functions must not be runtime-executable.
  IF has_function_privilege('scolaira_app', 'auth_public_submission_cache_prune(interval,integer,boolean)', 'EXECUTE')
     OR has_function_privilege('scolaira_app', 'auth_public_submission_cache_report()', 'EXECUTE')
     OR has_function_privilege('scolaira_app', 'auth_public_remediation_report()', 'EXECUTE')
     OR has_function_privilege('scolaira_app', 'auth_public_surface_signal_report(interval,integer)', 'EXECUTE')
     OR has_function_privilege('scolaira_app', 'auth_ops_suspend_rls(text[])', 'EXECUTE')
     OR has_function_privilege('scolaira_app', 'auth_ops_restore_rls(text[])', 'EXECUTE') THEN
    RAISE EXCEPTION '[H-5] an operational-only function is executable by the runtime role';
  END IF;

  -- …and the tenant-facing ones must be.
  IF has_function_privilege('scolaira_app', 'auth_public_link_exposure()', 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('scolaira_app', 'auth_public_surface_events(interval,integer)', 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('scolaira_app', 'auth_record_public_surface_event(text,uuid,jsonb)', 'EXECUTE') IS NOT TRUE THEN
    RAISE EXCEPTION '[H-5] a tenant-facing operational function must be executable by the runtime role';
  END IF;

  -- The recorder refuses anonymous lifecycle signals…
  v_fail := false;
  BEGIN
    PERFORM auth_record_public_surface_event('link_rotated', NULL, '{}'::jsonb);
  EXCEPTION WHEN insufficient_privilege THEN
    v_fail := true;
  END;
  IF NOT v_fail THEN
    RAISE EXCEPTION '[H-5] the event recorder must refuse anonymous lifecycle signals';
  END IF;

  -- …and refuses any attempt to smuggle data into the log.
  v_fail := false;
  BEGIN
    PERFORM auth_record_public_surface_event('submission_unknown_bearer', NULL,
                                             jsonb_build_object('token', 'x'));
  EXCEPTION WHEN invalid_parameter_value THEN
    v_fail := true;
  END;
  IF NOT v_fail THEN
    RAISE EXCEPTION '[H-5] the event recorder must refuse credential-bearing detail';
  END IF;

  -- …including nesting, and an oversized payload.
  v_fail := false;
  BEGIN
    PERFORM auth_record_public_surface_event('submission_unknown_bearer', NULL,
                                             jsonb_build_object('probe', jsonb_build_object('token', 'x')));
  EXCEPTION WHEN invalid_parameter_value THEN
    v_fail := true;
  END;
  IF NOT v_fail THEN
    RAISE EXCEPTION '[H-5] the event recorder must refuse nested detail';
  END IF;

  v_fail := false;
  BEGIN
    PERFORM auth_record_public_surface_event('submission_unknown_bearer', NULL,
      jsonb_build_object('a',1,'b',2,'c',3,'d',4,'e',5,'f',6,'g',7,'h',8,'i',9));
  EXCEPTION WHEN invalid_parameter_value THEN
    v_fail := true;
  END;
  IF NOT v_fail THEN
    RAISE EXCEPTION '[H-5] the event recorder must bound the size of a detail payload';
  END IF;

  -- The prune must refuse an unsafe window even before doing anything.
  v_fail := false;
  BEGIN
    PERFORM * FROM auth_public_submission_cache_prune(interval '1 hour', 10, true);
  EXCEPTION WHEN invalid_parameter_value THEN
    v_fail := true;
  END;
  IF NOT v_fail THEN
    RAISE EXCEPTION '[H-5] the prune must refuse a retention window shorter than a day';
  END IF;

  -- Dry-run by default, and it must leave the cache untouched.
  SELECT count(*) INTO v_events FROM public_submission_keys;
  PERFORM * FROM auth_public_submission_cache_prune();
  SELECT count(*) INTO v_count FROM public_submission_keys;
  IF v_count <> v_events THEN
    RAISE EXCEPTION '[H-5] a dry run must not delete replay-cache rows';
  END IF;

  -- RLS posture of every table the operational paths touch is intact.
  SELECT string_agg(c.relname, ',') INTO v_bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('payment_links', 'payments', 'audit_events', 'public_submission_keys', 'public_surface_events')
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '[H-5] RLS must stay enabled AND forced on %', v_bad;
  END IF;

  v_link := NULL;
  IF v_link IS NOT NULL THEN
    RAISE NOTICE '[H-5] unreachable %', v_link;
  END IF;

  RAISE NOTICE '[H-5] public surface is operable: link rotation, actionable exposure reports, replay-cache lifecycle, durable secret-free abuse signals';
END $$;
