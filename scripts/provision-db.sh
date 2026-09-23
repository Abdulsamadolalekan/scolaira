#!/usr/bin/env bash
# scripts/provision-db.sh
#
# One-time DB provisioning: creates roles, databases, installs pgcrypto,
# then runs migrations as the OWNER role. This runs as a SUPERUSER
# (postgres) via sudo. Runtime never has these privileges.
set -euo pipefail

DB_OWNER_PW="${DB_OWNER_PW:-scolaira_owner_pw}"
DB_APP_PW="${DB_APP_PW:-scolaira_app_pw}"
DB_DEV_PW="${DB_DEV_PW:-scolaira}"

SUPERUSER_PSQL="sudo -n -u postgres psql -v ON_ERROR_STOP=1"

run_sql() { $SUPERUSER_PSQL "$@"; }

echo "[provision] creating roles..."
run_sql <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scolaira_owner') THEN
    CREATE ROLE scolaira_owner NOBYPASSRLS NOSUPERUSER CREATEDB CREATEROLE LOGIN PASSWORD '${DB_OWNER_PW}';
  ELSE
    ALTER ROLE scolaira_owner WITH LOGIN PASSWORD '${DB_OWNER_PW}' CREATEDB CREATEROLE NOBYPASSRLS NOSUPERUSER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scolaira_app') THEN
    CREATE ROLE scolaira_app NOINHERIT LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${DB_APP_PW}';
  ELSE
    ALTER ROLE scolaira_app WITH LOGIN PASSWORD '${DB_APP_PW}' NOCREATEDB NOCREATEROLE NOBYPASSRLS NOSUPERUSER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scolaira') THEN
    CREATE ROLE scolaira NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE LOGIN PASSWORD '${DB_DEV_PW}';
  ELSE
    ALTER ROLE scolaira WITH LOGIN PASSWORD '${DB_DEV_PW}' NOCREATEDB NOCREATEROLE NOBYPASSRLS NOSUPERUSER;
  END IF;
END \$\$;
GRANT scolaira_app TO scolaira;
GRANT scolaira_app TO scolaira_owner WITH ADMIN OPTION;
SQL

for db in scolaira scolaira_test; do
  echo "[provision] database $db..."
  run_sql -tc "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1 || run_sql -c "CREATE DATABASE $db OWNER scolaira_owner;"
  run_sql -c "ALTER DATABASE $db OWNER TO scolaira_owner;"
  run_sql -d "$db" <<SQL
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS drizzle AUTHORIZATION scolaira_owner;
GRANT CONNECT ON DATABASE $db TO scolaira, scolaira_app;
GRANT USAGE ON SCHEMA public TO scolaira, scolaira_app;
GRANT CREATE ON SCHEMA public TO scolaira;
GRANT USAGE ON SCHEMA drizzle TO scolaira, scolaira_app;
ALTER DEFAULT PRIVILEGES FOR ROLE scolaira_owner IN SCHEMA public
  GRANT ALL ON TABLES TO scolaira_app;
ALTER DEFAULT PRIVILEGES FOR ROLE scolaira_owner IN SCHEMA public
  GRANT ALL ON SEQUENCES TO scolaira_app;
ALTER DEFAULT PRIVILEGES FOR ROLE scolaira_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO scolaira_app;
SQL
done

echo "[provision] done."
