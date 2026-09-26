-- M10 final-audit hardening for actor attribution.
--
-- RLS scopes the control records to an organization, but an INSERT payload
-- could otherwise name an active user from another organization in created_by,
-- resolved_by, or decided_by. These guards make attribution tenant-safe at the
-- database boundary as well as in the authorized service.

CREATE OR REPLACE FUNCTION m10_reconciliation_actor_tenant_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  row_data jsonb := to_jsonb(NEW);
  row_org uuid := NULLIF(row_data ->> 'organization_id', '')::uuid;
  row_created_by uuid := NULLIF(row_data ->> 'created_by', '')::uuid;
  row_resolved_by uuid := NULLIF(row_data ->> 'resolved_by', '')::uuid;
  row_decided_by uuid := NULLIF(row_data ->> 'decided_by', '')::uuid;
BEGIN
  IF row_created_by IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM organization_members om
     WHERE om.organization_id = row_org
       AND om.user_id = row_created_by
       AND om.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Reconciliation creator must be an active member of the organization'
      USING ERRCODE = 'check_violation';
  END IF;

  IF row_resolved_by IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM organization_members om
     WHERE om.organization_id = row_org
       AND om.user_id = row_resolved_by
       AND om.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Reconciliation resolver must be an active member of the organization'
      USING ERRCODE = 'check_violation';
  END IF;

  IF row_decided_by IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM organization_members om
     WHERE om.organization_id = row_org
       AND om.user_id = row_decided_by
       AND om.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Reconciliation decision actor must be an active member of the organization'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER m10_reconciliation_case_actor_tenant_guard
BEFORE INSERT OR UPDATE OF organization_id, created_by, resolved_by ON reconciliation_cases
FOR EACH ROW EXECUTE FUNCTION m10_reconciliation_actor_tenant_guard();
--> statement-breakpoint
CREATE TRIGGER m10_reconciliation_evidence_actor_tenant_guard
BEFORE INSERT OR UPDATE OF organization_id, created_by ON reconciliation_evidence
FOR EACH ROW EXECUTE FUNCTION m10_reconciliation_actor_tenant_guard();
--> statement-breakpoint
CREATE TRIGGER m10_reconciliation_candidate_actor_tenant_guard
BEFORE INSERT OR UPDATE OF organization_id, created_by, decided_by ON reconciliation_candidates
FOR EACH ROW EXECUTE FUNCTION m10_reconciliation_actor_tenant_guard();
