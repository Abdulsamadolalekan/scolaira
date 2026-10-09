-- M4.7: rate_limits and login_attempts are NOT tenant-scoped tables. They
-- hold rate-limit counters (keyed by IP/email strings) and append-only
-- failed-login logs, respectively. They are written exclusively by SECURITY
-- DEFINER helpers (auth_rate_limit_hit, direct INSERT from login()) that
-- run as the owner role. RLS policies on non-tenant tables with no policy
-- block even the owner (FORCE ROW LEVEL SECURITY applies to owners too),
-- which broke the login/register paths.
--
-- We add permissive policies scoped to the OWNER role (which is the only
-- role that touches these tables, via SECURITY DEFINER functions). The
-- runtime role (scolaira_app) does not get direct access, and the
-- SECURITY DEFINER functions validate their inputs. This keeps RLS
-- enabled (defense-in-depth) while allowing the legitimate auth path.
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rate_limits_owner_all ON rate_limits;
CREATE POLICY rate_limits_owner_all ON rate_limits FOR ALL
  TO scolaira_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS login_attempts_owner_all ON login_attempts;
CREATE POLICY login_attempts_owner_all ON login_attempts FOR ALL
  TO scolaira_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
-- Wrap login_attempts INSERT in a SECURITY DEFINER helper (same pattern as
-- rate-limit) so callers don't need direct write access to the table.
CREATE OR REPLACE FUNCTION auth_record_login_attempt(p_email text, p_ip text, p_success boolean)
RETURNS void AS $$
BEGIN
  INSERT INTO login_attempts (email, ip_address, success) VALUES (p_email, p_ip, p_success);
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint

-- Ensure the runtime app role cannot touch these tables directly (defense
-- in depth); they go through SECURITY DEFINER helpers.
REVOKE ALL ON rate_limits FROM PUBLIC, scolaira_app;
REVOKE ALL ON login_attempts FROM PUBLIC, scolaira_app;
GRANT EXECUTE ON FUNCTION auth_rate_limit_hit(text, integer, interval) TO scolaira_app;
GRANT EXECUTE ON FUNCTION auth_record_login_attempt(text, text, boolean) TO scolaira_app;
--> statement-breakpoint
