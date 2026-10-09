-- =============================================================================
-- 0052_opening_balances.sql
-- Phase 2: opening balances — the money a school carries in when it starts on
-- SCOLAIRA, recorded honestly, and posted ONLY where the ledger can represent it.
--
-- WHY THIS EXISTS (the gap, measured)
--   Before this migration a school arriving with existing debt had exactly two
--   doors, and both were wrong:
--     * add the child through onboarding (`POST /api/onboarding/students/import`)
--       and then bill the current term — which silently drops everything the
--       family owed before today; or
--     * hand-create an invoice for the old amount — which books historical debt
--       as THIS term's billing. `auth_invoice_scope_buckets` (0048) classifies
--       `i.term_id IS NOT DISTINCT FROM p_term_id` as CURRENT_TERM *before* it
--       ever looks at `due_date`, so an invoice minted on the active term is
--       reported as this-term billing no matter what date is written on it.
--   The pilot-readiness audit calls opening balances the last hard onboarding
--   blocker: a school that cannot carry in its balances cannot reconcile on day
--   one, so it will not switch.
--
-- WHAT THIS MIGRATION DOES NOT DO — two documented conflicts, not workarounds
--
--   (1) A carry-in CREDIT / overpayment cannot be posted, and this table makes
--       that a database rule rather than a convention. A credit would have to be
--       either a `payments` row or a negative invoice line, and both are refused
--       by existing invariants:
--         * `payments` is money received — `auth_period_valuation` sums it as
--           collections, `payments_amount_positive` requires `amount_kobo > 0`,
--           `pay_unalloc_le_amount` requires
--           `0 <= unallocated_kobo <= amount_kobo`, and a payment requires
--           allocation rows. A negative "payment" would fabricate a deposit and
--           inflate the collections figure of a school that never received one.
--         * invoice lines are charges: `amount_kobo`/`unit_rate_kobo` are the
--           `kobo_value` domain, `CHECK (VALUE >= 0)`, and
--           `invoice_status.total_due_kobo` is derived from live lines.
--       So a credit is RECORDED here (signed, with its evidence) and reported as
--       an unapplied opening credit. Applying it needs a ledger concept SCOLAIRA
--       does not have yet — a signed opening balance that collections can consume
--       without pretending money arrived. That belongs with Phase 4/5 (real
--       payments and reconciliation), not here. Per the standing rule, the
--       invariant wins and the conflict is written down.
--
--   (2) A current-term amount that has not been billed yet must NOT be posted
--       from here either, because term billing (`billTerm`) is the only code
--       allowed to create this term's invoices, and it derives them from fee
--       assignments and enrolments. A second door that mints current-term
--       invoices would double-charge a child the moment billing ran. CURRENT_TERM
--       _UNBILLED rows are therefore a *to-do*: they tell the school "this is
--       billing work, not a carry-in", and the guide says so.
--
--   Only HISTORICAL_BALANCE can reach POSTED. It mints a real invoice on a PRIOR
--   term, which is exactly what the existing "Prior-term debt" bucket already
--   reports — so no SQL function, policy, trigger or state machine in the ledger
--   is edited by this migration. The carry-in debt stops being a comment in a
--   spreadsheet and becomes the same audited, allocatable, receiptable invoice as
--   any other.
--
-- SCOPE / SAFETY
--   ADDITIVE ONLY: two enums, one table, its indexes, its RLS policies, three
--   triggers, grants. It creates no FK into a protected table that did not
--   already exist, alters no existing table, replaces no policy and no function.
--   `opening_balances` is append-and-transition, never update-in-place-after-review
--   and never delete: the same discipline `waivers` (0020) and the financial
--   tables use, backed here by `trg_block_financial_delete` and a RESTRICTIVE
--   deny policy — the one shape that actually denies a delete (measured in 0050:
--   a PERMISSIVE `FOR DELETE USING (false)` next to a `FOR ALL` policy adds
--   TRUE OR FALSE, i.e. nothing).
-- =============================================================================

--> statement-breakpoint

CREATE TYPE opening_balance_category AS ENUM (
  'CURRENT_TERM_UNBILLED',
  'HISTORICAL_BALANCE',
  'CREDIT_OVERPAYMENT',
  'UNVERIFIED'
);
--> statement-breakpoint

CREATE TYPE opening_balance_status AS ENUM (
  'DRAFT',
  'APPROVED',
  'REJECTED',
  'POSTED',
  'REVERSED'
);
--> statement-breakpoint

CREATE TABLE opening_balances (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  student_id      uuid NOT NULL REFERENCES students (id) ON DELETE RESTRICT,

  -- The four categories the audit demanded, and nothing else: current-term
  -- invoices, historical balances, credits/overpayments, unknown/unverified.
  -- The point of the split is that they must never be added together.
  category        opening_balance_category NOT NULL,

  -- What the school typed: a magnitude. `kobo_value` already refuses a negative,
  -- so an amount can never be smuggled past the ledger's non-negotiable rule.
  amount_kobo     kobo_value NOT NULL,
  -- What it means for what the family owes. `signed_kobo_value` is the domain
  -- this schema already provides for a number that may go below zero, and the
  -- CHECK below derives it from `category` — the sign is never typed by hand, so
  -- there is no way to record a "credit" that ADDS to what is owed.
  signed_amount_kobo signed_kobo_value NOT NULL,

  -- The date the figure was true as at. Carries-in debt without an as-at date is
  -- unauditable, and it is what the posting guard below checks the term against.
  as_at           date NOT NULL,
  -- The term this balance belongs to, when the school knows. Nullable on purpose:
  -- a school that has not recorded its prior term yet can still capture the
  -- figure; it simply cannot post it until a prior term exists.
  term_id         uuid REFERENCES terms (id) ON DELETE RESTRICT,

  -- Where the number came from, in the recorder's own words, and an optional
  -- pointer to the paper. A figure with no source note is not a record, it is a
  -- guess, and this table refuses it.
  source_note     text NOT NULL,
  evidence_ref    varchar(160),

  status          opening_balance_status NOT NULL DEFAULT 'DRAFT',
  created_by      uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  reviewed_by     uuid REFERENCES users (id) ON DELETE RESTRICT,
  reviewed_at     timestamptz,
  review_note     text,
  -- Derived from (reviewed_by = created_by). Kept as its own column because
  -- "the same person recorded and approved this" must survive in the row, not
  -- only be re-derivable: it is the fact an auditor asks about first when a
  -- number enters a ledger. Pilot schools are frequently one-person offices, so
  -- self-review is permitted — it is never permitted to be invisible.
  self_reviewed   boolean NOT NULL DEFAULT false,

  -- The invoice this balance became, when it was posted. NULL for every category
  -- that cannot be posted (see the CHECK below).
  posted_invoice_id uuid REFERENCES invoices (id) ON DELETE RESTRICT,
  posted_at       timestamptz,
  reversal_reason text,
  reversed_at     timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT opening_balances_amount_positive CHECK (amount_kobo > 0),
  CONSTRAINT opening_balances_sign_matches_category CHECK (
    (category = 'CREDIT_OVERPAYMENT' AND signed_amount_kobo = -amount_kobo)
    OR
    (category <> 'CREDIT_OVERPAYMENT' AND signed_amount_kobo = amount_kobo)
  ),
  CONSTRAINT opening_balances_source_note_check CHECK (
    length(btrim(source_note)) BETWEEN 5 AND 500
  ),
  CONSTRAINT opening_balances_review_pair_check CHECK (
    (reviewed_at IS NULL) = (reviewed_by IS NULL)
  ),
  CONSTRAINT opening_balances_posted_pair_check CHECK (
    (posted_invoice_id IS NULL) = (posted_at IS NULL)
  ),
  CONSTRAINT opening_balances_posted_needs_review CHECK (
    status = 'DRAFT' OR reviewed_by IS NOT NULL
  ),
  -- THE HEADROOM-FREE RULE. Everything except a historical balance is unpostable
  -- by construction, and a historical balance cannot be posted without the invoice
  -- it points at. A future caller that forgets the application-layer check hits
  -- this instead of the ledger.
  CONSTRAINT opening_balances_only_history_posts CHECK (
    status <> 'POSTED' OR category = 'HISTORICAL_BALANCE'
  ),
  CONSTRAINT opening_balances_posted_needs_target CHECK (
    status <> 'POSTED'
    OR (posted_invoice_id IS NOT NULL AND posted_at IS NOT NULL AND term_id IS NOT NULL)
  ),
  CONSTRAINT opening_balances_rejected_needs_reason CHECK (
    status <> 'REJECTED' OR length(btrim(coalesce(review_note, ''))) > 0
  ),
  CONSTRAINT opening_balances_reversed_needs_reason CHECK (
    status <> 'REVERSED' OR length(btrim(coalesce(reversal_reason, ''))) > 0
  ),
  -- Kept as a constraint even though `trg_opening_balance_transition` derives the
  -- value: it is the statement of the rule, and it survives a future edit that
  -- drops the trigger.
  CONSTRAINT opening_balances_self_reviewed_is_derived CHECK (
    self_reviewed = (reviewed_by IS NOT NULL AND reviewed_by = created_by)
  )
);
--> statement-breakpoint

-- The register is read by the guide and by finance, per student and per status.
CREATE INDEX opening_balances_org_status_category_idx
  ON opening_balances (organization_id, status, category, created_at DESC);
--> statement-breakpoint
CREATE INDEX opening_balances_student_idx
  ON opening_balances (student_id, status);
--> statement-breakpoint

-- THE ANTI-DOUBLE-COUNTING INDEX. Recording the same carry-in twice (two people,
-- one spreadsheet) is the single most likely way this feature corrupts a ledger,
-- so it is refused where it matters: one POSTED historical balance per student per
-- term. Unposted rows are unlimited on purpose — a school may refine a figure,
-- reject it and record another.
CREATE UNIQUE INDEX opening_balances_one_posted_per_student_term_idx
  ON opening_balances (organization_id, student_id, term_id)
  WHERE status = 'POSTED' AND category = 'HISTORICAL_BALANCE' AND term_id IS NOT NULL;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Tenant isolation. Same shape as every current tenant table (0050 is the
-- reference): platform-admin branch OR HMAC-bound tenant authorisation AND the
-- row's own organization. There is deliberately NO public policy and NO bootstrap
-- branch: opening balances are a school's financial record and no unauthenticated
-- or identity-free path has any business reading them.
-- -----------------------------------------------------------------------------
ALTER TABLE opening_balances ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE opening_balances FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY opening_balances_tenant_isolation ON opening_balances
  FOR SELECT USING (auth_is_platform_admin_authorized()
                    OR (auth_is_tenant_authorized()
                        AND organization_id = _app_current_org_uuid()));
--> statement-breakpoint
CREATE POLICY opening_balances_tenant_isolation_write ON opening_balances
  FOR INSERT WITH CHECK (auth_is_platform_admin_authorized()
                         OR (auth_is_tenant_authorized()
                             AND organization_id = _app_current_org_uuid()));
--> statement-breakpoint
CREATE POLICY opening_balances_tenant_isolation_update ON opening_balances
  FOR UPDATE USING (auth_is_platform_admin_authorized()
                    OR (auth_is_tenant_authorized()
                        AND organization_id = _app_current_org_uuid()))
  WITH CHECK (auth_is_platform_admin_authorized()
              OR (auth_is_tenant_authorized()
                  AND organization_id = _app_current_org_uuid()));
--> statement-breakpoint
CREATE POLICY opening_balances_no_delete ON opening_balances
  AS RESTRICTIVE FOR DELETE USING (false);
--> statement-breakpoint

-- organization_id always comes from the session, never from the caller — the
-- existing 0002-hardened trigger that silently overwrites a forged value.
CREATE OR REPLACE TRIGGER a_opening_balances_set_org
  BEFORE INSERT ON opening_balances
  FOR EACH ROW EXECUTE FUNCTION trg_set_org_from_context();
--> statement-breakpoint

CREATE OR REPLACE TRIGGER set_updated_at_opening_balances
  BEFORE UPDATE ON opening_balances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- Opening balances are a financial record: no erasing, correct by reversing.
CREATE OR REPLACE TRIGGER block_financial_delete_opening_balances
  BEFORE DELETE ON opening_balances
  FOR EACH ROW EXECUTE FUNCTION trg_block_financial_delete();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The state machine, enforced here rather than by convention.
--
--   DRAFT    -> APPROVED | REJECTED
--   APPROVED -> POSTED   | REJECTED
--   POSTED   -> REVERSED
--   REJECTED, REVERSED are terminal.
--
-- `trg_enforce_status_transitions` (0001) is attached to a fixed list of tables
-- and `can_transition` carries a CASE per entity; this table is not in either,
-- and re-defining that shared function to add it would touch the guard that
-- protects invoices, payments and receipts. A dedicated trigger on the new table
-- gives the same guarantee with a smaller blast radius, so the protected shared
-- machinery is left exactly as it is.
--
-- The POSTED branch is where "do not corrupt the ledger" is actually enforced.
-- A carry-in may only become an invoice that the H-2 buckets classify as PRIOR
-- TERM, which — measured against 0048:256-262 — requires three things at once:
-- the invoice is on a term that is not the current term, that term is not flagged
-- current, and the invoice's due date falls BEFORE the current term starts. Pass
-- any of those and the amount shows up as historical debt, which is what the
-- school is owed; fail any of them and the statement raises instead of quietly
-- relabelling history as this-term billing.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_opening_balance_transition()
RETURNS TRIGGER AS $$
DECLARE
  v_invoice_student uuid;
  v_invoice_term    uuid;
  v_invoice_due     date;
  v_term_starts     date;
  v_term_is_current boolean;
  v_cur_id          uuid;
  v_cur_starts      date;
BEGIN
  -- DERIVED FIRST, on INSERT as well as UPDATE. `self_reviewed` is not something a
  -- writer decides, it is a fact about two other columns, so it is computed here
  -- and the CHECK constraint below makes disagreement impossible. A BEFORE trigger
  -- rather than a plain CHECK-with-default because a CHECK cannot write a value:
  -- without this, an importer or a seed that set `reviewed_by = created_by` would
  -- either fail the constraint or leave the flag lying, and neither is a control.
  NEW.self_reviewed := (NEW.reviewed_by IS NOT NULL AND NEW.reviewed_by = NEW.created_by);

  IF OLD IS NULL THEN
    -- INSERT: nothing transitions; the derivation above is the whole job.
    RETURN NEW;
  END IF;

  -- A non-status edit is legal only while the row is still a draft. Once a
  -- figure has been reviewed, its amount and category are frozen; correcting it
  -- means rejecting or reversing and recording a new row, so the trail shows the
  -- mistake rather than hiding it.
  IF NEW.status = OLD.status THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'opening balance % is % and is immutable; record a new one and reject or reverse this', OLD.id, OLD.status
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status IN ('APPROVED', 'REJECTED') THEN
    IF NEW.reviewed_by IS NULL OR NEW.reviewed_at IS NULL THEN
      RAISE EXCEPTION 'an opening balance must be reviewed by a named person (reviewed_by, reviewed_at) before it leaves DRAFT'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'REJECTED' AND length(btrim(coalesce(NEW.review_note, ''))) = 0 THEN
      RAISE EXCEPTION 'rejecting an opening balance requires a review_note so the reason is on the record'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.status = 'APPROVED' AND NEW.status = 'POSTED' THEN
    IF NEW.posted_invoice_id IS NULL OR NEW.posted_at IS NULL THEN
      RAISE EXCEPTION 'POSTED requires the invoice this balance became'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.status = 'APPROVED' AND NEW.status = 'REJECTED' THEN
    IF length(btrim(coalesce(NEW.review_note, ''))) = 0 THEN
      RAISE EXCEPTION 'rejecting an approved opening balance requires a review_note'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.status = 'POSTED' AND NEW.status = 'REVERSED' THEN
    IF length(btrim(coalesce(NEW.reversal_reason, ''))) = 0 THEN
      RAISE EXCEPTION 'reversing a posted opening balance requires a reversal_reason'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.status = 'DRAFT' AND NEW.status = 'POSTED' THEN
    RAISE EXCEPTION 'an opening balance must be APPROVED before it is posted (found DRAFT -> POSTED)'
      USING ERRCODE = 'check_violation';
  ELSE
    RAISE EXCEPTION 'Invalid opening-balance status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Entering POSTED: verify the target invoice against the ledger's own truth.
  IF NEW.status = 'POSTED' AND OLD.status <> 'POSTED' THEN
    IF NEW.category <> 'HISTORICAL_BALANCE' THEN
      RAISE EXCEPTION 'a % opening balance cannot be posted; only HISTORICAL_BALANCE has a place in the ledger', NEW.category
        USING ERRCODE = 'check_violation',
              HINT = 'A credit needs a signed-balance concept the ledger does not have yet; an unbilled current-term amount must go through term billing.';
    END IF;

    SELECT i.student_id, i.term_id, i.due_date, t.starts_on, t.is_current
      INTO v_invoice_student, v_invoice_term, v_invoice_due, v_term_starts, v_term_is_current
      FROM invoices i
      JOIN terms t ON t.id = i.term_id
     WHERE i.id = NEW.posted_invoice_id;

    IF v_invoice_student IS NULL THEN
      RAISE EXCEPTION 'opening balance % points at an invoice that does not exist', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_invoice_student <> NEW.student_id THEN
      RAISE EXCEPTION 'invoice % bills a different student than the opening balance', NEW.posted_invoice_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_invoice_term <> NEW.term_id THEN
      RAISE EXCEPTION 'invoice % is on term %, not the term this balance was recorded against', NEW.posted_invoice_id, v_invoice_term
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_term_is_current THEN
      RAISE EXCEPTION 'a carry-in balance may not be posted on the current term; that term is billed from fee assignments, not from opening balances'
        USING ERRCODE = 'check_violation',
              HINT = 'Record it as CURRENT_TERM_UNBILLED and run term billing, or post it against the prior term it belongs to.';
    END IF;

    SELECT t.id, t.starts_on
      INTO v_cur_id, v_cur_starts
      FROM terms t
     WHERE t.organization_id = NEW.organization_id
       AND t.is_current
     ORDER BY t.starts_on DESC
     LIMIT 1;

    IF v_cur_id IS NOT NULL THEN
      IF v_invoice_term = v_cur_id THEN
        RAISE EXCEPTION 'a carry-in balance may not be posted on the active term (%)', v_cur_id
          USING ERRCODE = 'check_violation';
      END IF;
      IF v_invoice_due IS NULL OR v_invoice_due >= v_cur_starts THEN
        RAISE EXCEPTION 'the posted invoice is not due before the active term begins (due_date %, active term starts %), so the H-2 buckets would classify it as OTHER_TERM, not PRIOR_TERM',
          v_invoice_due, v_cur_starts
          USING ERRCODE = 'check_violation',
                HINT = 'Set due_date to the as-at date of the balance, which must fall inside the prior term.';
      END IF;
    END IF;

    IF v_term_starts > NEW.as_at THEN
      RAISE EXCEPTION 'the balance is stated as at % but the term begins %; a carry-in cannot belong to a term that had not started', NEW.as_at, v_term_starts
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE
    SET search_path = pg_catalog, public;
--> statement-breakpoint

CREATE OR REPLACE TRIGGER opening_balances_transition
  BEFORE INSERT OR UPDATE ON opening_balances
  FOR EACH ROW EXECUTE FUNCTION trg_opening_balance_transition();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Privileges, stated exactly as they end up. The runtime role may read, record and
-- move a row through its lifecycle. It may not delete (blocked at row level by the
-- RESTRICTIVE policy above and by trigger — the grant cannot override either, and
-- `scripts/migrate.ts` re-grants DELETE on all tables after every run, which is
-- precisely why neither of those two is the enforcement point of record). The four
-- privileges R1 (0044) revoked are revoked here too, because ALTER DEFAULT
-- PRIVILEGES hands them to every new table and TRUNCATE is not subject to
-- row-level security.
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON opening_balances TO scolaira_app;
--> statement-breakpoint
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON opening_balances FROM scolaira_app;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Self-audit: this migration refuses to complete unless the guarantees it claims
-- are true in this database (the discipline of 0042/0046/0048/0049/0050).
-- -----------------------------------------------------------------------------
DO $audit$
DECLARE
  v_policies    integer;
  v_checks      integer;
  v_rls         boolean;
  v_force       boolean;
  v_grants      text[];
  v_leaked      text[];
  v_triggers    integer;
BEGIN
  SELECT relrowsecurity, relforcerowsecurity INTO v_rls, v_force
    FROM pg_class WHERE relname = 'opening_balances';
  IF NOT v_rls OR NOT v_force THEN
    RAISE EXCEPTION 'Phase 2 audit: opening_balances must have RLS enabled AND forced (rls=%, force=%)',
      v_rls, v_force;
  END IF;

  SELECT count(*) INTO v_policies
    FROM pg_policies WHERE tablename = 'opening_balances';
  IF v_policies <> 4 THEN
    RAISE EXCEPTION 'Phase 2 audit: expected 4 policies on opening_balances, found %', v_policies;
  END IF;

  -- No bootstrap branch, ever: this is a tenant's financial record.
  SELECT count(*) INTO v_triggers
    FROM pg_policy
   WHERE polrelid = 'opening_balances'::regclass
     AND (pg_get_expr(polqual, polrelid) LIKE '%auth_bootstrap%'
          OR pg_get_expr(polqual, polrelid) LIKE '%true%');
  IF v_triggers > 0 THEN
    RAISE EXCEPTION 'Phase 2 audit: opening_balances carries an unconditional or bootstrap policy branch';
  END IF;

  SELECT count(*) INTO v_triggers
    FROM pg_policy
   WHERE polrelid = 'opening_balances'::regclass
     AND polname = 'opening_balances_no_delete'
     AND polpermissive = false
     AND pg_get_expr(polqual, polrelid) = 'false';
  IF v_triggers < 1 THEN
    RAISE EXCEPTION 'Phase 2 audit: opening_balances has no RESTRICTIVE deny policy for DELETE';
  END IF;

  SELECT count(*) INTO v_checks
    FROM pg_constraint
   WHERE conrelid = 'opening_balances'::regclass AND contype = 'c';
  IF v_checks < 10 THEN
    RAISE EXCEPTION 'Phase 2 audit: expected at least 10 CHECK constraints on opening_balances, found %', v_checks;
  END IF;

  -- The three triggers this table depends on, by name, so a rename or a dropped
  -- migration fails here rather than in production.
  SELECT count(*) INTO v_triggers
    FROM pg_trigger
   WHERE tgrelid = 'opening_balances'::regclass
     AND NOT tgisinternal
     AND tgname IN ('a_opening_balances_set_org',
                    'set_updated_at_opening_balances',
                    'block_financial_delete_opening_balances',
                    'opening_balances_transition');
  IF v_triggers <> 4 THEN
    RAISE EXCEPTION 'Phase 2 audit: opening_balances must carry 4 triggers (org stamp, updated_at, delete block, state machine), found %', v_triggers;
  END IF;

  -- The anti-double-counting index must be partial exactly as designed: a
  -- full unique index would make it impossible to record a corrected figure.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     JOIN pg_class c ON c.oid = i.indrelid
     JOIN pg_class ic ON ic.oid = i.indexrelid
    WHERE c.relname = 'opening_balances'
      AND ic.relname = 'opening_balances_one_posted_per_student_term_idx'
      AND i.indisunique
      AND i.indpred IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Phase 2 audit: the posted-once-per-student-and-term partial unique index is missing or is not partial';
  END IF;

  SELECT array_agg(privilege_type ORDER BY privilege_type) INTO v_grants
    FROM information_schema.role_table_grants
   WHERE table_name = 'opening_balances' AND grantee = 'scolaira_app';
  IF NOT (v_grants @> ARRAY['INSERT','SELECT','UPDATE']) THEN
    RAISE EXCEPTION 'Phase 2 audit: scolaira_app is missing required DML grants on opening_balances: %', v_grants;
  END IF;

  SELECT array_agg(p.priv) INTO v_leaked
    FROM unnest(ARRAY['TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) AS p(priv)
   WHERE has_table_privilege('scolaira_app', 'opening_balances', p.priv);
  IF v_leaked IS NOT NULL THEN
    RAISE EXCEPTION 'Phase 2 audit: runtime role holds RLS-bypassing privileges on opening_balances: %', v_leaked;
  END IF;

  RAISE NOTICE 'Phase 2 audit: opening_balances ok — % policies, FORCE RLS, % CHECK constraints, 4 triggers, posted-once index present, no TRUNCATE/REFERENCES/TRIGGER/MAINTAIN, deletes denied at row level and by trigger.',
    v_policies, v_checks;
END
$audit$;
--> statement-breakpoint
