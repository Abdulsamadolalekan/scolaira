-- R1 (C-2) — organization-composite financial integrity boundaries.
--
-- BEFORE
--   Tenant-owned rows referenced each other through single-column foreign keys
--   on globally unique UUIDs, so referential integrity was satisfied by a
--   reference that crossed organizations:
--
--     invoice_lines.invoice_id       -> invoices.id       (no org predicate)
--     payment_allocations.payment_id -> payments.id       (no org predicate)
--     payment_allocations.invoice_id -> invoices.id       (no org predicate)
--     receipts.payment_id            -> payments.id       (no org predicate)
--     reversals.payment_id           -> payments.id       (no org predicate)
--     … every tenant-owned parent/child pair in the schema.
--
--   Nothing structurally prevented organization A's child row from pointing at
--   organization B's parent, and the financial triggers maintain balances by
--   looking parents up by id alone:
--
--     allocations_insert_trg   -> UPDATE payments SET unallocated_kobo = …
--     allocations_insert_trg   -> UPDATE invoices SET paid_kobo = …
--     reversals_insert_trg     -> UPDATE payments/invoices/payment_allocations …
--     invoice_lines_*_trg      -> UPDATE invoices SET total_kobo = …
--
--   RLS narrowed the blast radius for the runtime role, but RLS is a
--   *visibility* mechanism layered over a query; it is not the right place for
--   the ledger's ownership invariant to live, and it does not hold for every
--   principal (seed/bootstrap/platform paths, maintenance SQL, future roles).
--
-- AFTER
--   Every parent/child relationship between tenant-owned tables is enforced by
--   an organization-composite foreign key:
--
--     (child.organization_id, child.parent_id)
--         REFERENCES parent (organization_id, id)
--
--   The database rejects the cross-tenant reference itself, independently of
--   the application, of RLS, and of which principal is connected. Because a
--   child can only ever reference a parent in its own organization, the
--   financial triggers cannot be induced to mutate or recompute another
--   tenant's row either: the statement that would do so is rejected and rolled
--   back. The fix is therefore constraints-only — no financial trigger,
--   reconciliation rule, collections rule or ledger semantic is modified.
--
--   Constraints are validated on creation (`NOT VALID` is deliberately NOT
--   used): a pre-existing row that violates tenant ownership must fail the
--   migration loudly instead of being grandfathered.
--
-- DELETE ACTIONS
--   The added constraints use the default NO ACTION. Financial parents are
--   append-only (DELETE is revoked from the runtime role and refused by
--   block_financial_delete_*), and roster parents are archived by status rather
--   than deleted, so no legitimate cascade is blocked. NO ACTION checks run
--   after any cascade from the pre-existing single-column foreign keys, so the
--   existing `ON DELETE CASCADE` roster relationships keep working unchanged.
--
-- SECTION 4 is a self-audit: the migration FAILS if any tenant-owned
-- parent/child foreign key in the schema is left without an
-- organization-composite counterpart.

-- ---------------------------------------------------------------------------
-- 1. Parent-side uniqueness for composite references.
--    id is already the primary key, so (organization_id, id) is already
--    unique; this index is the artifact Postgres uses to enforce the
--    composite foreign keys below.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  parents text[] := ARRAY[
    'academic_sessions','terms','classes','students','guardians','fee_definitions',
    'fee_assignments','invoices','invoice_lines','payments','payment_allocations',
    'reversals','receipts','reminders','reconciliation_cases','collections_cases'
  ];
  p text;
BEGIN
  FOREACH p IN ARRAY parents LOOP
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (organization_id, id)',
      p || '_org_id_uidx', p
    );
  END LOOP;
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Organization-composite foreign keys.
--    The list is explicit (not inferred at runtime) so the invariant is
--    auditable by reading this file. Each entry is
--    (child table, child parent-reference column, parent table).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  rels text[][] := ARRAY[
    -- academic roster -------------------------------------------------------
    ARRAY['terms',                'session_id',          'academic_sessions'],
    ARRAY['student_guardians',    'student_id',          'students'],
    ARRAY['student_guardians',    'guardian_id',         'guardians'],
    ARRAY['class_enrollments',    'class_id',            'classes'],
    ARRAY['class_enrollments',    'student_id',          'students'],
    ARRAY['class_enrollments',    'term_id',             'terms'],
    ARRAY['fee_assignments',      'fee_definition_id',   'fee_definitions'],
    ARRAY['fee_assignments',      'class_id',            'classes'],
    ARRAY['fee_assignments',      'term_id',             'terms'],
    -- invoicing -------------------------------------------------------------
    ARRAY['invoices',             'student_id',          'students'],
    ARRAY['invoices',             'term_id',             'terms'],
    ARRAY['invoices',             'session_id',          'academic_sessions'],
    ARRAY['invoice_lines',        'invoice_id',          'invoices'],
    ARRAY['invoice_lines',        'billing_student_id',  'students'],
    ARRAY['invoice_lines',        'billing_term_id',     'terms'],
    ARRAY['invoice_lines',        'fee_assignment_id',   'fee_assignments'],
    ARRAY['waivers',              'invoice_line_id',     'invoice_lines'],
    -- payments and their downstream financial records ----------------------
    ARRAY['payment_allocations',  'payment_id',          'payments'],
    ARRAY['payment_allocations',  'invoice_id',          'invoices'],
    ARRAY['payment_allocations',  'reversal_id',         'reversals'],
    ARRAY['reversals',            'payment_id',          'payments'],
    ARRAY['receipts',             'payment_id',          'payments'],
    ARRAY['receipts',             'allocation_id',       'payment_allocations'],
    ARRAY['receipts',             'student_id',          'students'],
    -- public collection surfaces -------------------------------------------
    ARRAY['payment_links',        'invoice_id',          'invoices'],
    ARRAY['payment_links',        'student_id',          'students'],
    ARRAY['reminders',            'invoice_id',          'invoices'],
    ARRAY['reminders',            'student_id',          'students'],
    ARRAY['reminders',            'guardian_id',         'guardians'],
    -- M10 reconciliation control plane -------------------------------------
    ARRAY['reconciliation_cases',       'payment_id',    'payments'],
    ARRAY['reconciliation_evidence',    'case_id',       'reconciliation_cases'],
    ARRAY['reconciliation_candidates',  'case_id',       'reconciliation_cases'],
    ARRAY['reconciliation_candidates',  'invoice_id',    'invoices'],
    ARRAY['reconciliation_candidates',  'student_id',    'students'],
    -- M11 collections control plane ----------------------------------------
    ARRAY['collections_cases',          'student_id',    'students'],
    ARRAY['collections_case_events',    'case_id',       'collections_cases'],
    ARRAY['collections_case_events',    'reminder_id',   'reminders']
  ];
  r text[];
  cname text;
  n int := 0;
BEGIN
  FOREACH r SLICE 1 IN ARRAY rels LOOP
    cname := format('%s__%s__org_fkey', r[1], r[2]);
    IF EXISTS (
      SELECT 1 FROM pg_constraint c
       WHERE c.conname = cname AND c.conrelid = r[1]::regclass
    ) THEN
      CONTINUE;
    END IF;
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (organization_id, %I) REFERENCES %I (organization_id, id)',
      r[1], cname, r[2], r[3]
    );
    n := n + 1;
  END LOOP;
  RAISE NOTICE '[R1 C-2] organization-composite foreign keys added: %', n;
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Self-audit: every FK whose child AND parent are both tenant-owned must
--    have an organization-composite counterpart. This makes the invariant
--    exhaustive and permanent: a future migration that adds a tenant-owned
--    relationship cannot forget it without failing here.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(DISTINCT format('%s(%s) -> %s', ch, cols, par), ', ')
    INTO bad
    FROM (
      SELECT c.conrelid::regclass::text AS ch,
             c.confrelid::regclass::text AS par,
             (SELECT string_agg(a.attname, ',' ORDER BY a.attname)
                FROM unnest(c.conkey) k(attnum)
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols
        FROM pg_constraint c
        JOIN pg_class cl ON cl.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace
       WHERE c.contype = 'f'
         AND n.nspname = 'public'
         -- tenant-owned on both sides
         AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.conrelid  AND a.attname = 'organization_id' AND a.attnum > 0 AND NOT a.attisdropped)
         AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.confrelid AND a.attname = 'organization_id' AND a.attnum > 0 AND NOT a.attisdropped)
         -- not already an organization-composite constraint itself
         AND NOT (
           (SELECT array_agg(a.attname::text ORDER BY a.attname)
              FROM unnest(c.confkey) k(attnum)
              JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum)
           = ARRAY['id','organization_id']
         )
         -- and without an organization-composite counterpart: same child and
         -- parent table, referencing (organization_id, id), and covering
         -- organization_id plus exactly this relationship's columns.
         AND NOT EXISTS (
           SELECT 1 FROM pg_constraint c2
            WHERE c2.contype = 'f'
              AND c2.conrelid = c.conrelid
              AND c2.confrelid = c.confrelid
              AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
                     FROM unnest(c2.confkey) k(attnum)
                     JOIN pg_attribute a ON a.attrelid = c2.confrelid AND a.attnum = k.attnum)
                  = ARRAY['id','organization_id']
              AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
                     FROM unnest(c2.conkey) k(attnum)
                     JOIN pg_attribute a ON a.attrelid = c2.conrelid AND a.attnum = k.attnum)
                  = (SELECT array_agg(DISTINCT x ORDER BY x) FROM (
                       SELECT 'organization_id'::text AS x
                       UNION
                       SELECT a.attname::text
                         FROM unnest(c.conkey) k(attnum)
                         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                     ) q)
         )
    ) missing;

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '[R1 C-2] tenant-owned foreign keys without organization-composite enforcement: %', bad
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Runtime-visible assertion helper for the R1 test-suite (read-only).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_org_composite_fk_count()
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT count(*)::int
    FROM pg_constraint c
   WHERE c.contype = 'f'
     AND c.connamespace = 'public'::regnamespace
     AND c.conname LIKE '%__org_fkey'
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_org_composite_fk_count() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_org_composite_fk_count() TO scolaira_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Existing financial triggers are NOT modified.
--
--    The composite foreign keys above make a cross-tenant parent structurally
--    unreachable, which is exactly the property the trigger parent lookups
--    depend on: allocations_insert_trg, reversals_insert_trg and the
--    invoice_lines triggers resolve their parents by id, and after this
--    migration every such id is necessarily owned by the row's own
--    organization. A forged cross-tenant reference is rejected at the
--    constraint, the offending statement is rolled back, and no balance,
--    status or ledger row of the foreign tenant is touched.
--
--    That is demonstrated (not asserted) in tests/db/r1-composite-fk.test.ts.
--    Preserving the triggers as-is is deliberate: R1 tightens boundaries, it
--    does not reinterpret the ledger.
-- ---------------------------------------------------------------------------
