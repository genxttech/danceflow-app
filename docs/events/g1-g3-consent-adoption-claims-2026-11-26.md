# G1 explicit marketing opt-in, G2 Student cutover threshold, G3 ticket claims (2026-11-26)

Owner dispositions of 2026-11-26. **Design and evidence only**: no code, migration, flag, send or hosted write in this change. It narrows `g02-lead-eligibility-and-event-marketing-consent-proposal.md` (PR #576) Part B.

## G1. Explicit marketing opt-in for event-derived audiences

Decision: use explicit opt-in; never manufacture consent history.

**Rule.** An email address enters an event-derived audience (`event_attendees`, `specific_event_registrants`, `specific_event_checked_in`) only with a recorded, unrevoked opt-in for **that studio**, and only if it is not unsubscribed or suppressed. Buying, registering, attending or being a client is not consent. Guest attendee emails are never included.

**Record.** New table, written only by server code (service role), readable by the studio's marketing roles:

| Column | Notes |
|---|---|
| `studio_id`, `email_normalized` | the consent is per studio and address |
| `granted_at`, `wording_version` | the exact wording shown is versioned in code |
| `source` | `public_event_checkout` or `student_event_checkout` |
| `registration_id` | evidence link; the buyer's own registration |
| `confirmed_by_payment_at` | set at settlement (or at once for free sign-ups); an abandoned checkout never counts |
| `revoked_at`, `revoked_reason` | set by unsubscribe; a later opt-in is a new row |

No backfill: the table starts empty, and existing registrations are not converted.

**Capture.** An unchecked checkbox for the buyer on the public cart checkout and the public registration form, and an optional `marketingOptIn` boolean (absent means false) on the Student checkout route, so older apps keep working and opt nobody in. Staff "sell tickets" offers no attestation. Ticking is never required to buy.

**Audience.** One shared function replaces the three copies (`campaigns/actions.ts`, `campaigns/page.tsx`, `campaigns/[id]/page.tsx`). The screen shows "N registrants excluded (no opt-in)". `marketing_claim_campaign_recipient` re-checks consent at send time for event audiences, so an old draft cannot send to someone who no longer qualifies.

**Order.** SQL before app; ship while marketing sends are frozen (M1). Operational mail (confirmations, reminders) is unaffected. Historical event audiences become empty until people opt in; that is the intended effect.

**Slices.** (1) table, RLS, settlement hook, claim re-check, SQL tests; (2) capture on both web forms and the Student route plus the Student checkbox; (3) shared audience function and UI count. All touch protected paths.

**One point to confirm.** This design applies opt-in to event-derived audiences only. Client audiences (`all_active_clients`, `new_leads`, `inactive_clients`) are unchanged; changing them was not part of the question. The wording text needs an owner or counsel read before activation.

## G2. Evidence before a cutover threshold

Read-only PROD run of `event-registration-claim-release/gate2_prereq_evidence.sql`, 2026-11-26T15:03Z (`pg_stat_statements` since 2026-10-20):

| Measure | 2026-11-19 baseline | 2026-11-26 |
|---|---|---|
| view reads (calls) | 0 | 31 |
| base-table reads (calls, all callers) | 10296 | 13091 |
| dancer self policies | present | 3 present |
| claim function executable by `authenticated` | no | no |

Limits: the database cannot say which client made a read. The 31 view reads show that something reads the views, not that it was the Student app; the base-table figure includes staff, organizer and checkout traffic and proves nothing either way. Request logs by client were not available to engineering.

Build history (verified in git): both Student builds uploaded to Play, version code 1 (`f5f31103`) and version code 2 (`4564c0b2`), read only the `my_event_*` views and have no direct read of `event_registrations` or `event_registration_attendees`. Both are on the **internal testing track only** (records of 2026-11-20 and 2026-11-21; Console not re-read here). There is no iOS release.

**Proposed threshold.** A percentage is meaningless with an internal-only audience. Cut over when all hold:
1. No Student build that predates #649 is on any Play track (true for version codes 1 and 2).
2. Any locally installed pre-#649 build (QA or sideloaded) used by a real person is replaced; confirm with the tester list.
3. One signed-in Student wallet and ticket screen check on the released build shows tickets, then a check after the cutover.
4. The web line serves the view readers (true of the live line since #660).

If a build without view readers is ever published, this threshold no longer applies. Gate 2 SQL stays separately owner-gated.

## G3. Initial claims use the verified purchaser

Already how `claim_my_event_registrations()` behaves (`20270222090000`): it links a registration with no `user_id` only when the registration is buyer-originated (`public_event_page`) and its `attendee_email` equals the caller's **verified** email. Both checkout routes write the buyer's email into that column. So:

- A gift ticket is claimed by the purchaser. A guest cannot claim it.
- A buyer whose account email differs from the checkout email cannot claim it; there is no override.
- Holder transfer is future work and needs its own design: purchaser-initiated, single-use expiring invitation to a verified address, revocable until accepted, audited, and the old ticket code replaced on acceptance.

Nothing to build now. The function is not executable until Gate 2 activation.
