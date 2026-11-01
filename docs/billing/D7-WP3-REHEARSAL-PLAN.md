# D7 WP-3 pre-production rehearsal: preparation (NOT AUTHORIZED TO RUN)

**Status: design only. No Stripe call has been made for this rehearsal, and none will be until the owner authorizes this exact operation list.** Sandbox: `DanceFlow-D7-Price-Transition` (`acct_1UWz98RESPl6zEVj`), restricted `rk_test_` key. This extends, and does not repeat, the approved 28/28 proof (`D7-WP3-STRIPE-TESTMODE-PROOF-PLAN.md`). No live operation of any kind.

## 1. What the real subscription looks like (from the code, not assumed)
* Created by Stripe **Checkout** (`src/app/api/billing/checkout/route.ts`): `mode: subscription`, `payment_method_collection: always`, one line item quantity 1, `allow_promotion_codes: true`, `subscription_data.metadata` (studio/plan/offer ids) and, for new studios, `trial_period_days`. Checkout saves the card as the **subscription-level** default payment method.
* A studio may later add the **Organizer Suite add-on as a second subscription item** on the same subscription (`/api/billing/addons/organizer-suite/checkout` uses `subscriptionItems.create`, `proration_behavior: none`) and AI credit packs similarly.
* **Finding that needs a decision before the rehearsal (code change in WP-3, not Stripe):** the WP-3 planner refuses any subscription with more than one item. If DanceAbel buys the paid add-on before the July 2027 transition, the transition would be refused. Two options: (A) support exactly one protected plan item plus explicitly listed add-on items carried unchanged into both phases (recommended; the rehearsal then covers it), or (B) forbid add-on purchase on a protected subscription until after the transition. This is the first thing the rehearsal should exercise once chosen.

## 2. Scenarios (each on its own test clock)
| # | Scenario | Offline (fixtures) | Stripe TEST |
|---|---|---|---|
| H1 | Checkout-shaped subscription: subscription-level default PM, metadata, trial then first paid period at the legacy price (clock advanced past the trial), quantity 1 | yes | yes |
| H2 | Quantity > 1 (2 seats) through the transition; reconcile amount/quantity checks | yes | yes |
| H3 | Plan item + add-on item (after the decision in section 1) | yes | yes |
| H4 | Approved regular-price transition executed (dry run, hash, execute) on H1-H3 | yes | yes |
| H5 | **Past-due renewal** on the new price: failing test card as the subscription default PM, clock advanced past the boundary; reconcile must still prove the change, release the registry row, leave the open invoice open (no debt forgiveness, no refund, no payment evidence invented) | yes | yes |
| H6 | Automatic-tax subscription: planner refuses (`automatic_tax`) | yes | only if the sandbox already has Stripe Tax origin settings; otherwise recorded BLOCKED (no key broadening) |
| H7 | Delayed, duplicate, out-of-order webhooks: `subscription_schedule.*` and `customer.subscription.updated` in every order, including events that arrive after the next renewal | yes (route tests + fixtures built from the H4 Stripe objects) | no new calls: fixtures are the redacted objects captured in H4 |
| H8 | Reconcile after the transition: registry released atomically, audit evidence present; reconcile run after the first renewal fails closed (known window) | yes (disposable Postgres, real RPC) | reads only |
| H9 | Idempotent re-run of everything above | yes | yes |

## 3. Exact Stripe TEST operations (all inside the approved 19-operation allowlist; no new operation type)
`accounts.retrieve` · `testHelpers.testClocks.create/advance/del` · `customers.create/update` · `paymentMethods.attach` (`pm_card_visa`; `pm_card_chargeCustomerFail` for H5) · `products.create` · `prices.create` (legacy, regular, add-on) · `prices.retrieve` · `subscriptions.create/retrieve/update` (create with `default_payment_method`, metadata, `trial_end`, quantity, optional second item; `update` to swap the default PM for H5 and to cancel-test) · `subscriptionSchedules.create/update/retrieve/release` · `invoices.list` · `coupons.create` (only if re-testing the discount refusal).
**Not used:** Checkout Sessions (a hosted-page flow cannot be completed from the API; the Checkout *output* shape is reproduced with `subscriptions.create` parameters taken from the real route), charges, refunds, payouts, webhook endpoints, Connect, account/permission changes.
**Optional, only with separate owner approval:** for H6 success-path, Tax settings write. If absent, H6 is offline-only and reported as BLOCKED on the Stripe side.

## 4. Restricted-key permissions
Identical to the approved proof key (Accounts read; Customers, Products, Prices, Subscriptions, Payment methods, Coupons write; Invoices read; Test clocks). **No additional permission is required for H1-H5, H7-H9.** The existing key is not to be broadened.

## 5. Differences from the approved proof
New fixture shapes (subscription-level PM, trial then paid, quantity 2, add-on item, failing card); one past-due path with an unpaid invoice left open; a Stripe-object fixture capture for webhook ordering tests; a second evidence folder `docs/billing/evidence/d7-wp3-rehearsal/` (same redaction rules, owner contact details excluded). Test scope: ≈8-10 disposable test clocks, deleted at the end; shared test products/prices/coupons remain (no delete operation is allowlisted). Estimated Stripe writes: ≈150, reads ≈300.

## 6. Entry conditions
Owner decision on section 1 (A or B); the multi-item code change reviewed (if A); owner authorization of this exact list; the key unchanged; evidence folder redaction check before commit.
