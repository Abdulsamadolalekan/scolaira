# Public Surface Operational Hardening (H-5) — Closeout

**Scope:** making the R3-enforced public payment surface *operable*: safe rotation of
leaked payment-link credentials, an actionable exposure report, a lifecycle for the
append-only replay cache, and durable, secret-free detection of abuse and refusals.
**Migration:** `lib/db/migrations/0047_h5_operational_hardening.sql` (47th).
**Suites:** `tests/db/h5-operational-hardening.test.ts` (18 tests),
`tests/db/h5-independent-reaudit.test.ts` (10 tests),
`app/(app)/invoices/[id]/invoice-actions.test.tsx` (3 unit tests),
`e2e/h5-operational-surface.spec.ts` (4 E2E tests).
**Status:** complete, verified on a fresh database, on an in-place 46 → 47 upgrade,
and through the typecheck / lint / build / Playwright gates.
**Not a feature milestone, and not M12.** Historical migrations 0000–0046, M10 and
M11 are untouched; frozen tags were not moved.

---

## 1. Why this milestone was selected

R3 (`H-3`) closed the *risks* on the public surface: amount binding, per-link
submission bounds, the replay cache, credential-free storage, and owner-only write
policies. What R3 left behind were **operational** problems, i.e. things an operator
would have to do after R3 landed and could not:

1. a leaked URL could only be **revoked** — killing the link, its binding and any
   usefulness it still had — because there was no way to retire one bearer secret
   and issue another;
2. the exposure report was a **platform-wide count** (`auth_public_stale_token_exposure()`),
   so a school could not see *which* of its links was exposed or what to do;
3. the replay cache was append-only with **no lifecycle** — it could only grow;
4. refusals (rate limit, backlog bound, key reuse, amount mismatch) were returned to
   the payer and then **forgotten**; nothing was durable and nothing was observable;
5. there was no operator surface at all — no CLI, no report, no safe way to suspend
   the frozen RLS posture for a bounded maintenance action.

## 2. Findings, classified

| # | Finding | Class | Closed by |
|---|---|---|---|
| O1 | A leaked link's token could not be rotated; revocation was the only remedy and it destroys the link | Operational / availability of remediation | §4.1 rotation provenance + `POST /api/payment-links/[token]/rotate` |
| O2 | Exposure was reported as global counts only; no tenant-scoped, actionable answer existed | Operability / incident response | §4.1 `auth_public_link_exposure()` + `GET /api/payment-links/exposure` |
| O3 | The replay cache had no report and no prune; retention was unmanageable and unauditable | Retention / unbounded growth | §4.1 cache report + prune, `scripts/public-surface-ops.ts prune` |
| O4 | Rate-limit (`429`) and backlog (`53400`) refusals left no durable, queryable evidence | Detection / observability | §4.1 `public_surface_events` + recorder + `GET /api/payment-links/signals` |
| O5 | No operator surface, and no way to suspend the frozen RLS posture for a bounded maintenance action | Operability / tooling | §4.1 `auth_ops_suspend_rls/restore`, `auth_public_remediation_report()`, ops CLI |

None of these was a new exploit. Each was a control that could not be *operated*,
which is why several of them were recorded as residual limitations in the R3 closeout.

## 3. Measured pre-fix evidence (PROVEN)

Measured on a purpose-built **46-state** database (migrations 0000–0046 only), as the
owner role, on the real schema:

```
-- [O1] rotation surface
payment_links rotation columns (token_fingerprint|token_rotation_count|token_rotated_at): 0
functions with "rotate" in the name:                                                     0
-- [O2] exposure scope
tenant-scoped exposure function (auth_public_link_exposure):                             0
global exposure function (auth_public_stale_token_exposure):                             1
-- [O3] replay cache lifecycle
cache lifecycle functions (report | prune):                                              0
-- [O4] durable abuse / rate-limit telemetry
public_surface_events table:                                                             0
auth_record_public_surface_event():                                                      0
audit rows recording a rate-limit or backlog refusal:                                    0
-- [O5] operator surface
ops functions (suspend | restore | remediation report):                                   0
```

The 46-state database was built by the upgrade harness described in §9, which is also
where two genuine migration defects were found and fixed (§8).

## 4. Remediation

### 4.1 Database (`0047_h5_operational_hardening.sql`) — PROVEN

**Rotation (`O1`).** `payment_links` gains `token_fingerprint` (`^[0-9a-f]{16}$`,
backfilled from `app_meta.tenant_ctx_secret`), `token_rotation_count` (CHECK `>= 0`,
CHECK `count = 0 OR rotated_at IS NOT NULL`) and `token_rotated_at`. A `BEFORE
INSERT OR UPDATE OF token` trigger maintains the fingerprint, and
`trg_payment_link_token_rotation_guard()` refuses any token change that does not
carry the provenance of a rotation. Rotation is therefore *not* something application
code could forget: the database enforces it, including for the owner.

**Exposure (`O2`).** `auth_public_link_exposure()` answers, for the calling tenant:
which link, its status, how many stored payment rows and audit rows still contain the
token, when the exposure started and last occurred, and the recommended action
(`ROTATE` while the link is ACTIVE). It joins nothing outside the tenant and is
read-only; `auth_public_stale_token_exposure()` remains the platform-wide view.
`auth_public_remediation_report()` is the owner-only, cross-tenant version used by the
CLI — deliberately not executable by the runtime role, and it does not join
`organizations` (which is itself FORCE-RLS and invisible to the owner without a
suspended posture).

**Replay-cache lifecycle (`O3`).** `auth_public_submission_cache_report()` returns the
inventory (total / live pending / settled / pruneable / oldest). `auth_public_submission_cache_prune(interval, limit, apply)`
is dry-run by default, bounded by `limit`, refuses to touch a live `PENDING`
reservation, and never deletes a reservation whose payment row is missing
(the composite FK makes an orphan structurally impossible — see §10, RA3).

**Detection (`O4`).** `public_surface_events` (owner-only, append-only, no UPDATE or
DELETE policy) plus `auth_record_public_surface_event(kind, link_id, detail)`:
the runtime may write, only the owner may read. The detail validator accepts a
**flat scalar JSON object of at most 8 keys** and refuses anything else with `22023`,
so a credential, a reference, a phone number or an amount cannot be smuggled into
telemetry. A submission's refusals are recorded through the scope's own SQL handle
(`signalWith`) so a failed signal can never abort a payment. `auth_public_surface_events(interval, limit)`
is the tenant-scoped reader.

**Operations (`O5`).** `auth_ops_suspend_rls(tables)` / `auth_ops_restore_rls(tables)`
are owner-only, whitelist the five operational tables, **verify the posture before
suspending** (refusing to operate on a table whose RLS is not enabled *and* forced),
and must be paired inside one transaction. They exist so owner-side maintenance is a
bounded, auditable action rather than an ad-hoc `ALTER TABLE`.

**Recorder neutralization.** `auth_record_public_surface_event` was hardened so the
caller's ambient identity cannot influence the write: the token-lookup policy on
`payment_links` requires `_app_current_org_uuid() IS NULL` in public context, so the
recorder resets identity before resolving a link. This was found by RA-series probing,
not by inspection.

### 4.2 Application — PROVEN

| Surface | Authorization | Notes |
|---|---|---|
| `POST /api/payment-links/[token]/rotate` | `payment_link.rotate` (**OWNER only**) | CSRF, tenant-scoped read of the link, `404` for unknown/other-tenant tokens (no oracle), `400` for non-ACTIVE, audit `before/after` on `rotationCount`, best-effort telemetry (`{rotationCount, reasonRecorded}`), response returns the **new** token only |
| `GET /api/payment-links/exposure` | `payment_link.read` | tenant-scoped, secret-free, carries operator guidance |
| `GET /api/payment-links/signals?since=&limit=` | `payment_link.read` | interval is matched, mapped and clamped server-side (`interval '24 hours'`), never interpolated from raw text |
| `scripts/public-surface-ops.ts` (`report` / `signals` / `prune`) | migration credential only | not an HTTP surface; `report --json`; exit `0` clean, `2` critical, `3` misconfiguration |
| Invoice action bar rotate control | affordance only | `canRotate` is derived from `checkPermission('payment_link.rotate')`; the route remains the authority |

Operator guidance is deliberate: the confirm step states that the old URL stops
working and that a new one must be sent, because rotation is a credential change.

### 4.3 Auditability — PROVEN

`payment_link.rotate` and `payment_link.revoke` audit rows record identifiers, the
rotation count and the operator's reason. **No bearer credential is written to the
audit trail or to telemetry** — asserted by reading both back in RA10, including the
case where the operator pastes the leaked URL into the reason field.

## 5. Tests added (adversarial by construction)

**Contract suite (`h5-operational-hardening.test.ts`, 18 tests)** — A: rotation
preserves identity and retires only the old token; the invariant is enforced by the
database; an inactive link cannot be rotated and rotation does not clear a backlog;
rotation is a durable signal. B: the exposure report is actionable and secret-free,
tenant-scoped, with the platform report owner-only. C: prune is dry-run by default,
bounded and safe; replay still works for a live reservation; pruning is auditable.
D: every terminal outcome leaves a classified signal; the recorder enforces its caller
matrix and cannot store secrets; the log is append-only and abuse cannot exceed the
internal cap. E: rotation is owner-only, the read routes require authorization and are
tenant-scoped, and the runtime role cannot reach the operational surface at all.
**F (added in this closeout): the lifecycle end-to-end** — a link is viewed and paid,
rotated, paid again, revoked, and refused afterwards, with the ledger, identity,
fingerprint, audit rows, signals and exposure report asserted at every step; and a dead
token cannot be resurrected by the cache or by replaying its original idempotency key,
before or after a prune.

**Independent re-audit (`h5-independent-reaudit.test.ts`, 10 tests)** — RA1 rotation
repeatedly retires only the credential; RA2 the fingerprint equals the audit trail's
fingerprint and is not a credential; RA3 retention cannot reach the live window, an
orphaned reservation (structurally impossible: `23503` on
`public_submission_keys__payment_id__org_fkey`) or bad input; RA4 no tenant session
and no runtime privilege can run the operational controls; RA5 signals cannot be
forged, cannot enumerate and cannot carry data; RA6 a broken recorder cannot fail a
payment, change its status, or alter the response body; RA7 rotation is refused to
every non-owner role and to every other tenant; RA8 the frozen RLS / append-only
posture survives every operational action; **RA9** the lifecycle cannot be steered
across tenants and a retired credential stays retired (including repeat rotation);
**RA10** telemetry cannot be used to smuggle a leaked credential back into
operational view.

**Unit (`invoice-actions.test.tsx`, 3 tests)** — the rotate affordance is not offered
without `canRotate`; the consequence is stated before confirming and the POST carries
the link's token, the CSRF header and the optional reason; a refusal is surfaced and
never rendered as a success.

**E2E (`h5-operational-surface.spec.ts`, 4 tests)** — over real HTTP with no session:
rotation cannot be performed anonymously and the response does not echo the token;
the exposure report and the signal feed are not anonymously readable; the CLI is not
an HTTP surface (the script path and `/ops` fall through to sign-in, `/api/ops` is a
JSON `401`).

## 6. Verification results (PROVEN)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit` | clean |
| Lint | `npx next lint` | no errors; pre-existing warnings only (unrelated files) |
| Build | `npm run build` | exit 0, compiled successfully, 106 routes incl. the three new ones |
| Unit + integration | `npx vitest run` | **42 files / 497 tests passed** |
| H-5 contract | `npx vitest run tests/db/h5-operational-hardening.test.ts` | **18 / 18** |
| H-5 re-audit | `npx vitest run tests/db/h5-independent-reaudit.test.ts` | **10 / 10** |
| E2E | `npx playwright test` | **36 / 36 passed** (chromium) |
| Fresh install | drop DB → `npx tsx scripts/migrate.ts` | `new=47 total=47`; `[R1] runtime privileges verified…`, `[H-5] fingerprinted 0 pre-existing payment link(s)`, `[H-5] public surface is operable…` |
| Upgrade | `bash /tmp/upgrade-verify.sh` (46-state + legacy rows → 47) | **PASS**, STEP1–STEP7 |
| Ops CLI | `report` / `signals` / `prune` | exit `0` clean, `2` with critical signals, `3` on unknown command / bad interval / missing 0047; `report --json` parses |

Upgrade harness detail (legacy data carried across the migration):

```
STEP4 ok: upgrade 46 -> 47 applied cleanly with the self-audit NOTICE
STEP5 post-upgrade: links=1 null_fp=0 wrong_fp=0 | provenance=true | remediation=ROTATE|1|1 cache=t posture=t
STEP6 rotation of a pre-existing link (rolled back): 1|true|true
STEP7 unguarded rotation: refused by trg_payment_link_token_rotation_guard
UPGRADE VERIFICATION: PASS
```

Alerting path (observability is only real if it can wake someone up): six
`submission_unknown_bearer` events make `scripts/public-surface-ops.ts signals --since 1h`
report `CRITICAL submission_unknown_bearer … events=6` and exit `2`.

## 7. Posture evidence (PROVEN)

Measured after H-5 on the migrated database, as the owner:

```
rls+force-rls disabled on any of payment_links, payments, audit_events,
  public_submission_keys, public_surface_events:            none
scolaira_app privileges on public_submission_keys (SELECT|INSERT):  false | false
scolaira_app privileges on public_surface_events  (SELECT|INSERT):  false | false
scolaira_app UPDATE | DELETE on audit_events:                       false | false
app-callable auth_% functions:                                      24
rotation provenance columns present:                                3
H-5 lifecycle functions present:                                    8
policies on the operational tables:                                 4
```

Authorization boundaries (who can do what):

| Action | Runtime role | Any tenant member | Owner | Another tenant | Migration credential |
|---|---|---|---|---|---|
| Rotate a link's token | no | no | **yes** | no (404) | not an API |
| Read the exposure report (own tenant) | no | yes (`payment_link.read`) | yes | no | yes (global report) |
| Read the abuse-signal feed (own tenant) | no | yes (`payment_link.read`) | yes | no | yes (CLI) |
| Write telemetry | **yes** (recorder only) | no | no | no | no |
| Read / prune the replay cache | no | no | no (function-gated) | no | **yes** (owner-only functions) |
| Suspend / restore the RLS posture | no | no | no | no | **yes** (bounded, in-transaction) |

## 8. Defects found and fixed during verification

1. **The 0047 fingerprint backfill could not run on a database that already had
   links.** `payment_links` is FORCE-RLS, so the owner's `UPDATE … SET
   token_fingerprint` matched zero rows and the following `SET NOT NULL` failed with
   `23502`. Fixed by running the backfill (and the three CHECK constraints) inside a
   bounded `DISABLE ROW LEVEL SECURITY` / `ENABLE … FORCE …` block that restores the
   posture in the same `DO` block, including on the error path. This is the defect
   that a fresh-install-only verification would have missed.
2. **The migration runner's post-grant revoke was unconditional.**
   `REVOKE ALL ON public_surface_events` raised `42P01` when the table did not yet
   exist (a 46-state database). Guarded with `to_regclass(...) IS NOT NULL` in both
   `scripts/migrate.ts` and `tests/global-setup-db.ts`, which must stay mirrored.
3. **`auth_ops_suspend_rls` surfaced a raw Postgres error** when the calling query
   already used the table (`cannot ALTER TABLE … because it is being used by active
   queries`), which made a composition limit look like infrastructure failure. It now
   refuses with an actionable message naming the table.

## 9. Operational procedures

**When a payment-link URL has leaked (the incident path).**

1. `GET /api/payment-links/exposure` (or the invoice screen) — identify the ACTIVE
   link and the number of stored rows still carrying its token.
2. Rotate: invoice action bar → *Rotate link* (OWNER), optionally recording the
   incident reason; or `POST /api/payment-links/{token}/rotate`.
   The response contains the **new** URL. Nothing else about the link changes.
3. Send the new URL to payers. The old URL is dead immediately, for everyone.
4. Verify: `scripts/public-surface-ops.ts signals --since 24h` should show
   `link_rotated`, and the exposure report should no longer recommend `ROTATE`.
5. Do **not** edit stored rows. History is append-only; the rotated token authorizes
   nothing, which is what actually removes the exposure.

**Routine exposure review.** `GET /api/payment-links/exposure` on a schedule (e.g.
weekly) and after any suspected incident. `recommendedAction: ROTATE` is the trigger.

**Abuse and refusal monitoring.** `scripts/public-surface-ops.ts signals --since 1h`
from cron/monitoring. Exit `2` means at least one critical signal (repeated forged
bearers, amount-mismatch attempts, backlog pressure). Exit `0` with `INFO` rows is
normal traffic. The feed is secret-free by construction, so it is safe to ship to a
log aggregator; it is still owner-credential-only.

**Replay-cache retention.** `scripts/public-surface-ops.ts prune` (dry run, the
default) reports candidates; `--apply --limit N --retention 90d` deletes settled
reservations older than the window. A live `PENDING` reservation is never pruned, so
an in-flight payer can always retry. The prune is recorded as a `cache_pruned` signal
and is idempotent under re-runs. Retention windows are clamped to 10 years; the
lookback for signals is clamped to 30 days.

**Bounded maintenance.** Any owner-side repair that must read FORCE-RLS tables uses
`auth_ops_suspend_rls([...])` … `auth_ops_restore_rls([...])` inside a single
transaction. The helper refuses to operate if the posture it is about to suspend is
not intact, and refuses to run when the calling statement already uses the table
(run it as a top-level statement).

**Credentials.** The CLI and all owner-side maintenance use `DATABASE_MIGRATION_URL`
(the owner role). The runtime continues to use the `scolaira_app` role, which has no
privilege on `public_submission_keys`, `public_surface_events` or `app_meta`.

## 10. Classifications

**PROVEN** — rotation retires only the credential and preserves link identity,
provenance and every payment already attributed; the rotation invariant is enforced by
the database (including for the owner); a rotated link can be rotated again; a revoked
link cannot be resurrected; exposure reporting is tenant-scoped, actionable and
secret-free; the platform report is owner-only; the cache lifecycle cannot delete a
live reservation, cannot create a duplicate payment, cannot reach an orphan (impossible
by FK) and cannot be aimed by bad input; refusals are durable, classified, secret-free
and observable with an actionable exit code; telemetry cannot fail a payment nor carry
a credential; no tenant member, other tenant or runtime-role connection can operate
any of the new surfaces; RLS/FORCE-RLS and the append-only posture survive every
operational action; fresh install and 46 → 47 upgrade both verified, the latter with
legacy rows (pre-R3-style exposure and a cache reservation) carried across.

**ASSUMED** — that operators will run the CLI from a controlled host with the owner
credential (the CLI is not an HTTP surface and has no session model of its own); that
the school's own exposure report is reviewed on a schedule rather than only after an
incident; that cron/monitoring is configured to act on exit code `2`.

**NOT-YET-VERIFIED** — behaviour under a cache of production size (the prune was
exercised on small fixtures and is bounded by `limit`, but no large-volume soak was
run); sustained-abuse behaviour of the telemetry cap (the cap is asserted, not load
tested); the `LIKE`-based exposure scan's cost on a large `payments.notes` /
`audit_events.metadata` corpus; integration with a real monitoring/alerting stack
(exit codes and severities are implemented; the paging integration is an operations
task); an upgrade from a *production* 46-state copy (verified on a purpose-built
46-state database with seeded legacy rows, not on live tenant data).

## 11. Residual risks and limitations

1. **Rotation does not erase history.** A token that leaked into a third party's
   possession remains in *their* records forever; rotation removes its *authority*.
   This is intentional and is why the fix is operational rather than a data rewrite.
2. **Detection is retrospective.** The signal feed shows what happened; it does not
   block. Blocking controls remain the existing R3 rate limit and backlog bound.
3. **One credential, one operator.** Rotation is OWNER-only by design — a finance
   officer's compromise cannot silently retire a credential the school is using —
   which means a sole-owner school has a single point of failure for incident
   response.
4. **Telemetry is capped**, so a sustained attacker can crowd out older signal rows
   for the same link and kind; the cap prevents unbounded growth at the cost of
   retention depth.
5. **The CLI is a privileged local tool.** It is not exposed over HTTP (proven), but
   it inherits the security of its host and the owner credential.

## 12. Exit criteria

- [x] Every control from the R3 closeout's residual list is now operable, with a
      documented procedure.
- [x] Rotation/revocation lifecycle verified end-to-end, including the ledger.
- [x] Independent re-audit (10 adversarial tests) green; no control weakened to pass.
- [x] Full regression suite, typecheck, lint, production build, Playwright/E2E green.
- [x] Fresh install **and** 46 → 47 upgrade verified, the latter with legacy data.
- [x] No historical migration, M10/M11 tag or frozen invariant modified.

## 13. Recommended next milestone

From the remaining register: **H-2** (next in the security queue), then **H-4**,
**H-6**, **H-8**, **H-9**, and **A5 (FORCE-RLS coverage audit)**. H-5 deliberately
did not start any of these, did not add a twelfth milestone, and did not touch the
frozen M10/M11 history.
