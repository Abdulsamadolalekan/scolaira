-- =============================================================================
-- 0050_member_invitations.sql
-- H-8: org-scoped, hashed, expiring, single-use membership invitations.
--
-- Measured defect (docs/readiness/H8_SCOPE_MAP.md, register §H-8):
--   * `app/(app)/members/page.tsx` renders an "Invite member" link to
--     `/members/invite`, a route that does not exist (404);
--   * `POST /api/members` answers 404 for an unknown email and 501
--     NOT_IMPLEMENTED for a known one, and no test covers either behaviour;
--   * `organization_members.status` already allows 'INVITED' and carries
--     `invited_at`, but there is no table that can hold a token, so an invite
--     could never be accepted.
--
-- ADDITIVE ONLY. No applied migration is edited, no existing policy is
-- replaced, and no datum is rewritten. The table is tenant-scoped in exactly the
-- same shape as every other tenant table: the platform-admin branch of
-- `auth_is_platform_admin_authorized()` (HMAC-bound, see
-- 0010_lockdown_secdef) plus the tenant-authorised branch. There is deliberately
-- NO public policy: an invitation is never readable without tenant context.
--
-- Delivery note (decision D-1): this phase ships a link, not email. The plaintext
-- token is returned exactly once, to the authorised inviter, and only its
-- sha256 is stored.
-- =============================================================================

--> statement-breakpoint

CREATE TYPE invitation_status AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED');

--> statement-breakpoint

CREATE TABLE member_invitations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email           varchar(320) NOT NULL,
  role            membership_role NOT NULL,
  -- sha256 hex of the URL token. The plaintext is never persisted.
  token_hash      char(64) NOT NULL,
  status          invitation_status NOT NULL DEFAULT 'PENDING',
  invited_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  invited_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  accepted_at     timestamptz,
  accepted_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_invitations_email_lower CHECK (email = lower(email)),
  CONSTRAINT member_invitations_token_hash_hex CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT member_invitations_expiry_after_invite CHECK (expires_at > invited_at),
  CONSTRAINT member_invitations_role_not_owner CHECK (role <> 'OWNER')
);

--> statement-breakpoint

CREATE UNIQUE INDEX member_invitations_token_hash_idx ON member_invitations(token_hash);

--> statement-breakpoint

-- At most one live invitation per (organization, email): re-inviting replaces
-- the previous pending row instead of leaving two usable tokens outstanding.
CREATE UNIQUE INDEX member_invitations_pending_unique_idx
  ON member_invitations(organization_id, email)
  WHERE status = 'PENDING';

--> statement-breakpoint

CREATE INDEX member_invitations_org_status_idx ON member_invitations(organization_id, status, invited_at DESC);

--> statement-breakpoint

ALTER TABLE member_invitations ENABLE ROW LEVEL SECURITY;

--> statement-breakpoint

ALTER TABLE member_invitations FORCE ROW LEVEL SECURITY;

--> statement-breakpoint

-- Tenant isolation.
--
-- MEASURED DECISION — why this table, alone among tenant tables, carries the
-- bootstrap branch.
--
-- Every other tenant table uses `platform OR (tenant AND org match)` (checked on
-- this database: students_tenant_isolation, reminders, payment_links). An
-- invitation CANNOT use that shape, because acceptance has a genuine
-- chicken-and-egg: the accepting user is not yet a member of the organization
-- and the organization is known only *after* the token is resolved, so there is
-- no tenant context to be in. The three candidate doors were measured:
--
--   * `auth_scope_seed_local(org, user)` — the non-NULL branch delegates to
--     `auth_scope_tenant_local(org, user)`, which verifies membership. A
--     non-member cannot use it. Ruled out by measurement, not by preference.
--   * `auth_scope_platform_local(user)` — requires a real platform
--     administrator; it also grants read/write across EVERY table of the target
--     organization. Far too wide for "consume one invitation".
--   * bootstrap (`app.auth_bootstrap = '1'`, reached only through
--     `withSystemScope()`) — no identity, no organization, and it opens only the
--     tables that explicitly opt in. Narrowest available door.
--
-- Bootstrap is therefore the door, on exactly the precedent of
-- `organizations_tenant_isolation`, which needs it for the same structural
-- reason (registration must create the organization before any membership
-- exists). The application layer keeps the reading narrow: `acceptInvitation`
-- addresses a single row by `sha256(token)` and writes nothing else. The
-- trade-off is stated rather than hidden — see docs/readiness/H8_CLOSEOUT.md;
-- the boundary test pins that a bootstrap context sees these rows and that no
-- OTHER tenant table is reachable from it.
CREATE POLICY member_invitations_tenant_isolation ON member_invitations
  USING (auth_is_platform_admin_authorized()
         OR current_setting('app.auth_bootstrap', true) = '1'
         OR (auth_is_tenant_authorized()
             AND organization_id = _app_current_org_uuid()));
--> statement-breakpoint

CREATE POLICY member_invitations_tenant_isolation_write ON member_invitations
  FOR INSERT
  WITH CHECK (auth_is_platform_admin_authorized()
              OR current_setting('app.auth_bootstrap', true) = '1'
              OR (auth_is_tenant_authorized()
                  AND organization_id = _app_current_org_uuid()));
--> statement-breakpoint

-- No DELETE at row level: an invitation is a record of intent and is revoked,
-- never erased (the acceptance path marks ACCEPTED/REVOKED instead).
--
-- AS RESTRICTIVE is load-bearing, not decoration. Policies are PERMISSIVE by
-- default and permissive policies are OR'd together, so a `FOR DELETE ... USING
-- (false)` PERMISSIVE policy next to the FOR ALL tenant policy adds TRUE OR FALSE,
-- i.e. nothing: measured, a tenant member deleted a row of their own
-- organization's invitations and the statement succeeded
-- (tests/db/h8-invitation-rls.test.ts). Only AS RESTRICTIVE makes it an AND, so
-- the delete becomes (tenant policy) AND false = denied.
--
-- NOTE FOR THE A5 PRIVILEGE/POLICY COVERAGE AUDIT (out of H-8 scope, recorded in
-- docs/readiness/H8_CLOSEOUT.md): `reminders_no_delete` and `reminders_no_update`
-- in 0019 are both PERMISSIVE, sit next to a `reminders_tenant_isolation ... FOR
-- ALL` policy, and therefore do not deny anything either. That table is frozen
-- (H-6/M6) and is not touched here.
CREATE POLICY member_invitations_no_delete ON member_invitations
  AS RESTRICTIVE FOR DELETE USING (false);
--> statement-breakpoint

-- Privileges, stated exactly as they end up (MEASURED after a full run, not just
-- inside this transaction).
--
-- The runtime role may read and create invitations and may move a row through
-- its lifecycle (status/accepted_at/revoked_at). Two facts decide this block:
--
--   1. `scripts/migrate.ts` finishes EVERY migration run with
--      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO
--      scolaira_app`. A table-level DELETE revoke written here therefore does not
--      survive the run that applies it. Measured after a 0 -> 50 run:
--      `has_table_privilege('scolaira_app','member_invitations','DELETE')` = true.
--      Deleting is instead impossible at the ROW level: policy
--      `member_invitations_no_delete` uses `USING (false)`, which no grant can
--      override. That policy — not this GRANT — is the enforcement point.
--
--   2. The four privileges R1 (0044) revoked stay revoked, because the runner
--      does not re-grant them: TRUNCATE is NOT subject to row-level security, so
--      a reintroduced TRUNCATE would silently defeat this table's RLS. They are
--      revoked explicitly here rather than left to the default privileges
--      (`scolaira_owner=arwdDxtm/scolaira_owner`), which hand all four to every
--      newly created table. That default is why the two 0048 tables
--      (`financial_periods`, `surface_scope_settings`) currently carry
--      TRUNCATE/REFERENCES/TRIGGER — recorded in docs/readiness/H8_CLOSEOUT.md as
--      an A5 privilege-coverage finding, out of H-8 scope.
GRANT SELECT, INSERT, UPDATE ON member_invitations TO scolaira_app;
--> statement-breakpoint

REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON member_invitations FROM scolaira_app;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Self-audit: the migration refuses to complete unless the invariants it claims
-- are actually true in this database (same discipline as 0042/0046/0048/0049).
-- -----------------------------------------------------------------------------

DO $audit$
DECLARE
  v_policies    integer;
  v_bootstrap   integer;
  v_constraints integer;
  v_rls         boolean;
  v_force       boolean;
  v_grants      text[];
  v_leaked      text[];
BEGIN
  SELECT count(*) INTO v_policies
    FROM pg_policies
   WHERE tablename = 'member_invitations';
  IF v_policies <> 3 THEN
    RAISE EXCEPTION 'H-8 audit: expected 3 policies on member_invitations, found %', v_policies;
  END IF;

  SELECT relrowsecurity, relforcerowsecurity INTO v_rls, v_force
    FROM pg_class WHERE relname = 'member_invitations';
  IF NOT v_rls OR NOT v_force THEN
    RAISE EXCEPTION 'H-8 audit: member_invitations must have RLS enabled AND forced (rls=%, force=%)',
      v_rls, v_force;
  END IF;

  -- The three DML privileges the application needs must be present. (No exact-set
  -- assertion: `scripts/migrate.ts` re-grants DELETE on all tables after this
  -- transaction commits, so an exact set checked here would describe a state that
  -- does not survive the run. Row-level deletes are blocked by policy instead.)
  SELECT array_agg(privilege_type ORDER BY privilege_type) INTO v_grants
    FROM information_schema.role_table_grants
   WHERE table_name = 'member_invitations' AND grantee = 'scolaira_app';
  IF NOT (v_grants @> ARRAY['INSERT','SELECT','UPDATE']) THEN
    RAISE EXCEPTION 'H-8 audit: scolaira_app is missing required DML grants on member_invitations: %',
      v_grants;
  END IF;

  -- The four privileges R1 revoked must be absent: they are not re-granted by the
  -- migration runner, and TRUNCATE in particular bypasses row-level security.
  SELECT array_agg(p.priv) INTO v_leaked
    FROM unnest(ARRAY['TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) AS p(priv)
   WHERE has_table_privilege('scolaira_app', 'member_invitations', p.priv);
  IF v_leaked IS NOT NULL THEN
    RAISE EXCEPTION 'H-8 audit: runtime role holds RLS-bypassing privileges on member_invitations: %', v_leaked;
  END IF;

  -- Deleting must be impossible at the row level (that is what the DELETE grant
  -- cannot override).
  SELECT count(*) INTO v_bootstrap
    FROM pg_policy
   WHERE polrelid = 'member_invitations'::regclass
     AND polname = 'member_invitations_no_delete'
     AND polpermissive = false
     AND pg_get_expr(polqual, polrelid) = 'false';
  IF v_bootstrap < 1 THEN
    RAISE EXCEPTION 'H-8 audit: member_invitations has no RESTRICTIVE denying DELETE policy (a permissive USING (false) denies nothing)';
  END IF;

  SELECT count(*) INTO v_constraints
    FROM pg_constraint
   WHERE conrelid = 'member_invitations'::regclass AND contype = 'c';
  IF v_constraints < 4 THEN
    RAISE EXCEPTION 'H-8 audit: expected at least 4 CHECK constraints, found %', v_constraints;
  END IF;

  -- The bootstrap branch is load-bearing: without it the acceptance path cannot
  -- read the row its token hashes to (that failure was measured end-to-end
  -- before this branch existed). A future edit that drops it must fail here, not
  -- in production.
  SELECT count(*) INTO v_bootstrap
    FROM pg_policy
   WHERE polrelid = 'member_invitations'::regclass
     AND pg_get_expr(polqual, polrelid) LIKE '%auth_bootstrap%';
  IF v_bootstrap < 1 THEN
    RAISE EXCEPTION 'H-8 audit: member_invitations lost its bootstrap branch — token acceptance would break';
  END IF;

  RAISE NOTICE 'H-8 audit: member_invitations ok — % policies, FORCE RLS, required DML grants present, no TRUNCATE/REFERENCES/TRIGGER/MAINTAIN, % CHECK constraints, bootstrap branch present, deletes denied at row level.',
    v_policies, v_constraints;
END
$audit$;
--> statement-breakpoint
