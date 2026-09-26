-- =============================================================================
-- 0020_term_billing.sql — M8 controlled term billing
--
-- This migration establishes the database boundary for controlled billing:
--   * authoritative fee defaults;
--   * term billing timestamps and state consistency;
--   * a denormalized invoice-line billing key because PostgreSQL cannot put
--     parent invoice columns in a child-table unique index;
--   * immutable, line-attached waivers with signed line adjustments;
--   * structural write locks so billing sees a coherent cohort/fee structure;
--   * tenant RLS and least-privilege grants for the new table.
--
-- Formal reasoning is recorded in M8_DATABASE_INVARIANTS.md.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Fee defaults and term billing metadata
-- -----------------------------------------------------------------------------
ALTER TABLE fee_definitions
  ADD COLUMN IF NOT EXISTS default_amount_kobo kobo_value NOT NULL DEFAULT 0;

ALTER TABLE terms
  ADD COLUMN IF NOT EXISTS billed_at timestamptz,
  ADD COLUMN IF NOT EXISTS billed_by uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'terms_billed_by_fkey'
       AND conrelid = 'terms'::regclass
  ) THEN
    ALTER TABLE terms
      ADD CONSTRAINT terms_billed_by_fkey
      FOREIGN KEY (billed_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END;
$$;

-- The existing enum transition guard still owns the legal status transitions.
-- This CHECK prevents a direct UPDATE from manufacturing a BILLED term without
-- the corresponding billing flag, or setting billed=true on an ACTIVE term.
ALTER TABLE terms
  ADD CONSTRAINT terms_billing_state_consistent CHECK (
    (status <> 'BILLED' OR billed = true)
    AND (billed = false OR status IN ('BILLED', 'CLOSED'))
  );
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 2. Fee-assignment configuration uniqueness and positive active amounts
-- -----------------------------------------------------------------------------
-- PostgreSQL's ordinary UNIQUE constraint treats NULL class_id values as
-- distinct. This partial index makes the school-wide assignment unique while
-- retaining one class-specific amount per class.
CREATE UNIQUE INDEX fee_assign_orgwide_unique_idx
  ON fee_assignments (organization_id, fee_definition_id, term_id)
  WHERE class_id IS NULL;

ALTER TABLE fee_assignments
  ADD CONSTRAINT fee_assign_active_positive
  CHECK (status <> 'ACTIVE' OR amount_kobo > 0);
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 3. Invoice-line billing key
-- -----------------------------------------------------------------------------
ALTER TABLE invoice_lines
  ADD COLUMN IF NOT EXISTS billing_student_id uuid,
  ADD COLUMN IF NOT EXISTS billing_term_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'invoice_lines_billing_student_fkey'
       AND conrelid = 'invoice_lines'::regclass
  ) THEN
    ALTER TABLE invoice_lines
      ADD CONSTRAINT invoice_lines_billing_student_fkey
      FOREIGN KEY (billing_student_id) REFERENCES students(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'invoice_lines_billing_term_fkey'
       AND conrelid = 'invoice_lines'::regclass
  ) THEN
    ALTER TABLE invoice_lines
      ADD CONSTRAINT invoice_lines_billing_term_fkey
      FOREIGN KEY (billing_term_id) REFERENCES terms(id) ON DELETE RESTRICT;
  END IF;
END;
$$;

-- A line can be either an ad-hoc line (no fee assignment and no billing key)
-- or a controlled term-billing line (all key pieces present). The trigger below
-- additionally proves that the key matches its parent invoice and assignment.
ALTER TABLE invoice_lines
  ADD CONSTRAINT invoice_lines_billing_key_pair CHECK (
    (billing_student_id IS NULL AND billing_term_id IS NULL)
    OR (billing_student_id IS NOT NULL AND billing_term_id IS NOT NULL
        AND fee_assignment_id IS NOT NULL)
  );

-- M5/M6 used adjustment_kobo for non-negative surcharges. M8 needs a signed
-- adjustment because a waiver lowers a line. amount_kobo remains a non-negative
-- kobo_value and the existing exact amount formula remains in force.
ALTER TABLE invoice_lines
  DROP CONSTRAINT IF EXISTS inv_lines_adjustment_nonneg;

CREATE UNIQUE INDEX invoice_lines_term_fee_student_unique_idx
  ON invoice_lines (organization_id, billing_student_id, billing_term_id, fee_assignment_id)
  WHERE fee_assignment_id IS NOT NULL;

CREATE INDEX invoice_lines_billing_student_term_idx
  ON invoice_lines (organization_id, billing_student_id, billing_term_id);
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 4. Waiver reason + immutable waiver table
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'waiver_reason') THEN
    CREATE TYPE waiver_reason AS ENUM (
      'SCHOLARSHIP', 'SIBLING_DISCOUNT', 'STAFF_CHILD', 'EARLY_PAYMENT', 'OTHER'
    );
  END IF;
END;
$$;

CREATE TABLE waivers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_line_id uuid NOT NULL REFERENCES invoice_lines(id) ON DELETE RESTRICT,
  reason          waiver_reason NOT NULL,
  amount_kobo     kobo_value NOT NULL,
  note            text,
  approved_by     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT waivers_amount_positive CHECK (amount_kobo > 0),
  CONSTRAINT waivers_note_length CHECK (note IS NULL OR length(note) <= 500)
);

CREATE UNIQUE INDEX waivers_invoice_line_unique_idx ON waivers(invoice_line_id);
CREATE INDEX waivers_org_created_idx ON waivers(organization_id, created_at DESC);
CREATE INDEX waivers_org_reason_idx ON waivers(organization_id, reason);
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 5. Structural locks and configuration guards
-- -----------------------------------------------------------------------------
-- Billing locks the term FOR UPDATE. Enrollments take FOR SHARE, so an
-- enrollment that committed before billing is included and one that starts
-- during billing waits until the bill transaction commits.
CREATE OR REPLACE FUNCTION trg_m8_enrollment_term_lock()
RETURNS trigger AS $$
DECLARE
  v_term_id uuid;
  v_org_id uuid;
  v_status term_status;
BEGIN
  v_term_id := COALESCE(NEW.term_id, OLD.term_id);
  v_org_id := COALESCE(NEW.organization_id, OLD.organization_id);

  SELECT status INTO v_status
    FROM terms
   WHERE id = v_term_id
     AND organization_id = v_org_id
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Enrollment term is not visible in the active organization'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_status = 'CLOSED' THEN
    RAISE EXCEPTION 'Cannot change enrollments for a CLOSED term'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND v_status IN ('BILLED', 'CLOSED')
     AND (NEW.student_id IS DISTINCT FROM OLD.student_id
          OR NEW.class_id IS DISTINCT FROM OLD.class_id
          OR NEW.term_id IS DISTINCT FROM OLD.term_id) THEN
    RAISE EXCEPTION 'Cannot move an enrollment inside a BILLED term; use an explicit correction workflow'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE TRIGGER m8_enrollment_term_lock
BEFORE INSERT OR UPDATE OR DELETE ON class_enrollments
FOR EACH ROW EXECUTE FUNCTION trg_m8_enrollment_term_lock();
--> statement-breakpoint

-- Fee structure is frozen once a term has been billed. This is necessary for
-- top-up retries: a later run may add a newly enrolled student, but it must not
-- silently replace the fee structure already issued to existing students.
CREATE OR REPLACE FUNCTION trg_m8_fee_assignment_term_lock()
RETURNS trigger AS $$
DECLARE
  v_term_id uuid;
  v_org_id uuid;
  v_status term_status;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.term_id IS DISTINCT FROM OLD.term_id THEN
    RAISE EXCEPTION 'A fee assignment cannot move between terms'
      USING ERRCODE = 'check_violation';
  END IF;

  v_term_id := COALESCE(NEW.term_id, OLD.term_id);
  v_org_id := COALESCE(NEW.organization_id, OLD.organization_id);

  SELECT status INTO v_status
    FROM terms
   WHERE id = v_term_id
     AND organization_id = v_org_id
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fee assignment term is not visible in the active organization'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_status IN ('BILLED', 'CLOSED') THEN
    RAISE EXCEPTION 'Fee assignments are frozen after a term is billed'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE TRIGGER m8_fee_assignment_term_lock
BEFORE INSERT OR UPDATE OR DELETE ON fee_assignments
FOR EACH ROW EXECUTE FUNCTION trg_m8_fee_assignment_term_lock();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 6. Invoice-line key consistency and waiver application
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_m8_invoice_line_billing_guard()
RETURNS trigger AS $$
DECLARE
  v_invoice invoices%ROWTYPE;
  v_assignment fee_assignments%ROWTYPE;
  v_has_waiver boolean;
BEGIN
  IF NEW.fee_assignment_id IS NULL THEN
    IF NEW.billing_student_id IS NOT NULL OR NEW.billing_term_id IS NOT NULL THEN
      RAISE EXCEPTION 'Ad-hoc invoice lines cannot carry a billing key'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.billing_student_id IS NULL OR NEW.billing_term_id IS NULL THEN
    RAISE EXCEPTION 'Fee-assignment invoice lines require billing_student_id and billing_term_id'
      USING ERRCODE = 'not_null_violation';
  END IF;

  SELECT * INTO v_invoice
    FROM invoices
   WHERE id = NEW.invoice_id
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice for invoice line does not exist'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW.organization_id IS DISTINCT FROM v_invoice.organization_id
     OR NEW.billing_student_id IS DISTINCT FROM v_invoice.student_id
     OR NEW.billing_term_id IS DISTINCT FROM v_invoice.term_id THEN
    RAISE EXCEPTION 'Invoice-line billing key does not match its parent invoice'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_assignment
    FROM fee_assignments
   WHERE id = NEW.fee_assignment_id
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fee assignment for invoice line does not exist'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_assignment.organization_id IS DISTINCT FROM NEW.organization_id
     OR v_assignment.term_id IS DISTINCT FROM NEW.billing_term_id THEN
    RAISE EXCEPTION 'Invoice-line fee assignment is outside the invoice term or tenant'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Once a waiver exists, direct line edits cannot erase or alter its effect.
  -- The waiver trigger's nested UPDATE is the one deliberate exception.
  IF TG_OP = 'UPDATE' AND pg_trigger_depth() = 1 THEN
    SELECT EXISTS(
      SELECT 1 FROM waivers WHERE invoice_line_id = OLD.id
    ) INTO v_has_waiver;
    IF v_has_waiver AND (
      NEW.unit_rate_kobo IS DISTINCT FROM OLD.unit_rate_kobo
      OR NEW.quantity IS DISTINCT FROM OLD.quantity
      OR NEW.adjustment_kobo IS DISTINCT FROM OLD.adjustment_kobo
      OR NEW.amount_kobo IS DISTINCT FROM OLD.amount_kobo
      OR NEW.fee_assignment_id IS DISTINCT FROM OLD.fee_assignment_id
      OR NEW.billing_student_id IS DISTINCT FROM OLD.billing_student_id
      OR NEW.billing_term_id IS DISTINCT FROM OLD.billing_term_id
    ) THEN
      RAISE EXCEPTION 'An invoice line with a waiver cannot be changed'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE TRIGGER m8_invoice_line_billing_guard
BEFORE INSERT OR UPDATE ON invoice_lines
FOR EACH ROW EXECUTE FUNCTION trg_m8_invoice_line_billing_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_m8_apply_waiver()
RETURNS trigger AS $$
DECLARE
  v_line invoice_lines%ROWTYPE;
  v_new_adjustment bigint;
  v_new_amount bigint;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Waivers are immutable and append-only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.approved_by IS DISTINCT FROM NULLIF(current_setting('app.user_id', true), '')::uuid THEN
    RAISE EXCEPTION 'Waiver approver must be the authenticated acting user'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT il.* INTO v_line
    FROM invoice_lines il
   WHERE il.id = NEW.invoice_line_id
     AND il.organization_id = NEW.organization_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Waiver line is not visible in the active organization'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_line.fee_assignment_id IS NULL OR v_line.billing_student_id IS NULL THEN
    RAISE EXCEPTION 'M8 waivers require a fee-assignment-backed billing line'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM invoices
     WHERE id = v_line.invoice_id
       AND organization_id = NEW.organization_id
       AND status = 'DRAFT'
  ) THEN
    RAISE EXCEPTION 'Waivers can only be attached before invoice issuance'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.amount_kobo > v_line.amount_kobo THEN
    RAISE EXCEPTION 'Waiver amount cannot exceed the current invoice-line amount'
      USING ERRCODE = 'check_violation';
  END IF;

  v_new_adjustment := v_line.adjustment_kobo - NEW.amount_kobo;
  v_new_amount := (v_line.unit_rate_kobo * v_line.quantity) + v_new_adjustment;
  IF v_new_amount < 0 THEN
    RAISE EXCEPTION 'Waiver would make invoice-line amount negative'
      USING ERRCODE = 'check_violation';
  END IF;

  -- This is a draft-only line mutation; the ordinary invoice-line trigger
  -- recomputes the parent invoice total from the line rows.
  UPDATE invoice_lines
     SET adjustment_kobo = v_new_adjustment,
         amount_kobo = v_new_amount
   WHERE id = NEW.invoice_line_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE TRIGGER m8_waiver_apply_before_insert
BEFORE INSERT ON waivers
FOR EACH ROW EXECUTE FUNCTION trg_m8_apply_waiver();
--> statement-breakpoint

-- A line with a negative signed adjustment must have an immutable waiver row,
-- and the waiver magnitude must exactly explain the negative adjustment. This
-- check runs at the only boundary where a financial obligation becomes real.
CREATE OR REPLACE FUNCTION trg_m8_invoice_issue_waiver_guard()
RETURNS trigger AS $$
DECLARE
  v_line record;
  v_waiver_total bigint;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'DRAFT'
     AND NEW.status = 'ISSUED' THEN
    FOR v_line IN
      SELECT il.id, il.fee_assignment_id, il.adjustment_kobo,
             il.billing_student_id, il.billing_term_id
        FROM invoice_lines il
       WHERE il.invoice_id = NEW.id
    LOOP
      IF v_line.fee_assignment_id IS NOT NULL
         AND (v_line.billing_student_id IS NULL OR v_line.billing_term_id IS NULL) THEN
        RAISE EXCEPTION 'Cannot issue an invoice with an incomplete M8 billing key'
          USING ERRCODE = 'check_violation';
      END IF;

      SELECT COALESCE(SUM(w.amount_kobo), 0) INTO v_waiver_total
        FROM waivers w
       WHERE w.invoice_line_id = v_line.id;

      -- Existing ad-hoc invoice lines may use a signed adjustment without
      -- an M8 waiver. Only fee-assignment-backed lines enter this stricter
      -- controlled-billing contract.
      IF v_line.fee_assignment_id IS NOT NULL
         AND v_line.adjustment_kobo < 0
         AND v_waiver_total <> -v_line.adjustment_kobo THEN
        RAISE EXCEPTION 'Negative invoice-line adjustment has no matching immutable waiver'
          USING ERRCODE = 'check_violation';
      END IF;

      IF v_line.fee_assignment_id IS NOT NULL
         AND v_waiver_total > 0
         AND v_line.adjustment_kobo <> -v_waiver_total THEN
        RAISE EXCEPTION 'Waiver does not exactly explain the fee-assignment line adjustment'
          USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE TRIGGER m8_invoice_issue_waiver_guard
BEFORE UPDATE ON invoices
FOR EACH ROW EXECUTE FUNCTION trg_m8_invoice_issue_waiver_guard();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 7. Waiver immutability, RLS, and runtime privileges
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_m8_waiver_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Waivers are immutable and cannot be updated or deleted'
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE TRIGGER m8_waivers_block_update
BEFORE UPDATE ON waivers FOR EACH ROW EXECUTE FUNCTION trg_m8_waiver_immutable();
CREATE TRIGGER m8_waivers_block_delete
BEFORE DELETE ON waivers FOR EACH ROW EXECUTE FUNCTION trg_m8_waiver_immutable();

ALTER TABLE waivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE waivers FORCE ROW LEVEL SECURITY;
CREATE POLICY waivers_tenant_isolation ON waivers FOR ALL
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);

CREATE OR REPLACE TRIGGER a_waivers_set_org
BEFORE INSERT ON waivers FOR EACH ROW EXECUTE FUNCTION trg_set_org_from_context();

GRANT SELECT, INSERT ON waivers TO scolaira_app;
REVOKE UPDATE, DELETE ON waivers FROM scolaira_app;
--> statement-breakpoint

-- Keep the mutation surface for the new billing columns explicit. Existing
-- grants on invoice_lines/terms/fee_definitions are retained.
GRANT USAGE ON TYPE waiver_reason TO scolaira_app;
--> statement-breakpoint

-- End of M8 database boundary.
