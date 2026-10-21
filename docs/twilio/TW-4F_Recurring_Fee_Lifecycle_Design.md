# TW-4F: recurring provider-fee lifecycle integrity (design, 2026-10-21)

Baseline: `main` 1c036885 (R2a, PR #252, `20261207090000`, merged). PR #251 (sender re-verification, `20261206090000`) is still OPEN and untouched; R2b (`20261208090000`, planned) and R2c have no committed code. This slice takes migration `20261209090000`, depends only on what is on `main`, and links to R2a / R2b by soft references only. Local and synthetic only: no hosted SQL, no real Twilio call, no number purchase / cancellation / release, no Stripe, no SMS, no flag enabled.

## 1. The problem

Twilio keeps billing a live A2P campaign and a rented number to DanceFlow's subaccount whether or not (a) the owner's recurring authorization has expired or was revoked, (b) the prepaid credit is exhausted or the account is on hold or negative, or (c) DanceFlow stopped sending. Before this slice DanceFlow could not see that exposure, did not alert anyone before it started, and an expired authorization silently fell back to service state `none` (sending allowed, nobody paying). R2a's design (section 6.1) listed this as a BLOCKER before any studio is activated; this is that control layer.

## 2. Two axes, never confused

| Axis | Meaning | Where it lives | Who changes it |
|---|---|---|---|
| **DanceFlow state** (sending) | approved sender, no credit hold, service state not `suspended` | `studio_sms_billed_senders`, `studio_sms_credit_accounts.hold`, `_tw4rc_service_state` | the sending gate, `tw4_rfl_suspend_df`, existing sender / hold functions |
| **Provider state** (billing) | the Twilio resource still exists and bills (`active`) or is confirmed gone (`cancelled`) | `studio_sms_provider_resources.provider_state` | ONLY the cancellation functions, ONLY with provider evidence |

Suspending DanceFlow never changes the provider axis (`tw4_rfl_suspend_df` returns `provider_resources_unchanged: true` and how many fees continue). Cancelling at the provider is a separate, authorized, evidenced operation.

## 3. Objects (all new; no API-role privileges; service-role functions only)

| Object | Purpose |
|---|---|
| `studio_sms_provider_resources` | Inventory: one row per Messaging Service / campaign / number, stamped with the business's ACTIVE subaccount, fee kind derived by the database (campaign: the location's verified path; number: `number`; Messaging Service: none). Identity immutable; `provider_state` moves only through the cancellation functions. |
| `studio_sms_provider_cover` | Cover that is not a recurring charge: the registration period's existing fee reservation, and the pilot business's per-period written approvals. Permanent. |
| `studio_sms_provider_exposure` | One row per (resource, service period) that no owner act covers past grace, plus provider bill evidence. Closed by cover or by an administrator's written disposition; never by time. |
| `studio_sms_provider_cancel_ops` | The cancellation state machine (section 6). One open operation per resource. |
| `studio_sms_provider_alerts` | De-duplicated alert outbox (kind + dedupe key unique), claimed with a token, retried at most 5 times. |

Audit rows go to the existing `studio_sms_onboarding_audit` (vocabulary extended from the live list, so the order of sibling migrations does not matter).

## 4. Cover rules (who pays for a period)

A service period (the business's local calendar month, the same `_tw4ml_month_key` the recurring scheduler uses) of a live recurring-fee resource is covered ONLY by:

1. a `charged` recurring charge for that location and fee (any campaign monthly kind pays for the campaign);
2. the authorization's own first-month set-aside (`commitment_reservation_id` still reserved) for the month the authorization starts;
3. for the PILOT business only: the registration period's existing fee reservation, passed to `tw4_rfl_register` by R2a / R2b (never a `rec:` / `commit:` / `rfl:` reservation). Every other business's registration period is covered by its standing authorization (commitment, then charge); registering a separate initial reservation for such a business is refused, because the owner's authorization would then pay the same month a second time (independent review P0);
4. for the pilot business only: a written approval recorded by `tw4_rfl_pilot_cover` for the current or next period.

Nothing else counts. An authorization that has expired, been revoked, hit its limit, or has no charge yet is `uncovered`, with the reason recorded (`authorization_expired`, `authorization_revoked`, `no_authorization`, `charge_unfunded`, `charge_held`, `charge_refused`, `awaiting_charge`, `not_authorized_period`, `no_pilot_approval`). Time never extends cover and no function here extends, renews or creates an authorization: renewal is the owner's own `tw4_recurring_authorize`.

A charge pays ONE resource's period: a replacement registered after its predecessor was cancelled inside the same period is not covered by the predecessor's charge (Twilio bills it separately), and a reserved commitment does not hide an unfunded / held / refused charge. One LIVE resource of each kind per location (unique index): a replacement is registered only after the first is confirmed cancelled.

**Charges follow the resource.** `tw4_recurring_charge` (the 20261203 body plus two added `held` branches) never charges a period in which NO resource of that fee was live at the provider (before the first was registered, or the gap between a cancelled resource and its replacement; per period, not "is any live now"), and never while a cancellation of the location's resource is authorized, claimed or unknown. Both outcomes are `held` (nothing captured, retried by the scheduler, which skips only charged / refused rows), so a later replacement is charged for the periods it was live; the unpaid month of a retired resource does not suspend sending. The cancellation date is when the operation STARTED (an operation first abandoned on evidence that the resource was still present is never backdated before that finding). The cancellation month itself is still payable (Twilio already billed it), a live replacement makes the same authorization chargeable again, and a location that never registered a resource is unchanged (charges before provisioning completes). A NEW authorization (renewal) is refused (`TW041`) while a cancellation of the same fee's resource at the location is authorized, claimed or unknown, and `tw4_rfl_studio_ready` reports `cancellation_pending`. Confirming a cancellation alerts the owner that their authorization stays until they revoke it. Provider cost variances are only ever recorded (reconciliation + alert): no function here debits the studio for one.

**Grace.** An uncovered period is exposure (and suspends sending) 7 days after the later of the period start and the resource's registration: the same 7 days `_tw4rc_service_state` already uses for unpaid periods.

## 5. Exposure, alerts, and the gate

- `tw4_rfl_scan_entity(entity)` (one legal business per call, under that business's entity-row + credit-account lock, so it serializes with recurring charges): opens / refreshes / closes exposure for the previous and current period; raises upcoming-charge alerts; never charges or changes anything else. `tw4_rfl_scan_entities()` lists businesses with a live resource or an open exposure; `tw4_rfl_inventory_gaps()` raises a critical admin alert for any non-released billed sender whose number or campaign is not in the inventory (nothing monitors it).
- Alerts (owner and/or platform administrators, once per condition): `authorization_expiring` (35 days ahead, once per authorization), `next_period_uncovered` / `pilot_approval_needed` (next period will not be covered), `funding_low` (7 days before the next period, settled credit below the authorized charges), `negative_balance`, `account_on_hold`, `exposure_open` (critical), `provider_variance` (a recorded recurring provider charge differing from its expected cost), `inventory_gap`, `cancel_unknown`. Alert text never contains an amount, token, SID or message body.
- **Provider bill evidence** (`tw4_rfl_observe_provider_bill`): an administrator records what Twilio actually billed for a period (through the existing `tw4_credit_record_provider_charge`, so the variance record exists). A bill on an uncovered period, or on a period after a CONFIRMED cancellation, opens exposure with the billed amount. It is never charged to the studio.
- **The gate.** `_tw4rc_service_state` (consulted by every billed send, never by STOP / START / HELP handling: a test pins that no inbound / compliance function references it) additionally returns `suspended` when a registered live resource has an uncovered period past grace that no administrator has dispositioned. This stops DanceFlow's sending only. Two refinements: an authorized / claimed / unknown cancellation of any resource of the location also reports `suspended` (a sender re-approval cannot reopen sending through a resource being removed), and a past REGISTRATION period that nothing covered is recorded as exposure but does not gate (the owner can no longer fix a period that began before their authorization could; an administrator dispositions it, and `tw4_rfl_exposure_dispose` records the row itself when no scan has yet).
- **Disposition.** After an owner renews, only the NEW period is covered. A fully uncovered earlier month stays an exposure (and keeps sending suspended) until an administrator records `absorbed` (DanceFlow accepts the cost) or `not_billed_confirmed` (Twilio confirmed to have billed nothing; refused when a bill is recorded). Retroactive charging of the owner is not implemented: it would be a new spending commitment the owner never made.

## 6. Cancellation (nothing here calls Twilio)

`authorize` -> `begin` (single claim) -> `finish` (`confirmed` with provider evidence digest | `refused` only on the definite code `api` | `unknown`) -> `resolve` (unknown or claimed > 20 min: `cancelled` with evidence digest, or `still_active`). `withdraw` only before the claim.

- Authorization needs an administrator, a decision type (`owner_written`, `founder_written`, `policy_lapse`), a written reference (10+ characters, permanent: one decision authorizes one cancellation, once, in any spelling), a written reason, and the explicit irreversibility acknowledgement.
- A **phone number** is never cancelled on `policy_lapse`, and never while it is the live sender (DanceFlow sending must be suspended first; re-checked at claim time).
- `policy_lapse` for a campaign / Messaging Service needs an exposure open at least 14 days.
- One open operation per resource (unique index); concurrent claims: exactly one `execute`, the rest `in_progress`; an `unknown_outcome` is never repeated (`reconcile`).
- An operation abandoned as `still_active` (which itself needs the digest of a provider read) can still be completed with `confirmed` + evidence if the operator was mid-step; nothing else can leave `abandoned`.
- `confirmed` sets the resource `cancelled` (final), closes accruing exposure rows without a bill (rows with recorded bills stay open for a disposition), and revokes DanceFlow's sender if it pointed at the resource.

## 7. The ConfiDance pilot

The $150 ceiling is unchanged and cumulative: `tw4_rfl_pilot_cover` authorizes through `tw4_spend_authorize(..., 'pilot', location)` (permanent approval reference, published price, spend cap) and reserves / captures a `pilot` credit reservation counted by the same cumulative sum R2a and the runner use, under the same locks. Current or next period only (no retroactive approval); refused while the account is on hold or negative; replay-safe. The pilot business still cannot hold a standing authorization (`TW011`). Month two onward therefore needs a new written approval per resource per period; without one the period is exposure and sending is suspended after grace (R2a section 6.2's blocker, now enforced).

## 8. Interfaces agreed with R2a / R2b / R2c

- **Credit-funded businesses register AFTER they hold the standing authorization** (as R2a already requires) and pass NO initial reservation; R2b must not reserve a separate first-month number fee for them. The pilot business passes the reservation that pays its first period.

- **R2b registers every number and campaign in the SAME transaction/flow that records it** (`tw4_rfl_register(studio, actor, kind, provider_sid, account_sid, e164, source, source_operation_id, initial_reservation)`), passing the reservation that already pays the first period. The activation checklist must call `tw4_rfl_studio_ready(studio)` and refuse `ready_for_activation` / `active` while it returns blockers (missing inventory, uncovered current / next period, open exposure).
- R2a's campaign path should register the campaign when `tw4_prov_observe` confirms it (same call). Until it does, `tw4_rfl_inventory_gaps()` flags the sender.
- R2a's `studio_sms_prov_resources` / operation ids are referenced only through `source_operation_id` (no foreign key). The migration extends the approval-reference constraints ADDITIVELY from their live definitions, so it applies before or after R2b's `20261208` (which adds `number_selection`) without losing either source; **R2b's own migration still rebuilds those constraints from a fixed list and must adopt the same additive pattern** (otherwise applying it AFTER this one drops `cancellation`, or fails when cancellation rows exist). No file of R2a / R2b is edited here.
- R2c's panel reads `tw4_rfl_admin_overview(actor)` and drives the store methods in `src/lib/sms/providerFeeLifecycle.ts`.

### R2b integration requirements (PR #254; verified against its branch, nothing in its worktree changed)

1. Call `tw4_rfl_register` (platform-administrator actor: the runner's lease context has none today) in the SAME transaction as the provider-ownership observation of the number; pilot business: pass the `prov:` purchase reservation as `p_initial_reservation` (otherwise `tw4_rfl_pilot_cover` would consume the ceiling twice for the registration month); credit businesses pass none.
2. Pre-check "no live number in the inventory and no open cancellation" in `tw4_num_begin` before buying, so registration can never fail after a real purchase.
3. `tw4_num_retire` and replacements go through the `tw4_rfl_cancel_*` lifecycle (authorization, claim, evidence); otherwise the owner keeps being charged for a released number and the replacement cannot register. A release recorded only through the sender path raises the `released_resource_active` alert.
4. Activation (`tw4_act_*`) calls `tw4_rfl_studio_ready(studio)` and refuses while it reports blockers.
5. Lock order everywhere: location link (`_tw4sr_lock`), then the business row, then the credit account (this migration's functions follow it; a replayed R2b order is tested not to deadlock).
6. Apply R2b's constraint rewrite additively (see above).

## 9. Operational exposure rules

1. A live campaign or number with no covered period is exposure from day 8 of the period, even when nothing is being sent.
2. Exposure is measured in the published EXPECTED provider cost (internal) and, separately, in provider bills actually recorded. It is DanceFlow's cost until an administrator records a disposition.
3. Sending is suspended automatically on any uncovered period past grace; suspension is not cancellation. The administrator decides, in writing, whether to wait, cancel, or absorb.
4. Nothing releases a number automatically. A number needs the owner's or the founder's written decision.
5. Every disposition, suspension, cancellation step and registration is audited with the actor.

## 10. What is not done (explicit)

- No provider read / write: confirming that a resource is gone, and the console step itself, are human steps recorded with an evidence digest. A future provider-read adapter can supply the digest; the state machine does not change.
- No alert delivery channel: alerts stay in the outbox (counted in the overview) until the owner decides recipients and channel (decision D1). The runner's sink is injected.
- No scheduler registration (route is 404 unless `SMS_FEE_LIFECYCLE_SCAN=on`, and not in `vercel.json`).
- The grace and the 35-day / 14-day windows are constants in the SQL; they are not owner-configurable.
- Provider billing anniversaries differ from calendar months; the model uses the same calendar period the recurring charges use (documented approximation).

## 11. Independent review (Opus, 2026-10-21) and what changed

Fixed (each pinned by a test in `localStack.tw4rfl.test.ts`, "independent review findings"): P0 owner paying twice for the registration month (initial reservation only for the pilot business; real authorize + charge path asserted to capture once); P2 a charge covering a replacement resource (per-resource cover, one live resource per kind); P2 a partial registration month suspending sending the owner cannot fix (not gated; dispose records the row itself); P2 `abandoned` unable to record a real cancellation (abandoned -> confirmed with evidence; `still_active` needs evidence); P2 credit hold affecting other locations (result reports `hold_affects_other_locations`); P2 scan cap silent (`truncated`, counted as an error); P3 suspend / cancel deadlock (same lock order); P3 sender re-approval during a pending cancellation (open operation suspends the gate); P3 provider reference reuse across periods, lost disposition note on reopen, UTC date in the expiry alert, commitment hiding an unfunded charge, misleading alert wording.

Accepted and documented: alerts are not delivered until the channel decision (D1); pilot period approvals are captured at once and are not released if the resource is cancelled before that period (they consume ceiling; decision D4); a `policy_lapse` age check uses the exposure's first detection (a reopened exposure keeps its age); provider billing anniversaries vs calendar months.

## 12. Outstanding decisions (owner)

- **D1** Alert channel and recipients (email? platform panel only?) and who counts as "owner" per location.
- **D2** Grace (7 days), expiry notice (35 days) and lapse window (14 days) are SQL constants; confirm or make configurable.
- **D3** Dual control for `absorbed` dispositions and cancellations (today one administrator).
- **D4** Whether a cancelled resource's already-approved FUTURE pilot period should release ceiling (needs a ledger change outside this slice).
- **D5** Whether an owner should ever be asked to retroactively cover a lapsed month (not implemented: it would be a new commitment).
- **D6** Schedule registration of `/api/cron/sms-provider-fee-lifecycle` (daily suggested) after D1.

## 13. Deployment and rollback

Requires `20261205090000`. Apply in numeric order; independent of `20261206` / `20261207`. With R2b's `20261208` the approval-reference constraints merge additively when this migration is applied AFTER it; applying R2b's current migration AFTER this one drops `cancellation` (or fails if cancellation rows exist) until R2b adopts the additive pattern (section 8). The migration replaces `_tw4rc_service_state` and `tw4_recurring_charge` (each precondition-checked against its current body) and adds three insert triggers (recurring authorizations, spend events, credit reservations). Rollback `rollback/20261209090000_..._rollback.sql` restores both bodies and drops every object, and REFUSES (55000) once any resource, cover, exposure, cancellation or alert row exists (forward-fix only from then on). Application is dark: the route answers 404 by default, nothing registers resources until R2a / R2b call `tw4_rfl_register`.
