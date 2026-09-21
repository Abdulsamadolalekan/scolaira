-- M10 final-audit hardening: candidates cannot be added or decided after
-- their case is terminal, flagged, or already allocated.

CREATE OR REPLACE FUNCTION m10_reconciliation_candidate_case_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  case_closed timestamptz;
  case_state varchar;
BEGIN
  SELECT c.closed_at, c.state
    INTO case_closed, case_state
    FROM reconciliation_cases c
   WHERE c.id = NEW.case_id
     AND c.organization_id = NEW.organization_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reconciliation candidate case must exist in the organization'
      USING ERRCODE = 'check_violation';
  END IF;
  IF case_closed IS NOT NULL THEN
    RAISE EXCEPTION 'Candidates cannot be added to a closed reconciliation case'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state = 'ACCEPTED' AND case_state <> 'UNMATCHED' THEN
    RAISE EXCEPTION 'Candidates may be accepted only from an unmatched reconciliation case'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER m10_reconciliation_candidate_case_guard
BEFORE INSERT OR UPDATE OF organization_id, case_id, state ON reconciliation_candidates
FOR EACH ROW EXECUTE FUNCTION m10_reconciliation_candidate_case_guard();
