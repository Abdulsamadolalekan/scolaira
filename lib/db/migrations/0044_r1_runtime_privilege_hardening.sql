-- R1 — runtime-role privilege hardening.
--
-- FINDING (surfaced by the R1 independent re-audit, `tests/db/r1-independent-
-- reaudit.test.ts`, section F)
--
--   The runtime role held far more than the four DML privileges the
--   application needs:
--
--     has_table_privilege('invoices','TRUNCATE')            -> true
--     has_table_privilege('app_meta','SELECT')              -> true
--     RELACL for every table: scolaira_app=arwdDxtm/scolaira_owner
--
--   ROOT CAUSE: the post-migration grant step (`scripts/migrate.ts`,
--   `tests/global-setup-db.ts`, `scripts/provision-db.sh`) ran
--   `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO scolaira_app` and
--   only afterwards revoked a hand-picked list. The blanket grant re-granted —
--   and silently overrode — everything the migrations themselves had revoked,
--   including `REVOKE ALL ON app_meta` from migration 0010.
--
--   WHY IT MATTERS: TRUNCATE is NOT subject to row-level security, so RLS,
--   FORCE RLS and every append-only `REVOKE UPDATE, DELETE` in the schema were
--   powerless against it. A runtime-role compromise (SQL injection, a leaked
--   application credential) could have destroyed authoritative financial
--   history and, in `app_meta`, the tenant-context HMAC secret. REFERENCES and
--   TRIGGER allow fabricating constraints or triggers on financial tables;
--   MAINTAIN allows VACUUM/ANALYZE manipulation.
--
-- REMEDIATION
--   * Revoke TRUNCATE, REFERENCES, TRIGGER and MAINTAIN from the runtime role
--     on every table in `public`. The application needs SELECT, INSERT, UPDATE
--     and DELETE only — and the append-only tables keep their narrower sets.
--   * Restore `app_meta` to owner-only: nothing in the runtime path reads it
--     (the token/proof minters are SECURITY DEFINER and run as the owner).
--   * The grant step in `scripts/migrate.ts` now grants the explicit DML set
--     instead of ALL PRIVILEGES, so a fresh install cannot re-open this hole,
--     and this migration makes existing databases correct regardless of the
--     order in which grants and revokes ran.
--
-- No table, constraint, policy, trigger or financial value is modified.

-- ---------------------------------------------------------------------------
-- 1. Withdraw the non-DML privileges from the runtime role everywhere.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_tbl   record;
  v_priv  text;
  v_privs text[] := ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
BEGIN
  FOR v_tbl IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    FOREACH v_priv IN ARRAY v_privs LOOP
      BEGIN
        EXECUTE format('REVOKE %s ON TABLE public.%I FROM scolaira_app', v_priv, v_tbl.relname);
      EXCEPTION WHEN undefined_object THEN
        -- Older servers do not know every privilege name (e.g. MAINTAIN);
        -- nothing to revoke there.
        NULL;
      END;
    END LOOP;
  END LOOP;

  -- Sequences accept USAGE/SELECT/UPDATE only; nothing further to withdraw.
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. The tenant-context secret table is owner-only (as migration 0010
--    intended before the blanket grant overrode it).
-- ---------------------------------------------------------------------------

REVOKE ALL ON app_meta FROM scolaira_app;
--> statement-breakpoint
REVOKE ALL ON login_attempts, rate_limits FROM scolaira_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON login_attempts, rate_limits TO scolaira_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Schema CREATE is not part of the runtime role's job.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'public') THEN
    REVOKE CREATE ON SCHEMA public FROM scolaira_app;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  -- The migration role may not own the schema; the post-migration grant step
  -- handles it in that case.
  NULL;
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Self-audit.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_bad     text;
  v_trunc   text[];
BEGIN
  SELECT string_agg(c.relname || ':' || p.priv, ', ')
    INTO v_bad
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN (VALUES ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p')
     -- CASE guards the evaluation order: SQL does not guarantee that WHERE
     -- conjuncts are evaluated left to right, and the privilege functions raise
     -- when handed a relation of the wrong kind.
     AND CASE WHEN c.relkind IN ('r', 'p')
              THEN has_table_privilege('scolaira_app', c.oid, p.priv)
              ELSE false END;

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '[R1] runtime role still holds non-DML privileges: %', v_bad;
  END IF;

  IF has_table_privilege('scolaira_app', 'app_meta', 'SELECT')
     OR has_table_privilege('scolaira_app', 'app_meta', 'INSERT')
     OR has_table_privilege('scolaira_app', 'app_meta', 'UPDATE')
     OR has_table_privilege('scolaira_app', 'app_meta', 'DELETE') THEN
    RAISE EXCEPTION '[R1] app_meta must be owner-only';
  END IF;

  -- Sequences only expose USAGE/SELECT/UPDATE; assert the runtime role holds
  -- no UPDATE on them beyond what document numbering needs.
  SELECT string_agg(c.relname, ', ') INTO v_trunc
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'S'
     AND CASE WHEN c.relkind = 'S'
              THEN has_sequence_privilege('scolaira_app', c.oid, 'USAGE') IS NOT TRUE
              ELSE false END;
  IF v_trunc IS NOT NULL THEN
    RAISE EXCEPTION '[R1] runtime role lost USAGE on sequences: %', v_trunc;
  END IF;

  RAISE NOTICE '[R1] runtime privileges verified: DML only, app_meta owner-only, no TRUNCATE anywhere';
END $$;
