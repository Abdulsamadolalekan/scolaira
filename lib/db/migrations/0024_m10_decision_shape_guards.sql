-- M10 follow-up hardening: reject decision-shaped rows that bypass the
-- application service. The service remains responsible for authorization,
-- idempotency, and audit writes; these guards prevent malformed direct SQL.

ALTER TABLE reconciliation_cases
  ADD CONSTRAINT m10_reconciliation_allocated_closed_ck
  CHECK (state <> 'ALLOCATED' OR closed_at IS NOT NULL);
--> statement-breakpoint
ALTER TABLE reconciliation_cases
  ADD CONSTRAINT m10_reconciliation_closed_resolved_ck
  CHECK (closed_at IS NULL OR (state IN ('RECONCILED', 'ALLOCATED') AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL));
--> statement-breakpoint
ALTER TABLE reconciliation_candidates
  ADD CONSTRAINT m10_reconciliation_candidate_decision_ck
  CHECK (state = 'PROPOSED' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL));
--> statement-breakpoint

CREATE OR REPLACE FUNCTION m10_reconciliation_case_shape_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.state = 'ALLOCATED' AND NEW.closed_at IS NULL THEN
    RAISE EXCEPTION 'Allocated reconciliation cases must be closed'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.closed_at IS NOT NULL AND (NEW.state NOT IN ('RECONCILED', 'ALLOCATED') OR NEW.resolved_by IS NULL OR NEW.resolved_at IS NULL) THEN
    RAISE EXCEPTION 'Closed reconciliation cases require a resolved actor, time, and terminal state'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER m10_reconciliation_case_shape_guard
BEFORE INSERT OR UPDATE OF state, closed_at, resolved_by, resolved_at ON reconciliation_cases
FOR EACH ROW EXECUTE FUNCTION m10_reconciliation_case_shape_guard();
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
    RETURN NEW;
  END IF;

  IF NEW.state <> OLD.state AND OLD.state <> 'PROPOSED' THEN
    RAISE EXCEPTION 'Decided reconciliation candidates cannot change state'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state <> OLD.state AND (NEW.decided_by IS NULL OR NEW.decided_at IS NULL) THEN
    RAISE EXCEPTION 'Decided reconciliation candidates require decided_by and decided_at'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER m10_reconciliation_candidate_insert_guard
BEFORE INSERT ON reconciliation_candidates
FOR EACH ROW EXECUTE FUNCTION m10_reconciliation_candidate_transition_guard();
