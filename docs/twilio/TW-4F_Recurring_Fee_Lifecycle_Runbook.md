# TW-4F recurring provider-fee lifecycle: runbook

Operations for `20261209090000_twilio_recurring_fee_lifecycle.sql` (design: `TW-4F_Recurring_Fee_Lifecycle_Design.md`). Every step that touches hosted DEV (`epdrtzcydvnoidwrepqz`) or PROD (`hvsujyfbftfffxpfmlpb`), a schedule, an environment flag or Twilio needs the owner's explicit approval first. Nothing below has been done on any hosted environment.

## 1. Before activation (activation gates)

1. Hosted SQL in order (each needs approval): `20261205` then, when merged, `20261206` / `20261207` / `20261208`, then `20261209090000_twilio_recurring_fee_lifecycle.sql`.
   - Preflight: `select to_regclass('public.studio_sms_provider_resources')` is null; `select to_regclass('public.tw4_local_qa_only')` is null (the local QA marker must never exist on hosted).
   - Postflight: the five tables exist with no API-role privileges; `select count(*) from public.studio_sms_provider_resources` = 0; `public._tw4rc_service_state` source contains `_tw4rfl_gate_suspended`; `tw4_local_qa_only` is still null. With no resource registered the gate changes nothing for any studio.
2. R2b registers every number and campaign with `tw4_rfl_register` in the same flow that records it, and its activation checklist refuses `ready_for_activation` / `active` while `tw4_rfl_studio_ready(studio)` returns blockers. Until then no studio may be activated for real sending.
3. Deploy the application containing the route (it answers 404 by itself).
4. Decide the alert channel and recipients (design decision D1) and wire a sink; until then alerts only accumulate (`alerts_waiting` in the overview).
5. Environment (production only, owner approval): `SMS_FEE_LIFECYCLE_SCAN=on`, `CRON_SECRET` already set. Register the schedule in its own reviewed PR (suggested daily, `0 14 * * *`); the unit test that pins "not registered" must be updated in that PR.
6. Watch two completed scans (route response counts) before the first live studio.

## 2. Reading the overview (`tw4_rfl_admin_overview`)

| Signal | Meaning | Action |
|---|---|---|
| `df_sending: false`, `provider_state: active` | DanceFlow stopped sending; the provider still bills | Decide: owner renews, or section 5, or absorb |
| `current_period` / `next_period` = `uncovered:*` | no owner act covers that period; the reason says why | Section 3 |
| Open exposure | a period past grace without cover, or a recorded provider bill without cover | Section 3 / 4 |
| `open_cancel_operation` | an authorized, claimed or unknown cancellation | Section 5 |
| `alerts_waiting` > 0 | outbox not delivered | Wire / fix the sink |
| `inventory_gap` alert | a billed sender's number or campaign is not registered, so nothing monitors it | Register it (`tw4_rfl_register`) immediately; do not activate |

## 3. A period is uncovered

1. Identify the reason in the overview: `authorization_expired` / `_revoked` / `no_authorization` (owner), `charge_unfunded` (credit), `charge_held` (hold or spending cap), `charge_refused` (limit or price changed), `awaiting_charge` (scheduler did not run), `no_pilot_approval` (pilot).
2. DanceFlow sending is already suspended once the period is 7 days old. To suspend sooner, or to also hold credit: `tw4_rfl_suspend_df(studio, actor, reason, hold)`. This changes nothing at Twilio and its result says how many provider fees continue. A credit HOLD is per legal business: `hold_affects_other_locations` in the result says how many other locations' recurring charges it stops (they become uncovered after their own grace), so prefer suspension without a hold unless funds are the cause.
3. Tell the owner (the alert says what ends and how to renew). **Renewal is always the owner's own act** through their texting settings (`tw4_recurring_authorize`) at the then-current published price; the platform never renews, extends or charges on their behalf. For the pilot business, record a written approval for the period: `tw4_rfl_pilot_cover(resource, period, approval_ref, actor)` (current or next period only, inside the cumulative $150 ceiling, each approval reference single use).
4. After renewal the NEW period is covered and sending resumes. A fully uncovered EARLIER month remains an exposure and keeps sending suspended until you record the disposition in section 4.

## 4. Recording what Twilio actually billed, and disposing of exposure

- When the Twilio Console / invoice shows a recurring charge for a period no owner act covered: `tw4_rfl_observe_provider_bill(resource, period, provider_ref, cost_cents, actor)` (one call per bill line; replays by reference are harmless). It records the reconciliation line, opens exposure with the billed amount and alerts. It never charges the studio.
- A bill after a CONFIRMED cancellation is `billed_after_cancellation`: open a dispute with Twilio, then dispose.
- `tw4_rfl_exposure_dispose(resource, period, actor, disposition, note)`: `absorbed` (DanceFlow accepts the cost; required to resume sending after a fully uncovered earlier month) or `not_billed_confirmed` (Twilio verified to have billed nothing; refused when a bill is recorded). The note (10+ characters) says what was checked. The disposition is final and audited.

## 5. Cancelling a provider resource (irreversible)

Only with the owner's or the founder's written decision, except a lapse (below). Nothing in DanceFlow calls Twilio: you perform the console step and record the evidence.

1. **Suspend first** (`tw4_rfl_suspend_df`): a number cannot be cancelled while it is the live sender.
2. `tw4_rfl_cancel_authorize(resource, actor, approval_ref, decided_by, reason, true)`. `approval_ref` is the written decision's permanent reference (10+ characters, single use); `true` is the irreversibility acknowledgement. Numbers: `owner_written` or `founder_written` only. `policy_lapse` (campaign / Messaging Service only) needs an exposure open at least 14 days and the lapse notices delivered to the owner.
3. `tw4_rfl_cancel_begin(operation, actor)`: proceed ONLY on `action: execute`. `in_progress` means someone else holds the claim. `reconcile` means an earlier outcome is unknown: look the resource up first, never repeat.
4. Perform the console step for the subaccount named by the resource (never the parent). Then `tw4_rfl_cancel_finish`:
   - `confirmed` with the digest of the evidence that the resource is gone (the provider read / console record's hash);
   - `refused` ONLY when Twilio definitively refused (code `api`); the reference is then spent and a new decision is needed;
   - `unknown` for any timeout / ambiguous result: alerts the administrators; nothing is repeated.
5. An `unknown_outcome` (or a claim older than 20 minutes) is closed with `tw4_rfl_cancel_resolve`: `cancelled` with an evidence digest, or `still_active` with the digest of the provider read that shows the resource present and a written finding. If an operator completes the console step after an operation was abandoned, record it with `tw4_rfl_cancel_finish(..., confirmed, <digest>)` (the only exit from `abandoned`). Withdraw an unclaimed authorization with `tw4_rfl_cancel_withdraw`.
6. Confirmation marks the resource cancelled (final), stops its accruing exposure, and revokes DanceFlow's sender if it pointed at the resource. Any recorded provider bill stays open for step 4's disposition.

Numbers are never released as a side effect of anything else: not by suspension, not by expiry, not by a scan.

## 6. ConfiDance month two and later

Each paid month of the pilot's campaign and number needs its own written approval (`tw4_rfl_pilot_cover`), inside the cumulative $150 ceiling that already includes every pilot reservation. The scan alerts both owner and administrators for the NEXT period (`pilot_approval_needed`). Without an approval the period is exposure from day 8 and sending is suspended; the lapse procedure in section 5 applies only after 14 days of exposure and never to the number.

## 7. Rollback

Application first (leave `SMS_FEE_LIFECYCLE_SCAN` unset). SQL: `rollback/20261209090000_twilio_recurring_fee_lifecycle_rollback.sql` restores the 20261128 `_tw4rc_service_state` and drops the objects, and REFUSES (55000) once any resource, cover, exposure, cancellation operation, alert or `rfl_*` audit row exists. From then on the stance is forward-fix: a new migration, never deleting evidence.
