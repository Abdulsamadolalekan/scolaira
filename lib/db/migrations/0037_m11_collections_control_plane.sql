-- M11: tenant-scoped Collections Workbench and operational case control plane.
--
-- These records are operational workflow state only. They do not copy or
-- replace invoice, payment, allocation, reversal, refund, receipt, or
-- reconciliation truth. Financial detail is joined from the authoritative
-- tables at read time; financial mutations remain in existing services.

CREATE TABLE collections_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  state varchar(16) NOT NULL DEFAULT 'OPEN' CHECK (state IN (
    'OPEN', 'IN_PROGRESS', 'ESCALATED', 'RESOLVED', 'CLOSED'
  )),
  priority varchar(16) NOT NULL DEFAULT 'NORMAL' CHECK (priority IN (
    'LOW', 'NORMAL', 'HIGH', 'URGENT'
  )),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
  next_action_at timestamptz,
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  closed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  closed_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX m11_collections_open_student_unique_idx
  ON collections_cases (organization_id, student_id)
  WHERE state <> 'CLOSED';
--> statement-breakpoint
CREATE INDEX m11_collections_org_state_idx
  ON collections_cases (organization_id, state, created_at DESC);
--> statement-breakpoint
CREATE INDEX m11_collections_org_priority_idx
  ON collections_cases (organization_id, priority, created_at DESC);
--> statement-breakpoint
CREATE INDEX m11_collections_org_assignee_idx
  ON collections_cases (organization_id, assigned_to, state, next_action_at);
--> statement-breakpoint
CREATE INDEX m11_collections_org_student_idx
  ON collections_cases (organization_id, student_id, created_at DESC);
--> statement-breakpoint

CREATE TABLE collections_case_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES collections_cases(id) ON DELETE RESTRICT,
  event_type varchar(32) NOT NULL CHECK (event_type IN (
    'CREATED', 'ASSIGNED', 'UNASSIGNED', 'NOTE', 'ACTION',
    'STATE_CHANGE', 'RESOLVED', 'CLOSED', 'REOPENED'
  )),
  previous_state varchar(16) CHECK (
    previous_state IS NULL OR previous_state IN ('OPEN', 'IN_PROGRESS', 'ESCALATED', 'RESOLVED', 'CLOSED')
  ),
  next_state varchar(16) CHECK (
    next_state IS NULL OR next_state IN ('OPEN', 'IN_PROGRESS', 'ESCALATED', 'RESOLVED', 'CLOSED')
  ),
  previous_assignee uuid REFERENCES users(id) ON DELETE RESTRICT,
  next_assignee uuid REFERENCES users(id) ON DELETE RESTRICT,
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 4000),
  reminder_id uuid REFERENCES reminders(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX m11_collections_events_case_idx
  ON collections_case_events (organization_id, case_id, created_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX m11_collections_events_reminder_idx
  ON collections_case_events (organization_id, reminder_id);
--> statement-breakpoint
CREATE INDEX m11_collections_events_actor_idx
  ON collections_case_events (organization_id, created_by, created_at DESC);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION m11_collections_case_tenant_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_actor uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  bootstrap boolean := current_setting('app.auth_bootstrap', true) = '1';
BEGIN
  IF NOT bootstrap AND current_actor IS NOT NULL AND TG_OP = 'INSERT'
     AND NEW.created_by IS DISTINCT FROM current_actor THEN
    RAISE EXCEPTION 'Collections creator must be the authenticated actor'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT bootstrap AND current_actor IS NOT NULL AND TG_OP = 'UPDATE'
     AND NEW.resolved_by IS DISTINCT FROM OLD.resolved_by
     AND NEW.resolved_by IS NOT NULL
     AND NEW.resolved_by IS DISTINCT FROM current_actor THEN
    RAISE EXCEPTION 'Collections resolver must be the authenticated actor'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT bootstrap AND current_actor IS NOT NULL AND TG_OP = 'UPDATE'
     AND NEW.closed_by IS DISTINCT FROM OLD.closed_by
     AND NEW.closed_by IS NOT NULL
     AND NEW.closed_by IS DISTINCT FROM current_actor THEN
    RAISE EXCEPTION 'Collections closer must be the authenticated actor'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM students s
     WHERE s.id = NEW.student_id
       AND s.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Collections student must belong to the same organization'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.assigned_to IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM organization_members om
     WHERE om.organization_id = NEW.organization_id
       AND om.user_id = NEW.assigned_to
       AND om.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Collections assignee must be an active member of the organization'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM organization_members om
     WHERE om.organization_id = NEW.organization_id
       AND om.user_id = NEW.created_by
       AND om.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Collections creator must be an active member of the organization'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.resolved_by IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM organization_members om
     WHERE om.organization_id = NEW.organization_id
       AND om.user_id = NEW.resolved_by
       AND om.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Collections resolver must be an active member of the organization'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.closed_by IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM organization_members om
     WHERE om.organization_id = NEW.organization_id
       AND om.user_id = NEW.closed_by
       AND om.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Collections closer must be an active member of the organization'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER m11_collections_case_tenant_guard
BEFORE INSERT OR UPDATE OF organization_id, student_id, assigned_to,
  created_by, resolved_by, closed_by ON collections_cases
FOR EACH ROW EXECUTE FUNCTION m11_collections_case_tenant_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION m11_collections_case_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  transition text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'OPEN' OR NEW.version <> 0
       OR NEW.resolved_by IS NOT NULL OR NEW.resolved_at IS NOT NULL
       OR NEW.closed_by IS NOT NULL OR NEW.closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Collections cases must be created OPEN at version zero'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.organization_id IS DISTINCT FROM NEW.organization_id
     OR OLD.student_id IS DISTINCT FROM NEW.student_id
     OR OLD.created_by IS DISTINCT FROM NEW.created_by
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'Collections case tenant and creation linkage are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Collections case version must advance exactly once'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.state = 'CLOSED' THEN
    RAISE EXCEPTION 'Closed collections cases are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.state <> OLD.state THEN
    transition := OLD.state || '->' || NEW.state;
    IF transition NOT IN (
      'OPEN->IN_PROGRESS', 'OPEN->ESCALATED', 'OPEN->RESOLVED',
      'IN_PROGRESS->OPEN', 'IN_PROGRESS->ESCALATED', 'IN_PROGRESS->RESOLVED',
      'ESCALATED->IN_PROGRESS', 'ESCALATED->RESOLVED',
      'RESOLVED->OPEN', 'RESOLVED->IN_PROGRESS', 'RESOLVED->CLOSED'
    ) THEN
      RAISE EXCEPTION 'Invalid collections case transition %', transition
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.state = 'RESOLVED' THEN
    IF NEW.resolved_by IS NULL OR NEW.resolved_at IS NULL THEN
      RAISE EXCEPTION 'Resolved collections cases require resolver and resolved_at'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.state = 'CLOSED' THEN
    IF OLD.state <> 'RESOLVED' OR NEW.closed_by IS NULL OR NEW.closed_at IS NULL THEN
      RAISE EXCEPTION 'Collections cases may close only from RESOLVED with closer and closed_at'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.resolved_by IS NOT NULL OR NEW.resolved_at IS NOT NULL
       OR NEW.closed_by IS NOT NULL OR NEW.closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Open collections cases cannot retain resolution or closure attribution'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.closed_at IS NOT NULL AND NEW.state <> 'CLOSED' THEN
    RAISE EXCEPTION 'Only CLOSED collections cases may have closed_at'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER m11_collections_case_transition_guard
BEFORE INSERT OR UPDATE ON collections_cases
FOR EACH ROW EXECUTE FUNCTION m11_collections_case_transition_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION m11_collections_case_updated_at()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER m11_collections_cases_updated_at
BEFORE UPDATE ON collections_cases
FOR EACH ROW EXECUTE FUNCTION m11_collections_case_updated_at();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION m11_collections_event_tenant_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  case_student uuid;
  current_actor uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  bootstrap boolean := current_setting('app.auth_bootstrap', true) = '1';
BEGIN
  IF NOT bootstrap AND current_actor IS NOT NULL
     AND NEW.created_by IS DISTINCT FROM current_actor THEN
    RAISE EXCEPTION 'Collections event actor must be the authenticated actor'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT c.student_id
    INTO case_student
    FROM collections_cases c
   WHERE c.id = NEW.case_id
     AND c.organization_id = NEW.organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Collections event case must belong to the same organization'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM organization_members om
     WHERE om.organization_id = NEW.organization_id
       AND om.user_id = NEW.created_by
       AND om.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Collections event actor must be an active member of the organization'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.next_assignee IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM organization_members om
     WHERE om.organization_id = NEW.organization_id
       AND om.user_id = NEW.next_assignee
       AND om.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Collections next assignee must be an active member of the organization'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.reminder_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM reminders r
     WHERE r.id = NEW.reminder_id
       AND r.organization_id = NEW.organization_id
       AND (
         r.student_id = case_student
         OR EXISTS (
           SELECT 1
             FROM invoices i
            WHERE i.id = r.invoice_id
              AND i.organization_id = r.organization_id
              AND i.student_id = case_student
         )
       )
  ) THEN
    RAISE EXCEPTION 'Collections reminder must belong to the case student account'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER m11_collections_event_tenant_guard
BEFORE INSERT ON collections_case_events
FOR EACH ROW EXECUTE FUNCTION m11_collections_event_tenant_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION m11_collections_event_immutable()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Collections case history is append-only'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER m11_collections_event_immutable
BEFORE UPDATE OR DELETE ON collections_case_events
FOR EACH ROW EXECUTE FUNCTION m11_collections_event_immutable();
--> statement-breakpoint

-- Correct the future reminder contract without rewriting historical rows:
-- PRINT may be recorded as delivered, while unsupported external channels
-- remain PENDING until a provider actually delivers them.
CREATE OR REPLACE FUNCTION m11_reminder_delivery_shape_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT'
     AND NEW.channel <> 'PRINT'
     AND NEW.status = 'SENT' THEN
    RAISE EXCEPTION 'Unsupported reminder channels cannot be recorded as SENT without provider delivery'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER m11_reminder_delivery_shape_guard
BEFORE INSERT ON reminders
FOR EACH ROW EXECUTE FUNCTION m11_reminder_delivery_shape_guard();
--> statement-breakpoint

ALTER TABLE collections_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE collections_cases FORCE ROW LEVEL SECURITY;
ALTER TABLE collections_case_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE collections_case_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY collections_cases_tenant_isolation ON collections_cases FOR ALL
USING (
  auth_is_platform_admin_authorized()
  OR (
    auth_is_tenant_authorized()
    AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  )
)
WITH CHECK (
  auth_is_platform_admin_authorized()
  OR (
    auth_is_tenant_authorized()
    AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  )
);
--> statement-breakpoint
CREATE POLICY collections_case_events_tenant_isolation ON collections_case_events FOR ALL
USING (
  auth_is_platform_admin_authorized()
  OR (
    auth_is_tenant_authorized()
    AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  )
)
WITH CHECK (
  auth_is_platform_admin_authorized()
  OR (
    auth_is_tenant_authorized()
    AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  )
);
--> statement-breakpoint

-- The migration runner reapplies the same least-privilege restrictions after
-- its broad bootstrap grant. The runtime may insert/read and may only update
-- workflow columns on cases; history can never be updated or deleted.
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON collections_cases, collections_case_events FROM scolaira_app;
REVOKE UPDATE ON collections_cases, collections_case_events FROM scolaira_app;
GRANT UPDATE (state, priority, assigned_to, next_action_at, resolved_by,
  resolved_at, closed_by, closed_at, version) ON collections_cases TO scolaira_app;
REVOKE UPDATE, DELETE ON collections_case_events FROM scolaira_app;
--> statement-breakpoint

COMMENT ON TABLE collections_cases IS
  'M11 student-level operational collections workflow; authoritative financial truth remains in invoices and payment services';
COMMENT ON TABLE collections_case_events IS
  'M11 append-only collections history and action ledger';
