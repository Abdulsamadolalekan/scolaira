-- M4.6 security hardening: RLS is only meaningful when the runtime database
-- principal does NOT have BYPASSRLS or SUPERUSER.
--
-- Roles are created by the one-time provisioning script
-- (scripts/bootstrap-roles.sql, run as a superuser). THIS MIGRATION does
-- NOT create or alter roles because that requires superuser / CREATEROLE
-- and migrations run as the schema-owner (scolaira_owner), which may or
-- may not have that privilege in every deployment.
--
-- What this migration does:
--   1. Ensure the app role has USAGE on public/drizzle.
--   2. GRANT appropriate privileges on existing tables/sequences/functions.
--   3. Re-assert FORCE ROW LEVEL SECURITY on tenant-owned tables (so
--      table owners cannot bypass RLS).
--   4. Set default privileges so future tables created by scolaira_owner
--      are accessible to the app.
--
-- NOTE: the application connection now SET ROLE to scolaira_app (or
-- connects directly as scolaira_app) via lib/db/index.ts, so these
-- grants are what the HTTP request path actually uses.

GRANT USAGE ON SCHEMA public TO scolaira_app;
GRANT CREATE ON SCHEMA public TO scolaira_app;
--> statement-breakpoint

DO $$
DECLARE t text;
BEGIN
  FOR t IN VALUES
    ('organizations'),('users'),('organization_members'),('sessions'),
    ('password_credentials'),('password_resets'),('login_attempts'),
    ('academic_sessions'),('terms'),('classes'),('students'),('guardians'),
    ('student_guardians'),('class_enrollments'),('fee_definitions'),
    ('fee_assignments'),('invoices'),('invoice_lines'),('payments'),
    ('payment_allocations'),('receipts'),('reversals'),('payment_links'),
    ('communications'),('audit_events'),('idempotency_keys'),('webhook_events'),
    ('doc_number_sequences')
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE %I TO scolaira_app', t);
  END LOOP;
END $$;
--> statement-breakpoint

GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO scolaira_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO scolaira_app;
--> statement-breakpoint

ALTER DEFAULT PRIVILEGES FOR ROLE scolaira_owner IN SCHEMA public
  GRANT ALL ON TABLES TO scolaira_app;
ALTER DEFAULT PRIVILEGES FOR ROLE scolaira_owner IN SCHEMA public
  GRANT ALL ON SEQUENCES TO scolaira_app;
ALTER DEFAULT PRIVILEGES FOR ROLE scolaira_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO scolaira_app;
--> statement-breakpoint
