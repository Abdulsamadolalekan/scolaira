# Deployment record — shape and template

> **No deployment record exists, for any environment**, because nothing has ever been deployed
> (H9-F7/H9-F8). This file defines what a record must contain so that the first real deployment
> produces evidence instead of a memory. CI is not a deployment record: it proves a commit built
> and served `/api/ready` **in CI**, which is local/rehearsal evidence, not production evidence.

**Audience:** whoever performs a deployment.
**Status:** template only — no instance has been filled in.

---

## 1. Why a record

The acquisition checklist asks for release evidence (`ADQ §F.3`) and the strongest evidence this
project currently has — hosted CI runs — **expires** (artifact retention is 7–14 days, H9-F17).
A committed record is the part that survives: it is inspectable from the repository alone, without
GitHub, and it states which commit is known to have been deployed where.

## 2. What a record must contain

| Field                     | Why it matters                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| Date and time (UTC)       | When the environment changed.                                                                      |
| Environment               | Which environment — `staging`, `production`, or a named preview.                                   |
| Commit SHA                | The exact code deployed. Must resolve in the repository.                                           |
| Migration state           | `applied` count and newest tag, **after** `npm run db:migrate` ran.                                |
| `/api/ready` response     | The actual payload from the deployed host, not a summary sentence.                                 |
| Operator                  | Who performed it (a person, accountable).                                                          |
| Rollback target           | The commit/schema state to return to, and whether it is compatible with the migrated schema.        |
| Post-deploy smoke result  | The 3–5 minute check from `docs/DEPLOYMENT.md` §VIII step 8, with its outcome.                      |
| Migrations applied        | `new=<n>` from the migration runner; `0` is a valid, useful answer.                                |
| Incidents / deviations    | Anything that did not go as written — including "nothing", stated explicitly.                       |

A record is **evidence**, so it must contain raw outputs (the JSON payload, the exit codes), not
adjectives.

## 3. Template

```markdown
### Deployment <YYYY-MM-DDThh:mmZ> — <environment>

- **Commit:** <sha>
- **Operator:** <name>
- **Migrations:** `npm run db:migrate` → `new=<n> total=<n>`; newest tag `<0050_...>`
- **Readiness (from the deployed host):**
  ```json
  {"status":"ready","probe":"readiness","checks":[ ... pasted verbatim ... ]}
  ```
- **Smoke:** login ✔ / invoice screen ✔ / test payment ✔ / receipt ✔ — or the failure, verbatim
- **Rollback target:** <previous commit sha> — schema compatible: yes/no
- **Deviations:** none, or what deviated and what was done about it
- **Restore verification:** `scripts/verify-restored-db.ts` → `VERIFIED` / `NOT VERIFIED` — for a
  restore event, not a routine deploy
```

## 4. Where records live

`docs/readiness/` alongside the milestone evidence, one entry per deployment, newest first. The
[evidence index](./../readiness/H9_EVIDENCE_INDEX.md) links them so a reader can find every record
from one page.

## 5. The first record will be produced by

The first deployment to a real environment — which cannot happen until a host is chosen
(H9-F5) and an environment exists (H9-F7). Until then this file is a promise, and it is labelled
as one.
