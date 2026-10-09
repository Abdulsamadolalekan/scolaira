-- M4.7c: small SECURITY DEFINER helper for tests to wipe rate_limits
-- between multi-register setup batches. We keep this as a migration so
-- it's owned by scolaira_owner (the only role that can DELETE from
-- rate_limits), and we only EXECUTE-grant it to the app role. It is safe
-- to expose: the worst case is clearing rate limits, which an attacker
-- without DB access cannot call, and with DB access they already lost.
-- This is NOT intended for production callers.
CREATE OR REPLACE FUNCTION auth_clear_rate_limits() RETURNS void AS $$
BEGIN
  DELETE FROM rate_limits;
  DELETE FROM login_attempts;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_clear_rate_limits() TO scolaira_app;
--> statement-breakpoint
