# Term & Session State Machines

Entities: `sessions`, `terms`

## Sessions (Academic Year, e.g., "2025/2026")

### Valid States
- `PLANNED` — session created, not current yet.
- `ACTIVE` — session in progress (the current academic year).
- `CLOSED` — session ended; archived for historical reference.

### Transitions
- Create → PLANNED.
- PLANNED → ACTIVE (OWNER/SCHOOL_ADMIN): "start session"; any previous ACTIVE session becomes CLOSED (only one current session per organization).
- ACTIVE → CLOSED (OWNER): "end session" — typically after all terms are finalized; can only close if all its terms are themselves closed.
- CLOSED is terminal (re-opening requires OWNER action; rare, audit with reason).

## Terms (First/Second/Third term within a session)

### Valid States
- `PLANNED` — set up but not billed.
- `ACTIVE` — current billing term; billing runs possible; parents receiving invoices.
- `BILLED` — billing has been executed (all students billed); invoices ISSUED.
- `CLOSED` — term financially closed; prior-term balances carried forward; no further mutations except corrections (reversals/refunds still possible with OWNER approval and audit).

### Transitions
- Create → PLANNED.
- PLANNED → ACTIVE (OWNER/SCHOOL_ADMIN): "set as current term."
- ACTIVE → BILLED (system/OWNER): after billing run executed for all students in the term; manually triggered to avoid surprise.
- BILLED → CLOSED (OWNER): "close term"; requires reconciliation completion check (unreconciled items flagged but not blocked if owner accepts carry-forward); carries forward outstanding balances as prior-term debt into next term.
- CLOSED → ACTIVE (OWNER only, rare): reopen a closed term; audit with reason; blocks any concurrently-active term.

## Database Changes

- ACTIVE → CLOSED: creates a term-closing record; creates prior-term balance records (effect is an attribute on outstanding invoices — they remain tied to their term; reporting separates prior vs current).
- "Carry forward" is a reporting concept, not a new invoice; outstanding invoices keep their original term_id and show up in prior-term-exposure on the Command Center.

## Audit Events
- `session.created`, `session.started`, `session.closed`, `session.reopened`
- `term.created`, `term.activated`, `term.billed`, `term.closed`, `term.reopened`

## Failure Behavior

- Closing a session with non-closed terms → 422 ("All terms must be closed before closing the session.").
- Closing a term with unreconciled payments → warning (not a hard block, but owner must confirm acknowledgement of unreconciled items).
- Activating a new term while another is ACTIVE → previous term moves from ACTIVE → BILLED automatically? Or explicit transition? RECOMMENDATION: require explicit close/activation; do not silently demote.
- Reopening a closed term → 409 if there's already an active term in the same session (must first set that one back or close it).
