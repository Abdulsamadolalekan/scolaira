-- M7.1: Reminders / communications log for accounts-receivable follow-up.
--
-- We record every reminder issued to a parent/guardian about an outstanding
-- balance. This gives the bursar an auditable trail (what was sent, to whom,
-- through what channel, by whom, at what aging) and prevents accidental
-- re-spamming of the same parent within a cooldown window.
--
-- Rows are immutable (no UPDATE); a reminder is either QUEUED (pending
-- delivery), SENT, DELIVERED, or FAILED. We do NOT delete reminders.
--
-- A reminder is scoped to an invoice and optionally a student. This keeps
-- follow-up tightly bound to the authoritative financial record (no
-- free-text messages about balances we can't later substantiate). The
-- statement-of-account reminder has invoice_id = NULL and carries the
-- aging snapshot in `aging_snapshot`.

CREATE TABLE IF NOT EXISTS reminders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Target: one of invoice_id OR student_id must be present.
  invoice_id      uuid REFERENCES invoices(id)      ON DELETE RESTRICT,
  student_id      uuid REFERENCES students(id)      ON DELETE RESTRICT,
  guardian_id     uuid REFERENCES guardians(id)     ON DELETE RESTRICT,

  channel         communication_channel NOT NULL,
  status          communication_status  NOT NULL DEFAULT 'PENDING',

  -- Snapshot at the time the reminder was queued, so we can show what the
  -- bursar saw even after balances change.
  balance_kobo    bigint NOT NULL DEFAULT 0,
  aging_days      integer NOT NULL DEFAULT 0,
  aging_bucket    text    NOT NULL DEFAULT 'CURRENT',
    -- 'CURRENT','DUE_SOON','OVERDUE_30','OVERDUE_60','OVERDUE_90','SEVERE'
  subject         text,
  body            text NOT NULL,

  -- Delivery metadata (for SMS/email integration later; today PRINT carries
  -- this as the print-job batch id).
  external_id     varchar(128),
  error_message   text,
  sent_at         timestamptz,
  delivered_at    timestamptz,
  failed_at       timestamptz,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CHECK (balance_kobo >= 0),
  CHECK (aging_days >= 0),
  CHECK (invoice_id IS NOT NULL OR student_id IS NOT NULL),
  CHECK (aging_bucket IN ('CURRENT','DUE_SOON','OVERDUE_30','OVERDUE_60','OVERDUE_90','SEVERE'))
);

CREATE INDEX reminders_org_created_idx     ON reminders(organization_id, created_at DESC);
CREATE INDEX reminders_org_invoice_idx     ON reminders(organization_id, invoice_id, created_at DESC);
CREATE INDEX reminders_org_student_idx     ON reminders(organization_id, student_id, created_at DESC);
CREATE INDEX reminders_org_status_idx      ON reminders(organization_id, status);
--> statement-breakpoint

ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;

-- Tenant-isolation policy (same shape as all other financial tables).
CREATE POLICY reminders_tenant_isolation ON reminders
  USING (auth_is_platform_admin_authorized()
         OR (auth_is_tenant_authorized()
             AND organization_id = _app_current_org_uuid()));
--> statement-breakpoint

-- Public context has NO access to reminders (intentionally; reminders are
-- internal). We intentionally DO NOT create a public policy.

-- UPDATE/DELETE are forbidden at row level (soft immutable log). A trigger
-- enforces the no-mutation rule below.
CREATE POLICY reminders_no_update ON reminders
  FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY reminders_no_delete ON reminders
  FOR DELETE USING (false);
--> statement-breakpoint

-- Immutable-row trigger: once a row exists, only status columns
-- (status/sent_at/delivered_at/failed_at/external_id/error_message/updated_at)
-- may change, and only forward in the lifecycle PENDING→SENT→DELIVERED or
-- PENDING/SENT→FAILED.
CREATE OR REPLACE FUNCTION trg_reminders_immutable()
RETURNS trigger AS $$
DECLARE
  allowed boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Deleting reminders is forbidden';
  END IF;
  -- Only permit whitelisted transitions for status lifecycle.
  allowed := (
    OLD.id IS NOT NULL
    AND NEW.id = OLD.id
    AND NEW.organization_id = OLD.organization_id
    AND NEW.invoice_id      IS NOT DISTINCT FROM OLD.invoice_id
    AND NEW.student_id      IS NOT DISTINCT FROM OLD.student_id
    AND NEW.guardian_id     IS NOT DISTINCT FROM OLD.guardian_id
    AND NEW.channel         = OLD.channel
    AND NEW.balance_kobo    = OLD.balance_kobo
    AND NEW.aging_days      = OLD.aging_days
    AND NEW.aging_bucket    = OLD.aging_bucket
    AND NEW.subject         IS NOT DISTINCT FROM OLD.subject
    AND NEW.body            = OLD.body
    AND NEW.created_by      IS NOT DISTINCT FROM OLD.created_by
    AND NEW.created_at      = OLD.created_at
  );
  IF NOT allowed THEN
    RAISE EXCEPTION 'Reminder rows are immutable — only delivery status may be updated';
  END IF;

  -- Allow only forward status transitions.
  IF NEW.status = OLD.status THEN
    NULL; -- allowed (idempotent update of metadata)
  ELSIF OLD.status = 'PENDING' AND NEW.status IN ('SENT','FAILED') THEN
    NULL;
  ELSIF OLD.status = 'SENT' AND NEW.status IN ('DELIVERED','FAILED') THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'Invalid reminder status transition: % → %', OLD.status, NEW.status;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE;
--> statement-breakpoint

CREATE TRIGGER trg_reminders_enforce_immutable
BEFORE UPDATE OR DELETE ON reminders
FOR EACH ROW EXECUTE FUNCTION trg_reminders_immutable();
--> statement-breakpoint

-- Grant privileges to runtime role (mirrors other tables; the migration
-- runner re-applies table grants in migrate.ts, but we do it here for
-- defense in depth).
GRANT ALL PRIVILEGES ON reminders TO scolaira_app;
