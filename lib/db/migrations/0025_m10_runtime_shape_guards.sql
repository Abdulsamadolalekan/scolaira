-- M10 final-audit hardening.
--
-- The application service already requires these shapes. These forward-only
-- database guards ensure the runtime role cannot create a decision-shaped
-- control record that bypasses the service boundary.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM reconciliation_cases WHERE payment_id IS NULL) THEN
    RAISE EXCEPTION 'M10 preflight failed: reconciliation case without payment_id';
  END IF;
  IF EXISTS (SELECT 1 FROM reconciliation_cases WHERE created_by IS NULL) THEN
    RAISE EXCEPTION 'M10 preflight failed: reconciliation case without created_by';
  END IF;
  IF EXISTS (SELECT 1 FROM reconciliation_evidence WHERE created_by IS NULL) THEN
    RAISE EXCEPTION 'M10 preflight failed: reconciliation evidence without created_by';
  END IF;
  IF EXISTS (SELECT 1 FROM reconciliation_candidates WHERE created_by IS NULL) THEN
    RAISE EXCEPTION 'M10 preflight failed: reconciliation candidate without created_by';
  END IF;
END;
$$;
--> statement-breakpoint

ALTER TABLE reconciliation_cases
  ALTER COLUMN payment_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE reconciliation_cases
  ALTER COLUMN created_by SET NOT NULL;
--> statement-breakpoint
ALTER TABLE reconciliation_evidence
  ALTER COLUMN created_by SET NOT NULL;
--> statement-breakpoint
ALTER TABLE reconciliation_candidates
  ALTER COLUMN created_by SET NOT NULL;
--> statement-breakpoint

ALTER TABLE reconciliation_evidence
  ADD CONSTRAINT m10_reconciliation_evidence_content_ck
  CHECK (reference IS NOT NULL OR note IS NOT NULL);
--> statement-breakpoint
ALTER TABLE reconciliation_candidates
  ADD CONSTRAINT m10_reconciliation_candidate_basis_ck
  CHECK (btrim(basis) <> '');
--> statement-breakpoint

CREATE OR REPLACE FUNCTION m10_reconciliation_case_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.state <> 'UNMATCHED' OR NEW.previous_state IS NOT NULL OR NEW.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'New reconciliation cases must start open and UNMATCHED'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER m10_reconciliation_case_insert_guard
BEFORE INSERT ON reconciliation_cases
FOR EACH ROW EXECUTE FUNCTION m10_reconciliation_case_insert_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION m10_reconciliation_case_decision_evidence_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.state IN ('RECONCILED', 'ALLOCATED') AND NOT EXISTS (
    SELECT 1
      FROM reconciliation_evidence e
     WHERE e.case_id = NEW.id
       AND e.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Reconciliation terminal decisions require append-only evidence'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER m10_reconciliation_case_decision_evidence_guard
BEFORE INSERT OR UPDATE OF state ON reconciliation_cases
FOR EACH ROW EXECUTE FUNCTION m10_reconciliation_case_decision_evidence_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION m10_reconciliation_case_version_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Reconciliation case version must advance exactly once'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER m10_reconciliation_case_version_guard
BEFORE UPDATE ON reconciliation_cases
FOR EACH ROW EXECUTE FUNCTION m10_reconciliation_case_version_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION m10_reconciliation_evidence_open_case_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM reconciliation_cases c
     WHERE c.id = NEW.case_id
       AND c.organization_id = NEW.organization_id
       AND c.closed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Evidence cannot be added to a closed reconciliation case'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER m10_reconciliation_evidence_open_case_guard
BEFORE INSERT ON reconciliation_evidence
FOR EACH ROW EXECUTE FUNCTION m10_reconciliation_evidence_open_case_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION m10_reconciliation_candidate_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'PROPOSED' AND (NEW.decided_by IS NULL OR NEW.decided_at IS NULL) THEN
      RAISE EXCEPTION 'Inserted reconciliation decisions require decided_by and decided_at'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state <> 'PROPOSED' AND NOT EXISTS (
      SELECT 1 FROM reconciliation_evidence e
       WHERE e.case_id = NEW.case_id
         AND e.organization_id = NEW.organization_id
    ) THEN
      RAISE EXCEPTION 'Candidate decisions require append-only evidence'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state <> 'PROPOSED' AND (
    NEW.state IS DISTINCT FROM OLD.state OR
    NEW.student_id IS DISTINCT FROM OLD.student_id OR
    NEW.invoice_id IS DISTINCT FROM OLD.invoice_id OR
    NEW.basis IS DISTINCT FROM OLD.basis OR
    NEW.created_by IS DISTINCT FROM OLD.created_by OR
    NEW.decided_by IS DISTINCT FROM OLD.decided_by OR
    NEW.decided_at IS DISTINCT FROM OLD.decided_at
  ) THEN
    RAISE EXCEPTION 'Decided reconciliation candidates are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.state <> OLD.state AND OLD.state <> 'PROPOSED' THEN
    RAISE EXCEPTION 'Decided reconciliation candidates cannot change state'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state <> OLD.state AND (NEW.decided_by IS NULL OR NEW.decided_at IS NULL) THEN
    RAISE EXCEPTION 'Decided reconciliation candidates require decided_by and decided_at'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state <> 'PROPOSED' AND NOT EXISTS (
    SELECT 1 FROM reconciliation_evidence e
     WHERE e.case_id = NEW.case_id
       AND e.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Candidate decisions require append-only evidence'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER m10_reconciliation_candidate_immutable_guard
BEFORE UPDATE ON reconciliation_candidates
FOR EACH ROW EXECUTE FUNCTION m10_reconciliation_candidate_transition_guard();
