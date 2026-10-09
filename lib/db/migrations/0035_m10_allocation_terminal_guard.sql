-- M10 final-audit hardening: ALLOCATED is only a control-plane reflection
-- of an authoritative, fully allocated payment and an accepted candidate.
-- Flagged cases must be explicitly unflagged before allocation.

CREATE OR REPLACE FUNCTION m10_reconciliation_case_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  transition text;
BEGIN
  IF OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Closed reconciliation cases are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.state <> OLD.state THEN
    transition := OLD.state || '->' || NEW.state;
    IF transition NOT IN (
      'UNMATCHED->FLAGGED', 'UNMATCHED->RECONCILED', 'UNMATCHED->ALLOCATED',
      'FLAGGED->UNMATCHED', 'FLAGGED->RECONCILED',
      'RECONCILED->FLAGGED', 'RECONCILED->ALLOCATED'
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
    ELSIF OLD.state = 'FLAGGED' AND NEW.state IN ('UNMATCHED', 'RECONCILED') THEN
      IF NEW.previous_state IS NOT NULL OR OLD.previous_state IS DISTINCT FROM NEW.state THEN
        RAISE EXCEPTION 'Unflagged reconciliation cases must restore their prior state and clear previous_state'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      RAISE EXCEPTION 'Reconciliation previous_state changed without a supported transition'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.state = 'ALLOCATED' THEN
    IF NEW.closed_at IS NULL THEN
      RAISE EXCEPTION 'Allocated reconciliation cases must be closed'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM payments p
       WHERE p.id = NEW.payment_id
         AND p.organization_id = NEW.organization_id
         AND p.status = 'CONFIRMED'
         AND p.unallocated_kobo = 0
    ) THEN
      RAISE EXCEPTION 'Allocated reconciliation cases require a fully allocated confirmed payment'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM reconciliation_candidates rc
       WHERE rc.case_id = NEW.id
         AND rc.organization_id = NEW.organization_id
         AND rc.state = 'ACCEPTED'
    ) THEN
      RAISE EXCEPTION 'Allocated reconciliation cases require an accepted candidate'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.closed_at IS NOT NULL AND NEW.state NOT IN ('RECONCILED', 'ALLOCATED') THEN
    RAISE EXCEPTION 'Only reconciled or allocated cases may be closed'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
