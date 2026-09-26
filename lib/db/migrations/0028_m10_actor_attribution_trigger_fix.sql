-- M10 forward fix: the shared actor guard must read optional actor columns
-- through row JSON because each reconciliation table has a different shape.

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
