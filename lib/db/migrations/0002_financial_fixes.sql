-- MIGRATION 0002: Financial guard tightenings discovered by M2 attack tests.
--
--   (a) Allow PAID->ISSUED and PAID->PARTIALLY_PAID transitions: after a full
--       or partial reversal, an invoice legitimately drops back from PAID.
--
--   (b) Make financial triggers update paid_kobo AND status in ONE statement
--       per invoice row, so we never see an intermediate row whose status is
--       inconsistent with paid_kobo.
--
--   (c) BEFORE UPDATE trigger on invoices rejects direct status regressions
--       that are not backed by a corresponding paid_kobo change (i.e. attacks
--       that try to fake ISSUED when money is still owed, or PAID when money
--       is still outstanding). Trusted triggers (pg_trigger_depth() > 1) are
--       allowed through because they always write a consistent final state
--       via the single-statement updates above.
--
--   (d) payment_allocations append-only trigger: blocks direct UPDATE/DELETE
--       from clients (pg_trigger_depth() <= 1). The reversal trigger is the
--       only legitimate mutator.
--
--   (e) Defense-in-depth: REVOKE UPDATE on payment_allocations from the app
--       role (inserts only; status flips come from triggers owned by the
--       migration role).

-- -----------------------------------------------------------------------------
-- (a) can_transition whitelist — add PAID -> ISSUED / PAID -> PARTIALLY_PAID.
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
        'PAID->PARTIALLY_PAID','PAID->ISSUED','PAID->VOID',
        'VOID->DRAFT'
      ];
    WHEN 'payments' THEN
      allowed := ARRAY[
        'PENDING->CONFIRMED','PENDING->FAILED','PENDING->REJECTED','PENDING->DUPLICATE_SUSPECT',
        'CONFIRMED->REVERSED','CONFIRMED->REFUNDED','CONFIRMED->DUPLICATE_SUSPECT',
        'DUPLICATE_SUSPECT->CONFIRMED','DUPLICATE_SUSPECT->REVERSED','DUPLICATE_SUSPECT->REFUNDED',
        'FAILED->CONFIRMED'
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
      RETURN true;
  END CASE;
  RETURN (old_status||'->'||new_status) = ANY(allowed);
END;
$$ LANGUAGE plpgsql STABLE;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- (b) trg_allocations_insert — single-statement paid_kobo + status update.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_allocations_insert()
RETURNS TRIGGER AS $$
DECLARE
  v_pay_unalloc BIGINT;
  v_invoice_outstanding BIGINT;
  v_invoice_status invoice_status;
BEGIN
  PERFORM 1 FROM "payments" WHERE "id" = NEW."payment_id" FOR UPDATE;
  PERFORM 1 FROM "invoices"  WHERE "id" = NEW."invoice_id"  FOR UPDATE;

  SELECT "unallocated_kobo" INTO v_pay_unalloc
    FROM "payments" WHERE "id" = NEW."payment_id";
  SELECT invoice_outstanding_kobo(NEW."invoice_id") INTO v_invoice_outstanding;
  SELECT "status" INTO v_invoice_status FROM "invoices" WHERE "id" = NEW."invoice_id";

  IF v_invoice_status = 'VOID' THEN
    RAISE EXCEPTION 'Cannot allocate against a void invoice (invoice_id=%)', NEW."invoice_id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."amount_kobo" > v_pay_unalloc THEN
    RAISE EXCEPTION 'Allocation amount (% kobo) exceeds payment unallocated (% kobo)',
      NEW."amount_kobo", v_pay_unalloc USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."amount_kobo" > v_invoice_outstanding THEN
    RAISE EXCEPTION 'Allocation amount (% kobo) exceeds invoice outstanding (% kobo)',
      NEW."amount_kobo", v_invoice_outstanding USING ERRCODE = 'check_violation';
  END IF;

  UPDATE "payments"
     SET "unallocated_kobo" = "unallocated_kobo" - NEW."amount_kobo"
   WHERE "id" = NEW."payment_id";

  -- Single UPDATE: paid_kobo + status atomically.
  UPDATE "invoices"
     SET "paid_kobo" = "paid_kobo" + NEW."amount_kobo",
         "status" = CASE
           WHEN "status" IN ('DRAFT','VOID') THEN "status"
           WHEN ("paid_kobo" + NEW."amount_kobo") = 0             THEN 'ISSUED'::invoice_status
           WHEN ("paid_kobo" + NEW."amount_kobo") >= "total_kobo" THEN 'PAID'::invoice_status
           ELSE 'PARTIALLY_PAID'::invoice_status
         END
   WHERE "id" = NEW."invoice_id";

  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- (b cont.) trg_reversals_insert — single-statement paid_kobo + status update.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_reversals_insert()
RETURNS TRIGGER AS $$
DECLARE
  v_payment payments%ROWTYPE;
  v_remaining kobo_value := NEW."amount_kobo";
  v_alloc RECORD;
  v_alloc_amt BIGINT;
  v_any_active_alloc BOOLEAN;
BEGIN
  IF NEW."payment_id" IS NULL THEN
    RAISE EXCEPTION 'Reversals in M2 must reference a payment.';
  END IF;

  SELECT * INTO v_payment FROM "payments" WHERE "id" = NEW."payment_id" FOR UPDATE;

  DECLARE
    already_reversed BIGINT;
  BEGIN
    SELECT COALESCE(SUM("amount_kobo"), 0) INTO already_reversed
      FROM "reversals"
     WHERE "payment_id" = NEW."payment_id" AND "id" <> NEW."id";
    IF NEW."amount_kobo" > (v_payment."amount_kobo" - already_reversed) THEN
      RAISE EXCEPTION 'Reversal amount (% kobo) exceeds remaining reversible amount on payment (% kobo)',
        NEW."amount_kobo", (v_payment."amount_kobo" - already_reversed)
        USING ERRCODE = 'check_violation';
    END IF;
  END;

  FOR v_alloc IN
    SELECT pa.* FROM "payment_allocations" pa
     WHERE pa."payment_id" = NEW."payment_id" AND pa."status" = 'ACTIVE'
     ORDER BY pa."allocated_at" ASC, pa."id" ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_alloc_amt := LEAST(v_alloc."amount_kobo", v_remaining);

    IF v_alloc_amt <> v_alloc."amount_kobo" THEN
      RAISE EXCEPTION 'Partial allocation reversal not supported in M2; reverse entire allocations.';
    END IF;

    UPDATE "payment_allocations"
       SET "status" = 'REVERSED', "reversal_id" = NEW."id"
     WHERE "id" = v_alloc."id";

    -- Single atomic UPDATE per allocation reversed:
    UPDATE "invoices"
       SET "paid_kobo" = "paid_kobo" - v_alloc_amt,
           "status" = CASE
             WHEN ("paid_kobo" - v_alloc_amt) = 0             THEN 'ISSUED'::invoice_status
             WHEN ("paid_kobo" - v_alloc_amt) >= "total_kobo" THEN 'PAID'::invoice_status
             ELSE 'PARTIALLY_PAID'::invoice_status
           END
     WHERE "id" = v_alloc."invoice_id";

    IF NEW."type" IN ('REVERSAL','CORRECTION') THEN
      UPDATE "payments"
         SET "unallocated_kobo" = "unallocated_kobo" + v_alloc_amt
       WHERE "id" = NEW."payment_id";
    END IF;

    v_remaining := v_remaining - v_alloc_amt;
  END LOOP;

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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- (c) trg_validate_invoice_status_balance — blocks fake status regressions.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_validate_invoice_status_balance()
RETURNS TRIGGER AS $$
BEGIN
  -- Trusted internal triggers (pg_trigger_depth() > 1) always write a
  -- consistent final state via the single-statement UPDATEs above.
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'ISSUED' AND COALESCE(NEW.paid_kobo, 0) <> 0 THEN
    RAISE EXCEPTION 'Invalid invoice state: ISSUED requires paid_kobo = 0 (got %)', NEW.paid_kobo
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'PAID' AND COALESCE(NEW.paid_kobo, 0) < COALESCE(NEW.total_kobo, 0) THEN
    RAISE EXCEPTION 'Invalid invoice state: PAID requires paid_kobo >= total_kobo (paid=%, total=%)',
      NEW.paid_kobo, NEW.total_kobo USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'PARTIALLY_PAID'
     AND (COALESCE(NEW.paid_kobo, 0) <= 0 OR COALESCE(NEW.paid_kobo, 0) >= COALESCE(NEW.total_kobo, 0)) THEN
    RAISE EXCEPTION 'Invalid invoice state: PARTIALLY_PAID requires 0 < paid_kobo < total_kobo (paid=%, total=%)',
      NEW.paid_kobo, NEW.total_kobo USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'DRAFT' AND COALESCE(NEW.paid_kobo, 0) <> 0 THEN
    RAISE EXCEPTION 'Invalid invoice state: DRAFT cannot have paid_kobo > 0'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE;
--> statement-breakpoint

DROP TRIGGER IF EXISTS validate_invoice_status_balance ON "invoices";
CREATE TRIGGER validate_invoice_status_balance
BEFORE UPDATE ON "invoices"
FOR EACH ROW EXECUTE FUNCTION trg_validate_invoice_status_balance();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- (d) payment_allocations append-only guard.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_guard_allocation_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'payment_allocations are append-only: amount/status changes must flow through reversals; direct UPDATE/DELETE forbidden.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE;
--> statement-breakpoint

DROP TRIGGER IF EXISTS guard_allocation_mutation_upd ON "payment_allocations";
CREATE TRIGGER guard_allocation_mutation_upd
BEFORE UPDATE ON "payment_allocations"
FOR EACH ROW EXECUTE FUNCTION trg_guard_allocation_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS guard_allocation_mutation_del ON "payment_allocations";
CREATE TRIGGER guard_allocation_mutation_del
BEFORE DELETE ON "payment_allocations"
FOR EACH ROW EXECUTE FUNCTION trg_guard_allocation_mutation();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- (f) set_tenant_context_for_system(NULL,NULL) must set is_platform_admin so
--     seeding in system context works even when org_id is NULL.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_tenant_context_for_system(p_organization_id uuid, p_user_id uuid)
RETURNS void AS $$
BEGIN
  PERFORM set_config('app.organization_id', coalesce(p_organization_id::text, ''), false);
  PERFORM set_config('app.user_id', coalesce(p_user_id::text, ''), false);
  PERFORM set_config('app.is_platform_admin', CASE WHEN p_organization_id IS NULL THEN '1' ELSE '0' END, false);
  PERFORM set_config('app.bypass_financial_triggers', '0', false);
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- (g) Harden trg_set_org_from_context to ALWAYS overwrite NEW.organization_id
--     from the tenant GUC. Otherwise a client issuing INSERT with an explicit
--     forged organization_id could land a row in another org if the role has
--     BYPASSRLS or is superuser.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_set_org_from_context()
RETURNS TRIGGER AS $$
DECLARE
  v_ctx_org uuid;
  v_is_system boolean;
BEGIN
  v_ctx_org := NULLIF(current_setting('app.organization_id', true), '')::uuid;
  v_is_system := coalesce(nullif(current_setting('app.is_platform_admin', true), ''), '0') IN ('1','true','t','yes');

  IF v_ctx_org IS NULL THEN
    IF v_is_system AND NEW."organization_id" IS NOT NULL THEN
      -- System context with explicit org: accept it (seeds/migrations).
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Cannot insert into % without organization_id and no tenant context set', TG_TABLE_NAME
      USING ERRCODE = 'not_null_violation';
  END IF;
  -- Always overwrite with the session tenant when one is set; a forged
  -- organization_id in the INSERT is silently corrected to the caller's
  -- own org (RLS WITH CHECK would also reject, but this produces
  -- correct-by-construction rows).
  NEW."organization_id" := v_ctx_org;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE
    SET search_path = pg_catalog, public;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- (e) Column-level REVOKE belt-and-suspenders.
-- -----------------------------------------------------------------------------
REVOKE UPDATE ON "payment_allocations" FROM scolaira_app;
GRANT INSERT, SELECT ON "payment_allocations" TO scolaira_app;
--> statement-breakpoint
