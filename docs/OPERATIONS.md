# SCOLAIRA — Operations

> Run a lean operation. Behave like a founder spending personal money, but never skimp on things that protect money, security, or correctness.
>
> **Read the status block first.** This document was written as a target operating model. Parts of it
> describe a system that does not exist yet; each of those is labelled below and in place.

---

## 0. What is true today (H-9 status, 2026-09-26)

| Area in this document                        | State today                                                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Environments (§I)                            | **None provisioned.** No preview, staging or production environment has ever existed; there is no deploy pipeline.           |
| Error tracking — Sentry (§II, §IV)           | **Absent.** `SENTRY_DSN` is parsed by `lib/security/env.ts` and never used; nothing is shipped to a vendor.                  |
| Logs (§II, §IV)                              | **Present.** Structured single-line JSON from the app (`lib/ops/log.ts`): `startup_configuration`, `readiness_failed`.        |
| Uptime checks (§II)                          | **Absent.** No external monitor exists.                                                                                      |
| Metrics (§II)                                | **Absent.** No analytics or counters wired.                                                                                  |
| Backup monitoring (§II, §VII of DR)          | **Absent — there is no backup to monitor** (H9-F1).                                                                          |
| Readiness contract (§III)                    | **Present and hosted-proven** (H-6): `/api/ready` three checks, `/api/health` liveness only.                                 |
| Alert delivery (§V)                          | **Absent.** A failing readiness probe writes one log line; no alert is delivered to anyone (H9-F10). Manual daily check.     |
| Support model (§VI)                          | **Present** as the H-8 platform plane — see `docs/ops/SUPPORT_OPERATOR_MODEL.md`.                                             |
| On-call (§VII)                               | **Informal only.** No rotation, no named recovery owner (H9-F4).                                                             |
| Incident runbooks (§XI)                      | **Present** — `docs/ops/INCIDENT_SEVERITY.md`, `docs/ops/BREACH_NOTIFICATION.md`, `docs/ops/RESTORE_TO_CLEAN_DATABASE.md`.     |
| Deploy/rollback paths named below            | **Intent.** Vercel instant rollback, maintenance mode and PITR do not exist here (H9-F7).                                     |

**Provider claim:** the stack table below names Sentry, Vercel and Supabase. Nothing in this
repository integrates or deploys to any of them (H9-F12). Treat every vendor name as a plan, and
check the table in §0 before relying on one.

---

## I. Environments

**Only one row of this table describes something that exists.**

| Environment  | Purpose                   | URL (intended)                          | Deploy trigger (intended)           | State                    |
| ------------ | ------------------------- | --------------------------------------- | ----------------------------------- | ------------------------ |
| `local`      | Developer machine         | `http://localhost:3000`                 | Manual                              | **Exists**               |
| `preview`    | PR review                 | Per-PR preview URL                      | Every PR push                       | **Not provisioned**      |
| `staging`    | Pre-production validation | `staging.scolaira.app` (intended)       | Merge to `main`                     | **Not provisioned**      |
| `production` | Live schools              | `app.scolaira.app` (intended)           | Manual approval after staging smoke | **Not provisioned**      |

There is **no deploy workflow**: `.github/workflows/ci.yml` runs quality and readiness jobs on a
disposable Postgres and stops there — it does not deploy anywhere, and no scheduled job exists.
Choosing a host is an open decision (H9-F5); the provisioning checklist lives in
`docs/DEPLOYMENT.md` §II.

All environments run the same Next.js build. Environment-specific configuration via env vars.

## II. Observability Stack (Pilot)

| Need               | Tool                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Error tracking     | Sentry (free/cheap tier) — server + client                                                                              |
| Logs               | Vercel build/runtime logs; Supabase logs; structured JSON logs from application                                         |
| Metrics            | Vercel Analytics + simple in-app counters for invariants/rate-limit hits; proper Prometheus/Grafana deferred to Phase 9 |
| Uptime checks      | External (e.g., Better Uptime or UptimeRobot free tier) for **`/api/ready`** (the deploy gate) and the public payment page. `/api/health` is liveness only and must NOT be used as a dependency check — measured in H-6: it answered `ok` with the database down. |
| Audit              | In-app `audit_events` table (owned by SCOLAIRA; never deleted by app)                                                   |
| Webhook monitoring | In-app `webhook_events` table; alert on > N failures/hour                                                               |
| Backup monitoring  | **Nothing.** No backup exists to monitor, and no dashboard or script exists (H9-F1)                                        |

## III. Health and Readiness (implemented contract, H-6)

Two probes with two different jobs. The contract is documented in full in
`docs/API_CONTRACTS.md` §II.V; this is the operator's view.

**Liveness — `GET /api/health`.** Always `200` while the process serves traffic.
It deliberately makes **no claim about the database, the schema or auth** — it
answers "is this process alive", which is what a restart probe should ask. The
`checks` block this endpoint used to advertise was removed in H-6: it reported
`{"database":"not_configured"}` inside a `200 {"status":"ok"}`, so a deployment
with no database, a half-applied schema and an unusable session secret all looked
healthy to anything watching it.

**Readiness — `GET /api/ready`.** `200` only when all three required
dependencies pass; `503 { "status": "unavailable", "checks": [...] }` otherwise,
with a machine-readable reason per failing check:

```bash
curl -s https://<host>/api/ready | jq .
# 200 → {"status":"ready","probe":"readiness",
#         "checks":[{"name":"database","status":"ok",...},
#                   {"name":"schema","status":"ok","detail":{"applied":50,"expected":50,"latest":"0050_member_invitations"}},
#                   {"name":"auth","status":"ok",...}]}
```

Diagnosis table:

| reason | what it means | first action |
| --- | --- | --- |
| `database_not_configured` | `DATABASE_URL` is unset in this deployment | fix the environment, redeploy |
| `database_unreachable` / `database_timeout` | the database cannot be reached inside the probe budget | check the database host, network rules and connection limits |
| `schema_behind` | the database has fewer migrations than this build requires | run `npm run db:migrate` (owner credential) before serving traffic |
| `schema_ahead` | the database has migrations this build does not know | you deployed app code older than the schema: roll forward, do not guess |
| `schema_version_mismatch` | the newest journal tag is not the tag this build expects | same as above; verify the migration folder is what you think it is |
| `schema_objects_missing` | a required table or function is absent | re-run migrations; if it persists, the database was restored from a partial dump |
| `schema_unverifiable` | the migration journal cannot be read at all | run the migrations or check the runtime role's schema grants |
| `auth_unconfigured` | `SCOLAIRA_SESSION_SECRET` is missing or shorter than 32 bytes | generate one with `openssl rand -base64 48` and redeploy |
| `auth_crypto_broken` | signing and verifying a session/CSRF token does not round-trip | the secret is corrupt or two deployments disagree on it; rotate |

Every non-ready result also emits exactly one single-line JSON event so a log
scraper can alert without parsing prose:

```json
{"ts":"2026-09-25T12:31:44.188Z","level":"error","event":"readiness_failed",
 "failed":"database:database_unreachable,schema:database_unreachable",
 "expectedMigrations":50,"environment":"production"}
```

Measured behaviour (H-6 evidence, `docs/readiness/H6_RELEASE_EVIDENCE_CLOSEOUT.md`):
with Postgres stopped, `/api/ready` returned `503 database_unreachable` **while
`/api/health` still returned `200`** and login returned `500` — i.e. the old gate
was green precisely when the product was unusable. On restart, `/api/ready`
returned to `200` with no process restart (no cached "ready").

## IV. Logging

> **What exists today (H-6):** structured single-line JSON events emitted by the
> application (`lib/ops/log.ts`): one `startup_configuration` line per boot
> (build, expected migration count/tag, whether the database and auth secret are
> configured) and one `readiness_failed` line per non-ready probe. **What does not exist yet:** the Sentry
> integration named in the stack table below — `SENTRY_DSN` is parsed by
> `lib/security/env.ts` and never used, so nothing is shipped anywhere. Treat the
> stdout JSON lines as the signal until the error-reporting work is scheduled (it
> is not part of H-6; see `docs/readiness/H6_RELEASE_EVIDENCE_CLOSEOUT.md`,
> residual items).


- Structured JSON logs with fields: `timestamp`, `level`, `request_id`, `user_id` (hashed if not necessary), `organization_id` (hashed), `action`, `duration_ms`, `error` (if any).
- **Never log:**
  - Passwords, session tokens, API keys, webhook secrets.
  - Full guardian phone numbers (last 4 digits ok for debugging).
  - Full payment card/account numbers.
  - Request bodies on auth endpoints.
  - Raw CSV upload contents (size and hash are ok).
- Log levels: `debug` (development only), `info`, `warn`, `error`, `fatal`.
- Request-id generated at edge and propagated through all logs for a single user action.

## V. Alerting

> **No alert is delivered anywhere today (H9-F10).** `readiness_failed` and
> `FINANCIAL_INVARIANT_VIOLATION` are written to the application log; there is no consumer, no
> e-mail, no SMS, no pager and no monitor watching that log. The list below is the **trigger
> list** — the conditions that would raise an alert once a delivery path exists.
>
> **Interim control (decided, H9-6):** a **manual daily check** of `/api/ready` and of the
> `readiness_failed` log event, owned by the founder/support, per
> `docs/ops/INCIDENT_SEVERITY.md` §Manual check. That is the whole of the detection story; it cannot
> catch a failure that starts and resolves between checks, and it depends on a person remembering.
> Wiring a real alert consumer is deliberately **not** claimed here and has not been done.

Critical alerts (wake-up worthy):

- `/api/ready` fails (`503`) for > 2 minutes, or a `readiness_failed` event appears in the logs.
- `FINANCIAL_INVARIANT_VIOLATION` error at any time.
- Database backup failure (daily check).
- Paystack webhook secret rotation mismatch (signature verification failure rate > 20% over 5 minutes).
- > 10x spike in 5xx errors.
- Detection of possible tenant-isolation breach (security event).

Warnings:

- Webhook failure rate > 5%.
- E-mail/SMS send failure rate > 10% — **cannot fire: no e-mail/SMS provider is integrated**
  (H9-F12/H9-F13); pending `communications` rows are queued and never sent.
- CSV import error rate > 50% (suggests user confusion or bug).
- Slow queries > 1s p95 (track once basic metrics added).

## VI. Support

Pilot model (Phase 1–2):

- Founder/engineering runs support directly via WhatsApp/phone.
- In-app support can begin as a simple `support@scolaira.app` mailto; full help center deferred.
- Every support incident is logged and reviewed weekly to identify product fixes.
- Support access by a platform administrator is a **read-only window**, entered and exited through an
  audited endpoint, and it is refused on an organization the administrator belongs to. The full model
  — identity, membership, what is logged, what is impossible — is in
  [`docs/ops/SUPPORT_OPERATOR_MODEL.md`](./ops/SUPPORT_OPERATOR_MODEL.md).

## VII. On-Call

- Pilot: founder + engineering on shared on-call (informal).
- Post-pilot: formal on-call rotation; documented escalation.

## VIII. Rate Limits & Abuse

See `/docs/SECURITY.md` §VIII. Rate-limit violations are logged; sustained abuse triggers IP bans via Vercel edge rules or WAF.

## IX. Database Operations

- All schema changes via migrations in the repository (`lib/db/migrations/`, applied with
  `npm run db:migrate` and the owner credential). New migrations are numbered after the current
  chain; **applied migrations are never edited**.
- No manual DDL in production.
- One-off scripts live in `scripts/` (there is no `/ops/scripts/` directory) and are reviewed and
  committed like anything else. Long-running data fixes go through reviewed scripts with run logs.
- A production database session requires an explicit reason, an audit entry, and the read-only path
  wherever read-only is enough.
- Verify a restored or newly provisioned database with the read-only ops command before it serves:
  `npx tsx --conditions=react-server scripts/verify-restored-db.ts --platform-admin <uuid|email>`
  (10 checks, exit non-zero on any failure; `NOT VERIFIED` if a check could not run). See
  `docs/ops/RESTORE_TO_CLEAN_DATABASE.md` §6.

## X. Secrets Management

- Dev: `.env.local` (git-ignored); `.env.example` committed with placeholders.
- Preview/Staging/Production: Vercel environment variables + Supabase dashboard secrets.
- Rotation: when a secret rotates, it is updated in the secret store first, then dependent services redeploy; old secret invalidated; rotation recorded in DECISIONS or runbook.
- No secrets in Slack, WhatsApp, email, or support tickets.

## XI. Incident Response (Summary)

1. **Identify:** Monitoring alerts, user report, or engineer observation.
2. **Severity:**
   - SEV1 — Financial integrity / security breach / total outage. Immediate response.
   - SEV2 — Major feature broken for multiple schools; no data corruption.
   - SEV3 — Minor bug, cosmetic issue, single-school issue.
3. **Respond:** Fix forward if safe; otherwise stop the process and deploy the previous commit.
   There is no one-click rollback and no PITR today (H9-F7/H9-F1) — for data corruption there is no
   automated recovery path at all, which is why the manual check in
   `docs/ops/INCIDENT_SEVERITY.md` matters more here than it should.
4. **Communicate:** SEV1/2: in-app banner + direct WhatsApp/email to affected proprietors. Be honest about impact and resolution.
5. **Recover:** Verify fix with tests and post-deploy smoke; confirm invariants hold; monitor for 1 hour.
6. **Postmortem:** Written within 48 hours for SEV1/2. Includes: timeline, root cause, impact, action items, owner. No blame.

Runbooks (H-9): [`INCIDENT_SEVERITY.md`](./ops/INCIDENT_SEVERITY.md),
[`BREACH_NOTIFICATION.md`](./ops/BREACH_NOTIFICATION.md),
[`RESTORE_TO_CLEAN_DATABASE.md`](./ops/RESTORE_TO_CLEAN_DATABASE.md),
[`SUPPORT_OPERATOR_MODEL.md`](./ops/SUPPORT_OPERATOR_MODEL.md).

## XII. Cost Discipline (Pilot)

Target pilot monthly spend: under ₦150,000 (≈ under $100 USD equivalent).

| Line                              | Expected cost (monthly)         |
| --------------------------------- | ------------------------------- |
| Vercel Pro (or Free during pilot) | $0–$20                          |
| Supabase Pro (production)         | $25                             |
| Sentry                            | $0–$26                          |
| Email (Resend)                    | $0 (free tier enough for pilot) |
| SMS (Phase 7)                     | Usage-based, budget per term    |
| Domain                            | ~$12/year                       |
| Uptime monitor                    | $0                              |
| GitHub                            | Free for private repos          |

Re-evaluate spend after first paying school. Never add a SaaS subscription without a trial + a clear need. Prefer building simple in-house functionality over buying a tool for a small feature.
