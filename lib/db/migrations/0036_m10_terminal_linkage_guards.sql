-- M10 final-audit hardening: terminal records and candidate linkages must not
-- be rewritten through the runtime role after the service boundary.
--
-- Earlier guards covered state transitions and most decided-candidate fields,
-- but their UPDATE OF trigger lists left two direct-SQL gaps:
--   * a closed case could have reason/kind/resolution fields rewritten while
--     incrementing version; and
--   * a decided candidate could be moved to another case in the same tenant.
-- Both are history/linkage mutations, not supported workflows.

CREATE OR REPLACE FUNCTION m10_reconciliation_case_version_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Closed reconciliation cases are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Reconciliation case version must advance exactly once'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION m10_reconciliation_case_linkage_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Reconciliation case tenant, payment, and creation linkage are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER m10_reconciliation_case_linkage_guard
BEFORE UPDATE ON reconciliation_cases
FOR EACH ROW EXECUTE FUNCTION m10_reconciliation_case_linkage_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION m10_reconciliation_candidate_linkage_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.case_id IS DISTINCT FROM OLD.case_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Reconciliation candidate tenant, case, and creation linkage are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER m10_reconciliation_candidate_linkage_guard
BEFORE UPDATE ON reconciliation_candidates
FOR EACH ROW EXECUTE FUNCTION m10_reconciliation_candidate_linkage_guard();
