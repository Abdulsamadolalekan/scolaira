-- M10 final-audit hardening for case history and terminal immutability.
--
-- This is intentionally a separate forward migration: 0025 may already be
-- present in an upgraded database, so its trigger function must not be edited
-- in place.

CREATE OR REPLACE FUNCTION m10_reconciliation_case_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  transition text;
BEGIN
  -- A closed case is a durable decision record, not a mutable work item.
  IF OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Closed reconciliation cases are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.state <> OLD.state THEN
    transition := OLD.state || '->' || NEW.state;
    IF transition NOT IN (
      'UNMATCHED->FLAGGED', 'UNMATCHED->RECONCILED', 'UNMATCHED->ALLOCATED',
      'FLAGGED->UNMATCHED', 'FLAGGED->RECONCILED', 'FLAGGED->ALLOCATED',
      'RECONCILED->FLAGGED', 'RECONCILED->ALLOCATED',
      'ALLOCATED->FLAGGED'
    ) THEN
      RAISE EXCEPTION 'Invalid reconciliation transition %', transition
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.previous_state IS DISTINCT FROM OLD.previous_state THEN
    IF NEW.state = 'FLAGGED' AND NEW.state IS DISTINCT FROM OLD.state THEN
      IF NEW.previous_state IS DISTINCT FROM OLD.state THEN
        RAISE EXCEPTION 'Flagged reconciliation cases must retain their prior state'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF OLD.state = 'FLAGGED' AND NEW.state = 'UNMATCHED' THEN
      IF NEW.previous_state IS NOT NULL OR OLD.previous_state IS DISTINCT FROM NEW.state THEN
        RAISE EXCEPTION 'Unflagged reconciliation cases must restore their prior state and clear previous_state'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      RAISE EXCEPTION 'Reconciliation previous_state changed without a supported transition'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.state = 'ALLOCATED' AND NEW.closed_at IS NULL THEN
    RAISE EXCEPTION 'Allocated reconciliation cases must be closed'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.closed_at IS NOT NULL AND NEW.state NOT IN ('RECONCILED', 'ALLOCATED') THEN
    RAISE EXCEPTION 'Only reconciled or allocated cases may be closed'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
