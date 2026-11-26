# Business Pulse Command Center: Phase A audit (2026-11-21)

Owner-approved workstream: Pulse becomes the default landing screen and single-pane-of-glass command center of the DanceFlow Business app; Today stays the tactical lesson-and-attendance workspace; Schedule stays the calendar. This is the read-only audit (Phase A) at main `882df3eb`. It changes no code, no migration, nothing deployed. The pinned Business v0.2 candidate (`27d007a2`) is untouched; every later phase lands on main only and behind flags that default OFF.

## 1. Summary

- **What exists.** Pulse is three cards (counts of today's appointments, the next appointment, "new clients in 7 days") fed by `GET /pulse` (`src/lib/staff/studioPulse.ts`). It is OFF by default (`pulse` word), the app lands on **Today** (`initialTab` in `mobile/business/src/lib/navigation.ts`), and for instructors Pulse is the same day as Today with fewer details. That is the overlap the owner noticed.
- **What was approved.** The Mobile Design Direction canvas (Business boards, "Owner pulse" and "Instructor Today") separates them: Pulse = studio health tiles (collected today, sessions today, unpaid balance, new leads) plus a **"Needs you"** list (ARIA suggestion with Review / Not now, lesson requests with oldest wait, an event sell-through line). Today = one hero "Next, in 12 minutes" card with Check in / Client, then the day's list. Pulse is the first tab for owners.
- **Most of the data already exists on the web; almost none of it is behind a staff API route.** Every card needs either a new read route or a pure-lib extraction from a 3,117-line page (`src/app/app/page.tsx`) or from `reports/page.tsx`. Nothing needs a migration for P1.
- **Proposed P1** (read-only, flag-gated, default OFF): a new `GET /pulse` v2 payload (additive; v1 fields unchanged so the pinned candidate keeps working) with five card payloads, a role-adaptive Pulse screen, and a flag-gated default-landing switch. Details in section 7.

## 2. Definitions used by the cards (settled before any build)

| Term | Meaning | Source |
|---|---|---|
| **Lead** | `clients.status = 'lead'` (pipeline: `contacted`, `consultation_booked`, then `converted` / `lost`). A lead is a CRM record, not a booking. | `src/app/app/leads/page.tsx`; NSI spec section 3 |
| **Lesson request** | A row a dancer or visitor created asking for a time: `booking_requests` (public booking page and portal) or `student_booking_action_requests` (book / reschedule / cancel from the portal or Student app). A request is not yet a booking. | section 3.1 |
| **Confirmed booking** | An `appointments` row. Approving a `booking_requests` row inserts the appointment as `scheduled` in the same action (`approveBookingRequestAction`); `confirmed` is the later dancer acknowledgement (`appointmentConfirmation.ts`). | schedule/requests/actions.ts |
| **New Student Intake** | Triggered only by a committed appointment (`scheduled`, `rescheduled`, `confirmed`) of an existing qualifying type for a client with no valid completion and no earlier non-cancelled qualifying appointment. "Intake is separate from discovery leads, inquiries and intro requests, which never trigger it." A request alone never triggers intake. Pulse never starts or implies intake. | NSI spec (`NSI_V1_Engineering_Spec.md`, untracked in the intake worktree): the trigger rule, the new-student rule, and the lines separating intake from leads |
| **Non-lead activity** | Event registrants, ticket purchasers and guest attendees. They must not be counted as new sales leads. | brief; lead-integrity proposal PR #576 |

**Existing defect this audit found.** `loadPulse` returns `newClientsLast7Days` = every `clients` row created in 7 days (manual adds, portal sign-ups, event registrants, quick-add). The v0.1 app labels it "new in the last 7 days" under "Clients", which is honest, but it must NOT become the "New leads" tile. The web leads page already groups `eventRegistrationLeads` inside the lead list, so event registrants can currently carry `status = 'lead'`; lead eligibility belongs to the lead-integrity session (G-01/G-02, PR #576). Pulse must consume that rule through one shared predicate, not reinvent it (decision O3).

## 3. Card-by-card audit

Roles below use `src/lib/auth/permissions.ts`. "Broad" = `studio_owner`, `studio_admin`, `front_desk` (+ `platform_admin`, which the staff API refuses today). The staff API serves only `studio_owner`, `studio_admin`, `front_desk`, `instructor`; independent instructors and organizer roles get `role_not_permitted` (`SERVED_ROLES`).

### 3.1 Lesson Requests
- **Data (two queues).**
  - `booking_requests` (public `/book/[studio]` and portal): `status` `pending` / `approved` / `declined` (the dashboard counts `pending`, `new`, `in_review`); fields include `client_id`, `instructor_id`, `room_id`, `appointment_type`, `requested_starts_at`, `source`. Web count: `page.tsx` ~2319. Actions: `approveBookingRequestAction`, `declineBookingRequestAction` (`src/app/app/schedule/requests/actions.ts`).
  - `student_booking_action_requests` (portal / Student app book, reschedule, cancel): `status` `pending` / `approved` / `declined` / `executed` / `cancelled` / `expired` / `failed`; `mode` `request_only` / `approval_required` / `instant`; `source` `portal` / `mobile_app` / `staff` / `aria`. Queue page and actions: `src/app/app/schedule/self-service/` (`approveStudentBookingActionRequest` calls `executeApprovedStudentBookingAction`).
  - The web "pending" count covers only `booking_requests`; the self-service queue is a separate page. Pulse should show both under one card with a source chip.
- **"Approved awaiting booking".** For `booking_requests` approval books in the same action, so there is no durable middle state; for self-service actions the middle state appears only when execution fails (`failed`) or while `approved` is not yet `executed`. P1 reports what the rows say; it does not invent a state.
- **Permissions today.** Broad roles triage everything. An instructor may act only on requests whose `instructor_id` is their own resolved instructor; an unassigned request is never instructor-actionable (`bookingRequestAccess.ts`, `requireOwnActionRequestOrBroadRole`). Instructors never see client email.
- **Staff API today:** none. **P1:** new read route (counts by state, oldest waiting, 5 most recent, per role scope) from a pure lib extracted from the two web queries. **P2:** approve / decline through `requireStaffWrite` with a new capability key (proposal `requestReview`), reusing the web action cores (extract-don't-fork: the action bodies contain conflict checks, entitlement lookup, decision email and push; they must move into `src/lib/staff/` like `classRoster.ts` did, with the web actions becoming thin callers).

### 3.2 New Leads
- **Data.** `clients` with `status = 'lead'` (list ordered `created_at desc`), `lead_activities` (`follow_up_due_at`, `completed_at`) for overdue and due-today follow-ups, `referral_source` (for example `public_intro_booking`). Web: `leads/page.tsx` (overdue / due today / completed follow-ups, source filters, lifecycle snapshot) and `page.tsx` follow-up derivation (~2380-2510).
- **Existing mobile data.** `GET /clients?status=lead` lists leads (name search, cursor) but has no recency ordering, no follow-up info and no "uncontacted" signal.
- **Permissions.** `canViewClients` / `canEditClients`: owner, admin, front desk. Instructors have no lead visibility (teaching-relationship rule); the card is hidden for them.
- **Gap.** Eligibility predicate (O3); "uncontacted" = lead with no `lead_activities` row (derivable); assigned follow-ups = `lead_activities` due. **P1:** new read route fields: recent leads (id, name, created, source label, next follow-up due), counts (new in 7 days, uncontacted, follow-ups overdue / due today). Quick actions in P1 are navigation only (open client, call / text via the device dialer on the client's own phone); **P2** adds "log follow-up" and "mark contacted" through the existing `clientNotes` / lead-activity paths with a new capability key.

### 3.3 ARIA Needs Attention
- **Data.** `automation_actions` (`id, rule_key, title, body, status, priority, related_table, related_id, client_id, due_at, created_at`), drafts in `outbound_deliveries` (`related_table = 'automation_actions'`, statuses `draft` / `queued` / `sent` / `failed` / `skipped`), `automation_runs`; organizer-workspace recommendations persist in `aria_action_items` (`dismissed`, `completed`, `snoozed`). Pages: `/app/automations`, `/app/automations/drafts`, `/app/aria`.
- **Approval model (must be preserved).** Approve, dismiss, edit and the autonomy settings require `canManageSettings` (owner, admin; plus organizer owner / admin); front desk and instructors cannot. Approved actions are executed server-side (`executeAriaApprovedActionsAction`), never by the client. Pulse therefore never executes: it shows prepared items and routes to the approval path.
- **Permissions today in the API:** none. **P1:** read-only count and the top items (title, priority, age, type chip, client first name only where the viewer already may see clients). Visible to owner and admin; hidden from front desk and instructors in P1 (owner decision O4). **P4 (D):** Approve / Dismiss buttons call a staff route that runs the SAME web approval function (extracted), `canManageSettings` enforced server-side, audit row written; "Execute" stays a web or server-side step.

### 3.4 Operational Exceptions
Nothing persists "exceptions"; each is derived. What the data supports today:

| Exception | Source | Available now | Notes |
|---|---|---|---|
| Cancellations | `appointments.status = 'cancelled'` (already in `loadPulse` as `today.cancelled`) | yes | add recent cancellations (who is hidden unless the viewer may see the client) |
| Low or empty packages | `client_packages` + `client_package_items.quantity_remaining` (web follow-up item `package`) | yes | `client_packages` has no expiry column in the audited schema, so "expiring" cannot be built honestly; show "running low / used up" |
| Unpaid lessons / failed charges | `appointments` payment fields; `payment_settlement_conflicts`; `payments` (web `payments/page.tsx`) | yes for owner, admin, front desk (`canViewPayments`) | |
| Missing confirmations | `appointment_confirmation_tokens` and appointment `scheduled` vs `confirmed` | derivable | needs a window rule (decision O5) |
| Schedule conflicts | `detectAppointmentConflicts` (`src/lib/schedule/conflicts.ts`) runs at write time only | derivable by overlap query | new lib; no persisted flag |
| Waivers / documents | documents module (Phase 8) | not audited deeply | out of P1 |
| Active client with no upcoming appointment | web follow-up item `client` | yes (CRM-tier roles) | candidate, low priority |

**P1:** counts and the top 5 across the "available now" rows, role-filtered. No actions beyond opening the existing mobile appointment or client screen.

### 3.5 Business Health
- **Data.** `payments` (`amount`, status, `refund_amount`), balances, bookings counts, trends: today in `reports/page.tsx` (`payments` ~853, `appointments` ~888, packages, memberships, events, `commerce_orders`) and `payments/page.tsx` (`paidTotal`, `pendingTotal`). All inline in page components; none reusable.
- **Permissions.** Revenue and balances: `canViewPayments` (owner, admin, front desk); reports: `canViewReports` (adds organizer owner / admin). Instructors: no studio money. An instructor's own numbers (their sessions, their earnings via `instructor_earnings`) are a separate, smaller card (decision O4).
- **P1:** tiles that need no money first: sessions today, done vs ahead (from existing `loadPulse` data). **P1b** (still read-only, after a pure `src/lib/staff/studioHealth.ts` extraction with tests against the web's own totals): collected today, unpaid balance, with the "up / down on last same weekday" line from the approved design. Currency and time zone come from the studio. No revenue appears for roles without `canViewPayments`, enforced in the lib, not the screen.

### 3.6 Compact next-session summary
Already served (`pulse.next`, studio-wide or the instructor's own, `UPCOMING_STATUSES`). P1 keeps one line and a "See today" link to the Today tab. No schedule list on Pulse.

## 4. Role matrix for P1 (proposal; decisions O1, O4)

| Card | Owner | Admin | Front desk | Instructor | Independent instructor / organizer |
|---|---|---|---|---|---|
| Next session + sessions today | yes | yes | yes | own day | not served by the API today |
| Lesson requests | all, read | all, read | all, read | requests assigned to them | not served |
| New leads | yes | yes | yes | hidden | not served |
| ARIA needs attention | yes (read) | yes (read) | hidden | hidden | not served |
| Operational exceptions | all | all | all (no ARIA) | own schedule only (cancellations, conflicts, confirmations) | not served |
| Business health | yes | yes | yes (`canViewPayments`) | own sessions only | not served |

Organizer workspaces have a different surface (events, tickets, settlement: `page.tsx` organizer branch ~1263-1330, `reports/page.tsx` organizer sections). Independent instructors are `role_not_permitted` on every staff route. A Pulse for those workspaces needs its own API contract; P1 does not change that refusal.

## 5. Cross-cutting findings

1. **Tenancy.** Every query filters by `studio_id` and then by the instructor's resolved id for instructor scope (the `loadPulse` and `instructorToday` pattern); RLS is a second layer, never the only one.
2. **Extract, don't fork.** Needed libs under `src/lib/staff/` with the web pages becoming callers: `pulseRequests.ts`, `pulseLeads.ts`, `pulseAria.ts`, `pulseExceptions.ts`, `studioHealth.ts`. The web follow-up queue logic in `page.tsx` (~2230-2700) is the most valuable thing to extract and is also what keeps the web and app counts equal.
3. **Contract first.** Additive fields on `GET /pulse` (`cards: { requests, leads, aria, exceptions, health }`, each `null` when the role may not see it, plus per-card `asOf` and `truncated`); documented in `docs/mobile/Staff_API_Contract.md` before code. v1 fields stay byte-compatible so the pinned v0.1 / v0.2 builds are unaffected.
4. **Limits.** Each card query is bounded (counts via `head: true`, lists limited to 5 to 25) and fails independently: one card error must not blank the screen (per-card error state, stale banner already exists).
5. **Landing.** `initialTab` ignores the Pulse flag today. The default-landing switch is a new default-OFF word (proposal `pulseHome`, separate from `pulse`) so v0.1 testers are unaffected; with it on, owners, admins and front desk land on Pulse, instructors keep Today (decision O1).
6. **Hold on side effects.** No card triggers intake, a notification, a message or an ARIA run. Reads only until P2.

## 6. Pre-existing findings (not changed here)

- `GET /clients` listing and `loadPulse.newClientsLast7Days` count every client type; see section 2.
- `get_teaching_clients_for_instructor` is absent on PROD (already reported in the backport review); instructor client lookups depend on it.

## 7. Phased plan

| Phase | Scope | Main files | Depends on | Parallel with |
|---|---|---|---|---|
| **A** (this PR) | audit, definitions, plan | this document | none | n/a |
| **P1a** contract + libs | additive `GET /pulse` v2 and the five pure libs with unit tests (role matrix, tenancy, truncation); web follow-up queue extracted to a shared lib | `src/lib/staff/pulse*.ts`, `studioHealth.ts`, `src/app/api/staff/.../pulse/route.ts`, contract doc, `page.tsx` callers | O3 for leads; O5 for confirmations | P1b UI against a fixture payload |
| **P1b** UI | new Pulse layout (health tiles, "Needs you" list, requests, leads, ARIA, exceptions, compact next session), card sheets, role-adaptive, per-card loading / error / empty states, 200% text, dark | `mobile/business/src/screens/PulseScreen.tsx` + `components/pulse/*`, `lib/staffApi.ts`, `lib/features.ts` | P1a contract | P1a |
| **P1c** landing | `pulseHome` word, `initialTab` switch, a11y and jest | `navigation.ts`, `app/index.tsx` | O1 | after P1b |
| **P2** request review actions | approve / decline via `requireStaffWrite` (new key), idempotency per `writeSupport`, shared action core extracted from the two web actions, real-DB tests under the lock, independent security review, role refusal / tenancy / outcome-conflict tests; writes OFF by default | `src/lib/staff/bookingRequests.ts`, routes, mobile mutation | P1a, owner gate | none |
| **P3** lead quick actions | log follow-up, mark contacted | reuse note / lead-activity paths | P2 pattern | P2 |
| **P4 / D** ARIA actions | approve / dismiss through the existing approval function (`canManageSettings`), no device execution | extracted approval lib | P1 ARIA card, owner decision | P2 |
| Evidence | jest, static a11y, role-matrix tests, real-stack API proof on iso-qa, emulator screenshots (current vs target) | `scripts/qa/staff-api/*`, `mobile/business` | emulator slot after the Student build | all |

Screenshots: "current" captures of today's Pulse and Today from the iso-qa seed need the emulator slot; none were taken in this phase.

## 8. Acceptance evidence planned for P1
Pure-lib unit tests per card x role (owner, admin, front desk, instructor with and without a linked instructor, independent instructor refused); tenancy (studio B data never returned); truncation flags; contract snapshot test; `a11y-audit` static pass for new components; screen tests for loading, error, empty, role-hidden cards; the real-stack route proof (disposable iso-qa stack, production build) reusing `scripts/qa/staff-api/r3-gate-lib.mjs`; device captures after the emulator slot.

## 9. Owner decisions that are genuinely needed
- **O1.** Default landing: Pulse for owner, admin and front desk behind a new `pulseHome` word, instructors keep Today. (Recommended.)
- **O2.** Is the P1 "Business health" limited to sessions first, with money tiles in P1b after the extraction is proven against the web totals? (Recommended.)
- **O3.** Lead eligibility for the "New leads" tile: adopt whatever rule the lead-integrity session lands (G-01/G-02, #576). Until then P1 shows leads only as `status = 'lead'` excluding event-registration origins, labeled by source.
- **O4.** Which role sees which card (section 4), notably: front desk sees ARIA? (recommended: no, matches `canManageSettings`), instructor sees own-day health only.
- **O5.** Window for "missing confirmation" (for example unconfirmed within 48 hours of start).
- **O6.** P2 scope: one approve / decline for both request queues, or `booking_requests` first.
