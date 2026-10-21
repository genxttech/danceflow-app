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

## 11. Remediation round 2 (2026-10-21, after PR #252 merged as 1c036885)

**Base.** PR #254 now targets `main`. The R2a squash commit has the same tree as the reviewed R2a branch head `b2c2514a`; `origin/main` was merged into this branch (no rebase, no force-push) so the PR diff is the R2b files only (14 files).

**Closed in R2b (database-enforced, tested):**

| Finding | Control |
|---|---|
| Owner approval trusted a caller-supplied actor | `tw4_num_select` / `tw4_num_withdraw` accept the OWNER path only when `auth.uid() = p_actor`. The only entry points an authenticated user can run are `tw4_num_select_as_owner` and `tw4_num_withdraw_as_owner` (actor = `auth.uid()`). A service-role call that merely names an owner is refused (`42501`). A platform admin may still record the owner's written approval (reference required, used once). Owner approvals are audited as `user`, not as an admin. |
| Inbound route supplied by the caller | `studio_sms_inbound_route_pins` (append-only; latest row is current) pinned by `tw4_inbound_route_pin_set` (admin, https origin only). `tw4_act_compliance_record` refuses when no pin exists or the expected route differs (`TW044`); the activation checklist has an `inbound_route_pinned` item. |
| Provider number inventory not reconciled | `tw4_num_context` returns every number SID the system accounts for in the business's subaccount (any ledger operation incl. retired, any sender row of its locations, admin acknowledgements). Before recording or buying anything the runner lists the subaccount's complete inventory (`listIncomingNumbers`, paginated lists refused) and stops with `num_inventory_unknown` if the provider shows a number the system does not know. `tw4_num_inventory_ack` (admin, reason) records a known foreign number once. The per-number lookup still refuses to adopt it. |
| Sender stays valid after ownership loss | A provider 404 or mismatch on the number or its attachment revokes the sender and moves the location to `exception` (R2b round 1); `tw4_num_rent_basis` reports it as `provider_ownership_lost`. |
| Sending before activation | `_tw4sr_ready` = PR #249 readiness AND onboarding `active` for any location with an R2b operation (round 1). |

**Recurring-fee lifecycle: what is authoritative, and what R2b does not do.**

Authoritative state: rent is an obligation of `studio_sms_recurring_authorizations` (status, term, price, commitment reservation) charged by `tw4_recurring_charge` through `tw4_recurring_due_list`. Neither knows about provider resources, so today an active `number` authorization is charged whether or not a number exists. The provider-resource truth for a number is the R2b ledger (`studio_sms_num_operations` + `studio_sms_num_resources`, written only from provider reads). R2b exposes it as a **read-only contract**: `tw4_num_rent_basis(studio)` returns `{live, reason, managed, pilot, phone_number_sid, e164, confirmed_at, last_observed_at}`. `live` = a purchase the provider's own read confirmed as owned in the business's active subaccount, not retired, whose sender row is not released.

R2b deliberately does **not** edit `tw4_recurring_charge`, the due list, an authorization or a reservation, and does not charge, refund, renew, revoke or cancel anything. The recurring-fee workstream must gate `number` rent on the contract:

1. For `kind = 'number'` and `managed = true`: charge a period only when `live = true`. When `live = false`, record the period as waiting/held with the `reason` (never `charged`, never silently skipped). A location with `managed = false` (a number that predates R2b) is not gated.
2. First month: the commitment set-aside remains reserved until the first live period is charged; revoking the authorization while a live purchase exists should be surfaced to the platform (`tw4_act_exposure` already lists `number_without_authorization`) rather than silently releasing the set-aside.
3. Provider-cost variance: Twilio's bill for a number that was bought but never became billable to the studio (revoked authorization, ownership lost, retired but not yet released at the console) is a DanceFlow-borne provider cost. It is recorded by the exposure list and handled by an operator; no studio is charged for it without an authorization, and no authorization is renewed automatically.
4. ConfiDance (pilot): never charged by a schedule (`tw4_recurring_charge` already refuses pilot businesses). `rent_basis.pilot = true`. Month two needs a new per-operation written approval inside the cumulative ceiling; that operation does not exist yet and keeps the activation checklist failing (`pilot_month_two_undefined`).
5. Numbers are never released or cancelled automatically: retiring is an admin act after a console release.

Dependencies: PR #251 (sender re-verification) is independent of R2b (R2b never calls its scheduler-only function; `_tw4sr_ready` is the shared judge). PR #253 (R2c UI) must call `tw4_num_select_as_owner` / `tw4_num_withdraw_as_owner` with the owner's own session client, call admin actions only from authenticated platform-admin server actions, and build number adapters through a gated factory. The recurring-fee lifecycle PR must consume `tw4_num_rent_basis`.

## 12. Remediation round 3 (second independent Opus review of f4c5f4d9) and corrections to section 11

No P0 in either review. Fixed (each pinned by a test):

* **Rent basis is tri-state, not a bare flag.** `tw4_num_rent_basis` returns `state`: `billable` (a purchase the provider's own read confirmed as owned, in the active subaccount, attachment intact, not retired, sender not released), `not_billable` (never bought, refused, declared not created, retired) or `indeterminate` (purchase outcome unknown, ownership not confirmed or lost, attachment lost, subaccount not active, released but not retired). **The consumer holds an indeterminate period; it never forgives it**: a paid number may exist, Twilio keeps billing a suspended subaccount, and the recurring module can only charge the current or previous month. `observation_age_seconds` is returned; R2b has no refresh scheduler, so the freshness policy is the consumer's. This corrects the earlier statement that a mismatch always reported `provider_ownership_lost` (an attachment loss is `attachment_lost`).
* **`managed` is "on the R2b path", not "has an operation".** Only a location with a pre-R2b sender number (a sender row naming a number no R2b operation bought) is unmanaged. A location that authorized rent and has not bought yet is managed with `not_billable`: no number, no rent.
* **Exposure** lists: funding-continuity failures; every indeterminate basis; any live pilot number (month two has no approval operation); a live number with no active rent authorization; an active rent authorization on a managed location with nothing to bill.
* **Inventory reconciliation is database-enforced.** The runner sends the provider inventory to `tw4_num_inventory_observe`; the database judges it against `_tw4num_known` and stamps the lease. `tw4_num_begin(number_purchase)` requires a clean stamp from its own lease within 5 minutes (`TW045`), whoever the caller is. A retired purchase and a released sender no longer count as known, so a number that lingers after a console "release" stops the next purchase; `tw4_num_inventory_ack` refuses a number that belongs to a purchase declared not created. `listIncomingNumbers` fails closed (every returned row counts; a row without a valid sid makes the inventory unreadable).
* **The send gate binds the sender to the ledger.** An R2b location sends only while `active` AND from the sender its own ledger bought and attached (purchase owned, attachment attached, service and campaign verified). A free-form PR #249 sender row on an active location no longer sends.
* **Approval references: one direction was not enough.** Admin-recorded number approvals are registered in the shared `studio_sms_approval_refs` registry (new source `number_selection`, same advisory lock and ceiling check), so a reference used for a number approval can never approve a spend or a spending-limit and the reverse. The rollback restores the original registry constraints and refuses once such rows exist.
* **Compliance is tied to the current pin.** Each compliance check stores the route it was judged against and the activation checklist compares it with the latest pin (a rotated pin invalidates earlier checks). Origins must be lowercase dotted DNS names (no IP literals, `localhost`, trailing dot or empty labels).
* **Owner withdraw wrapper is owner-only**; `tw4_num_settle_admin` cannot release the fee of a number the provider confirmed as owned.

**Corrections to section 11.** Rule 2 (set-aside "remains reserved until the first live period is charged") describes the intended behavior; current recurring code captures the first scheduled charge in the authorization's start month and releases the set-aside on revoke. The recurring-fee workstream owns closing that. Section 11's "database-enforced" claim for inventory reconciliation was true only for the runner; it is now enforced by `tw4_num_begin`.

**Residual risks (accepted for Git-only merge; each blocks real activation or is the recurring workstream's):**
1. The pilot business can buy a number it cannot activate (no month-two operation): months two onward are DanceFlow's cost, visible only through exposure (`pilot_number_live`); the owner's setup ceiling is not consumed by them. Decide the month-two operation before any real pilot purchase.
2. A late-found purchase (a purchase declared "not created" that later turns up) has no adoption path: ack refuses it, the pilot reservation was already released. An operator must handle it by hand; adoption is a future slice.
3. `tw4_num_retire` relies on an admin's written note plus the next purchase's inventory check; it does not itself require a provider read.
4. The recurring module's current/previous-month window turns a held period into lost rent; a 1-month rent term can never pass the 35-day activation check; renewal forces revoke-then-reauthorize (opens a window the exposure list reports).
5. Month-one set-aside handling, revoke while a live number exists, and replacement-number billing remain with the recurring-fee workstream.
6. PR #249's direct sender record/verify actions still exist for locations with no R2b operation.
7. A sibling location's in-flight purchase can make another location's inventory check fail closed (noisy `exception`, no money effect).
