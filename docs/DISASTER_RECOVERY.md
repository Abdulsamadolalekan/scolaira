# SCOLAIRA — Backup & Disaster Recovery

> A backup that has never been restored is an assumption, not a recovery strategy.

---

## I. Objectives

| Metric | Pilot target | Mature target |
|---|---|---|
| **RPO** (Recovery Point Objective — max data loss) | ≤ 1 hour | ≤ 5 minutes |
| **RTO** (Recovery Time Objective — time to restore service) | ≤ 4 hours | ≤ 1 hour |

## II. Backup Strategy

### A. Automated Backups (Supabase)
- **Daily logical backups** (built-in Supabase).
- **Point-in-Time Recovery (PITR)** enabled on production from day one (Supabase Pro). Allows restore to any second in the retention window (7 days pilot; extend to 30 days post-pilot).
- Retention of daily backups: 30 days.

### B. Off-site Backups
- Weekly logical backup (pg_dump) exported and encrypted to a separate cloud storage (e.g., S3-compatible storage in a different region/account) via a scheduled job (GitHub Action or Supabase Edge Function with minimal privilege).
- On-demand ad-hoc backup before any destructive migration.

### C. Source Code & Configuration
- All code, migrations, tests, docs in GitHub private repo (remote backup per §47).
- Infrastructure-as-code (Vercel + Supabase config) captured in repo as we grow; for pilot, documented env var schema in this doc is sufficient.
- Env var list (not values) versioned in repo; values stored in Vercel + Supabase secret stores and copied to founder-owned password manager as a final fallback.

## III. What Gets Backed Up

| Asset | Primary backup | Off-site backup | Frequency |
|---|---|---|---|
| Postgres database (all financial data, users, audit) | Supabase PITR + daily backup | Weekly encrypted pg_dump to independent storage | Continuous (PITR), daily, weekly |
| Supabase Storage (receipts, CSV imports, logos) | Supabase built-in | Sync to secondary bucket weekly | daily |
| Application code | GitHub | GitHub (remote, separate from sandbox) | on every push |
| Environment variables | Vercel + Supabase | Encrypted offline copy in founder password manager | on change |
| DNS / domain | Domain registrar | Registrar handles; access credentials stored offline | n/a |

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

| Test | Frequency | Owner |
|---|---|---|
| Local restore from pg_dump to empty Postgres | Monthly (pilot), quarterly post-pilot | Engineering |
| PITR restore to staging clone | Quarterly | Engineering |
| Full disaster tabletop walkthrough | Bi-annually | Founder + Engineering |

Every test records: time taken, issues found, manual steps required, whether RPO/RTO met.
Findings drive fixes — if a restore takes 6 hours at pilot, that is a P1 issue to address before scaling.

## VI. Migration Safety

- Every migration is applied to staging first and the staging app exercised before production deploy.
- Destructive migrations (DROP TABLE/COLUMN) are multi-step and forbidden on pilot without founder approval.
- Each migration has a rollback plan; if not auto-reversible, a compensating migration is written and tested before the forward migration lands.

## VII. Backup Monitoring

- Supabase backup success/failure is visible on dashboard; alerts configured via email to engineering/founder.
- Weekly off-site backup job sends a success/failure notification (simple Slack/email/WhatsApp alert).
- Failed backups are P1; the next business day must be used to diagnose and remediate.

## VIII. Communication Plan During Incidents

- In-app maintenance banner (or Vercel maintenance page) during downtime so proprietors see why they can't log in rather than a generic error.
- Direct WhatsApp/email to pilot-school proprietors during SEV1/SEV2.
- Update every 30 minutes during active incident; communicate resolution and impact honestly.
- Do not hide data loss incidents — trust is preserved through transparency, not silence.

## IX. Recovery Documentation Location

- This document (`/docs/DISASTER_RECOVERY.md`) is the canonical source and must be kept current.
- Runbooks for specific restore scenarios live in `/docs/ops/` (added as we implement production infrastructure).
- Emergency contacts (founder, engineering, Supabase support, Paystack support) maintained in `/docs/ops/emergency_contacts.md` (created when infrastructure is provisioned).
