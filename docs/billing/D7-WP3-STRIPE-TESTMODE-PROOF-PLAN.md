# D7 WP-3: Stripe test-mode proof plan (NOT AUTHORIZED, nothing here has been run)

**Status: plan only.** No Stripe call, test-mode object, hosted database write, deployment or customer notice is authorized by this document. The owner must separately authorize the test-mode proof before step 1.

Purpose: prove, in Stripe **test mode** only, that `scripts/billing/price-transition.ts` moves a subscription to a new Price at its period boundary with no proration and no immediate charge, that a read-back mismatch or error leaves the subscription unchanged, and that the audit record is complete. Live behavior is proven by nothing here; any live operation needs its own written authorization (`--allow-live --live-authorization-ref`).

## 1. Scope and isolation
- Stripe: a **test-mode** account only (`sk_test_` / `rk_test_` key). The script treats any key not starting `sk_live_`/`rk_live_` as test, and refuses live without explicit live authorization.
- Database: the **disposable local Postgres** (scripts/qa/d7_price_transitions_sql.sh pattern) with migrations 20270201090000 and 20270204090000, and a throwaway studio and registry row. Never DEV or PROD.
- Objects (all test mode, all created by a setup step the owner authorizes): one Customer, a Product, a "legacy" recurring monthly Price ($129), a "regular" recurring monthly Price (test amount, e.g. $159), a test PaymentMethod `pm_card_visa` attached as default, one Subscription on the legacy Price (trial none), advanced with a **Test Clock** so the period boundary is reachable without waiting.
- Synthetic records: a registry row for that subscription; a notice row (approved, delivered, `sent_at` at least 60 days before the boundary, amount equal to the regular Price).

## 2. Exact Stripe API operations
Setup (test mode, owner-authorized, one time): `testHelpers.testClocks.create`, `customers.create` (with `test_clock`), `paymentMethods.attach` / `customers.update` (default PM), `products.create`, `prices.create` x2, `subscriptions.create` (legacy Price).

Under test (what the script does): reads `subscriptions.retrieve`, `prices.retrieve`; then only on execute: `subscriptionSchedules.create({from_subscription})`, `subscriptionSchedules.update` (two phases; `proration_behavior: none`; `end_behavior: release`), `subscriptionSchedules.retrieve` (read-back), and on any failure `subscriptionSchedules.release`.

Verification only: `testHelpers.testClocks.advance` past the boundary, then `subscriptions.retrieve`, `invoices.list` for the customer.

## 3. Restricted key permissions (test-mode restricted key `rk_test_`)
Read: Customers, Subscriptions, Prices, Products, Invoices. Write: Subscriptions (schedules), Customers and Prices/Products for setup only, Test clocks. Nothing else (no Refunds, Payouts, Charges write, Webhook endpoints, Connect, API-key management). The setup key may be broader than the script key; the script key must be the narrow one.

## 4. Expected behavior and pass criteria
| # | Case | Expected |
|---|---|---|
| T1 | Dry run (default) | Prints plan and hash; **zero** Stripe writes (request log shows only GETs); no audit row |
| T2 | Execute with correct hash | Audit row `approved` before the first Stripe write; schedule created; two phases, first ends at the boundary on the legacy Price, second starts at the boundary on the regular Price; `proration_behavior none`; audit row `scheduled` with schedule id |
| T3 | No invoice or charge created by scheduling | Invoice list unchanged until the boundary |
| T4 | Advance test clock past boundary | New invoice at the regular amount only, one per period; subscription item Price is the regular Price; schedule released/completed; no proration line items |
| T5 | Wrong or stale hash (e.g. quantity changed after dry run) | Refused, no Stripe write, no audit row |
| T6 | Second execute (replay) | Refused (`open_transition_exists` / unique index); exactly one schedule exists |
| T7 | Injected failure (update rejected, or read-back mismatch via a deliberately wrong expected price) | Schedule released, subscription unchanged (no schedule attached), audit row `failed` with reason |
| T8 | Subscription with existing schedule, `cancel_at_period_end`, `past_due`, two items | Each refused with its blocker |
| T9 | Live key supplied without `--allow-live --live-authorization-ref` | Refused before any write (run with an `sk_live_`-prefixed dummy against a stubbed client; never a real live key) |

## 5. Rollback / release behavior
Before the boundary: `subscriptionSchedules.release` returns the subscription to its original Price with nothing else changed (the script already does this on any failure). After the boundary the change is a normal Price change; reverting it is a separate, owner-approved subscription update, not part of this proof. Test objects are deleted by removing the Test Clock (which deletes its customers and subscriptions).

## 6. Evidence capture
For each case save, under `docs/billing/evidence/d7-wp3-testmode/` (no secrets, no card data): script JSON output, Stripe request-log excerpt (method, path, status, request id) showing write/no-write, the `price_transitions` row (redacted ids acceptable), the invoice list before and after the clock advance, and the schedule object read-back. Record the plan hash, key mode (`test`), Stripe API version and the commit SHA of the script.

## 7. Entry conditions (all required before the proof is requested)
Independent review verdict recorded; PR CI green; owner authorization for the test-mode proof stating the Stripe account and who supplies the restricted key; the 60-day minimum remains provisional and is only a parameter in the proof.

## 8. Explicit non-goals
No live Stripe call; no change to DanceAbel's subscription; no registry insert on any hosted database; no customer notice; no assumption that today's regular Pro price will be the July 2027 price; the paid Organizer Suite add-on and its price are a separate work package.

## 9. Additions after independent review (2026-10-31)
Extra test-mode cases, to be run in the same authorized proof:
| # | Case | Expected |
|---|---|---|
| T10 | Subscription with metadata, a default tax rate and item metadata | Both phases of the schedule carry them after scheduling, and they are still on the subscription after the clock advance |
| T11 | Subscription with a coupon/discount, a trial, `pause_collection` or `cancel_at` | Refused by the planner (unsupported setting); nothing written |
| T12 | Whether Stripe accepts the final phase with no `end_date`/`iterations`, and the exact first-phase `start_date` Stripe returns | Confirmed against the real API; if rejected the executor must be adjusted before any live use |
| T13 | Create with a Stripe idempotency key replayed | One schedule only |
| T14 | `D7_TRANSITION_OWNER_IDS` unset or not containing the approver | Refused before any write |

Known follow-ups deliberately NOT in this PR (owner decisions or later work packages):
- After the boundary passes, a reconcile step must mark the transition `applied` and the registry row must be updated/released (new `stripe_price_id`, audited release); otherwise the open transition and the registry keep treating the studio as protected. Needs an owner decision on when protection ends.
- Confirm the new regular Pro Price id is recognised by the subscription webhook plan mapping before July 2027.
- Pin the Stripe API version in the script once the proof fixes the version used.
- The 60-day notice minimum and the 24-hour minimum lead time are provisional parameters.

## 10. Owner decisions recorded (2026-11-01) and proof prerequisites

Approved policy: DanceAbel's protected rate runs through July 8, 2027; the boundary is 2027-07-09T04:00:00Z. The 60-day advance-notice minimum and a separate 24-hour minimum lead time before the boundary for creating the schedule are approved minimum safeguards (subject to stricter applicable requirements); neither authorizes sending a notice or creating a schedule automatically. The effective price is never assumed from today's regular Pro price: it must be explicitly authorized and appear in the delivered notice.

The test-mode proof is **conditionally authorized**. It does not start until ALL of these are confirmed in writing, and the first provider call is preceded by `validateProofKey`, `checkSandboxIdentity` and a print of the exact operation list (`src/lib/billing/priceTransitionProofGuard.ts`):
1. An explicitly approved, isolated Stripe TEST sandbox (account id supplied as `--expected-account`); the C6 invoice-testing sandbox/credential is excluded without separate approval.
2. A restricted `rk_test_` key limited to the operations in `PROOF_ALLOWED_OPERATIONS`; no live key, live customer/subscription id or production webhook endpoint anywhere. This approval does not change existing account permissions.
3. The Stripe API version is recorded before testing (the scripts print `Stripe.API_VERSION` of the installed SDK; the proof pins and records the version actually used).
4. Evidence is captured without credentials (`redactSecrets`).

Cases: T1-T14 above plus failed schedule creation, failed release, lost create response, audit-update recovery and post-boundary reconciliation (transition boundary, schedule activation, actual price change, atomic registry release), including advancing the test clock and inspecting the resulting subscription and invoices. If no suitable sandbox/key exists or one would need new credential provisioning, STOP and request the owner setup.

Status 2026-11-01: **prerequisites met and the proof RUN.** Sandbox `DanceFlow-D7-Price-Transition` (`acct_1UWz98RESPl6zEVj`), restricted `rk_test_` key (Accounts Read added by the owner after the first preflight reported the missing permission), Stripe API version `2026-03-25.dahlia` (installed SDK). Result: **28 of 28 cases pass** (`scripts/billing/price-transition-proof.ts run`); redacted evidence in `docs/billing/evidence/d7-wp3-testmode/` (run-results.json, run-log.json, preflight-log.json). 16 disposable test clocks (with their customers and subscriptions) were created and deleted; the shared test product, 3 prices and 1 coupon from each run remain in the sandbox (no delete operation is allowlisted).

Defects found by the proof and fixed in this PR (each now has a unit regression):
1. Echoing the schedule phase back verbatim is rejected by Stripe (`automatic_tax.disabled_reason`, null/empty fields, `currency`): carried fields are now pruned and sanitized, and the read-back compares as a subset.
2. Stripe does not copy subscription-item metadata into schedule phase items, so item metadata would be lost when the new price replaced the item: subscription and item metadata are now read, included in the approved plan/hash, and set explicitly on both phases (verified on the live subscription after the boundary).
3. Lost-create-response recovery could have released a schedule it did not create: the executor now refuses to touch a subscription that already has a schedule.
4. Harness-only: Stripe retains idempotency keys, so audit ids must be unique (production audit ids are UUIDs).

Behavior confirmed against the real API: a final phase sent without an end date is accepted; Stripe stores one implicit billing cycle for it and releases the schedule afterwards (verified by advancing a second cycle: schedule `released`, subscription still active on the regular price, two renewal invoices of exactly the regular amount, no proration lines). Not exercised against Stripe: a genuinely failing renewal payment (past_due) on the new price — covered by unit tests only.

### 10.1 Final review (2026-11-01) and what the proof does NOT establish
Evidence hygiene: account contact details are never written to the evidence (`scrubAccountEvidence`; e-mail addresses are redacted everywhere); the evidence was regenerated after the final code and re-verified clean. The proof harness and the production script now share one Stripe reader (`priceTransitionStripeRead.ts`), so the proof exercises the production mapping.

Simulated, not real Stripe failures (the recovery code is real, the trigger is injected): T7a update failure, T7b read-back corruption, F2 release failure, F3 lost create response. The database is an in-memory stand-in in the harness (SQL proven separately on disposable Postgres; the atomic registry release is not exercised against Stripe).

Not proven; required before any production use (each is a gate, not an assumption):
1. A rehearsal with a test-mode subscription shaped like the real Checkout-created one (subscription-level default payment method, payment settings, description, quantity > 1) and one past_due renewal on the new price.
2. Tax: subscriptions with automatic tax are refused (`automatic_tax`) until a tax-enabled rehearsal proves the disclosed amount; price `tax_behavior` is not compared with the notice.
3. Reconciliation window: evidence requires the subscription period to start exactly at the boundary, so reconciliation must run within the first regular billing period (webhook hook or the due sweep). A later first run fails closed to needs_review and needs owner remediation.
4. Owner decision to confirm: a past_due or unpaid subscription on the approved price still counts as "price changed" and releases the registry row (payment collection is deliberately not a condition).
5. Real-time rehearsal of webhook ordering, and the written live authorization (`--allow-live` plus a reference) for the real run.
