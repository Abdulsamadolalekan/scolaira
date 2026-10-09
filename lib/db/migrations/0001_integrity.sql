-- =============================================================================
-- 0001_integrity.sql
--
-- Adds to the tables created by 0000_init.sql:
--   - CHECK constraints (non-negative kobo, statuses, valid amounts, etc.)
--   - Partial unique indexes (reference uniqueness per method, etc.)
--   - Per-organization receipt number sequences (for RCP-YYYY-NNNNNN)
--   - updated_at automatic trigger
--   - Financial invariant triggers:
--       * invoice total = SUM(lines.amount)
--       * allocation amount <= payment.unallocated AND <= invoice.outstanding
--       * payment.unallocated maintained automatically
--       * invoice.paid_kobo maintained automatically
--       * invoice.status derived automatically
--       * invoice lines frozen after invoice issuance
--       * allocation.status/reversal id validation
--       * reversal <= reversible amount
--       * positive payment amounts, non-empty reversal reasons
--   - State-machine transition enforcement (generic guard function)
--   - Audit trigger helper + "no delete/udpate on audit_events" protection
--   - RLS: enable on all tenant tables, set up app role, set_tenant_context
--   - Index cleanup (payment_allocations.reversal_id FK)
--
-- Source of truth for invariants: docs/FINANCIAL_INVARIANTS.md
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. DOMAIN types for kobo (defensive: even if BIGINT is the storage, DOMAINs
--    encode non-negative CHECK at the type level for columns that opt in.)
-- -----------------------------------------------------------------------------
CREATE DOMAIN kobo_value AS BIGINT CHECK (VALUE >= 0);
CREATE DOMAIN signed_kobo_value AS BIGINT;
CREATE DOMAIN naira_string AS TEXT CHECK (VALUE ~ '^-?(0|[1-9]\d{0,14})\.\d{2}$');
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 2. Apply kobo_value domain / CHECK constraints to money columns.
--    Drizzle generated bigint columns without checks; we now add constraints.
--    Adding them as named CHECKs keeps errors legible.
-- -----------------------------------------------------------------------------
-- We alter the column TYPE for strict columns (which rejects negatives at the
-- storage level). For columns that represent derived/signed values we use CHECK
-- constraints instead.

-- fee_assignments.amount_kobo — non-negative
ALTER TABLE "fee_assignments"
  ALTER COLUMN "amount_kobo" TYPE kobo_value
  USING "amount_kobo"::kobo_value;
ALTER TABLE "fee_assignments"
  DROP CONSTRAINT IF EXISTS fee_assign_amount_nonneg;
ALTER TABLE "fee_assignments"
  ADD CONSTRAINT fee_assign_amount_nonneg CHECK ("amount_kobo" >= 0);
--> statement-breakpoint

-- invoices total/paid
ALTER TABLE "invoices"
  ALTER COLUMN "total_kobo" TYPE kobo_value USING "total_kobo"::kobo_value;
ALTER TABLE "invoices"
  ALTER COLUMN "paid_kobo" TYPE kobo_value USING "paid_kobo"::kobo_value;
--> statement-breakpoint

-- invoice_lines amounts/rates
ALTER TABLE "invoice_lines"
  ALTER COLUMN "unit_rate_kobo" TYPE kobo_value USING "unit_rate_kobo"::kobo_value;
ALTER TABLE "invoice_lines"
  ALTER COLUMN "amount_kobo" TYPE kobo_value USING "amount_kobo"::kobo_value;
--> statement-breakpoint

-- payments
ALTER TABLE "payments"
  ALTER COLUMN "amount_kobo" TYPE kobo_value USING "amount_kobo"::kobo_value;
ALTER TABLE "payments"
  ALTER COLUMN "unallocated_kobo" TYPE kobo_value USING "unallocated_kobo"::kobo_value;
ALTER TABLE "payments"
  ADD CONSTRAINT payments_amount_positive CHECK ("amount_kobo" > 0);
ALTER TABLE "payments"
  ADD CONSTRAINT payments_unalloc_nonneg CHECK ("unallocated_kobo" >= 0);
--> statement-breakpoint

-- payment_allocations
ALTER TABLE "payment_allocations"
  ALTER COLUMN "amount_kobo" TYPE kobo_value USING "amount_kobo"::kobo_value;
ALTER TABLE "payment_allocations"
  ADD CONSTRAINT allocations_amount_positive CHECK ("amount_kobo" > 0);
--> statement-breakpoint

-- receipts
ALTER TABLE "receipts"
  ALTER COLUMN "amount_kobo" TYPE kobo_value USING "amount_kobo"::kobo_value;
--> statement-breakpoint

-- reversals
ALTER TABLE "reversals"
  ALTER COLUMN "amount_kobo" TYPE kobo_value USING "amount_kobo"::kobo_value;
ALTER TABLE "reversals"
  ADD CONSTRAINT reversals_amount_positive CHECK ("amount_kobo" > 0);
ALTER TABLE "reversals"
  ADD CONSTRAINT reversals_reason_required CHECK (length(trim("reason")) > 0);
--> statement-breakpoint

-- 2b. Non-negative checks for additional _kobo columns not using the kobo_value domain
--     (defensive; added during M2 architecture gate).
ALTER TABLE "fee_assignments"
  ADD CONSTRAINT fee_assign_adjustment_nonneg CHECK ("adjustment_kobo" IS NULL OR "adjustment_kobo" >= 0);
ALTER TABLE "invoice_lines"
  ADD CONSTRAINT inv_lines_adjustment_nonneg CHECK ("adjustment_kobo" IS NULL OR "adjustment_kobo" >= 0);
ALTER TABLE "payment_links"
  ADD CONSTRAINT pay_links_amount_nonneg CHECK ("amount_kobo" IS NULL OR "amount_kobo" >= 0);

-- 2c. Single-statement guard: payment.unallocated_kobo must not exceed amount_kobo.
ALTER TABLE "payments"
  ADD CONSTRAINT pay_unalloc_le_amount CHECK ("unallocated_kobo" <= "amount_kobo");

--> statement-breakpoint


-- payment_links amount is optional and signed (null = open amount; negative not allowed when present)
ALTER TABLE "payment_links"
  ADD CONSTRAINT payment_links_amt_nonneg CHECK ("amount_kobo" IS NULL OR "amount_kobo" >= 0);
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 3. Partial unique index: reference is unique within org for non-CASH methods
--    (CASH may legitimately have no reference, or reuse a generic "CASH" stub).
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS payments_org_reference_unique_idx
  ON "payments" ("organization_id", "reference")
  WHERE "reference" IS NOT NULL AND "method" IN ('BANK_TRANSFER','POS','ONLINE');
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 4. Foreign keys / indexes Drizzle missed
--    - payment_allocations.reversal_id -> reversals.id (circular, added post-hoc)
-- -----------------------------------------------------------------------------
-- Add reversal_id FK only if not already present (defensive for re-runs).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE constraint_name = 'payment_allocations_reversal_id_fkey'
       AND table_name = 'payment_allocations'
  ) THEN
    ALTER TABLE "payment_allocations"
      ADD CONSTRAINT payment_allocations_reversal_id_fkey
      FOREIGN KEY ("reversal_id") REFERENCES "reversals"("id") ON DELETE SET NULL;
  END IF;
END;
$$;
CREATE INDEX IF NOT EXISTS allocations_reversal_idx ON "payment_allocations"("reversal_id");
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 5. updated_at trigger (applies to every table with updated_at)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE;
--> statement-breakpoint

-- Generate per-table triggers dynamically
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT table_name
    FROM information_schema.columns
    WHERE column_name = 'updated_at'
      AND table_schema = 'public'
  LOOP
    EXECUTE format(
      'CREATE OR REPLACE TRIGGER set_updated_at_%I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at();',
      t, t
    );
  END LOOP;
END;
$$;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 6. Generic invoice-outstanding computed helper (SQL/PLpgSQL function, not a
--    generated column — used by the allocation trigger).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION invoice_outstanding_kobo(p_invoice_id uuid)
RETURNS BIGINT AS $$
DECLARE
  v_total BIGINT;
  v_paid BIGINT;
BEGIN
  SELECT "total_kobo", "paid_kobo"
    INTO v_total, v_paid
    FROM "invoices"
   WHERE "id" = p_invoice_id;
  RETURN v_total - v_paid;
END;
$$ LANGUAGE plpgsql STABLE;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 7. Financial invariant trigger — payment_allocations
--    Validates and updates payment.unallocated_kobo and invoice.paid_kobo
--    atomically on ALLOCATION INSERT.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_allocations_insert()
RETURNS TRIGGER AS $$
DECLARE
  v_pay_unalloc BIGINT;
  v_invoice_outstanding BIGINT;
  v_invoice_status invoice_status;
BEGIN
  -- Lock payment and invoice (in deterministic order to avoid deadlocks)
  PERFORM 1 FROM "payments" WHERE "id" = NEW."payment_id" FOR UPDATE;
  PERFORM 1 FROM "invoices"  WHERE "id" = NEW."invoice_id" FOR UPDATE;

  SELECT "unallocated_kobo" INTO v_pay_unalloc
    FROM "payments" WHERE "id" = NEW."payment_id";
  SELECT invoice_outstanding_kobo(NEW."invoice_id") INTO v_invoice_outstanding;
  SELECT "status" INTO v_invoice_status
    FROM "invoices" WHERE "id" = NEW."invoice_id";

  IF v_invoice_status = 'VOID' THEN
    RAISE EXCEPTION 'Cannot allocate against a void invoice (invoice_id=%)', NEW."invoice_id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."amount_kobo" > v_pay_unalloc THEN
    RAISE EXCEPTION 'Allocation amount (% kobo) exceeds payment unallocated (% kobo)',
      NEW."amount_kobo", v_pay_unalloc
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."amount_kobo" > v_invoice_outstanding THEN
    RAISE EXCEPTION 'Allocation amount (% kobo) exceeds invoice outstanding (% kobo)',
      NEW."amount_kobo", v_invoice_outstanding
      USING ERRCODE = 'check_violation';
  END IF;

  -- Reduce payment.unallocated
  UPDATE "payments"
     SET "unallocated_kobo" = "unallocated_kobo" - NEW."amount_kobo"
   WHERE "id" = NEW."payment_id";

  -- Increase invoice.paid and recompute status
  UPDATE "invoices"
     SET "paid_kobo" = "paid_kobo" + NEW."amount_kobo"
   WHERE "id" = NEW."invoice_id";

  -- Invoice status recompute
  UPDATE "invoices"
     SET "status" = CASE
       WHEN "status" IN ('DRAFT','VOID') THEN "status"   -- unchanged if draft/void
       WHEN "paid_kobo" = 0            THEN 'ISSUED'
       WHEN "paid_kobo" >= "total_kobo" THEN 'PAID'
       ELSE 'PARTIALLY_PAID'
     END
   WHERE "id" = NEW."invoice_id";

  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE;
--> statement-breakpoint

CREATE OR REPLACE TRIGGER allocations_insert_trg
BEFORE INSERT ON "payment_allocations"
FOR EACH ROW
WHEN (NEW."status" = 'ACTIVE')
EXECUTE FUNCTION trg_allocations_insert();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 8. Block direct UPDATE of paid_kobo / total_kobo / unallocated_kobo.
--    Only internal triggers (allocations, reversals, invoice_lines changes,
--    payment CONFIRM-seeding) are allowed to mutate these columns. The guard
--    uses pg_trigger_depth() >= 2: that means this guard trigger was entered
--    as a side-effect of another trigger firing (i.e. the UPDATE originated
--    from inside the trigger stack, not directly from a client statement).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_guard_financial_columns()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  -- Allow updates that originate from another trigger (e.g. allocations, reversals)
  -- but block direct client/session UPDATEs of financial columns.
  -- pg_trigger_depth() = 0 means the UPDATE came directly from the client; = 1 means
  -- this guard trigger is the first trigger firing (client-initiated). When another
  -- trigger issues the UPDATE, depth >= 2 here.
  IF pg_trigger_depth() >= 2 THEN
    RETURN NEW;
  END IF;
  IF NEW."paid_kobo" IS DISTINCT FROM OLD."paid_kobo"
  OR NEW."total_kobo" IS DISTINCT FROM OLD."total_kobo" THEN
    RAISE EXCEPTION 'Direct update of invoices.total_kobo/paid_kobo is forbidden; use invoice_lines/allocation triggers.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE;
--> statement-breakpoint

CREATE OR REPLACE TRIGGER invoices_guard_financial_cols
BEFORE UPDATE ON "invoices"
FOR EACH ROW EXECUTE FUNCTION trg_guard_financial_columns();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_guard_payment_unalloc()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF pg_trigger_depth() >= 2 THEN
    RETURN NEW;
  END IF;
  IF NEW."unallocated_kobo" IS DISTINCT FROM OLD."unallocated_kobo" THEN
    RAISE EXCEPTION 'Direct update of payments.unallocated_kobo is forbidden; use allocations/reversals.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE;
--> statement-breakpoint

CREATE OR REPLACE TRIGGER payments_guard_unalloc
BEFORE UPDATE ON "payments"
FOR EACH ROW EXECUTE FUNCTION trg_guard_payment_unalloc();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 9. Invoice total maintenance: total_kobo = SUM(lines.amount) + adjustments.
--    Lines can change only while invoice is DRAFT.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_invoice_lines_change()
RETURNS TRIGGER AS $$
DECLARE
  v_invoice_status invoice_status;
  v_total BIGINT;
BEGIN
  -- Determine which invoice we affect
  DECLARE
    v_invoice_id uuid := COALESCE(NEW."invoice_id", OLD."invoice_id");
  BEGIN
    SELECT "status" INTO v_invoice_status FROM "invoices" WHERE "id" = v_invoice_id;

    IF (TG_OP IN ('UPDATE','DELETE')) AND v_invoice_status NOT IN ('DRAFT') THEN
      RAISE EXCEPTION 'Invoice lines cannot be modified after issuance (invoice status=%)', v_invoice_status
        USING ERRCODE = 'check_violation';
    END IF;

    -- Recompute total
    SELECT COALESCE(SUM("amount_kobo"), 0) INTO v_total
      FROM "invoice_lines"
     WHERE "invoice_id" = v_invoice_id;

    UPDATE "invoices"
       SET "total_kobo" = v_total
     WHERE "id" = v_invoice_id;
  END;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE;
--> statement-breakpoint

CREATE OR REPLACE TRIGGER invoice_lines_insert_trg
AFTER INSERT ON "invoice_lines" FOR EACH ROW EXECUTE FUNCTION trg_invoice_lines_change();
CREATE OR REPLACE TRIGGER invoice_lines_update_trg
AFTER UPDATE ON "invoice_lines" FOR EACH ROW EXECUTE FUNCTION trg_invoice_lines_change();
CREATE OR REPLACE TRIGGER invoice_lines_delete_trg
AFTER DELETE ON "invoice_lines" FOR EACH ROW EXECUTE FUNCTION trg_invoice_lines_change();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 10. invoice_lines.amount_kobo derived: amount = unit_rate*quantity + adjustment
--     when adjustment is present and amount is not explicitly overridden.
--     We allow explicit amount to allow ad-hoc lines with no fee assignment.
-- -----------------------------------------------------------------------------
-- (Implemented as a BEFORE INSERT/UPDATE trigger so it's automatic only when
-- the caller leaves amount_kobo equal to (unit_rate*qty); no forced override.)
-- For now we enforce only that amount_kobo equals (unit_rate_kobo*quantity)+adjustment_kobo
-- when unit_rate is set (catalog lines).
ALTER TABLE "invoice_lines"
  ADD CONSTRAINT invoice_lines_amount_matches CHECK (
    ("unit_rate_kobo" IS NULL) OR
    ("amount_kobo" = "unit_rate_kobo" * "quantity" + "adjustment_kobo")
  );
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 11. State machine enforcement (generic, table-driven via CASE).
--     We use a transition table per entity: the mapping function below raises if
--     the transition is not in the allowed set. The guard is a BEFORE UPDATE
--     trigger on each status-bearing table.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION can_transition(entity regclass, old_status text, new_status text)
RETURNS boolean AS $$
DECLARE
  allowed text[];
BEGIN
  CASE entity::text
    WHEN 'students' THEN
      allowed := ARRAY[
        'ACTIVE->ARCHIVED','ACTIVE->WITHDRAWN','ACTIVE->GRADUATED',
        'ARCHIVED->ACTIVE','WITHDRAWN->ACTIVE','GRADUATED->ACTIVE'
      ];
    WHEN 'invoices' THEN
      allowed := ARRAY[
        'DRAFT->ISSUED','DRAFT->VOID',
        'ISSUED->PARTIALLY_PAID','ISSUED->PAID','ISSUED->VOID',
        'PARTIALLY_PAID->PAID','PARTIALLY_PAID->ISSUED','PARTIALLY_PAID->VOID',
        'PAID->PARTIALLY_PAID','PAID->VOID',  -- reopen after reversal
        'VOID->DRAFT'  -- exceptional reopen, audited separately
      ];
    WHEN 'payments' THEN
      allowed := ARRAY[
        'PENDING->CONFIRMED','PENDING->FAILED','PENDING->REJECTED','PENDING->DUPLICATE_SUSPECT',
        'CONFIRMED->REVERSED','CONFIRMED->REFUNDED','CONFIRMED->DUPLICATE_SUSPECT',
        'DUPLICATE_SUSPECT->CONFIRMED','DUPLICATE_SUSPECT->REVERSED','DUPLICATE_SUSPECT->REFUNDED',
        'FAILED->CONFIRMED' -- retry success
      ];
    WHEN 'payment_allocations' THEN
      allowed := ARRAY['ACTIVE->REVERSED'];
    WHEN 'receipts' THEN
      allowed := ARRAY['ISSUED->VOID'];
    WHEN 'payment_links' THEN
      allowed := ARRAY['ACTIVE->PAID','ACTIVE->EXPIRED','ACTIVE->REVOKED','EXPIRED->ACTIVE'];
    WHEN 'communications' THEN
      allowed := ARRAY[
        'PENDING->SENT','PENDING->FAILED',
        'SENT->DELIVERED','SENT->FAILED',
        'DELIVERED->FAILED'
      ];
    WHEN 'academic_sessions' THEN
      allowed := ARRAY['PLANNED->ACTIVE','ACTIVE->CLOSED','CLOSED->ACTIVE'];
    WHEN 'terms' THEN
      allowed := ARRAY[
        'PLANNED->ACTIVE','ACTIVE->BILLED','BILLED->CLOSED','CLOSED->ACTIVE'
      ];
    WHEN 'fee_assignments' THEN
      allowed := ARRAY['DRAFT->ACTIVE','ACTIVE->ARCHIVED','ARCHIVED->ACTIVE'];
    ELSE
      RETURN true; -- entity not guarded by default
  END CASE;
  RETURN (old_status||'->'||new_status) = ANY(allowed);
END;
$$ LANGUAGE plpgsql STABLE;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_enforce_status_transitions()
RETURNS TRIGGER AS $$
DECLARE
  entity regclass := TG_TABLE_NAME::regclass;
  old_s text;
  new_s text;
BEGIN
  -- Only act when status column is changing
  IF to_jsonb(NEW) ? 'status' IS DISTINCT FROM true THEN
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT ($1::%I).status', TG_TABLE_NAME) INTO old_s USING OLD;
  EXECUTE format('SELECT ($1::%I).status', TG_TABLE_NAME) INTO new_s USING NEW;
  IF old_s IS NOT DISTINCT FROM new_s THEN
    RETURN NEW;
  END IF;
  IF NOT can_transition(entity, old_s, new_s) THEN
    RAISE EXCEPTION 'Invalid status transition for %: % -> %', entity, old_s, new_s
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE;
--> statement-breakpoint

-- Attach transition guard to all status-bearing tables
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN VALUES ('students'),('invoices'),('payments'),('payment_allocations'),
                  ('receipts'),('payment_links'),('communications'),
                  ('academic_sessions'),('terms'),('fee_assignments') LOOP
    EXECUTE format(
      'CREATE OR REPLACE TRIGGER enforce_status_transitions_%I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION trg_enforce_status_transitions();',
      t, t
    );
  END LOOP;
END;
$$;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 12. Reversal impact: on reversal INSERT, decrement paid_kobo and update
--     allocations/payment status. Reversals are append-only (no UPDATE/DELETE
--     allowed via RLS / normal role; triggers do not fire on update since
--     reversals don't have one — there's no trigger because we use a guard).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_reversals_insert()
RETURNS TRIGGER AS $$
DECLARE
  v_payment payments%ROWTYPE;
  v_remaining kobo_value := NEW."amount_kobo";
  v_alloc RECORD;
  v_alloc_amt BIGINT;
BEGIN
  IF NEW."payment_id" IS NULL THEN
    -- CORRECTION-only reversal (no payment) would be for future cross-payment fixes; disallow for now.
    RAISE EXCEPTION 'Reversals in M2 must reference a payment.';
  END IF;

  -- Lock payment
  SELECT * INTO v_payment FROM "payments" WHERE "id" = NEW."payment_id" FOR UPDATE;

  -- Total reversible amount = payment amount - already reversed
  DECLARE
    already_reversed BIGINT;
  BEGIN
    SELECT COALESCE(SUM("amount_kobo"), 0)
      INTO already_reversed
      FROM "reversals"
     WHERE "payment_id" = NEW."payment_id"
       AND "id" <> NEW."id";
    IF NEW."amount_kobo" > (v_payment."amount_kobo" - already_reversed) THEN
      RAISE EXCEPTION 'Reversal amount (% kobo) exceeds remaining reversible amount on payment (% kobo)',
        NEW."amount_kobo", (v_payment."amount_kobo" - already_reversed)
        USING ERRCODE = 'check_violation';
    END IF;
  END;

  -- Reverse allocations oldest-first until reversal amount is consumed
  FOR v_alloc IN
    SELECT pa.* FROM "payment_allocations" pa
     WHERE pa."payment_id" = NEW."payment_id"
       AND pa."status" = 'ACTIVE'
     ORDER BY pa."allocated_at" ASC, pa."id" ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_alloc_amt := LEAST(v_alloc."amount_kobo", v_remaining);

    -- Mark allocation reversed if fully reversed, otherwise keep ACTIVE (partial
    -- allocation reversal is not supported in M2 — we always reverse full
    -- allocations or fail with a clear error; simpler invariant).
    IF v_alloc_amt <> v_alloc."amount_kobo" THEN
      RAISE EXCEPTION 'Partial allocation reversal not supported in M2; reverse entire allocations.';
    END IF;

    UPDATE "payment_allocations"
       SET "status" = 'REVERSED',
           "reversal_id" = NEW."id"
     WHERE "id" = v_alloc."id";

    UPDATE "invoices"
       SET "paid_kobo" = "paid_kobo" - v_alloc_amt
     WHERE "id" = v_alloc."invoice_id";

    -- Recompute invoice status
    UPDATE "invoices"
       SET "status" = CASE
         WHEN "paid_kobo" = 0            THEN 'ISSUED'::invoice_status
         WHEN "paid_kobo" >= "total_kobo" THEN 'PAID'::invoice_status
         ELSE 'PARTIALLY_PAID'::invoice_status
       END
     WHERE "id" = v_alloc."invoice_id";

    -- Restore unallocated on payment only if the payment was CONFIRMED and
    -- reversal is REVERSAL (for REFUND, money left the system entirely so
    -- unallocated stays 0)
    IF NEW."type" IN ('REVERSAL','CORRECTION') THEN
      UPDATE "payments"
         SET "unallocated_kobo" = "unallocated_kobo" + v_alloc_amt
       WHERE "id" = NEW."payment_id";
    END IF;

    v_remaining := v_remaining - v_alloc_amt;
  END LOOP;

  -- Payment status update (if fully reversed/refunded)
  DECLARE
    v_any_active_alloc BOOLEAN;
  BEGIN
    SELECT EXISTS(
      SELECT 1 FROM "payment_allocations"
       WHERE "payment_id" = NEW."payment_id" AND "status" = 'ACTIVE'
    ) INTO v_any_active_alloc;

    IF NOT v_any_active_alloc THEN
      UPDATE "payments"
         SET "status" = CASE NEW."type"
           WHEN 'REFUND' THEN 'REFUNDED'::payment_status
           ELSE 'REVERSED'::payment_status
         END
       WHERE "id" = NEW."payment_id";
    END IF;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE;
--> statement-breakpoint

CREATE OR REPLACE TRIGGER reversals_insert_trg
AFTER INSERT ON "reversals"
FOR EACH ROW EXECUTE FUNCTION trg_reversals_insert();
--> statement-breakpoint

-- Reversals are immutable: no UPDATE/DELETE
CREATE OR REPLACE FUNCTION trg_block_reversal_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Reversals are append-only and cannot be modified or deleted.'
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql VOLATILE;
--> statement-breakpoint

CREATE OR REPLACE TRIGGER reversals_block_update
BEFORE UPDATE ON "reversals" FOR EACH ROW EXECUTE FUNCTION trg_block_reversal_mutation();
CREATE OR REPLACE TRIGGER reversals_block_delete
BEFORE DELETE ON "reversals" FOR EACH ROW EXECUTE FUNCTION trg_block_reversal_mutation();
--> statement-breakpoint

-- Block DELETE on financial records entirely
CREATE OR REPLACE FUNCTION trg_block_financial_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Deleting financial records is forbidden. Use reversal/refund/void instead.'
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql VOLATILE;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOR t IN VALUES ('invoices'),('invoice_lines'),('payments'),('payment_allocations'),('receipts') LOOP
    EXECUTE format(
      'CREATE OR REPLACE TRIGGER block_financial_delete_%I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION trg_block_financial_delete();',
      t, t
    );
  END LOOP;
END;
$$;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 13. Audit events are append-only (no UPDATE/DELETE).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_audit_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Audit events are append-only.'
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql VOLATILE;
--> statement-breakpoint

CREATE OR REPLACE TRIGGER audit_block_update BEFORE UPDATE ON "audit_events" FOR EACH ROW EXECUTE FUNCTION trg_audit_immutable();
CREATE OR REPLACE TRIGGER audit_block_delete BEFORE DELETE ON "audit_events" FOR EACH ROW EXECUTE FUNCTION trg_audit_immutable();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 14. Issued-at/paid-at timestamps on status change.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_set_status_timestamps()
RETURNS TRIGGER AS $$
BEGIN
  -- invoices
  IF TG_TABLE_NAME = 'invoices' THEN
    IF TG_OP = 'UPDATE' AND NEW."status" = 'ISSUED' AND OLD."status" = 'DRAFT' THEN
      NEW."issued_at" = now();
    END IF;
    IF NEW."status" = 'VOID' AND (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM 'VOID') THEN
      NEW."voided_at" = now();
    END IF;
  END IF;
  -- payments
  IF TG_TABLE_NAME = 'payments' THEN
    -- Initialize unallocated = amount ONLY when a payment first enters CONFIRMED
    -- (i.e. TG_OP = INSERT with status CONFIRMED, or TG_OP = UPDATE where OLD.status
    -- != CONFIRMED and NEW.status = CONFIRMED). Do NOT re-initialize on every
    -- update to CONFIRMED payments (allocation triggers decrement unallocated).
    IF NEW."status" = 'CONFIRMED'
       AND (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM 'CONFIRMED') THEN
      IF NEW."paid_at" IS NULL THEN NEW."paid_at" = now(); END IF;
      IF NEW."unallocated_kobo" IS NULL OR NEW."unallocated_kobo" = 0 THEN
        NEW."unallocated_kobo" = NEW."amount_kobo";
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE;
--> statement-breakpoint

CREATE OR REPLACE TRIGGER invoices_status_timestamps
BEFORE INSERT OR UPDATE ON "invoices" FOR EACH ROW EXECUTE FUNCTION trg_set_status_timestamps();
CREATE OR REPLACE TRIGGER payments_status_timestamps
BEFORE INSERT OR UPDATE ON "payments" FOR EACH ROW EXECUTE FUNCTION trg_set_status_timestamps();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 15. Payment reference duplication guard: prevent inserting a CONFIRMED payment
--     with a reference that already exists for another confirmed payment in the
--     same org. This is defense in depth beyond the partial unique index above
--     (which covers BANK_TRANSFER/POS/ONLINE including PENDING).
-- -----------------------------------------------------------------------------
-- (The unique index payments_org_reference_unique_idx is the guard.)

-- -----------------------------------------------------------------------------
-- 16. RLS: enable RLS on every tenant table; default-deny; policy uses the
--     app.organization_id GUC set by set_tenant_context().
-- -----------------------------------------------------------------------------

-- Helper: auto-populate NEW.organization_id from tenant GUC when NULL, so
-- application code can omit it and still satisfy the RLS WITH CHECK policy.
CREATE OR REPLACE FUNCTION trg_set_org_from_context()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."organization_id" IS NULL THEN
    NEW."organization_id" := NULLIF(current_setting('app.organization_id', true), '')::uuid;
  END IF;
  IF NEW."organization_id" IS NULL THEN
    RAISE EXCEPTION 'Cannot insert into % without organization_id and no tenant context set', TG_TABLE_NAME
      USING ERRCODE = 'not_null_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE
    SET search_path = pg_catalog, public;
--> statement-breakpoint

-- Tenant-owned tables (all tables except users, and excluding pure join/lookup
-- tables that always go through their parent).
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN VALUES
    ('organization_members'),('academic_sessions'),('terms'),('classes'),
    ('students'),('guardians'),('student_guardians'),('class_enrollments'),
    ('fee_definitions'),('fee_assignments'),('invoices'),('invoice_lines'),
    ('payments'),('payment_allocations'),('receipts'),('reversals'),
    ('payment_links'),('communications'),('audit_events'),('idempotency_keys'),
    ('webhook_events')
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);

    -- Attach BEFORE INSERT org-auto-populate trigger on each tenant table.
    EXECUTE format(
      'CREATE OR REPLACE TRIGGER %I_set_org BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION trg_set_org_from_context();',
      t, t
    );

    -- Default deny; explicit policies grant access when GUC is set.
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I FOR ALL USING (
         "organization_id" = NULLIF(current_setting(''app.organization_id'', true), '''')::uuid
       ) WITH CHECK (
         "organization_id" = NULLIF(current_setting(''app.organization_id'', true), '''')::uuid
       );',
       t, t
    );
  END LOOP;
END;
$$;
--> statement-breakpoint

-- Also enable on organizations (a user can only see their own org).
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;
CREATE POLICY organizations_tenant_isolation ON "organizations" FOR ALL USING (
  "id" = NULLIF(current_setting('app.organization_id', true), '')::uuid
) WITH CHECK (
  "id" = NULLIF(current_setting('app.organization_id', true), '')::uuid
);
--> statement-breakpoint

-- sessions table: scoped by user_id via app.user_id
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY sessions_user_isolation ON "sessions" FOR ALL USING (
  "user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
);
--> statement-breakpoint

-- users: user can read themselves; platform admins see all — simplified for M2.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
CREATE POLICY users_self_or_admin ON "users" FOR ALL USING (
  "id" = NULLIF(current_setting('app.user_id', true), '')::uuid
  OR current_setting('app.is_platform_admin', true) = '1'
);
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 17. App role + set_tenant_context function (SECURITY DEFINER).
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scolaira_app') THEN
    CREATE ROLE scolaira_app NOINHERIT LOGIN;
  END IF;
END;
$$;
--> statement-breakpoint

-- Grant usage + CRUD to scolaira_app; RLS will enforce tenant isolation.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN VALUES
    ('organizations'),('users'),('organization_members'),('sessions'),
    ('academic_sessions'),('terms'),('classes'),('students'),('guardians'),
    ('student_guardians'),('class_enrollments'),('fee_definitions'),
    ('fee_assignments'),('invoices'),('invoice_lines'),('payments'),
    ('payment_allocations'),('receipts'),('reversals'),('payment_links'),
    ('communications'),('audit_events'),('idempotency_keys'),('webhook_events')
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA public TO scolaira_app;');
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO scolaira_app;', t);
  END LOOP;
  -- sequences / future serials
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO scolaira_app;';
END;
$$;
--> statement-breakpoint

-- Revoke UPDATE/DELETE on audit_events and reversals from scolaira_app to make
-- the triggers/immutability policies defense-in-depth even if RLS is off.
REVOKE UPDATE, DELETE ON "audit_events" FROM scolaira_app;
REVOKE UPDATE, DELETE ON "reversals" FROM scolaira_app;
REVOKE DELETE ON "invoices" FROM scolaira_app;
REVOKE DELETE ON "invoice_lines" FROM scolaira_app;
REVOKE DELETE ON "payments" FROM scolaira_app;
REVOKE DELETE ON "payment_allocations" FROM scolaira_app;
REVOKE DELETE ON "receipts" FROM scolaira_app;
--> statement-breakpoint

-- Secure set_tenant_context: sets app.organization_id, app.user_id, app.is_platform_admin
-- after verifying the user is actually a member of that organization.
CREATE OR REPLACE FUNCTION set_tenant_context(
  p_organization_id uuid,
  p_user_id uuid
) RETURNS void AS $$
DECLARE
  v_role membership_role;
  v_admin boolean;
BEGIN
  IF p_organization_id IS NULL THEN
    PERFORM set_config('app.organization_id', '', false);
    PERFORM set_config('app.user_id', coalesce(p_user_id::text, ''), false);
    PERFORM set_config('app.is_platform_admin', '0', false);
    PERFORM set_config('app.bypass_financial_triggers', '0', false);
    RETURN;
  END IF;

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Cannot set tenant context without user_id';
  END IF;

  SELECT "role" INTO v_role
    FROM "organization_members"
   WHERE "organization_id" = p_organization_id
     AND "user_id" = p_user_id
     AND "status" = 'ACTIVE';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User % is not an active member of organization %', p_user_id, p_organization_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT "is_platform_admin" INTO v_admin FROM "users" WHERE "id" = p_user_id;

  PERFORM set_config('app.organization_id', p_organization_id::text, false);
  PERFORM set_config('app.user_id', p_user_id::text, false);
  PERFORM set_config('app.is_platform_admin', CASE WHEN v_admin THEN '1' ELSE '0' END, false);
  PERFORM set_config('app.bypass_financial_triggers', '0', false);
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public;
--> statement-breakpoint

-- Allow scolaira_app to execute set_tenant_context
GRANT EXECUTE ON FUNCTION set_tenant_context(uuid, uuid) TO scolaira_app;
--> statement-breakpoint

-- System-internal set_context used by migrations/seed/tests that bypasses
-- membership check (used by the SEED/test role only).
CREATE OR REPLACE FUNCTION set_tenant_context_for_system(p_organization_id uuid, p_user_id uuid)
RETURNS void AS $$
BEGIN
  PERFORM set_config('app.organization_id', coalesce(p_organization_id::text, ''), false);
  PERFORM set_config('app.user_id', coalesce(p_user_id::text, ''), false);
  PERFORM set_config('app.is_platform_admin', '0', false);
  PERFORM set_config('app.bypass_financial_triggers', '0', false);
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 18. Numbering sequences (invoice / payment / receipt / reversal per org).
--     We use a simple per-org monotonic counter table. Numbering is
--     "INV-YYYY-NNNNNN" where NNNNNN is zero-padded and reset per calendar year.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "doc_number_sequences" (
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "scope" text NOT NULL,  -- 'INV'|'PMT'|'RCP'|'REV'
  "year" integer NOT NULL,
  "last_value" bigint NOT NULL DEFAULT 0,
  PRIMARY KEY ("organization_id", "scope", "year")
);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "doc_number_sequences" TO scolaira_app;
ALTER TABLE "doc_number_sequences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "doc_number_sequences" FORCE ROW LEVEL SECURITY;
CREATE POLICY doc_numbers_tenant_isolation ON "doc_number_sequences" FOR ALL USING (
  "organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION next_doc_number(p_scope text)
RETURNS text AS $$
DECLARE
  v_org uuid;
  v_year integer;
  v_last bigint;
  v_prefix text;
BEGIN
  v_org := NULLIF(current_setting('app.organization_id', true), '')::uuid;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Cannot generate document number without tenant context';
  END IF;
  v_year := EXTRACT(YEAR FROM now())::integer;
  INSERT INTO "doc_number_sequences" ("organization_id", "scope", "year", "last_value")
    VALUES (v_org, p_scope, v_year, 1)
    ON CONFLICT ("organization_id", "scope", "year")
    DO UPDATE SET "last_value" = "doc_number_sequences"."last_value" + 1
    RETURNING "last_value" INTO v_last;

  v_prefix := CASE p_scope
    WHEN 'INV' THEN 'INV-'
    WHEN 'PMT' THEN 'PMT-'
    WHEN 'RCP' THEN 'RCP-'
    WHEN 'REV' THEN 'REV-'
    ELSE p_scope || '-'
  END;
  RETURN v_prefix || v_year::text || '-' || lpad(v_last::text, 6, '0');
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION next_doc_number(text) TO scolaira_app;
--> statement-breakpoint

-- Trigger: auto-assign invoice/payment/receipt/reversal number on insert if null.
-- We create one trigger per entity to avoid polymorphic dynamic-SQL complexity.

CREATE OR REPLACE FUNCTION trg_assign_invoice_number()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."invoice_number" IS NULL OR NEW."invoice_number" = '' THEN
    NEW."invoice_number" := next_doc_number('INV');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_assign_payment_number()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."payment_number" IS NULL OR NEW."payment_number" = '' THEN
    NEW."payment_number" := next_doc_number('PMT');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_assign_receipt_number()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."receipt_number" IS NULL OR NEW."receipt_number" = '' THEN
    NEW."receipt_number" := next_doc_number('RCP');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_assign_reversal_number()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."reversal_number" IS NULL OR NEW."reversal_number" = '' THEN
    NEW."reversal_number" := next_doc_number('REV');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public;
--> statement-breakpoint

CREATE OR REPLACE TRIGGER assign_doc_number_invoices BEFORE INSERT ON "invoices"
  FOR EACH ROW EXECUTE FUNCTION trg_assign_invoice_number();
CREATE OR REPLACE TRIGGER assign_doc_number_payments BEFORE INSERT ON "payments"
  FOR EACH ROW EXECUTE FUNCTION trg_assign_payment_number();
CREATE OR REPLACE TRIGGER assign_doc_number_receipts BEFORE INSERT ON "receipts"
  FOR EACH ROW EXECUTE FUNCTION trg_assign_receipt_number();
CREATE OR REPLACE TRIGGER assign_doc_number_reversals BEFORE INSERT ON "reversals"
  FOR EACH ROW EXECUTE FUNCTION trg_assign_reversal_number();
--> statement-breakpoint
