# Runbook — Breach notification

> If you suspect personal data has been exposed, the clock starts now. Notify within **24 hours**.
> This is an **internal target adopted by engineering**, chosen because it is stricter than any
> deadline we currently understand; it has **not** been reviewed by a lawyer, and the legal
> notification duties and deadlines have not been confirmed (H9-F23, H9-F19).

**Audience:** the founder and whoever is on duty at the moment of discovery.
**Status:** procedure adopted; **legal review outstanding** — see §6.

---

## 1. What counts

Treat it as a breach if **any** of these is true, even if you are unsure:

- Personal data (names, phone numbers, e-mail addresses, student records, payment records) was, or
  may have been, visible to someone who should not have seen it — **especially another school**.
- A credential was exposed: database password, `SCOLAIRA_SESSION_SECRET`, a platform token, a
  payment-provider secret, or an invitation/support token.
- A device or account holding production access was lost, stolen or accessed by someone else.
- A dump, export or CSV containing school data was sent to the wrong recipient or stored somewhere
  it should not be.
- You cannot tell whether any of the above happened, but you cannot rule it out either.

**Unsure is not a reason to wait.** Erring towards notifying is the rule.

## 2. Immediate actions (first hour)

1. **Stop the exposure without destroying evidence.** Revoke or rotate the credential; take the
   affected surface offline if it is still open. Do not delete logs, rows or files to "clean up".
2. **Write down the wall-clock time you became aware.** Everything below is measured from it. This
   timestamp is the single most important fact in the record.
3. **Establish the blast radius**: whose data, which organizations, how many people, what
   categories (contact details only, or financial records too).
4. **Preserve**: `audit_events` for the window, application logs, the request trail in
   `webhook_events` if payments are involved. Copy them out to a file that is not in the database
   being investigated.
5. **Tell the founder.** They decide on notification and on what is said publicly. Nothing is
   announced by anyone else first.
6. **Do not speculate publicly.** Say what is known, that an investigation is under way, and when
   the next update will come.

## 3. Notification — 24-hour target

| Who                                  | When                          | Content                                                                                   |
| ------------------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------- |
| **Founder**                          | Immediately on suspicion      | Facts known so far, blast radius, what was stopped.                                        |
| **Affected schools (proprietors)**   | **≤ 24 hours** from awareness | Plain language: what happened, what data, what we have done, what they should do, contact. |
| **Affected individuals**             | ≤ 24 hours where the school asks us to notify directly, or where required | Same content, addressed to them.                            |
| **Regulator**                        | As advised by counsel; do not assume a deadline | Filing is a founder action, not an engineering one.                             |
| **Payment provider**                 | ≤ 24 hours if a payment secret or transaction data is involved | Follow the provider's own incident channel.               |

Write the notification for a school proprietor, not for an engineer:

> On <date>, <what happened>. The data involved was <categories>. We <what we did>. There is no
> action you need to take / we recommend you <action>. We will update you by <time>. You can reach
> us on <contact>.

## 4. What is recorded

- **Awareness time**, detection method (who noticed, how), and the affected window.
- Blast radius: organizations, people, data categories, whether financial records were involved.
- Actions taken, with timestamps, and who took them.
- Who was notified, when, and how.
- The decision **not** to notify anyone about a particular group, with the reason.
- Post-incident review within 48 hours.

The record lives with the incident; it is not filed in the repository if it contains personal data.

## 5. Blast radius that matters most

SCOLAIRA holds children's records and school fee data. **Cross-tenant exposure is the worst
outcome**: it means the isolation guarantees the product's whole design rests on have failed, and
it is treated as SEV1 regardless of how few rows are involved. If the exposure is cross-tenant, say
so plainly to every affected school rather than describing it as "an access issue".

## 6. Gaps and dependencies (recorded, not hidden)

1. **No legal review.** The 24-hour target and the reporting duties are engineering's draft. The
   data-residency and legal-basis questions are open (`docs/DATA_RESIDENCY_AND_PRIVACY.md`, H9-F19);
   counsel must confirm which regulator, which deadline, and in what form.
2. **No emergency contact list.** `docs/ops/emergency_contacts.md` does not exist (H9-F4): naming
   people is a founder decision. Until it does, the founder is reached the way the team already
   reaches them.
3. **No alerting.** A breach is detected by a human noticing — there is no monitoring that would
   catch it (H9-F10).
4. **No backup, so no restore-based containment.** Recovery limits what we can promise an affected
   school today (H9-F1/H9-F3).
