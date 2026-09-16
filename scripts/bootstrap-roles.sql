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
-- Usage:
--   sudo -u postgres psql -f scripts/bootstrap-roles.sql
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

-- Create databases if missing.
DO $$
BEGIN
  PERFORM 1 FROM pg_database WHERE datname = 'scolaira';
  IF NOT FOUND THEN
    EXECUTE 'CREATE DATABASE scolaira OWNER scolaira_owner';
  ELSE
    EXECUTE 'ALTER DATABASE scolaira OWNER TO scolaira_owner';
  END IF;
  PERFORM 1 FROM pg_database WHERE datname = 'scolaira_test';
  IF NOT FOUND THEN
    EXECUTE 'CREATE DATABASE scolaira_test OWNER scolaira_owner';
  ELSE
    EXECUTE 'ALTER DATABASE scolaira_test OWNER TO scolaira_owner';
  END IF;
END $$;

-- Per-database grants.
\if :{?boot_db}
\else
-- These commands must run per-database; invoke with
--   psql -d scolaira  -v boot_db=1 -f scripts/bootstrap-roles.sql
--   psql -d scolaira_test -v boot_db=1 -f scripts/bootstrap-roles.sql
\warning Skipping per-database grants; pass -v boot_db=1 and connect to a database.
\endif
