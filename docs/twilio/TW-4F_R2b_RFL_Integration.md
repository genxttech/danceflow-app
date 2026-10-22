# TW-4F: R2b / recurring-fee-lifecycle financial integration (2026-10-22)

Baseline `main` af9bcf7c. Migration `20261217090000` (20261215 = campaign evidence targets, 20261216 = orphan-exposure views). Dark, Git-only: no hosted SQL, no Twilio call, no purchase, no Stripe, no SMS. Rollback: `rollback/20261217090000_..._rollback.sql`.

## 1. What changed

| Gap on main | Change |
|---|---|
| Nothing registered a provider-confirmed number in the recurring-fee inventory; `tw4_rfl_register` took administrator-typed identifiers. | `tw4_num_observe` registers the number **in the same transaction** as the ownership observation, from the locked ledger rows (`_tw4num_register_owned`). The administrator wrapper `tw4_rfl_register` keeps its signature, but for a location the number ledger manages it accepts **only the ledger's facts** (sid, account, number, `r2b`, source operation, the purchase's own pilot reservation). |
| `tw4_num_rent_basis` was unused: number rent was charged while the purchase outcome was unknown, ownership was lost, or nothing was registered. | `tw4_recurring_charge` holds (never charges) number rent while the basis is `indeterminate`, or `billable`/`not_billable` without a matching registered number (`_tw4num_rent_hold`). `held` rows are retried by the scheduler. Cover, grace, limits, the pilot refusal and the campaign fee are unchanged. |
| A confirmed number cancellation left the ledger's purchase live; retirement took an administrator's sentence. | `_tw4rfl_mark_cancelled` retires the ledger's purchase and attachment in the same transaction (`_tw4num_on_number_cancelled`, idempotent). `tw4_num_retire` refuses an unregistered number unless the PROVIDER's own read contradicted ownership. |
| `tw4_num_retire` took the location link before the onboarding row, the inverse of the runner functions (`tw4_num_observe` mismatch branch, `begin`, `finish`, `resolve`, `settle_admin`). | `tw4_num_retire` now takes the onboarding row first, like the runner family. |

## 2. Transaction boundaries and failure behavior

Registration runs in a sub-block of `tw4_num_observe`. A business refusal (for example a second live number, or an inactive subaccount) **never discards the provider's evidence**: the observation, the pilot-fee capture and the audit stay; the failure is recorded (`registration_failed=<SQLSTATE>` on the `num_observed` audit row), a critical `inventory_gap` alert is queued, rent stays held and the location stays unready (`rfl_ready` requires the inventory to match the ledger). `tw4_num_registration_gaps(actor)` lists such numbers; `tw4_num_registration_retry(studio, actor)` retries from the ledger and takes no identifiers. Serialization, deadlock and lock-timeout errors (classes 40, 55, 57) are not business refusals and propagate.

## 3. Lock order (tested)

Two families already exist on main and are kept. `tw4_num_retire` now follows the runner family; it still inverts against `tw4_act_mark_ready`/`activate`/`suspend` (link then onboarding), exactly as `tw4_num_observe`'s mismatch branch already did on main. Postgres detects such a cycle and aborts one side, so nothing is corrupted; a clean fix needs those functions replaced and is a follow-up.

- **Number-runner family** (`tw4_num_begin`, `finish`, `observe`, `resolve`, `settle_admin`, and now `retire`): onboarding row, then location link, business row, credit account, then ledger rows. Registration inside `tw4_num_observe` adds only the business row and credit account, after the onboarding row, so it keeps this order.
- **Lifecycle family** (cancellation, authorization, charge): profile rows (dual control), location link, business row, credit account, then lifecycle rows.
- The families cross in one place, `_tw4rfl_mark_cancelled` -> `_tw4num_on_number_cancelled`. That hook **never waits** and is **all or nothing**: it needs the onboarding and ledger rows (`FOR UPDATE SKIP LOCKED`), no live runner lease and no in-flight or unknown operation at the location (the guards `tw4_num_retire` has). Otherwise it defers the whole retirement with a warning alert. While deferred, rent stays held (registry cancelled, ledger live; the cancellation month Twilio billed is then not charged to the studio if the retirement happens more than a month later: DanceFlow absorbs it). The operator releases the sender row and runs `tw4_num_retire`, which accepts the cancelled registry state as its evidence. A deferral is visible as an `inventory_gap` alert only; listing deferred retirements in a read is a follow-up.

## 4. Money invariants

- **No duplicate charge:** the charge function's replay and one-charge-per-period rules are untouched; a held row is updated in place.
- **No retroactive studio charge:** nothing here charges earlier periods; held periods are retried only inside the existing current/previous-month window.
- **Pilot ceiling:** registration only **binds** the purchase's existing `prov:<op>:number` reservation as the registration period's cover. It creates no reservation, so the cumulative sum is unchanged (tested). Each later period still needs its own written approval.
- **Unknown stays held and visible:** `purchase_outcome_unknown` holds rent; an unregistered owned number alerts and appears in `tw4_num_registration_gaps`.
- **Provider-cost variances** stay DanceFlow-borne (nothing here debits a studio).
- **Core is internal:** `_tw4rfl_register_core` and the other new helpers have no API-role privilege; only the retry and gaps functions are granted, to `service_role`.

## 5. Decisions made (owner may overrule)

- **D1 `registered_by` (NOT NULL):** the administrator who started the purchase operation (`started_by`), a ledger-bound actor. The audit row is typed `system`; a retry does not record its caller (no audit action exists for it; follow-up).
- **D2 stale observation:** an old last-read does **not** hold rent on its own (Twilio keeps billing; holding only defers). Only an indeterminate basis holds.
- **D3 legacy numbers:** a location with no number-ledger activity (no purchase attempt and no selection) keeps today's behavior, including administrator registration.
- **D5 pilot cover:** a purchase's own pilot reservation is bound as the registration period's cover only while it is still reserved/captured and the registration month equals the purchase month; otherwise the number registers with no cover and the period needs its own written approval.
- **D6 over-hold:** once a location has any ledger purchase attempt, rent for an administrator-registered legacy number at the same location is held too while the ledger is indeterminate (DanceFlow bears the cost; conservative).
- **D4 pre-selection charges:** a location with an authorization but no ledger activity is still chargeable (the lifecycle's deliberate "charges before provisioning" rule). Extending the hold to such locations is an owner decision.

## 6. Still open (not done here)

- Real-provider validation and authoritative creation history for purchased-then-deleted numbers.
- Scheduled inventory reconciliation, funding monitoring and the ConfiDance month-two controls.
- The R2a campaign path's registration (`tw4_prov_observe`) and the TW047 wording/mapping follow-ups.
- Application surfaces for the retry and gaps functions (a store method and an admin panel row).
- Hosted apply order: after 20261214; no SQL has been applied to DEV or PROD.
