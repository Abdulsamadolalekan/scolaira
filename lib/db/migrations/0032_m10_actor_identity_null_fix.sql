-- M10 forward fix: nullable resolver/decision actors are valid on open and
-- proposed rows; compare them to the authenticated actor only when present.

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
  current_actor uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  bootstrap boolean := current_setting('app.auth_bootstrap', true) = '1';
BEGIN
  IF NOT bootstrap AND current_actor IS NOT NULL AND row_created_by IS DISTINCT FROM current_actor THEN
    RAISE EXCEPTION 'Reconciliation creator must be the authenticated actor'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT bootstrap AND current_actor IS NOT NULL AND row_resolved_by IS NOT NULL
     AND row_resolved_by IS DISTINCT FROM current_actor THEN
    RAISE EXCEPTION 'Reconciliation resolver must be the authenticated actor'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT bootstrap AND current_actor IS NOT NULL AND row_decided_by IS NOT NULL
     AND row_decided_by IS DISTINCT FROM current_actor THEN
    RAISE EXCEPTION 'Reconciliation decision actor must be the authenticated actor'
      USING ERRCODE = 'check_violation';
  END IF;

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
