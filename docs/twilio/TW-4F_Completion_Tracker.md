# TW-4F Completion Tracker

Status: 2026-10-22, baseline `main` = `960a9d02` (#271). Documentation only. This file tracks how far TW-4F is from being complete and release-ready. It is **not a roadmap**: priorities come from `docs/roadmap/DanceFlow_Master_Roadmap.md` (v2.22), and design decisions come from the TW-4F design documents cited below. When this tracker disagrees with an approved design document, the design document wins and the disagreement is listed in section 9.

Status vocabulary:

| Status | Meaning |
|---|---|
| **VERIFIED** | Merged on `main`, and its app caller or user journey was traced in code. |
| **UNCONNECTED** | Merged on `main` (SQL and/or library), but nothing in the application calls it. Evidence is given. |
| **MISSING** | Not implemented anywhere on `main` or on an open PR. |
| **AWAITING QA/MERGE** | Implemented on an open PR, not merged. |
| **HOSTED-UNVERIFIED** | Hosted DEV/PROD state is taken from earlier records and was not re-read for this tracker. |
| **GATE** | A live-provider, financial or activation gate. Each one needs separate explicit owner authorization. |

How the "no caller" claims were checked: `git grep -l -w <symbol> 960a9d02 -- src scripts`, excluding `__tests__`, `*.test.*` and migrations. "Only the defining file" means the symbol appears nowhere else. Import checks used `git grep -E "from '.*/<module>'"`.

## 1. Confirmed facts

- `origin/main` = `960a9d02581331181c84f485b4558c0963340c47`. Checked with `git ls-remote` on 2026-10-22.
- **Merged** (checked with `gh pr view`; merge commits):

  | PR | Merge commit | PR | Merge commit |
  |---|---|---|---|
  | #242 | c3610433 | #257 | 4bf634d7 |
  | #244 | 8305afbd | #258 | 6320b02b |
  | #245 | d6b1b068 | #259 | 78cb881e |
  | #246 | ed5bef03 | #260 | 6fdca0ae |
  | #247 | a851d7a6 | #261 | af9bcf7c |
  | #248 | 82d19a29 | #262 | f1fb93ec |
  | #249 | 9bd5d791 | #263 | b44838ff |
  | #250 | 4c13dbd5 | #264 | 03a4837d |
  | #252 | 1c036885 | #265 | 444f79f7 |
  | #253 | 0a84f9da | #268 | ea4afdf5 |
  | #254 | 54ca06be | #270 | b8752497 |
  | #255 | b9b19edb | #271 | 960a9d02 |
  |  |  | #272 | 21c0424d |

  #256 is closed and was superseded by #268.
- **Open TW-4F PRs** (heads as of 2026-10-22):

  | PR | Head | Scope | Merge state vs `960a9d02` | Migration | Worktree / owner |
  |---|---|---|---|---|---|
  | #251 | 0fe7a622 | Automated sender re-verification, route `/api/cron/sms-sender-reverify` | **CONFLICT** in `src/app/platform/sms/page.tsx` (`git merge-tree`); 17 commits behind | `20261206090000` | `C:\Dev\studioapp-reverify` (sender re-verify session) |
  | #266 | d90a9f17 | Isolated regression QA harness (`scripts/qa/iso-qa.mjs`), no app code | clean | none | `C:\Dev\studioapp-isoqa` |
  | #267 | 64c1f41e | R2a rollback test works on layered schemas (test only) | clean | none | `C:\Dev\studioapp-r2arollback` |
  | #269 | 6c3dde21 | Evidence recorder uses the operation's original account and Messaging Service | clean | `20261215090000` | `C:\Dev\studioapp-origscope` |

  #221 (T2 rollback draft, "DO NOT MERGE") is not TW-4F.
- **Migrations on `main`:** `20261120090000` through `20261217090000`, 28 forward files, each with a rollback.
  - `1206` and `1215` exist only on #251 and #269. Both were checked as order-independent: neither replaces a function that a later migration on `main` redefines.
  - No migration registers `pg_cron`. No migration seeds price rows.
  - Next free timestamp: `20261218090000`.
- **Crons:** `vercel.json` schedules only `/api/cron/sms-onboarding-purge` among the SMS routes.
  - `/api/cron/sms-recurring`, `/api/cron/sms-usage-reconcile` and `/api/cron/sms-provider-fee-lifecycle` exist but are not scheduled.
  - Provisioning, number, inventory and evidence work has no route at all.
- **CI** (`.github/workflows/e2e-public-event-registration.yml`) runs tsc, vitest, the build and lint. The `localStack.*` DB suites skip without `TW4A_LOCAL_*` env, so **CI runs none of the TW-4F database suites**. DB QA is manual, on a dedicated container or the #266 harness.
- **Active sessions:** no TW-4F session was running at the time of this audit. The worktrees listed above are clean (`git status --porcelain` is empty).

## 2. Assumptions and unverified state

- **HOSTED-UNVERIFIED.** A read-only catalog probe of DEV/PROD was not permitted in this session. The last recorded state (2026-10-19 sync review and Phase A) is:
  - **PROD** (`hvsujyfbftfffxpfmlpb`) has Twilio objects through `20261119092100` (TW-4A through R1.1) with 0 rows. The app was `dpl_9JYuwjxf…` (main `2cc05d9e`).
  - **DEV** (`epdrtzcydvnoidwrepqz`) additionally has `1120`, `1121` and `1122` (fingerprint `7d4442fa`).
  - `1123`–`1217` have been applied only to local or isolated QA databases.
  - None of this may be treated as confirmed until a fresh SELECT-only fingerprint probe has been authorized and run.
- `docs/twilio/TW-4F_Production_Onboarding_Plan.md` §9a still says `1120` and `1121` are "NOT applied". That conflicts with the Phase A record. See section 9.
- Twilio ticket #29647095: the docs record the six answers as received 2026-10-19 (`TW-4F_Production_Onboarding_Plan.md` §13, `TW-4F_Provider_Integration.md`). The roadmap row "Twilio Q1–Q5 confirmation … OPEN" (`DanceFlow_Master_Roadmap.md:166`) looks stale. See section 9.
- Provider request shapes are taken from the code (`src/lib/sms/twilioIsv/real.ts`). No real Twilio call has been made for R2a or R2b.

## 3. Requirement tracker

Columns:

- **Req** is the tracker ID.
- **Evidence** is the PR or code location on `960a9d02`.
- **WS** is the workstream that owns the work (section 6).
- **Dependency** is what must be done first.
- **Acceptance** is the acceptance criteria.
- **QA evidence** is the QA evidence required.
- **Gate** is the release-gate class: G = Git completion, D = hosted DEV, P = ConfiDance pilot, L = general production.

### 3.1 Owner journey

| Req | Requirement | Status | Evidence | WS | Dependency | Acceptance | QA evidence | Gate |
|---|---|---|---|---|---|---|---|---|
| O-1 | Owner sees Messaging Service and campaign status | VERIFIED | `src/app/app/settings/sms/page.tsx:106` → `getOwnerProvisioning` (`src/lib/sms/provisioning/ownerRead.ts`) → `get_studio_sms_provisioning` (20261210, granted to `authenticated`) | — | — | Done | Existing R2c-I2 suites | G |
| O-2 | Owner sees number, sender and compliance stages | UNCONNECTED | The owner read returns only `messaging_service` and `campaign`. `buildJourney` in `src/lib/sms/provisioning/journey.ts` uses R2b facts only when all three are present, otherwise "Not available yet". 3 of 8 stages cannot progress. | J2 | — | All 8 stages driven by owner-scoped facts; no SID, EIN, cost or provider detail leaks | Isolated DB: owner/other-studio/anon personas; browser E2E | G |
| O-3 | Owner number search, selection and fee approval | UNCONNECTED | `tw4_num_select_as_owner` and `tw4_num_withdraw_as_owner` (20261208, granted to `authenticated`) have no caller. `NumberFact.actionHref` is never set. `src/app/app/settings/sms/actions.ts` has only the save, submit and cancel setup actions. | J3 | J1 (offers exist), J2 | Owner picks an offered number and approves the published fee; replay and forged-studio requests refused | Browser E2E with fake adapter; forged-request tests; DB ledger check | G |
| O-4 | Owner recurring-fee and inventory overview | UNCONNECTED | `sms_rfl_owner_overview` (20261209, granted to `authenticated`) has only its defining migration | J2 | — | Owner sees covered/uncovered periods in neutral language; no request for payment for unexpected resources (RFL Ops D5 / orphan policy) | Persona tests; copy review | G |
| O-5 | Credit, monthly limit and recurring authorization panels | VERIFIED (dark) | `SmsCreditPanel`, `SmsLimitPanel` → `/api/billing/sms-limits/*`, `SmsRecurringPanel` → `/api/billing/sms-recurring/*`. Flags: `SMS_CREDIT_PURCHASES`, `SMS_MONTHLY_LIMITS`, `SMS_RECURRING_AUTHORIZATION` | — | — | Done in Git | Existing suites; Stripe test-mode checkout still **BLOCKED** (infra) | G / P |
| O-6 | Owner cancellation of a number or service | MISSING (scope decision) | `SmsCancelSetup` cancels only onboarding (`cancel_sms_onboarding`). There is no owner path to `tw4_rfl_cancel_*`. | — | Owner decision U-7 | Per decision | — | L |

### 3.2 Platform-admin journey and provisioning

| Req | Requirement | Status | Evidence | WS | Dependency | Acceptance | QA evidence | Gate |
|---|---|---|---|---|---|---|---|---|
| A-1 | Start and refresh R2a Messaging Service and campaign provisioning | UNCONNECTED | `runProvisioning` and `refreshProvisioning` appear only in `src/lib/sms/twilioIsv/provisionRunner.ts`; no module imports `provisionRunner`. `factory.ts` builds only `createScopedRealAdapter` (R1) and never `createScopedProvisioningAdapter`. `adminView.ts` says "The provisioning runner has no platform action in this build." | J1 | — | Admin action runs or refreshes through the existing ledger with real-call env gates unchanged; fake adapter only in local QA | Isolated DB + fake adapter E2E; idempotency/replay; pilot-cap refusal | G |
| A-2 | Start R2b number offers, acquisition and refresh | UNCONNECTED | `offerNumbers`, `runNumberAcquisition` and `refreshNumber` appear only in `numberRunner.ts`, which no module imports. `createScopedNumberAdapter` appears only in `real.ts`. | J1 | — | Same as A-1, plus the cumulative $150 ceiling is enforced at purchase | As A-1; concurrent purchase race | G |
| A-3 | Activation console (checklist, AOO attestation, compliance validation, sender verification, mark ready, activate, suspend) | UNCONNECTED | `activationCheck`, `attestOptOut`, `markReady` and the call to `tw4_act_activate` appear only in `src/lib/sms/activation.ts`, which no module imports | J4 | J1, F1, F3 | Every checklist item (`_tw4act_items`, 20261208:1625) is visible; activation refused unless all pass; manual platform release (D8) | Browser E2E admin; negative per checklist item | G / P |
| A-4 | Advanced Opt-Out | VERIFIED as attestation | Approved D4: a Console step recorded by an admin (`TW-4F_Production_Onboarding_Plan.md` §11). R1 sender panel checkbox (`SenderIdentity.tsx`); R2b `tw4_act_attest` needs five confirmations, no caller (see A-3). No provider API read. | J4 | A-3 | Attestation recorded per studio subaccount before activation | Activation E2E | P |
| A-5 | Provisioning ledger and unknown-outcome resolution (R2a) | VERIFIED (resolve as created only) | `ProvisioningLedger.tsx` → `resolveProvisioningOperationAction` → `tw4_prov_resolve`. `FEE_RELEASE_ENABLED=false` hides "not created" for fee-bearing operations (`ProvisioningLedger.tsx:43,51`). | F4 | U-1 | Per decision U-1 | — | G |
| A-6 | Number-operation ledger read | UNCONNECTED | `tw4_num_status` has only its defining migration | F4 | — | Admin sees number operations, outcomes and holds | Persona + UI tests | G |
| A-7 | Evidence recording for fee-bearing unknown outcomes | UNCONNECTED | `checkCampaignAbsence` appears only in `provisionEvidence.ts`, which no module imports. #269 (original scope) is open. | F4 | #269 merged | Two spaced, complete listings recorded under a lease; release only per U-1 | Isolated DB `feeres` suite; fake listings E2E | G |
| A-8 | Campaign and number orphan exposure (consolidated) | UNCONNECTED | `tw4_prov_orphan_exposure`, `tw4_prov_orphan_alert_status` (20261216), `tw4_num_orphan_exposure` and `tw4_num_orphan_resolve` (20261214) have only their defining migrations. `RecurringFeesExposure` shows only `tw4_rfl_exposure_report`. | F4 | — | One admin view; unknown cost null; never added to the RFL report (20261216 warning); no owner payment request | Persona + aggregation tests | G |
| A-9 | Registration-gap listing and audited retry | UNCONNECTED | `tw4_num_registration_gaps` and `tw4_num_registration_retry` (20261217) have only their defining migration. The retry records no caller (`TW-4F_R2b_RFL_Integration.md` §5 D1). | F4 | — | Admin lists gaps and retries; actor audited | DB suite `r2brfl`; UI test | G |
| A-10 | Deferred-retirement recovery | MISSING | `_tw4num_on_number_cancelled` (20261217:106) defers with a warning alert only. There is no listing or admin action. Deferred retirements are not listed in the gaps read (#271 review P3). | F4 | — | Deferred retirements listed with a guarded retry; sender release prerequisite explicit | DB suite; lock-order test | G |
| A-11 | Provider-side release on cancellation (number, Messaging Service/campaign) | MISSING | `real.ts` has no DELETE method. `tw4_rfl_cancel_finish` records an outcome and digest typed by the admin. | F5 | — | Release via adapter with unknown-outcome-never-repeated semantics; dual control kept for numbers (RFL Ops D3) | Fake adapter suite; request-shape contract tests | G / P |
| A-12 | Campaign registration into the RFL inventory | MISSING | `tw4_prov_observe` is unchanged. `ProviderFeeLifecycle.register` (`providerFeeLifecycle.ts:53` → `tw4_rfl_register`) has no caller. Campaigns surface as inventory gaps and block `rfl_ready` (`TW-4F_R2b_RFL_Integration.md` §6). | F4 | — | Provider-confirmed campaign registers in the same transaction as the observation, mirroring 20261217 for numbers | DB suite | G |
| A-13 | Price list management and publication | UNCONNECTED | `tw4_price_set` appears only in `creditStore.ts`, which no module imports. Prices are a DRAFT (`TW-4F-3b_Pricing_Proposal.md`). One admin, immediate effect. | — | U-2 | Per decision U-2 | — | P |

### 3.3 Financial controls

| Req | Requirement | Status | Evidence | WS | Dependency | Acceptance | QA evidence | Gate |
|---|---|---|---|---|---|---|---|---|
| F-1 | **ConfiDance activation funding path** | **MISSING (P1 blocker)** | `_tw4act_funding` (20261208:1604–1607) returns `pilot_month_two_undefined` unconditionally whenever a `studio_sms_pilot_exceptions` row exists. No later migration replaces it. The pilot can never pass `funding_continuity`. | F1 | — | Funding passes only with a `tw4_rfl_pilot_cover` written approval for the current period. It still fails closed without one, and the next period is flagged. No standing authorization (TW011). $150 cumulative ceiling unchanged. | Isolated DB: with/without cover, expired period, at-ceiling, concurrent cover | G / P |
| F-2 | $150 cumulative pilot ceiling | VERIFIED (SQL) | `studio_sms_pilot_exceptions.ceiling_cents between 1 and 15000`, single-row unique, `_tw4c_pilot_cap_guard` (20261122). Never replenished (RFL Ops D4). | — | — | Done | Existing suites | G |
| F-3 | Written approval for every paid pilot period | VERIFIED (mechanism); evidence form open | `tw4_rfl_pilot_cover` (20261209:800): current or next period, approval reference required, published price, ceiling, immediate capture. UI `RecurringFeesPilot.tsx` → `rflPilotCoverAction` (`recurringFeeActions.ts:198`). The reference is free text recorded by one admin. | F1 | U-4 | Per U-4 (evidence fields and/or dual control) | DB suite + UI | P |
| F-4 | Recurring charge enforcement | VERIFIED (SQL) | `tw4_recurring_charge` (20261217:332) refuses periods outside the current or previous month and the pilot business, replays charged periods, and holds retired resources and open cancellations. Unique `(authorization_id, period_key)` and the `studio_sms_recurring_charges_once` index (20261126:80/85). Caller `smsRecurring.ts` ← `/api/cron/sms-recurring` (`SMS_RECURRING_SCHEDULER` + DB switch; not scheduled). | F3 | — | Re-verified on the full chain in isolated QA | Full-chain isolated run | G / D |
| F-5 | Usage reconciliation readiness before billed sending | UNCONNECTED (P1) | `tw4_usage_settle` is called only by `src/lib/sms/usageReconciler.ts` via `/api/cron/sms-usage-reconcile` (not scheduled). Turning on billed sending without the reconciler leaves reservations uncaptured. | F3 | — | Billed sending switch (`tw4_usage_set_switch`) and/or `tw4_usage_begin` refuse unless the reconciler has a recent healthy run | DB suite: stale heartbeat refusal | G / P |
| F-6 | Rent basis and rent hold | VERIFIED (SQL) | `tw4_num_rent_basis` / `_tw4num_rent_basis_core` (20261208:2005); `_tw4num_rent_hold` (20261217:78) holds and never charges when the basis is indeterminate | — | — | Done | Existing `r2brfl` suite | G |
| F-7 | Dual control (absorb, number cancellation) | VERIFIED | 20261211:151–206, CHECK `decided_by <> requested_by`; UI `providerFeeOps.ts` | — | — | Done | Existing `rflops` suite | G |
| F-8 | No retroactive studio charges for unauthorized provider cost | VERIFIED (policy in SQL) | RFL Ops D5: `tw4_rfl_variance_report` / `tw4_rfl_variance_ack`, DanceFlow-borne | — | — | Done | Existing | G |
| F-9 | Financial release requires verified evidence | VERIFIED (SQL), release gated in UI | `tw4_prov_resolve('not_created')` needs two spaced, complete, absent listings (`_tw4prov2_proof`, 20261212). Refused for the pilot (TW048). Numbers need one clean post-attempt inventory (`_tw4num_absence_evidence`, 20261213). | F4 | U-1 | Per U-1 | — | G |
| F-10 | Activation lock-order inversion | MISSING (P2/P3) | `tw4_act_*` vs retire/observe-mismatch lock order (`TW-4F_R2b_RFL_Integration.md` §6; #271 review) | F1 | — | One lock order; concurrency test proves no deadlock abort | Concurrent isolated DB test | G |
| F-11 | Provider funding-exposure monitoring | UNCONNECTED | `tw4_act_exposure` has only its defining migration. The RFL scan is unscheduled. | M1 | F4 | Scheduled read with alerting; DanceFlow-borne exposure visible | Route tests; DB | P |
| F-12 | Provider bill ingestion | MISSING (manual by design today) | `tw4_rfl_observe_provider_bill` is admin-entered | — | — | Manual entry acceptable for the pilot (record in runbook) | — | L |

### 3.4 Sending, compliance and notifications

| Req | Requirement | Status | Evidence | WS | Dependency | Acceptance | QA evidence | Gate |
|---|---|---|---|---|---|---|---|---|
| S-1 | Send-time gate chain for billed sending | VERIFIED (fail closed) | `src/lib/notifications/dispatch.ts` / `src/app/api/sms/send/route.ts` → `sendBilledSms` → `tw4_usage_begin`. Order: legal entity, switch, `_tw4sr_ready` (20261214:652, incl. `_tw4num_send_blocked` and inventory health), suspension, funds, monthly limit ($0 default), reservation. | — | — | Done | Existing | G |
| S-2 | **Legacy sender fallback without a campaign gate** | MISSING (P1) | `_tw4sr_ready` falls back to `_tw4sr_ready_core` when neither R2a nor R2b touched the location (20261214:665, "PR #249 behaviour exactly"). That path is a hand-recorded sender with no campaign-verified check. | F2 | U-3 | Billed sending refused unless a verified campaign is bound to the sender, or per U-3 | DB suite: legacy location refusal | G / P |
| S-3 | Legacy non-billed send path (A2P-2 registration) | VERIFIED as existing behavior; outside TW-4 checks | `sendTwilioSms` path for non-billed studios. Changing it affects live sending. | — | U-3 | Per U-3 | — | L |
| S-4 | 24h sender re-verification | AWAITING QA/MERGE | #251 (`20261206090000`, route `sms-sender-reverify`, `SMS_SENDER_REVERIFY`); conflict in `page.tsx` | W0 | Rebase by owning session | Merged; route unscheduled | `localStack.tw4rv`; route tests | G |
| S-5 | Scheduled inventory reconciliation | UNCONNECTED (availability) | `reconcileInventories` appears only in `numberRunner.ts`; no route. `_tw4sr_ready` holds sending once inventory health is `stale` (>24h), `unknown` or `critical`. | M1 | J1 | Route built (unscheduled); health visible | Route + DB tests | P |
| S-6 | Owner/admin alert delivery and escalation | VERIFIED (dark) | Sink `src/lib/sms/providerFeeAlerts/sink.ts` → `queueOutboundDelivery`; gates `SMS_FEE_LIFECYCLE_SCAN`, `SMS_FEE_LIFECYCLE_DELIVERY` plus DB switches; 5 attempts then `alert_delivery_exhausted`. Escalation uses the same email channel. | M1 | U-5 | Delivery runbook §7 checklist executed when authorized | Runbook evidence | P |
| S-7 | Neutral owner copy for unexpected resources | VERIFIED | #272, `providerFeeAlerts/templates.ts:24` | — | — | Done | Existing | G |
| S-8 | SMS quiet hours | MISSING (scope) | No quiet-hours check in `src/lib/sms` or `src/lib/notifications` | — | U-9 | Per decision | — | L |

### 3.5 Provider adapters

| Req | Requirement | Status | Evidence | WS | Dependency | Acceptance | QA evidence | Gate |
|---|---|---|---|---|---|---|---|---|
| P-1 | Real R2a request shapes (`POST /v1/Services`, `POST /v1/Services/{MG}/Compliance/Usa2p`) | VERIFIED in code, never exercised | `RealProvisioningAdapter` in `real.ts`; gates `TW4_ISV_REAL_CALLS` + `TW4_PROVISIONING_REAL_CALLS` + production deployment | F5 | — | Contract tests pin parameter names and lengths against Twilio's documented API | Contract test suite | G; real call = GATE |
| P-2 | Real R2b request shapes (`AvailablePhoneNumbers`, `IncomingPhoneNumbers`, `Services/{MG}/PhoneNumbers`) | VERIFIED in code, never exercised | `RealNumberAdapter`; `TW4_NUMBER_REAL_CALLS` | F5 | — | As P-1 | Contract tests | G; real call = GATE |
| P-3 | Live provider validation | GATE | `TW-4F_R2b_Number_Activation_Design.md` §9; `TW-4F_R2b_RFL_Integration.md` §6 | — | Owner authorization per call | Each call separately authorized; evidence recorded | Recorded evidence file | P |

## 4. Migration manifest (Git)

The full TW-4F chain on `main` runs in this order:

`1120 → 1121 → 1122 → 1123 → 1124 → 1125 → 1126 → 1127 → 1128 → 1129 → 1130 → 1201 → 1202_090 → 1202_140 → 1202_150 → 1203 → 1204 → 1205 → 1207 → 1208 → 1209 → 1210 → 1211 → 1212 → 1213 → 1214 → 1216 → 1217`

Then the open-PR files `1206` (#251) and `1215` (#269), which may be applied after `1217`.

Key facts for apply planning (from the migration headers and rollback scripts):

- Rollbacks refuse once evidence rows exist. Examples: `1122` (any price, account or ledger row), `1201`, `1207`, `1209`, `1211` (55000).
  - `1217` refuses if a restored body's fingerprint differs.
  - `1125` aborts (55000) if old disputes cannot be rebuilt.
  - **Once a hosted database holds real rows, rollback means "roll the app back first" and leave the SQL in place.**
- One-off data changes: `1123` (UPDATE top-ups), `1125` (INSERT dispute backfill), `1127` (audit INSERT), `1202_090` (approval-reference backfill).
- Client-exposed grants (`authenticated`):
  - `sms_location_attest` (1121)
  - credit reads (1122, 1124)
  - recurring overviews (1126, 1128)
  - fee kinds (1202_090)
  - `tw4_num_select_as_owner` / `_withdraw_as_owner` (1208)
  - `sms_rfl_owner_overview` (1209)
  - `get_studio_sms_provisioning` (1210)

  Everything else is `service_role` only.
- Hosted apply method recorded in the docs: one file at a time with `db query -f`, a fingerprint before and after, and a reverse-rollback round trip on DEV. The migration history table is not authoritative (see the 2026-10-19 sync record). The CLI's out-of-order refusal therefore does not apply. If the CLI were used, `1206`/`1215` would need `--include-all`.

## 5. Gates that stay off

All of these are off by default and stay off until separately authorized:

- **Env flags:**
  - `SMS_CREDIT_PURCHASES`, `SMS_MONTHLY_LIMITS`, `SMS_RECURRING_AUTHORIZATION`, `SMS_RECURRING_SCHEDULER`
  - `SMS_USAGE_BILLING`, `SMS_USAGE_RECONCILER`, `SMS_INBOUND_RECORDING`
  - `SMS_FEE_LIFECYCLE_SCAN`, `SMS_FEE_LIFECYCLE_DELIVERY`
  - `SMS_USAGE_EVIDENCE_READS`, `SMS_SENDER_VERIFY_READS`, `SMS_BILLED_REAL_SEND`, `SMS_SENDER_REVERIFY` (#251)
  - `TW4_ISV_REAL_CALLS`, `TW4_PROVISIONING_REAL_CALLS`, `TW4_NUMBER_REAL_CALLS`, `TW4_SUBACCOUNT_WEBHOOKS`
- **Code constant:** `FEE_RELEASE_ENABLED=false`.
- **DB switches** (no row means OFF): `tw4_recurring_set_switch`, `tw4_usage_set_switch`, `tw4_rfl_set_switch('scan'|'delivery')`.
- **Other holds:** credit hold, monthly limit default $0, the pilot ceiling, and no `vercel.json` entries for the TW-4F crons.

## 6. Workstreams

Not authorized for execution until the owner approves each slice. The rules for every slice:

- Its own worktree from the latest `origin/main`.
- Its own branch and PR, with CI green.
- A developer QA matrix that marks BLOCKED work as BLOCKED, never PASSED.
- No hosted apply, no merge without approval, no real provider activity.
- Fail-closed behavior preserved.

**Shared file:** `src/app/platform/sms/page.tsx`. Each slice adds only one import and one mount line, and the second PR to merge rebases. #251 already conflicts there.

| WS | Purpose | Reuse | Owned files / functions | Migration reservation | Depends on | Reviews | Isolated DB / browser E2E | Git completion | Release gate |
|---|---|---|---|---|---|---|---|---|---|
| **W0** | Close the open PRs | existing branches | #251, #266, #267, #269 only, by their owning sessions | `1206`, `1215` (existing) | — | Opus on the #251 rebase delta | #266 matrix; `tw4rv`, `feeres` suites | All four merged or closed by owner decision | G |
| **F1** | Pilot activation funding and activation hardening (F-1, F-3 evidence per U-4, F-10) | `_tw4act_funding`, `tw4_rfl_pilot_cover`, `tw4_act_*` | New migration replacing `_tw4act_funding` and the `tw4_act_*` lock order; `localStack.f1` suite. Sole owner of `_tw4act_*` / `tw4_act_*` bodies. | `20261218090000` | — | Opus financial + concurrency | Dedicated container; full-chain apply/rollback fingerprint | Merged; F-1 and F-10 VERIFIED | G → P |
| **F2** | Campaign-verified gate for the legacy billed fallback (S-2) | `_tw4sr_ready`, `_tw4sr_ready_core` | New migration replacing `_tw4sr_ready` only. Sole owner of `_tw4sr_*`. | `20261219090000` | U-3 | Opus security | Dedicated container | Merged; S-2 VERIFIED | G → P |
| **F3** | Reconciler readiness gate for billed usage (F-5); re-verify F-4 on the full chain | `tw4_usage_set_switch`, `tw4_usage_begin`, run leases (1205) | New migration replacing the usage switch/begin guard. Sole owner of `tw4_usage_*`. | `20261220090000` | — | Opus financial | Dedicated container | Merged; F-5 VERIFIED | G → P |
| **F4** | Evidence, recovery and exposure tooling (A-5 per U-1, A-6..A-10, A-12) | `provisionEvidence.ts`, `numberStore.ts`, 1212/1214/1216/1217 functions | New `src/app/platform/sms/Exposure*.tsx`, `RecoveryActions.ts`, `provisionLedger.ts`; migration for the audited retry wrapper, campaign RFL registration and the deferred-retirement listing. Owns `tw4_prov_observe`, `tw4_num_registration_*`. | `20261221090000` | W0 (#269) | Opus financial | Dedicated container; admin browser E2E | Merged; A-6..A-10, A-12 VERIFIED | G |
| **F5** | Provider release adapters and request-shape contracts (A-11, P-1, P-2) | `real.ts`, fakes, `tw4_rfl_cancel_*` | New methods in `real.ts`, `fakeNumbers.ts`, `fakeProvisioning.ts`; new `cancelRunner.ts`; contract tests | none expected | — | Opus (irreversible operation) | Fake adapter suite | Merged; A-11 VERIFIED with fakes | G; real calls = GATE |
| **J1** | Admin orchestration for R2a/R2b (A-1, A-2) | `provisionRunner.ts`, `numberRunner.ts`, `createScoped*Adapter`, `config.ts` | `src/lib/sms/twilioIsv/factory.ts`; new `src/app/platform/sms/provisioningRunActions.ts`; `adminView.ts`, `ProvisioningSummary` | none | — | Opus (fee-bearing path) | Fake adapter, isolated DB, admin browser E2E | Merged; A-1, A-2 VERIFIED | G |
| **J2** | Owner-safe facts read (O-2, O-4) | 1210 pattern, `ownerRead.ts`, `journey.ts` | New owner read function; `ownerRead.ts`, `journey.ts`, owner `page.tsx` | `20261222090000` | — | Opus security (tenant isolation) | Personas; owner browser E2E | Merged; O-2, O-4 VERIFIED | G |
| **J3** | Owner number selection and fee approval (O-3) | `tw4_num_select_as_owner` / `_withdraw_as_owner` | New `src/app/app/settings/sms/NumberSelection*.tsx`, `numberActions.ts` | none | J1, J2 | Opus security | Owner browser E2E with fake offers | Merged; O-3 VERIFIED | G |
| **J4** | Activation console (A-3, A-4) | `activation.ts` | New `src/app/platform/sms/Activation*.tsx`, `activationActions.ts` | none | J1, F1, F3 | Opus | Admin browser E2E through to `active` (fake) | Merged; A-3 VERIFIED | G → P |
| **M1** | Monitoring and scheduler routes (S-5, F-11; S-6 escalation per U-5). Routes only, `vercel.json` untouched. | `reconcileInventories`, `tw4_act_exposure`, run-lease pattern | New `src/app/api/cron/sms-*` routes | `20261223090000` if job kinds are needed | J1, F4, W0 (#251) | Opus on leases | Route + DB tests | Merged; routes 404 unless flagged | G → P |
| **Q1** | Isolated QA and E2E preparation (runs from day one) | #266 harness, `localStack*` fixtures, Playwright | `scripts/qa/**`, Playwright specs and fixtures for owner + admin TW-4F journeys | none | #266 | — | Full-chain scenario (1120→1217, then 1206, 1215); persona matrix | Harness scenario plus E2E specs merged; executed per slice | G |
| **H1** | Hosted DEV apply package (docs/scripts only) | Phase A fingerprint method | `docs/twilio/TW-4F_Hosted_Apply_Manifest.md`; SELECT-only probe scripts | none | — | — | — | Manifest merged; no execution | D |

**Parallel waves** (no shared SQL functions or files apart from the page mount line):

- **Wave 1:** W0, F1, F3, F4, F5, J1, J2, Q1, H1. F2 also joins once U-3 is answered.
- **Wave 2:** J3 (after J1 and J2), J4 (after J1, F1 and F3), M1 (after J1, F4 and #251).
- **Then:** full-journey execution of the isolated E2E (Q1 specs), followed by hosted DEV (H1) under separate authorization.

**Priority within wave 1:** F1 > F3 > F2 > F4 > F5 > J1 > J2. Q1 and H1 run alongside.

## 7. Open owner decisions

Already decided, and **not** reopened here:

- Subaccount per studio (D2).
- Standard + MIXED (D3).
- Advanced Opt-Out as a Console attestation (D4).
- $150 pilot cap, with a written approval for every fee (D5).
- Twilio pre-review (D6).
- Manual activation for the pilot (D8).
- Owner completes the wizard (D9).
- From RFL Ops D1–D6:
  - email via the outbound queue
  - fixed 7/35/14-day windows
  - two distinct admins for absorb and number cancellation
  - the ceiling is never auto-restored
  - no retroactive studio billing
  - no `vercel.json` cron
- Unexpected provider resources are DanceFlow-borne and the owner gets an informational notice only.
- R2b/RFL D1–D3, D5 and D6.

Still unresolved:

| ID | Decision | Why it matters | Source |
|---|---|---|---|
| U-1 | Lift `FEE_RELEASE_ENABLED` once an evidence console exists, or keep fee-bearing unknowns resolvable only as "created" or absorbed | Releasing held fees | `TW-4F_Prov_Fee_Resolution_Evidence.md` §7 ("a future slice may lift it only after … an owner decision") |
| U-2 | Exact published prices and whether publication needs a second admin | Nothing can be authorized without a published price; `tw4_price_set` is a single-admin action that takes effect immediately | `TW-4F-3b_Pricing_Proposal.md` (DRAFT) |
| U-3 | Legacy senders: refuse billed sending for locations without a verified campaign (F2); decide the future of the non-billed A2P-2 path | Compliance bypass vs live sending continuity | 20261214:665 |
| U-4 | What counts as a pilot period's "written approval": the free-text reference recorded by one admin (today), structured owner evidence, and/or two admins | The authorization is enforceable but its evidence is weak | `tw4_rfl_pilot_cover` (20261209:800) |
| U-5 | An out-of-band escalation channel when alert email delivery is exhausted | Escalation goes over the same failing channel | `TW-4F_RFL_Delivery_Runbook.md` §7 |
| U-6 | Extend the rent hold to locations with an authorization but no ledger activity | R2b/RFL D4: left to the owner | `TW-4F_R2b_RFL_Integration.md` §5 |
| U-7 | Owner self-service cancellation of a number or service, or admin-only | Scope of O-6 | — |
| U-8 | Who may turn DB kill switches on (one admin today) | Control over money movement | RFL Ops follow-up backlog |
| U-9 | SMS quiet hours: inside TW-4F or separate | Scope of S-8 | — |
| U-10 | D1: delete the parent-account Stage B draft before the real ConfiDance run | Required before Stage C | `TW-4F_Production_Onboarding_Plan.md` §11 |

## 8. Definition of done

**TW-4F Git completion (G):**

- W0, F1–F5, J1–J4, M1, Q1 and H1 are merged.
- Every `tw4_*` RPC has an app caller or a documented "SQL-only by design" note.
- The owner and admin journeys have been executed end to end in browser E2E on an isolated stack with fake adapters, and marked PASS.
- All `localStack` suites are green when run serially.
- The full-chain apply and reverse-rollback fingerprints round-trip.
- Opus reviews show no open P0 or P1.
- No P1 rows remain in this tracker.

**Hosted DEV (D), each step separately authorized:**

1. Fresh SELECT-only probe.
2. Ordered apply with per-file sha256 and fingerprints.
3. Reverse-rollback round trip while the database still has 0 rows.
4. Grants and RLS probe.
5. All flags and switches confirmed off; fake adapters only; no cron.

**ConfiDance pilot (P), each step separately authorized:**

1. PROD SQL, then app promotion.
2. Prices published (U-2).
3. Stage B draft handled (U-10).
4. Per-fee and per-period written approvals (U-4) within the $150 cumulative ceiling.
5. Real-provider validation, one call at a time.
6. Scheduled jobs registered: reconciler, inventory reconciliation, sender re-verification, RFL scan and delivery.
7. Alert recipients verified and the delivery runbook §7 executed.
8. Manual activation (D8).
9. First real SMS to a consented test recipient.

**General production (L):**

- Pilot retrospective.
- Decisions taken on U-3, U-5, U-7 and U-9.
- Funding-exposure monitoring live.
- Real cancellation validated.
- Per-studio gating for self-service onboarding.

## 9. Document inconsistencies to reconcile (not fixed here)

- `TW-4F_Production_Onboarding_Plan.md` §9a says `1120`/`1121` are NOT applied, while the 2026-10-19 Phase A record says DEV has `1120`–`1122`. Resolve this with the authorized hosted probe.
- `DanceFlow_Master_Roadmap.md:166` lists "Twilio Q1–Q5 confirmation … OPEN", but `TW-4F_Production_Onboarding_Plan.md` §13 records the ticket #29647095 answers as of 2026-10-19.
- `TW-4F_R2b_RFL_Integration.md` §6 lists "ConfiDance month-two controls" as open. The controls exist (`tw4_rfl_pilot_cover`), but activation is still blocked by `_tw4act_funding` (F-1).
- `TW-4F_Recurring_Fee_Lifecycle_Design.md` §12 lists D1–D6 as outstanding. They were decided in `TW-4F_RFL_Ops_Design.md` §1.
