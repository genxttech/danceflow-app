# TW-4F-3b: prepaid SMS credits, Messaging Service and campaign (design)

Status 2026-10-19. Owner decision: **prepaid SMS credits are the default billing model for every independent studio.** DanceFlow's parent Twilio account may be billed centrally, but each studio funds its own onboarding, registration, phone-number and messaging costs through DanceFlow. Twilio subaccount isolation (approved D2: one subaccount per legal business) is **not** independent billing: Twilio bills the parent. This document records the assessment, the model, what is built in slice **3b-0** (local, synthetic, not applied to any hosted database) and the decisions still needed. Nothing here contacts Twilio or Stripe.

## 1. What this changes for TW-4F-3b and the earlier slices

| Area | Before | Now |
|---|---|---|
| Who pays | implied: DanceFlow / the owner's invoice | the **studio**, from settled prepaid credit, before any fee-bearing Twilio call |
| Spend cap (3a) | permission-like guard per legal entity ($150 for ConfiDance) | unchanged, and still **not permission to spend**: each real fee-bearing operation needs its own authorization at the published price, **and** funded credit |
| Authorization | admin typed an amount | the amount **is** the published customer price (no price, no authorization, no other amount) |
| Reservation | marked an authorization used | also **holds the funding studio's credit atomically**; capture charges it, release frees it (and voids the authorization) |
| Brand (B1) | stopped on no authorization | also stops on `insufficient_credit`; a created brand is captured exactly once; a definite refusal releases; an unknown outcome stays held |
| 3b campaign vetting, Messaging Service, number purchase and monthly rent | to be designed | each is a fee kind with its own price, authorization, reservation, capture and reconciliation |
| 4F-4 activation | checklist only | adds: credit funded for the first period, recurring approval recorded, usage debit path live |

## 2. Reuse of existing DanceFlow financial primitives

- **Stripe webhook idempotency:** `claim_payment_provider_event` (PAY-WH-1) already gives one atomic, leased claim per Stripe event id. Funding settlement will run inside that claim and additionally key the ledger on the Stripe payment (`topup:<payment_intent>`), so a replay at either layer credits nothing twice.
- **Platform Stripe account and customer:** studios already pay DanceFlow through Stripe Checkout on the platform account (SaaS billing, add-ons). Top-ups use the same account and customer, one-time `payment` mode, per request.
- **Patterns, not tables:** the append-only, idempotency-keyed, per-record ledger shape of `client_account_ledger` and the PAY refund reconciliation. Not reused as tables: `client_account_ledger` is a studio's money owed to its *clients*; `usage_events` / `usage_addon_entitlements` are metered allowances (quantities, not money). Mixing either with DanceFlow-to-studio funds would conflate two different ledgers, so the new ledger is separate (and money is integer cents).
- **Authorization and role helpers:** `_tw4_r1_is_platform_admin`, `_sms_onb_studio_role`, the one-shot confirmations of 3a.

## 3. Model (built in 3b-0)

- **Price list** (`studio_sms_price_list`): one active published price per kind (`brand`, `campaign_vetting`, `number`, `monthly`, `sms_usage`), customer price plus DanceFlow's internal expected provider cost. Prices are never edited: a change retires the old price and publishes a new one.
- **Credit account** (one per studio): settled balance, open reservations, hold, low-balance threshold. `available = balance - reserved`, spendable only while not on hold and not negative.
- **Ledger** (append-only, per-studio sequence, idempotency key per entry, a database check on each kind's sign pattern): `topup_settled`, `topup_reversed`, `reserve`, `release`, `capture`, `usage_charge`, `usage_refund`, `adjustment`. Balance and reserved are the sum of its deltas; `tw4_credit_verify` proves the counters agree.
- **Funding:** `tw4_credit_topup_pending` records an unsettled payment (not spendable). Only `tw4_credit_settle_topup` (called from the settled-payment webhook) credits it, once per provider payment. A refund or lost dispute (`tw4_credit_reverse_topup`) takes credit back once per event and may drive the balance negative, which blocks all spending until the studio funds it again.
- **Fee-bearing step:** authorize (published price, cap) -> reserve (atomic hold of the funding studio's credit, idempotent per operation, serialized by row locks so concurrent runs and retries bind one authorization and hold the money once) -> Twilio call -> capture on success, release on a definite refusal, hold on an unknown outcome. A released authorization is void and a retry needs a new one.
- **Funding studio of a legal entity:** registration, vetting, number and recurring fees of a legal business (shared by several locations, one subaccount) debit the entity's funding studio (the founding location). Messaging usage debits the sending studio.
- **Messaging usage:** `tw4_credit_debit_usage` is one atomic, idempotent debit that refuses when funds are short (no overdraft); `tw4_credit_refund_usage` credits undelivered or failed messages once per key.
- **Reconciliation:** `tw4_credit_record_provider_charge` stores the actual Twilio charge once per reference and flags a variance against the published expected cost. **The studio is never re-debited for a variance** (fixed published prices); variances are DanceFlow's to review. Delayed usage lands as later `usage_charge`/`usage_refund` entries by key.
- **Studio view:** `sms_credit_overview`, `sms_credit_history` and `sms_price_list` (own studio, owner or administrator only; prices exclude provider cost; history excludes references and actors).
- **No automatic top-ups or recurring payments:** nothing stores a payment method for charging, schedules a charge or tops up on low balance. Credit arrives only from a settled, explicitly started payment. Low balance is a flag (`low_balance_flagged_at`, set once per dip, cleared on recovery); sending a warning is a notification slice.
- **Retention:** the credit tables reference studios with `ON DELETE RESTRICT`: a studio with financial history cannot be hard-deleted (the account-deletion flow needs an explicit anonymize-and-retain rule; see decisions).

## 4. Not built in 3b-0 (next slices, in order)

1. **3b-pay:** Stripe Checkout for fixed top-up packs on the platform account, and the settled/refunded/disputed webhook handlers inside the existing claim (`checkout.session.completed` with `payment_status = paid`, `async_payment_succeeded`, `charge.refunded`, `charge.dispute.*`). Needs decisions 2-4 below.
2. **3b-ui:** studio "SMS credit" page (balance, pending, history, prices, top-up), platform page for prices, authorizations, adjustments and the provider-charge reconciliation list; low-balance banner. Needs decisions 2, 3 and 8.
3. **3b-campaign:** Messaging Service, campaign payload, G5 hold (D6 pre-review), fee kinds `campaign_vetting`/`monthly` through the same authorize/reserve/capture path. Real Twilio calls remain blocked on Q1b and Q1c.
4. **Recurring charges:** per-period authorization (decision 6) and the usage debit hooked into sending.

## 5. Decisions needed before expanding scope

1. **Funding unit.** Implemented: entity-level fees debit the funding (founding) studio; usage debits the sending studio. Confirm, or choose per-entity pooling or a different funding studio per entity.
2. **Prices.** Customer price per kind (brand, vetting, number, monthly rent, per-segment SMS), margin over Twilio's cost, sales-tax handling, and whether fees are shown separately. The price list is empty until set; nothing can be authorized without it.
3. **Top-up design.** Fixed packs vs custom amounts, minimum/maximum balance, payment methods (cards settle immediately; ACH settles later and stays pending until `async_payment_succeeded`).
4. **Unused credit.** Refund policy and expiry. Prepaid-balance rules vary by state and need a legal check before any promise; default proposal: non-refundable except at DanceFlow's discretion on account closure, no expiry.
5. **Negative balance.** Today a negative balance only blocks new spending. Decide whether sending is also suspended (Twilio subaccount suspend), after how long, and the write-off rule for disputes lost after credit was used.
6. **Recurring charges (number rent, campaign monthly).** Per-period owner authorization (safest, matches "no unapproved recurring payments") vs a standing approval with an end date, and what happens when funds run out (release the number? suspend sending?).
7. **Provider variance and delayed usage.** Confirm DanceFlow absorbs variances against published prices and who reviews them.
8. **Low-balance warnings.** Threshold defaults and channel (in-app only until the marketing email freeze lifts, or transactional email).
9. **Studio deletion.** How the account-deletion flow treats financial history (retain-and-anonymize is the likely answer).
10. **ConfiDance pilot funding.** The $150 maximum stays and is not permission to spend. Fund it by a real settled payment through the new flow, or a recorded complimentary adjustment (admin, written reason)? Either way each real fee-bearing operation still needs its own explicit written authorization.

Still blocking real Twilio activity: **Q1b** (cross-account Primary profile assignment) and **Q1c** (webhook signing token). No hosted migration, deployment, authenticated Twilio call, paid provisioning or SMS is authorized by this document.

## 6. Opus financial-integrity review (2026-10-19) and what was done

No ledger-arithmetic, locking, tenant-isolation or rollback defects were found; the review verified: counters = ledger sums, shape check, replay semantics, no capture-after-release, lock order (no cycle), settled-only funding, the NULL-safe studio views (a first version of those views had a three-valued-logic hole that let any non-member read a balance; it was caught by the new tests before review and fixed with `coalesce`). Findings and outcomes:

- **Stuck reservations (High):** a reservation from an earlier generation, a cancelled setup or a crash could never be captured or released. Fixed: `tw4_credit_resolve_reservation` (platform admin, written reason, any generation, idempotent) with `tw4_credit_open_reservations`; the runner now captures a fee step that already succeeded (a lost settlement is retried by the next run) and releases a reservation when the begin is refused (closed window, brand already exists).
- **Reversal/refund idempotency (Medium):** reversal keys now include the payment and require the provider event id; usage refunds must reference a recorded usage charge of the same studio and can never exceed it in total.
- **Unused authorization (Low):** `tw4_spend_withdraw`; failed payments can be marked failed (`tw4_credit_topup_failed`) and leave `pending`; reserve/settle validate the fee kind; internal ledger helpers are not callable by the service role; the migration refuses to apply over 3a `reserved` events it cannot bind.
- **Accepted for now:** an authorization is not bound to one location: the oldest authorized event of the kind in the legal entity is used and the funding studio is debited (decision 1 in section 5; the approver is always a platform admin and every run needs a platform admin). Credit accounts are created lazily by threshold/hold changes (harmless, but they prevent hard-deleting the studio).
- **Stack note:** `ON DELETE RESTRICT` means e2e fixtures and any studio-deletion flow cannot remove a studio with credit history; the fixtures leave such studios behind and `e2e/README.md` gives the local cleanup.
