# Runbook — Restore a dump into a clean database

> **This is the only restore path that exists today.** There is no automated backup, no
> point-in-time recovery and no provider snapshot to fall back on (H9-F1, H9-F5). What follows
> works with a dump file that someone else produced — it does not create one on a schedule.

**Audience:** an operator with the database owner credential and shell access to a machine that
can reach the target Postgres.
**Status:** rehearsed locally, 2026-09-26, against a disposable database (§6). **Not** a production
drill: no production backup exists to restore from.

---

## 0. What you need before you start

| Item                        | Note                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A dump file                 | `pg_dump` custom format (`.dump`).                                                                                |
| Target Postgres             | Same major version as the source (the dump is version-sensitive).                                                 |
| Owner credential            | `DATABASE_MIGRATION_URL` — the role that owns the schema. Used for restore, migrations and verification.          |
| A **dump credential**       | See §1. This is the step that surprises people.                                                                   |
| Platform-admin user id      | A real `users.id` with `is_platform_admin = true`, so the verification tool can read tenant data (see §5).        |

### The credential trap (measured, H9-F25)

Every tenant table runs with `FORCE ROW LEVEL SECURITY`, and tenant context is established per
connection by the application. `pg_dump` does not establish that context, so **`pg_dump` run as
`scolaira_owner` fails**:

```
pg_dump: error: query failed: ERROR:  query would be affected by row-level security policy for table "academic_sessions"
HINT:  To disable the policy for the table's owner, use ALTER TABLE NO FORCE ROW LEVEL SECURITY.
```

Taking a dump therefore requires a role with `BYPASSRLS` (or the database superuser). **No such
role exists in this project today, and adding one is not authorised** — it would widen the
privilege model that H-1/H-2/R1 deliberately narrowed. Until that decision is made, a dump can
only be taken by the database superuser. That is a real dependency of the backup mechanism, not an
implementation detail.

Never disable RLS (`ALTER TABLE … NO FORCE`) to make a dump work: that would silently remove the
policy protection from a live database.

---

## 1. Take a dump

```bash
# Superuser path (the only one that works today), on the database host:
sudo -u postgres pg_dump -Fc <source_database> > /secure/path/<source>-$(date -u +%Y%m%dT%H%M%SZ).dump

# Verify it is not empty before you rely on it:
stat -c '%n %s bytes' /secure/path/<source>-*.dump
```

A dump with a suspiciously small size is a failed dump. `pg_dump` writes errors to stderr and can
still exit non-zero after writing a partial file — check the exit status, not just the file.

## 2. Create an empty target

The target must be new and empty. Never restore over a database that is serving traffic.

```bash
sudo -u postgres psql -c "CREATE DATABASE <target_db> OWNER scolaira_owner;"
sudo -u postgres psql -d <target_db> -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
```

`pgcrypto` is pre-created here because extension creation needs superuser; `pg_restore` running as
the schema owner will otherwise report `must be owner of extension pgcrypto`. That one error is
expected and harmless when the extension already exists.

## 3. Restore

```bash
export TARGET_URL="postgresql://scolaira_owner:<pw>@<host>:5432/<target_db>"
pg_restore -d "$TARGET_URL" --no-owner --role=scolaira_owner /secure/path/<dump>
```

Read the output. `pg_restore` continues past errors and then reports
`warning: errors ignored on restore: N`. **N must be 0 or explicitly explained** — an ignored error
is usually a missing object.

## 4. Check the data is actually there

Do this as the superuser, not as the owner: the owner sees **zero rows** through FORCE RLS without
tenant context, which makes an empty restore look exactly like a successful one.

```bash
sudo -u postgres psql -d <target_db> -c \
  "select (select count(*) from organizations) orgs, (select count(*) from users) users, (select count(*) from invoices) invoices;"
```

## 5. Bring the database to the state this build expects

A restored dump carries whatever schema existed at dump time. The application refuses to serve a
database whose migration state does not match the build (`/api/ready` → `503 schema_behind` /
`schema_ahead` / `schema_version_mismatch`). Apply migrations before serving traffic:

```bash
DATABASE_MIGRATION_URL="$TARGET_URL" npm run db:migrate
# [db] migrations applied. new=<n> total=50
```

This step also re-applies the append-only privilege hardening (`REVOKE DELETE` on financial and
audit tables). A dump taken from a database whose privileges had drifted will be corrected here —
which is why it is a step in the runbook and not an afterthought.

## 6. Verify the restored database (do not skip, do not eyeball it)

```bash
DATABASE_MIGRATION_URL="$TARGET_URL" \
  npx tsx --conditions=react-server scripts/verify-restored-db.ts \
    --platform-admin <platform-admin-uuid-or-email>
```

The tool is read-only; it cannot change financial truth. It prints one PASS/FAIL block and exits
non-zero unless every check passes. Without `--platform-admin` it runs the catalog checks only and
reports the data checks as `SKIPPED` — a skipped check is **not** a pass, and the overall verdict
stays `NOT VERIFIED`.

What it checks: migration state, required objects, `FORCE ROW LEVEL SECURITY`, the runtime role's
privileges, and six financial invariants (invoice totals, invoice paid amounts, payment
unallocated amounts, reversal caps, non-negative amounts, orphaned ledger rows).

### Reading a FAIL

| Failure                                | What it means                                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `security.runtime_privileges`          | The restored copy grants the runtime role privileges it must not have (e.g. `DELETE` on `invoices`). |
| `financial.invoice_totals` and friends | The data itself violates a financial invariant. Investigate before serving traffic.                 |
| `schema.*`                             | The dump is older/newer than this build, or something is missing.                                    |

Two failure modes are expected and are **not** tool defects:

1. **A dump taken from a database seeded by `npm run e2e:seed`** restores the escalated grants that
   the E2E seed path leaves behind (H9-F24). §5 corrects it; the tool proves it.
2. **A development or test database** carries bulk fixtures inserted outside the application
   (hundreds of invoices with no line items). Those rows really do violate
   `total = Σ lines`, and the tool is right to report them. The tool is a restore check for
   production data, not a fixture linter — point it at a restored dump, not at a scratch database.

## 7. Point the application at the restored database

1. Set `DATABASE_URL` (runtime role — `scolaira_app`, never the owner) to the restored database.
2. Restart the application process.
3. Confirm readiness: `curl -s https://<host>/api/ready` → `200 {"status":"ready"}`.
   `/api/health` is liveness only and says nothing about the database.
4. Run the smallest real journey (log in, open one invoice, record one test payment in test mode).
5. Only then repoint users at the new instance.

## 8. Record what happened

Write the outcome into a drill record — source dump, target, timestamps, wall-clock duration,
RPO/RTO outcome, issues, operator. **No drill record exists yet, because no backup exists yet.**
The record is the artefact the acquisition checklist asks for (ADQ D4) and its absence is
H9-F3/H9-F16.

---

## Rehearsal evidence (local, 2026-09-26)

Performed on a disposable database on the development host — **local rehearsal, not production
evidence**:

| Step                                       | Result                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `pg_dump` as `scolaira_owner`              | **FAILED** — `query would be affected by row-level security policy`           |
| `pg_dump` as superuser                     | 1,063,641 bytes                                                              |
| `pg_restore` as owner into an empty target | `errors ignored on restore: 1` (pre-created `pgcrypto` only)                  |
| Rows restored (read as superuser)           | 2 organizations, 4 users, 5 invoices, 4 invoice lines                        |
| `verify-restored-db` **before** §5         | `9 passed, 1 failed — NOT VERIFIED` (inherited `DELETE` on `invoices`)        |
| `npm run db:migrate`                       | `new=0 total=50`                                                             |
| `verify-restored-db` **after** §5          | `10 passed, 0 failed, 0 skipped — VERIFIED` (exit 0)                         |

Why this matters: the tool caught a real privilege difference between the source and what the
restored copy should look like, and the runbook's repair step was what fixed it. Steps 7–8 were not
rehearsed locally (no deployed environment exists).

## Out of scope / not covered here

- **Taking** backups on a schedule, off-site copies, PITR: no host or provider has been selected.
- Point-in-time recovery to a timestamp: needs a provider that offers it.
- Any RPO/RTO claim: nothing has been measured against a real backup.
