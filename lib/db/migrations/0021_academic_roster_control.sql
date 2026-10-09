-- =============================================================================
-- M9: Academic roster, term control, and forward-only integrity hardening.
--
-- M8 remains frozen at 0020_term_billing.sql. This migration adds only
-- forward protections and does not create or mutate financial history.
--
-- Required preflight before production application:
--   - duplicate current sessions/terms
--   - cross-tenant academic references
--   - invalid enrollment dates
--   - active enrollments on inactive students / archived classes
--   - duplicate ISSUED receipts per payment
-- The unique indexes/checks below intentionally fail rather than silently
-- repair a pre-existing violation.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Database uniqueness for current academic context and receipt issuance.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX m9_academic_sessions_one_current_idx
  ON academic_sessions (organization_id)
  WHERE is_current = true;
--> statement-breakpoint

CREATE UNIQUE INDEX m9_terms_one_current_idx
  ON terms (organization_id)
  WHERE is_current = true;
--> statement-breakpoint

-- A payment may be re-receipted after the previous receipt is VOID, but it may
-- have at most one concurrently issued receipt. This is the hard race guard
-- beneath the application's read-before-insert idempotency check.
CREATE UNIQUE INDEX m9_receipts_payment_issued_unique_idx
  ON receipts (payment_id)
  WHERE status = 'ISSUED';
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 2. Date invariants. The product permits an explicitly recorded late
-- enrollment; it does not permit inverted intervals.
-- -----------------------------------------------------------------------------
ALTER TABLE academic_sessions
  ADD CONSTRAINT m9_academic_sessions_dates_valid
  CHECK (ends_on IS NULL OR ends_on >= starts_on);
--> statement-breakpoint

ALTER TABLE terms
  ADD CONSTRAINT m9_terms_dates_valid
  CHECK (ends_on IS NULL OR ends_on >= starts_on);
--> statement-breakpoint

ALTER TABLE class_enrollments
  ADD CONSTRAINT m9_class_enrollments_dates_valid
  CHECK (left_on IS NULL OR left_on >= enrolled_on);
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 3. Same-organization relationship guards.
--
-- Foreign keys protect identity, while these triggers protect the denormalized
-- organization_id columns used by RLS and tenant-scoped financial joins.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION m9_terms_tenant_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM academic_sessions s
     WHERE s.id = NEW.session_id
       AND s.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Term session must belong to the same organization'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER m9_terms_tenant_guard
BEFORE INSERT OR UPDATE OF organization_id, session_id ON terms
FOR EACH ROW EXECUTE FUNCTION m9_terms_tenant_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION m9_student_guardians_tenant_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM students s
     WHERE s.id = NEW.student_id
       AND s.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Student guardian link student must belong to the same organization'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM guardians g
     WHERE g.id = NEW.guardian_id
       AND g.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Student guardian link guardian must belong to the same organization'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER m9_student_guardians_tenant_guard
BEFORE INSERT OR UPDATE OF organization_id, student_id, guardian_id ON student_guardians
FOR EACH ROW EXECUTE FUNCTION m9_student_guardians_tenant_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION m9_fee_assignment_tenant_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM terms t
     WHERE t.id = NEW.term_id
       AND t.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Fee assignment term must belong to the same organization'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.class_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM classes c
     WHERE c.id = NEW.class_id
       AND c.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Fee assignment class must belong to the same organization'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER m9_fee_assignment_tenant_guard
BEFORE INSERT OR UPDATE OF organization_id, term_id, class_id ON fee_assignments
FOR EACH ROW EXECUTE FUNCTION m9_fee_assignment_tenant_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION m9_enrollment_integrity_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_term_status term_status;
  v_student_status student_status;
  v_class_deleted_at timestamptz;
BEGIN
  IF NEW.enrolled_on > CURRENT_DATE THEN
    RAISE EXCEPTION 'Enrollment enrolled_on cannot be in the future'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.left_on IS NOT NULL AND NEW.left_on < NEW.enrolled_on THEN
    RAISE EXCEPTION 'Enrollment left_on cannot precede enrolled_on'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT t.status
    INTO v_term_status
    FROM terms t
   WHERE t.id = NEW.term_id
     AND t.organization_id = NEW.organization_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Enrollment term must belong to the same organization'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT s.status
    INTO v_student_status
    FROM students s
   WHERE s.id = NEW.student_id
     AND s.organization_id = NEW.organization_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Enrollment student must belong to the same organization'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT c.deleted_at
    INTO v_class_deleted_at
    FROM classes c
   WHERE c.id = NEW.class_id
     AND c.organization_id = NEW.organization_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Enrollment class must belong to the same organization'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- CLOSED terms are historical and are already blocked by the M8 lock
  -- trigger. A BILLED term may receive an explicit top-up enrollment, but an
  -- active top-up must still point to an active student.
  IF NEW.left_on IS NULL
     AND v_term_status <> 'CLOSED'
     AND v_student_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Inactive students cannot have an active enrollment'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.left_on IS NULL
     AND v_term_status <> 'CLOSED'
     AND v_class_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Archived classes cannot receive active enrollments'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER m9_enrollment_integrity_guard
BEFORE INSERT OR UPDATE OF organization_id, student_id, class_id, term_id, enrolled_on, left_on ON class_enrollments
FOR EACH ROW EXECUTE FUNCTION m9_enrollment_integrity_guard();
--> statement-breakpoint

-- A status change must not leave an active enrollment in a future/current
-- billable term. Closed-term history is intentionally not rewritten because
-- M8 makes closed enrollment rows immutable.
CREATE OR REPLACE FUNCTION m9_student_status_enrollment_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status <> 'ACTIVE' AND OLD.status = 'ACTIVE' AND EXISTS (
    SELECT 1
      FROM class_enrollments e
      JOIN terms t ON t.id = e.term_id
     WHERE e.organization_id = NEW.organization_id
       AND e.student_id = OLD.id
       AND e.left_on IS NULL
       AND t.status <> 'CLOSED'
  ) THEN
    RAISE EXCEPTION 'Close active enrollments before making a student inactive'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER m9_student_status_enrollment_guard
BEFORE UPDATE OF status ON students
FOR EACH ROW EXECUTE FUNCTION m9_student_status_enrollment_guard();
--> statement-breakpoint

-- Do not archive a class while it still carries an active enrollment in an
-- open/billable term. Historical closed-term rows may retain the class.
CREATE OR REPLACE FUNCTION m9_class_archive_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND EXISTS (
    SELECT 1
      FROM class_enrollments e
      JOIN terms t ON t.id = e.term_id
     WHERE e.organization_id = NEW.organization_id
       AND e.class_id = OLD.id
       AND e.left_on IS NULL
       AND t.status <> 'CLOSED'
  ) THEN
    RAISE EXCEPTION 'A class with active open-term enrollments cannot be archived'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER m9_class_archive_guard
BEFORE UPDATE OF deleted_at ON classes
FOR EACH ROW EXECUTE FUNCTION m9_class_archive_guard();
--> statement-breakpoint

-- M8 deliberately permits an enrollment DELETE in a BILLED term so its
-- trigger can return OLD. M9 makes the historical boundary explicit: after
-- billing, leave the enrollment instead of deleting it.
CREATE OR REPLACE FUNCTION m9_enrollment_delete_guard()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_status term_status;
BEGIN
  SELECT t.status
    INTO v_status
    FROM terms t
   WHERE t.id = OLD.term_id
     AND t.organization_id = OLD.organization_id
   FOR SHARE;

  IF v_status IN ('BILLED', 'CLOSED') THEN
    RAISE EXCEPTION 'Enrollment history cannot be deleted after a term is billed'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN OLD;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER m9_enrollment_delete_guard
BEFORE DELETE ON class_enrollments
FOR EACH ROW EXECUTE FUNCTION m9_enrollment_delete_guard();
--> statement-breakpoint

-- Application enrollment writes use leave/update, never hard-delete. Keep a
-- second line of defense against destructive runtime mutations while allowing
-- the owner/migration principal to perform controlled maintenance if required.
REVOKE DELETE ON class_enrollments FROM scolaira_app;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 4. Database metadata comment for operators and migration inspection.
-- -----------------------------------------------------------------------------
COMMENT ON INDEX m9_academic_sessions_one_current_idx IS
  'M9: at most one current academic session per organization';
COMMENT ON INDEX m9_terms_one_current_idx IS
  'M9: at most one current term per organization';
COMMENT ON INDEX m9_receipts_payment_issued_unique_idx IS
  'M9: at most one issued receipt per payment; VOID receipts may be reissued';
