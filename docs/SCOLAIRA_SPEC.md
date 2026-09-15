# SCOLAIRA — Product Specification

> **THE FINANCIAL OPERATING SYSTEM FOR NIGERIAN PRIVATE SCHOOLS**
> Brand promise: **EVERY TERM, FULLY FUNDED.**

---

## 1. Product Identity

| Field               | Value                                                        |
| ------------------- | ------------------------------------------------------------ |
| Name                | SCOLAIRA                                                     |
| Tagline             | The Financial Operating System for Nigerian Private Schools  |
| Core promise        | Every term, fully funded                                     |
| Primary customer    | Proprietor-owned Nigerian private schools (150–800 students) |
| Decision maker      | School proprietor / owner                                    |
| Operational users   | Owner, School Admin, Finance Officer, Authorized Staff       |
| Parent relationship | Transactional, no conventional account required              |

**Spelling is sacred:** S-C-O-L-A-I-R-A.
(Schola + Naira). Never SCOLARIA, SCOLAIR, SCOLIARA.

## 2. What SCOLAIRA Is NOT

SCOLAIRA is **not** primarily:

- A generic school management system
- A timetable or grading application
- A parent social network
- An AI chatbot product
- A payment gateway
- A generic accounting application

SCOLAIRA is a **deeply focused financial operating system for school fees**.

## 3. The Core Financial Chain (Product Heart)

```
SCHOOL
  → STUDENT
    → FEE OBLIGATION
      → INVOICE
        → PAYMENT
          → ALLOCATION
            → RECONCILIATION
              → OUTSTANDING BALANCE
                → COMMUNICATION
                  → REPORTING
                    → ACTION
                      → REPEAT
```

Every major product decision must strengthen this chain. No feature fragments it.

## 4. Product Flywheel

```
BILL → KNOW → COMMUNICATE → COLLECT → RECONCILE → ANALYZE → ACT → REPEAT
```

## 5. Payment-Method Agnosticism (NON-NEGOTIABLE)

SCOLAIRA never assumes every parent:

- Has a smartphone
- Understands payment links
- Uses online banking
- Wants to use a payment link
- Can pay digitally

Supported payment methods (at minimum):

- **Cash**
- **Bank transfer**
- **POS**
- **Paystack / online payment**
- **Other legitimate school-approved methods**

Payment links are **one collection channel**, not the product.

**The product's core value: ONE ACCURATE FINANCIAL RECORD OF EVERY NAIRA billed, collected, allocated, reconciled and outstanding.**

### Worked example

> Student owes ₦250,000. Parent pays ₦100,000 CASH. Finance officer records ₦100,000.
>
> SCOLAIRA must: record the payment, identify the student, preserve the payment method, update outstanding balance, allocate correctly, issue a receipt, preserve audit history, make the transaction visible in reports, and never require the parent to create an account.

This same truth must hold for: CASH, TRANSFER, POS, PAYSTACK, PARTIAL PAYMENTS, MULTIPLE PAYMENTS, MULTIPLE INVOICES, PREVIOUS BALANCES.

## 6. Monetary Representation

- **Internal:** Integer kobo (minor units). Never floating point.
- **External/API contract:** Naira string, e.g. `"150000.00"`. Never bare numbers.

No "sometimes naira, sometimes kobo." One contract. One meaning.

## 7. Command Center (Proprietor's Control Room)

Answers one question: **WHERE IS OUR MONEY?**

Core metrics:

1. Where are we now? (BILLED / COLLECTED / OUTSTANDING)
2. What changed?
3. What is at risk? (OVERDUE / UNRECONCILED / PREVIOUS-TERM EXPOSURE)
4. What requires action?
5. What should I do next? (COLLECTION RATE context)

No decorative charts. Every number supports a decision.

## 8. Financial Action Centre

Data → Insight → Priority → Action.

Surfaces:

- Overdue high-value accounts
- Unreconciled payments
- Duplicate-suspect payments
- Students carrying previous-term balances
- Classes with unusual collection performance
- Fee lines with weak recovery
- Recently missed payment commitments
- Accounts requiring follow-up

## 9. Collection Priority (Deterministic, Explainable)

**No fake "AI."** Priority is computed deterministically from:

- Amount outstanding
- Days overdue
- Previous-term debt
- Payment history
- Promised payment status
- Class exposure
- Invoice age

Every recommendation must explain its rationale:

> **HIGH PRIORITY** — ₦420,000 outstanding · 38 days overdue · ₦120,000 previous-term balance

## 10. Modules (School Edition)

1. Command Center
2. Students
3. Fee Catalog
4. Billing
5. Invoices
6. Payments
7. Receipts
8. Reconciliation
9. Communication
10. Reports
11. Terms / Sessions
12. Settings
13. Staff / Permissions
14. Audit History

No vanity sidebar items. Every module serves the financial OS.

## 11. Role Model

| Role                | Scope                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------- |
| **OWNER**           | Full organization control                                                                |
| **SCHOOL ADMIN**    | Operational administration (no ownership transfer or platform-level actions)             |
| **FINANCE OFFICER** | Payments, reconciliation, receipts, financial reporting, billing ops (as authorized)     |
| **STAFF**           | Only explicitly authorized capabilities                                                  |
| **PLATFORM ADMIN**  | Separate surface at `/admin` for schools, subscriptions, support, system health, metrics |

## 12. Parent Experience

The parent journey is **transactional and mobile-first**:

```
MESSAGE → VIEW BALANCE → UNDERSTAND ITEMIZATION → PAY OR KNOW HOW TO PAY → RECEIVE CONFIRMATION
```

No forced account creation. No complicated dashboards. No forced app download.

## 13. Long-Term Platform Layers

| Layer                   | Purpose                                            |
| ----------------------- | -------------------------------------------------- |
| SCOLAIRA SCHOOL         | Core fee & financial OS (build first)              |
| SCOLAIRA COLLECTIONS    | Collection workflows & channels                    |
| SCOLAIRA RECONCILIATION | Money matching & exception management              |
| SCOLAIRA INTELLIGENCE   | Financial visibility, trends, risk, prioritization |
| SCOLAIRA PAYMENTS       | Future payment infrastructure (do not build now)   |

## 14. Product Phasing

| Phase | Name                                | Goal                                            |
| ----- | ----------------------------------- | ----------------------------------------------- |
| 1     | Financial Truth                     | Correct ledger, invoices, payments, allocations |
| 2     | Payment Completeness                | All payment methods recorded, receipts issued   |
| 3     | Reconciliation                      | Flagship reconciliation workflow                |
| 4     | Command Center Intelligence         | Proprietor control room                         |
| 5     | Collection Priority                 | Deterministic prioritization                    |
| 6     | Financial Memory                    | Historical depth, term-over-term                |
| 7     | Communication / Workflow Refinement | SMS/WhatsApp/reminders                          |
| 8     | Parent Experience Refinement        | Mobile payment pages                            |
| 9     | Platform Scalability                | Multi-school operations                         |
| 10    | Financial Infrastructure            | Deeper payment rails                            |

**Do not jump to Phase 10 before Phase 1 is trustworthy.**

## 15. What NOT to Build

- Pointless AI chatbot
- Motivational quotes
- Gamification
- Decorative analytics
- Fake predictive intelligence
- Unnecessary social features
- Bloated academic management
- Meaningless notification centers
- Excessive profile customization
- Feature-count vanity

SCOLAIRA becomes known for doing **FEES** exceptionally well.

## 16. Three-Layer Experience

| User            | Primary question                                         |
| --------------- | -------------------------------------------------------- |
| Owner           | "What is happening with my money?"                       |
| Finance Officer | "What needs to be recorded, reconciled, or followed up?" |
| Staff           | "What am I authorized to do?"                            |
| Parent          | "How much do I owe and how can I pay?"                   |

Do not give every user the same interface.

---

_This document is the product source of truth. Terminology herein is canonical._
