# G-02 follow-up proposal: lead eligibility by ticket purpose, and event registration vs marketing consent

Status: **PROPOSAL ONLY. No code, migration or audience behavior changes in this PR.** Written 2026-11-15 for owner decision.
Context: PR #565 (merged or not) gates studio lead creation from paid event registrations by `ticket_kind`
(`general_admission` and `workshop` yes, everything else no). The owner does not accept "every general-admission
registration is a prospective student", and asked how event campaign audiences are built and what consent exists.

Everything below was verified in the code at `main` b27520fa (plus #565 for the lead function). Where something is
inferred rather than read, it says so.

---------------------------------------------------------------------------------------------------------------------

## Part A -- eligibility rule for "this paid registration is a prospective student"

### What exists today
- `event_ticket_types.ticket_kind` (text NOT NULL default `general_admission`, CHECK in `general_admission, vip,
  competitor, spectator, staff, vendor, table, pass, other`). The kind is chosen in `TicketTypeForm.tsx`; it describes
  *what the ticket is*, not *whether the studio wants its buyers in Leads*.
- `capture_event_registration_lead(uuid)` (SQL, run through the settlement outbox) and its orderless TypeScript twin
  `safeCaptureStudioEventRegistrationLead` (`src/lib/events/settlementSideEffects.ts`, called from the payments webhook)
  both decide on the registration's `ticket_type_id`. Only the **buyer** (attendee 1 of the registration) can become a
  lead; guest attendees (`event_registration_attendees`) never do.

### Candidate rules

**Rule 1 -- explicit per-ticket-type flag, default OFF (recommended).**
- Where: new column `event_ticket_types.creates_prospect_lead boolean not null default false`, plus a CHECK that the flag
  can only be true for kinds that can plausibly be prospects (`general_admission, vip, other`); the hard-excluded kinds
  (`spectator, vendor, staff, table, pass, competitor`) can never be flagged. Form: one checkbox on `TicketTypeForm.tsx`
  ("Add buyers of this ticket to Leads as prospective students", unchecked, with help text); create/update actions in
  `src/app/app/events/[id]/tickets/actions.ts` and the event-create path in `events/actions.ts` pass it through.
- Default for existing ticket types: **false**. Existing leads, clients and notifications are untouched (no backfill).
  Consequence: until a studio ticks the box, future general-admission buyers stop becoming leads (they still produce the
  labelled "not added as a lead" notification from #565). A one-time in-app banner on Events/Tickets can tell studios.
- Migration: additive column + CHECK, one function replacement (`event_ticket_kind_creates_lead(text)` becomes
  `event_ticket_creates_lead(ticket_type_id)` reading flag AND kind-not-excluded). Git-only, rollback = drop column /
  restore #565 function body.
- TS/SQL interaction: both capture paths already load the ticket type; they read `creates_prospect_lead` instead of
  calling the kind list. The kind list survives only as the hard-exclusion set. SQL/TS parity test stays (pin the
  exclusion list and the "flag required" rule on both sides).
- UI size: small (one checkbox, one help line, one banner); no new screens.
- Edge cases: *guests* (unchanged: only the buyer); *existing client by email* (flag on: reuse as today and only fill
  empty source fields; flag off: untouched and not linked); *duplicate registrations* (advisory lock per studio+email and
  the dedupe key already make repeats no-ops); *refunds* (a lead is created at paid settlement; a later refund does not
  delete it -- same as every other lead; refunded-before-drain is already skipped because the function requires
  `payment_status = 'paid'`); *free tickets* (a free registration is not `paid` through the cart path today, so no
  lead; decide separately if free sign-ups should qualify); *flag changed after sale* (decided at settlement time).
- Tests: the G-02 SQL suite extended with flag on/off x each kind; the hard-exclusion CHECK; TS twin parity; form action
  tests; migration rollback test.

**Rule 2 -- ticket purpose enum with studio opt-in.**
- Where: replace/augment `ticket_kind` with `ticket_purpose` (`prospect_intro, student_workshop, practice_party,
  spectator, staff, vendor, competitor, other`) and a per-studio settings table mapping each purpose to "creates lead"
  (default: none).
- Pros: names the *reason*, reusable for reporting and for other defaults (waivers, check-in). Cons: a second
  classification beside `ticket_kind` (migration of existing rows to purposes needs guesses), a settings screen, a new
  per-studio table with RLS, larger test surface. Same default-off behavior as Rule 1 once mapped.
- UI size: medium-large (purpose picker plus a studio-level mapping screen). Not recommended now.

**Rule 3 -- event-level setting.**
- Where: `events.lead_capture_mode in ('none','prospect_tickets')` (default `none`), set in the event form.
- Pros: smallest UI (one select per event). Cons: too coarse -- a single event sells GA and spectator tickets, so the
  setting must still be combined with a per-ticket decision, and a mixed event forces the studio to choose between
  over-capturing and under-capturing. Reasonable only as a *default source* for Rule 1 (new ticket types inherit the
  event's setting).

### Recommendation
**Rule 1.** It is the only option that is both explicit studio configuration and minimal: one nullable-risk-free
column with a safe default, one checkbox, and a function change that is already isolated in #565. The hard-excluded kinds
cannot be flagged, so a misconfiguration cannot reintroduce the original defect. Rule 3 can be added later purely as
the default for the checkbox without touching the capture path. #565's kind-based default would then be superseded
by this rule (so #565 should either wait for the decision or be followed by a small PR that swaps the predicate).

### Decisions the owner must make for Part A
1. Rule 1, 2 or 3 (recommend 1).
2. Existing ticket types default OFF (recommended) or default ON for `general_admission` only (keeps current
   behavior but is exactly what the owner objected to).
3. May `vip` and `other` kinds be flagged at all (recommended yes, studio opt-in)?
4. Should free sign-ups ever create leads?
5. Is the one-time "leads are now opt-in per ticket" banner acceptable?

---------------------------------------------------------------------------------------------------------------------

## Part B -- event attendance is not marketing consent

### How event campaign audiences are built today (verified)
Studio campaigns (`src/app/app/marketing/campaigns/actions.ts`, `getEventRecipients`, lines ~488-650):
- `event_attendees`: every row of `event_registrations` for the studio with a non-null `attendee_email` and status not
  `cancelled` (limit 5000), de-duplicated by email.
- `specific_event_registrants` / `specific_event_checked_in`: for one chosen event, the buyer rows from
  `event_registrations` **plus every guest attendee email** from `event_registration_attendees` (checked-in variant: only
  attendees with `checked_in_at`).
- **Not considered anywhere**: ticket kind or purpose, whether the person is a client or lead, payment status (only
  `cancelled` is excluded, so pending/unpaid holds count), and any opt-in. Guest attendee emails are typed by the buyer
  about third parties.
- The same queries are duplicated for audience counts/re-preview in `campaigns/page.tsx` (~351) and
  `campaigns/[id]/page.tsx` (~467-551), so any rule must be applied in all three places (better: one shared function).
- The client audiences (`all_active_clients`, `new_leads`, `inactive_clients`, ...) read `clients` by status.

### Consent signals that exist today (verified)
- **Email is opt-out only**: per-studio `marketing_unsubscribes` (email, studio), platform
  `marketing_email_suppressions` (hard bounce/complaint), one-click unsubscribe links/headers, studio postal footer
  (Marketing M-0, `20261117090000`; send-time eligibility is re-checked in `marketing_claim_campaign_recipient`).
  Marketing sends are currently frozen behind `marketing_send_frozen()` (M-0 state), which is the window to change this
  safely.
- **No email marketing opt-in exists** on `clients`, `event_registrations`, `event_orders`, the public registration form
  (`src/app/events/[slug]/register/RegistrationForm.tsx`) or the cart/student event checkout. (Searched for consent /
  opt-in / marketing columns and form fields; none.)
- **SMS is explicit opt-in** (A2P-1B `src/lib/sms/publicConsent.ts`: checkbox + consent record + history event; TW-2
  consent integrity; client SMS consent card). That model is the template for email.
- Organizer contacts (`organizer_contacts`, `unsubscribed` status) are organizer-scoped and separate.

### Proposed rule
**A person enters an event-derived marketing audience only if at least one of these holds:**
1. *Explicit marketing opt-in recorded at registration* -- a new unchecked checkbox on the registration/checkout form,
   stored with evidence (timestamp, wording version, source/IP-free), on the registration (buyer) -- never for guest
   attendees; or
2. *Existing relationship*: the email matches an existing **client** of that studio (status active, or a lead that the
   studio itself created through an eligible ticket under Part A) and is not unsubscribed/suppressed.
Everyone else (spectators, vendors, staff, competitors, guests, anyone who just bought a ticket) stays out of campaigns
by default. Event reminders / confirmations (operational, `event-reminders` cron) are unaffected: they are not
marketing. Guest attendee emails are **removed from marketing audiences entirely** unless the guest has their own opt-in
(future).

- Code locations: one new shared `getEventMarketingRecipients` replacing the three duplicated queries (actions.ts,
  `campaigns/page.tsx`, `campaigns/[id]/page.tsx`); join `event_registrations` to `clients` by lowercase email within the
  studio; read the opt-in columns; filter registrations to `payment_status = 'paid'` (or confirmed). Add the basis
  (`opt_in` / `client`) to the recipient row; defence in depth: store it on `marketing_campaign_recipients` and re-check in
  `marketing_claim_campaign_recipient` so a stale draft list cannot send to someone who no longer qualifies.
- Migration: opt-in columns on `event_registrations` (`marketing_opt_in boolean not null default false`,
  `marketing_opt_in_at timestamptz`, `marketing_opt_in_version text`); recipient `consent_basis` column; claim-function
  replacement. Git-only, with rollback.
- UI: checkbox on the public registration form and student-app event checkout (unchecked by default); the cart/student
  checkout routes persist it; staff "sell tickets" gets an explicit "customer agreed" control that defaults off (a
  staff-attested opt-in is a legal question for the owner); campaign audience descriptions explain the new rule and show
  "N registrants excluded (no opt-in)".
- Risks: **existing event audiences shrink to near zero** for historical registrants (none have an opt-in) unless they
  are existing clients -- intentional but visible; drafts/scheduled campaigns with event audiences must be regenerated
  (M-0 sync preserves rows that were already sent). Payment-pending registrations stop counting. Studios may need an
  "import past opt-ins" path (owner/legal decision, not proposed here).
- Tests: audience unit tests per rule (opt-in only, client only, both, neither, guest attendee, unpaid, cancelled,
  unsubscribed, suppressed); SQL claim-time recheck suite; form/route tests that the checkbox is stored with evidence
  and never defaulted; regression that operational reminders are unchanged; a duplicate-query guard so the three call
  sites cannot drift.

### Decisions the owner must make for Part B
1. Adopt the rule (opt-in OR existing client) for event audiences? (recommended yes)
2. Is a checkbox at registration sufficient evidence, and what exact wording/version?
3. May staff attest an opt-in on behalf of a customer in "sell tickets"? (recommended no; default off)
4. Guest attendees: exclude from marketing entirely (recommended)?
5. Historical registrants: leave excluded (recommended) or allow a studio-attested re-permission campaign?
6. Should unpaid/pending registrations ever be marketed to (recommended no)?
7. Timing: implement while marketing sends are frozen (recommended) and before any studio sends event campaigns.

---------------------------------------------------------------------------------------------------------------------

## Recommended order if approved
1. Decide Part A and B (above).
2. Swap #565's predicate to Rule 1 (small PR, protected paths).
3. Part B implementation as a separate protected-path PR set: audiences + opt-in capture + claim-time recheck.
4. Production: both are SQL-before-app and need backport to `release/website-embeds` (live is not main).
