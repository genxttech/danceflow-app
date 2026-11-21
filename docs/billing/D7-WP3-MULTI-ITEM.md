# D7 WP-3 multi-item extension (protected Pro item plus add-on items)

**Status: implemented locally, OFFLINE tests only. No Stripe call of any kind (not even TEST) has been made for this change. The Stripe TEST proof in section 5 is a PROPOSAL that needs owner approval; it has not been run.** Single-item behaviour is unchanged (all pre-existing tests pass unmodified).

Owner decision (Option A): preserve legitimate existing subscription items during a protected-price transition. Cause: the app lets a studio add the paid Organizer Suite add-on (and AI credit packs) as additional ITEMS on the same subscription (`subscriptionItems.create`, proration none), so a protected $129 Pro subscription that gains an add-on item would otherwise be refused (`subscription_unsupported_items`).

## 1. Exact tested behaviour

### 1.1 Planner (`planPriceTransition`)
* One item: unchanged. Several items require the operator-supplied `protectedPriceId` (the runner passes `--expected-current-price`); without it the old blocker `subscription_unsupported_items` still applies.
* Multi-item is supported only when ALL of these hold; each failure is its own blocker:
  * at most `MAX_SUBSCRIPTION_ITEMS` (5) items (`subscription_items_over_cap`);
  * exactly one item carries `protectedPriceId` (`protected_item_not_found`, `protected_item_ambiguous`), no other Price appears twice (`item_duplicate_price`), the target Price is not already on the subscription (`target_price_already_on_subscription`);
  * every item has an integer quantity >= 1 (`item_quantity_invalid`);
  * every item is a plain recurring, licensed, per_unit Price, interval count 1, no transform_quantity, shape known (`item_shape_unsupported`);
  * every item has the same interval and currency as the target (`item_interval_or_currency_mismatch`);
  * no item has discounts, tax_rates or billing_thresholds (`item_unsupported_settings`; they could not be proven to carry verbatim, so multi-item refuses them; the single-item path is unchanged);
  * no add-on is itself a protected/legacy Price (`item_is_protected_price`; it would need its own transition).
* Plan: phase 1 = every item unchanged, ending at the approved boundary; phase 2 = every other item unchanged (same Price, quantity, item metadata) and the protected item on the target Price with the SAME quantity. Items are sorted by Price id so the plan and its hash do not depend on Stripe's item order. `change.protectedPriceId` is set only for multi-item plans (single-item plan output is byte-identical to before). `proration: "none"`.

### 1.2 Runner
* `current_price_unexpected` for one item: unchanged. For several items: exactly one item must carry the expected Price.
* A new optional dependency `isProtectedPrice(priceId)` classifies the add-ons (script: `*_FOUNDER_LEGACY` env Price ids, plus unreleased `protected_subscriptions.stripe_price_id`). If it is absent on a multi-item run the run is blocked (`protected_price_check_unavailable`, fail closed).
* The plan hash covers `change`, i.e. every item, quantity, item metadata and the protected Price id. A changed add-on (quantity, Price, metadata, added, removed) gives a different hash: the approval is stale, nothing is written. The pre-write re-read uses the same check.

### 1.3 Executor
* Verifies the created schedule's current phase against the whole approved item set (order-insensitive multiset of Price and quantity) before writing; an add-on bought or removed since the dry run stops the run with the schedule released.
* Builds each phase item from the created schedule's phase item with the same current Price (settings copied verbatim), changing only `price` of the protected item in phase 2 plus explicit item metadata.
* Read-back (multi-item): item set equal in both phases (order-insensitive); item metadata carried; every SENT item (all settings) is present in the read item; every unrelated item is identical (canonical, key-order-insensitive) in phase 1 and phase 2. Any mismatch releases the schedule and reports failure. Single-item read-back is unchanged.

### 1.4 Reconciliation (`evaluateReconciliation`)
The approved item sets are read from the stored `dry_run` snapshot (`approvedFromDryRun`); nothing new is stored. Present only for multi-item transitions; single-item rules are untouched.
* `onTarget`: exactly one item carries the target Price. `plannedQuantity` is the target item's quantity (not item 0).
* After the boundary the live set must equal the approved SECOND phase (target on): else needs_review with `approved_item_missing`, `unexpected_item_present` (includes the old protected Price still billed, a second target item, an unapproved add-on), `approved_item_quantity_changed`, `quantity_changed` (target). Not yet on the target: the live set must still equal the approved FIRST phase (same reasons otherwise).
* BEFORE the boundary (any trigger, e.g. the `customer.subscription.updated` webhook when `PRICE_TRANSITION_RECONCILE_ENABLED=true`): live set != approved first phase gives needs_review `items_changed_after_scheduling` + the item reasons, so an add-on bought, removed or resized after scheduling is surfaced while it can still be fixed. Reconcile never writes to Stripe.
* Evidence adds only `items_match_plan` and `observed_item_count`. SQL RPC `complete_price_transition_reconciliation` is unchanged and needs no change (it ignores extra evidence keys; it cannot see items, see section 4).

### 1.5 Mapper (`mapStripeSubscription`)
Items now also carry `shape` (currency, interval, interval_count, type, billing_scheme, usage_type, transform_quantity) and `unsupported` (billing_thresholds, discounts, tax_rates). A subscription whose items report different periods gets `item_periods_differ` in `unsupportedSettings`.

### 1.6 Add-on that appears AFTER scheduling (UNVERIFIED Stripe behaviour)
What Stripe does when `subscriptions.update` / `subscriptionItems.create` adds an item to a subscription that has an attached schedule is NOT verified here. From memory of the Stripe documentation (unverified) it is one of: (a) Stripe rejects the direct change because the subscription is schedule-managed; (b) Stripe accepts it and the schedule's phases are NOT updated, so the item is absent from the next phase and disappears (or is billed inconsistently) at the boundary; (c) Stripe accepts it and re-synchronises the current phase only. The code therefore does not depend on any of them: the pre-boundary check flags (b)/(c) as needs_review, and a post-boundary set that differs from the approved set also needs review. **Residual risk:** if the add-on is added and the boundary passes before any reconcile trigger runs, and Stripe dropped the item, the live set equals the approved set and reconcile cannot tell. Mitigations outside this change: keep `PRICE_TRANSITION_RECONCILE_ENABLED=true` before the boundary, and make the Organizer Suite / AI-pack purchase routes refuse (or route through the transition) when the subscription has an attached schedule (`src/app/api/billing/addons/organizer-suite/checkout/route.ts` does not check `subscription.schedule` today).

Proration: add-ons are added with `proration_behavior: none` by the app. The schedule is created and updated with `proration_behavior: none` on the schedule and each phase; the tests assert this on the update call. Whether Stripe issues any proration or extra invoice lines at the phase transition for multi-item schedules is UNVERIFIED (U9).

### 1.7 Offline tests
`priceTransitionMultiItem.d7.test.ts`: planner (supported combos, 21 refusals plus the cap boundary), executor (two-phase construction, order-insensitivity, dropped add-on, changed quantity, item appearing on read-back, add-on added/removed before the write, Stripe-style rejection of mixed intervals), the stateful fake itself (rejects duplicates, phase gaps, empty items, invalid quantity), runner (hash covers every item, five stale-approval variants, add-on appearing between approval re-read and write, identity refusals), mapper (multi-item shapes, unsupported settings, metered/tiered/transform/yearly), reconcile (success, seven fail-closed reasons, grace window, pre-boundary drift, single-item untouched, apply path), `approvedFromDryRun`. The fake (`priceTransitionFakes.ts`) now models several items and Stripe's rejection of invalid phase input (duplicate Price in a phase, empty items, invalid quantity, mixed interval/currency, phase start != previous end).

## 2. Stripe-side assumptions that are UNVERIFIED offline

| # | Assumption | If wrong | Covered by proof step |
|---|---|---|---|
| U1 | `subscriptionSchedules.create({from_subscription})` yields ONE phase containing ALL items with their quantities (verified for one item only) | executor refuses before writing (current phase differs) and releases | M1 |
| U2 | Item metadata is not copied to the schedule phase items for every item, and is accepted explicitly per item (verified single item) | read-back metadata check fails, release | M1 |
| U3 | A phase item read from Stripe echoes every key we send (`isSubset(sent, read)`), and a read phase item has no phase-varying key (id etc.) so unrelated items are canonically equal across phases | false failure (safe, schedule released) | M1 |
| U4 | `update` accepts N items with distinct Prices of one interval/currency per phase; rejects mixed interval/currency (the fake models this) | failure released | M1, M6 |
| U5 | Stripe may return items in any order (we are order-insensitive) | none | M1 |
| U6 | `subscriptions.retrieve` returns full Price objects on items (shape fields needed by the mapper) for the pinned API version | multi-item refused as `item_shape_unsupported` (safe) | M1 |
| U7 | All items of one subscription report the same period | refused (`item_periods_differ`) | M1 |
| U8 | At the boundary Stripe moves ALL items to phase 2, preserves add-ons unchanged, releases the schedule (`end_behavior: release`) and the live item set equals phase 2 | reconcile needs_review | M1 |
| U9 | The boundary renewal invoice is one invoice with no proration lines for the add-ons or the Pro item | proof records the lines; owner review | M1 |
| U10 | Adding an item (proration none) to a subscription that has an attached schedule: accepted / rejected, and whether the schedule phases change | see 1.6; pre-boundary check flags drift | M3 |
| U11 | Changing or removing an add-on item's quantity on a schedule-attached subscription: same question | needs_review | M4, M5 |
| U12 | `release` of a schedule leaves every item, quantity and metadata on the subscription as before | failure path might alter the subscription | M6 |
| U13 | Add-on items have no `tax_rates` / `discounts` / `billing_thresholds` when created by our routes (these are refused if present) | multi-item refused (safe) | M1 (observe) |
| U14 | Idempotency keys behave identically for the larger payload | none expected | M1 |

## 3. Interpretation notes
"item-level quantity changes" is implemented as: quantities must be integers >= 1, the protected item's quantity is carried unchanged, and any quantity drift after approval (stale hash before the write, reconcile reasons before or after the boundary) is refused or flagged.

## 4. Changes believed needed elsewhere (NOT made)
1. SQL: none required. Optional hardening only: the RPC cannot verify add-ons are preserved because the evidence is application-supplied; a future migration could require `items_match_plan = 'true'` in the evidence for multi-item transitions. Not needed for correctness of this change.
2. `src/app/api/billing/addons/organizer-suite/checkout/route.ts` (and AI-pack equivalents): refuse or defer when the subscription has an attached schedule (see 1.6).
3. The `--all-due` sweep (`listDueTransitionIds`) only lists transitions past the boundary; the pre-boundary drift check relies on the webhook trigger. A pre-boundary sweep of `scheduled` multi-item transitions would remove the residual risk.
4. `scripts/billing/price-transition-proof-scenarios.ts` T8 ("two items refused") was updated to expect `protected_price_check_unavailable` (the harness runner has no `isProtectedPrice`); it was not run.

## 5. PROPOSED additional Stripe TEST proof (needs owner approval; NOT run)

Scope: sandbox `DanceFlow-D7-Price-Transition`, restricted `rk_test_` key, the same guard (`priceTransitionProofGuard.ts`). Only operations already in the 19-operation allowlist: `accounts.retrieve`, `testHelpers.testClocks.create/advance/del`, `customers.create/update`, `paymentMethods.attach`, `products.create`, `prices.create/retrieve`, `subscriptions.create/retrieve/update`, `subscriptionSchedules.create/update/retrieve/release`, `invoices.list`, `coupons.create` (not needed). Note `subscriptionItems.create` is NOT allowlisted, so mid-schedule item changes use `subscriptions.update` with `items` (add: `{price}`, resize: `{id, quantity}`, remove: `{id, deleted: true}`), `proration_behavior: none`. No new permission, no live key, no webhook, no Connect.

Test objects (one test clock each, deleted at the end; shared products/prices remain): products Pro, Add-on, AI pack; monthly USD prices legacy 12900, regular 15900, add-on 2900, AI pack 1500; a yearly USD add-on price (M6); customer with `pm_card_visa` as the subscription default payment method. Subscriptions are created with `items` = Pro (qty 1, item metadata), Add-on (qty 1, item metadata), AI pack (qty 3), subscription metadata, no trial.

| Step | Operations | Expected observations | Pass criteria |
|---|---|---|---|
| M1 happy path | create clock/customer/PM/sub; run the real runner dry run then execute (create, retrieve, update, retrieve schedule); `subscriptions.retrieve`; advance clock past the boundary and past the period roll; `subscriptions.retrieve`, `subscriptionSchedules.retrieve`, `invoices.list` | schedule phase 1 = 3 items, phase 2 = Add-on, AI pack unchanged + Pro on regular price; same quantities and item metadata; after the boundary live items = phase 2 set, schedule released/completed; renewal invoice: Pro 15900 + Add-on 2900 + AI pack 3 x 1500, no proration lines, no second invoice | runner reports `scheduled` and reconcile `ready` with `items_match_plan: true`; invoice lines exactly as expected; U1-U9, U12-U14 recorded |
| M2 mapper reality | `subscriptions.retrieve` of the M1 subscription before scheduling | mapped items carry shape, no `unsupported`, no `item_periods_differ` | plan `ok` on the mapped real object |
| M3 add-on added after scheduling | on a second M1-style subscription after scheduling: `subscriptions.update` adding a second add-on price (proration none); `subscriptions.retrieve`, `subscriptionSchedules.retrieve`; run reconcile (apply off) pre-boundary; advance past the boundary; retrieve + `invoices.list` | record: Stripe accepts or rejects; whether phase 1/2 contain the new item; whether the new item survives the boundary | reconcile reports needs_review `items_changed_after_scheduling` if accepted; the outcome (a)/(b)/(c) of section 1.6 is recorded as fact; no crash |
| M4 resize | `subscriptions.update` AI pack quantity 3 to 5 after scheduling; same observations | as M3 | needs_review `approved_item_quantity_changed`; behaviour recorded |
| M5 remove | `subscriptions.update` `deleted: true` on the Add-on item after scheduling; same observations | as M3 | needs_review `approved_item_missing`; behaviour recorded |
| M6 failure path | prices.create yearly Add-on; subscription Pro + yearly Add-on is not creatable if Stripe rejects mixed intervals (record that); alternative: executor run where the schedule update is rejected (use a deliberately invalid phase through the real client in the harness only) then `subscriptionSchedules.release`, `subscriptions.retrieve` | Stripe's real error text for mixed interval; after release the subscription still has all 3 items, quantities, metadata; no schedule attached | items unchanged byte-for-byte vs before; `released: true` |
| M7 idempotency | repeat M1 execute with the same idempotency prefix on a fresh subscription | no second schedule; same result | one schedule only |

Estimated Stripe writes about 60, reads about 120 across 5 test clocks. Evidence: redacted request/response log under `docs/billing/evidence/` with the existing redaction rules. Entry conditions: owner approval of this exact list, key unchanged, code reviewed.
