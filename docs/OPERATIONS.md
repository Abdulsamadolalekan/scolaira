# SCOLAIRA — Operations

> Run a lean operation. Behave like a founder spending personal money, but never skimp on things that protect money, security, or correctness.

---

## I. Environments

| Environment | Purpose | URL (preliminary) | Deploy trigger |
|---|---|---|---|
| `local` | Developer machine | `http://localhost:3000` | Manual |
| `preview` | PR review | Per-PR Vercel preview URL | Every PR push |
| `staging` | Pre-production validation | `staging.scolaira.app` (or Vercel auto) | Merge to `main` |
| `production` | Live schools | `app.scolaira.app` | Manual approval after staging smoke |

All environments run the same Next.js build. Environment-specific configuration via env vars.

## II. Observability Stack (Pilot)

| Need | Tool |
|---|---|
| Error tracking | Sentry (free/cheap tier) — server + client |
| Logs | Vercel build/runtime logs; Supabase logs; structured JSON logs from application |
| Metrics | Vercel Analytics + simple in-app counters for invariants/rate-limit hits; proper Prometheus/Grafana deferred to Phase 9 |
| Uptime checks | External (e.g., Better Uptime or UptimeRobot free tier) for `/api/health` and public `/pay/` page |
| Audit | In-app `audit_events` table (owned by SCOLAIRA; never deleted by app) |
| Webhook monitoring | In-app `webhook_events` table; alert on > N failures/hour |
| Backup monitoring | Supabase dashboard alerts; weekly manual check script |

## III. Health Check

`GET /api/health` returns:

```json
{
  "status": "ok" | "degraded" | "down",
  "version": "<git sha>",
  "timestamp": "ISO-8601",
  "checks": {
    "database": "ok" | "down",
    "auth": "ok" | "down",
    "paystack": "ok" | "degraded" | "unknown"
  }
}
```

Authenticated `GET /api/health/ready` (platform admin only) adds deeper checks (migration version, disk, queue depth).

## IV. Logging

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

Critical alerts (wake-up worthy):
- `/api/health` reports `down` for > 2 minutes.
- `FINANCIAL_INVARIANT_VIOLATION` error at any time.
- Database backup failure (daily check).
- Paystack webhook secret rotation mismatch (signature verification failure rate > 20% over 5 minutes).
- > 10x spike in 5xx errors.
- Detection of possible tenant-isolation breach (security event).

Warnings:
- Webhook failure rate > 5%.
- Email/SMS send failure rate > 10%.
- CSV import error rate > 50% (suggests user confusion or bug).
- Slow queries > 1s p95 (track once basic metrics added).

## VI. Support

Pilot model (Phase 1–2):
- Founder/engineering runs support directly via WhatsApp/phone.
- In-app support can begin as a simple `support@scolaira.app` mailto; full help center deferred.
- Every support incident is logged and reviewed weekly to identify product fixes.
- Support-impersonation (platform admin accessing a school) is audited (see `/docs/SECURITY.md` §XV).

## VII. On-Call

- Pilot: founder + engineering on shared on-call (informal).
- Post-pilot: formal on-call rotation; documented escalation.

## VIII. Rate Limits & Abuse

See `/docs/SECURITY.md` §VIII. Rate-limit violations are logged; sustained abuse triggers IP bans via Vercel edge rules or WAF.

## IX. Database Operations

- All schema changes via migrations in repo.
- No manual DDL in production.
- Long-running data fixes go through reviewed migration scripts or one-off scripts committed to `/ops/scripts/` with run logs.
- A production DB access session requires: an explicit reason, an entry in the platform audit log, and use of a read-only role by default.
- Prod DB is not accessible from developer IPs unless VPN/IP-allowlist is enabled via Supabase dashboard.

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
3. **Respond:** Fix forward if safe; otherwise roll back deploy (Vercel one-click) or restore from PITR for data corruption events.
4. **Communicate:** SEV1/2: in-app banner + direct WhatsApp/email to affected proprietors. Be honest about impact and resolution.
5. **Recover:** Verify fix with tests and post-deploy smoke; confirm invariants hold; monitor for 1 hour.
6. **Postmortem:** Written within 48 hours for SEV1/2. Includes: timeline, root cause, impact, action items, owner. No blame.

Detailed runbooks will be added as the system matures, starting from the pilot playbook.

## XII. Cost Discipline (Pilot)

Target pilot monthly spend: under ₦150,000 (≈ under $100 USD equivalent).

| Line | Expected cost (monthly) |
|---|---|
| Vercel Pro (or Free during pilot) | $0–$20 |
| Supabase Pro (production) | $25 |
| Sentry | $0–$26 |
| Email (Resend) | $0 (free tier enough for pilot) |
| SMS (Phase 7) | Usage-based, budget per term |
| Domain | ~$12/year |
| Uptime monitor | $0 |
| GitHub | Free for private repos |

Re-evaluate spend after first paying school. Never add a SaaS subscription without a trial + a clear need. Prefer building simple in-house functionality over buying a tool for a small feature.
