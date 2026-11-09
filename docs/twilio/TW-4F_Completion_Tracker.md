# TW-4F Completion Tracker

Status: baseline audit 2026-10-22 at `960a9d02` (#271); final Git status 2026-10-23 at `0f5dc7b8` (§0). Documentation only. This file tracks how far TW-4F is from being complete and release-ready. It is **not a roadmap**: priorities come from `docs/roadmap/DanceFlow_Master_Roadmap.md` (v2.22), and design decisions come from the TW-4F design documents cited below. When this tracker disagrees with an approved design document, the design document wins and the disagreement is listed in section 9.

## 0. Final Git status (2026-10-23, `main` = `0f5dc7b8`)

This section supersedes the per-row statuses in §3. Those rows record the baseline audit at `960a9d02` and are kept as history.

All pilot-blocking TW-4F code is merged into `main`. It is Git only: no migration is applied to any hosted database, nothing is deployed, no scheduler is registered, every flag and DB switch is off, and no live Twilio, Stripe or SMS activity has happened.

| Req | Final Git status | Merged PR → squash commit |
|---|---|---|
| O-2, O-4 owner number, sender, compliance and RFL status | VERIFIED (dark) | #276 → `09ffea39`; owner-language areas in #294 |
| O-3 owner number selection and fee approval | VERIFIED (dark) | #294 → `210f2b8e` (1227). The approval does not check the ceiling; the purchase does |
| A-1, A-2 admin R2a/R2b orchestration | VERIFIED (dark) | #278 → `de9b9f99` |
| A-3, A-4 activation console and AOO attestation | VERIFIED (dark) | #298 → `897120e1` (1226) |
| A-5..A-10, A-12 evidence, orphan exposure, ledger read, gaps/retry, deferred retirement, campaign RFL registration | VERIFIED (dark) | #288 → `973f36da` (1221); #269 → `6422e050` (1215) |
| A-11, P-1, P-2 provider release adapters and offline request-shape contracts | VERIFIED offline; real calls are a GATE | #279 → `d2489cc9` (1224); hardening #299 → `0f5dc7b8` |
| F-1, F-10 pilot funding continuity and act lock order | VERIFIED (dark) | #280 → `86dc9b1e` (1219); #290 → `c982d7fa` (1225, D5 cover rule) |
| F-5 reconciler readiness gate | VERIFIED (dark) | #277 → `2877bab7` (1218) |
| S-4 24h sender re-verification | VERIFIED (dark, unscheduled) | #251 → `cdf342e2` (1206) |
| S-5 scheduled inventory reconciliation | VERIFIED (dark, unscheduled; read-only `TW4_NUMBER_READS`) | #296 → `893941b0` (1223) |
| A9b activation compliance reads without the purchase switch | VERIFIED (dark) | #300 → `84f52048` |
| S-2 legacy sender campaign gate (F2) | NOT STARTED: waits on U-3 | — |
| A-13, F-11, F-12, S-8, U-5 | Not pilot-blocking (§8A B/C) | — |
| Browser E2E for owner and admin journeys | BLOCKED: the isolated stack has no auth (GoTrue) | #275 scaffolding |

Known issues carried forward: KI-1 (pilot double capture; activation is blocked in the DB until the owner re-decides), KI-2 (rollback leaves widened CHECK constraints), KI-3 (r2bp2.rfl stale test on main). See §7.

### 0.1 Owner decisions and follow-up merges (2026-10-24, `main` = `67bb64f2`)

**Owner decisions (2026-10-24):**

- **U-2.** Do not publish cost-plus-25% as final or interim pricing. A validated pricing recommendation is being prepared (docs only). Inbound and outbound prepaid ledger tracking stay separate. No live pricing change.
- **U-4.** A pilot approval must reference a dated, explicit written owner authorization that is retained and auditable: scope, amount, period and action. A reference alone is not authorization.
- **U-10.** The cleanup policy for the obsolete Stage B draft is approved, conditional on verifying its identity and keeping the evidence. The Twilio Console deletion needs a separate explicit authorization.
- **KI-1.** Fix the double capture with a new migration. The `pilot_ki1_redecided` activation block is not bypassed.
- **#290 P2-2.** The billing-month safeguard stays until Twilio evidence is verified.
- **Two-admin control.** A second platform admin is unconfirmed, so the requirement stays fail-closed.

**Merged (owner-approved squash merges, head-pinned, tree verified, Git-only):**

| PR | Change | Migration | Merge commit |
|---|---|---|---|
| #305 | U-4 evidence for pilot period covers. The 11-argument `tw4_rfl_pilot_cover` requires structured evidence (role, scope, amount equal to the published price, period, document id/link plus sha256, never the text) in an append-only table. `approval_ref` is 3..200 in SQL, with a minimum of 10 in the RPC, action and form. | 1229 | `522a35bd` |
| #308 | Test fixes. The f1funding rollback control works with 1226. The j4activation KI-1 assertion allows readers. | — | `e365c317` |
| #307 | KI-1 fix. A cross-month pilot campaign reservation is released, not captured, with an admin alert. The activation block is untouched. | 1228 | `fae5e325` |
| #309 | Test fix. The tw4rfl rollback copy follows strict reverse order. | — | `c2ac7a5f` |
| #316 | U-4 evidence for every pilot spend approval: `tw4_spend_authorize` for the pilot (credit refuses evidence), `tw4_pilot_exception_create` (evidence amount equals the ceiling), and the period cover. It adds the append-only `studio_sms_pilot_spend_evidence` table and an exhaustive scope-to-fee-kind map. Opus found no P0/P1/P2. | 1230 | `67bb64f2` |

**Rollback note.** After 1229, `1219` cannot be re-applied unless 1229 is rolled back first, because its precondition expects the 4-argument `tw4_rfl_pilot_cover`. Hosted rollback must follow the strict reverse of the apply order (manifest §5.1), and 1230 is rolled back first.

**Hosted apply-order gate (1230).** 1230 refuses to apply once any pilot exception exists or any live evidence-free pilot approval exists. Apply it before ConfiDance's pilot exception or any pilot approval is created, and quiesce all administrative pilot actions for the duration of the apply. The precondition is that no pilot exception has ever existed. The exemption 1230 carries for #305 period covers is dead code on any hosted target, because no hosted cover exists. Hosted DEV and PROD have none today (probe 2026-10-24).

**Not verified for #316:**
- `tw4fj1` is BLOCKED by a harness limitation; it fails identically on plain main.
- The Playwright spec `sms-subaccount-panel-fees` is BLOCKED: there is no auth-capable isolated stack.

**Pilot-activation blockers still open:**

1. ~~U-4 for pilot spend and reservation approvals~~ **DONE in #316 (1230).**
2. **KI-1 activation block.** It is lifted only by a later migration, after the owner re-decides now that the fix (#307) is merged.
3. **Prices not published.** U-2 is pending the validated recommendation.
4. **Stage B draft.** The deletion needs separate authorization (U-10).
5. **Security finding (P1, not TW-4F-specific).** Platform-admin server actions check only `platform_role`, not MFA/`aal2`. The page layout enforces MFA, but server actions can be called directly. The fix needs owner approval (shared auth boundary).
6. **Security finding (P2).** The platform client-linking action upserts `platform_role: null` (`src/app/platform/actions.ts:518-524`). It could demote an admin whose email matches a client.
7. **Second platform admin.** None is confirmed. The prerequisites are `profiles.platform_role = 'platform_admin'` (granted today only by a manual, unaudited service-role SQL update, which needs owner authorization), TOTP enrolment at `/platform-mfa/setup`, and a different human (enforced by policy only). With one admin, absorb-exposure and number cancellation stay blocked (fail-closed).
8. **Approval-amount UX follow-up (from #305).** The form takes a dollar amount instead of showing the published price.
9. **Pilot spend hardening (financial/security, bounded, from #316).** This must land before live pilot activation. A direct `tw4_spend_authorize` call can still use the `pilot_period_cover` scope. Restrict it to calls made through `tw4_rfl_pilot_cover` (for example a transaction-local flag that only that function sets), or require the covered period to be the current or next month. The same review must also evaluate a deferred `ENABLE ALWAYS` constraint trigger that requires the evidence row to exist by commit for every pilot spend event and every pilot exception. It needs a new migration, tests and Opus review; it is not started or authorized.

Hosted state is unchanged by all of the above: DEV fingerprint `bf10276e`, PROD `d17059a0`, re-confirmed read-only on 2026-10-24.

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
| **F1** | Pilot activation funding and activation hardening (F-1, F-10, reconciler checklist item; F-3 evidence waits on U-4) | `_tw4act_funding`, `tw4_rfl_pilot_cover`, `tw4_act_*` | New migration replacing `_tw4act_funding` and the `tw4_act_*` lock order; `localStack.f1` suite. Sole owner of `_tw4act_*` / `tw4_act_*` bodies. | `20261219090000` | — | Opus financial + concurrency | Dedicated container; full-chain apply/rollback fingerprint | Merged; F-1 and F-10 VERIFIED | G → P |
| **F2** | Campaign-verified gate for the legacy billed fallback (S-2) | `_tw4sr_ready`, `_tw4sr_ready_core` | New migration replacing `_tw4sr_ready` only. Sole owner of `_tw4sr_*`. | `20261220090000` (reserved, not launched) | U-3 | Opus security | Dedicated container | Merged; S-2 VERIFIED | G → P |
| **F3** | Reconciler readiness gate for billed usage (F-5); re-verify F-4 on the full chain | `tw4_usage_set_switch`, `tw4_usage_begin`, run leases (1205) | New migration replacing the usage switch/begin guard. Sole owner of `tw4_usage_*`. | `20261218090000` | — | Opus financial | Dedicated container | Merged; F-5 VERIFIED | G → P |
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

### 6.1 Ownership ledger (Wave 1, launched 2026-10-22)

This is the only ownership record. A slice edits only the files and SQL functions listed against it. A change outside its row needs agreement from the coordinator (session "DanceFlow TW-4F completion audit") first. Each PR merges only with separate owner approval.

Every slice starts from `main` = `960a9d02` in its own worktree, cut by the app from branch `twilio-tw4f-<slice>`. When this ledger was written, no migration timestamp above `20261217090000` existed on any remote branch or as an untracked file in any worktree.

| WS | Session | Branch | Owned files | Owned SQL functions | Migration | Depends on | Parallel status |
|---|---|---|---|---|---|---|---|
| W0 #251 | TW-4F scheduled SMS reconciliation & recovery (existing owner) | `twilio-tw4f-sender-reverify` | `SenderIdentity.tsx`, `page.tsx` (merge-conflict resolution), `senderVerification.ts`, route `sms-sender-reverify` | `_tw4sr_judge`, `tw4_sender_reverify`, `tw4_sender_due_reverify`, `tw4_sender_health`, `tw4_sender_reverify_run` | `20261206090000` | — | Rebase requested |
| W0 #266 | Automated Twilio sender provisioning (existing owner) | `twilio-tw4f-isolated-qa` | `scripts/qa/iso-qa.mjs` and the harness files | — | — | — | Refresh requested |
| W0 #267, #269 | DanceFlow provisioning UI (existing owner) | `twilio-r2a-rollback-test`, `twilio-prov-evidence-orig-scope` | `localStack.r2a.test.ts`; `provisionEvidence.ts` (#269 scope) | `tw4_prov_evidence_targets` | `20261215090000` | — | Refresh requested |
| F3 | tw4f-f3-recon-gate | `twilio-tw4f-f3-recon-gate` | `UsageReconciliation.tsx`; new `localStack.f3recon`, `usageReconcilerReadiness.ts`; **send-path enforcement (owner-approved 2026-10-22):** `src/app/api/sms/send/route.ts`, `src/lib/notifications/dispatch.ts`, `src/lib/sms/usageBilling.ts` and their existing tests; `src/lib/notifications/deliveryOutcome.ts` (approved 2026-10-23, limited to classifying `sms_billing_paused` as definitely unsent: the refusal happens before any provider call); `docs/twilio/TW-4F_Usage_Reconciliation_Runbook.md`; `localStack.tw4recon`, `localStack.tw4usage`, `senderFixtures.ts`; shared: `localStack.tw4sender.test.ts`, `page.tsx` (see notes) | `tw4_usage_begin`, `tw4_usage_set_switch`, new `_tw4usage_reconciler_ready()` (a contract F1 depends on) | `20261218090000` | #251 for the shared files | Resumed after outage |
| F1 | tw4f-f1-funding | `twilio-tw4f-f1-funding` | new `localStack.f1funding` | `_tw4act_*`, `tw4_act_*` (acquires locks from the `act_*` side only; must stop before touching `tw4_num_retire` / `tw4_num_observe`) | `20261219090000` | F3 helper, for the checklist item only | Running |
| F2 | not launched | — | — | `_tw4sr_ready`, `_tw4sr_ready_core` | `20261220090000` (reserved) | U-3 | Waiting on decision U-3 |
| F4 | tw4f-f4-recovery | `twilio-tw4f-f4-recovery` | `provisionLedger.ts`, `ProvisioningLedger.tsx`, `provisioningActions.ts`; new `Exposure*`, `Recovery*`, `NumberLedger*`, `recoveryActions.ts`; one mount line in `page.tsx` | `tw4_prov_observe`, `tw4_num_registration_*`, new recovery/exposure reads | `20261221090000` | #269 (merge `main` in after it lands) | Running |
| F5 | tw4f-f5-release | `twilio-tw4f-f5-release-adapters` | new methods only in `real.ts`; `fakeNumbers.ts`, `fakeProvisioning.ts`; new `cancelRunner.ts`; `RecurringFeesCancel.tsx`; `cancel_*` actions in `recurringFeeActions.ts` | new read-only `tw4_rfl_cancel_target` (service_role only; `tw4_rfl_cancel_*` SQL bodies unchanged) | `20261224090000` | — | Running |
| J1 | tw4f-j1-orchestration | `twilio-tw4f-j1-admin-orchestration` | `factory.ts`, `adminView.ts`, `ProvisioningSummary.tsx`, `SmsOnboardingPilot.tsx`; new `provisioningRunActions.ts` | none | none | F5 builder signature (optional) | Running |
| J2 | tw4f-j2-owner-read | `twilio-tw4f-j2-owner-reads` | `ownerRead.ts`, `journey.ts`, `src/app/app/settings/sms/page.tsx` and the journey/status components it renders (not `actions.ts`, not `SmsCancelSetup`) | new owner texting-status function | `20261222090000` | — | Running |
| Q1 | tw4f-q1-qa | `twilio-tw4f-q1-qa-e2e` | new `scripts/qa/tw4f/**`, `e2e/tests/tw4f-*.spec.ts`, `e2e/helpers/tw4f*.ts`, `docs/qa/TW-4F_QA_Baseline.md` | none | none | #266 for the harness | Running continuously alongside the other slices |
| H1 | tw4f-h1-manifest | `docs-tw4f-hosted-manifest` | new `docs/twilio/TW-4F_Hosted_Apply_Manifest.md`, `scripts/hosted/tw4f/**` | none | none | — | Running |
| M1 | not launched | — | new `src/app/api/cron/sms-*` routes | job kinds if needed | `20261223090000` (reserved) | J1, F4, #251 | Wave 2 |
| RFL-D5 | Twilio recurring fee lifecycle control (existing RFL owner) | fresh worktree from 78bc699c | RFL SQL only + its localStack tests | `_tw4rfl_register_core` (skip cross-month initial_reservation binding), `tw4_rfl_pilot_cover` (may supersede a non-counting initial_reservation cover), `_tw4rfl_cover` / `rfl_ready` (D5 alignment) | `20261225090000` | D5; found by F1 #280 + #288 review (2026-10-23) | Requested |
| J3 | J2 session (tw4f-j2-owner-read) | `twilio-tw4f-j3-number-selection` (merges #276) | new owner `NumberSelection*.tsx`, `numberActions.ts`; `number.actionHref` in `journey.ts`/`ownerRead.ts` | new owner-scoped offer read if needed | `20261227090000` | #276, J1 #278 offers | Started 2026-10-23 (owner-approved) |
| J4 | F1 session (tw4f-f1-funding) | `twilio-tw4f-j4-activation-console` | new `Activation*.tsx`, `activationActions.ts`, `activation.ts`, one `page.tsx` mount | `_tw4act_*`/`tw4_act_*` incl. the deferred `superseded_at` filter (needs 1225) | `20261226090000` | #280 recheck after #290; #277 | Approved; starts after #280 recheck |
| INV-R | F4 session (tw4f-f4-recovery) | `twilio-tw4f-inventory-reconcile-route` (merges #278) | new `src/app/api/cron/sms-inventory-reconcile/route.ts` (flag `SMS_INVENTORY_RECONCILE`, no vercel.json) | only if a job kind is needed | `20261223090000` (needed: extend run job check with `inventory_reconcile`, replace `tw4_reconcile_run_begin` job list only, new `tw4_reconcile_run_alive`) | J1 #278 `buildNumberRuntime` | Started 2026-10-23 (owner-approved) |
| J3, J4 | not launched | — | J3: new owner `NumberSelection*`, `numberActions.ts`. J4: new `Activation*`, `activationActions.ts` | none | none | J3: J1 + J2. J4: J1 + F1 + F3 | Wave 2 |
| A #312 | TW-4F AAL2 (slice A) | `claude/twilio-tw4f-aal2` | AAL2 enforcement (#312); files per PR #312 | per PR #312 | `20261231090000` (reserved) | #316 (1230) | Git-only. Renumbered from `20261230090000` (see note below). |
| B Blocker 9 | TW-4F Blocker 9 (slice B) | `claude/twilio-tw4f-b-blocker9` | Blocker 9; files per its PR | per its PR | `20261231100000` (reserved) | 1230; sequenced after `20261231090000` | Git-only. Apply order: 1230 → 1231 → 1231b. |

**Migration timestamp reservations (2026-10-24).** `20261231090000` is reserved for slice A (AAL2, #312) and `20261231100000` for slice B (Blocker 9). `20270101090000` through `20270112090000` belong to Competition and must not be used by TW-4F. #312's earlier use of `20261230090000` collided with merged #316 and is being renumbered to `20261231090000`.

Notes on the files more than one slice touches:

- **`src/app/platform/sms/page.tsx`:** merge order is **#251 → F4 → F3**. #251 resolves its pending merge conflict first. F4 owns the recovery-panel mount (import + one element) and rebases onto #251. F3 adds only its readiness integration (one import, one load, one prop on `UsageReconciliation`) and rebases onto whichever of #251/F4 has merged. No slice rewrites the page or removes another slice's lines.
- **`src/lib/sms/__tests__/localStack.tw4sender.test.ts`:** #251 and F3 both change it. #251 lands first; F3 rebases and adds its assertions next to #251's. Neither session deletes or weakens the other's assertions; a needed change to the other's assertion goes through that session.
- **`src/lib/sms/provisioning/__tests__/journey.r2c.test.ts`:** J1 owns its additions in this file. J2 keeps its tests in `journey.j2.test.ts` and does not edit this file. If J2's `journey.ts` change breaks an assertion here, J2 asks J1 to update it. J1 must not overwrite J2's changes in `journey.ts`.
- **RFL-owned files** (`recurringFeeActions.ts`, `RecurringFeesCancel.tsx`) are with F5 for this wave. The RFL and R2b sessions have been told who owns what.

### 6.2 Recovery checkpoint (2026-10-22, after the API outage)

Every Wave 1 session and the #251/#266 owners stopped on an API connectivity error at about 21:00Z. No work was lost; each session resumed in its original worktree. Rules on resuming: preserve all uncommitted work (no reset, stash, clean or force-push); each session manages only its own QA containers, removing one only after confirming no test is running and no evidence is needed from it; at most two or three database-heavy suites run on the machine at once.

Open PRs, revalidated 2026-10-22 (CI = the required "Typecheck, build, lint, unit/integration tests" check; Playwright E2E is skipped by design):

| PR | Head | Mergeable | CI | Status |
|---|---|---|---|---|
| #251 | 0fe7a622 | CONFLICTING | green (old head) | Pending conflict resolution (merge of `main` in progress locally) |
| #266 | d90a9f17 | CLEAN | green | QA harness verification; local merge of `main` not yet pushed |
| #267 | 59ecf3f0 | CLEAN | green | Awaiting owner merge decision |
| #269 | 5a2432d3 | CLEAN | green | **MERGED** 2026-10-23 → main 6422e050 |
| #273 | this PR | CLEAN | docs | Completion tracker |
| #274 | a6074a92 | CLEAN | docs | H1 hosted manifest; F1/F4/J2 hash rows follow their PRs |
| #275 | c858ddc1 | CLEAN | green | Q1 QA/E2E preparation; partial baseline, re-run on an idle host |

Re-checked 2026-10-23 with `gh pr view`; `main` is still `960a9d02`. Every PR below is MERGEABLE and CLEAN. The required check is green on each code PR (Playwright skipped), and the docs PRs carry only Vercel checks.

| PR | Head | Scope | Merge-readiness |
|---|---|---|---|
| #251 | d3a5d136 | Sender re-verification, 1206 | **NOT READY (one P2).** Conflict resolved by merging `main` in; page.tsx changes are additive only; all 16 files are in scope. tw4rv + tw4sender 45/45 on a dedicated DB (1207..1217 then 1206). An independent review (2026-10-23) found a P2: `inbound_route_ok` is computed from a number read that failed transiently, so a 429 turns into a definitive FAILED (`senderVerification.ts:281-285`). The fix is with the owner. The full suite matrix with 1206 applied after 1217 has not run yet (#266 owner will run it on the final head); catalogs are identical for any 1206 position. Merge first among the `page.tsx` PRs. |
| #266 | 872a9130 | Isolated QA harness | `main` merged in, full-chain scenarios added. Final verification evidence is still awaited from its owner. |
| #267 | 59ecf3f0 | R2a layered rollback test | Ready for the owner's decision. |
| #269 | 5a2432d3 | Evidence original scope, 1215 | **MERGED 2026-10-23 (squash, owner-approved) → main `6422e050`; Git-only, 1215 not applied hosted.** Was READY WITH NOTES (P3 only). An independent review (2026-10-23) confirmed that evidence is bound to the operation's own Messaging Service and account, that cross-scope substitution is refused (TW049, `scope_changed`), and that tenant/lease gating and the fee-release safeguards are intact. 1215 is compatible after 1217 and grants service_role only. feeres 46/46 on this exact head (1207..1217 with 1215). Carry-forward: once the evidence scheduler is wired, `scope_unavailable` and skipped targets must escalate to an operator. F4 depends on it. |
| #273 | this PR | Tracker | Docs only. |
| #274 | e4116404 | H1 hosted manifest | Docs only. F3 and J2 rows provisional; F1, F4 and F5 rows wait for their PRs. |
| #275 | c858ddc1 | Q1 runner and E2E scaffolding | Baseline partial (load); needs a re-run on an idle host. |
| #276 | d99f42a0 | J2 owner reads, 1222 | j2owner 12/12, r2ci2 15/15, unit 205/205. r2b and tw4rfl BLOCKED by load; owner browser E2E BLOCKED. |
| #277 | c3971961 | F3 reconciler gate, 1218 | f3recon 10/10, tw4recon 37/37, tw4usage 26/26, tw4inbound 28/28, tw4sender 18/18 (3 on a solo rerun). r2b not applicable on the main chain. Includes the accepted out-of-ledger `deliveryOutcome.ts` token. `page.tsx` and `tw4sender` test rebase after #251 (and F4) merge. |
| #278 | 629e7314 | J1 admin orchestration, no SQL | tw4fj1 11/11, r2b 53/53. **Open:** the PR body calls r2a (15 failures), r2brfl (1) and r2bp2.rfl (1) pre-existing, but no main-only control run was done, and #267's refresh reported r2a 28/1 skipped/0 failed on the same chain. Needs a main-only r2a control before the claim is accepted. |
| #279 | 57780760 | F5 release adapters, 1224 | f5canceltarget 8/8, contract 10/10, runner 26/26; tw4rfl 85/87 (load timeout; the run was cut by the 40-minute cap), tw4rflops 63/64 (QA-image grant gap). **Two deferred P2s need the owner's disposition before merge:** P2-3 (provider request IDs in the evidence digest) and P2-4 (RFL-owned `beginCancel` maps a malformed execute to skip). Real Twilio DELETE BLOCKED. |
| #280 | 4046b8f6 | F1 pilot funding + act lock order, 1219 | f1funding 25/25 with and without 1218, tw4rfl 87/87, r2brfl 27/28 (load-sensitive wall-clock check). tw4rflops, r2b and full pilot activation BLOCKED. Redefines only `_tw4act_*`/`tw4_act_*` (adds `_tw4act_pilot_funding`); `tw4_num_retire`/`tw4_num_observe` are referenced in comments only. **Merges after #277** (apply 1218 then 1219; roll back 1219 first). |

Not yet a PR: F4 (local 231efad3), waiting for its DB slot and for #251 and #269 to merge.

Follow-ups recorded during Wave 1:

- `_tw4ml_month_start` scans `pg_timezone_names` on every call for a business with no `studio_sms_entity_timezones` row; this can hit the 8 s authenticated statement timeout in production (found by J2; may be a gap left after `20261202140000`). Owner: RFL/monthly limits.
- The #266 base image lacks `auth.users` columns (`email_confirmed_at`, `banned_until`, `deleted_at`) and the default `authenticated` UPDATE/DELETE grant on `outbound_deliveries`; tw4rflops cannot run on a stock stack until #266 adds both.
- Interrupted tw4rfl / r2brfl / r2bp2 runs leave pilot-exception and orphan rows behind that break later suites on the same database; run one suite per fresh database.

### 6.2a Merge log (owner-approved, Git only)

Every merge below is Git only. Nothing is applied to any hosted database, no deploy ran, and no scheduler or SMS is enabled.

| PR | Approved head | Squash commit on `main` | Verification |
|---|---|---|---|
| #269 | 5a2432d3 | 6422e050 | Tree equals the approved head |
| #251 | 9de9eb4c | cdf342e2 | Tree equals `git merge-tree 6422e050 9de9eb4c`. The only difference from the approved head is #269's 6 files. 1206 is not applied hosted, the route is unscheduled and `SMS_SENDER_REVERIFY` is off. |

**After #251** (re-checked 2026-10-23): every open PR is MERGEABLE/CLEAN against cdf342e2.

| PR | Head |
|---|---|
| #266 | 99cea902 |
| #267 | 59ecf3f0 |
| #274 | 26dec94e |
| #275 | f5a84651 |
| #276 | d99f42a0 |
| #277 | c3971961 |
| #278 | 629e7314 |
| #279 | 57780760 |
| #280 | 4046b8f6 |
| #288 | 42e26eb8 | F4 recovery tooling, 1221 | **MERGED 2026-10-23 (squash, owner-approved) → main `973f36da`; Git-only, 1221 not applied hosted.** f4recovery 26/26, r2brfl 28/28 on the final head; independent review P1/P2 fixed; KI-1 kept by owner decision. |

`page.tsx` order from here:
- F4 (#288) merges main and re-runs.
- F3 (#277) merges main now. It keeps #251's `tw4sender` assertions and merges main again after #288.

**#266 final main baseline** (6422e050, single lane): 19/23 suites PASS.
- tw4payhardening passed 15/15 on a single lane.
- With its new per-stack steps (auth.users columns, `outbound_deliveries` grant, opt-in `ISO_QA_MARKER`), tw4rflops passes 64/64 on a stock stack.
- Known failures: tw4a 1/14, tw4f1b 1/19 and r2a 1/26 (2BP01).
- `localStack.r2b` is not verified: 53 skips by design on the merged chain.
- `matrix main-then-pr251` is superseded by the merge.

**#267 vs 1221 (F4):**
- With 1221 present, 1209's rollback refuses while lifecycle rows exist. That is fail-closed by design.
- Fix in #267, test-only, about 15–25 lines: `clearFixtureEvidence` also deletes the suite's own lifecycle and `rfl_%` audit rows, plus one assertion that the guard still refuses when those rows are left. Layer discovery already handles 1221.
- Proven with one 1221-enabled DB run.

### 6.3 QA scheduling decision (owner, 2026-10-23)

- **Heavy-slot order:** #251 P2 re-test and F4's regression suites run now, alongside #266's remaining matrices. No other resource-intensive suite starts if it would materially compromise test reliability.
- **Q1 baseline:** once #251, F4 and #266 have finished heavy testing and released their containers, Q1 runs the full localStack baseline as the **only** resource-intensive job on the host. After it, Q1 runs the inexpensive migration-chain checks for #276–#280.
- **No duplicate baselines:** before starting, Q1 checks which suites #266 has already verified (head, chain, and verified-pass results only) and skips equivalent coverage.
- **The main-only control comes from the Q1 baseline.** It settles #278's "pre-existing" claim for r2a / r2brfl / r2bp2.rfl, which stays UNVERIFIED until then.
- **Evidence rules for every run:**
  - Record the host CPU, free RAM and container count.
  - Timed-out, skipped, killed or infrastructure-blocked tests are never passes.
  - Report real regressions separately from resource-exhaustion failures.
  - Preserve existing evidence.
  - Each session cleans up only the containers and processes it owns.
- Independent coding, code review and lightweight tests continue while Q1 waits.

**#266 verified coverage** (harness 872a9130, chain 1207..1217 without 1215; each a PASS with exit 0 on a fresh DB, none skipped):

| Area | Suites (tests) |
|---|---|
| Billing | tw4f3bpay 18, tw4f3bui 7, tw4monthly 28, tw4recexec 20, tw4recurring 30 |
| SMS | tw4inbound 28, tw4recon 37, tw4sender 18 (main's version), tw4usage 26 |
| Provisioning | r2ci1 10, r2ci2 15 |
| twilioIsv | dryRun.tw4r1 15, isolatedQa.canary 5, feeres 43, tw4f3a 16, tw4f3b0 18, tw4fi 25, tw4r1 11 |

**Not verified:**
- tw4payhardening: timeouts; its 60-run property test is pinned at 90 s.
- r2b: 53 skipped. Its beforeAll refuses a DB that has the real 1209 lifecycle, so it runs only on a partial chain. Follow-up for R2b/RFL.
- tw4a, tw4f1b, r2a: known failures.
- tw4rfl and tw4rflops: `matrix` does not discover them.

Compare runs main-then-pr251, pr251-then-main and pr251-mid are identical (0 catalog differences). #266 is rerunning on main 6422e050, with 1215 included. That rerun is the authoritative main baseline for the suites `matrix` discovers.

**Q1 exclusive run scope** (after #251, F4 and #266 release), so no duplicate work:
- tw4rfl and tw4rflops (TW4RFL_DB, ISO_QA_MARKER)
- tw4payhardening run solo
- the #278 control: r2a, r2brfl and r2bp2.rfl on #266's iso-qa stack, on main and on J1's branch, one fresh DB each. J1's original harness differed from iso-qa (proxy, GUCs, transaction wrapping, readiness), so its 15 r2a failures may be a harness artifact.
- the chain checks for #276–#280

**#279 tw4rfl, exact result:**
- 85 PASS
- 1 PASS when run alone ("EXHAUSTED funding…"), after a load timeout
- 1 BLOCKED (resource): the rollback test was killed by the 40-minute cap and not re-run

**#274 head:** 26dec94e. The 1215 row is merged; 1218, 1219, 1222 and 1224 are provisional. Hash verifier and probe sync were not re-run after these edits.
- This decision authorizes no merges, hosted migrations, deployments, provider spending, scheduler activation or SMS activation.

Heads, CI and mergeability are re-checked before any merge is recommended. No PR merges without separate owner approval.

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

**Known pilot-ceiling issue KI-1** (owner decision 2026-10-23: keep the current behavior for now; must be revisited before ConfiDance activation):

- **Where:** R2a `tw4_prov_observe` (20261207, unchanged by F4) captures the pilot's monthly campaign reservation when the campaign is approved, with no month check.
- **Effect:** suppose an attempt reserves in October and approval lands in November.
  - The October reservation is captured.
  - Under D5 it covers no lifecycle period, so F4 #288 attaches no cover.
  - November then needs its own `tw4_rfl_pilot_cover`, which captures a second time.
  - The result is two pilot captures against ConfiDance's prepaid credit and the $150 cumulative ceiling for one provider month.
- **Pinned** by a real-path test in #288 (it asserts 2 captures), so the behavior stays visible.
- **Recommended fix** (not authorized yet): release the earlier reservation in `tw4_prov_observe` when approval lands in a later month. It belongs in its own migration with an Opus financial review.
- **Gate:** ConfiDance activation (P) may not proceed until the owner re-decides KI-1.
- **Related:** RFL-D5 (#290) does not address this capture.
- **Same family, added 2026-10-23 (#290 Opus P2-2):** D5 keys the first-month cover on the month the reservation was created, which can differ from the month Twilio bills the first monthly fee (for example, a campaign submitted 25 Sep that finishes vetting 5 Oct). The cross-month rule could then use the $150 ceiling twice for one Twilio fee. Resolving it needs provider evidence of the billing month, or explicit owner acceptance in D5. There is no rule change now; it is part of the KI-1 re-decision before activation.
- **Rollback-order caveat (#290 P3):** the merged 1211/1217 rollbacks do not refuse when 1225 is applied, so a wrong reverse order silently drops the D5 check. Hosted rollback must strictly reverse the apply order (H1 manifest).

**Known rollback-completeness gap KI-2** (found by Q1, #275, 2026-10-23; owner decision pending):

- After rolling back 1207..1217, three CHECK constraints stay wider than the baseline: `studio_sms_approval_refs_shape`, `studio_sms_approval_refs_source_check` (still accept `number_selection`) and `studio_sms_onboarding_audit_action_check` (still lists later action names).
- This is safe (a widened allowlist). It is on `main` and was not introduced by any slice.
- **Recommendation:** document it as intentional, because narrowing fails once rows use the values.

**Main-level test finding KI-3** (Q1, #275):

- `localStack.r2bp2.rfl` fails 2/3 on plain `main`, deterministically and not from load.
- **Likely cause:** a stale test. `tw4_rfl_alerts_claim` returns nothing while the RFL delivery switch is off (fail-closed), and the test never turns delivery on.
- **Next step:** confirm the cause and fix the test, not the fail-closed function.

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
4. Per-fee and per-period written approvals (U-4) within the $150 cumulative ceiling. Known issue KI-1 (double pilot capture when approval lands in a later month than the reservation) has been re-decided by the owner.
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

## 8A. Pilot closeout plan (2026-10-23, owner reprioritization)

TW-4F moves to a focused pilot closeout. Competition E2E, New Student Intake and mobile now run alongside it.

**Baseline.** `main` = `973f36da`. #251, #269 and #288 are merged (Git-only). None of 1206, 1215 or 1221 is applied to a hosted database.

**Verified gaps.** I checked `main` and every open PR head with `git grep` for non-test callers. These three capabilities are missing everywhere:

| Gap | Evidence of absence | Why it blocks the pilot |
|---|---|---|
| Owner number selection and fee approval (J3) | `tw4_num_select_as_owner` has no caller on `main` or any open head | Number fees need the owner's authorization, so they cannot run without it |
| Activation console (J4) | No importer of `src/lib/sms/activation.ts` | Nothing reaches `active`. The pilot needs manual platform activation (D8) |
| Scheduled inventory reconciliation route | `reconcileInventories` has no caller; there is no `src/app/api/cron/sms-inventory*` | `_tw4sr_ready` holds sending once inventory health is stale (>24h) |

### A. Mandatory for a safe ConfiDance pilot

| # | Item | Owner / where | Required tests | Status |
|---|---|---|---|---|
| A1 | F3 reconciler gate | #277, F3 session | — | **MERGED 2026-10-23 → main `2877bab7`** (Git-only) |
| A2 | RFL-D5 cover month rule and supersede | #290, RFL session | — | **MERGED 2026-10-23 (owner-approved) → main `c982d7fa`**; d5 21/21, tw4rfl 87/87, tw4rflops 64/64, r2brfl 28/28, f4recovery 26/26; Opus clean; Git-only |
| A3 | F1 pilot funding and activation lock order | #280, F1 session | — | **MERGED 2026-10-23 → main `86dc9b1e`** (Git-only); f1funding 25/25 with and without 1218 |
| A4 | J1 admin provisioning orchestration | #278, J1 session | — | **MERGED 2026-10-23 → main `de9b9f99`** (no SQL) |
| A5 | J2 owner status reads | #276, J2 session | — | **MERGED 2026-10-23 → main `09ffea39`** (Git-only). Follow-up: map `usage_reconciler_ready`/`pilot_ki1_redecided` to owner-language areas instead of "other" |
| A6 | F5 release adapters | #279, F5 session | — | **MERGED 2026-10-23 → main `d2489cc9`** (1224 Git-only). P3 hardening follow-up: throwing-getter test, fake-hub release test, accept only `provider_read` evidence on the real path, document the 401 retry after token rotation |
| A7 | **J3 owner number selection** | #294, J2 session | — | **MERGED 2026-10-23 → main `210f2b8e`** (1227 Git-only) |
| A8 | **J4 activation console** | #298, F1 session | — | **MERGED 2026-10-23 → main `897120e1`** (1226 Git-only; KI-1 pilot activation block enforced in the DB) |
| A9 | **Inventory reconciliation route** | #296, F4 session | — | **MERGED 2026-10-23 → main `893941b0`** (1223 Git-only; flag `SMS_INVENTORY_RECONCILE` off, not scheduled) |
| A9b | **Read-only compliance reads for activation** | #300, F4 session (J4 owner approved) | — | **MERGED 2026-10-23 → main `84f52048`** (no SQL). Activation no longer needs the purchase switch. Runbook note: activation compliance reads and the inventory route share `TW4_NUMBER_READS` and its token cache |
| A10 | Browser E2E for owner and admin journeys | Q1, #275 | Needs an isolated stack with auth (GoTrue) | BLOCKED (infra) |
| A11 | QA and docs tooling | #266, #267, #275, #274, #273 | — | Ready for owner merge decisions |
| A12 | Owner decisions | Owner | — | U-2 prices; U-4 written-approval evidence form; U-10 Stage B draft; **KI-1 re-decision (activation gate)** |
| A13 | Hosted DEV | H1 manifest (#274) | Authorized SELECT-only probe, then a one-file-at-a-time apply with fingerprints and a rollback round trip while 0 rows | Not authorized |
| A14 | Controlled live-provider validation | Owner authorization per call | F5 offline contracts are done; real request shapes still unverified | Not authorized |
| A15 | Pilot schedulers and alerts | Owner authorization | Register reconciler, inventory reconciliation, re-verify, RFL scan and delivery; verify recipients; delivery runbook §7 | Not authorized |

**Shortest safe path.**

1. Finish the DB runs for A1 and A2, then the A3 recheck.
2. The owner merges A1 to A6 and A11 (Git-only). Suggested order: #290, #280, #277, #276, #278, #279, then tooling.
3. Build A7, A8 and A9, with the A10 infrastructure built in parallel.
4. Owner decisions in A12.
5. Hosted DEV (A13).
6. Live validation, one call at a time (A14).
7. Schedulers (A15).
8. Manual activation.

### B. Mandatory for general studio availability

- F2: campaign-verified gate for legacy senders (U-3; reserved 20261220).
- Funding-exposure monitor (F-11) and out-of-band escalation (U-5).
- Evidence-absence scheduler, and the `FEE_RELEASE_ENABLED` decision (U-1).
- Owner self-service cancellation (U-7) and the kill-switch policy (U-8).
- Price publication with dual control (U-2 follow-up).
- `_tw4ml_month_start` timezone-scan performance risk under the 8 s statement timeout (found by J2).
- Self-service onboarding gating per studio; provider bill ingestion; quiet hours (U-9).

### C. Nonblocking hardening and later enhancements

- KI-2: rollback leaves widened CHECK constraints (document as intentional).
- KI-3: the `r2bp2.rfl` test is stale.
- The r2b suite refuses to run on the merged chain.
- Running TW-4F DB suites in CI.
- P3 notes:
  - #251: a run where every sender errors is still marked completed.
  - #269: `scope_unavailable` must escalate once the evidence scheduler exists.
  - #288: the old retry does not audit refusals; its "Record provider listing" button is the first admin button that can call Twilio.
- Two-month deferred-retirement absorption.
- RecurringFeesCancel UI backlog (withdrawal visibility, double-submit states).
- J3 finding (2026-10-23): `tw4_num_select` (1208, R2b-owned) does not check the pilot ceiling or funding when the owner approves; only the purchase does (`_tw4num_reserve`, TW007). An approval made by a direct RPC call at the ceiling is recorded but cannot buy, so this fails closed and is pinned by a test in J3. Hardening: refuse it in SQL.

## 9. Document inconsistencies to reconcile (not fixed here)

- `TW-4F_Production_Onboarding_Plan.md` §9a says `1120`/`1121` are NOT applied, while the 2026-10-19 Phase A record says DEV has `1120`–`1122`. Resolve this with the authorized hosted probe.
- `DanceFlow_Master_Roadmap.md:166` lists "Twilio Q1–Q5 confirmation … OPEN", but `TW-4F_Production_Onboarding_Plan.md` §13 records the ticket #29647095 answers as of 2026-10-19.
- `TW-4F_R2b_RFL_Integration.md` §6 lists "ConfiDance month-two controls" as open. The controls exist (`tw4_rfl_pilot_cover`), but activation is still blocked by `_tw4act_funding` (F-1).
- `TW-4F_Recurring_Fee_Lifecycle_Design.md` §12 lists D1–D6 as outstanding. They were decided in `TW-4F_RFL_Ops_Design.md` §1.
