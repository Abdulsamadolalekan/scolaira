# M9 database preflight

**Executed:** 2026-09-21 (Africa/Lagos local date)
**Baseline:** migrations `0000` through `0020_term_billing.sql` only
**Database:** throwaway PostgreSQL database, owner-side inspection before applying `0021`
**Purpose:** verify that forward-only M9 constraints would not silently rewrite or reinterpret existing records.

## Results

All preflight counts were zero:

```text
duplicate_current_sessions|0
duplicate_current_terms|0
cross_tenant_terms|0
cross_tenant_enrollments|0
cross_tenant_guardians|0
cross_tenant_fee_assignments|0
invalid_enrollment_dates|0
future_enrollment_dates|0
active_inactive_enrollments|0
active_archived_class_enrollments|0
duplicate_issued_receipts|0
```

The preflight did not delete, merge, rewrite, or financially reinterpret any row. No duplicate issued receipt or other correction decision was exposed, so migration application proceeded on this throwaway database.

## Upgrade evidence from the same database

```text
[db] applying 0021_academic_roster_control.sql (22 statements)
[db] applying 0022_m9_tenant_guard_order.sql (5 statements)
[db] migrations applied. new=2 total=22
migrations|22
m9_session_index|1
m9_term_index|1
m9_receipt_index|1
scolaira_app|f|f|f|f|f
```

The final role columns are `rolsuper | rolinherit | rolcreaterole | rolcreatedb | rolbypassrls`, confirming the required runtime-role posture. The throwaway database was dropped after verification.

The fresh-database path was separately exercised by the M9 integration tests; it applied all 22 migrations in order, including the existing `0004` numbering gap.
