-- scripts/bootstrap-roles.sql
--
-- ONE-TIME PROVISIONING — run as a SUPERUSER (postgres) before migrations.
-- This creates the separate runtime vs migration/owner principals so that
-- the application NEVER connects as a role that can bypass RLS.
--
--   scolaira_owner — NOSUPERUSER, CREATEDB, CREATEROLE; owns schemas and
--                    tables; used by migrations and bootstrap.
--   scolaira_app   — NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE;
--                    the runtime application principal. RLS is enforced.
--   scolaira       — convenience LOGIN role used in dev; may SET ROLE to
--                    scolaira_app. (In production the app connects directly
--                    as scolaira_app.)
--
-- Usage (two steps, both idempotent):
--
--   # 1. roles + databases
--   sudo -u postgres psql -f scripts/bootstrap-roles.sql
--
--   # 2. per-database grants, once per database
--   sudo -u postgres psql -d scolaira      -v boot_db=1 -f scripts/bootstrap-roles.sql
--   sudo -u postgres psql -d scolaira_test -v boot_db=1 -f scripts/bootstrap-roles.sql
--
-- Or use scripts/provision-db.sh, which performs both steps for the local
-- databases.
--
-- H-6 note: this file used to wrap `CREATE DATABASE` in a `DO` block, which
-- Postgres always rejects ("CREATE DATABASE cannot be executed from a
-- function"), and the per-database branch ended in `\warning`, which is not a
-- psql command. The documented invocation therefore exited 2 and provisioned
-- nothing. Database creation now uses psql's `\gexec` (a meta-command, not a
-- transaction) and the skip branch uses `\echo`. Both paths are exercised by
-- the deployment runbook in docs/DEPLOYMENT.md.
--
-- Safe to re-run; uses IF NOT EXISTS / do-nothing grants.

-- Create roles.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scolaira_owner') THEN
    CREATE ROLE scolaira_owner NOBYPASSRLS NOSUPERUSER CREATEDB CREATEROLE
      LOGIN PASSWORD 'scolaira_owner_pw';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scolaira_app') THEN
    CREATE ROLE scolaira_app NOINHERIT LOGIN NOBYPASSRLS NOSUPERUSER
      NOCREATEDB NOCREATEROLE PASSWORD 'scolaira_app_pw';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scolaira') THEN
    CREATE ROLE scolaira NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE
      LOGIN PASSWORD 'scolaira';
  END IF;
END $$;

-- The dev login role can SET ROLE to the runtime role.
GRANT scolaira_app TO scolaira;
-- The owner role can administer the app role (to grant/revoke as schemas evolve).
GRANT scolaira_app TO scolaira_owner WITH ADMIN OPTION;

-- Create the databases if they are missing, or hand ownership to the owner role
-- if they already exist. `\gexec` runs each generated statement outside any
-- transaction, which is what CREATE DATABASE requires.
SELECT format('CREATE DATABASE %I OWNER scolaira_owner', d)
  FROM (VALUES ('scolaira'), ('scolaira_test')) AS t(d)
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = d)
\gexec

SELECT format('ALTER DATABASE %I OWNER TO scolaira_owner', d)
  FROM (VALUES ('scolaira'), ('scolaira_test')) AS t(d)
 WHERE EXISTS (SELECT 1 FROM pg_database WHERE datname = d)
\gexec

-- Per-database grants. These commands must run while connected to the database
-- they apply to, so they are skipped unless -v boot_db=1 is passed.
\if :{?boot_db}
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS drizzle AUTHORIZATION scolaira_owner;
GRANT CONNECT ON DATABASE :DBNAME TO scolaira, scolaira_app;
GRANT USAGE ON SCHEMA public TO scolaira, scolaira_app;
GRANT CREATE ON SCHEMA public TO scolaira;
GRANT USAGE ON SCHEMA drizzle TO scolaira, scolaira_app;
ALTER DEFAULT PRIVILEGES FOR ROLE scolaira_owner IN SCHEMA public
  GRANT ALL ON TABLES TO scolaira_app;
ALTER DEFAULT PRIVILEGES FOR ROLE scolaira_owner IN SCHEMA public
  GRANT ALL ON SEQUENCES TO scolaira_app;
ALTER DEFAULT PRIVILEGES FOR ROLE scolaira_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO scolaira_app;
\else
\echo 'Skipping per-database grants. Re-run connected to a database with: psql -d <db> -v boot_db=1 -f scripts/bootstrap-roles.sql'
\endif
