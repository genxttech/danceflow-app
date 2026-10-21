# TW-4F R2: automated Twilio sender provisioning (design, 2026-10-20)

Baseline: `main` 4c13dbd5 (PR #250). PR #251 (sender re-verification, migration `20261206090000`) is still OPEN and untouched; R2 neither edits its files nor duplicates its scheduled verification. Local/synthetic only: no hosted SQL, no real Twilio call, no number purchase, no fee, no SMS, no flag enabled.

## 1. Inventory (what exists, what is missing)

| Piece | Exists | Missing for R2 |
|---|---|---|
| Brand runner `runBrandSubmission` (S1-S11, T1-T6, B1) with lease, ledger (`studio_sms_provisioning_steps`), unknown-outcome reconciliation, fee gate (`tw4_spend_reserve/settle`) | yes | Messaging Service, campaign, number steps |
| Subaccount-scoped adapters + token rotation (`rotatingSubaccountAdapter`) | yes (registration adapter only) | provisioning adapter surface |
| Price kinds `campaign_vetting`, `number`, `monthly`, `monthly_low_volume`; permanent approval refs; pilot ceiling; recurring authorization | yes | a runner that consumes them for campaign / number |
| State graph `brand_pending -> service_setup -> campaign_pending -> ready_for_activation -> active` | yes (`brand approved` already moves to `service_setup`, step `M1`) | writers for the middle states |
| Verified sender registry (`studio_sms_billed_senders`, `tw4_sender_record/verify`, readiness gate) | yes (PR #249) | the provisioning output feeding it; Advanced Opt-Out attestation at activation |

## 2. Split (smallest safe slices; each is dark and independently reviewable)

| PR | Scope | Fee-bearing | Migration |
|---|---|---|---|
| **R2a** | provisioning operation ledger; Messaging Service create/reuse; A2P campaign submission + status following; fee gate; provider adapter (real + fake); runner | campaign vetting (+ first campaign month for the pilot business) | `20261207090000` |
| **R2b** | number search -> owner-authorized purchase -> attach to the Messaging Service; recording the result into the PR #249 sender registry; Advanced Opt-Out attestation + STOP/START/HELP compliance check; activation checklist (`ready_for_activation`) | number rent | `20261208090000` (planned) |
| **R2c** | platform-admin provisioning card (one next action, resolve unknown outcomes), studio-owner progress, copy | none | none (reads) |

Messaging Service, campaign and number are separated because their authorizations differ (free / vetting + monthly / number rent), their failure modes differ (lookup-reconcilable / carrier review / purchase), and a slice that mixes them cannot be reviewed against one authorization story.

## 3. R2a design

### 3.1 Ledger

`studio_sms_prov_operations`: one row per provider operation ATTEMPT (`op_kind` in `messaging_service`, `campaign`; R2b adds number kinds). Columns: onboarding, studio, legal entity, `twilio_account_sid` (stamped from the entity's ACTIVE subaccount, immutable), attempt, `status` (`in_flight`, `succeeded`, `failed` = definite refusal, `unknown_outcome`, `abandoned` = an admin established it never happened), provider-lookup `friendly_name`, `request_digest`, `provider_sid` (MG.../QE...), `fee_bearing`, the spend kinds reserved, error code/detail (sanitized), who resolved an unknown outcome and why. Unique: one OPEN (`in_flight`/`unknown_outcome`) operation per studio and kind; one `succeeded` Messaging Service per studio; a `succeeded` campaign is superseded only after the provider marked it failed.

`studio_sms_prov_resources`: the mirror of what the provider REPORTS (not what we did): one row per Messaging Service / campaign with the read-back facts (account, parent service, brand, use case, mock flag, campaign status, rejection reasons) and the database's verdict. Approval is set ONLY by `tw4_prov_observe` from provider reads; a submission response never marks anything approved.

Both tables are append/update-guarded, have no API-role privileges, and are reached only through service-role `tw4_prov_*` functions that re-check the platform-admin actor and the onboarding lease (the same lease as the brand runner, so the two runners are mutually exclusive).

### 3.2 Gates (all in the database, all before the first provider call)

1. Onboarding state `service_setup` (Messaging Service) / `service_setup` or `campaign_pending` (campaign); open runner window; lease held.
2. The studio's legal business has an ACTIVE subaccount; the adapter's account must equal it (`account_mismatch` otherwise).
3. Campaign only: the studio's OWN brand is recorded `approved`, from a real (non-mock) B1 on this account; the Messaging Service is `succeeded` AND observed `ready` (right account, routed to DanceFlow's inbound URL, `UseInboundWebhookOnNumber=false`).
4. Campaign path: tier read from the database (`tw4_runner_fee_kinds`); use case is derived from it (`standard` -> `MIXED`, `low_volume_standard` -> `LOW_VOLUME`); an unverified Low-Volume Standard path -> `tier_ineligible`; missing published prices -> `tier_unpriced`. The tier cannot silently change: the tier-switch functions already refuse while an approval is open, and a campaign submission freezes it (checked again at observe time).
5. Fee authorization for `campaign` (reserved atomically in one transaction, so a partial reservation cannot commit):
   - always: a written, owner-approved `campaign_vetting` spend event (permanent reference, correct business and location), reserved against settled credit or, for the pilot business, the cumulative ceiling;
   - credit-funded business: an ACTIVE recurring authorization of the path's campaign monthly kind at the current published price, and settled credit for the first month beyond the vetting reservation;
   - ConfiDance pilot business (no standing authorization is allowed): a SECOND explicit written approval of the monthly kind for the first month, inside the same cumulative ceiling. Each fee component has its own reference; none is inferred.
6. A captured fee needs a fresh authorization for any later attempt (`tw4_spend_reserve` already requires an `authorized` event per attempt); resubmission after rejection therefore always needs a new explicit approval.

### 3.3 Idempotency and unknown outcomes

- `tw4_prov_begin` returns `skip` (already succeeded), `reconcile` (an open attempt exists), or `execute`. A lost response, timeout, 429/5xx or unreadable success is recorded `unknown_outcome`; the next run FIRST looks the resource up at the provider (Messaging Service by friendly name; campaign by listing the service's campaigns), adopts exactly one match, and never creates when it cannot be sure. A free operation (Messaging Service) whose lookup finds nothing may be created again only after a quiet period (120 s) to cover list lag; a FEE operation (campaign) that cannot be matched stays `unknown_outcome` for a human (`tw4_prov_resolve`: created-with-SID or not-created, reason required) and its reservation is neither captured nor released.
- Duplicate runner invocation: the onboarding lease (`55P03`), plus the open-operation unique index.
- Campaign fee settlement: captured when the provider accepted the submission (the vetting fee is non-refundable), released only on a definite pre-acceptance refusal.

### 3.4 Approval follows provider evidence

`tw4_prov_observe` judges provider reads: account match, parent service match, brand equals the recorded brand, use case equals the path, not mock, status map `VERIFIED` -> verified, `FAILED` -> failed (reasons recorded, onboarding -> `exception`/`campaign_rejected`), `IN_PROGRESS` and anything unrecognized -> pending. Source `fake` is accepted only where the local-QA marker exists (`_tw4sr_fake_allowed`). A verified campaign does NOT activate anything: R2b still needs a number, a verified sender and the Advanced Opt-Out checks.

### 3.5 Provider adapter and gates

New `IsvProvisioningAdapter` (Messaging Service find/create/read, campaign find/create/read) with a real REST implementation (subaccount credentials only, form-encoded, same transient/definite classification as the registration adapter) and a fake with injectable failures including lost responses. Real calls need a production build on a production deployment AND `TW4_PROVISIONING_REAL_CALLS=on` (a switch separate from `TW4_ISV_REAL_CALLS`).

### 3.6 Known limits (explicit)

- A second location of a business that already has a Messaging Service/campaign does not auto-share it: the second location's runner stops with `entity_resource_exists` for a human decision (no duplicate fee). Sharing is R2b/R2c.
- Advanced Opt-Out and the number are R2b. Campaign monthly fees after the first month: credit businesses rely on recurring charges (the recurring scheduler is already an activation gate); the pilot business has no standing authorization, so month 2 onward needs new approvals (open risk).

## 4. Deployment and rollback (R2a)

Requires `20261204090000`. Independent of `20261205` / `20261206` (adds only new objects; extends the audit vocabulary by reading the live list). Apply in numeric order. Rollback `rollback/20261207090000_...` refuses once any operation, resource, fee reservation or audit row of R2a exists (provider or financial evidence is never destroyed); forward recovery is a new migration. Application is dark: nothing calls the runner until R2c wires a platform action, and real calls are double-gated.

## 5. Revisions after the independent Opus review (2026-10-20) — authoritative where they differ from §3

Fixed (each pinned by a test): 

- **Generic resolver (P1).** `tw4_credit_resolve_reservation` (20261201 body, precondition-checked) now refuses `prov:%` reservations: a provisioning reservation is settled only by the ledger (`finish`, `observe`, `tw4_prov_resolve`), so an admin cannot release a fee Twilio charged and wedge the operation.
- **Kill switch (P2).** `tw4_prov_begin` requires an open runner window for every step, whatever mode the lease was claimed in.
- **Capture timing (P2).** A submission captures only the non-refundable vetting fee. The pilot's first-month fee stays reserved until the provider APPROVES (captured in `tw4_prov_observe` on `VERIFIED`) and is released on rejection. Observe also captures a vetting reservation that a human-resolved `created` operation left held, once a provider read of THIS account and service confirms it.
- **Pilot vs standing authorization (P2).** A pilot business with any active recurring authorization is refused (`pilot_conflict`, TW011) before anything is reserved.
- **Authorization coverage (P2).** A credit business needs an active recurring authorization with more than 28 days left; it is read `FOR SHARE` in the same transaction as the attempt.
- **Brand on this account (P2).** `_tw4prov_brand` requires the B1 step to carry the studio's ACTIVE subaccount.
- **One campaign per service (P2).** If any campaign (even a rejected one the ledger knows) still exists at the provider, a fee-bearing resubmission stops with `prerequisite_missing` BEFORE anything is reserved (delete the failed campaign at Twilio first), so no approval is burned on a create the provider refuses.
- **Fee release needs evidence (P2).** A fee operation is closed `failed` only with the definite-refusal code `api`; `tw4_prov_resolve` accepts an `in_flight` attempt only after 20 minutes; `resolve(created)` captures nothing by itself.
- **Reopen (P3).** `tw4_prov_reopen` retires (supersedes) the failed campaign so a refresh does not send the onboarding back to `exception`.
- **Evidence source (P3).** `source` is derived from the adapter (`evidenceSource`); the real adapter lives in `real.ts` (the repo's "only real.ts reaches Twilio" guard), has a private constructor and is built only by `createScopedProvisioningAdapter` behind the provisioning gate.

Accepted and documented (not changed): 

- Traceability: `tw4_approval_ref_trace` reports the reservation's `operation_key` (`prov:<operation id>:<kind>`), which names the operation; it does not join the ledger.
- The expected inbound route is supplied by the server (`NEXT_PUBLIC_APP_URL`), the same trust model as the sender-readiness slice; the database does not pin an origin.
- **Open risk:** a campaign outlives its owner's recurring authorization (Twilio keeps billing the subaccount; DanceFlow absorbs it until an operator acts). Activation (R2b) must re-check an active authorization, and the recurring scheduler is an activation gate. The pilot business has no month-2 funding path without new approvals.
- **Open risk:** removing a rejected campaign is a manual console step; R2a deletes nothing at the provider.
