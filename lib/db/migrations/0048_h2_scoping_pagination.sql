-- =============================================================================
-- 0048_h2_scoping_pagination.sql
-- H-2: aggregation, reporting, term-boundary & pagination hardening.
--
-- Measured defect (docs/readiness/H2_SCOPE_MAP.md, register §4 + §13 R7):
--   * headline KPIs were TERM-scoped while every arrearage queue was ALL-TERM,
--     with no scope label on any payload and no way to see which one you were
--     reading;
--   * debt carried forward from a previous term was invisible in every headline
--     figure, although it was spent from the same cash;
--   * lists were silently capped (200/500/100/50) with no cursor, no total and
--     no truncation signal — one page even summed the returned page into its
--     own headline strip;
--   * reminder staleness boundaries (7d / 14d / 4h cooldown) were call-site
--     literals, unlabelled and untestable at the boundary.
--
-- This migration adds the *one* definition of the classification every surface
-- must render, so no two screens can disagree by construction:
--
--   CURRENT_TERM  billed by the active term
--   PRIOR_TERM    an earlier term, already due when the active term began
--                 (i.e. genuinely carried-forward debt)
--   OTHER_TERM    an earlier term, not yet due at the cut-over, or everything
--                 when no term is active (no cut-over exists)
--
-- and a term-boundary control (financial periods + as-of valuation + close)
-- that refuses to freeze a window holding unresolved or unapplied money.
--
-- Classification is DERIVED, never stored: no ledger column is added, no
-- historical row is rewritten, and the authoritative totals remain the
-- trigger-maintained invoices.total_kobo / invoices.paid_kobo columns.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The declared invoice-scope setting (H-2 decision 2).
--
--    Absence of a row means the documented default: ALL_TERM. Arrear visibility
--    is the safe default; a school may elect TERM scope explicitly, and every
--    payload then SAYS so.
-- -----------------------------------------------------------------------------

CREATE TYPE invoice_scope AS ENUM ('TERM', 'ALL_TERM');
--> statement-breakpoint

CREATE TABLE surface_scope_settings (
  organization_id uuid PRIMARY KEY,
  invoice_scope   invoice_scope NOT NULL DEFAULT 'ALL_TERM',
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES users (id),
  CONSTRAINT surface_scope_settings__org_fkey
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE surface_scope_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE surface_scope_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Tenant isolation for the three operations the surface performs. There is
-- deliberately NO delete policy: a scope choice is superseded, never removed.
DROP POLICY IF EXISTS surface_scope_settings_tenant_select ON surface_scope_settings;
CREATE POLICY surface_scope_settings_tenant_select ON surface_scope_settings
  FOR SELECT USING (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  );
--> statement-breakpoint
DROP POLICY IF EXISTS surface_scope_settings_tenant_insert ON surface_scope_settings;
CREATE POLICY surface_scope_settings_tenant_insert ON surface_scope_settings
  FOR INSERT WITH CHECK (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  );
--> statement-breakpoint
DROP POLICY IF EXISTS surface_scope_settings_tenant_update ON surface_scope_settings;
CREATE POLICY surface_scope_settings_tenant_update ON surface_scope_settings
  FOR UPDATE USING (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  ) WITH CHECK (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  );
--> statement-breakpoint
CREATE OR REPLACE TRIGGER surface_scope_settings_set_org
  BEFORE INSERT ON surface_scope_settings
  FOR EACH ROW EXECUTE FUNCTION trg_set_org_from_context();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER surface_scope_settings_set_updated_at
  BEFORE UPDATE ON surface_scope_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 2. Financial periods — the term-boundary control surface.
--
--    A period is a bounded, non-overlapping financial window. Closing it
--    records who froze it and when; the freeze is enforced by trigger, not by
--    convention, and the as-of valuation is computed from ledger timestamps so
--    it stays stable after the window closes.
-- -----------------------------------------------------------------------------

CREATE TABLE financial_periods (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  name            text NOT NULL,
  starts_on       date NOT NULL,
  ends_on         date NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users (id),
  closed_at       timestamptz,
  closed_by       uuid REFERENCES users (id),
  CONSTRAINT financial_periods__org_fkey
    FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT financial_periods_name_check
    CHECK (length(btrim(name)) BETWEEN 1 AND 64),
  CONSTRAINT financial_periods_range_check
    CHECK (ends_on >= starts_on),
  CONSTRAINT financial_periods_closed_pair_check
    CHECK ((closed_at IS NULL) = (closed_by IS NULL)),
  CONSTRAINT financial_periods_org_name_key
    UNIQUE (organization_id, name)
);
--> statement-breakpoint
CREATE INDEX financial_periods_org_range_idx
  ON financial_periods (organization_id, starts_on, ends_on);
--> statement-breakpoint
ALTER TABLE financial_periods ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE financial_periods FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS financial_periods_tenant_select ON financial_periods;
CREATE POLICY financial_periods_tenant_select ON financial_periods
  FOR SELECT USING (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  );
--> statement-breakpoint
DROP POLICY IF EXISTS financial_periods_tenant_insert ON financial_periods;
CREATE POLICY financial_periods_tenant_insert ON financial_periods
  FOR INSERT WITH CHECK (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  );
--> statement-breakpoint
DROP POLICY IF EXISTS financial_periods_tenant_update ON financial_periods;
CREATE POLICY financial_periods_tenant_update ON financial_periods
  FOR UPDATE USING (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  ) WITH CHECK (
    organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  );
--> statement-breakpoint
CREATE OR REPLACE TRIGGER financial_periods_set_org
  BEFORE INSERT ON financial_periods
  FOR EACH ROW EXECUTE FUNCTION trg_set_org_from_context();
--> statement-breakpoint

-- A closed period is frozen evidence: its boundaries and identity cannot move.
-- The only legal UPDATE is the OPEN -> CLOSED transition itself.
CREATE OR REPLACE FUNCTION trg_financial_period_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'financial period % is closed and immutable', OLD.id
      USING ERRCODE = '55000',
            HINT = 'Reopen by creating a correcting period; never rewrite a closed window.';
  END IF;
  IF NEW.organization_id <> OLD.organization_id
     OR NEW.starts_on <> OLD.starts_on
     OR NEW.ends_on <> OLD.ends_on
     OR NEW.name <> OLD.name THEN
    RAISE EXCEPTION 'financial period boundaries are immutable'
      USING ERRCODE = '55000',
            HINT = 'Delete the open period and create a corrected one.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE
    SET search_path = pg_catalog, public;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER financial_periods_immutable
  BEFORE UPDATE ON financial_periods
  FOR EACH ROW EXECUTE FUNCTION trg_financial_period_immutable();
--> statement-breakpoint

-- Non-overlap: periods partition the timeline per organization. A gap is
-- allowed (a school may not bother with every month); an overlap is not,
-- because two windows claiming the same day would double-count a close.
CREATE OR REPLACE FUNCTION trg_financial_period_no_overlap()
RETURNS TRIGGER AS $$
DECLARE
  v_clash text;
BEGIN
  SELECT p.name || ' (' || p.starts_on || '..' || p.ends_on || ')'
    INTO v_clash
    FROM financial_periods p
   WHERE p.organization_id = NEW.organization_id
     AND p.id <> NEW.id
     AND daterange(p.starts_on, p.ends_on, '[]') && daterange(NEW.starts_on, NEW.ends_on, '[]')
   LIMIT 1;
  IF v_clash IS NOT NULL THEN
    RAISE EXCEPTION 'financial period %..% overlaps existing period %',
      NEW.starts_on, NEW.ends_on, v_clash
      USING ERRCODE = '23P01',
            HINT = 'Financial periods must not overlap; adjust the boundaries.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE
    SET search_path = pg_catalog, public;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER financial_periods_no_overlap
  BEFORE INSERT OR UPDATE ON financial_periods
  FOR EACH ROW EXECUTE FUNCTION trg_financial_period_no_overlap();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 2b. Posture repair, found by this migration's own self-audit.
--
--     `reminders` is the one tenant table where row-level security was ENABLED
--     but not FORCED. It is not a cosmetic difference: the H-2 staleness
--     classification and the dashboard's follow-up aggregates both read it, and
--     with FORCE off the table owner is exempt from its own policy — an
--     owner-side query could read or write across tenants. Every other tenant
--     table in this schema is ENABLE + FORCE; this closes the outlier. It can
--     only ever narrow access, never widen it.
-- -----------------------------------------------------------------------------

ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE reminders FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 3. The single classification every surface renders.
--
--    SECURITY INVOKER (the default) on purpose: row-level security still
--    applies, the tenant GUC still decides which rows are visible, and the
--    function can never be a way around the RLS boundary.
--
--    p_cutover is the active term's starts_on. p_term_id is the active term.
--    Both are supplied by the caller because the *declared* contract is that
--    the active term defines the cut-over; the function does not guess one.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth_invoice_scope_buckets(p_term_id uuid, p_cutover date)
RETURNS TABLE (
  bucket          text,
  invoice_count   integer,
  billed_kobo     bigint,
  collected_kobo  bigint,
  outstanding_kobo bigint,
  overdue_kobo    bigint,
  draft_count     integer
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  WITH classified AS (
    SELECT
      CASE
        WHEN i.term_id IS NOT DISTINCT FROM p_term_id AND p_term_id IS NOT NULL THEN 'CURRENT_TERM'
        WHEN p_term_id IS NOT NULL
             AND i.due_date IS NOT NULL
             AND p_cutover IS NOT NULL
             AND i.due_date < p_cutover THEN 'PRIOR_TERM'
        ELSE 'OTHER_TERM'
      END AS bucket,
      i.id,
      i.status,
      i.total_kobo,
      i.paid_kobo,
      i.due_date,
      i.term_id
    FROM invoices i
    WHERE i.organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  ),
  applied AS (
    -- Money actually applied to each invoice, from the allocation table, where
    -- the payment behind it is CONFIRMED. Unallocated credit sitting on a
    -- payment is never counted as collected.
    SELECT a.invoice_id, sum(a.amount_kobo) AS collected_kobo
      FROM payment_allocations a
      JOIN payments p ON p.id = a.payment_id AND p.organization_id = a.organization_id
     WHERE a.organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
       AND a.status = 'ACTIVE'
       AND p.status = 'CONFIRMED'
     GROUP BY a.invoice_id
  )
  SELECT
    c.bucket,
    count(*) FILTER (WHERE c.status <> 'VOID')::integer AS invoice_count,
    coalesce(sum(c.total_kobo) FILTER (WHERE c.status IN ('ISSUED','PARTIALLY_PAID','PAID')), 0)::bigint AS billed_kobo,
    coalesce(sum(coalesce(ap.collected_kobo, 0))
             FILTER (WHERE c.status IN ('ISSUED','PARTIALLY_PAID','PAID')), 0)::bigint AS collected_kobo,
    coalesce(sum(c.total_kobo - c.paid_kobo)
             FILTER (WHERE c.status IN ('ISSUED','PARTIALLY_PAID')), 0)::bigint AS outstanding_kobo,
    coalesce(sum(c.total_kobo - c.paid_kobo)
             FILTER (WHERE c.status IN ('ISSUED','PARTIALLY_PAID')
                       AND c.due_date IS NOT NULL AND c.due_date < current_date), 0)::bigint AS overdue_kobo,
    count(*) FILTER (WHERE c.status = 'DRAFT')::integer AS draft_count
  FROM classified c
  LEFT JOIN applied ap ON ap.invoice_id = c.id
  GROUP BY c.bucket
$$;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 4. The as-of valuation for a financial period.
--
--    "As of" is the period end date, and every figure is filtered by ledger
--    timestamps (invoice issue date, allocation creation, payment creation), so
--    the report for a closed window does not move when later money arrives —
--    which is exactly what makes it usable as boundary evidence.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth_period_valuation(p_period_id uuid)
RETURNS TABLE (
  bucket               text,
  invoice_count        integer,
  billed_kobo          bigint,
  collected_kobo       bigint,
  outstanding_kobo     bigint,
  overdue_kobo         bigint,
  payments_received_kobo        bigint,
  payments_unallocated_kobo     bigint,
  payments_pending_count        integer,
  payments_duplicate_count      integer,
  unallocated_confirmed_count   integer
)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org     uuid;
  v_start   date;
  v_end     date;
  v_term    uuid;
  v_cutover date;
BEGIN
  v_org := NULLIF(current_setting('app.organization_id', true), '')::uuid;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'no tenant context' USING ERRCODE = '42501';
  END IF;

  SELECT p.starts_on, p.ends_on INTO v_start, v_end
    FROM financial_periods p
   WHERE p.id = p_period_id AND p.organization_id = v_org;
  IF v_end IS NULL THEN
    RAISE EXCEPTION 'financial period not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT t.id, t.starts_on INTO v_term, v_cutover
    FROM terms t
   WHERE t.organization_id = v_org AND t.is_current
   LIMIT 1;

  RETURN QUERY
  WITH classified AS (
    SELECT
      CASE
        WHEN i.term_id IS NOT DISTINCT FROM v_term AND v_term IS NOT NULL THEN 'CURRENT_TERM'
        WHEN v_term IS NOT NULL AND i.due_date IS NOT NULL AND v_cutover IS NOT NULL
             AND i.due_date < v_cutover THEN 'PRIOR_TERM'
        ELSE 'OTHER_TERM'
      END AS bucket,
      i.id,
      i.status,
      i.total_kobo,
      i.due_date
    FROM invoices i
    WHERE i.organization_id = v_org
      AND coalesce(i.issue_date, i.created_at::date) <= v_end
  ),
  applied AS (
    SELECT a.invoice_id, sum(a.amount_kobo) AS collected_kobo
      FROM payment_allocations a
      JOIN payments p ON p.id = a.payment_id AND p.organization_id = a.organization_id
     WHERE a.organization_id = v_org
       AND a.status = 'ACTIVE'
       AND p.status = 'CONFIRMED'
       AND a.allocated_at::date <= v_end
     GROUP BY a.invoice_id
  ),
  invoices_at_close AS (
    SELECT
      c.bucket,
      count(*)::integer AS invoice_count,
      coalesce(sum(c.total_kobo) FILTER (WHERE c.status IN ('ISSUED','PARTIALLY_PAID','PAID')), 0)::bigint AS billed_kobo,
      coalesce(sum(coalesce(ap.collected_kobo, 0))
               FILTER (WHERE c.status IN ('ISSUED','PARTIALLY_PAID','PAID')), 0)::bigint AS collected_kobo,
      -- "Owed as of the window end" is derived from the AS-OF money, not from
      -- the invoice's CURRENT status: a payment allocated after the window flips
      -- an invoice to PAID today, and reading that status would move a closed
      -- report's outstanding figure. (Measured: a post-window allocation moved
      -- a closed window's outstanding by 21,000 kobo.) An invoice that was paid
      -- as of the window shows total - collected = 0 and contributes nothing; a
      -- voided invoice is an explicit correction and is excluded.
      coalesce(sum(greatest(c.total_kobo - coalesce(ap.collected_kobo, 0), 0))
               FILTER (WHERE c.status IN ('ISSUED','PARTIALLY_PAID','PAID')
                         AND greatest(c.total_kobo - coalesce(ap.collected_kobo, 0), 0) > 0), 0)::bigint AS outstanding_kobo,
      coalesce(sum(greatest(c.total_kobo - coalesce(ap.collected_kobo, 0), 0))
               FILTER (WHERE c.status IN ('ISSUED','PARTIALLY_PAID','PAID')
                         AND greatest(c.total_kobo - coalesce(ap.collected_kobo, 0), 0) > 0
                         AND c.due_date IS NOT NULL AND c.due_date < v_end), 0)::bigint AS overdue_kobo
    FROM classified c
    LEFT JOIN applied ap ON ap.invoice_id = c.id
    GROUP BY c.bucket
  ),
  payment_window AS (
    SELECT
      coalesce(sum(p.amount_kobo) FILTER (WHERE p.status = 'CONFIRMED'
                AND p.created_at::date BETWEEN v_start AND v_end), 0)::bigint AS received_kobo,
      coalesce(sum(p.unallocated_kobo) FILTER (WHERE p.status = 'CONFIRMED'
                AND p.created_at::date <= v_end), 0)::bigint AS unallocated_kobo,
      count(*) FILTER (WHERE p.status = 'PENDING' AND p.created_at::date <= v_end)::integer AS pending_count,
      count(*) FILTER (WHERE p.status = 'DUPLICATE_SUSPECT' AND p.created_at::date <= v_end)::integer AS duplicate_count,
      count(*) FILTER (WHERE p.status = 'CONFIRMED' AND p.unallocated_kobo > 0
                AND p.created_at::date <= v_end)::integer AS unallocated_confirmed_count
    FROM payments p
    WHERE p.organization_id = v_org
  )
  SELECT
    b.bucket,
    b.invoice_count,
    b.billed_kobo,
    b.collected_kobo,
    b.outstanding_kobo,
    b.overdue_kobo,
    w.received_kobo,
    w.unallocated_kobo,
    w.pending_count,
    w.duplicate_count,
    w.unallocated_confirmed_count
  FROM invoices_at_close b
  CROSS JOIN payment_window w
  UNION ALL
  -- The tie-back row: every bucket summed. A caller that reports a headline
  -- without this row, or a headline that disagrees with it, is a bug by
  -- construction — this is what the H-2 reconciliation tests assert.
  SELECT
    'ALL_TERM',
    coalesce(sum(b.invoice_count), 0)::integer,
    coalesce(sum(b.billed_kobo), 0)::bigint,
    coalesce(sum(b.collected_kobo), 0)::bigint,
    coalesce(sum(b.outstanding_kobo), 0)::bigint,
    coalesce(sum(b.overdue_kobo), 0)::bigint,
    -- Aggregates, not grouped columns: a period with no invoices yet must still
    -- return its ALL_TERM row (a grouped aggregate over an empty set returns
    -- NOTHING, which would have made an empty period look like a missing one).
    max(w.received_kobo)::bigint,
    max(w.unallocated_kobo)::bigint,
    max(w.pending_count)::integer,
    max(w.duplicate_count)::integer,
    max(w.unallocated_confirmed_count)::integer
  FROM invoices_at_close b
  CROSS JOIN payment_window w;
END;
$$;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 5. Grants. The runtime role reads the buckets and the valuation; it may
--    maintain its own scope setting and its own periods, and it may never
--    delete a period (deletion would erase boundary evidence).
-- -----------------------------------------------------------------------------

GRANT EXECUTE ON FUNCTION auth_invoice_scope_buckets(uuid, date) TO scolaira_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_period_valuation(uuid) TO scolaira_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_invoice_scope_buckets(uuid, date) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_period_valuation(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON surface_scope_settings TO scolaira_app;
--> statement-breakpoint
REVOKE DELETE ON surface_scope_settings FROM scolaira_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON financial_periods TO scolaira_app;
--> statement-breakpoint
REVOKE DELETE ON financial_periods FROM scolaira_app;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 6. Self-audit: the migration refuses to complete unless the invariants it
--    claims are actually true in this database.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  v_bad   text;
  v_n     integer;
  v_fn    text;
BEGIN
  -- Every table whose aggregates feed a headline must keep RLS enforced.
  SELECT string_agg(c.relname, ',') INTO v_bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('invoices', 'payments', 'payment_allocations', 'terms', 'students',
                       'reminders', 'surface_scope_settings', 'financial_periods')
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '[H-2] RLS must stay enabled AND forced on %', v_bad;
  END IF;

  -- The classification function must never be a bypass around RLS: a SECURITY
  -- DEFINER aggregate could read every tenant's invoices.
  FOR v_fn IN SELECT unnest(ARRAY['auth_invoice_scope_buckets', 'auth_period_valuation']) LOOP
    IF EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = v_fn AND p.prosecdef
    ) THEN
      RAISE EXCEPTION '[H-2] % must be SECURITY INVOKER (RLS must still apply)', v_fn;
    END IF;
  END LOOP;

  -- The classification must partition the book: exactly three buckets, and the
  -- sum of the three equals the all-term figure the same function returns.
  SELECT count(*) INTO v_n FROM auth_invoice_scope_buckets(NULL, NULL);
  SELECT string_agg(DISTINCT bucket, ',' ORDER BY bucket) INTO v_bad
    FROM auth_invoice_scope_buckets(NULL, NULL);
  IF v_bad IS NOT NULL AND v_bad NOT IN ('CURRENT_TERM', 'OTHER_TERM', 'PRIOR_TERM',
                                         'CURRENT_TERM,OTHER_TERM', 'CURRENT_TERM,PRIOR_TERM',
                                         'OTHER_TERM,PRIOR_TERM', 'CURRENT_TERM,OTHER_TERM,PRIOR_TERM') THEN
    RAISE EXCEPTION '[H-2] unexpected classification bucket(s): %', v_bad;
  END IF;

  -- Deletion of boundary evidence must be impossible for the runtime role.
  IF has_table_privilege('scolaira_app', 'financial_periods', 'DELETE')
     OR has_table_privilege('scolaira_app', 'surface_scope_settings', 'DELETE') THEN
    RAISE EXCEPTION '[H-2] the runtime role must not be able to delete scope settings or financial periods';
  END IF;

  RAISE NOTICE '[H-2] invoice classification live; % bucket row(s) returned for this tenant', v_n;
  RAISE NOTICE '[H-2] one declared scope per surface, explicit pagination everywhere, term-boundary close control installed';
END
$$;
