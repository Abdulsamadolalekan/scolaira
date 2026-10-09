# SCOLAIRA M11 Staging Verification

**Date:** 2026-09-22 (Africa/Lagos)  
**Result:** **PASS — all requested M11 staging gates passed**  
**Implementation/freeze target:** `cc0f6af378015aa6c4deba10a4e126ef9d8ff165`  
**Implementation SHA:** `a4d421c0062f7589bf1ebd7517ae8b6a328f3862`  
**M10 frozen target:** `5841f2e94ff4ee9a908ef6963662feca4a6ec37c`

This record covers the final isolated staging gate. It does not authorize or
contain M12 work. M5 through M10, including financial truth and the M10
reconciliation control plane, remained unchanged and frozen.

## 1. Controlled staging environment

A fresh PostgreSQL 17.11 database named `scolaira_m11_staging` was created
specifically for this gate. No production, development, or pre-existing tenant
data was used.

Two controlled non-production tenants were used only as bounded fixtures: one
primary staging tenant and one isolated tenant used to prove cross-tenant
rejection. The primary tenant contained the workflow and financial fixtures;
the second tenant contained only the minimum membership/student/reminder data
needed for tenant-boundary tests.

Migration/bootstrap operations used `scolaira_owner`. Runtime operations used
`scolaira_app`. The runtime role was never used to apply migrations, and
`scolaira_app` was not a member of `scolaira_owner`.

## 2. Migration and journal gate

| Check                                        | Result                                                |
| -------------------------------------------- | ----------------------------------------------------- |
| Fresh migration principal                    | `scolaira_owner`                                      |
| Fresh migration result                       | `new=37 total=37`                                     |
| Replay result on the seeded staging database | `new=0 total=37`                                      |
| Journal row count                            | `37`                                                  |
| Terminal journal row                         | `id=37`, tag `0037_m11_collections_control_plane`     |
| Forward-only/replay behavior                 | Passed; no prior migration was modified or re-applied |

The staging database was recreated and freshly migrated before the final seed.
The replay was run after seeding and returned `new=0 total=37` without changing
staging records.

## 3. Runtime role, RLS, grants, and immutable-history audit

Catalog verification passed for both M11 tables:

- `scolaira_app`: `NOSUPERUSER`, `NOINHERIT`, `NOCREATEROLE`, `NOCREATEDB`,
  `NOBYPASSRLS`; no membership in `scolaira_owner`.
- `collections_cases`: RLS enabled and FORCE RLS enabled, with one tenant
  isolation policy.
- `collections_case_events`: RLS enabled and FORCE RLS enabled, with one
  tenant isolation policy.
- Runtime table privileges: SELECT and INSERT allowed; table-level UPDATE and
  DELETE denied for both M11 tables.
- Runtime column privileges: workflow-column update allowed on cases;
  `student_id`, `organization_id`, and event-history update denied.
- `set_tenant_context(uuid, uuid)` executable by the runtime role;
  `set_tenant_context_for_system(uuid, uuid)` not executable by the runtime
  role.
- Ten M11 indexes present, including the partial unique index
  `m11_collections_open_student_unique_idx` and the case/event tenant indexes.
- Tenant, lifecycle, updated-at, actor/linkage, reminder-linkage, and
  append-only triggers present.
- The append-only function contains the `Collections case history is
append-only` guard; the lifecycle function contains the `Closed collections
cases are immutable` guard.
- M11 tables contain zero columns matching financial-shadow patterns such as
  `amount`, `balance`, `paid`, `outstanding`, `allocated`, `refund`, `receipt`,
  or `reversal`.

## 4. Controlled seed

The primary staging tenant was seeded only with bounded records required for
the gate:

- one partially allocated invoice: 100,000 kobo billed and 40,000 kobo paid;
- one fully allocated invoice: 80,000 kobo billed and 80,000 kobo paid;
- one outstanding workflow invoice: 50,000 kobo billed and unpaid;
- one confirmed 25,000-kobo unallocated payment linked to an M10 case and
  student candidate;
- one `PRINT` reminder recorded as `SENT` and one unsupported `SMS` reminder
  retained as `PENDING`;
- a closed historical collections episode and a current active episode for the
  account-context student; and
- a complete positive-workflow episode, followed by a later open episode for a
  second student.

Final runtime-visible primary-tenant counts were:

| Record                       |                           Count/result |
| ---------------------------- | -------------------------------------: |
| Collections cases            |                                      4 |
| Collections case events      |                                     13 |
| Reminders                    |        2 (`PRINT/SENT`, `SMS/PENDING`) |
| M10 reconciliation cases     |                                      1 |
| M10 candidates               |                                      1 |
| Invoices                     | 3 (`ISSUED`, `PARTIALLY_PAID`, `PAID`) |
| Payments                     |                                      3 |
| Payment allocations          |                                      2 |
| Collections case states      |                   2 `CLOSED`, 2 `OPEN` |
| Total payment amount         |                           145,000 kobo |
| Confirmed unallocated amount |                            25,000 kobo |

The runtime context resolved to `FINANCE_OFFICER` and
`auth_is_tenant_authorized() = true` for the primary fixture.

## 5. Positive workflow smoke

The staging workflow passed end to end through the collections repository and
runtime database principal:

1. Read the queue and case detail under an authenticated tenant context.
2. Verified the authoritative account projection for partially allocated,
   fully allocated, and confirmed-unallocated payment context.
3. Verified candidate-linked unallocated M10 context was visible on the
   student-level case detail.
4. Created a case for an outstanding student account.
5. Assigned the case to an active same-tenant finance member.
6. Added an action/history event.
7. Exercised `OPEN -> IN_PROGRESS -> ESCALATED -> RESOLVED -> CLOSED`.
8. Created a later open episode for the same student after closure.

The workflow produced the expected four-case/two-closed/two-open final shape.

## 6. Negative security and concurrency smoke

Every direct runtime rejection below occurred as expected:

| Attack/negative case                            | Result          |
| ----------------------------------------------- | --------------- |
| Forged organization context by a foreign member | Rejected        |
| Cross-tenant case read                          | Rejected/hidden |
| Cross-tenant case creation                      | Rejected        |
| Cross-tenant reminder linked to a case event    | Rejected        |
| Forged same-tenant event actor                  | Rejected        |
| Direct mutation of a closed case                | Rejected        |
| Direct update of append-only event history      | Rejected        |
| Direct delete of append-only event history      | Rejected        |
| Stale optimistic version assignment             | Rejected        |
| Duplicate active case for one student           | Rejected        |

The final full route/auth suites additionally passed the HTTP-boundary checks
for authenticated identity derivation, unauthorized `STAFF` access, CSRF,
organization-scoped idempotency replay, changed-payload/idempotency conflict,
safe duplicate-case conflict mapping, stale versions, and closed-case
behavior. No client-supplied organization or actor identity was treated as
authority.

## 7. Financial and M10 non-interference

A before/after snapshot of authoritative financial and M10 rows was taken
around the collections-only workflow. The snapshots were identical.

The following remained unchanged during the positive workflow:

- invoice totals, paid amounts, statuses, and outstanding semantics;
- payment amounts, statuses, and the 25,000-kobo unallocated amount;
- payment allocations;
- receipts, reversals, and other financial-boundary records; and
- M10 reconciliation case/candidate state and linkage.

No M11 table contains financial truth, and no M11 operation created or mutated
an invoice, payment, allocation, receipt, reversal/refund, or M10 decision.

## 8. Final verification suite

All final checks passed:

| Gate                        | Result                                                                   |
| --------------------------- | ------------------------------------------------------------------------ |
| Full Vitest                 | **31 files / 279 tests passed**                                          |
| Explicit M10 regression     | **11/11 passed**                                                         |
| M11 database focus          | **10/10 passed**                                                         |
| M11 route focus             | **5/5 passed**                                                           |
| M11 authorization focus     | **2/2 passed**                                                           |
| Playwright                  | **32/32 passed**                                                         |
| TypeScript                  | `tsc --noEmit` passed                                                    |
| Production build            | Passed; **48/48** pages generated                                        |
| Lint                        | Passed; existing non-fatal `any`/unused-variable warnings only           |
| Argon2                      | Native load plus hash/verify passed                                      |
| Targeted M11 Prettier check | Passed for M11-specific source, tests, and documents                     |
| `git diff --check`          | Passed                                                                   |
| M10 lineage                 | `m10-reconciliation-control-plane^{}` = `5841f2e...`                     |
| Frozen-path audit           | Migrations `0000`–`0036`, M9, M10, and financial-control paths unchanged |

The repository-wide lint output retains the previously documented non-fatal
legacy warnings. A broad changed-path Prettier run also reports warnings in
shared supporting files; no source normalization or unrelated formatting
changes were made during this gate. All M11-specific source, tests, migration
metadata, and documents checked for this gate passed targeted formatting.

## 9. Freeze/tag decision

All requested staging, security, tenant, workflow, financial-boundary,
non-interference, migration, and final verification gates passed. The
annotated freeze tag was then created, with the required exact peel:

```text
m11-collections-control-plane
-> cc0f6af378015aa6c4deba10a4e126ef9d8ff165
```

The tag is annotated (tag object type `tag`) and peels exactly to the final
closeout commit. No M12 work was started. M9, M10, and all frozen financial
paths remain untouched.
