-- R2 — exceptional-path financial integrity.
--
-- FINDINGS (verified against the running database before this migration)
--
--   H-7.1  A retry of a *correction* is not guarded by the database. The
--          reversal route implements idempotency as SELECT-then-INSERT on
--          (payment_id, reference), and the only unique index on `reversals`
--          was (organization_id, reversal_number). Measured with two
--          connections following that exact sequence:
--
--            connection A saw 0 existing reversals before insert
--            connection B (same reference, concurrent): inserted (saw 0)
--            reversals with the SAME reference for one payment: 2
--            invoice after the duplicate reversals: paid_kobo=0 status=ISSUED
--
--          i.e. two individually-valid half reversals of the same logical
--          correction produced an unintended FULL reversal of a 1,000,000 kobo
--          payment. The amount guard in trg_reversals_insert bounds each row,
--          but it cannot see a duplicate that is deliberately shaped to be
--          individually legal.
--
--   H-7.2 (partially DISPROVEN, and narrowed here)  A unique guard on payment
--          references does exist — `payments_org_reference_unique_idx` from
--          migration 0001 — but its predicate is
--              reference IS NOT NULL AND method IN ('BANK_TRANSFER','POS','ONLINE')
--          so it (a) omits method 'OTHER', which the application guard covers
--          only with a racy SELECT-then-throw, and (b) has no status predicate,
--          so a payment recorded as FAILED/REJECTED permanently blocks a
--          legitimate retry of the same teller reference at the database level
--          even though the application deliberately allows it — the retry dies
--          with a raw 23505 instead of a mapped conflict. Measured:
--            OTHER payments sharing one reference (no DB guard): 2
--
-- REMEDIATION
--   1. `reversals` gets UNIQUE (payment_id, reference) WHERE reference IS NOT
--      NULL — the same guarantee the route already claimed in its header
--      comment, now enforced by the database and therefore safe under
--      concurrency.
--   2. The payments reference guard is replaced by the invariant the
--      application actually intends: at most one *live* payment per
--      (organization, reference) for every non-CASH method. FAILED/REJECTED
--      attempts no longer block a retry, and 'OTHER' is covered by the
--      database rather than by a race-prone application check.
--   3. `receipts.allocations_snapshot` records, at issue time, the allocation
--      set that the receipted amount was computed from, with write-once
--      semantics enforced by trigger. Before this, a receipt's frozen
--      `amount_kobo` was rendered against *current* ACTIVE allocations, so any
--      post-issuance reversal silently stopped the printed lines from summing
--      to the receipted amount — a parent-facing document contradicting the
--      ledger.
--
-- FAIL-CLOSED PRE-CHECKS
--   Both unique indexes validate existing rows. If a database already contains
--   a conflicting pair (only possible through the race this migration closes),
--   the migration aborts with a diagnostic naming the rows instead of silently
--   choosing a winner. The operator resolves the duplicate (reverse it or flag
--   it through the reconciliation control plane) and re-runs the migration.
--
--   READING NOTE — why the pre-check toggles FORCE ROW LEVEL SECURITY:
--   `reversals` and `payments` are FORCE-RLS tables, and this migration runs as
--   the owning role, so it cannot simply SELECT across tenants to look for
--   duplicates (verified: `row_security = off` is refused with "query would be
--   affected by row-level security policy"). The check therefore lifts FORCE for
--   the duration of the transaction only. This is safe and observable:
--     * DDL is transactional in PostgreSQL, so no other session ever sees the
--       table without FORCE, and the setting is restored before the migration
--       commits;
--     * FORCE only affects the *owner*, which is not the role the application
--       connects as, so the runtime boundary is untouched either way;
--     * the self-audit at the end of this migration fails the migration if
--       `relforcerowsecurity` is not true for either table afterwards.
-- ---------------------------------------------------------------------------
-- 1. Fail-closed pre-checks.
-- ---------------------------------------------------------------------------

ALTER TABLE reversals NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE payments NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

DO $$
DECLARE
  v_dupes  integer;
  v_detail text;
BEGIN
  SELECT count(*) INTO v_dupes
    FROM (
      SELECT payment_id, reference
        FROM reversals
       WHERE reference IS NOT NULL
       GROUP BY payment_id, reference
      HAVING count(*) > 1
    ) d;
  IF v_dupes > 0 THEN
    SELECT string_agg(format('payment %s reference %L (%s rows)', payment_id, reference, n), '; ')
      INTO v_detail
      FROM (
        SELECT payment_id, reference, count(*) AS n
          FROM reversals
         WHERE reference IS NOT NULL
         GROUP BY payment_id, reference
        HAVING count(*) > 1
        LIMIT 5
      ) x;
    RAISE EXCEPTION
      '[R2] % reversal reference(s) are duplicated for one payment and must be resolved before the uniqueness guarantee can be installed: %',
      v_dupes, v_detail;
  END IF;

  SELECT count(*) INTO v_dupes
    FROM (
      SELECT organization_id, reference
        FROM payments
       WHERE reference IS NOT NULL
         AND method <> 'CASH'
         AND status NOT IN ('FAILED', 'REJECTED')
       GROUP BY organization_id, reference
      HAVING count(*) > 1
    ) d;
  IF v_dupes > 0 THEN
    SELECT string_agg(format('organization %s reference %L (%s rows)', organization_id, reference, n), '; ')
      INTO v_detail
      FROM (
        SELECT organization_id, reference, count(*) AS n
          FROM payments
         WHERE reference IS NOT NULL
           AND method <> 'CASH'
           AND status NOT IN ('FAILED', 'REJECTED')
         GROUP BY organization_id, reference
        HAVING count(*) > 1
        LIMIT 5
      ) x;
    RAISE EXCEPTION
      '[R2] % live payment reference(s) are duplicated within one organization and must be resolved before the uniqueness guarantee can be installed: %',
      v_dupes, v_detail;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE reversals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Reversal idempotency guaranteed by the database.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX reversals_payment_reference_unique_idx
  ON reversals (payment_id, reference)
  WHERE reference IS NOT NULL;
--> statement-breakpoint
COMMENT ON INDEX reversals_payment_reference_unique_idx IS
  'R2/H-7: a reversal reference identifies one logical correction per payment; a concurrent retry can no longer double-reverse.';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. One live payment per (organization, reference) for every non-CASH method.
--    Replaces the 0001 guard, whose predicate missed method OTHER and whose
--    lack of a status predicate made a FAILED attempt permanently block a
--    legitimate retry.
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS payments_org_reference_unique_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX payments_org_reference_live_unique_idx
  ON payments (organization_id, reference)
  WHERE reference IS NOT NULL
    AND method <> 'CASH'
    AND status NOT IN ('FAILED', 'REJECTED');
--> statement-breakpoint
COMMENT ON INDEX payments_org_reference_live_unique_idx IS
  'R2/H-7: at most one live (non-FAILED/REJECTED) payment per organization and teller reference, for every non-CASH method.';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Receipt allocation snapshot (append-only, write-once).
-- ---------------------------------------------------------------------------

ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS allocations_snapshot jsonb;
--> statement-breakpoint
ALTER TABLE receipts
  ADD CONSTRAINT receipts_allocations_snapshot_is_array
  CHECK (allocations_snapshot IS NULL OR jsonb_typeof(allocations_snapshot) = 'array');
--> statement-breakpoint
COMMENT ON COLUMN receipts.allocations_snapshot IS
  'R2/H-7: the allocation set the receipted amount was computed from, captured inside the issuance transaction. Written once; immutable thereafter.';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION trg_receipts_snapshot_immutable()
RETURNS TRIGGER AS $$
BEGIN
  -- The snapshot is a record of what was receipted. It may be set once (legacy
  -- rows keep NULL) and may never change afterwards, so a later reversal or
  -- re-allocation cannot rewrite history.
  IF OLD."allocations_snapshot" IS NOT NULL
     AND NEW."allocations_snapshot" IS DISTINCT FROM OLD."allocations_snapshot" THEN
    RAISE EXCEPTION 'receipt allocation snapshot is immutable (receipt_id=%)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE TRIGGER receipts_snapshot_immutable_trg
BEFORE UPDATE ON "receipts"
FOR EACH ROW EXECUTE FUNCTION trg_receipts_snapshot_immutable();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Self-audit: the migration fails if it did not achieve its purpose.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_idx        text;
  v_rev_uniq   text;
  v_pay_uniq   boolean;
  v_pay_old    boolean;
  v_snapshot   boolean;
  v_trigger    boolean;
BEGIN
  SELECT indexdef INTO v_rev_uniq
    FROM pg_indexes
   WHERE tablename = 'reversals' AND indexname = 'reversals_payment_reference_unique_idx';
  IF v_rev_uniq IS NULL OR position('UNIQUE' in v_rev_uniq) = 0 THEN
    RAISE EXCEPTION '[R2] reversals (payment_id, reference) uniqueness is not in place';
  END IF;

  SELECT bool_or(indexname = 'payments_org_reference_live_unique_idx')
    INTO v_pay_uniq FROM pg_indexes WHERE tablename = 'payments';
  SELECT bool_or(indexname = 'payments_org_reference_unique_idx')
    INTO v_pay_old FROM pg_indexes WHERE tablename = 'payments';
  IF v_pay_uniq IS NOT TRUE THEN
    RAISE EXCEPTION '[R2] the live-payment reference guard is not in place';
  END IF;
  IF v_pay_old IS TRUE THEN
    RAISE EXCEPTION '[R2] the superseded payments reference guard is still in place';
  END IF;
  SELECT indexdef INTO v_idx FROM pg_indexes
   WHERE tablename = 'payments' AND indexname = 'payments_org_reference_live_unique_idx';
  IF position('CASH' in coalesce(v_idx, '')) = 0 OR position('<>' in coalesce(v_idx, '')) = 0 THEN
    RAISE EXCEPTION '[R2] the live-payment guard does not cover every non-CASH method: %', v_idx;
  END IF;
  IF position('FAILED' in coalesce(v_idx, '')) = 0 THEN
    RAISE EXCEPTION '[R2] the live-payment guard does not exclude superseded attempts: %', v_idx;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'receipts' AND column_name = 'allocations_snapshot'
  ) INTO v_snapshot;
  IF NOT v_snapshot THEN
    RAISE EXCEPTION '[R2] receipts.allocations_snapshot was not added';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'receipts'::regclass AND tgname = 'receipts_snapshot_immutable_trg'
  ) INTO v_trigger;
  IF NOT v_trigger THEN
    RAISE EXCEPTION '[R2] the receipt snapshot immutability trigger is missing';
  END IF;

  -- FORCE RLS must be exactly where it was: the pre-check lifted it
  -- transactionally and this assertion is what makes that safe to rely on.
  IF NOT (SELECT bool_and(relforcerowsecurity) FROM pg_class
           WHERE oid IN ('reversals'::regclass, 'payments'::regclass)) THEN
    RAISE EXCEPTION '[R2] FORCE ROW LEVEL SECURITY was not restored by the pre-check';
  END IF;

  RAISE NOTICE '[R2] reversal idempotency, live-payment reference guard and receipt snapshot are installed.';
END $$;
