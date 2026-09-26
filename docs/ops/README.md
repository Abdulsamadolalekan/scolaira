# SCOLAIRA — Operations Runbooks

> Every document in this folder states what is **true today**. Where a procedure
> depends on something that does not exist yet, the document says so in the step
> that needs it, instead of describing an imagined system.

---

## Status of the operational controls (H-9, 2026-09-26)

| Control                                     | State today                                                                                                                                              |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automated database backups                  | **Absent.** No host, no provider, no schedule, no backup has ever been taken (H9-F1).                                                                     |
| Point-in-time recovery                      | **Absent.** No host decision, so there is nothing to enable (H9-F5).                                                                                      |
| Off-site backup                             | **Absent.**                                                                                                                                                |
| Restore ever performed                      | **No.** No restore from a real backup has been performed; RPO/RTO are unmeasured (H9-F3).                                                                |
| Restore verification tooling                | **Present** — `scripts/verify-restored-db.ts` (read-only; 10 checks). Local evidence only; no production run has happened.                                 |
| Restore runbook                             | **Present** — `RESTORE_TO_CLEAN_DATABASE.md`. Rehearsed locally against a disposable database (see §Rehearsal).                                            |
| Named recovery owner                        | **Absent.** Nobody is named for backup verification, drill cadence or SEV1 recovery (H9-F4).                                                              |
| Alert delivery                              | **Absent.** No alert is delivered anywhere: `/api/ready` failing produces a log line and nothing else (H9-F10). See `INCIDENT_SEVERITY.md` §Manual check. |
| Incident runbook                            | **Present** — `INCIDENT_SEVERITY.md` (severity definitions + manual detection cadence).                                                                    |
| Breach-notification runbook                 | **Present** — `BREACH_NOTIFICATION.md` (internal 24-hour target; not legally reviewed).                                                                     |
| Support-operator model                      | **Present** — `SUPPORT_OPERATOR_MODEL.md` (describes the implemented H-8 support plane).                                                                   |
| Deployment record                           | **Absent for every environment** — nothing has ever been deployed. Shape defined in `DEPLOYMENT_RECORD.md` (H9-F8).                                        |
| Emergency contacts file                     | **Absent.** `DISASTER_RECOVERY.md` §IX refers to `docs/ops/emergency_contacts.md`; it does not exist, because naming people is a founder decision (H9-F4). |

---

## The documents

| Document                                                       | Use it when                                                                        |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [`RESTORE_TO_CLEAN_DATABASE.md`](./RESTORE_TO_CLEAN_DATABASE.md) | You must get data out of a dump and into a working database.                       |
| [`INCIDENT_SEVERITY.md`](./INCIDENT_SEVERITY.md)               | Something is wrong and you need to decide how wrong, and what to do first.          |
| [`BREACH_NOTIFICATION.md`](./BREACH_NOTIFICATION.md)           | Personal data may have been exposed. Start the clock immediately.                   |
| [`SUPPORT_OPERATOR_MODEL.md`](./SUPPORT_OPERATOR_MODEL.md)     | You are supporting a school and need to know what you may look at, and what is logged. |
| [`DEPLOYMENT_RECORD.md`](./DEPLOYMENT_RECORD.md)               | You are about to deploy to a real environment and must leave evidence behind.        |

---

## What this folder deliberately does not contain

- **No backup procedure.** Writing one would imply a backup exists (H9-F1). It does not. The
  mechanism is blocked on the host/provider decision (`DISASTER_RECOVERY.md` §II is intent, not
  implementation) and belongs to a later, separately authorised tranche.
- **No recovery-owner assignment.** Naming a person is a founder decision (H9-F4).
- **No production drill record.** No production backup exists to restore from (H9-F3).
- **No contact list.** See above; inventing names would be worse than an empty file.

## Related

- `docs/DISASTER_RECOVERY.md` — backup and recovery strategy, with its status block.
- `docs/OPERATIONS.md` — environments, readiness contract, alerting, incident response summary.
- `docs/DEPLOYMENT.md` — deploy checklist and rollback, with its status block.
