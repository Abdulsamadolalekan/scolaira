# Controlled pilot — deployment requirements and the owner's decisions

Prepared 2026-10-09 against the pushed baseline `fea875e` (branch `arena/h8-platform-support`).
**Nothing is deployed. No hosting account, domain or certificate has been created or changed for this
work, and none was needed.** This document states the minimum a first one-school pilot needs, and lists
the configuration decisions that are yours to make.

Every line is tagged:

- **[M]** measured in this environment today (a command was run; the output is quoted or archived);
- **[T]** proven by a test that exists in this repository and passed on this commit;
- **[A]** an assumption or a decision that still needs you or a real environment.

Environment used for the [M] measurements: Debian sandbox, Node v20.20.2, PostgreSQL 17, the
production build (`npm run build` → `next start`) served behind a TLS front end, database
`scolaira_pilot` (scratch, synthetic data only). Readiness returned
`{"applied":52,"expected":52,"latest":"0052_opening_balances"}`. [M]

---

## 1. Hosting

| Requirement                                                 | Why                                                                                                                                                                                            | Status                                                              |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| One persistent Node process running `next start`            | `next.config.ts` sets no `output: 'standalone'`, so this is a server-rendered app, not a static export; the deploy target needs `.next` **and** `node_modules`                                 | [M] config read; consequence for the host is [A] until you pick one |
| Node 20                                                     | CI pins `node-version: 20`; all evidence in this session was produced on v20.20.2                                                                                                              | [M] [T]                                                             |
| No `engines` field in `package.json`                        | Nothing stops a host from running a different major, where the session crypto or the driver could behave differently                                                                           | [M] gap — decision **D-1**                                          |
| ≥2 GB RAM with ≥2 GB swap, or ≥4 GB                         | Measured on a 2-core 2 GB runner: `next-server` sits near 1 GB RSS and the release gate caps it at `--max-old-space-size=768`; without swap an OOM kill lands mid-suite                        | [M]                                                                 |
| Process supervision + auto-restart                          | **No** `Dockerfile`, `Procfile`, `fly.toml`, `vercel.json`, `docker-compose.yml` or PM2 config exists in the repository — the deployment shape is not expressed in code at all                 | [M] gap — decision **D-2**                                          |
| Self-hosted fonts, no third-party requests from the browser | The `/login` response preloads `/_next/static/media/*.woff2`; `app/fonts.ts` uses `next/font` self-hosting. A pupil's browser talks only to your origin                                        | [M]                                                                 |
| Static asset caching                                        | `cache-control: private, no-cache, no-store` on pages is deliberate (financial data). Do not put an aggressive page cache in front of the app; caching `_next/static` (content-hashed) is safe | [M] header observed; the CDN choice is [A]                          |

## 2. Database

| Requirement                                                                | Why                                                                                                                                                                                                                                                                                                                                                        | Status                                               |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| PostgreSQL 17                                                              | CI image is `postgres:17`; the 52 migrations and all evidence were produced there. 15/16 are plausible but unproven                                                                                                                                                                                                                                        | [M] [T]; pinning is decision **D-3**                 |
| `pgcrypto` enabled **before** the first migration                          | Migrations never run `CREATE EXTENSION`; the restore rehearsal pre-creates it because it needs superuser. A managed provider usually exposes this as a flag                                                                                                                                                                                                | [M]                                                  |
| Three roles, exactly as `scripts/bootstrap-roles.sql` defines them         | `scolaira_owner` (DDL, `NOBYPASSRLS`), `scolaira_app` (`NOINHERIT NOBYPASSRLS`, runtime), `scolaira` (dev). Measured in `pg_roles`: app role `super=false bypassrls=false inherit=false`                                                                                                                                                                   | [M] [T]                                              |
| The provider must allow role membership + `SET ROLE` + per-database grants | `scolaira_app` gets privileges only through `ALTER DEFAULT PRIVILEGES FOR ROLE scolaira_owner`; some managed offerings rewrite ownership                                                                                                                                                                                                                   | [A] until the chosen provider is tested              |
| **No PgBouncer in transaction mode**                                       | `lib/db/index.ts` opens the pool with `prepare: true` (prepared-statement cache) and the tenant context is set with transaction-local `set_config('app.organization_id', …)` — transaction pooling swaps server connections between statements, which breaks cached statements. Use session mode, a proxy that preserves prepared statements, or no pooler | [M] code read; the behaviour on a real pooler is [A] |
| Pool size                                                                  | `SCOLAIRA_DB_POOL_MAX` defaults are per-instance; a one-school pilot is far below any interesting number                                                                                                                                                                                                                                                   | [M]                                                  |
| UTC on the server                                                          | Timestamps are stored/returned `+00`; `organizations.timezone` carries the school's zone                                                                                                                                                                                                                                                                   | [M]                                                  |
| Migrations run **before** the app version that expects them                | `lib/ops/readiness.ts` fails readiness on `applied != expected` (52 today), so a new build against an un-migrated database returns 503 instead of serving wrong data. That is the intended gate — do not "fix" a 503 by rolling the database back                                                                                                          | [M] [T]                                              |
| There is no down-migration                                                 | Rollback of schema = restore from backup. This is why §4 of the security note matters more than it looks                                                                                                                                                                                                                                                   | [M]                                                  |

## 3. Environment variables — what this build actually reads

[.env.example](../.env.example) is the contract; the table below is cross-checked against the code.

**Required to serve traffic**

| Variable                  | Notes                                                                                        | Proof   |
| ------------------------- | -------------------------------------------------------------------------------------------- | ------- |
| `DATABASE_URL`            | the `scolaira_app` role, never the owner                                                     | [M]     |
| `DATABASE_MIGRATION_URL`  | owner role; only needed by `npm run db:migrate`                                              | [M]     |
| `SCOLAIRA_SESSION_SECRET` | absent → readiness fails `auth_unconfigured`; a session round-trip is proved by `/api/ready` | [M] [T] |
| `NODE_ENV=production`     | flips cookie flags to `Secure`/`__Secure-`                                                   | [M] [T] |
| `NEXT_PUBLIC_APP_URL`     | the public origin; read in `app/layout.tsx` (metadata) and `lib/security/env.ts`             | [M]     |

**Optional / operational**

| Variable                           | Notes                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SCOLAIRA_SESSION_SECRET_PREVIOUS` | rotation window; consumer `lib/auth/config.ts` [M]                                                                                                                                                                                                                        |
| `TRUSTED_PROXY_HOPS`               | **set to `1` behind exactly one proxy.** The register/login rate limiters key on client address and ignore `X-Forwarded-For` unless this declares the hop count — left unset, every school shares one bucket and a pilot onboarding morning can lock everyone out [M] [T] |
| `SCOLAIRA_DB_POOL_MAX`             | pool sizing [M]                                                                                                                                                                                                                                                           |
| `SCOLAIRA_BUILD_COMMIT`            | appears in `/api/ready` and the startup log line. Today the running build reports `commit: "development"` — set this per release or you cannot tell which build is live [M]                                                                                               |
| `NEXT_PUBLIC_PAY_URL`              | read as `payUrl`; defaults to localhost [M]                                                                                                                                                                                                                               |

**Development only — must be unset in a deployed environment** [M]

- `SCOLAIRA_BOOTSTRAP=1` puts the request path on the migration credential (asserted against by a test).
- `SCOLAIRA_DEV_ECHO_RESET_TOKEN=1` echoes password-reset tokens in API responses. Gated on **both**
  this flag and a non-production `NODE_ENV`, so a mis-set `NODE_ENV` alone cannot leak tokens [T].

**Declared, read by nothing in this build** [M] — verified by reference search over `app/`, `lib/`,
`components/`: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY`, `PAYSTACK_SECRET_KEY`, `PAYSTACK_WEBHOOK_SECRET`, `RESEND_API_KEY`,
`FROM_EMAIL_ADDRESS`, `SENTRY_DSN`, `SENTRY_AUTH_TOKEN` → **zero consumers**. Do not buy an email or
error-reporting subscription for the pilot; nothing calls them. Do not assume Supabase is involved at
all: authentication is implemented in this repository (session cookie + CSRF, sessions in Postgres).

## 4. Domain and TLS

1. **TLS is not optional.** In a production build the session and CSRF cookies are marked `Secure`, so
   over plain HTTP nobody can stay signed in. Measured directly: the harness needs an HTTPS origin for
   the product's own login to work. [M] [T]
2. **HSTS is already sent**: `strict-transport-security: max-age=31536000; includeSubDomains` (no
   `preload`). With that header live, a certificate failure becomes a hard lockout for anyone who has
   visited before — get the certificate in place and tested before pointing the domain at the app, and
   keep the old origin serving until then. [M]
3. `includeSubDomains` without a wildcard certificate means every subdomain you later add must have
   TLS. Either get a wildcard certificate or ask me to narrow the header before the pilot. **D-4** [M]
4. The proxy must forward `Host`, `X-Forwarded-For` and `X-Forwarded-Proto` untouched. Next uses `Host`
   for absolute URLs; the limiter uses the forwarded address with `TRUSTED_PROXY_HOPS`. [M]
5. If the certificate is not publicly trusted (internal CA, self-signed staging), also set
   `SCOLAIRA_INTERNAL_ORIGIN=http://127.0.0.1:<port>` — otherwise each page's server-side self-fetch
   re-enters through TLS and dies with `DEPTH_ZERO_SELF_SIGNED_CERT`. This does not disable
   verification and does not skip authorisation; the route still enforces session, tenant, role and RLS. [M] [T]
6. CSP today is `script-src 'self' 'unsafe-inline' 'unsafe-eval'` (measured on a live response). It is
   a known, documented hardening item, not a pilot blocker for a single authenticated school; it becomes
   a real requirement the moment any third-party payment script is added. [M]

## 5. What has to exist for the pilot to be observable

| Need                    | Today                                                                                                                                                          | Status  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Liveness                | `GET /api/health` → `{status:"ok",probe:"liveness",readiness:"/api/ready"}`; it deliberately makes **no** claim about the database or auth                     | [M] [T] |
| Readiness / deploy gate | `GET /api/ready` → 4 checks: database, schema (migration count), auth crypto, and it 503s when any fails                                                       | [M] [T] |
| Alerting                | **Absent.** A failing readiness probe writes one log line; nobody is told (H9-F10). Decision **D-5**: which uptime service, at what interval, and who is paged | [M]     |
| Log retention           | Structured JSON to stdout; no drain configured. Without a drain, the audit value of the operational log is "whatever the terminal kept"                        | [M] [A] |
| Error reporting         | None wired (see the no-consumer table above)                                                                                                                   | [M]     |
| Backups                 | No mechanism exists. See `PILOT_SECURITY_AND_BACKUP.md` and the executed drill result                                                                          | [M]     |

## 6. Decisions that need the owner — none of these is mine to take

| #    | Decision                                                                                                                                                                                                                                                                                        | Recommended default for a one-school pilot                                                                                                                                                                               |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D-1  | Add `engines: { node: "20.x" }` to `package.json`?                                                                                                                                                                                                                                              | Yes — one line, prevents a host silently choosing another major                                                                                                                                                          |
| D-2  | Hosting shape: VM with systemd, or a PaaS? No deploy artifact exists in the repo either way                                                                                                                                                                                                     | Smallest thing you can operate: one VM, `systemd` unit, `nginx` TLS termination, Postgres on the same box **with off-box backups** — or managed Postgres and a VM for the app                                            |
| D-3  | PostgreSQL version/provider, and who enables `pgcrypto`                                                                                                                                                                                                                                         | Managed PG 17 with `pgcrypto` enabled by the provider                                                                                                                                                                    |
| D-4  | Keep `includeSubDomains` in HSTS before a wildcard certificate exists?                                                                                                                                                                                                                          | Keep the header, drop `includeSubDomains` until a wildcard is in place, or obtain the wildcard first                                                                                                                     |
| D-5  | Monitoring service, interval, and who is paged when `/api/ready` returns 503                                                                                                                                                                                                                    | 60s external check + email/SMS to you; no on-call rota for one school                                                                                                                                                    |
| D-6  | **Password reset has no delivery channel.** `POST /api/auth/reset-request` returns only `{ok:true}` in production and the token is echoed only when `NODE_ENV !== 'production'` **and** a dev flag is set; no email provider is wired; there is no admin "set a member's password" route either | Pilot rule: the school keeps each staff password in its own secure record and no one self-serves a reset. Decide now whether that is acceptable for the pilot or whether an email provider becomes a pre-pilot exception |
| D-7  | **Who becomes the platform administrator.** `users.is_platform_admin` has no in-app writer (measured: no INSERT/UPDATE anywhere in `app/` or `lib/`) — the first one is a SQL statement                                                                                                         | You, on a named address, recorded in the ops file; carry-in approval depends on it                                                                                                                                       |
| D-8  | Backups: provider snapshot vs `pg_dump`, retention, and a permanent `BYPASSRLS` backup role (H9-F25)                                                                                                                                                                                            | Nightly `pg_dump -Fc` to a second machine + provider snapshot; a dedicated backup role is worth adding once you choose the provider                                                                                      |
| D-9  | Real school data. The pilot puts pupils' names, dates of birth and guardians' phone numbers in a hosted database, in a chosen country                                                                                                                                                           | Confirm the storage location, the lawful basis and the retention period with the school **before** the first real record is imported                                                                                     |
| D-10 | Registration is limited to 5 attempts per hour per client address (measured `register:ip:*`, 1-hour window)                                                                                                                                                                                     | Acceptable for one school; if several onboard together, stagger them or raise the limit deliberately                                                                                                                     |

## 7. Minimum actions before any school is onboarded

1. You choose D-2 and D-3; I provision, then re-run readiness + the release gate against the deployed
   origin and attach the evidence.
2. Set `SCOLAIRA_BUILD_COMMIT` on every deploy, and `TRUSTED_PROXY_HOPS=1` behind the proxy.
3. Certificate valid for the exact origin, tested with a real sign-in from a phone on mobile data.
4. `pgcrypto` enabled, roles bootstrapped, 52 migrations applied, `/api/ready` green through the
   public hostname.
5. Backups configured **and** the restore drill re-run against the real instance (the procedure is in
   `docs/ops/RECOVERY_DRILL.md`; the local execution result is in the pilot security note).
6. D-6, D-7 and D-9 answered in writing.
7. Only then: one school, synthetic rehearsal first (already done — see the rehearsal report), real
   data second, with the daily checklist from `docs/PILOT_OPERATING_CHECKLIST.md`.
