# TW-4F: recurring-fee lifecycle, operational database controls (PR 1 of 3, design, 2026-10-21)

Baseline: `main` 78cb881e (the recurring-fee lifecycle, `20261209090000`, merged and dark). This slice adds `20261211090000_twilio_rfl_ops.sql` (rollback `rollback/20261211090000_twilio_rfl_ops_rollback.sql`). It is database only: PR 2 (delivery runner) and PR 3 (platform panel) code against the interfaces below. Local and synthetic only: no hosted SQL, no Twilio call, no number purchase / cancellation / release, no Stripe, no SMS, no email, no flag enabled, no schedule registered.

## 1. Decisions applied (owner-approved)

| | Decision | Where it lives |
|---|---|---|
| D1 | Notifications use the existing idempotent outbound email queue; studio alerts go to verified active owners, platform exceptions to platform administrators; no Twilio SID, credential, token, provider cost, balance or cents in any email body; dedupe `rfl:<alert-id>:<recipient-ref>`; auditable delivery status | `tw4_rfl_alert_recipients`, `tw4_rfl_alert_delivery_record` (the email itself is PR 2) |
| D2 | Fixed windows: 7-day grace (unchanged), 35-day authorization notice (unchanged), 14-day escalation (new) | `tw4_rfl_scan_entity` |
| D3 | Dual control: two DISTINCT platform administrators for absorbing an exposure and for authorizing the cancellation of a provider NUMBER; bound, single use, auditable, invalidated on change, 24 h expiry; safety suspension never waits | `tw4_rfl_dual_*`, enforcement inside `tw4_rfl_exposure_dispose` and `tw4_rfl_cancel_authorize` |
| D4 | The cumulative $150 ConfiDance ceiling is never released or replenished automatically; no standing authorization ever; `tw4_rfl_pilot_cover` unchanged | nothing here touches reservations, ceilings or authorizations |
| D5 | Never bill a studio retroactively for unauthorized provider cost: variances are recorded, acknowledged, DanceFlow-borne | `tw4_rfl_variance_report`, `tw4_rfl_variance_ack` (no ledger access) |
| D6 | Build readiness, heartbeat, health, kill switches; NO `vercel.json` cron entry; no flag enabled | `tw4_rfl_set_switch`, `tw4_rfl_scan_begin/finish`, `tw4_rfl_health` |

Every kill switch FAILS CLOSED: default OFF, the absence of a log row is OFF, an unknown switch name is OFF.

## 2. Objects

All functions are `security definer` with a pinned `search_path`, revoked from `public`, `anon`, `authenticated` and granted to `service_role` only; every new table has RLS on and no API-role privilege (the functions are the only way in), a guard trigger (append-only or graph-checked, never deleted) and a truncate guard. Errors use the `TW04x` family, `42501` (not an administrator / requester approving) and `22023` (invalid input).

### 2.1 Kill switches
- `studio_sms_rfl_switch_log` (append-only): `switch` in (`scan`, `delivery`), `enabled`, `changed_by`, `reason`, `changed_at`.
- `tw4_rfl_set_switch(switch, enabled, actor, reason) -> {switch, enabled}`: platform administrator, reason 10 to 300 characters, audited (`rfl_switch_set`; the audit row hangs on the first linked location because the switch has no location of its own, the log row is the authoritative record).
- `tw4_rfl_switch_enabled(switch) -> boolean`: latest row wins, no row = false.
- `tw4_rfl_alerts_claim(limit)` (same signature, replaced body): returns no rows while `delivery` is off, so the application cannot deliver (and attempts are not consumed) with the switch off. Everything else about the claim (5 attempts, 15-minute stale reclaim, skip locked) is unchanged.

### 2.2 Scan heartbeat and health
- `studio_sms_rfl_runs` (append-only evidence; a run finishes once): one running row at a time (unique index), `lease_expires_at`, a counts-only `summary`.
- `tw4_rfl_scan_begin(runner, lease_seconds = 600) -> {ran, reason, run_id}`: `reason` is `switched_off` (scan switch off; nothing is recorded) or `busy` (another unexpired lease). An expired lease is closed as `failed` first, so a crashed runner never blocks the next. Serialized by an advisory lock; five concurrent callers get exactly one lease (tested).
- `tw4_rfl_scan_finish(run_id, status, summary, error) -> {updated}`: `completed` or `failed`; the summary must be a flat object of numbers (counts only; text, nesting and arrays are refused); the error is cut at 300 characters; final once (a second call, or a call for a run already closed as failed by lease expiry, returns `{updated: false}`).
- `tw4_rfl_health(actor)`: `scan_switch`, `delivery_switch`, `last_run_at`, `last_success_at`, `last_status`, `stale` (no completed run in 26 hours, or never), `runs_failed_24h`, `alerts_pending`, `alerts_failed`, `alerts_exhausted`, `oldest_pending_alert_age_seconds`, `open_exposure_count`, `open_cancel_operations`.

### 2.3 Reports (administrators; cents appear here and never in an email)
- `tw4_rfl_exposure_report(actor)`: open exposure, oldest first, with `aging_bucket` (`0-7`, `8-30`, `31-90`, `90+` by whole days since first detection), expected and billed cents, and `dual_request_status` (`pending` / `approved`, unexpired only).
- `tw4_rfl_variance_report(actor)`: recorded recurring-kind provider charges with status `variance`, newest first, with acknowledgement state.
- `tw4_rfl_variance_ack(charge, actor, note)`: note 10 to 500; one append-only acknowledgement per charge (a second call is a replay), outcome fixed `dancflow_borne`, audited (`rfl_variance_acked`). It never reads or writes a credit ledger, balance, reservation or authorization (tested by comparing the account before and after).

### 2.4 Escalation (replaces `tw4_rfl_scan_entity`, every existing behaviour kept)
For each active authorization of a business with a live resource of its fee, ending within 14 days, with no later-ending active authorization of the same location and fee (no renewal): `owner_notice_second` (audience `both`, dedupe `auth2:<authorization id>`) and `owner_unresponsive` (audience `admin`, dedupe `auth:<authorization id>:escalate`). The 35-day `authorization_expiring` notice is untouched. Summaries contain no amount, SID or token.

`tw4_rfl_escalate_delivery() -> {escalated}`: every alert that failed 5 times (or whose 5th claim was abandoned for more than 15 minutes) becomes ONE `alert_delivery_exhausted` admin alert (dedupe `exhausted:<alert id>`). An exhausted escalation is not itself escalated (that would never end); it shows in `tw4_rfl_health.alerts_exhausted`.

### 2.5 Recipients and the delivery record
- `tw4_rfl_alert_recipients(alert) -> (recipient_kind, user_id, studio_id, email, email_verified)`: owners = active `studio_owner` roles of the alert's location, or of EVERY location of the alert's legal business when the alert has no location; the role row must belong to a location linked to the alert's own business (an alert that names another business's location returns no owner); admins = `profiles.platform_role = 'platform_admin'`; the alert's audience is honoured; only users with a non-empty email, a confirmed email, not deleted and not banned; one row per owner (a multi-location owner is one recipient), at most 5 owners and 10 administrators; nothing for an unknown or already delivered alert.
- `studio_sms_rfl_alert_deliveries` + `tw4_rfl_alert_delivery_record(alert, claim_token, recipient_ref, recipient_kind, outcome) -> {recorded, replayed}`: needs the alert's CURRENT claim token and `sending` status (else `{recorded: false}`); `recipient_ref` is `<kind>:<user id>` (or `<kind>:none` for `no_recipient`), never an email address (a CHECK enforces the shape); unique per (alert, recipient); a replay keeps the first outcome; audited (`rfl_alert_delivery`) without any address.

### 2.6 Dual control (D3)
- `studio_sms_rfl_dual_requests`: `absorb_exposure` (resource + period) or `cancel_number` (resource + normalized approval reference); `facts_hash`; status `pending` -> `approved` | `rejected` | `expired` | `invalidated`, `approved` -> `consumed` | `rejected` | `expired` | `invalidated`; decided states are final. The table itself requires that an approved or consumed request names a decider different from the requester (CHECK), that its binding never changes, and that status moves only through the functions (a transaction-local flag, the same device the lifecycle guards use).
- Bound facts (`facts_hash`, SHA-256): legal business, resource id, provider state, action, period, exposure state / expected cents / billed cents (absorb), ids of open cancellations of the resource, normalized approval reference (cancel), digest of the reason. A new provider bill, a new open cancellation, a changed reason or reference, a closed exposure all change it. Scan refreshes (last-detected time, reason text) deliberately do not.
- `tw4_rfl_dual_request(actor, action, resource, period, reason, approval_ref) -> {request_id, facts_hash, expires_at, status, replayed}`: administrator; reason 10 to 500; absorb needs the period of an OPEN exposure (or one the disposition would itself record: uncovered and past grace); cancel needs a phone number, an active resource, no open cancellation and an approval reference (10 to 200 characters) not already used by any permanent reference. One open request per action, resource and period: the same facts return the same request (also for the other administrator); an expired one is closed; one whose facts moved is invalidated and replaced.
- `tw4_rfl_dual_approve(request, actor, note) -> {status}`: note 10 to 500; a platform administrator DIFFERENT from the requester (`42501` otherwise, also enforced by the table); an expired request is closed `expired`; facts are recomputed and a mismatch sets `invalidated` and refuses (both outcomes are returned, not raised, so the status persists); concurrent approvals decide exactly once (the loser gets `TW041`).
- `tw4_rfl_dual_reject(request, actor, note)`: any administrator, including the requester (withdraw), while pending or approved.
- `tw4_rfl_dual_list(actor)`: pending and approved, unexpired requests with the bound facts (`approval_ref` and `resource_kind` are extra keys for the approver's screen).
- ENFORCEMENT (same signatures, bodies replaced with only the intended additions):
  - `tw4_rfl_exposure_dispose(..., 'absorbed', ...)` needs an approved, unexpired request for the same resource and period whose reason equals the supplied note and whose facts hash still matches; it consumes it in the same transaction as the disposition. It runs AFTER the replay and closed-state checks (so replaying an already recorded disposition needs no new approval and consumes nothing) and before anything is written. `not_billed_confirmed` is not gated.
  - `tw4_rfl_cancel_authorize` for `resource_kind = 'number'` needs the same for `cancel_number` (same normalized approval reference and reason). It runs AFTER every older refusal (reference reuse, open operation, `policy_lapse` on a number `TW042`, live sender `TW041`, lapse age) and the replay, and before the reference is registered. Campaign and Messaging Service cancellations are not gated.
  - Error `TW042` when the approval is missing, pending, expired, consumed, bound to something else, or its facts moved (the failed call rolls back, so nothing is consumed).
  - Both take the location link lock first (`_tw4sr_lock`), then the business and credit locks (`_tw4rfl_lock`): the order R2b's activation and the lifecycle's `tw4_rfl_suspend_df` / `tw4_rfl_cancel_finish` already use. A concurrent mix of suspension, campaign cancellation, scan, request, approval and disposition on one location was run three times without a deadlock.
- `tw4_rfl_suspend_df` (immediate safety suspension of sending) is not touched and never waits for an approval (tested: sending stops, nothing is requested). `tw4_rfl_pilot_cover` is not touched.

### 2.7 Review hardening (applied in the same migration)

- **Permanent invalidation (F1).** `studio_sms_rfl_fact_epochs(resource_id, epoch)` only ever increases. Triggers bump it on a cancellation insert / status change, an exposure state / billed cents / bill references / disposition / expected-cost change (a bill-carrying or non-open insert too) and a resource provider-state change; NOT on a scan's last-detected / reason touch and not when an exposure row is first recorded open without a bill. The epoch is part of `facts_hash`, so a fact that changes and reverts (a cancellation opened then withdrawn, an exposure covered then reopened) never restores an earlier approval. A refusal at consumption raises (and rolls back), so `tw4_rfl_dual_approve`, `tw4_rfl_dual_list` and a later `tw4_rfl_dual_request` also mark such a request `invalidated` (audited `rfl_dual_invalidated`) on their non-raising paths. `tw4_rfl_dual_list` therefore writes (it skips rows another transaction holds).
- **Decision type bound (F2).** `tw4_rfl_dual_request(actor, action, resource, period, reason, approval_ref, decided_by default null)`: required for `cancel_number` (`owner_written` | `founder_written`; `policy_lapse` and anything else is refused `22023`), must be null for `absorb_exposure`. It is stored (`cancel_decided_by`), part of the hash, and compared in `tw4_rfl_cancel_authorize` (`p_decided_by` must equal it). The old six-argument call form still works for absorb via the default.
- **Born pending (F3).** A BEFORE INSERT trigger forces `status = pending` and nulls every decided / consumed field, so an owner-level insert cannot fabricate an approved row.
- **Requester standing (F5).** At approval, at listing and at consumption the REQUESTER must still be a platform administrator; expiry is judged with `clock_timestamp()` (a long transaction cannot use an approval that expired meanwhile).
- **Truthful escalation text (F4).** The second notice says the authorization "has not yet been renewed"; the escalation says "reminders were queued for the owner". Dedupe keys unchanged. The "no later-ending authorization" sub-condition matters across the two campaign kinds of one fee (only one ACTIVE authorization exists per location and kind).
- **Deterministic switches (F7).** The log carries a `bigserial seq`; the latest row is ordered by `changed_at desc, seq desc`. `tw4_rfl_scan_begin` closes an expired running lease as failed even while the scan switch is off (health never shows `running` forever).
- **Privacy of admin-addressed email.** Admin emails are queued under a studio in `outbound_deliveries`, whose SELECT policies let that studio's staff read recipient / subject / body. Every SELECT policy open to API roles is rewritten from its LIVE definition to `(<existing predicate>) and not coalesce(template_key like 'platform_rfl_admin_%', false)`; the originals are kept in `studio_sms_rfl_policy_backup` and the rollback restores them exactly. The migration refuses if there is no such policy or one already carries the marker. Service role and the table owner are unaffected.
- **UI contract.** `tw4_rfl_admin_overview` resources[] now also carry `open_cancel_operation_id` (every existing key kept); `tw4_rfl_dual_list` keeps `approval_ref` and `resource_kind` (and adds `cancel_decided_by`, also exposed as `decided_by`: the decision type, null for an absorption).

## 3. What fails closed (summary)

| Situation | Behaviour |
|---|---|
| No switch row, unknown switch, `null` | OFF |
| Scan switch off | `scan_begin` returns `{ran: false, reason: 'switched_off'}` and records nothing |
| Delivery switch off | `tw4_rfl_alerts_claim` returns no rows; no attempt is consumed |
| Absorption / number cancellation without an approved request, expired, consumed, stale facts, different reason or reference | `TW042`, nothing changed |
| Requester approving their own request | `42501` (function) and a CHECK violation (table) |
| Crashed runner | its lease expires; the next `scan_begin` closes it `failed` |
| `tw4_rfl_health.stale` | true when there is no completed run in 26 hours (or ever) |

## 4. Not done here (explicit)

No delivery (PR 2), no panel (PR 3), no `vercel.json` entry, no switch turned on, no SQL applied to DEV or PROD, no change to `tw4_rfl_suspend_df`, `tw4_rfl_pilot_cover`, the sending gate or the recurring charge. Nothing in the new objects calls Twilio, charges a studio, posts to a credit ledger or extends an authorization (a static guard in `rflOpsMigrationShape.tw4rflops.test.ts` pins this for the migration text; the real-schema suite pins it for the account before and after).

## 5. Activation steps for the scheduler (DRAFT: a separate, owner-approved step; none of this is done by this PR)

1. Apply `20261211090000` to DEV, run `localStack.tw4rfl.test.ts` and `localStack.tw4rflops.test.ts` against an isolated clone; review the PR 2 and PR 3 branches against the same database.
2. Apply to PROD in numeric order (after `20261209090000`), with the application of PR 2 / PR 3 promoted only afterwards (the migration is dark: until a switch is turned on nothing is claimed or run). Rollback: application first, then `rollback/20261211090000_twilio_rfl_ops_rollback.sql` (refused once any switch row, run, delivery record, acknowledgement or dual-control request exists: forward-fix only from then).
3. With the owner's approval, set `SMS_FEE_LIFECYCLE_SCAN=on` for the environment, then turn the scan switch on with `tw4_rfl_set_switch('scan', true, <admin>, '<written reason>')`. Run the route once by hand and read `tw4_rfl_health` (`last_status = completed`, `stale = false`).
4. Only after a clean first week, and the D1 email path verified end to end with a test alert to an administrator, set `SMS_FEE_LIFECYCLE_DELIVERY=on` and turn the delivery switch on the same way. Deliveries are at-least-once with a deterministic queue key, so a retry never duplicates an email.
5. Register the daily schedule in `vercel.json` last (D6), as its own reviewed change. Daily is enough: the longest window is 14 days and the gate's grace is 7.
6. To stop at any time: turn the switch off (immediate; the next claim or begin returns nothing). Turning a switch off never loses an alert: pending alerts stay in the outbox.

## 6. Tests

- `src/lib/sms/twilioIsv/__tests__/localStack.tw4rflops.test.ts`: real-schema scenarios (switches, heartbeat and lease, concurrency, health, reports and their boundaries, escalation, recipients and tenant isolation, delivery record, dual control end to end including binding, invalidation by a new bill / new open cancellation / changed reason, expiry by back-dating, reject, single-use under concurrent callers, number cancellation, ConfiDance ceiling, privileges, vocabularies, no-ledger guards, byte-identity of every untouched lifecycle function).
- `src/lib/sms/twilioIsv/__tests__/localStack.tw4rfl.test.ts`: existing scenarios keep every assertion; the ones that absorb an exposure or authorize a number cancellation first record the approved dual-control request (helpers `absorb` / `authorizeCancel`), and the two alert-claim scenarios switch delivery on for their duration (`withDelivery`).
- `src/lib/sms/__tests__/rflOpsMigrationShape.tw4rflops.test.ts`: static guards (each replaced function differs from its predecessor only by the intended additions, md5 preconditions, the rollback restores the predecessors byte for byte and drops everything new, vocabularies extended from live definitions, nothing calls Twilio or a ledger, no schedule registered).

## 6a. Running the real-schema suites

`localStack.tw4rfl.test.ts` and `localStack.tw4rflops.test.ts` share ONE database and the GLOBAL switch / run state: run them SERIALLY (`vitest run --no-file-parallelism`, or one after the other), or give each its own database; never two at once against one database. Each scenario restores the switch state it found; "no row" checks run inside a transaction that is rolled back; the only direct fixture edits are of rows a suite created or of runs still marked running (closed as failed). Migrations apply in numeric order (`20261208`, `20261209`, `20261211`) and were tested together.

## 7. Resolved ambiguities and residual notes

- `alerts_exhausted` counts failed alerts with 5 or more attempts AND a claim abandoned (older than 15 minutes) at the fifth attempt: that alert is never claimable again, so it is as exhausted as a failed one. `alerts_pending` is status `pending` only (retryable `failed` ones are in `alerts_failed`).
- The platform-level switch audit row needs a location (`studio_sms_onboarding_audit.studio_id` is mandatory): it hangs on the first linked location, as the existing usage switch does. With no linked location the log row is the only record.
- The variance acknowledgement is one per charge ever; a later call by anyone, with any note, is a replay and changes nothing.
- A rejection or approval of a request does not need the exposure to still exist; only approval and consumption recompute the facts.
- The rollback keeps this slice's audit actions and alert kinds in their vocabularies (as the lifecycle rollback does): removing them could orphan audit rows or alerts.
- Disposition and number authorization require TWO administrators at the moment of approval, but the administrator who executes the action may be either of them or a third; the audit records requester, approver and executor.
