# SCOLAIRA — Database Design

> Database is designed from domain truth, not from screens.

- **Engine:** PostgreSQL 15+ (Supabase managed in production; local Postgres for development).
- **ORM:** Drizzle ORM with explicit SQL migrations.
- **Money:** `BIGINT` kobo everywhere (see `/docs/FINANCIAL_INVARIANTS.md`).
- **Timestamps:** `TIMESTAMPTZ`; stored UTC, displayed `Africa/Lagos`.
- **Tenant column:** Every tenant table has `organization_id UUID NOT NULL REFERENCES organizations(id)`.
- **RLS:** Enabled on all tenant tables; default-deny.
- **Indexes:** Explicitly declared below; add indexes for every foreign key + common query patterns (organization_id + status, organization_id + term_id, etc.).
- **Soft delete:** Financial records do not support soft delete; we use states (VOID/REVERSED/ARCHIVED/WITHDRAWN) and append-only history.

---

## I. Schema Overview (Entity List)

1. organizations
2. users
3. memberships (join: users ↔ organizations with role)
4. sessions (academic sessions, e.g. 2025/2026)
5. terms (belongs to session; First/Second/Third term)
6. classes (per organization; e.g. "JSS 2A")
7. students (per organization; status ACTIVE/ARCHIVED/WITHDRAWN)
8. guardians (contacts for a student)
9. student_class_enrollments (student-in-class per term, for term-over-term history)
10. fee_definitions (catalog, e.g. "Tuition", "Development Levy")
11. fee_assignments (fee_definition × class × term with amount_kobo and optional due_date)
12. invoices (per student per term; aggregate of invoice_lines)
13. invoice_lines (one line of a bill; points to fee_assignment)
14. payments (money received; method, amount, state, reference)
15. payment_allocations (payment → invoice, with amount_kobo)
16. receipts (issued per successful allocation or per payment confirmation)
17. reversals (reversals/refunds of payments or allocations)
18. payment_links (shareable signed links for obligations)
19. communication_events (SMS/WhatsApp/email/print, channel-agnostic log)
20. audit_events (append-only log of mutations)
21. idempotency_keys (deduplication for API calls and webhooks)
22. webhook_events (raw received webhook payloads for audit/replay)
23. subscriptions (commercial state per organization — phase-deferred but schema present)
24. onboarding_state (per-organization progress through setup wizard)

## II. Table Definitions (Key Tables)

> Types below are illustrative. Migrations are the source of truth; this document is the design reference.

### organizations
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| name | TEXT NOT NULL | |
| slug | TEXT UNIQUE | short name for URLs if needed |
| logo_url | TEXT | |
| address | TEXT | |
| phone | TEXT | |
| email | TEXT | |
| currency | CHAR(3) NOT NULL DEFAULT 'NGN' | Only NGN at launch |
| timezone | TEXT NOT NULL DEFAULT 'Africa/Lagos' | |
| plan | TEXT NOT NULL DEFAULT 'pilot' | subscription plan — D6 |
| status | org_status NOT NULL DEFAULT 'ACTIVE' | ACTIVE / SUSPENDED / CHURNED |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |
| updated_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |

### users
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | matches Supabase auth.user |
| email | TEXT UNIQUE NOT NULL | |
| first_name | TEXT | |
| last_name | TEXT | |
| phone | TEXT | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |
| last_login_at | TIMESTAMPTZ | |

### memberships
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK → organizations | |
| user_id | UUID FK → users | |
| role | role NOT NULL | OWNER / SCHOOL_ADMIN / FINANCE_OFFICER / STAFF / PLATFORM_ADMIN (platform only, not in school memberships) |
| status | membership_status NOT NULL DEFAULT 'ACTIVE' | ACTIVE / INVITED / DISABLED |
| invited_at | TIMESTAMPTZ | |
| joined_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |

**UNIQUE** `(organization_id, user_id)`.

### sessions
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK | |
| name | TEXT NOT NULL | e.g. "2025/2026" |
| starts_on | DATE NOT NULL | |
| ends_on | DATE | |
| is_current | BOOLEAN NOT NULL DEFAULT false | one org has at most one current session |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |

**UNIQUE** `(organization_id, name)`.
**INDEX** `(organization_id, is_current)`.

### terms
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK | |
| session_id | UUID FK → sessions | |
| name | TEXT NOT NULL | "First Term", "Second Term", "Third Term" |
| starts_on | DATE NOT NULL | |
| ends_on | DATE | |
| due_date | DATE | default due date for fees (can be overridden per fee_assignment) |
| is_current | BOOLEAN NOT NULL DEFAULT false | |
| billed | BOOLEAN NOT NULL DEFAULT false | becomes true after billing run |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |

**UNIQUE** `(organization_id, session_id, name)`.

### classes
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK | |
| name | TEXT NOT NULL | "JSS 2A" |
| arm | TEXT | optional section/arm |
| sort_order | INT | for UI ordering |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |

**UNIQUE** `(organization_id, name)`.

### students
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK | |
| student_code | TEXT | org-scoped admission/registration number |
| first_name | TEXT NOT NULL | |
| last_name | TEXT NOT NULL | |
| other_names | TEXT | |
| gender | gender | M/F/OTHER |
| date_of_birth | DATE | optional |
| current_class_id | UUID FK → classes (nullable) | current snapshot |
| status | student_status NOT NULL DEFAULT 'ACTIVE' | ACTIVE/ARCHIVED/WITHDRAWN |
| joined_on | DATE | |
| archived_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |
| updated_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |

**UNIQUE** `(organization_id, student_code)` where student_code not null.
**INDEX** `(organization_id, status)`, `(organization_id, current_class_id, status)`.

> Note: historical class membership lives in `student_class_enrollments` so that changing `current_class_id` does not erase history.

### guardians
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK | |
| student_id | UUID FK → students | |
| first_name | TEXT NOT NULL | |
| last_name | TEXT NOT NULL | |
| relationship | TEXT | "Father", "Mother", "Guardian", "Uncle", etc. |
| phone_primary | TEXT NOT NULL | required for communication |
| phone_secondary | TEXT | |
| email | TEXT | optional |
| is_primary_contact | BOOLEAN NOT NULL DEFAULT false | one primary per student |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |

**INDEX** `(student_id)`, `(organization_id, phone_primary)`.

### student_class_enrollments
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK | |
| student_id | UUID FK → students | |
| class_id | UUID FK → classes | |
| term_id | UUID FK → terms | |
| enrolled_on | DATE NOT NULL | |
| left_on | DATE | nullable |

**UNIQUE** `(student_id, term_id)` (a student is in one class per term).

### fee_definitions
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK | |
| name | TEXT NOT NULL | "Tuition" |
| code | TEXT | optional short code e.g. "TUIT" |
| description | TEXT | |
| is_active | BOOLEAN NOT NULL DEFAULT true | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |

**UNIQUE** `(organization_id, name)`.

### fee_assignments
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK | |
| fee_definition_id | UUID FK → fee_definitions | |
| class_id | UUID FK → classes (nullable; null = all classes) | |
| term_id | UUID FK → terms | |
| amount_kobo | BIGINT NOT NULL CHECK (amount_kobo >= 0) | |
| due_date | DATE | overrides term.due_date |
| is_required | BOOLEAN NOT NULL DEFAULT true | optional fees can be opted out |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |

**INDEX** `(organization_id, term_id, class_id)`.

### invoices
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK | |
| invoice_number | TEXT NOT NULL | org-scoped sequential e.g. "INV-2025-0001" |
| student_id | UUID FK → students | |
| term_id | UUID FK → terms | |
| issue_date | DATE NOT NULL | |
| due_date | DATE NOT NULL | |
| total_kobo | BIGINT NOT NULL CHECK (total_kobo >= 0) | equals sum of lines (enforced by trigger) |
| paid_kobo | BIGINT NOT NULL DEFAULT 0 | maintained by trigger/transaction; sum of non-reversed allocations |
| voided_at | TIMESTAMPTZ | |
| voided_reason | TEXT | |
| status | invoice_status NOT NULL DEFAULT 'DRAFT' | DRAFT/ISSUED/PARTIALLY_PAID/PAID/VOID |
| notes | TEXT | |
| created_by | UUID FK → users | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |
| updated_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |

**UNIQUE** `(organization_id, invoice_number)`.
**INDEXES:** `(organization_id, student_id, term_id, status)`, `(organization_id, status, due_date)`, `(organization_id, term_id)`.
**Note:** outstanding_kobo is computed as `total_kobo - paid_kobo` in views/services, not stored, to avoid drift.

### invoice_lines
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK | |
| invoice_id | UUID FK → invoices ON DELETE RESTRICT | |
| fee_assignment_id | UUID FK → fee_assignments (nullable, for ad-hoc lines) | |
| description | TEXT NOT NULL | |
| quantity | INT NOT NULL DEFAULT 1 | |
| unit_amount_kobo | BIGINT NOT NULL CHECK (unit_amount_kobo >= 0) | |
| amount_kobo | BIGINT NOT NULL CHECK (amount_kobo >= 0) | usually quantity * unit_amount_kobo; trigger enforces |
| line_type | TEXT NOT NULL DEFAULT 'FEE' | FEE / CREDIT / ADJUSTMENT |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |

### payments
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK | |
| payment_number | TEXT | org-scoped sequential e.g. "RCPT-2025-00123" |
| student_id | UUID FK → students (nullable, for unmatched payments) | |
| method | payment_method NOT NULL | CASH / BANK_TRANSFER / POS / ONLINE / OTHER |
| amount_kobo | BIGINT NOT NULL CHECK (amount_kobo > 0) | always positive; reversals are separate |
| paid_at | TIMESTAMPTZ NOT NULL | timestamp as recorded; for cash = time of entry; for online = webhook time |
| recorded_by | UUID FK → users (nullable for webhook-confirmed) | |
| external_reference | TEXT | Paystack reference / bank teller / POS transaction ID |
| bank_name | TEXT | for transfers |
| depositor_name | TEXT | for transfers; informational, not trusted as identity |
| notes | TEXT | |
| status | payment_status NOT NULL DEFAULT 'CONFIRMED' | PENDING / CONFIRMED / REVERSED / REFUNDED / FAILED / DUPLICATE_SUSPECT |
| provider | TEXT | 'paystack' / 'manual' / null |
| provider_event_id | TEXT | Paystack event id for traceability |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |
| updated_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |

**UNIQUE** `(organization_id, method, external_reference)` where external_reference is not null.
**INDEXES:** `(organization_id, student_id, status, paid_at)`, `(organization_id, status)`, `(provider, provider_event_id)`.

### payment_allocations
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK | |
| payment_id | UUID FK → payments ON DELETE RESTRICT | |
| invoice_id | UUID FK → invoices ON DELETE RESTRICT | |
| amount_kobo | BIGINT NOT NULL CHECK (amount_kobo > 0) | |
| allocated_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |
| allocated_by | UUID FK → users | |
| note | TEXT | |
| reversed_by_id | UUID FK → reversals (nullable) | link to reversal if undone |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |

**INDEXES:** `(payment_id)`, `(invoice_id)`, `(organization_id, invoice_id)`.
**Constraints enforced by trigger:** Σ allocations per payment ≤ payment.amount_kobo; Σ allocations per invoice ≤ invoice.total_kobo - invoice.paid_kobo (with locking).

### receipts
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK | |
| receipt_number | TEXT NOT NULL UNIQUE per org | |
| payment_id | UUID FK → payments | |
| student_id | UUID FK → students | |
| issued_to_name | TEXT | parent/guardian name if captured |
| amount_kobo | BIGINT NOT NULL | total receipt amount (matches total non-reversed allocation on payment at time of issue) |
| issued_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |
| issued_by | UUID FK → users | |
| channel | TEXT | 'PRINT' / 'EMAIL' / 'WHATSAPP' / 'SMS_LINK' |
| notes | TEXT | |
| voided_at | TIMESTAMPTZ | |

### reversals
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK | |
| payment_id | UUID FK → payments (nullable if allocation-only reversal) | |
| allocation_id | UUID FK → payment_allocations (nullable) | |
| amount_kobo | BIGINT NOT NULL CHECK (amount_kobo > 0) | |
| reason | TEXT NOT NULL | required field |
| reversed_by | UUID FK → users | |
| type | reversal_type NOT NULL | REVERSAL / REFUND / CORRECTION |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |

Reversals are append-only; once inserted cannot be updated/deleted by app role.

### payment_links
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK | |
| token | TEXT NOT NULL UNIQUE | 256-bit random, URL-safe |
| invoice_id | UUID FK → invoices (nullable) | |
| student_id | UUID FK → students | |
| amount_kobo | BIGINT | allow fixed amount; null = "pay outstanding" |
| expires_at | TIMESTAMPTZ NOT NULL | |
| status | link_status NOT NULL DEFAULT 'ACTIVE' | ACTIVE/PAID/EXPIRED/REVOKED |
| created_by | UUID FK → users | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |
| paid_at | TIMESTAMPTZ | |
| paid_payment_id | UUID FK → payments (nullable) | |

**INDEX** `(token)` (fast lookup), `(organization_id, status)`.

### communication_events
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK | |
| channel | comm_channel NOT NULL | SMS / WHATSAPP / EMAIL / PRINT / IN_APP |
| recipient_type | TEXT NOT NULL | GUARDIAN / STUDENT / STAFF |
| recipient_id | UUID | polymorphic FK depending on type |
| recipient_address | TEXT | phone/email/address |
| template_key | TEXT | e.g. "payment_reminder", "receipt" |
| subject | TEXT | for email |
| body | TEXT NOT NULL | plaintext |
| payment_id | UUID FK → payments (nullable) | |
| invoice_id | UUID FK → invoices (nullable) | |
| payment_link_id | UUID FK → payment_links (nullable) | |
| status | comm_status NOT NULL | PENDING / SENT / DELIVERED / FAILED |
| provider_message_id | TEXT | |
| error | TEXT | |
| sent_at | TIMESTAMPTZ | |
| created_by | UUID FK → users | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |

### audit_events
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK (nullable for platform-level events) | |
| actor_user_id | UUID FK → users (nullable) | |
| actor_type | TEXT NOT NULL | 'user' / 'system' / 'webhook' / 'platform_admin' |
| action | TEXT NOT NULL | e.g. 'payment.confirmed' |
| entity_type | TEXT NOT NULL | |
| entity_id | UUID | |
| before | JSONB | |
| after | JSONB | |
| reason | TEXT | |
| request_id | TEXT | |
| ip | INET | |
| user_agent | TEXT | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |

**Permissions:** app DB role has INSERT only; no UPDATE/DELETE.
**INDEXES:** `(organization_id, entity_type, entity_id, created_at DESC)`, `(actor_user_id)`, `(created_at DESC)`.

### idempotency_keys
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| organization_id | UUID FK (nullable for unauthenticated webhooks) | |
| scope | TEXT NOT NULL | 'api' / 'webhook' |
| key | TEXT NOT NULL | |
| request_hash | TEXT | hash of request body for collision detection |
| response_status | INT | |
| response_body | JSONB | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |
| expires_at | TIMESTAMPTZ NOT NULL | 24 hours for API, 30 days for webhooks |

**UNIQUE** `(scope, organization_id, key)`.

### webhook_events
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| provider | TEXT NOT NULL | 'paystack' |
| event_id | TEXT NOT NULL | |
| payload | JSONB NOT NULL | raw payload |
| signature_valid | BOOLEAN NOT NULL | |
| received_at | TIMESTAMPTZ NOT NULL DEFAULT now() | |
| processed_at | TIMESTAMPTZ | |
| status | TEXT NOT NULL | 'RECEIVED' / 'PROCESSED' / 'DUPLICATE' / 'REJECTED' / 'FLAGGED' |
| error | TEXT | |

**UNIQUE** `(provider, event_id)`.

## III. Financial Views / Reporting Derivations

Reports use SQL views or service-layer queries over the authoritative tables. Candidate views:

- `v_invoice_outstanding(invoice_id, outstanding_kobo, overdue_days, is_overdue)`
- `v_student_balance(student_id, term_id, current_outstanding_kobo, prior_outstanding_kobo, total_outstanding_kobo)`
- `v_org_totals(organization_id, term_id, billed_kobo, collected_kobo, outstanding_kobo, overdue_kobo, unreconciled_kobo)`

Materialized views may be added later for performance if needed, but must be refreshed transactionally and not serve stale-critical data.

## IV. Migrations

- All schema changes go through Drizzle migrations (`drizzle-kit generate` / `migrate`).
- Migrations are committed to `/apps/web/lib/db/migrations/`.
- Migrations are applied in CI before deploy; never run ad-hoc DDL in production.
- Destructive changes (column drop, table drop) require a multi-step migration:
  1. Make the new column/table available.
  2. Dual-write / backfill.
  3. Move readers to new shape.
  4. Stop writing old shape.
  5. Drop only after a release has passed without readers/writers.

## V. Development vs Production

- Development: local Postgres 15 (via Docker or native install). No SQLite.
- CI: ephemeral Postgres container for test runs.
- Production: Supabase managed Postgres with PITR enabled, automated backups, RLS on.
- Never use SQLite-specific features (no `AUTOINCREMENT`, no `STRICT` tables, no PRAGMA tricks).

## VI. Seeding for Development & Pilots

Seed scripts produce:
- A demo organization with realistic 150–800 student dataset (configurable).
- Multiple roles/users.
- A current session + three terms.
- Fee catalog and assignments.
- Invoices with realistic collection rate (~70%) across classes.
- Mix of payment methods including cash, transfers, POS, online, some partial, some overdue, some unreconciled.

Seeds do not run in production. There is a separate, controlled onboarding flow for real schools.
