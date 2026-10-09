# SCOLAIRA — Backup & Disaster Recovery

> A backup that has never been restored is an assumption, not a recovery strategy.
>
> **There is no backup to restore.** That sentence is the status of this document, not a figure of
> speech: as of H-9 (2026-09-26) no backup mechanism exists, no restore has ever been performed, and
> no recovery owner is named.

---

## 0. What is true today (H-9 status, 2026-09-26)

| Control in this document | State today                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Automated daily backups (§II.A) | **Absent.** No host or provider has been chosen (H9-F5), so nothing is scheduled and nothing has run (H9-F1).   |
| Point-in-time recovery (§II.A)  | **Absent.** Cannot be enabled without a host decision; the provider named below is not integrated.              |
| Off-site backup (§II.B)         | **Absent.** No storage target, no schedule, no encryption job.                                                  |
| Restore performed and verified  | **Never.** RPO/RTO targets have never been measured against a real backup (H9-F3).                              |
| Restore testing cadence (§V)    | **Never executed.** No record exists; this is the artefact the acquisition checklist asks for (ADQ D4).         |
| Backup monitoring (§VII)        | **Absent.** Nothing to monitor and no alerting path (H9-F10).                                                   |
| Named recovery owner (§V)       | **Absent.** No named owner for backup verification, drill cadence or SEV1 recovery (H9-F4).                     |
| Migration rollback plans (§VI)  | **Absent.** No migration carries a rollback plan; that claim is corrected in place below (H9-F11).               |
| Provider claims (Supabase/Vercel) | **Intent, not implementation.** Nothing in this repository deploys to or integrates with either (H9-F12).      |

**What does exist:** a read-only verification tool (`scripts/verify-restored-db.ts`) and an
executable restore runbook ([`docs/ops/RESTORE_TO_CLEAN_DATABASE.md`](./ops/RESTORE_TO_CLEAN_DATABASE.md)),
both rehearsed locally against a disposable database — **local rehearsal only, no production
evidence**. The mechanism that would produce a backup in the first place is blocked on the host and
provider decision and belongs to a later, separately authorised tranche.

---

## I. Objectives

| Metric                                                      | Pilot target | Mature target |
| ----------------------------------------------------------- | ------------ | ------------- |
| **RPO** (Recovery Point Objective — max data loss)          | ≤ 1 hour     | ≤ 5 minutes   |
| **RTO** (Recovery Time Objective — time to restore service) | ≤ 4 hours    | ≤ 1 hour      |

## II. Backup Strategy

**Everything in §II and §III below is intent.** None of it is implemented. The one thing that *has*
been measured is a blocker the plan does not mention: see "The credential problem" after §II.C.

### A. Automated Backups (Supabase) — NOT IMPLEMENTED

- **Daily logical backups** (built-in Supabase).
- **Point-in-Time Recovery (PITR)** enabled on production from day one (Supabase Pro). Allows restore to any second in the retention window (7 days pilot; extend to 30 days post-pilot).
- Retention of daily backups: 30 days.

### B. Off-site Backups — NOT IMPLEMENTED

- Weekly logical backup (pg_dump) exported and encrypted to a separate cloud storage (e.g., S3-compatible storage in a different region/account) via a scheduled job (GitHub Action or Supabase Edge Function with minimal privilege).
- On-demand ad-hoc backup before any destructive migration.

### C. Source Code & Configuration — PARTIAL (the repository exists; nothing else does)

- All code, migrations, tests, docs in GitHub private repo (remote backup per §47).
- Infrastructure-as-code (Vercel + Supabase config) captured in repo as we grow; for pilot, documented env var schema in this doc is sufficient.
- Env var list (not values) versioned in repo; values stored in Vercel + Supabase secret stores and copied to founder-owned password manager as a final fallback.

#### The credential problem (measured, H9-F25)

A logical backup requires `pg_dump`, and **`pg_dump` does not work with the role this project uses
to own the schema**. Every tenant table runs with `FORCE ROW LEVEL SECURITY`, and `pg_dump` does not
establish tenant context, so it fails:

```
pg_dump: error: query failed: ERROR:  query would be affected by row-level security policy for table "academic_sessions"
HINT:  To disable the policy for the table's owner, use ALTER TABLE NO FORCE ROW LEVEL SECURITY.
```

Taking a dump therefore requires a role with `BYPASSRLS` (or the database superuser). **No such role
exists, and creating one is not authorised** — it would widen the privilege model that H-1, H-2 and
R1 deliberately narrowed. This dependency must be resolved as part of the backup-mechanism decision;
it is not an implementation detail, and disabling RLS is not an acceptable workaround.

## III. What Gets Backed Up

**Nothing in this table is currently backed up.** It is the coverage target.

| Asset                                                | Primary backup (intended)    | Off-site backup (intended)                           | Frequency (intended)             |
| ---------------------------------------------------- | ---------------------------- | ---------------------------------------------------- | -------------------------------- |
| Postgres database (all financial data, users, audit) | Supabase PITR + daily backup | Weekly encrypted pg_dump to independent storage      | Continuous (PITR), daily, weekly |
| Supabase Storage (receipts, CSV imports, logos)      | Supabase built-in            | Sync to secondary bucket weekly                      | daily                            |
| Application code                                     | GitHub                       | GitHub (remote, separate from sandbox)               | on every push                    |
| Environment variables                                | Vercel + Supabase            | Encrypted offline copy in founder password manager   | on change                        |
| DNS / domain                                         | Domain registrar             | Registrar handles; access credentials stored offline | n/a                              |

## IV. Restore Procedures

### A. User Error / Small Data Fix

1. Identify scope and timestamp of corruption (via audit log).
2. If isolated (e.g., one payment mis-recorded), use the documented correction UI (reverse + re-record) — this is the preferred path and preserves audit history.
3. If UI path isn't available, write a reviewed, audited data-fix script in `/ops/scripts/`, run against staging first, then production; log the action in the platform audit.

### B. Production Outage with Data Loss (PITR restore)

1. Declare SEV1. Communicate status.
2. Put app in maintenance mode (Vercel maintenance page; writes disabled via feature flag).
3. Identify the last known-good timestamp via audit log/webhook records.
4. Use Supabase dashboard/API to trigger PITR restore to a new database instance.
5. Verify restored data invariants (run financial invariant health-check queries: totals match, orphaned allocations absent, no negative balances).
6. Update app to point to new DB; warm caches; disable maintenance mode.
7. Reconcile any transactions between restore point and outage (from webhook_events + Paystack dashboard + bank statements) using a documented replay tool.
8. Post-mortem within 48h.

### C. Total Supabase Loss (Catastrophic)

1. Declare SEV1.
2. Provision new Supabase project.
3. Restore from latest off-site pg_dump.
4. Restore storage from secondary bucket.
5. Apply migrations not present in backup (should be none if backup is recent).
6. Redeploy app with new DB credentials.
7. Reconcile transactions since last weekly backup (limited to ≤ 1 week of data loss; this is why PITR is the primary line of defense and weekly off-site is the fallback).
8. Validate invariants, enable writes, communicate to schools.

### D. Accidental Production Deploy (Code-level regression)

1. Roll back via Vercel "Instant Rollback" to previous deployment.
2. Verify health checks green; run post-rollback smoke.
3. If rollback introduces DB incompatibility, restore from migration-aware backup (unlikely because we avoid non-reversible deploys in pilot).

### E. Secret Compromise

1. Revoke/rotate compromised secret immediately (Paystack webhook secret, DB password, Supabase service role key).
2. Update secret store (Vercel/Supabase env vars).
3. Redeploy app so new secrets take effect.
4. Audit access with leaked secret (Paystack dashboard, Supabase logs); if evidence of misuse, treat as SEV1 and reconcile financial state.
5. Post-mortem.

## V. Restore Testing Cadence

| Test (intended)                              | Frequency (intended)                  | Owner (intended)      | Ever run? |
| -------------------------------------------- | ------------------------------------- | --------------------- | --------- |
| Local restore from pg_dump to empty Postgres | Monthly (pilot), quarterly post-pilot | Engineering           | **No**    |
| PITR restore to staging clone                | Quarterly                             | Engineering           | **No** — no PITR and no staging exist |
| Full disaster tabletop walkthrough           | Bi-annually                           | Founder + Engineering | **No**    |

**Nothing on this table has ever been run, and no owner is named**, so the cadence is currently a
wish rather than a schedule (H9-F3, H9-F4).

What a record must contain when a test *is* run: date, source artefact, target, wall-clock duration,
measured data-loss window against the RPO in §I, issues found, manual steps improvised, and the
operator's name. The template is in `docs/ops/RESTORE_TO_CLEAN_DATABASE.md` §8.

The only restoration evidence that exists today is the **local rehearsal** recorded in that runbook:
a dump restored into a disposable database, repaired, and verified by
`scripts/verify-restored-db.ts` (`10 passed, 0 failed — VERIFIED`). It proves the procedure works.
It does **not** prove a production backup exists, and it measures nothing about RTO/RPO against a
real backup.

## VI. Migration Safety

**Corrections (H-9):** this section previously claimed two things that are not true here.

- ~~"Every migration is applied to staging first"~~ — **there is no staging environment** (H9-F7).
  Migrations are exercised in CI against a disposable Postgres, which is the only rehearsed path.
- ~~"Each migration has a rollback plan"~~ — **no migration in `lib/db/migrations/` carries a
  rollback plan**, and there is no automated down-migration mechanism (H9-F11). Writing retroactive
  rollback plans would mean editing applied migrations, which is forbidden; the honest position is
  that recovery from a bad migration means **restoring a backup**, and there is no backup (H9-F1).

What is true today:

- Migrations are additive and numbered; the chain is the source of truth, and the build pins the
  expected count and newest tag (`lib/ops/migration-manifest.ts`) so a mismatch is reported by
  `/api/ready` rather than discovered later.
- Applied migrations are never edited; new work takes the next number after the chain
  (currently `0051`+).
- Destructive migrations (DROP TABLE/COLUMN) are multi-step and forbidden on pilot without founder
  approval.
- Before a destructive change, take a dump — which today means solving the credential problem above
  first.

## VII. Backup Monitoring

**There is nothing to monitor and nowhere to send an alert (H9-F1, H9-F10).** The intended controls
— dashboard alerts, a weekly job notification, failed-backup P1 — all assume a backup mechanism that
does not exist. When one is built, the monitoring must ship with it, not after it; today a total
backup failure would be silent.

## VIII. Communication Plan During Incidents

- In-app maintenance banner (or Vercel maintenance page) during downtime so proprietors see why they can't log in rather than a generic error.
- Direct WhatsApp/email to pilot-school proprietors during SEV1/SEV2.
- Update every 30 minutes during active incident; communicate resolution and impact honestly.
- Do not hide data loss incidents — trust is preserved through transparency, not silence.

## IX. Recovery Documentation Location

- This document (`/docs/DISASTER_RECOVERY.md`) is the canonical source for the *strategy* and must be
  kept current. It now carries a status block so no reader mistakes intent for implementation.
- Executable procedures live in **`docs/ops/`**, which exists: `RESTORE_TO_CLEAN_DATABASE.md`,
  `INCIDENT_SEVERITY.md`, `BREACH_NOTIFICATION.md`, `SUPPORT_OPERATOR_MODEL.md`,
  `DEPLOYMENT_RECORD.md`.
- **`docs/ops/emergency_contacts.md` does not exist.** Naming people for recovery and escalation is
  a founder decision (H9-F4); inventing a contact list here would be worse than an absent one.
