# Controlled pilot — security, recovery, and the line between verified and assumed

Prepared 2026-10-09 against `fea875e`. Objective: say plainly what is proven, by what, and what is
still only a claim. Nothing in this file was accepted on the strength of an earlier run: where a check
could be re-executed, it was.

Legend — **V-M** verified by measurement in this session · **V-T** verified by a test that exists in
this repository and passed on this commit · **A** assumption, still to be tested.

---

## 1. Tenant isolation

**Mechanism.** Every request opens a transaction and sets `app.organization_id` (and friends) with
`set_config(..., true)`, i.e. transaction-local, so a leaked connection cannot carry a tenant into the
next request. Tenant tables run `ROW LEVEL SECURITY` **with FORCE**, and the policies call
`auth_is_tenant_authorized()` / `auth_is_platform_admin_authorized()` — functions the readiness probe
checks for by signature at boot. [V-T `lib/db/tenant.ts`, `lib/ops/readiness.ts`]

**Verified today (V-M):**

| What                                                 | How it was measured                                                                                             | Result                                                                                                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime role is least-privileged                     | `pg_roles` read                                                                                                 | `scolaira_app`: `superuser=false`, `bypassrls=false`, `noinherit=true`                                                                                  |
| FORCE really binds even the owner                    | Read as `scolaira_owner` through the rehearsal harness                                                          | **0 rows** from `organizations`/tenant tables — the owner is not exempt, which is also why a backup needs a `BYPASSRLS` credential                      |
| One school cannot read another by id                 | Second school registered, authenticated, asked for the first school's pupil / invoice / opening-balance UUIDs   | refused — statuses recorded per request in the rehearsal report (`S16`)                                                                                 |
| No cross-tenant leakage in lists                     | The other school's own `/api/students?limit=200` body searched for the first school's admission prefix and name | not present                                                                                                                                             |
| Anonymous callers                                    | `GET` through the TLS front end                                                                                 | `/api/students`, `/api/invoices`, `/api/org/settings`, `/api/platform/orgs`, `/api/auth/me` → **401 at the route handler**; `/dashboard` → 307 to login |
| Middleware is not the boundary                       | Read `middleware.ts` + the 401s above                                                                           | correct by design: the Edge layer only redirects; the handler decides                                                                                   |
| Public payment path is reachable _and_ uninformative | `GET /p/<unknown-uuid>/view`                                                                                    | **404** (H-6's fix holds: not 401, not a redirect to login, and no existence leak)                                                                      |
| Preview surfaces are off in production               | `GET /preview/design-system`                                                                                    | **404**                                                                                                                                                 |
| Design-system exemption was not smuggled in          | production build, real server                                                                                   | no `/preview` route served                                                                                                                              |

**Test-suite backing (V-T):** `tests/db/` holds 19 files against a real PostgreSQL instance —
`h8-invitation-rls`, `financial-attacks`, `financial-invariants`, `db-boundary`, `audit`,
`concurrency`, `idempotency`, `m8-term-billing`, `m10-reconciliation`, `m11-collections`,
`opening-balance-rules`, `h2-independent-reaudit`, `h9-restore-verification` — 909 tests in the suite,
all passing on this commit. They are not mocked: the RLS ones open two connections and assert that one
tenant cannot see the other.

**A (assumption, needs the real environment):**

1. Behaviour behind a managed provider's **connection pooler**. The pool uses `prepare: true`;
   transaction-mode pooling invalidates cached prepared statements. Untested here.
2. Provider superuser. On any managed offering the vendor holds a superuser role that bypasses RLS.
   That is a trust decision about the vendor, not a property of this schema.
3. `app_meta` has RLS enabled but **not** forced (measured: it is the only such table). It holds build/
   metadata, not tenant rows — judged acceptable, but it is a deliberate exception and should stay on
   the list.
4. Multi-instance deployment (two app processes, one database) has not been exercised; the tenant
   context is per-transaction so it should be sound, and the concurrency tests cover the ledger side.

## 2. School-user permissions

- The role→action mapping lives in `lib/authz/permissions.ts`; pages additionally guard with
  `permission-guard` + `access-denied` components, so a restricted page says why rather than blanking.
  [V-T]
- Invitations are single-use links with a 7-day expiry and a hashed token (`member_invitations`), and
  **ownership is transferred, never invited** — the invite page states it. [V-T `h8-invitation-rls`]
- Support access is platform-only and gated in SQL by `auth_is_platform_admin_authorized()`; a school
  session cannot reach it even though `is_platform_admin` makes RLS more permissive, because the
  authorisation helper is checked separately. [V-T]
- **V-M, and it is a good one:** no route in this build writes `users.is_platform_admin`. The column is
  read by readiness and by restore verification; nothing sets it. Privilege cannot be escalated through
  the API — at the cost that granting the first platform administrator is a SQL operation (see
  `PILOT_DEPLOYMENT_REQUIREMENTS.md`, D-7).
- Password reset does not reveal whether an address exists, and echoes the token only when
  `NODE_ENV !== 'production'` **and** a dev flag is set. [V-T] The consequence for the pilot (no email
  transport exists) is decision D-6 in the deployment note.

## 3. Financial audit trail

`audit_events` carries `organization_id, actor_type, actor_user_id, actor_label, action, entity_type,
entity_id, before, after, reason, metadata, request_id, correlation_id, ip_address, created_at`
(measured from the live catalog). [V-M]

Rehearsal measurement (`S15` in the report) recorded, for a single synthetic school:
`term.create×1, term.bill×1, term.activate×1, student.import×1, student.create×8, receipt.issue×1,
payment_link.create×1, payment.record×2` — one row per mutating act, with the actor attached. The
billing act that creates 8 invoices and 16 lines is a **single** `term.bill` event [V-M], which is the
right granularity for a school to read back.

Related controls that exist and are tested, not merely documented: `reversals` rows (a reversal is a
record, not an edit), `receipts.allocations_snapshot` (the receipt freezes the allocation set at issue
time; the rehearsal asserts the snapshot's total equals the receipt amount), `waivers`,
`idempotency_keys` (billing cannot be run twice by accident), and `payments.unallocated_kobo` (a credit
is held, never applied invisibly). [V-T + V-M]

**A:** there is no retention/export/purge tooling for `audit_events`, and no tamper-evidence beyond
PostgreSQL itself (no hash chain, no WORM store). For a one-school pilot that is acceptable if the
nightly dump is kept off-box — the dump _is_ the tamper-evidence window. Decide before multi-school.

## 4. Production configuration — what to check on the real host

Verified here and therefore checkable there (the same commands):

```
GET /api/ready   → 200 {"status":"ready","build":{...},"checks":[database, schema, auth]}
GET /api/health  → 200 {"status":"ok","probe":"liveness","readiness":"/api/ready"}   # no dependency claims
GET /login       → headers: nosniff, X-Frame-Options: DENY, Referrer-Policy, HSTS, CSP, Permissions-Policy
```

Measured today: `schema {applied:52, expected:52, latest:"0052_opening_balances"}`,
`auth {sessionRoundTrip:true, csrfRoundTrip:true}`, `build.environment:"production"`, and
`build.commit:"development"` — **which must not be true in a real deploy**: set `SCOLAIRA_BUILD_COMMIT`.
[V-M]

Also measured: the header set above, including `content-security-policy` with
`script-src 'self' 'unsafe-inline' 'unsafe-eval'` (a documented pre-nonce state) and
`strict-transport-security: max-age=31536000; includeSubDomains` with no `preload`. [V-M]

`SCOLAIRA_BOOTSTRAP` and `SCOLAIRA_DEV_ECHO_RESET_TOKEN` must be absent in a deployed environment
(§3 of `.env.example`); a test asserts the request path never runs on the migration credential. [V-T]

**A:** all of the above on the actual host, through the actual certificate chain, on a phone on mobile
data. That is a 20-minute exercise once a host exists, and it is the last gate before real data.

## 5. Backups — the schedule to adopt

There is **no backup mechanism today** (measured: no cron, no provider config, no dump in any runbook
directory). What a pilot needs, minimally:

1. **Nightly `pg_dump -Fc`** at a quiet hour, written to the database host _and_ copied to a second
   machine (or object storage) in the same run. Copy must verify a checksum.
2. **Provider snapshot** (or WAL archiving / PITR) where the offering supports it, so the RPO is not
   "since last night".
3. **Retention:** 30 nightly + 12 monthly, off-box, encrypted at rest.
4. **A dump credential that is not the app role and not the schema owner.** Measured today: as
   `scolaira_owner`, `pg_dump` dies with
   `ERROR: query would be affected by row-level security policy for table "academic_sessions"` — the
   documented H9-F25 trap, now reproduced rather than assumed. The workaround is **not** removing FORCE.
   The minimum privilege set that actually worked, with two non-obvious parts written down because they
   cost an hour each:
   - `BYPASSRLS`, `NOLOGIN`-optional, `NOSUPERUSER`;
   - read access via `pg_read_all_data` **granted `WITH INHERIT TRUE`** — a `NOINHERIT` role gets a
     non-inheritable membership by default on PostgreSQL 16+, which yields silent
     `permission denied for table organizations` even though `pg_has_role()` says it is a member;
   - `USAGE` on schema `drizzle` **and** `SELECT` on `drizzle.__drizzle_migrations`, because `pg_dump`
     locks the migration ledger too; without it the dump dies before touching data.
     The rehearsal role used here is temporary and was dropped after the run. Making a permanent
     `scolaira_backup` role is your call (H9-F25).
5. **Monthly restore drill**, executed by the person who would have to do it at 7am.

## 6. The restore drill, executed 2026-10-09

First execution of `scripts/rehearse-restore.sh` in this project's history. `docs/ops/RECOVERY_DRILL.md`
previously said, correctly, that no drill had ever been run because no backup existed. This is what a
drill against a real cluster does prove — and it is the local, provider-independent shape of it:

| Stage                            | Result                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 preflight                      | `psql 17.11`; source `scolaira_e2e`; target `scolaira_rehearsal`; dump credential `super=false bypassrls=true` → guard satisfied                                          |
| 1 dump                           | `source-20261009T125437Z.dump`, **555,840 bytes**, sha256 `d25f838b64eba4e2…`, 0 s                                                                                        |
| 2 clean target                   | dropped/created, `pgcrypto` pre-created (superuser-only, as the script says)                                                                                              |
| 3 restore                        | `pg_restore exit=1`, **1 ignored error**, and that error was confirmed to be `must be owner of extension pgcrypto` on the `COMMENT ON EXTENSION` line — the expected one  |
| 4 data landed                    | `organizations=2 users=4 invoices=5`                                                                                                                                      |
| 5 schema matches this build      | `migrations: new=0 total=52` (a restored dump is already at head)                                                                                                         |
| 6 restored-database verification | `scripts/verify-restored-db.ts` → **`ok=true passed=10 failed=0 skipped=0`** with a platform administrator supplied, so the data assertions ran rather than being skipped |
| 7 teardown                       | target dropped, no residue; wall clock **2 s**                                                                                                                            |
| verdict                          | `RESULT: RESTORE REHEARSAL VERIFIED (local)`                                                                                                                              |

Evidence: `/home/user/backups/restore-drill-20261009/` (`transcript.log`, `summary.json`, the dump
itself — synthetic fixture data only).

**What this proves:** a dump of this schema restores into a clean database, keeps its data, needs no
schema repair to satisfy this build, and passes the product's own read-only restore verification.
**What it does not prove:** that any provider's snapshot or PITR works; that the off-box copy exists;
that a real incident would be noticed; anything about the production host. Those are the remaining
steps in §5 and the runbook below.

## 7. Runbook — the four commands that matter in an incident

```bash
# 1. Stop writing: take the app out of rotation (or scale to zero).
# 2. Confirm what you have, and when:
ls -l /backups/scolaira/ && sha256sum -c /backups/scolaira/SHA256SUMS.txt
# 3. Restore into a NEW database — never over the live one — and verify before switching:
createdb -T template0 -O scolaira_owner scolaira_restore_$(date +%u)
pg_restore -d "postgresql://scolaira_owner@localhost:5432/scolaira_restore_N" \
           --no-owner --role=scolaira_owner /backups/scolaira/source.dump
DATABASE_MIGRATION_URL=... npm run db:verify -- --json --platform-admin <ops-address>
# 4. Only when verification is ok:true: repoint DATABASE_URL at the restored database.
```

Decision you must make before the pilot, not during: **who is allowed to repoint `DATABASE_URL`, and
what is the maximum tolerated data loss** (that answer decides whether provider PITR is mandatory).

## 8. Residual risks for a one-school pilot, ranked

1. **No backup exists.** Fix: §5 before real data. Until then the honest status is "one disk failure =
   total loss of that school's records".
2. **No alerting.** A dead app or a failed migration is noticed by a human. Fix: external check on
   `/api/ready` + an email/SMS target.
3. **No password-reset channel** (no email transport in this build). Fix: pilot rule D-6, or accept an
   email provider as a scoped exception.
4. **CSP allows `unsafe-inline`/`unsafe-eval`.** Not exploitable by itself at this scope, but it is the
   weakest line in the header set. Fix: nonce pass, scheduled, not pilot-blocking.
5. **Pooler incompatibility is untested.** Fix: choose session mode (or `prepare:false`) and re-run the
   release gate against that configuration.
6. **`app_meta` without FORCE RLS.** Reviewed, no tenant data in it; keep it on the list.
7. **Single-instance assumption.** Two app processes sharing one database are untested end to end.
