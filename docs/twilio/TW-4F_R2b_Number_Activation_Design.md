# TW-4F R2b: phone-number provisioning and sender activation (design, 2026-10-21)

Baseline: `main` 4c13dbd5. **Stacked on PR #252 (R2a, head b2c2514a, migration `20261207090000`).** PR #251 (sender re-verification, `20261206090000`) is not modified and not duplicated: R2b feeds the PR #249 sender registry, and #251's scheduler (and `tw4_sender_reverify`) keeps an activated sender's verification fresh. Local/synthetic only: no hosted SQL, no real Twilio call, no number purchase, no fee, no SMS, no flag enabled. Migration: `20261208090000` (no other open PR claims a number at or after 20261208; R2a is 20261207).

R2b adds **no file R2a owns except three additive appends** (`real.ts` and `config.ts` tail additions, and the file list of the real-adapter guard test). It reads R2a's tables (`studio_sms_prov_operations`, `studio_sms_prov_resources`) and never writes them.

## 1. Flow

```
campaign VERIFIED (R2a)  ->  N0 search (read-only, free)  ->  offer (30 min, <= 25 numbers, nothing bought)
   -> N1 owner approval of ONE number (price + recurring cost disclosed, 24 h)   [studio owner in-app, or platform admin recording the owner's written approval]
   -> N2 purchase (FEE-BEARING; ledger + funding gate in ONE transaction before the provider call)  -> provider read confirms ownership -> fee captured
   -> N3 attach to the approved Messaging Service -> provider read confirms attachment
   -> sender record (PR #249 registry, pending) -> Advanced Opt-Out attestation + compliance validation -> sender verification (PR #249, provider reads)
   -> activation checklist -> ready_for_activation -> active
```

Every provider call runs in the legal business's **subaccount** with its own credential (the same rotating adapter pattern as R2a); the parent key never signs these calls. Real calls need a production build on a production deployment AND `TW4_ISV_REAL_CALLS=on` AND `TW4_PROVISIONING_REAL_CALLS=on` AND `TW4_NUMBER_REAL_CALLS=on` (a third switch, because this is the first operation that buys a number).

## 2. Data model (all tables: no API-role privileges, append/update-guarded, reached only through service-role `tw4_num_*` / `tw4_act_*` functions)

| Table | Purpose |
|---|---|
| `studio_sms_number_offers` | One read-only search result: candidates normalized and **re-filtered by the database** (US/CA SMS-capable, no address requirement, not already a sender / selected / owned anywhere). Expires in 30 minutes; at most 20 searches per studio per hour. Append-only. |
| `studio_sms_number_selections` | The owner's approval of exactly one candidate: published price acknowledged, recurring cost and funding disclosed in the stored statement, 24-hour life, one open selection per studio, one selection per number, one purchase per selection for the life of the system. |
| `studio_sms_num_operations` | Provider-operation ledger for `number_purchase` and `number_attach` (same shape and rules as R2a's ledger: recorded BEFORE the call, unknown outcomes never repeated, one live row per studio and kind, a number is bought once **globally**). |
| `studio_sms_num_resources` | What the PROVIDER reports (`owned`, `attached`, `mismatch`), judged by the database. |
| `studio_sms_optout_attestations` | Advanced Opt-Out attestation (a console setting Twilio does not expose to the API): checklist plus evidence reference, per Messaging Service and campaign. Append-only. |
| `studio_sms_compliance_checks` | Result of the compliance validation judged by the database from provider reads of the campaign (STOP / START / HELP keywords and reply messages, route, status). Append-only. |

## 3. Gates (all in the database, all before the first provider call)

Purchase (`tw4_num_begin`):

1. Onboarding state `campaign_pending`, runner window open, onboarding lease held, studio enabled.
2. The legal business has an ACTIVE subaccount and the adapter's account equals it (suspended / closed subaccount: `TW005`, nothing is called).
3. R2a's campaign is succeeded **and observed VERIFIED** on that account, and its Messaging Service is observed `ready`.
4. PR #249's release-before-replacement rule: a location whose latest sender row is not `released` and already has a number cannot buy another (`TW022`).
5. The selection is the studio's own, unexpired, unconsumed, for that exact number and account, and its acknowledged price equals the **current published price** (`TW008` otherwise).
6. Funding:
   * **Credit-funded business**: an ACTIVE `number` recurring authorization of this location at the current price with more than 28 days left, read `FOR SHARE` after the credit-account lock (the order revocation uses); its first month must still be set aside (or already charged); the account must not be on hold or negative. The recurring authorization IS the owner's disclosed, limit-checked recurring consent (it already enforces the monthly spending limit); R2b posts **no second charge**, so month one is never billed twice. The existing recurring scheduler (an activation gate) takes the rent.
   * **ConfiDance pilot business**: no standing authorization is allowed (`pilot_conflict`). A written, owner-approved `number` spend event (permanent unique reference, location-attributed) is **reserved atomically** with the attempt, inside the cumulative **$150 ceiling** (reserved plus captured pilot reservations). The reservation is captured only when a provider read confirms ownership, and released only on a definite provider refusal. Every attempt needs its own approval.
7. The selection is consumed in the same transaction; a refused or failed purchase needs a **new** selection and approval.

Attach (`tw4_num_begin`, free): the purchase must be succeeded AND observed `owned`; the Messaging Service is the one R2a verified; params must name exactly those SIDs.

## 4. Idempotency and ambiguity

* Lookups before creates: `findOwnedNumbers(e164)`. A number the subaccount already owns that the ledger never recorded is **not adopted** (we cannot know whether it was paid for): the run stops for a human (`exists_unrecorded`).
* A lost response / timeout / 429 / 5xx / unreadable success on the purchase is recorded `unknown_outcome`. The next run looks the number up: exactly one match is adopted; none keeps the operation `unknown_outcome` (fee operation: never repeated, only `tw4_num_resolve` by a platform admin, `not_created` only after 20 minutes); more than one stops. The reservation is neither captured nor released while unknown.
* A fee operation is closed `failed` only on the definite refusal code `api`.
* The generic credit resolver already refuses `prov:%` reservations (R2a); R2b uses that key prefix, so only the ledger (`finish`, `observe`, `tw4_num_resolve`, `tw4_num_settle_admin`) settles a number reservation.
* Concurrency: the onboarding lease (`55P03`), the one-live-operation index, the global unique live number, and one purchase per selection.

## 5. Sender registry hand-off (PR #249) and activation

* `tw4_num_record_sender` records the sender (pending) from the **ledger's** identifiers only, through `tw4_sender_record` (global uniqueness of number / service / campaign, `TW022`).
* `tw4_act_attest` stores the Advanced Opt-Out attestation (every checklist item true, evidence reference required). `tw4_act_compliance_record` judges the campaign's reads: opt-out keywords include STOP, opt-in include START, help include HELP, all three reply messages present, campaign VERIFIED and not mock, route correct. The server never supplies a verdict.
* `tw4_act_verify_sender` is the only R2b path to `tw4_sender_verify`: it passes `attested = true` **only** when a current attestation and a passed compliance check exist for the sender's own service/campaign; otherwise nothing is verified.
* Activation (`tw4_act_check` / `tw4_act_mark_ready` / `tw4_act_activate`) re-evaluates, in the database, in the same transaction as the state change: subaccount active; service ready; campaign VERIFIED with the path's use case; number owned and attached; `_tw4sr_ready` sender (verified within 24 h by PR #249's rule) whose identifiers equal the ledger's; attestation (30 days); compliance (24 h); and **funding continuity** (R2a design 6.1): credit businesses need ACTIVE recurring authorizations of the campaign monthly kind AND `number`, each with more than **35 days** left at the current published price, account not on hold. The pilot business has **no standing authorization by design**, so its funding continuity item is `pilot_month_two_undefined` and **fails**: the pilot cannot be activated until the owner defines the month-two operation (R2a design 6.2). `tw4_act_suspend` revokes the sender and moves the onboarding to `suspended`.
* PR #251 integration: an activated sender is an `approved` sender with a recent decisive verification; #251's scheduled re-verification (and `tw4_sender_reverify` from #249) refreshes it. R2b adds **no scheduler**. Activation consumes `_tw4sr_ready`, so a failed or stale re-verification immediately makes the sender not ready.

## 6. Out of scope / explicit non-goals

No scheduler, no UI (R2c), no real purchase, no automatic release of a number at the provider (`tw4_num_retire` records that an admin released it in the Twilio console after the sender row was released; DanceFlow deletes nothing at the provider), no SMS, no Stripe, no price publication, no flag enabled.

## 7. Deployment and rollback

Requires `20261207090000` (R2a) and therefore `20261204090000`. Independent of `20261205` / `20261206`. Apply in numeric order; the application is dark (nothing calls the runner until R2c wires a platform action, and real calls are triple-gated). Rollback `rollback/20261208090000_..._rollback.sql` refuses once any offer, selection, operation, resource, attestation, compliance or activation audit row exists (financial and provider evidence is never destroyed; forward recovery is a new migration). Rollback order: application first, then SQL; R2a's rollback only after R2b's.

## 8. Verification (2026-10-21, local only)

* Unit: `numberRunner.r2b.test.ts` (runner decisions against a scripted store), `realNumbers.r2b.test.ts` (request shapes, the third switch, outcome classification, credential rotation, fake provider semantics), `realAndConfig.test.ts` (only `real.ts` reaches Twilio; file list extended).
* Database: `localStack.r2b.test.ts` against the local QA stack with migrations through `20261208090000` (offers and owner approvals, credit and pilot funding, ceiling, unknown outcomes, refusals, duplicates, cross-tenant, suspension, sender hand-off, attestation, compliance, activation lapses, suspension, rollback refusal and contained rollback).
* The scripted-provider tests use only the fake provider and synthetic SIDs. No Twilio, Stripe or SMS call was made, no hosted database was touched.
* Interaction with PR #251: R2b never calls `tw4_sender_reverify` (PR #251 restricts it to its scheduler run). It refreshes through PR #249's `tw4_sender_verify` path, so it behaves the same with or without PR #251 applied.

## 9. Release blockers (must be closed before any real activation)

1. **No month-two operation for the pilot business** (R2a 6.2): the activation checklist fails `funding_continuity` for ConfiDance by design. Owner decision needed: the month-two approval operation (own approval per fee and per month, inside the cumulative ceiling, never a standing authorization) and the 35-day escalation.
2. **No scheduler for funding exposure** (R2a 6.1.2): `tw4_act_exposure` is the read-only input; the job that alerts platform admins, the owner notice at 35 days, and the runbook (6.1.4/5) are not built. The recurring-charge scheduler remains an activation gate, and the usage reconciler and PR #251's sender re-verification must be scheduled before activation.
3. **Real adapter never run against live Twilio**: request shapes follow public documentation and are pinned by injected-fetch tests only. A controlled, owner-approved dry run is required (a search is free; the first purchase is the first fee), with `TW4_NUMBER_REAL_CALLS` as the third switch.
4. **Advanced Opt-Out is an attestation**, not a provider read (Twilio does not expose it to the API). Compliance validation covers the campaign's keywords and replies and the service route; a real STOP / START / HELP exchange is an operator step before the first real send.
5. **No UI / platform action (R2c)** calls any of this; owner approval of a number has no in-app screen yet (`tw4_num_select` is the database contract).
6. **A retired number is released by hand at the Twilio console** (DanceFlow deletes nothing at the provider); revoking the number's recurring authorization after a release is an operator step.
7. PR #252 (R2a) must merge first; this branch is stacked on its head `b2c2514a`. If R2a is amended, rebase this branch (only `real.ts` / `config.ts` tail appends and the guard test's file list overlap).

## 10. Independent Opus review (financial integrity, provisioning, tenant isolation) and what changed

Three reviews of commit c8d619dd found **no P0**. Fixed in the follow-up commit, each pinned by a test:

* **Send gate (security P1, provisioning P1-1/P1-2).** A verified sender could send from `campaign_pending`, and PR #249's `tw4_sender_record` / `tw4_sender_verify` (with the form checkbox) bypass the R2b attestation. `_tw4sr_ready` is now the PR #249 readiness (kept unchanged as `_tw4sr_ready_core`) **plus** a state gate: a location that has any R2b operation sends only while its onboarding is `active`. Verified-but-not-activated, ready, suspended and exception locations do not send. Activation still needs the R2b attestation and compliance rows, so the direct PR #249 path cannot produce a sending R2b-managed location. A location with no R2b operation keeps PR #249 behaviour exactly.
* **Replacement stuck (provisioning P1-3).** `tw4_num_retire` from ready / active / suspended moves the location to `exception` (`num_retired`); `tw4_num_reopen` returns it to the number step. Retire refuses while an attach/purchase is open.
* **Number mismatch on a live location (security P2-4, provisioning P2-3).** A provider 404 on the number or service is now evidence (judged `mismatch`); the sender is revoked and the location goes to `exception`; the audit row names the real previous state.
* **Credit funding (financial P1-1, provisioning P2-1).** `_tw4num_credit_funded` requires the first-month set-aside to be reserved AND covered by the balance, or the current service month charged; evaluated in the preview, again in `tw4_num_begin` under the locks, and in the activation funding item (also now checks both rents are funded, and takes the entity/account/authorization locks).
* **Paid-call classification (financial P2-3, provisioning P2-2).** For the purchase, only a 4xx carrying Twilio's own error code and not 408/409/425/499 is a definite refusal; everything else is an unknown outcome (reservation kept, selection kept consumed).
* **Smaller:** approval references normalized with `_tw4fi_ref_norm`, taken under the fee namespace's advisory lock and checked against limit-ceiling approvals; pilot reserve filters by the acknowledged amount; no capture on an abandoned operation; one-way `superseded_at` and no reopening of an unknown outcome; offer array capped at 50; inbound route regex restricted to a hostname; campaign use case compared non-null; account predicates on the ledger reads; the runner asserts the ledger's account equals the adapter's before any create; `tw4_act_exposure` also lists a live number with no active rent authorization and an active rent authorization with no live number.

### Residual risks and release blockers added by the review (not fixed here; need owner decision or another slice)

1. **Month one of credit-funded rent is collected by the recurring scheduler, not at purchase** (financial P1-2): if the owner revokes the rent authorization right after the purchase and before the scheduler runs, the set-aside is released and DanceFlow pays Twilio for that month. Bounded to one month's rent per number and visible in `tw4_act_exposure` (`number_without_authorization`); closing it needs either a charge at observe time or a revoke guard in the recurring module. The scheduler and the exposure alert remain activation gates.
2. **Rent can be charged with no number** (financial P1-3): `tw4_recurring_charge` knows nothing about the ledger, so an authorization created before a purchase, or kept after a refused / not-created / retired purchase, keeps charging until the owner revokes. `tw4_act_exposure` lists `authorization_without_number`; a hard fix belongs in the recurring module (refuse a `number` period without a live purchase).
3. **A replacement number's first month** is not billed again when the same period was already charged (financial P2-1).
4. **Before any purchase the subaccount's full number list should be compared with the ledger** (financial P2-4); today only the selected number is looked up, so a hung purchase that later completes and was declared "not created" can leave an orphan number.
5. **Owner approval trusts the caller-supplied actor** (security P2-1): `tw4_num_select` is service_role only and checks the actor against `user_studio_roles`; R2c must derive the owner from the authenticated session (an `auth.uid()` wrapper) and never from a form.
6. **No gated factory for number adapters** (security P3): `evidenceSource` is a label the adapter sets; R2c must build adapters only through a factory that allows the fake only on a local database (as R2a's does).
7. **The expected inbound route is supplied by the server** and checked only by shape; pin the canonical origin in the database before activation.
8. **PR #249 UI actions** (`senderActions.ts`) still record/verify free-form identifiers for locations with no R2b operation; for R2b-managed locations they cannot make a sender send (send gate) or pass the activation checklist.
9. **Cancel + new onboarding with a live ledger row** wedges the runner (operations are found by studio, observed by onboarding): retire or resolve before cancelling.
10. An expired, never-withdrawn approval keeps its number reserved until the same location's next selection; a retired number cannot be approved again by anyone.
