-- =============================================================================
-- M10: Reconciliation control plane.
--
-- These tables are operational control records only. They deliberately do not
-- store payment balances, invoice balances, allocation amounts, or receipts.
-- Existing financial tables and their triggers remain authoritative.
-- =============================================================================

CREATE TABLE reconciliation_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  payment_id uuid REFERENCES payments(id) ON DELETE RESTRICT,
  kind varchar(32) NOT NULL CHECK (kind IN (
    'TO_CONFIRM', 'TO_MATCH', 'TO_ALLOCATE', 'DUPLICATE_REVIEW',
    'FLAGGED_EXCEPTION', 'LATE_EVENT'
  )),
  state varchar(16) NOT NULL CHECK (state IN ('UNMATCHED', 'FLAGGED', 'RECONCILED', 'ALLOCATED')),
  previous_state varchar(16) CHECK (previous_state IS NULL OR previous_state IN ('UNMATCHED', 'FLAGGED', 'RECONCILED', 'ALLOCATED')),
  reason text,
  resolution_code varchar(64),
  resolution_note text,
  assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  closed_at timestamptz,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX m10_reconciliation_one_open_payment_idx
  ON reconciliation_cases (payment_id)
  WHERE payment_id IS NOT NULL AND closed_at IS NULL;
--> statement-breakpoint
CREATE INDEX m10_reconciliation_org_state_idx
  ON reconciliation_cases (organization_id, state, created_at DESC);
--> statement-breakpoint
CREATE INDEX m10_reconciliation_org_kind_idx
  ON reconciliation_cases (organization_id, kind, created_at DESC);
--> statement-breakpoint
CREATE INDEX m10_reconciliation_payment_idx
  ON reconciliation_cases (payment_id);
--> statement-breakpoint
CREATE INDEX m10_reconciliation_assignee_idx
  ON reconciliation_cases (organization_id, assigned_to, state);
--> statement-breakpoint

CREATE TABLE reconciliation_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES reconciliation_cases(id) ON DELETE RESTRICT,
  kind varchar(32) NOT NULL CHECK (kind IN ('BANK_REFERENCE', 'CASH_RECEIPT', 'POS_SLIP', 'OPERATOR_NOTE', 'PROVIDER_EVENT')),
  reference varchar(255),
  observed_at timestamptz,
  note text,
  content_hash varchar(128),
  metadata jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX m10_reconciliation_evidence_case_idx
  ON reconciliation_evidence (organization_id, case_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX m10_reconciliation_evidence_reference_idx
  ON reconciliation_evidence (organization_id, reference);
--> statement-breakpoint

CREATE TABLE reconciliation_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES reconciliation_cases(id) ON DELETE RESTRICT,
  student_id uuid REFERENCES students(id) ON DELETE RESTRICT,
  invoice_id uuid REFERENCES invoices(id) ON DELETE RESTRICT,
  basis text NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'PROPOSED' CHECK (state IN ('PROPOSED', 'ACCEPTED', 'REJECTED')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (student_id IS NOT NULL OR invoice_id IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX m10_reconciliation_one_accepted_candidate_idx
  ON reconciliation_candidates (case_id)
  WHERE state = 'ACCEPTED';
--> statement-breakpoint
CREATE INDEX m10_reconciliation_candidates_case_idx
  ON reconciliation_candidates (organization_id, case_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX m10_reconciliation_candidates_invoice_idx
  ON reconciliation_candidates (organization_id, invoice_id);
--> statement-breakpoint
CREATE INDEX m10_reconciliation_candidates_student_idx
  ON reconciliation_candidates (organization_id, student_id);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION m10_reconciliation_case_tenant_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.payment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM payments p
     WHERE p.id = NEW.payment_id
       AND p.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Reconciliation payment must belong to the same organization'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.assigned_to IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM organization_members om
     WHERE om.organization_id = NEW.organization_id
       AND om.user_id = NEW.assigned_to
       AND om.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Reconciliation assignee must be an active member of the organization'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER m10_reconciliation_case_tenant_guard
BEFORE INSERT OR UPDATE OF organization_id, payment_id, assigned_to ON reconciliation_cases
FOR EACH ROW EXECUTE FUNCTION m10_reconciliation_case_tenant_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION m10_reconciliation_case_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  transition text;
BEGIN
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

  IF NEW.state = 'ALLOCATED' AND NEW.closed_at IS NULL THEN
    RAISE EXCEPTION 'Allocated reconciliation cases must be closed'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.closed_at IS NOT NULL AND NEW.state NOT IN ('RECONCILED', 'ALLOCATED') THEN
    RAISE EXCEPTION 'Only reconciled or allocated cases may be closed'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.closed_at IS NOT NULL AND OLD.closed_at IS NOT NULL AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION 'Closed reconciliation cases cannot change state'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.version < OLD.version THEN
    RAISE EXCEPTION 'Reconciliation case version cannot move backwards'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER m10_reconciliation_case_transition_guard
BEFORE UPDATE OF state, previous_state, closed_at, version ON reconciliation_cases
FOR EACH ROW EXECUTE FUNCTION m10_reconciliation_case_transition_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION m10_reconciliation_evidence_tenant_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM reconciliation_cases c
     WHERE c.id = NEW.case_id
       AND c.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Reconciliation evidence case must belong to the same organization'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER m10_reconciliation_evidence_tenant_guard
BEFORE INSERT OR UPDATE OF organization_id, case_id ON reconciliation_evidence
FOR EACH ROW EXECUTE FUNCTION m10_reconciliation_evidence_tenant_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION m10_reconciliation_evidence_immutable()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Reconciliation evidence is append-only'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER m10_reconciliation_evidence_immutable
BEFORE UPDATE OR DELETE ON reconciliation_evidence
FOR EACH ROW EXECUTE FUNCTION m10_reconciliation_evidence_immutable();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION m10_reconciliation_candidate_tenant_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  invoice_student uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM reconciliation_cases c
     WHERE c.id = NEW.case_id
       AND c.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Reconciliation candidate case must belong to the same organization'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.student_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM students s
     WHERE s.id = NEW.student_id
       AND s.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Reconciliation candidate student must belong to the same organization'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.invoice_id IS NOT NULL THEN
    SELECT i.student_id INTO invoice_student
      FROM invoices i
     WHERE i.id = NEW.invoice_id
       AND i.organization_id = NEW.organization_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Reconciliation candidate invoice must belong to the same organization'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.student_id IS NOT NULL AND NEW.student_id <> invoice_student THEN
      RAISE EXCEPTION 'Reconciliation candidate student must match the invoice student'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER m10_reconciliation_candidate_tenant_guard
BEFORE INSERT OR UPDATE OF organization_id, case_id, student_id, invoice_id ON reconciliation_candidates
FOR EACH ROW EXECUTE FUNCTION m10_reconciliation_candidate_tenant_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION m10_reconciliation_candidate_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.state <> OLD.state AND OLD.state <> 'PROPOSED' THEN
    RAISE EXCEPTION 'Decided reconciliation candidates cannot change state'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state <> OLD.state AND NEW.decided_at IS NULL THEN
    RAISE EXCEPTION 'Decided reconciliation candidates require decided_at'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER m10_reconciliation_candidate_transition_guard
BEFORE UPDATE OF state, decided_by, decided_at ON reconciliation_candidates
FOR EACH ROW EXECUTE FUNCTION m10_reconciliation_candidate_transition_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION m10_reconciliation_updated_at()
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
CREATE TRIGGER m10_reconciliation_cases_updated_at
BEFORE UPDATE ON reconciliation_cases
FOR EACH ROW EXECUTE FUNCTION m10_reconciliation_updated_at();
--> statement-breakpoint
CREATE TRIGGER m10_reconciliation_evidence_updated_at
BEFORE UPDATE ON reconciliation_evidence
FOR EACH ROW EXECUTE FUNCTION m10_reconciliation_updated_at();
--> statement-breakpoint
CREATE TRIGGER m10_reconciliation_candidates_updated_at
BEFORE UPDATE ON reconciliation_candidates
FOR EACH ROW EXECUTE FUNCTION m10_reconciliation_updated_at();
--> statement-breakpoint

ALTER TABLE reconciliation_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_cases FORCE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_candidates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY reconciliation_cases_tenant_isolation ON reconciliation_cases FOR ALL
USING (
  current_setting('app.is_platform_admin', true) = '1'
  OR organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
)
WITH CHECK (
  current_setting('app.is_platform_admin', true) = '1'
  OR organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
);
--> statement-breakpoint
CREATE POLICY reconciliation_evidence_tenant_isolation ON reconciliation_evidence FOR ALL
USING (
  current_setting('app.is_platform_admin', true) = '1'
  OR organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
)
WITH CHECK (
  current_setting('app.is_platform_admin', true) = '1'
  OR organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
);
--> statement-breakpoint
CREATE POLICY reconciliation_candidates_tenant_isolation ON reconciliation_candidates FOR ALL
USING (
  current_setting('app.is_platform_admin', true) = '1'
  OR organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
)
WITH CHECK (
  current_setting('app.is_platform_admin', true) = '1'
  OR organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
);
--> statement-breakpoint

-- The migration runner reapplies the broad table grant after all migrations;
-- these explicit revokes are repeated there and in test bootstrap. They make
-- the intended runtime boundary visible in a direct upgrade as well.
REVOKE DELETE ON reconciliation_cases, reconciliation_candidates, reconciliation_evidence FROM scolaira_app;
REVOKE UPDATE, DELETE ON reconciliation_evidence FROM scolaira_app;
--> statement-breakpoint

COMMENT ON TABLE reconciliation_cases IS
  'M10 operational review state; never a source of monetary truth';
COMMENT ON TABLE reconciliation_evidence IS
  'M10 append-only evidence for a reconciliation decision';
COMMENT ON TABLE reconciliation_candidates IS
  'M10 explicit human-reviewed payment/student/invoice candidates';
