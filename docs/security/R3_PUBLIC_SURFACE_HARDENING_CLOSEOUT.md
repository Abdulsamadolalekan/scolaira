# Public Surface Hardening (R3 / H-3) — Closeout

**Scope:** the product's only unauthenticated mutation — `POST /api/p/[token]/submit`
— and the public link page/API around it.
**Migration:** `lib/db/migrations/0046_r3_public_surface_hardening.sql` (46th).
**Suites:** `tests/db/r3-public-surface-hardening.test.ts` (29 tests),
`tests/db/r3-independent-reaudit.test.ts` (22 tests).
**Status:** complete, verified on a fresh database, on an in-place upgrade, and through the build/e2e gates.

---

## 1. Why this milestone was selected

R2 closed the *exceptional paths of authenticated money movement*. The public
payment-link surface was deliberately left for R3 because it is a different kind
of risk: an **unauthenticated, unowned, internet-facing write path** into the
ledger, authorized by nothing but a URL. The audit item H-3 covered the
authorization model (closed by R1/C-3); this milestone covers what that surface
is *allowed to do* — the amount it records, how many times it may be used, what
it stores, what it discloses, and whether the bearer can bypass it.

## 2. Findings, classified

| # | Finding | Class | Closed by |
|---|---|---|---|
| F1 | The payer's `amountKobo` claim was the recorded amount (underpayment recorded as truth) | Financial integrity | §4.1 amount binding |
| F2 | No submission idempotency: a retry was a 409 conflict or a second PENDING row | Correctness / queue pollution | §4.1 replay cache |
| F3 | No rate limiting on submissions | Abuse / DoS | §4.1 bounds + §4.2 platform budget |
| F4 | The raw bearer token was persisted in `payments.notes` and `audit_events.metadata` | Credential disclosure | §4.1 provenance + fingerprint, §4.3 audit rows |
| F5 | The link view over-disclosed (token echo, full surname, student id, invoice totals) | Privacy | §4.2 minimised payload |
| F6 | Database error text was echoed to the payer | Information disclosure | §4.2 stable error map |
| F7 | Public context could INSERT into `payments`/`audit_events` directly, bypassing everything | Authorization boundary | §4.1 owner-only policies |
| F8 | One link could accumulate unbounded PENDING rows | Operational integrity | §4.1 backlog bound |
| F9 | The audit trail for link *management* also stored the raw token | Credential disclosure | §4.3 |

## 3. Measured pre-fix evidence (PROVEN)

Measured against the pre-R3 tree (`0045`), runtime role `scolaira_app`, real
fixtures, committed rows:

| Probe | Result before R3 |
|---|---|
| P1 link fixed at 500 000 kobo, claim `amountKobo: 100` | **201**, `payments.amount_kobo = 100` |
| P2 same reference twice | 409 (R2's live-reference guard) — a *conflict*, never a replay |
| P3 eight distinct submissions | **eight 201s** |
| P4 inspect the stored rows | `notes` = `Submitted via payment link <RAW TOKEN>`; `audit_events.metadata.linkToken` = raw token (10 rows) |
| P5 `GET /api/p/<token>/view` | returned `token`, `studentLastName`, `studentId`, `totalKobo`, `paidKobo` |
| P6 whitespace-only payer name | 400 with the database's own message `submission payer name must not be empty` |
| P7 direct public-context `INSERT INTO payments` | **succeeded** (CASH PENDING row, no audit row, no amount binding, no idempotency, no bounds) — 0043's claim that public context had no direct write privilege was not true |
| P8 one link, ten submissions | **ten PENDING rows** accumulated |

P1, P3, P4, P5, P6, P7 and P8 were re-verified on the upgraded database used in
§6 (the token-bearing rows quoted there are those pre-R3 rows).

## 4. Remediation

### 4.1 Database (`0046_r3_public_surface_hardening.sql`) — PROVEN

1. **One authoritative amount rule** — `auth_public_amount_due(token)`: the
   link's fixed amount, else the linked invoice's outstanding balance, else
   NULL. Called by the entry point (which refuses anything that disagrees,
   `22023`) and by the link page, so the number shown and the number recorded
   cannot diverge. The caller's amount is a *claim*; the form sends none.
2. **Submission idempotency** — `public_submission_keys`: one row per accepted
   submission keyed on the SHA-256 of the client's `Idempotency-Key` **and** on
   the submission identity (link + bank reference). A retry returns the original
   `payment_id/payment_number/amount/status` with `replayed = true`; a key
   repurposed for a different submission is refused (`23000`). RLS is ENABLED +
   FORCED, policies are `TO scolaira_owner`, the runtime role holds **no**
   grant, and no UPDATE/DELETE policy exists — the cache is append-only even for
   its owner.
3. **Bounds** — per link: ≤ 5 PENDING (unreconciled) submissions and ≤ 10
   accepted submissions/hour, via the existing `auth_rate_limit_hit` counter;
   both raise `53400` → HTTP 429. Stripe-style retry semantics are preserved:
   no window is consumed by a refused attempt, so a failed submission can be
   retried.
4. **Provenance without secrets** — nullable `payments.link_id` with the
   organization-composite FK `payments__link_id__org_fkey`
   (R1/C-2 pattern), `notes = 'Submitted via payment link ' || link_id`,
   audit metadata `{channel, linkId, linkFingerprint, invoiceId}` where the
   fingerprint is a 16-hex HMAC-SHA256 of the token. The token is never stored.
5. **The direct write path is closed** — `payments_public_insert` (and the
   overlapping `payments_public_insert2` left by 0040) and
   `audit_events_public_insert` are narrowed to `TO scolaira_owner` and to
   exactly the shape the entry point writes; `payments_public_owner_link_count`
   is an owner-only, proof-gated, single-link SELECT policy used solely for the
   backlog count.
6. **Old signature removed, not overloaded** — `auth_public_submit_payment`
   (6-arg) is dropped, so a stale caller fails closed (`42883`) rather than
   reaching a path without the controls. The 7-arg signature returns
   `replayed`, and the key parameter has no default (a call without it does not
   resolve).

### 4.2 Application — PROVEN

* `app/api/p/[token]/submit/route.ts`: platform-wide budget (120/min + 900/h,
  consumed **before** the token is looked up, fail closed → 503 if the limiter
  errors), mandatory `Idempotency-Key` (400 otherwise), the 7-arg entry point,
  fresh `201` vs replay `200` + `Idempotent-Replayed: true`, and a stable
  non-disclosing error map (`22023`→409 `AMOUNT_MISMATCH`, `23000`→409
  `IDEMPOTENCY_KEY_REUSED`, `53400`→429, `23505`→409, `40001`→409,
  `23514`/`22P02`→400, everything else → 500 with details only in the server
  log).
* `app/api/p/[token]/view/route.ts`: payload is exactly
  `{amountDueKobo, expiresAt, note, organization:{name,phone},
  invoice:{invoiceNumber,studentFirstName,studentInitial}|null,
  student:{firstName,initial}|null}` — no token, no status, no full surname, no
  internal ids, no invoice totals.
* `app/p/[token]/page.tsx` + `submit-form.tsx`: render the minimised payload and
  attach a per-render idempotency key.

### 4.3 Audit rows for link management — PROVEN

`payment_link.create` and `payment_link.revoke` recorded the raw token as well.
Both now record the link id (and amount/expiry on creation); the suite's D1
scan asserts that **no** stored row anywhere contains the token.

## 5. Adversarial tests added (PROVEN)

`tests/db/r3-public-surface-hardening.test.ts` — the contract: amount binding
(A), idempotency/replay (B), bounds (C), token-free storage (D), minimised
disclosure (E), closed direct-write paths (F), cross-tenant/ledger
non-interference (G).

`tests/db/r3-independent-reaudit.test.ts` — written against the *contract*, not
the implementation, with its own harness and an attacker's framing: unknown /
revoked / malformed bearers (A), amount tampering at the boundary and by raw SQL
(B), replay and key-repurposing (C), owner-level probes on the replay cache
(readable only with a bearer proof, never rewritable) (D), bounds (E), direct
database attacks (F), ledger non-interference (G).

Probe sensitivity was demonstrated with mutations (temporarily re-introducing the
pre-R3 permissive policy / runtime grant made the corresponding probe fail, and
restoring it made it pass again):

```
M1 the F1 probe detects a permissive public INSERT policy      ✓ (ALLOWED when mutated)
M2 the D1 probe detects a runtime grant on the replay cache    ✓ (ALLOWED when mutated)
```

## 6. Verification results (PROVEN)

**Fresh database** — `tests/global-setup-db.ts`: `migrations applied. new=46 total=46`.

**Upgrade in place (45 → 46, the production runner, pre-R3 data present)**
Built a real 45-migration database, wrote two submissions **through the old
6-arg entry point** (one with a tampered amount), then applied `0046` with
`scripts/migrate.ts`:

```
[upgrade] pre-R3 schema: new=45 total=45
[upgrade] pre-R3 tampered submission: {"payment_number":"PMT-2026-000001","amount_kobo":"100","status":"PENDING"}
[upgrade] pre-R3 exposure: payments_with_token=1 audit_with_token=2
[db] applying 0046_r3_public_surface_hardening.sql (27 statements)
[db] migrations applied. new=1 total=46            (self-audit NOTICE emitted)
```

Then, on that upgraded database:

| Check | Result |
|---|---|
| old 6-arg signature gone | `to_regprocedure(...) = NULL`; a call fails `function ... does not exist` |
| historical rows untouched | still `amount_kobo` 100 / 300 000, token still in `notes`, `link_id` NULL |
| exposure report | `payments = 2`, `audit_events = 2` (owner-only) |
| tampered claim (100 vs 500 000) | `22023` refusal |
| submission with no claim | recorded 500 000 (the database decided) |
| replay (same key + reference) | same `payment_id`, `replayed = t`, no second row |
| invoice-balance link (no fixed amount) | derived 300 000 |
| revoked link | `28000` |
| new rows | `notes` = link UUID, `link_id` set, **no token** |
| runtime role, public context, direct `INSERT INTO payments` | `new row violates row-level security policy for table "payments"` (P7 closed in place) |
| runtime role, `public_submission_keys` | `permission denied for table` |
| runtime role, exposure report | `permission denied for function` |
| cross-organization link claim | `payments__link_id__org_fkey` violation (control: same-org insert succeeds) |
| app end-to-end on the upgraded DB (6 checks) | view minimised; submit 201 → replay 200 + header; tamper 409 `AMOUNT_MISMATCH` with no DB text; balance link 300 000; revoked ≡ unknown; cache unreachable — **6/6** |

Round-trip check: a database created by applying the *final* `0046` reproduces
the validated function bodies, policies and constraints **byte-identically**
(`diff` of `pg_get_functiondef` / `pg_policies` / `pg_constraint` dumps).

**Gates**

| Gate | Result |
|---|---|
| `npx vitest run` (unit + integration) | **39 files / 465 tests passed** (pre-R3 baseline: 31 / 279) |
| R3 suites | 51 / 51 |
| pinned suites (`r1-public-context`, `r1-independent-reaudit`, `m6-hardening`) | pass (see §7 for the two intentionally strengthened assertions) |
| `npx tsc --noEmit` | clean |
| `npm run lint` | pass (2 pre-existing warnings in `lib/reconciliation`) |
| `npm run build` | success — 48/48 static pages |
| `npx playwright test` | **32 / 32** (run against the dev database migrated by the production runner) |

## 7. Intentional test-expectation changes

Two pinned R1 assertions encoded the pre-R3 behaviour and were **strengthened**,
not deleted:

1. `r1-public-context` — "public context has no direct write privilege":
   previously asserted that a bare INSERT *succeeded* and only `RETURNING` was
   refused. It now asserts both are refused (R3 closes the write path; the
   `RETURNING` restriction was a symptom of the same permissive policy).
2. `r1-independent-reaudit` — "the public audit trail may only be written for
   the link's own organization": previously asserted public context *could*
   write an audit row for its own tenant. It now asserts public context cannot
   write the audit trail at all; the entry point writes it as the owner from the
   context it derived from the bearer.

`m6-hardening`'s view assertions were updated to the minimised payload (it
already asserted the token/status/totals were absent; it no longer expects the
full surname to be present). Call sites of the entry point in the R1 suites now
pass the idempotency key and the authoritative amount.

## 8. Financial non-interference (PROVEN)

The suites assert that after all of the above: no invoice's `paid_kobo` moved,
no allocation was created, no receipt exists for a PENDING payment, no PENDING
payment carries an unallocated balance, every accepted submission produced
exactly one payment + one audit row + one reservation, and the reconciliation /
collections control planes were never touched. `public_submission_keys` is not a
ledger and is not consulted for balances.

## 9. Residual limitations (honest)

1. **Historical exposure is not rewritten.** Pre-R3 rows still contain the raw
   token in `payments.notes` / `audit_events.metadata`. Both tables are
   append-only financial/audit history, so the remedy is operational: revoke or
   rotate the affected links. `auth_public_stale_token_exposure()` (owner-only,
   not executable by the runtime role) reports the exact scope.
2. **The link token remains a bearer credential in the URL.** R3 narrows what it
   authorizes (one link, one link-scoped amount, bounded submissions,
   owner-only ledger writes) but cannot make a URL non-secret: link-shortener
   and browser-history exposure remain. Rotate a link whenever the URL leaks.
3. **Per-link windows are transactional, the platform budget is not.** A
   submission refused by the amount/backlog checks rolls back its rate-limit
   hit (deliberate: retries stay possible); sustained abuse across many links is
   bounded by the route-level budget instead.
4. **The replay cache grows with accepted submissions.** Append-only by design
   (that is what stops a rewrite of an outcome); it has no retention policy yet.
   At the observed volumes this is negligible; a retention job would have to
   preserve the last outcome per (link, key) to stay correct.
5. **A replay is served for the lifetime of the link.** If the bursar rejects or
   reverses the original payment, the replay still reports the original PENDING
   outcome — the payer's evidence of what they submitted, not the current
   ledger state. The page therefore says "we received your submission", never
   "paid".
6. **Enforcement depends on deployment.** The 10/hour and backlog bounds are in
   the database (cannot be bypassed); the 120/min+900/h platform budget is
   application-level, so a horizontally scaled deployment shares it through the
   same `rate_limits` table but a *misconfigured* deployment could service the
   route without it. A WAF/edge limit is still recommended as defence in depth.
7. **`amountKobo` remains accepted as an optional claim** (for API clients that
   already know the amount). It is compared, never trusted; sending it is never
   required.

## 10. Deployed surface changed

| Object | Change |
|---|---|
| `auth_public_submit_payment` | **replaced** — 6-arg dropped, 7-arg (key + `replayed`) installed |
| `auth_public_amount_due(text)` | new (runtime-executable) |
| `auth_public_stale_token_exposure()` | new (owner-only) |
| `public_submission_keys` | new table (RLS forced, owner-only, append-only by policy) |
| `payments.link_id` + `payments__link_id__org_fkey` + `payments_org_link_status_idx` | new |
| `payment_links_org_id_uidx` | new (composite-FK parent) |
| `payments_public_insert`, `payments_public_insert2`, `audit_events_public_insert` | dropped/recreated owner-only |
| `payments_public_owner_link_count` | new (owner-only, proof-gated, single link) |
| `POST /api/p/[token]/submit` | mandatory `Idempotency-Key`; 201/200 replay; new error map; platform budget |
| `GET /api/p/[token]/view` | minimised payload |
| `scripts/migrate.ts`, `tests/global-setup-db.ts` | also revoke the replay cache from the runtime role after the broad bootstrap grant |

**Rollback:** the migration is forward-only (the 6-arg function is dropped), and
the pre-46 application code is not compatible with the 46 schema (it calls the
dropped signature). Rollback therefore requires redeploying the pre-R3
application **and** restoring the pre-46 schema, i.e. a `pg_dump`-based restore —
the same policy as the previous milestones. There is no in-place downgrade path,
by design: a callable pre-R3 entry point is precisely the risk this migration
removes.

## 11. Exit criteria

| Criterion | Status |
|---|---|
| Amount recorded is never the caller's claim unless it equals the authoritative amount | met (§4.1.1, §6) |
| A retry is a replay, never a duplicate | met (§4.1.2, §6) |
| Submissions are bounded per link and platform-wide | met (§4.1.3, §4.2, §6) |
| The bearer token is not persisted by any new write | met (§4.1.4, §4.3, §6) |
| Public responses disclose only what a payer needs | met (§4.2) |
| Public context cannot write the ledger directly | met (§4.1.5, §6) |
| Historical exposure is visible to an operator and remediable | met (§9.1) |
| Ledger semantics unchanged; M10/M11 untouched | met (§8) |
| Fresh install, upgrade in place, build and e2e gates | met (§6) |
| Independent re-audit by a fresh suite, with probe-sensitivity mutations | met (§5) |

## 12. Recommended next milestone

The remaining audit register is H-2, H-4, H-5, H-6, H-8, H-9 and the A5
FORCE-RLS gap noted in the R2 report. On the evidence of this milestone the
strongest next candidate is **H-5 (operational/observability hardening around
the public surface)**: link-rotation tooling, the exposure-retention job and
alerting on `53400`/`429` rates, so the bounds added here are *operated* rather
than merely enforced.
