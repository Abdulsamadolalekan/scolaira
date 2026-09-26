-- M10 final-audit critical fix: the original control-plane policies used the
-- forgeable app.is_platform_admin GUC directly. Match the post-M4.10 tenant
-- policy contract: platform access is granted only by the SECURITY DEFINER
-- authorization helper, and tenant access requires a valid tenant token.

DROP POLICY IF EXISTS reconciliation_cases_tenant_isolation ON reconciliation_cases;
CREATE POLICY reconciliation_cases_tenant_isolation ON reconciliation_cases FOR ALL
USING (
  auth_is_platform_admin_authorized()
  OR (auth_is_tenant_authorized()
      AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
)
WITH CHECK (
  auth_is_platform_admin_authorized()
  OR (auth_is_tenant_authorized()
      AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
);
--> statement-breakpoint

DROP POLICY IF EXISTS reconciliation_evidence_tenant_isolation ON reconciliation_evidence;
CREATE POLICY reconciliation_evidence_tenant_isolation ON reconciliation_evidence FOR ALL
USING (
  auth_is_platform_admin_authorized()
  OR (auth_is_tenant_authorized()
      AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
)
WITH CHECK (
  auth_is_platform_admin_authorized()
  OR (auth_is_tenant_authorized()
      AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
);
--> statement-breakpoint

DROP POLICY IF EXISTS reconciliation_candidates_tenant_isolation ON reconciliation_candidates;
CREATE POLICY reconciliation_candidates_tenant_isolation ON reconciliation_candidates FOR ALL
USING (
  auth_is_platform_admin_authorized()
  OR (auth_is_tenant_authorized()
      AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
)
WITH CHECK (
  auth_is_platform_admin_authorized()
  OR (auth_is_tenant_authorized()
      AND organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
);
