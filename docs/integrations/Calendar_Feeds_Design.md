# Calendar Feeds Design — dancer and staff subscriptions (first end-to-end slice)

Status: DESIGN ONLY (docs). Owner-approved as roadmap priority #1 (OD-10, 2026-11-23); no activation, publishing, provider enrollment or fee. No SQL has been run or authored for hosted databases; DDL below is illustrative. All behaviour ships off by default behind a kill switch and a per-studio allowlist (OD-5: no pricing or plan gating).
Inputs: `Integrations_Audit_Existing.md` §9 (native feed audit), `Connected_Apps_Architecture.md` §18.1 and §18.4 (security requirements), `Integrations_Roadmap.md` slice B1.
Internal-confidential note: Competition-governed event classes are excluded by allowlist (§7); nothing about unreleased Competition plans is written here.

## 1. Goal and non-goals
Goal: a dancer (or guardian) and a staff member can add their own DanceFlow schedule to Apple Calendar, Google Calendar or Outlook by subscribing to a private, revocable ICS URL, and the subscription stays correct through reschedules and cancellations.
Non-goals (this slice): two-way sync; creating/changing bookings from a calendar; studio-wide public calendars (they exist already and are untouched); per-vendor OAuth integrations; push notifications; any new paid entitlement.

## 2. What exists today (code audit, 2026-11-23)
| Feed | Route | Token storage | Notes |
|---|---|---|---|
| Studio and organizer public calendars | `/api/public-calendars/{studios,organizers}/…/events.ics`, `/studios/[slug]/event.ics`, `/organizers/[slug]/events.ics` | none (public event data) | Public events only; keep as is |
| Instructor feed | `/calendar/instructor/[token]` (`instructor_calendar_feeds`, one token per instructor) | **plaintext** `token`, readable by any active staff role via RLS | window −30d to +6 months; cancelled appointments omitted; UID `<appointment id>@danceflow`; DTSTART/DTEND in UTC; no SEQUENCE; `no-store`, no ETag; full client names and appointment notes in the event; distinct 404 messages; DB error text in 500s; `last_accessed_at` written every request |
| Coach schedule feed | `/coach-schedule/[token]/calendar` (event private-lesson slots) | token on coach row (`schedule_token_enabled`) | emits buyer name, email, phone, notes |
| Google Calendar push | OAuth integration | n/a | unrelated mechanism; not changed here |
| Dancer data sources | `/api/student/schedule` (client via `client_account_links`: `status=linked`, `can_view_schedule`, `is_primary`), appointments by `client_id`, group-class roster in `appointment_attendees`, event orders/tickets | n/a | studio timezone from `studio_settings.timezone` |
Reusable: ICS escaping/folding helpers and UTC instant formatting (the DST-safe fix is already in the instructor route), `normalizePublicToken`, the S1E-4 eligibility rules from the Google sync (cancelled/no_show handling), `client_account_links` visibility rule. Not reusable as-is: token storage, detail level, error handling, caching.

## 3. Token model
Illustrative table `calendar_feed_tokens` (service-role access only; RLS on, no policies, grants revoked in the same migration):
| Column | Purpose |
|---|---|
| `id` uuid | public-safe id for audit and UI |
| `studio_id` | tenant |
| `subject_kind` | `dancer_account` (a signed-in user with linked client profiles) or `staff` (user with an active instructor/staff role) |
| `subject_user_id` | auth user the feed belongs to (not the client id: a guardian's one feed covers all linked profiles they may view) |
| `token_hash` | SHA-256 of a 256-bit random secret; unique; the plaintext is never stored |
| `token_prefix` | first 6 chars of the secret, for support display only (not sufficient to guess) |
| `detail_level` | `minimal` (default) or `standard` (see §7) |
| `include_client_ids` | optional subset of linked profiles (guardian chooses which dependents appear) |
| `status` | `active`, `rotating`, `revoked`, `expired` |
| `created_at`, `created_by`, `expires_at` | default expiry 24 months, owner-configurable |
| `rotated_from`, `overlap_until` | previous token stays valid until `overlap_until` (default none, max 24 h) |
| `revoked_at`, `revoked_reason` | `user`, `admin`, `account_removed`, `role_lost`, `link_removed`, `studio_offboarded`, `incident` |
| `last_accessed_at` | updated at most once per 15 minutes |
At most one current token per (studio, subject, audience); during rotation the previous one is valid until its overlap ends. Existing instructor tokens are migrated by **hashing the existing plaintext values** into this table (so current subscriptions keep working), then the plaintext column is dropped after cutover; staff are prompted to rotate.

## 4. Secure URLs
- `https://<app origin>/calendar/feed/<secret>.ics`, with a `webcal://` variant shown in the UI for one-tap subscribe. Secret is 32 random bytes base64url (43 chars). Token only in the path, never in a query string.
- Display rules: the full URL is shown **once** at creation or rotation, with Copy and Subscribe buttons and a QR code; afterwards the UI shows only the prefix, created date, last used and detail level. To get a link again the user rotates.
- Response headers: `Cache-Control: private, no-store` on error responses; `Referrer-Policy: no-referrer`; `X-Robots-Tag: noindex`; `Content-Disposition: inline; filename="danceflow.ics"`.
- The application never logs the plaintext token; log entries use the token id. Residual risk: platform request logs may contain the URL path (accepted, mitigated by revocation, rotation and minimal detail; Architecture §18.1.6).
- Origin comes from one required config value, not the request.

## 5. Revoke and rotate UX
**Student app and portal** (dancer or guardian): Profile → "Add to calendar". States: not set up → Create link (choose studio if several, choose profiles to include, detail level, default minimal). Active → Subscribe (webcal), Copy link, Show QR (only right after create/rotate), Change detail level, Rotate link (confirm; old link stops after overlap), Turn off (revoke). Plain-language text explains that anyone with the link can see the schedule shown.
**Business app and web, staff**: Settings → "My calendar feed" with the same controls for the signed-in staff member (instructors, front desk where their role has a schedule).
**Owner/admin**: instructors page shows per-staff feed status (active/never/revoked, last used, detail level) with **Revoke** and "require rotation", but admins cannot view tokens. Bulk "revoke all staff feeds" for incidents.
**Automatic revocation** (no UI): dancer account deletion or merge; `client_account_links` link removed or `can_view_schedule` turned off (the feed also re-checks links on every request, so it takes effect immediately even if the hook lags); staff deactivation or role loss; studio offboarding; an owner "incident" action. Each writes an audit event with the reason.
**Audit**: every create, rotate, revoke, detail change and admin action writes an audit row (`integration_audit_events` once slice A1 exists; until then a feed-specific audit table with the same shape).

## 6. Feed content: event lifecycle (UID, SEQUENCE, cancellations)
- **UID** is stable for the life of the booking: `appt-<appointment_id>@danceflow` for appointments and group-class attendances (existing instructor feed uses `<appointment id>@danceflow`; keep that exact form for migrated feeds so subscribers do not see duplicates), `evt-<order item or ticket id>@danceflow` for event tickets. A dancer and an instructor subscribed to the same class get independent copies of the same UID in different calendars; that is fine.
- **SEQUENCE** increases on every change that matters to clients (time, location, title, status). v1 derives it without schema changes as whole seconds since 2026-01-01 UTC of the row's `updated_at` (monotonic, fits a 32-bit integer for decades); a revision counter maintained by trigger is the alternative if some updates do not touch `updated_at` (to verify per table). `LAST-MODIFIED` = `updated_at`; `DTSTAMP` = render time.
- **Reschedule**: same UID, new DTSTART/DTEND, higher SEQUENCE. Calendar apps replace the event.
- **Cancellation**: emit the event with `STATUS:CANCELLED`, the same UID, SEQUENCE+1, for a retention window of 30 days after the original end (so subscribers that poll infrequently still see the cancellation), then stop emitting it. Today's feed simply omits cancelled items, which relies on each client treating absence as deletion; keep that as the second line of defence, not the first.
- A dancer cancelling their own spot in a group class cancels it only in that dancer's feed; the class itself remains for others.
- `no_show` is not shown (consistent with the Google sync rule).
- Recurring series are emitted as individual occurrences (matching how appointments are stored); no RRULE in v1.
- Window: from 7 days in the past to 120 days ahead (instructor feed today uses −30d/+6 months; reduce for payload size), hard cap 1,000 events.
- Times: DTSTART/DTEND in UTC instants as today (DST-safe); `X-WR-CALNAME` = studio name + "Schedule"; `X-WR-TIMEZONE` is not required for UTC instants.
- Client refresh hints: `REFRESH-INTERVAL;VALUE=DURATION:PT1H` and `X-PUBLISHED-TTL:PT1H` are emitted, but calendar apps decide their own polling (Google Calendar typically refreshes subscribed feeds on the order of hours to a day; Apple has user-set intervals); the KB states that updates are not instant. Exact intervals are vendor-controlled and not verified here.

## 7. Privacy and detail levels
Default for everyone is `minimal`. Event-type **allowlist** (anything not listed is never emitted): private lesson, intro lesson, group class, coaching, practice party, floor rental (staff only), studio-hosted non-competition events the subject holds a ticket for. Competition-governed event classes and any class the Competition coordinator has excluded until release are not on the allowlist (the owner decides any change).
| Field | Dancer `minimal` | Dancer `standard` | Staff `minimal` | Staff `standard` |
|---|---|---|---|---|
| Title | "Private lesson" / class name | same | "Private lesson" / class name | "Lesson: <first name + last initial>" |
| Time, studio, room | yes | yes | yes | yes |
| Instructor | no | first name | n/a | n/a |
| Other participants | never | never | never | never |
| Appointment notes (internal) | **never** | never | **never** | never |
| Contact data, payments, health | never | never | never | never |
| Link back | studio portal URL (requires login) | same | staff app URL | same |
Minors (U18): dancer feeds for a dependent appear only in the guardian's account feed and only for profiles with `can_view_schedule`; staff feeds use first name + initial at most for any person under 18; no U18 data appears in descriptions. The default staff title today (full client name plus notes) is removed for migrated feeds.
No per-event free text is passed through from the studio (titles are escaped and length-capped; control characters stripped; CR/LF injection tested).

## 8. Tenant isolation
- A token resolves to exactly one `studio_id` and one `subject_user_id`; every query in the render path is filtered by that studio and by the subject's *current* visibility (staff: appointments assigned to their instructor id; dancer: appointments/attendances/tickets of profiles currently linked with `can_view_schedule`), re-evaluated on every request (no snapshot).
- The route uses the service role (no user session), so isolation is enforced in code by a single `resolveFeedSubject(token)` function used by all branches plus a unit test that fails if any query lacks the studio filter; cross-studio and cross-subject fixtures are mandatory tests.
- No endpoint accepts a `studioId`, `clientId` or `instructorId` parameter on the public route.

## 9. Caching, ETag and rate limits
- Render deterministic output (sorted by start, UID), compute a strong `ETag` over the body; honour `If-None-Match` with 304. The 304 path still validates the token, subject status and expiry first, so revocation is immediate.
- Small `Cache-Control: private, max-age=0, must-revalidate` for success; a short server-side memo (≤ 60 s) keyed by token id is allowed but must be invalidated by revocation (store the revocation check outside the memo).
- Rate limits: per token 60 requests/hour and per IP 300 requests/hour, 429 with `Retry-After`. **The existing limiter is in-memory per serverless instance and is not sufficient** (`src/lib/security/rate-limit.ts`); options for the owner/ops to choose before activation: a database-backed counter RPC, or a platform-level WAF rule on the feed path. No new infrastructure is introduced by this document.
- `last_accessed_at` write throttled to once per 15 minutes per token.
- Uniform failure: unknown, revoked, expired or disabled-studio tokens all return the same 404 body and similar timing; no DB error text is ever returned (generic 500 without detail).

## 10. Student and Business app entry points (release-train coordination via the APPS coordinator)
- Student app: a "Calendar" screen under Profile calling new endpoints on the Student API conventions (bearer auth as `getStudentApiUser`): `GET /api/student/calendar-feed` (status), `POST` (create/rotate; returns the URL once), `PATCH` (detail level, included profiles), `DELETE` (revoke). The app opens the `webcal://` URL via the OS handler; no new SDK, no WebView-only flow. Needs a Student app release slot.
- Business app and web: staff "My calendar feed" screen on the Staff API conventions (flat errors, idempotency); owner/admin management stays in the web app first, mobile later. Needs a Business app release slot only for the staff screen.
- Web portal: the same controls in `portal/[studioSlug]` and `app/settings` so the feature is usable before any app release.
- Sequencing suggestion (coordinator decides): web portal + web staff first (no store release), mobile screens in the next train.

## 11. Rollout controls
`CALENDAR_FEEDS_ENABLED` env flag (default off in every environment) plus per-studio allowlist table for pilots; the public route returns the uniform 404 when the studio is not enabled. No studio-visible UI appears until enabled. No charge, no entitlement.

## 12. Tests (developer-owned QA matrix)
Token: hash-only storage (DB dump contains no plaintext), constant-time lookup path, expiry, revoke immediate (including 304 path), rotate with and without overlap, auto-revocation hooks per reason, migration of existing instructor tokens still serving the same URL. Isolation: cross-studio, cross-subject, guardian with two dependents, a dependent removed mid-subscription, staff deactivated. Content: reschedule keeps UID and raises SEQUENCE; cancellation emits `STATUS:CANCELLED` with SEQUENCE+1 for 30 days then disappears; dancer self-cancel affects only their feed; DST boundary; allowlist excludes forbidden event classes; notes and contact data never present; U18 minimal naming; escaping and CR/LF injection; folding by octets (RFC 5545, 75 octets, UTF-8 multi-byte). HTTP: ETag/304, identical 404s, no error text, headers, rate-limit 429. Client conformance (manual evidence, BLOCKED until devices available): subscription accepted and cancellation honoured in Apple Calendar, Google Calendar, Outlook. UI: create/copy/rotate/revoke flows, one-time display, admin revoke without token visibility. Audit rows for each action.

## 13. Slices and estimates (one engineer, ±50%)
| Slice | Content | Est. |
|---|---|---|
| F-1 | Schema, hashing, resolver, kill switch/allowlist, audit, auto-revocation hooks; **plus** quick restrictive fix of the existing instructor-feed select policy (owner/admin and the instructor only) as a dark PR with PROD SQL as an owner gate | 5–7 d |
| F-2 | Renderer (UID/SEQUENCE/cancelled/allowlist/detail levels), ETag/304, uniform errors, rate-limit hook | 5–7 d |
| F-3 | Web UI: portal dancer controls, staff "My calendar feed", owner/admin management + incident revoke | 4–6 d |
| F-4 | Migration/cutover of instructor and coach feeds, deprecate plaintext column | 2–3 d |
| F-5 | Student/Staff API endpoints + mobile screens (next release train) | 6–9 d |
| F-6 | KB articles, QA evidence, client-conformance matrix | 2–3 d |
Total about 24–35 engineer-days; ICS rate-limit store is a dependency decision (§9).

## 14. Owner decisions and open items
1. Default staff `minimal` title: first name + last initial vs class name only (design default above).
2. Window length (7 days back / 120 days ahead) and retention of cancelled entries (30 days).
3. Rate-limit mechanism for the public feed path (DB counter vs platform WAF) — engineering/ops choice that may involve platform configuration (owner authorization if it changes hosting settings).
4. Whether admins may see aggregate feed usage per dancer (default: counts only, no token or detail).
5. Whether front desk and non-teaching staff get staff feeds (OD-2).
6. Authorization of any PROD SQL (policy fix, new tables, migration of tokens) — separate owner gate; none is requested by this document.
7. Verification still needed: whether `updated_at` changes on every client-relevant edit for each source table (else add the revision counter); vendor refresh intervals are not verified.
