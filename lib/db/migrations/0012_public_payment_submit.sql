-- M6b: Permit public PENDING payment inserts under public context.
--
-- The default tenant_isolation policy requires organization_id = current
-- app.organization_id, but because the public endpoint inserts with no
-- user_id and a null recorded_by, and because the payment_number is assigned
-- by a BEFORE trigger, we add a narrow permissive policy explicitly allowing
-- PENDING inserts when the public GUC context has been entered.
--
-- There is no public UPDATE/DELETE path, and no public read path that does not
-- require additional linkage.

DROP POLICY IF EXISTS payments_public_insert ON payments;
CREATE POLICY payments_public_insert ON payments
  FOR INSERT
  WITH CHECK (
    _app_current_org_uuid() IS NOT NULL
    AND organization_id = _app_current_org_uuid()
    AND status = 'PENDING'
    AND method IN ('BANK_TRANSFER','CASH','POS','ONLINE','OTHER')
  );

-- audit_events must also be insertable under public context (the default
-- tenant policy already matches on organization_id, but ensure inserts
-- with actor_type='USER' and no actor user_id are allowed).
DROP POLICY IF EXISTS audit_events_public_insert ON audit_events;
CREATE POLICY audit_events_public_insert ON audit_events
  FOR INSERT
  WITH CHECK (
    _app_current_org_uuid() IS NOT NULL
    AND organization_id = _app_current_org_uuid()
  );
--> statement-breakpoint
