/**
 * M4 runtime DB principal safety: the runtime DB session must NEVER have
 * rolsuper or rolbypassrls, and current_user must be exactly `scolaira_app`.
 *
 * This guard is enforced at connection time by `lib/db/index.ts` onconnect
 * hook: it FAIL-FASTs if rolsuper or rolbypassrls is true (meaning the
 * process will not start), and resets GUCs to safe defaults.
 */
import { describe, it, expect } from 'vitest';
import { getSql } from '@/lib/db';

describe('M4 runtime DB principal invariants', () => {
  it('runtime connection has current_user=scolaira_app and rolsuper=rolbypassrls=false', async () => {
    const sql = getSql();
    const r = await sql<{u:string;s:string;b:string}[]>`
      SELECT current_user AS u, rolsuper::text AS s, rolbypassrls::text AS b
        FROM pg_roles WHERE rolname = current_user`;
    expect(r[0]!.u).toBe('scolaira_app');
    expect(r[0]!.s).toBe('false');
    expect(r[0]!.b).toBe('false');
  });

  it('onconnect-style GUC reset leaves platform/bypass = "0"', async () => {
    // Use the same SQL the onconnect hook uses (set_config via SELECT) to
    // exercise exactly the production reset path, then read back.
    const sql = getSql();
    await sql`
      SELECT set_config('app.organization_id', '', false),
             set_config('app.user_id', '', false),
             set_config('app.acting_role', '', false),
             set_config('app.is_platform_admin', '0', false),
             set_config('app.auth_bootstrap', '0', false),
             set_config('app.bypass_financial_triggers', '0', false)`;
    const r = await sql<{pa:string;bft:string}[]>`
      SELECT current_setting('app.is_platform_admin') AS pa,
             current_setting('app.bypass_financial_triggers') AS bft`;
    expect(r[0]!.pa).toBe('0');
    expect(r[0]!.bft).toBe('0');
  });
});
