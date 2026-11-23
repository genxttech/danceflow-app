# External judges and the shared judge API: design brief

Status: DESIGN ONLY. Nothing here is implemented, applied or deployed. No SQL file, migration or code accompanies this brief.
Base: `origin/release/website-embeds` at `ba970a67`. The staff bearer-API pattern is cited from the same branch (it carries the same files as main for the pieces used here).
Audience: owner (decisions in section 8), Competition and Apps coordinators.

Confidentiality: this describes unreleased Competition OS capability. It is for internal engineering use. It is not for directors, organizers or any outside party, and nothing here is a basis for outreach.

Every factual claim about current behaviour cites a file. Where a claim is a design proposal or something not yet verified, it says so.

## 0. Summary

1. Today a judge must hold an active seat on the event's studio team (`user_studio_roles`) or organizer team (`organizer_users`). Five separate checks enforce this, and the only path that creates an official refuses anyone outside those teams. A judge with no seat cannot be an official and cannot be given one.
2. Proposal: an event-scoped external-judge grant, created by invitation and accepted by a verified-email DanceFlow identity. The grant is an `event_competition_officials` row, so every existing ballot, lock and assignment rule keeps working. It writes nothing to `user_studio_roles`, studios, clients or leads.
3. Every E1 read gate and every OJ-1 judge-facing check calls one helper, `_comp_e1_is_team_member(uuid, uuid)`, so the smallest correct change is to widen that one helper (plus new tables, invite/accept/revoke RPCs and a COI guard). The three E1 callers (`competition_is_active_official`, `my_competition_judging_assignments`, `competition_round_panel_status`) and the five OJ-1 pinned functions then work unchanged. Some E2 paths do not use the helper (section 1.2). The alternative (rewrite all seven) is listed with its cost.
4. `/api/judge/*` is a thin bearer-JWT wrapper over the existing RPCs, event-scoped, with request-id idempotency, an offline replay contract, short-lived sessions, device binding and its own kill switch. A route-level kill switch does not stop a direct PostgREST call with the same token, so the revocation, expiry and per-event enable switches also live in the database (section 3.7).
5. Conflict of interest is enforced in the database, not the client.
6. Four owner decisions (section 8) each have a recommendation. They are unapproved recommendations.

## 1. Today's model, and why a seat-less judge cannot be an official

### 1.1 The data model

- `event_competition_officials` (E1, `20270101090000_competition_e1_officials.sql`): one row per `(event_id, user_id)` (`unique (event_id, user_id)`), `role in ('judge','scorer','chair')`, `status in ('active','inactive')`, at most one active chair per event. `user_id` references `auth.users`.
- `event_competition_panel_assignments`: `(round_id, official_id, judge_letter)`, unique per round; frozen once a round leaves `draft`/`scheduled` (`assign_competition_panel_member` raises `COMP_PANEL_FROZEN`).
- Writes happen only through SECURITY DEFINER RPCs. Table writes are revoked for every API role; `authenticated` and `service_role` hold SELECT only, behind RLS.
- E2 (`20270102090000_competition_e2_ballots.sql`): `event_competition_ballots` and `event_competition_marks` are insert-only. A correction is a new row with `supersedes_id`, `version + 1` and `correction_reason`. `event_competition_ballot_drafts` holds the callback draft. `event_competition_ballot_events` is the append-only audit that also stores idempotency request ids.

### 1.2 The five places a team seat is required

The seat test is "active row in `user_studio_roles` for the event's studio, or active row in `organizer_users` for the event's organizer". It is applied inline in items 1 and 2 and through the shared predicate in items 3 to 5 (item 3 is the predicate itself). It is not the only gate: some E2 paths count judges by `o.status` only (`_compe2_round_judges`, the lock blockers), and `_compe2_round_role` checks the seat only on its chair and scorer branches; the manager branch and `competition_round_no_shows` manager/chair path do not use the helper. Those paths do not let a seat-less person in, because they require an official row or manager authority that a seat-less person cannot get today.

1. `add_competition_official` (E1) checks the seat inline and raises `COMP_OFFICIAL_NOT_TEAM_MEMBER`. This is the only RPC that creates an official. Its checks run in this order: the event has a competition program, the target is a team member, the account has a verified email, then the chair-uniqueness rule.
2. `list_competition_official_candidates` (E1) builds its candidate list from a `team` CTE (studio roles union organizer users). A person with no seat is never offered.
3. `_comp_e1_is_team_member(p_event_id, p_user_id)` (E1) is the shared predicate. It checks `user_studio_roles` (`active = true`) and `organizer_users` (`active = true`).
4. E1 reads: `competition_is_active_official(p_official_id)` (the predicate behind the `competition_officials_own_read`, `competition_panel_own_read` policies and, in E2, the own-read policies on ballots, attendance and drafts) and `my_competition_judging_assignments()` both require `_comp_e1_is_team_member`. Without it the judge sees no assignments and no own rows.
5. OJ-1 (`20270215091000_competition_oj1_official_team_member.sql`) added the same predicate to the E2 judge-facing functions, so an official removed from the team loses access immediately: `_compe2_round_role` (chair and scorer branches), `submit_competition_ballot`, `save_competition_callback_draft`, `competition_judge_ballot_sheet`, `competition_round_no_shows` (panel judge branch; defined in NS1 `20270115090000_competition_ns1_heat_no_shows.sql`, not E2).

Two consequences:

- A seat-less person cannot be created as an official (item 1). Even if a row were inserted by other means, items 3 to 5 would make it inert.
- The only way today to make someone a judge is to give them a studio or organizer seat. That grants a role row with standing beyond judging (workspace membership, subscription-gated access, the organizer suite) and, for a studio seat, puts a person in the studio's staff table. The owner direction is that a judge needs neither a subscription nor a staff account.

### 1.3 The app layer already tolerates non-staff officials

`src/lib/competition/officials/judgingAccess.ts` `resolveJudgingViewer` returns `{ kind: "studio" }` for platform admins and for anyone with a current studio role. Everyone else is an "official" viewer whose only source of access is `my_competition_judging_assignments()`. `src/app/app/layout.tsx` (lines 934 to 940) routes `/app/judging/**` for such a viewer into the minimal `JudgingShell`, only when `competitionFinalsEnabled()`. The header comment of `judgingAccess.ts` states that the database stays the authority and the app checks only refuse earlier.

So the web path built for OJ-1 already supports a viewer with no studio role, provided the database returns assignments. The gap is in the database, and the external-judge work is a database plus API change, with little web change.

Not verified in this brief: whether an account with no workspace, no onboarding and no studio is redirected elsewhere by code before reaching the layout branch above (login redirect, onboarding gates, billing gates). The accept flow must be exercised in a browser walk with a fresh seat-less account before any claim that the web path works end to end (section 6).

### 1.4 Other facts the design depends on

- Idempotency is already per request id: `submit_competition_ballot(p_round_id, p_heat_id, p_marks, p_request_id, p_correction_reason)` -> `_compe2_insert_ballot`. A null id raises `COMP_REQUEST_ID_REQUIRED`. The replay check reads `event_competition_ballot_events` by `request_id` before the round-status check. It returns the original result (`replayed: true`, original `ballot_id` and `version`) only when the kind is `ballot_submitted` or `ballot_corrected`, the actor matches, and the stored fingerprint, round, heat and official all match. Any other reuse raises `COMP_REQUEST_REUSED`.
- Ballots are accepted while the round is `active`, or while it is `ballots_locked` AND `correction_open` is true. E2 originally allowed `active` only (`COMP_BALLOT_ROUND_NOT_ACTIVE`, also a trigger); F2 (`20270114090000_competition_f2_results_lifecycle.sql`, around lines 400-415) rewrote both the trigger and `_compe2_insert_ballot` to add the correction-open case, and `src/lib/competition/ballots/window.ts` (`ballotsAccepting`, `inCorrectionWindow`) mirrors it. A7 (`20270120095500_competition_cf1_a7_od13_correction_integrity.sql`) later redefines `_compe2_insert_ballot` again. The live function is E2 + F2 + A7, so the implementation must read the live definition, not the E2 text. Lock (`lock_competition_round_ballots`) is a manager or chair action; reopen (`reopen_competition_round_ballots`) is manager only. A reopen is refused once a result is approved (`COMP_REOPEN_RESULT_APPROVED`).
- A correction is a second `submit_competition_ballot` for the same heat with a `p_correction_reason` of 1 to 500 characters (`COMP_BALLOT_CORRECTION_REASON_REQUIRED`). I found no time-based correction window (no interval or timer on ballots). The windows are status-based: round `active`, or locked with a manager-opened correction. A7 adds judge-reachable refusals for corrections: `COMP_CORRECTION_BALLOT_NOT_PERMITTED`, `COMP_CORRECTION_BALLOT_RESTRICTED`, `COMP_CORRECTION_COSIGN_REQUIRED`, `COMP_CORRECTION_CAUSE_REQUIRED`, `COMP_CORRECTION_OPENER_CONFLICT`; their exact conditions must be read from A7 before the error table in 3.5 is final. Replay precedes the status check in the E2 text and F2 only changes the status condition; the implementation must re-confirm this in the live (A7) text. The offline contract (section 3.5) must not invent a timer that the database does not have.
- The judge identity is derived from `auth.uid()`; it is never a parameter. Verified email is required (`verified_email_for_user`, LAUNCH-SEC-1C-B).
- `finalsGate.ts`: `competitionFinalsEnabled()` is the server-side flag `COMPETITION_FINALS_ENABLED === "true"`. Every CF1 page and action calls `requireCompetitionFinals()` first. The flag is defense in depth only; the database gates stay authoritative.
- Staff bearer API (`src/lib/auth/staffApiAuth.ts`): bearer only, no cookie fallback; `createBearerScopedClient(token)` so RLS and `auth.uid()` apply; `supabase.auth.getUser(token)` verification, with an auth outage returned as 503 rather than 401; IP and per-user in-memory rate limits (`STAFF_API_IP_LIMIT` 600/min, `STAFF_API_USER_LIMIT` 240/min via `src/lib/security/rate-limit.ts`); banned or inactive accounts refused; stable JSON `code` errors; `Cache-Control: private, no-store`. `src/lib/staff/writeGuard.ts`: per-capability kill switch from `STAFF_API_WRITE_POLICY` (fail closed), plus a minimum app version gate on `X-DanceFlow-App: business/<version>/<code>/<platform>` (403 `writes_disabled`, 426 `upgrade_required`). Both patterns are the model for section 3.
  - The staff guard additionally resolves a studio workspace and its subscription status. A judge has neither, so the judge guard must replace that step with an event-grant check; it cannot reuse `requireStaffApi` as is.
  - The in-memory limiter is per server instance (stated in the comment above the limits in `staffApiAuth.ts`). That is acceptable for the staff app; section 3.8 flags it for judge day.

## 2. Proposed event-scoped judge membership

### 2.1 Principles

- One grant = one `(event, person)` = one `event_competition_officials` row. No new authority table for scoring. Everything E1/E2/OJ-1/F2 already decides keeps deciding.
- Role limited to one event. The `unique (event_id, user_id)` constraint and the `event_id` foreign keys on assignments and ballots already scope all scoring rows to that event.
- The grant never touches `user_studio_roles`, `studios`, `clients`, leads, `organizer_users` or any marketing/CRM table. Enforced by design (separate tables, SECURITY DEFINER RPCs that do not reference those tables for writes) and by test (section 6).
- Community or membership status must never create a lead or client. The accept path creates no `profiles` side effects beyond what a normal sign-up already does.
- Revocation takes effect immediately: every gate already checks `o.status = 'active'` on every call, and `deactivate_competition_official` sets `status = 'inactive'` in one statement. The new standing check (below) adds an expiry check evaluated at call time, not at login.

### 2.2 Data (new objects, all proposed)

- `event_competition_judge_invitations`: `id`, `event_id`, `email_normalized` (lowercased trimmed), `role` (v1: `judge`; see decision note 8.4), `token_hash` (the raw token is never stored), `invited_by`, `status` (`pending` | `approved` | `accepted` | `revoked` | `expired`), `approved_by`, `approved_at`, `expires_at`, `accepted_by_user_id`, `accepted_at`, `declared_conflicts jsonb`, `request_id` (unique per event for idempotency, same pattern as `event_competition_official_events_request_idx`).
- Columns added to `event_competition_officials` (nullable additions, existing rows unaffected): `access_kind text not null default 'team'` (`'team'` | `'external_judge'`), `invitation_id uuid`, `access_expires_at timestamptz` (null for team officials).
- `event_competition_judge_sessions` (section 3.4): `id`, `event_id`, `official_id`, `user_id`, `device_id`, `issued_at`, `expires_at`, `revoked_at`, `last_seen_at`.
- `event_competition_judge_conflicts` (section 4): the declared and recorded conflicts, plus the organizer override rows with their mandatory reason.
- Audit: either extend the `kind` check on `event_competition_official_events` (adding `judge_invited`, `judge_approved`, `judge_accepted`, `judge_revoked`, `judge_expired`, `conflict_declared`, `conflict_override`) or add a sibling audit table. The kind list is a check constraint, so extending it is a constraint rewrite, a pinned-text change to note in review. A sibling append-only table with the same `protect_competition_history_evidence()` trigger avoids touching E1's table; that is the recommended default.

### 2.3 Flow

1. Invite (see decision 8.4 for who may): an authorised user calls `invite_competition_external_judge(p_event_id, p_email, p_role, p_request_id)`. The function normalises the email, writes a `pending` invitation with a hashed single-use token and an expiry (default 14 days or event end, whichever is first), records the audit row, and returns the token once to the server, which emails the link. It rejects an email that already belongs to an active team official of that event (`COMP_EXTJ_ALREADY_OFFICIAL`).
2. Approve: the organizer owner (or studio owner when the event has no organizer) calls `approve_competition_external_judge(p_invitation_id, p_request_id)`. Approval and invitation are different people (separation of duty, decision 8.4). A pending invitation cannot be accepted before approval.
3. Accept: the invitee signs in or signs up through the normal DanceFlow identity flow and calls `accept_competition_external_judge(p_token, p_request_id)`. Preconditions, all checked in the database:
   - `auth.uid()` is not null and `verified_email_for_user(auth.uid())` is not null (bound credential, not merely `email_confirmed_at`, matching `verified_identity.ts`);
   - the verified email equals the invitation's `email_normalized` (the grant binds to a verified identity, not to a link possession);
   - invitation is `approved`, unexpired, unused;
   - no existing active official for `(event, user)` with a different role (same rule as `COMP_OFFICIAL_EXISTS`).
   Effect: insert into `event_competition_officials` with `access_kind = 'external_judge'`, `role` from the invitation, `access_expires_at` from event policy. The existing `guard_competition_official` trigger still requires a verified email on activation.
4. Assign: unchanged. A manager assigns the judge to rounds with `assign_competition_panel_member`. The panel-freeze rule still applies.
5. Revoke: the organizer owner (or an event manager, see 8.4 for who) calls `deactivate_competition_official` (unchanged) or a thin `revoke_competition_external_judge` wrapper that also closes judge sessions and marks the invitation revoked. Effect on the next call: `status <> 'active'` fails every gate, and sessions are revoked in the same transaction.
6. Expire: `access_expires_at` passing has the same effect as revocation without a human action (evaluated inside the standing predicate, so no cron is needed for correctness; a sweeper only tidies statuses).

Identity, not email match, stays the rule E1 states ("an official is a user_id (never an email match)"). The invitation email is used once, at accept time, to bind a verified identity to the grant; afterwards the grant is keyed by `user_id`.

### 2.4 What changes in existing functions

Smallest change (recommended): redefine one function.

| Object | Change |
|---|---|
| `_comp_e1_is_team_member(uuid, uuid)` (E1) | New body: existing studio-role / organizer-user test, OR an active external grant: an `event_competition_officials` row with `access_kind = 'external_judge'`, `status = 'active'`, `access_expires_at > now()`, whose event's `external_judging_enabled` setting is true. Keep the name, signature and grants so no caller changes. A `comment on function` records the widened meaning. |

That single redefinition makes these callers admit an external judge with no text change (they call the helper by name):

- E1: `competition_is_active_official(uuid)` (drives the own-read RLS policies of E1 and E2), `my_competition_judging_assignments()`, and `competition_round_panel_status(uuid)` (E1, around lines 797 and 801), which feeds `competition_round_panel_ready`, which O1 `start_competition_round` requires (`20270106090000_competition_o1_day_of.sql` line 409). Widening the helper therefore also changes judge counting and the chair-designated flag in panel readiness for round start: an external judge counts toward the panel. That is intended, and must be tested (6.1).
- OJ-1 (md5-pinned): `_compe2_round_role(uuid)` (md5 `a7d7a235d9522a073312807df3ff11f9` after OJ-1), `submit_competition_ballot` (`0df585c22f7680da7c83b35ec5230d29`), `save_competition_callback_draft` (`781193f0b3e19cdb964fe98cfc7e524d`), `competition_judge_ballot_sheet` (`8e129175282c88ed3590e3d162fbb47c`), `competition_round_no_shows` (`d235ea7e04836a4d1c84170279c6ffe4`).

The helper is the only function whose text changes, so the OJ-1 pins on the five callers are not disturbed. The migration must still assert the pre-state `md5(pg_get_functiondef(...))` of `_comp_e1_is_team_member` as OJ-1 does (the E1 md5 is read from DEV and from the repo at write time; this brief does not invent a value).

Cost of the smallest change: the name now says "team member" but also admits an external grant. Mitigation: the comment, and a new alias function `_comp_ej_has_event_standing` that the redefined helper delegates to, so future callers use the honest name.

Alternative: leave `_comp_e1_is_team_member` untouched, add `_comp_ej_has_event_standing`, and rewrite all seven callers by the OJ-1 pinned fragment-replace method. Cost: seven pins, seven rollbacks, more review. Benefit: no semantic drift in a name. Not recommended.

Functions that must NOT change:

- `add_competition_official` and `list_competition_official_candidates` stay team-only. They are the manager path for team officials. External judges arrive only through invitation and accept. This keeps "external" an explicit, separately audited state.
- `can_manage_event_competition` stays as is. An external judge is never a manager.
- Scorer and chair: not admitted for external judges in v1 (the accept RPC refuses them). Chair has lock and attendance powers through `_compe2_round_role`; scorer reads every ballot of an assigned round. If the owner wants an external chair, that is a follow-up with its own review (decision 8.4 note).

New functions (all SECURITY DEFINER, `set search_path = public, pg_temp`, `revoke all ... from public, anon`, grants to `authenticated` only, as the E2 judge RPCs have; E1's manager RPCs also grant `service_role`, which the new judge-facing functions should not need): `invite_competition_external_judge`, `approve_competition_external_judge`, `accept_competition_external_judge`, `revoke_competition_external_judge`, `competition_judge_open_session`, `competition_judge_close_session`, `_comp_ej_has_event_standing`, `_comp_ej_conflict_check`.

New RLS: invitations readable by event managers; an invitee reads nothing through RLS (the accept RPC takes the token). Judge sessions readable by the owning user and by managers. Conflicts readable by managers; a judge sees only their own declared conflicts.

### 2.5 Migration slot and gating

- Slot: the next free timestamp after the latest on `release/website-embeds`, which is `20270218090000_twilio_inbound_start_order.sql` at the base above. The final slot is assigned when implementation starts, after re-checking both `release/website-embeds` and main for collisions. Not chosen here.
- Order: SQL before app, like OJ-1 (the new app code depends on the new RPCs, so the app is dark until the SQL exists).
- Gating:
  1. Local isolated database (dedicated Postgres container) for the SQL tests and the proof of section 6.
  2. DEV apply only through the approved wrapper (`danceflow-ops` `sb.sh`), with preflight/postflight and md5 assertions.
  3. PROD apply is an owner gate. Nothing in this brief authorises it. The standing development authorisation covers DEV, not PROD.
- Rollback file: required, and like E1 it refuses while any external-judge evidence exists, with the rollback of the helper redefinition restoring the exact E1 text.
- Feature flags stay off by default: `COMPETITION_FINALS_ENABLED` (existing) and the new judge API switch (section 3.7). The migration is inert until an organizer enables external judging for an event and an invitation is accepted.
- Pre-migration verification for the pinned text: the OJ-1 migration shows pre/post md5 per function; the new migration repeats that discipline for the one redefined helper. Known repo hazard from earlier phases: CRLF in function bodies shifts md5; normalise with `replace(..., E'\r', '')` as OJ-1 does.

## 3. `/api/judge/*` route set

### 3.1 Principles

- Wrap existing RPCs; add no scoring logic. The judge API is transport, auth, idempotency plumbing and error mapping. Validation of marks, panel rules and round state stays in `_compe2_*`.
- Bearer JWT only, no cookie fallback (the same rule as the staff API). The Supabase client is created with the caller's token so `auth.uid()` and RLS apply; the service role is not used for judge reads or writes.
- Event-scoped: every route is under `/api/judge/events/{eventId}/...`. The guard rejects any request whose event the caller has no active, unexpired judge grant for, using the same 403 for "no such event" and "not yours" (as `requireStaffApi` does for workspaces).
- The web UI and the native screen call the same routes. The existing server-action path under `/app/judging` may keep working during rollout; the target is one contract.

### 3.2 Routes (proposed)

All under `/api/judge`. Each returns JSON with a stable `code` on error and `Cache-Control: private, no-store`.

| Route | Wraps | Notes |
|---|---|---|
| `POST /session` | `competition_judge_open_session` | exchange verified bearer for a judge session record (device id in the body); returns `sessionId`, `expiresAt` |
| `DELETE /session` | `competition_judge_close_session` | sign-out for this device |
| `GET /me` | `my_competition_judging_assignments()` | events and rounds, grouped as `groupJudgingAssignments` does; own assignments only |
| `GET /events/{eventId}/rounds/{roundId}/sheet` | `competition_judge_ballot_sheet(p_round_id)` | the judge's own sheet: entries for each heat, own current ballot, callback draft. Redaction note below |
| `POST /events/{eventId}/rounds/{roundId}/ballots` | `submit_competition_ballot` | body: `requestId`, `heatId` (null for callback), `marks`, optional `correctionReason`. Idempotent (3.5) |
| `PUT /events/{eventId}/rounds/{roundId}/callback-draft` | `save_competition_callback_draft(p_round_id, p_entry_ids)` | drafts are last-write-wins and have no request id today (3.5) |
| `GET /events/{eventId}/rounds/{roundId}/status` | a new thin read: round status only | a cheap poll so an offline client learns the round locked; the existing `competition_round_ballot_status` is manager/chair/scorer only and must not be opened to judges |
| `GET /events/{eventId}/rounds/{roundId}/no-shows` | `competition_round_no_shows(p_round_id)` | panel judge read branch (OJ-1) |

Not in the judge API: desk, lock, reopen, attendance, paper ballot entry, results, publication, organizer actions. They stay web, staff and chair paths. Chair and scorer are out of scope for external judges in v1.

Redaction: `competition_judge_ballot_sheet` currently returns `entry_number` and `display_name` for each entry, so a judge sees entrant names today. Whether the entry payload exposes competitor names or studio affiliation to an external judge, versus a bib number only, is an open product question. It matters for COI (section 4) and for judge anonymity norms. This brief does not decide it. It is listed as an open item in section 7 and must be answered before the sheet route is built.

### 3.3 Guard (`requireJudgeApi`, proposed)

Order, modelled on `requireStaffApi` + `requireStaffWrite` but deliberately different in step 1: the staff guard authenticates first and checks its write kill switch afterwards, for writes only, so a disabled capability never reveals itself to an unauthenticated caller. The judge design checks the switch first so a disabled API does no token or database work during an incident. The trade-off (reveals "disabled" to anyone) is acceptable because the route set is not secret; if the owner prefers the staff order, swap steps 1 and 2.

1. Kill switch read (3.7). Off -> 503/403 `judging_disabled` before touching the token, so a disabled API reveals nothing.
2. IP rate limit, bearer extraction, `supabase.auth.getUser(token)`; an auth outage is a 503, never a 401 (the staff API does this so a native app does not sign the user out on an outage); banned or inactive account refused.
3. Per-user rate limit.
4. Event grant check through the caller-scoped client: the caller has an active, unexpired official row for `{eventId}` (via `my_competition_judging_assignments` or the standing predicate). Otherwise 403 `not_a_judge_for_event`.
5. Session check (3.4): a live, unrevoked, unexpired `event_competition_judge_sessions` row for `(user, event, device)`.
6. Writes only: minimum app version gate (`X-DanceFlow-App`, a new app id for the judge client, same fail-closed rule as `writeGuard.ts`).

### 3.4 Judge sessions and device binding

- Supabase access tokens expire on the platform's schedule. The brief does not rely on that for judge scope. A judge session is a row, issued after verified-email login, with `expires_at` computed per event policy (decision 8.2) and `device_id`.
- Device binding: the client generates a random device id at first run and keeps it in secure storage (native keystore; for web, an HttpOnly-independent random id in IndexedDB, which is weaker). The server binds the session to that id and refuses a mismatch with `device_mismatch`. A second device means a second session (limit per judge, default 2 so a judge can carry a phone and a tablet), and the organizer can revoke by device.
- Honest limit: a device id is a binding to an installation, not hardware attestation. A stolen token plus a copied id passes. Hardware-backed attestation is a possible later step (Play Integrity / App Attest), not v1.
- Whether the Supabase JWT exposes a session identifier usable to tie a judge session to the auth session is a technical question to confirm in a spike (by reading the actual token the project issues). The design does not depend on it; the binding above is application-level.

### 3.5 Request ids, replay and the offline contract

Database facts (section 1.4): the replay check precedes the round-status check, and matches on request id + kind + actor + fingerprint + round + heat + official.

Contract for the client (native and web):

- The client generates a UUID `requestId` when the judge presses submit, stores the entire request (round, heat, marks, reason, requestId) in a local durable queue, and sends it. The same `requestId` is reused for every retry of that same logical submission. A new submission, including a correction, gets a new id.
- Server behaviour (existing RPC semantics, passed through):
  - Same id, same content: returns the original `ballotId` and `version` with `replayed: true`, even if the round has since locked. Because the replay branch comes before `COMP_BALLOT_ROUND_NOT_ACTIVE`, a ballot that did reach the server but whose response was lost is safely acknowledged after lock. The API returns 200 with `replayed: true`.
  - Same id, different content (any of fingerprint, heat, round, official): `COMP_REQUEST_REUSED` -> 409 `request_reused`. The client must treat it as a bug, drop the queue item and surface an error.
  - Missing id: the API itself rejects 400 `request_id_required` (the database also raises `COMP_REQUEST_ID_REQUIRED`).
- Errors the client must handle on replay of a queued item that never reached the server, with explicit codes in the response body (`code` plus the underlying `COMP_*`):

| Situation | Database code | API status / code | Client action |
|---|---|---|---|
| Round locked or otherwise not accepting ballots while offline | `COMP_BALLOT_ROUND_NOT_ACTIVE` | 409 `round_not_active` (+ `roundStatus`, `correctionOpen`) | Mark the item `rejected_round_closed`; keep the marks visible to the judge; tell the judge to contact the chair or a manager; do not retry |
| A correction was queued but the round locked before it arrived | `COMP_BALLOT_ROUND_NOT_ACTIVE` (unless a manager has opened a correction on the locked round, in which case the correction can succeed, subject to the A7 refusals below) | 409 `round_not_active` | Same. The original ballot stands; the correction is lost and must be re-entered after a manager reopens or opens a correction |
| A7 correction refusals (`COMP_CORRECTION_BALLOT_NOT_PERMITTED`, `_BALLOT_RESTRICTED`, `_COSIGN_REQUIRED`, `_CAUSE_REQUIRED`, `_OPENER_CONFLICT`) | as named | 403/409/422 `correction_refused` + `detail` (mapping to be fixed after reading A7 lines ~302-365) | Surface, no automatic retry |
| A correction was queued with no reason | `COMP_BALLOT_CORRECTION_REASON_REQUIRED` | 422 `correction_reason_required` | Prompt for the reason, new `requestId` |
| Another ballot landed for the same judge and heat first (two devices) | `COMP_BALLOT_CONFLICT` | 409 `ballot_conflict` | Refetch the sheet; show the server version; the judge decides whether to submit a correction (new id) |
| Judge recorded absent | `COMP_BALLOT_JUDGE_ABSENT` | 409 `judge_absent` | Stop; the chair or manager must record them present |
| Panel member removed, grant revoked or expired | `COMP_JUDGE_NOT_ASSIGNED` / `COMP_FORBIDDEN` | 403 `not_assigned` / `grant_revoked` | Stop; no retry |
| Session expired | n/a (API layer) | 401 `session_expired` | Re-authenticate; queued items remain and replay after re-login with the same ids |
| Ballot format not approved | `COMP_BALLOT_FORMAT_NOT_APPROVED` | 409 `scheme_unavailable` | Stop |
| Marks invalid for the format (incomplete, ties, out of scale) | `COMP_BALLOT_INCOMPLETE`, `_MARK_OUT_OF_RANGE`, `_JUDGE_TIE`, ... | 422 `marks_invalid` + `detail` | Fix on screen; if it happened during a replay of an old queue item, the format changed under the judge, so surface it |

- "Correction window closes while offline": in the current database the window is status-based (round `active`, or locked with `correction_open`). The contract therefore reports `round_not_active` with the current `roundStatus` and `correctionOpen`, and the status poll route lets the client show "round closed" as soon as it is back online and before it replays. If the owner wants a timer-based window (for example "corrections close N minutes after submission"), that is a new rule and a database change, and needs its own decision. This brief does not propose it.
- Order of replay: the client replays its queue oldest first, one request in flight per round, stopping a round's queue on the first terminal rejection (a later correction depends on the earlier ballot existing, since a correction needs the prior ballot as `supersedes_id`).
- Callback drafts (`save_competition_callback_draft`): no request id and no history today (last write wins, `event_competition_ballot_drafts` is keyed `(round_id, official_id)`). Offline replay of a stale draft could overwrite a newer draft from another device. Contract: the draft route is best effort and the client must send `If-Unmodified-Since`-style `updatedAt` from the last sheet; implementing that needs a small change to the draft function or a wrapper-level check. Flagged as an open item. The authoritative object is the submitted ballot, not the draft.
- The client must never retry a request with a new id "to be safe". That would be a different request and, for a first ballot followed by a duplicate, would become a correction requiring a reason. The queue guards this by persisting the id before the first send.

### 3.6 Rate limits

- Reuse `checkRateLimit` / `rateLimitKey` with keys `judge-api:ip:*`, `judge-api:user:*`, `judge-api:event:*`.
- Starting values, to be tuned from the device smoke harness: IP 300/min, user 120/min, writes per user 30/min. A judge scoring a heat makes one write per heat, and a queue replay after reconnect can burst; the replay path must back off on 429 using the `Retry-After` header that `checkRateLimit` already produces.
- Competition days concentrate many judges on one venue network. Many judges behind one NAT will share the IP bucket. Make the IP limit generous and rely on the per-user limit.
- The limiter is in memory per server instance (same as the staff API). On a multi-instance deployment the effective limit is per instance. Acceptable for abuse control, not a security boundary. Authorisation does not depend on it.

### 3.7 Kill switch (dedicated, not `COMPETITION_FINALS_ENABLED`)

- `COMPETITION_FINALS_ENABLED` turns the whole CF1 web surface on or off and is read per request on the server. The judge API must not be coupled to it in either direction: finals can be on while external judging is off, and an emergency stop on the judge API must not take the organizer workspace down.
- Proposed: a JSON policy variable `JUDGE_API_POLICY`, same design as `STAFF_API_WRITE_POLICY`: fail closed (unset, empty, malformed -> everything disabled); fields `enabled` (list of capability words: `read`, `submit`, `draft`, `accept`), `minimumCode`, `blockedCodes` per platform. Reads can be disabled independently of writes. It requires `COMPETITION_FINALS_ENABLED === "true"` as well (defense in depth: judge API is never on when finals is off).
- A route-level switch does not stop a judge who calls the existing RPCs directly through PostgREST with their own token. The existing judge RPCs are granted to `authenticated` today, and `submit_competition_ballot` is already callable that way. So the database must carry its own stops:
  - revocation and expiry (`status`, `access_expires_at`), checked on every call by the standing predicate (section 2.4);
  - a per-event `external_judging_enabled` boolean read by the same predicate. An organizer owner can turn off all external judges for one event instantly;
  - an emergency platform-wide stop: an SQL-level setting row (not env) that the standing predicate reads, which the owner flips through the gated SQL path. This is slower than the env switch and is stated as such. The env switch is the fast, route-level stop; the database switch is the complete one.
- Deployment: env changes need a redeploy or rollback (same as the staff policy), so the per-event database switch is the real-time control during a live event.

## 4. Conflict-of-interest enforcement

### 4.1 What the database knows today

No judge conflict-of-interest mechanism. The word does not appear in the E1/E2/OJ-1 migrations, and there is no conflict table or relationship graph that can answer "is this entry's competitor the judge's student, partner or family?". A related but different check exists: the 10D `competitor_conflict` integrity check (two entries sharing a participant; see `docs/competition/callback-to-final-advancement-design.md`). It could inform a derived conflict but does not concern judges.

Facts that exist and can anchor a check:

- `event_competition_competitors` (10C): `event_id`, `studio_id`, optional `user_id`, `client_id`, `instructor_id`, name, email. Anchors are unique per event and immutable once set.
- `event_competition_entry_participants` (foundation v1): per entry, `client_id`, `instructor_id`, `registration_attendee_id`, `participant_role` (`dancer`, `leader`, `follower`, `student`, `professional`, `instructor`, ...), `display_name`.
- `event_competition_heat_entries` (used by `_compe2_heat_entries`) gives the entries of a heat, excluding `scratched` ones.
- `_compe2_validate_marks` validates the ballot against `_compe2_heat_entries` and rejects unknown entries.

Facts that do not exist:

- A reliable family relationship for an arbitrary external judge. `student_identity` relationship tables exist for student/portal linking, but linkage there is between portal accounts and clients inside a studio. It is not a graph of a judge's relatives. This brief does not claim it can answer "family". It must be declared.
- A teacher/student relationship for a judge who teaches at a studio that has no DanceFlow footprint. Declared.
- A dance partner history. Declared.

### 4.2 Design

COI has two inputs, both stored per event and per judge:

1. Declared conflicts: at invitation accept time, and editable by the judge and by managers until the first round the judge is assigned to leaves `draft`/`scheduled`. Each declaration names a competitor (picked from the event's `event_competition_competitors`/entries when they exist) or a free-text person/studio for later matching, with a `relationship` (`student`, `dance_partner`, `family`, `employer_studio`, `other`).
2. Derived conflicts: computed by the database from data it holds: same `user_id` on an `event_competition_competitors` row as the judge's `user_id` (only the competitors table has `user_id`; `event_competition_entry_participants` reaches it through its `competitor_id`, added in 10C, alongside `client_id`, `instructor_id`, `registration_attendee_id`); the judge's `instructor_id`/`client_id` anchors if any exist for their identity (an external judge has none, a team-seat official might); same email as a competitor row (normalised).

Enforcement points (a database rule, not a client rule):

- `_comp_ej_conflict_check(p_round_id, p_official_id)` returns the conflicting entry ids for a judge in a round.
- Panel assignment: `assign_competition_panel_member` warns the manager (a returned `conflicts` field; changing its signature or body means it is a pinned redefinition, so the proposal is that the conflict check lives in a new wrapper `assign_competition_panel_member_checked` or a trigger on `event_competition_panel_assignments` insert, which avoids rewriting the E1 function; to be decided at implementation).
- Ballot: recommended rule (decision 8.1) is to block scoring an entry the judge is in conflict with. The cleanest hook is the existing insert guard trigger `_compe2_guard_mark_insert` (marks are insert-only and written with their ballot), extended or supplemented by a new trigger that raises `COMP_JUDGE_CONFLICT`, so every path that inserts marks, including `enter_competition_paper_ballot` on behalf of a judge, is covered, not just `submit_competition_ballot`.
- Blocking a mark for one entry makes a ballot "incomplete" for the format (ordinal majority needs a full 1..N ranking; proficiency every entry rated). So a conflicted judge cannot score the whole heat. Recommended handling: the heat is scored by the remaining panel and the conflicted judge is recorded excluded for that heat, which requires a rule the existing lock and panel-size logic does not have (`_compe2_round_blockers`, `COMP_PANEL_SIZE`). This is the hard part of COI and is not a small change. See open item 7.3. The alternative that fits today's code: do not assign a conflicted judge to the round at all.
- Override: an organizer owner records an override with a mandatory reason (1 to 500 chars) in the conflicts table. The override row is the authority the trigger consults. Overrides are audited and visible to the managers; the judge is told an override exists.
- Revocation of a declared conflict by the judge alone is not allowed: a declaration can be added by the judge, removed only by a manager with a reason.

### 4.3 Honest limits

- A judge who does not declare a relationship the database cannot see will not be blocked. The rule is best effort plus audit. This is why declaration is mandatory at accept time (an explicit "I have no conflicts" or a list), and why the derived checks exist.
- Matching free-text declarations to competitors is fuzzy. v1 should use only structured picks plus exact normalised email, and surface unmatched declarations to the manager for review before the round opens. No automatic name matching.

## 5. Shared versus owned: Business native screen and responsive web judge UI

Shared (one contract, defined once):

- The API of section 3 and its error-code table.
- A typed client contract (request/response shapes, error `code`s, the offline queue item shape, status enums). Proposed as a documented contract plus generated or hand-mirrored types, in the style of `docs/mobile/Staff_API_Contract.md`.
- Mark schemes and validation for display: `src/lib/competition/ballots/schemes.ts` (referenced by the E2 migration header as shared with the SQL rules). The database remains the authority, the client only avoids sending requests that would be refused.
- Copy for error codes.
- The offline queue semantics (persist before send, id reuse, replay order, stop-on-terminal) as a written spec and shared test vectors, implemented once per platform.

Owned by the native screen (Business app): secure token and device-id storage, durable queue (local database), background replay, reduced-latency screen and haptic scoring flow, app-version header, push notification if ever used, device smoke harness.

Owned by the responsive web judge UI: the browser-session variant of the session (`device_id` in IndexedDB, with the weaker binding stated), service worker or an in-page queue if offline is supported at all on web (v1 may be "online required, with graceful retry" on web; native carries the full offline claim), the existing `/app/judging` pages as the starting point, and the invite-accept landing page (a person with no app installed accepts in a browser).

The invite accept is web-first by necessity: the invitee has no account.

Not duplicated: no second validation path, no second idempotency scheme and no second place that decides who may score.

## 6. Test plan and acceptance criteria

Evidence rules: functional QA is owned by engineering and results are PASSED only with evidence; a case that was not run is BLOCKED, not PASSED. SQL tests run on the isolated local Postgres first. Never call revoked functions through PostgREST as anon/service on the shared QA stack (a known segfault quirk on that stack, recorded in earlier phases).

### 6.1 SQL tests (database)

1. Seat-less judge: a user with no `user_studio_roles` and no `organizer_users` row cannot be added by `add_competition_official` (still `COMP_OFFICIAL_NOT_TEAM_MEMBER`), and can become a judge only through invite -> approve -> accept.
2. Accept preconditions: unverified identity refused; email mismatch refused; unapproved refused; expired refused; replayed token refused; second accept for the same event idempotent (request id).
3. No leakage of authority, asserted by row counts before and after the full invite -> accept -> assign -> submit -> revoke cycle: zero new rows in `user_studio_roles`, `studios`, `clients`, `profiles` beyond the sign-up identity, `organizer_users`, leads/marketing tables; `can_manage_event_competition(event)` false for the judge.
4. Event scope: a judge granted event A has no assignments, sheet, ballot rights or own-read rows for event B (including via `competition_is_active_official` and RLS reads).
5. Revocation: after `deactivate`/`revoke`, the very next call to each of `my_competition_judging_assignments`, `competition_judge_ballot_sheet`, `submit_competition_ballot`, `save_competition_callback_draft`, `competition_round_no_shows` and the own-read RLS selects returns no access, with no sleep or cache. Expiry (`access_expires_at` in the past) behaves the same. Per-event `external_judging_enabled = false` behaves the same.
6. Team officials unchanged: all existing E1, E2, OJ-1 SQL tests (`test_T_competition_e1_officials.sql`, `test_T_competition_e2_ballots.sql`, `test_T_competition_e2_p1fix.sql`, `scripts/qa/oj1/oj1-sql-proof.sql`) pass unchanged, and a removed team official still loses access.
7. md5 pins: after the migration, the five OJ-1 functions have their post-OJ-1 md5 unchanged; the helper has the new pinned md5; the rollback restores the E1 text exactly.
8. COI: derived conflict by shared `user_id`; declared structured conflict; blocked mark insert for a conflicted entry through both `submit_competition_ballot` and `enter_competition_paper_ballot`; override requires a reason and is audited; override by someone other than the organizer owner refused.
9. Idempotency regression: same request id replays after lock; changed content with the same id -> `COMP_REQUEST_REUSED`.
10. Insert-only: `UPDATE`/`DELETE` of ballots and marks still refused.
11. Grants: `anon` can execute none of the new functions; `authenticated` only the intended ones.

### 6.2 API tests

- Unit and integration tests in the style of `src/app/api/staff/__tests__` (`staffApi*.test.ts`, `localStack.staffApi*.test.ts`): 401 with no bearer or a cookie only; 503 on auth outage not 401; banned account; kill switch off for each capability; fail-closed on a malformed policy; event scope (404/403 same shape); rate limits (IP, user) including `Retry-After`; version gate (426); device mismatch; session expiry; error-code mapping table in 3.5, one test per row.
- Replay: send, drop the response, resend with the same id: 200 `replayed: true`. Lock the round, resend: still 200 `replayed: true`. New id after lock: 409 `round_not_active`.
- Direct-RPC bypass test: with the API switched off, a direct RPC call by a valid judge still works unless revoked, expired or per-event disabled. This test documents the real boundary; it is expected, not a defect.

### 6.3 End-to-end and device

- Playwright walk (web): invite as manager, approve as organizer owner, accept in a fresh browser with a new account that has no studio, score a round, revoke mid-round and confirm the next action fails. Includes the open check from 1.3 (no redirect to onboarding or billing for a seat-less account).
- Device smoke harness on a physical Android device and an emulator (Apps owns the harness): airplane-mode scoring of a heat, reconnect, replay; kill the app mid-queue; round locked while offline; session expiry while offline; second device on the same judge; clock skew.
- Shared Gradle rules apply to every Android build run for this (one build at a time, `--no-daemon`).

### 6.4 Acceptance criteria

A change set is accepted when:
1. Every item in 6.1 passes with evidence on the isolated database, then on DEV after the gated apply. PROD is separate and owner-gated.
2. The team-official regression (6.1 item 6) shows no behaviour change.
3. The authority-leak assertion (6.1 item 3) is exact (row counts equal), not "no errors".
4. The offline replay table in 3.5 is covered by tests and by at least one device run per row that the native client can produce.
5. A reviewer who did not write the migration confirms every changed or added function against its pre-state text.
6. The two kill switches and the per-event switch are each exercised on the DEV deployment, and the runbook states which stops are instant (database) and which need a redeploy (environment).
7. Nothing is exposed on a public page, a marketing page or a status label until the owner approves disclosure.

## 7. Open technical items (not owner decisions)

1. Whether the web path works end to end for a seat-less account (redirect behaviour before `/app/layout.tsx` line 934). Verify in the browser walk.
2. Entry redaction on the judge sheet (names, studios, bibs only). Affects COI and judge norms. Needs a product decision before the sheet route is built.
3. COI blocking interacts with lock and panel-size rules (`COMP_PANEL_SIZE`, "every assigned judge needs a ballot for every heat, or a recorded absence"). A per-heat conflict exclusion needs a rule in `_compe2_round_blockers`, a change in a function this brief has not read in full. Before implementation, read it and choose between "never assign a conflicted judge" (fits today's code) and "exclude per heat" (new rule).
4. Draft last-write-wins across devices (3.5).
5. Whether the Supabase JWT carries a session id usable for session tying (3.4, spike).
6. Chair or scorer as external. Out of v1.
7. In-memory rate limit on a multi-instance deploy.
8. Slot number and the exact pre-state md5 of `_comp_e1_is_team_member` (read from the repo and DEV at implementation).

## 8. Owner decisions

These are recommendations. The owner has not approved any of them.

### 8.1 Conflict-of-interest rule

Options:
- A. Disclosure only: judges declare, managers see it, nothing is blocked. Cheapest. A conflicted judge can still score. Weak defence in a dispute.
- B. Block scoring of entries containing the judge's own student, dance partner or family member (database rule), organizer override only with a recorded reason. Strong and auditable; limited by what can be declared (section 4.3) and requires the lock-rule work in 7.3.
- C. Block plus automatic recusal from the whole round for any conflict. Simplest to reason about; may leave a small panel short (a round needs the panel-size minimum).
- D. Block on any studio affiliation with a competitor. Broad; hurts small-community events where most judges are affiliated somewhere.

Recommendation: B. It matches the owner's stated intent and is the only option that holds up if a result is challenged, with the declared-conflict limitation stated openly to organizers.

Cost of B: moderate. It needs a conflicts table, a trigger, and the lock-rule decision in 7.3. If 7.3 proves large, a fall-back is C for v1 (never assign a conflicted judge) and B afterward.

### 8.2 Judge session length

Options:
- A. Fixed 12 hours. Simple. Long for a stolen device after the event.
- B. Event day plus a grace period (for example event end + 12 hours), re-verify the email once per event, length configurable per event within a platform maximum.
- C. Short rolling sessions (for example 60 minutes idle), re-login often. Strongest. Painful in a ballroom with poor reception and a judge mid-heat.
- D. Same as staff sessions (the existing Supabase session). No new work; no event-scoped bound, so it outlives the event.

Recommendation: B. Judges work a defined day. The grant carries `access_expires_at`, and the session cannot outlive it. Re-verifying the email per event proves the person still controls the invited address, and the offline queue is exempt only while a valid session exists, so the app must warn the judge before expiry. A platform maximum (for example 48 hours after event end) bounds a misconfiguration.

### 8.3 Showcase feedback in v1

Options:
- A. Out of v1. v1 covers competition scoring only.
- B. In v1: free-text comments and per-criterion feedback for showcase divisions, delivered to competitors.

Recommendation: A. Feedback adds a second write type with no idempotency or immutability design today, a new competitor-facing read path (judge identity is never exposed to entrants today: E1 states no public or entrant reader exists), moderation questions and a larger privacy surface. None of that is needed to prove external scoring. Revisit after v1 is accepted. Nothing here blocks adding it later: it would be a new insert-only table and route.

### 8.4 Who may invite external judges

Options:
- A. Any event manager (as `can_manage_event_competition` defines it: studio owner/admin, organizer owner/admin/staff, platform admin) invites and approves. Fast; one person can bring in a judge unchecked.
- B. Event manager invites; the organizer owner approves or revokes; the role is tied to one event. Separation of duty; one extra step.
- C. Platform admin only. Safest; does not scale and makes DanceFlow staff a bottleneck on event day.
- D. Organizer owner only for both. Simple; blocks a coordinator who does the legwork.

Recommendation: B. The people who run the logistics invite; the accountable owner approves; revocation by either is immediate (invite withdrawal) or by the owner (granted access). Where an event has no organizer (a studio-run event), the studio owner takes the owner role. Scope is exactly one event. The invite function needs a predicate stricter than `can_manage_event_competition` for approve/revoke (owner only); that predicate is new and is listed in 2.4.

Related note: chair and scorer remain team-seat roles in v1 (section 2.4). If the owner wants an external chair, say so now, because it changes the review depth (chair holds lock and attendance authority).

## 9. Prerequisites from Apps, and what Apps must NOT build yet

Prerequisites (Apps owns):

1. Bearer verification helper reusable beyond staff: extract the generic part of `resolveStaffUser` (rate limit -> bearer -> `getUser` -> transient-failure handling -> banned/inactive check) so judge and staff guards share it. Today it is coupled to workspace and profile logic. This is an Apps-owned change to code Apps owns, and it must not alter the staff API's behaviour (the staff test suite is the regression check).
2. Write guard and kill switch generalised: a policy parser and header/version gate usable with a different app id and capability list (today `writeGuard.ts` hard-codes `business/` and the staff capabilities).
3. Device smoke harness on a physical device and emulator, able to run the offline scenarios of 6.3, under the shared Gradle rules.
4. A judge-capable build channel (a new app id or a role-aware Business build). Which one is an Apps decision; the API contract does not depend on it beyond the `X-DanceFlow-App` header value.
5. Secure storage and a durable local queue library chosen and proven (power loss mid-queue).

Apps must NOT build yet:

- Any judging screen, judge login, accept-invite or queue UI. The database and API contract are not approved.
- Any call to `/api/judge/*` or to the E1/E2 RPCs from native code.
- A second copy of marks validation as an authority.
- Anything that implies external judges exist in store listings, release notes or marketing (confidentiality at the top of this document).
- Chair, scorer, desk, lock, results or organizer screens for external users.
- Any change to staff API behaviour as part of the extraction in prerequisite 1, beyond refactoring under the existing tests.

## 10. Sequencing proposal

1. Owner answers section 8 (one pass).
2. Competition: resolve 7.2 and 7.3 (read `_compe2_round_blockers`; decide redaction), then write the SQL design addendum with exact pins.
3. Local isolated DB: migration + SQL tests. Reviewer reads against pre-state.
4. API routes behind `JUDGE_API_POLICY`, dark, with Apps' extracted helpers.
5. DEV apply (gated wrapper), DEV validation.
6. Apps: device harness runs, then native screen. Web judge UI from the existing `/app/judging` pages.
7. Owner gate for PROD SQL and for enabling anything. Nothing in this sequence is authorised by this document.

## 11. Source index

- `src/lib/supabase/migrations/20270101090000_competition_e1_officials.sql`: tables, `guard_competition_official`, `_comp_e1_is_team_member`, `competition_is_active_official`, policies, `add_competition_official`, `list_competition_official_candidates`, `deactivate_competition_official`, `assign_competition_panel_member`, `my_competition_judging_assignments`.
- `src/lib/supabase/migrations/20270102090000_competition_e2_ballots.sql`: ballots/marks/drafts/events, `_compe2_round_role`, `_compe2_insert_ballot`, `submit_competition_ballot`, `competition_judge_ballot_sheet`, lock/reopen, RLS.
- `src/lib/supabase/migrations/20270215091000_competition_oj1_official_team_member.sql`: the five pinned redefinitions and their md5s.
- `src/lib/supabase/migrations/20261107090000_phase10a_competition_foundation_reconcile.sql`: `can_manage_event_competition`.
- `src/lib/supabase/migrations/20261009090000_launchsec1cb_verified_email_enforcement.sql`: `verified_email_for_user`.
- `src/lib/supabase/migrations/20261109090000_phase10c_competitor_registration.sql`: `event_competition_competitors`.
- `src/lib/supabase/migrations/20260620_competition_foundation_v1.sql`: `event_competition_entry_participants`.
- `src/lib/competition/officials/judgingAccess.ts`, `judging.ts`, `contract.ts`; `src/app/app/judging/**`; `src/app/app/layout.tsx` (lines 934 to 940); `src/lib/competition/finalsGate.ts`.
- `src/lib/auth/staffApiAuth.ts`, `src/lib/staff/writeGuard.ts`, `src/lib/security/rate-limit.ts`, `src/lib/auth/studentApiAuth.ts`, `src/app/api/staff/**`.
