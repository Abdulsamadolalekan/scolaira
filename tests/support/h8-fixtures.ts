/**
 * H-8 test fixtures.
 *
 * `memberInvitationColumns` is the list of columns the Drizzle schema maps for
 * `member_invitations`. The RLS suite checks each one exists in the database, so
 * a schema/DDL drift (a column renamed in one place only) fails a test instead of
 * surfacing as a runtime `undefined` in production.
 *
 * It is written out by hand rather than derived from the Drizzle table object on
 * purpose: deriving it would make the test agree with the schema by
 * construction, which is exactly the mistake it is meant to catch.
 */
export const memberInvitationColumns = [
  'id',
  'organization_id',
  'email',
  'role',
  'token_hash',
  'status',
  'invited_by',
  'invited_at',
  'expires_at',
  'accepted_at',
  'accepted_by',
  'revoked_at',
  'created_at',
  'updated_at',
] as const;
