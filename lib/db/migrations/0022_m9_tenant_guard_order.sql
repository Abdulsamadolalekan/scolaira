-- M9 follow-up: tenant auto-stamp triggers must run before same-row
-- relationship guards. PostgreSQL fires BEFORE ROW triggers alphabetically;
-- terms_set_org / student_guardians_set_org otherwise ran after the original
-- m9_* guard and left NEW.organization_id NULL during a valid insert.
--
-- This is an upgrade-safe repair for databases that already applied 0021.
-- No data is changed and no financial table is mutated.

DROP TRIGGER IF EXISTS m9_terms_tenant_guard ON terms;
--> statement-breakpoint
CREATE TRIGGER z_m9_terms_tenant_guard
BEFORE INSERT OR UPDATE OF organization_id, session_id ON terms
FOR EACH ROW EXECUTE FUNCTION m9_terms_tenant_guard();
--> statement-breakpoint

DROP TRIGGER IF EXISTS m9_student_guardians_tenant_guard ON student_guardians;
--> statement-breakpoint
CREATE TRIGGER z_m9_student_guardians_tenant_guard
BEFORE INSERT OR UPDATE OF organization_id, student_id, guardian_id ON student_guardians
FOR EACH ROW EXECUTE FUNCTION m9_student_guardians_tenant_guard();
--> statement-breakpoint

COMMENT ON TRIGGER z_m9_terms_tenant_guard ON terms IS
  'M9: runs after the tenant organization auto-stamp trigger';
COMMENT ON TRIGGER z_m9_student_guardians_tenant_guard ON student_guardians IS
  'M9: runs after the tenant organization auto-stamp trigger';
