# Runbook — Support operator model

> What a support operator is, what they may see, what is logged, and what they must never do.
> This documents behaviour that **exists in the code today** (H-8 platform plane + the frozen
> M4/M6 authorization layer). Where something is missing, it says so.

**Audience:** anyone acting as a platform administrator, and anyone granting that status.

---

## 1. What a platform administrator is

- A **normal `users` row** with `is_platform_admin = true`. There is no separate admin table, no
  separate login and no separate identity provider.
- Platform status is **checked in the database** on every request, not from a cookie:
  `auth_scope_platform_local()` refuses to mint a platform context unless the user id is a real
  platform administrator. A stolen or forged cookie grants nothing on its own.
- A platform administrator **does not need, and does not get, an organization membership**. This is
  deliberate: support staff must not appear as members of a school's team, and must not hold a role
  inside it.

### What a platform administrator cannot do

- **Cannot act as a member of a school.** There is no membership-less *tenant* session: platform
  identity is a platform-plane identity (read visibility across organizations), not a way to become
  a member of one. Anything that looks like "log in as the proprietor" does not exist (H9-F15 —
  and building it is out of scope for this milestone).
- **Cannot support their own tenant.** `assertNotOwnTenant` refuses support mode on an organization
  the administrator belongs to, so a conflict of interest is a hard error and not a policy note.
- **Cannot change money.** Support mode is a **read window**. It cannot post, allocate, reverse or
  edit financial records.

## 2. Entering support mode (the audited path)

```http
POST /api/platform/support-mode      # enter: body identifies the organization
DELETE /api/platform/support-mode    # leave
```

- Entering mints an HMAC-signed, time-boxed support cookie — `<orgId>.<nonce>.<expiry>.<sig>`,
  bound to the authenticated user id, signed under its own domain prefix so it can never be replayed
  as a session or active-organization cookie.
- **The audit row is written before the cookie is issued.** `platform.support.enter` is committed
  first; if that write fails the request fails and no cookie exists. A support window without an
  audit record cannot come into existence.
- While a window is open **every other platform capability is refused** (`withPlatformRoute`
  blocks them). The exceptions are exactly two: leaving support mode, and entering a new one (which
  replaces the current window with a freshly audited one). Support is a deliberate, one-thing-at-a-
  time act, not a mode you forget you are in.
- The window expires on its own; leaving early is always possible.

## 3. Platform reads

```http
GET /api/platform/orgs          # list organizations
GET /api/platform/orgs/<id>     # one organization
```

Every one of these runs inside `withPlatformContext()`, i.e. the database mints
`app.platform_token` for that backend. The read is authorized by the database, audited, and visible
in `audit_events` — support staff leave a trail like everyone else.

## 4. What is logged (audit expectations)

| Action                     | Audit event                | Guarantee                                                                 |
| -------------------------- | -------------------------- | ------------------------------------------------------------------------- |
| Enter support mode         | `platform.support.enter`   | Written **before** the cookie exists; failure means no support window.     |
| Leave support mode         | `platform.support.exit`    | Best-effort; the window also expires.                                      |
| Platform org read          | platform read events       | Every read through the platform plane is audited.                          |
| Any tenant-plane mutation  | existing M2/M8 audit rows  | Unchanged by this model.                                                   |

`audit_events` is append-only for the runtime role: `UPDATE` and `DELETE` are revoked (asserted by
`scripts/verify-restored-db.ts`, `security.runtime_privileges`). A support operator cannot erase
what they did, and neither can a compromised application process.

## 5. Granting and revoking platform status

- Granting is a **database change to `users.is_platform_admin`**, made with the migration/owner
  credential; there is no self-service elevation and no UI for it.
- Every grant should be recorded with whom and why (a decision entry or a ticket); the milestone
  documents do not track this automatically.
- Revoking is the same change in reverse, effective immediately (the database re-checks on every
  request, so no session needs to expire).

## 6. Known gaps (recorded, not hidden)

1. **No membership-less tenant session path.** A platform administrator can read an organization
   through the platform plane, but cannot enter the product as that school. Support that requires
   reproducing a school's *user* experience is therefore done by reading and asking, or by pairing
   with the school's own user. Closing this is the M4 identity-boundary decision, not a runbook fix
   (H9-F15).
2. **No support-contact record.** Nothing links a support action to a ticket id or a person's name
   beyond the authenticated user id.
3. **No alerting on platform-plane use.** Someone entering support mode is audited but not
   notified — see `INCIDENT_SEVERITY.md` §Manual check.
