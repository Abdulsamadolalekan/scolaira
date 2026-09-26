# SCOLAIRA — Deployment

---

## I. Pre-Requisites

1. GitHub repository created (D2); all code pushed to `main`.
2. Vercel account created under company ownership (D3); linked to GitHub repo.
3. Supabase organization and project created under company ownership (D3); credentials stored.
4. Domain `scolaira.app` (or variant) secured (D4); DNS access.
5. Paystack account with test keys available (D5).
6. Resend (or Postmark) account for transactional email (D11).

## II. Environments Setup

### Local Development

- Install Node.js 20+.
- Run local Postgres (Docker command documented in `/apps/web/README.md` to be written at scaffolding time).
- Copy `.env.example` to `.env.local` and fill in local Supabase/Postgres values.
- `npm install` (or pnpm) → `npm run db:migrate` → `npm run db:seed` → `npm run dev`.

### Preview (PR)

- Automatic on Vercel for every PR.
- Uses Supabase staging project (shared) with isolated org data seeded per test.
- No production data; no Paystack live keys; uses Paystack test mode and Resend test mode.

### Staging

- Deployed automatically on merge to `main`.
- Uses Supabase staging project with semi-realistic data volume (seeded + pilot school test data before go-live).
- Connected to Paystack test mode.
- Runs full E2E suite post-deploy.

### Production

- Manual promotion from staging (Vercel "Promote to Production").
- Uses Supabase production project with PITR enabled.
- Connected to Paystack live keys only after explicit go-live.
- Custom domain `app.scolaira.app` with TLS.

## III. Database Migrations

- Generated with `npm run db:generate` after schema edits.
- Applied in CI:
  - On PR: migrations applied to an ephemeral test DB (dry-run for verification).
  - On merge to `main`: migrations applied to staging automatically.
  - On production deploy: migrations applied during build (Vercel pre-deploy hook) **only if** a migration exists; long migrations (data backfills) run as separate out-of-band jobs before promoting.
- Migrations that take locks on large tables must be written as online-safe migrations (create new column/table, backfill in batches, swap).

## IV. Environment Variables (Schema)

Required env vars (all environments):

| Name                        | Description                                                              |
| --------------------------- | ------------------------------------------------------------------------ |
| `NEXT_PUBLIC_APP_URL`       | Canonical app base URL (e.g. `https://app.scolaira.app`)                 |
| `NEXT_PUBLIC_PAY_URL`       | Parent payment base URL (e.g. `https://pay.scolaira.app` or same origin) |
| `DATABASE_URL`              | Postgres connection string (server-side only)                            |
| `SUPABASE_URL`              | Supabase project URL                                                     |
| `SUPABASE_ANON_KEY`         | Supabase anon public key (client-safe)                                   |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role (server-side only; never to client)                |
| `PAYSTACK_SECRET_KEY`       | Paystack secret key (server-side)                                        |
| `PAYSTACK_PUBLIC_KEY`       | Paystack public key (client-safe, for inline pay)                        |
| `PAYSTACK_WEBHOOK_SECRET`   | Paystack webhook signature secret                                        |
| `RESEND_API_KEY`            | Email provider API key (server-side)                                     |
| `FROM_EMAIL_ADDRESS`        | Transactional sender (e.g. `receipts@scolaira.app`)                      |
| `SESSION_SECRET`            | Secret for signing any additional cookies outside Supabase (if any)      |
| `SENTRY_DSN`                | (optional) Error reporting DSN — **parsed but not used**: no error-reporting integration exists yet; the operational signal today is the structured JSON log lines |
| `NODE_ENV`                  | `development` / `production` / `test`                                    |

`.env.example` is committed with placeholder values and comments.

## V. DNS & Domains (Recommended)

Awaiting D4 approval. Initial recommendation:

- `app.scolaira.app` — school console.
- `scolaira.app` — marketing site (deferred, can be simple landing).
- Parent payment pages served on the same app domain at `/pay/:token` (keeps infra simple for pilot; moves to `pay.scolaira.app` later if desired).
- Platform admin lives at `/admin` on `app.scolaira.app`, guarded by PLATFORM_ADMIN role (avoids separate subdomain + separate cookie scope complications for pilot).

## VI. SSL / TLS

- Vercel provisions certificates automatically.
- Supabase provisions TLS for DB connections.
- HSTS preload enabled once HTTPS-only is confirmed stable.

## VII. CDN / Edge

- Next.js on Vercel serves static assets via edge CDN automatically.
- No dynamic HTML caching for authenticated routes (private data).
- Parent payment pages (`/pay/:token`) can be edge-cached with careful `Cache-Control: private, no-store` because they are public but user-specific to the token.

## VIII. Deploy Process Checklist

Because app code and schema must move together, the deploy order is:
**migrate first, then serve, then confirm readiness.**

1. CI green on `main`. The pipeline provisions a real Postgres, runs the real
   migrations from zero, seeds a disposable database, starts the **production
   build** and requires `/api/ready` to pass before the release-gate suite runs
   (see `.github/workflows/ci.yml`).
2. Staging smoke tests pass (auth, record payment, reconcile, view Command Center).
3. Database migrations reviewed and confirmed reversible or low-risk. Readiness
   compares the database's migration count and newest tag against the values this
   build ships (`lib/ops/migration-manifest.ts`), so a build deployed against the
   wrong schema is reported, not guessed at.
4. Changelog updated for users (even if simple "we shipped improvements" note).
5. Founder (or delegated) approves promotion.
6. Apply migrations with the OWNER credential, not the runtime credential:

   ```bash
   DATABASE_MIGRATION_URL=postgres://scolaira_owner:...@host/db npm run db:migrate
   ```

   A fresh environment is provisioned the same way it always was — roles first,
   then databases, then migrations:

   ```bash
   sudo -u postgres psql -f scripts/bootstrap-roles.sql
   sudo -u postgres psql -d scolaira -v boot_db=1 -f scripts/bootstrap-roles.sql
   DATABASE_MIGRATION_URL=... npm run db:migrate     # 49 migrations, from zero
   ```

7. Deploy the app. **Serving traffic before readiness passes is a mistake the gate
   now catches**: until the schema matches the build, `/api/ready` answers `503`
   with `schema_behind`/`schema_ahead`/`schema_version_mismatch`, and the platform
   must keep the instance out of rotation.
8. Post-deploy smoke (3-5 min): `curl -s https://<host>/api/ready` is `200`
   `"status":"ready"` (this is the gate — `/api/health` is liveness only and says
   nothing about the database); login works; payment page loads; test payment
   (test mode against Paystack) processes.
9. Monitor logs/metrics for 30 minutes. The failure signal is a single-line JSON
   event (`"event":"readiness_failed"` with the failed checks and reasons); the
   Sentry integration in the stack table is **not wired yet** — `SENTRY_DSN` is
   parsed and unused, and nothing is shipped to a vendor.
10. Announce to pilot school if user-facing change.

## IX. Rollback

- Vercel instant rollback to previous deployment for app code.
- Database rollback: migrations are written to be reversible; if a migration is non-reversible, a follow-up revert migration must be prepared before deploy.
- For data-corruption incidents: Supabase PITR to nearest safe timestamp; replay auditable events that post-date the restore point.
- Never roll back the app without considering DB state; app version and DB schema must be compatible. Readiness enforces this at the door: a build rolled back in front of a newer schema reports `schema_ahead` and stays `503` until it is rolled forward again, and `/api/health` will happily report `ok` the whole time — trust `/api/ready`, not liveness.

## X. CI/CD Tooling

- **GitHub Actions** for CI (lint, test, build, e2e).
- Vercel Git integration handles deployments from GitHub.
- Branch protections on `main`: required PR review, required status checks, no direct pushes.
- Required status checks: lint, typecheck, unit tests, integration tests, financial matrix, Playwright smoke, build.

## XI. Branching & Commits

- Trunk-based development on `main`.
- Features on short-lived branches (≤ 3 days) with PRs.
- Commits follow Conventional Commits style: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`, `sec:`, `fin:` (for financial-critical changes).
- Every PR runs formatting/lint/test; squashed merge to `main`.
- At every milestone per the company-build directive:
  1. `git status` clean.
  2. Tests pass.
  3. Build succeeds.
  4. `git commit -m "..."` → `git push`.
  5. Verify remote state matches local.
  6. Record commit hash in milestone note.
