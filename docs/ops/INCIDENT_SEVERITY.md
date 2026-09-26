# Runbook — Incident severity and response

> **There is no automated alerting.** Nothing will page you: `/api/ready` failing writes one JSON
> line to the application log and stops there (H9-F10). Until an alert consumer is wired, incidents
> are found by a **manual check** (see §Manual check) or by a school telling you. This document does
> not pretend otherwise.

**Audience:** the founder and whoever is on support duty.
**Status:** severity definitions and first actions are authoritative; detection cadence is the
interim control.

---

## 1. Severity

| Severity | Definition                                                                                                       | Response                                                                                        |
| -------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **SEV1** | Financial integrity in doubt, a security/tenant-isolation breach, or the product is unusable for all schools.     | Drop everything. Start the post-incident log immediately.                                       |
| **SEV2** | A major capability is broken for one or more schools; no data corruption suspected.                              | Same-day attention; communicate with affected schools.                                           |
| **SEV3** | Minor bug, cosmetic issue, a single school's edge case.                                                          | Normal queue; batch into the next change.                                                        |

Worked SEV1 examples: a payment that does not reconcile; `/api/ready` returning `503` for more than
a few minutes; anyone seeing another school's data; a leaked secret; the platform admin plane
behaving differently than it does in tests.

## 2. First actions (SEV1)

1. **Write down the wall-clock time and what you saw.** All later decisions refer to this.
2. **Find out whether money is affected.** Open the affected organization as a platform
   administrator — read-only support mode (`SUPPORT_OPERATOR_MODEL.md`). Support mode can look; it
   cannot change anything.
3. **Do not "fix" financial rows by hand.** Corrections go through the product's reversal and
   re-record paths, so the audit trail stays intact. Direct `UPDATE`s on ledger totals are refused
   by triggers on purpose.
4. **Preserve evidence before repairing.** Copy the relevant `audit_events`, `webhook_events` and
   reconciliation rows out to a file first.
5. **Decide: fix forward, or stop the writes.** There is no maintenance-mode feature flag in this
   codebase; the honest lever today is to stop/restart the application process.
6. **Communicate.** Tell affected proprietors directly (WhatsApp/phone) what is happening, in plain
   language, within the first hour. Do not wait for a full diagnosis.
7. **Afterwards:** a written post-mortem within 48 hours — timeline, cause, impact, actions, owner.
   If personal data may be involved, switch to `BREACH_NOTIFICATION.md` immediately, in parallel.

## 3. Manual check (the interim alerting substitute)

Until an alert consumer exists, the following is run **once per business day** and is the only
thing standing between a silent failure and a discovered one:

```bash
curl -s https://<host>/api/ready | jq .
# Expect: 200 {"status":"ready", ...}
# Any 503 is an incident: the payload names the failed check and its reason.
```

Also scan the application log for the machine-readable failure event:

```bash
# every non-ready probe emits exactly one line
... | grep '"event":"readiness_failed"'
```

| Check                            | Cadence        | Owner              |
| -------------------------------- | -------------- | ------------------ |
| `/api/ready` returns `200`       | Daily (manual) | Founder / support  |
| `readiness_failed` in the log    | Daily (manual) | Founder / support  |
| Backup success                   | **Cannot be checked — no backup exists** (H9-F1) | — |

**What this does not do:** it cannot detect a failure that starts and resolves between checks, and
it depends on someone remembering. That is a known, recorded weakness (H9-F10), not a control.

## 4. Severity → who

| Situation                        | Who acts                                      |
| -------------------------------- | --------------------------------------------- |
| SEV1 financial or security       | Founder (decision) + engineering (execution)   |
| SEV1 outage                      | Whoever is on duty, escalating to the founder  |
| SEV2                             | Support duty                                   |
| Breach (actual or suspected)     | Founder immediately; see `BREACH_NOTIFICATION.md` |

There is **no named recovery owner and no formal on-call rotation** (H9-F4): during the pilot this
is the founder plus engineering, informally. That gap is recorded, not papered over.

## 5. Communication rules

- Update at least every 30 minutes during an active SEV1.
- State impact in money terms where money is involved ("the ₦45,000 payment logged by Mrs Adeyemi
  on Tuesday is recorded but not yet allocated"), not in system terms.
- Never announce a resolution before it is verified by the affected school or by a measurement
  (a passing readiness probe, a reconciled balance).
- Do not hide data loss. Trust is rebuilt by disclosure, not by silence.
