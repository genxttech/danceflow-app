# D7 WP-4: paid Organizer Suite add-on, discovery and preparation

**Status: discovery and proposal only. Nothing here is approved or implemented. No Stripe call was made, no price or product was created, no hosted database was written, no customer was contacted.** Prepared 2026-11-05 against `origin/main` `c06222b7`. Section labels: **EVIDENCE** (read from the repo at that commit, with file references), **PROPOSAL, UNAPPROVED** (a recommendation), **NEEDS OWNER INPUT** (no evidence in the repo).

Policy this serves (OWNER-CONFIRMED, `D7-RELEASE-READINESS.md` sections 8.1 and 10.2): the complimentary Suite grants end at `2027-07-09T04:00:00Z` for DanceAbel; afterwards access requires a separately purchased paid add-on; no automatic purchase, charge or extension; data is preserved. The add-on purchase path is the only way access continues (gap G12).

---

## 1. What the add-on is today (EVIDENCE)

### 1.1 Inventory

| Piece | Where | What it does |
|---|---|---|
| Purchase route | `src/app/api/billing/addons/organizer-suite/checkout/route.ts` (POST, and GET delegating to POST) | Adds ONE subscription item to the studio's existing SaaS subscription; no Stripe Checkout page |
| Remove route | `.../organizer-suite/remove/route.ts` (POST, and GET delegating to POST) | Deletes the subscription item and sets the entitlement `canceled` |
| Price selection | checkout `getOrganizerSuitePriceId()` | `isFounderPricingActive()` and `STRIPE_PRICE_ORGANIZER_SUITE_ADDON_FOUNDER` set: founder price; otherwise `STRIPE_PRICE_ORGANIZER_SUITE_ADDON_STANDARD`; neither: `organizer_suite_missing_price`. The studio plans use the fail-closed `selectStudioMonthlyPrice` (`src/lib/billing/studioCheckoutPricing.ts`); **the add-on does not use it** |
| Price recognition | webhook `getOrganizerSuiteAddonPriceIds()` / `isOrganizerSuiteSubscriptionItem()` (`src/app/api/payments/webhook/route.ts:794-816`) | An item is "the Suite" if its price is either env price, or its metadata has `featureKey=organizer_suite` or `source=organizer_suite_addon` |
| Entitlement writer #1 | the checkout route itself (`upsertOrganizerSuiteEntitlement`, `onConflict: stripe_subscription_item_id`) | Writes `usage_addon_entitlements` (`source=stripe_subscription_item`, `status=active`, `quantity_included=1`) **immediately after the Stripe item is created** |
| Entitlement writer #2 | webhook -> RPC `apply_studio_subscription_state` (`migrations/20270202100000_...`, called at `route.ts:1051`) | On every `customer.subscription.created/updated/deleted` for a studio subscription: upserts a row per Suite item keyed by `stripe_subscription_item_id`, `active` iff the subscription status is `active` or `trialing`; cancels stale or all rows otherwise; never touches `manual_grant` rows; refuses an item that belongs to another studio |
| Readers | `src/lib/billing/organizerSuiteEntitlement.ts` (single shared boundary reader), `access.ts`, `src/lib/events/platformFee.ts`, every organizer-event checkout, Terminal and mark-paid gates | Access = any row with `feature_key=organizer_suite`, source in (`stripe_subscription_item`, `manual_grant`), `status=active`, and inside `period_start`/`period_end` |
| UI | `src/app/app/settings/billing/page.tsx:975-1125` (`OrganizerSuiteAddonCard`) | "Add Organizer Suite" confirm form posting to the checkout route; "Remove add-on" form; copy "No separate Stripe checkout page will open" and the fee tiers (3.25% Starter/Growth, 3.0% Pro) |
| Other mentions | Pro plan highlight (`plans.ts` Pro highlights), `get-started/studio`, `app/page.tsx`, `AppSidebarShell`, `navUtils.ts`, platform analytics/accounting MRR | Marketing and navigation only |
| Tests | `addonSubscriptionOwnership.paydc4a.test.ts` (ownership of the subscription before any Stripe write), `entitlementWriters.d7.test.ts` (writer allowlist), `studioSubscriptionWatermark.billingqa6.test.ts` (webhook -> RPC for Suite items), `organizerSuiteEntitlement*.d7.test.ts` (boundary rule) | **No test covers payment settlement, a declined card, past_due, trial behaviour, idempotency, the protected-subscription case, a second item beside WP-3, or the UI** |

### 1.2 What exactly happens when a studio buys it today

1. Studio owner/admin submits the form (POST; a plain GET also works, see gap P1-1). IP rate limit 6 per 10 minutes (in-memory).
2. Requires `studios.stripe_subscription_id` and `subscription_status` in (`active`, `trialing`). `past_due` is refused.
3. If an `active` `stripe_subscription_item` row exists: redirect "already active" (a `manual_grant` row does NOT short-circuit this, so a grant holder can buy; migration `20270203090000` lets the grant and the paid row coexist).
4. `verifyStudioSaasSubscription` proves the subscription is this studio's (PAY-DC-4A) before any Stripe write.
5. If the subscription already carries an item with the add-on price: upsert the entitlement `active` and stop (no check that the subscription is paid up beyond step 2).
6. Otherwise `stripe.subscriptionItems.create({ subscription, price, quantity: 1, proration_behavior: "none", metadata: { source: "organizer_suite_addon", featureKey, studioId } })`. **No `payment_behavior`, no idempotency key, no price validation.**
7. The entitlement row is upserted `active` in the same request.

Consequences (EVIDENCE from the Stripe parameters used, not from a test run; to be confirmed in the test-mode proof):
- **Access is granted before any money is collected.** With `proration_behavior: "none"` no invoice is created at item creation. The add-on is first billed on the next renewal invoice (or at trial end for a `trialing` subscription). Activation is on the checkout call, not on settlement.
- A studio can obtain a full billing period of the Suite and, if its next renewal fails, the webhook cancels the row only when the subscription status leaves `active`/`trialing` (`past_due` -> `addon.active=false`).
- The 30-day trial concept: a `trialing` studio subscription may buy the add-on and use the Suite for the rest of the trial.

States that exist for a paid row: `active`, `canceled` (RPC when the subscription is not `active`/`trialing`, or remove route), and `expired` (allowed by the CHECK but only the manual-grant expiry job uses it). A row flips back to `active` on a later subscription event when the subscription is `active` again (the RPC updates the same item-keyed row), so `past_due` followed by recovery self-heals.

### 1.3 The known latent defect and its status

- The production webhook (`release/pricing-p1` lineage) upserts Suite entitlements with `onConflict: "studio_id,feature_key"`. PROD has no such unique constraint, so Postgres raises 42P10 and the studio's own subscription webhook fails when it buys the add-on. Fixed in release-candidate PR #397, commit `12b78a23` (target `stripe_subscription_item_id`). **`main` does not have the defect**: it uses the RPC above (BILLING-QA-6, PR #360). Consequence: the paid add-on on PROD is only safe after the release path that carries the RPC or `12b78a23` (RPC also needs its SQL applied: it is not applied to PROD, `D7-RELEASE-READINESS.md` 10.7).
- Partial unique indexes from `20270203090000` (one active `manual_grant` per studio and feature) do not conflict with paid rows; they also still cannot serve `onConflict studio_id,feature_key`, which is why every writer must key on `stripe_subscription_item_id`.

---

## 2. Gaps between "implemented" and "safe to sell"

Severity: **P1** = blocks any sale; **P2** = must be decided or fixed before the DanceAbel date; **P3** = hardening.

| # | Gap | Evidence | Needed |
|---|---|---|---|
| P1-1 | **State-changing GET.** Both routes export `GET` that calls `POST`. A cross-site link or image tag can add a paid item or remove one for a logged-in owner (SameSite=Lax permits top-level GET navigations) | `checkout/route.ts` and `remove/route.ts` last lines | Remove `GET`; POST only; same-origin/CSRF check; explicit confirm page |
| P1-2 | **Activation before settlement.** Entitlement written in the request, with no invoice. See 1.2 | route step 6-7 | Activate only on verified settlement (section 4); remove writer #1 |
| P1-3 | **No idempotency.** A double submit (the UI form has no guard) can create two items with the same price. The step 5 "existing item" check races | no `idempotencyKey` in `subscriptionItems.create` | Deterministic Stripe idempotency key per (studio, subscription, price, attempt window); re-read the subscription inside the lock; unique active paid row per studio |
| P1-4 | **No price verification.** The studio plans refuse a Stripe Price unless active, USD, monthly and exactly the configured amount (`stripePriceMatchesExpected`). The add-on trusts the env id blindly. The amount the UI shows is the Organizer *plan* price (`resolveDisplayedMonthlyPriceCents(getBillingPlan("organizer"))` = $12 Founder / $19 regular), not a read of the add-on Price; platform analytics and accounting hardcode `ORGANIZER_SUITE_ADDON_CENTS = 1200` | `billing/page.tsx:982`, `platform/analytics/page.tsx:95`, `platform/accounting/page.tsx:104` | One configured expected amount, verified against the Stripe Price at purchase; UI and MRR read the same source |
| P1-5 | **Add-on Price amounts are undocumented.** Repo docs say "Organizer Suite $12 / $19 ... add-ons unchanged" (`PRICING-P1.md:11`) but no doc, code or test states the Stripe amounts of the two ADDON prices or even that they exist in PROD. Env values were not read (by rule) | `PRICING-P1.md`, `PRICING-P1-RELEASE-RUNBOOK.md:436` | Owner read-only confirmation of the two Stripe Prices (id, amount, interval, active) |
| P2-1 | **Failure behaviour is undefined.** No `payment_behavior`: a card that fails at renewal leaves the studio with the Suite for the whole period until Stripe moves the subscription to `past_due`, then access drops immediately (even for a studio whose grant has expired). Owner decision G5 (past_due) is still open | webhook RPC arg `p_addon.active` | Decide G5; write it into the state machine (section 3) |
| P2-2 | **Remove ends access immediately** (`subscriptionItems.del`, `proration_behavior: "none"`, row `canceled` at once) though the period is paid; no credit; no confirmation of the Stripe deletion before the DB update beyond the call succeeding | `remove/route.ts` | Decide: immediate versus end of paid period; refund policy |
| P2-3 | **Protected/grandfathered subscription.** Neither route calls `loadProtectedRegistry` or `evaluateProtection` (only `/api/billing/checkout` does, `protectedSubscriptions.ts`). That is correct in intent (the DanceAbel purchase must work and it does not change the base price), but it is untested and unrecorded. A purchase also adds a SECOND item to the protected subscription | `protectedSubscriptions.ts`; `billing/checkout/route.ts:498-527` | Explicit decision + test: add-on allowed for protected studios; never touches the protected price/registry row |
| P2-4 | **WP-3 interaction (multi-item).** `buildTransitionPlan` refuses any subscription with `items.length !== 1` (`subscription_unsupported_items`, `priceTransition.ts:168`), and its schedule carries exactly one item per phase, copying item metadata explicitly because Stripe schedules do not copy it (`priceTransition.ts:57,197-199`). After DanceAbel buys the add-on the subscription has two items and the regular-price transition cannot be planned. Order matters: a transition schedule that already exists, then an item added to the subscription, may be rejected by Stripe or leave the add-on out of phase 2 (to prove in test mode). A separate workstream is extending the planner | | Planner must carry the add-on item (price, quantity, metadata) through both phases, verify it in read-back, and reconcile; add-on creation must be refused or routed through the schedule when a schedule is attached; webhook plan resolution reads `items.data[0]` first (`route.ts:938`): with two items the first may be the add-on, so resolution relies on the all-items fallback (`resolvePlanCodeFromEnvPriceIds`); needs a test with the add-on listed first |
| P2-5 | **Purchase timing relative to expiry.** Buying early makes the studio pay while still complimentary; buying late leaves a gap (rows may be fully current only after settlement). The grant and a paid row coexist legitimately | | Decide the purchase window and the notice wording (WP-5); consider a "starts at expiry" option (section 3.4) |
| P2-6 | **Trial/proration policy undefined.** `proration_behavior: "none"` means the first charge is the next renewal; a `trialing` studio pays at trial end | | Decide: prorate and invoice now (recommended for settlement-based activation) versus first charge at renewal |
| P2-7 | **Refund/dispute/cancel of the add-on invoice.** Nothing connects a refunded or disputed add-on invoice to the entitlement; subscription cancel does cancel the row via the RPC | | Decide policy; test |
| P2-8 | **Reconciliation.** No job compares Stripe items to rows (drift, orphan items after a failed DB write: the route creates the Stripe item first, then writes the DB; a DB failure leaves a billed item without entitlement) | `checkout/route.ts` step 6-7 | Webhook-only activation removes this class; add a read-only reconciliation report |
| P2-9 | **Studio-facing UI.** One card; no price read from Stripe, no state for "payment pending/failed", no history, no notice of the expiry date or of the grant that is ending, no explanation of what happens to data. After WP-5 it must show the grant end date and the add-on price consistently | `billing/page.tsx` | UI states per section 3, driven by the same record the notice uses |
| P3-1 | In-memory per-IP rate limit only (6/10 min); no per-studio limit | route | per-studio DB-backed limit |
| P3-2 | Audit actor/reason attribution for paid rows is the database default (`app.entitlement_reason` unset by the webhook/RPC path; the audit trigger records a default reason) | `20270203090000` header | Set `app.entitlement_actor/reason` in the writer |
| P3-3 | Platform MRR hardcodes 1200 cents and counts every active row (including a manual grant) as paid revenue | analytics/accounting pages | Count only `stripe_subscription_item` rows at the real amount |

---

## 3. Entitlement activation state machine after verified settlement (PROPOSAL, UNAPPROVED)

Principle: **the database row is a projection of Stripe, written only by the webhook path (the existing RPC), and only when Stripe shows the item on a subscription whose state proves payment.** The purchase route writes nothing to `usage_addon_entitlements`.

### 3.1 States of a paid Suite row (`source = stripe_subscription_item`)

| State | Meaning | Row | Access |
|---|---|---|---|
| `none` | no item | no row | none (manual grant may still apply) |
| `purchase_pending` | purchase submitted; Stripe has not confirmed payment (3-D Secure, async method, pending update) | **no row** (state lives in Stripe: pending update/incomplete invoice) | none |
| `active` | item present on a subscription in `active`/`trialing` AND settlement verified (3.2) | `status=active` | yes |
| `suspended` | subscription `past_due`/`unpaid` (decision G5) | today: row `canceled` by the RPC; self-heals to `active` on recovery | per G5 |
| `canceled` | item removed, subscription canceled, or payment definitively failed | `status=canceled` | no |
| `expired` | not used for paid rows | | |

### 3.2 Transition table

| # | Event (source) | Guard | Action | Resulting state |
|---|---|---|---|---|
| T1 | Owner/admin confirms purchase (POST, same-origin) | subscription `active`/`trialing`; ownership verified; protected studios allowed; no active paid row; configured Price passes the amount/interval/currency check; no schedule attached unless handled by WP-3 | `subscriptionItems.create` with idempotency key and a payment behaviour that does not apply the item unless payment succeeds (candidate `pending_if_incomplete` or `error_if_incomplete`; to be chosen by the proof); **no DB write** | `purchase_pending` (or an error: nothing created) |
| T2 | `customer.subscription.updated` (item now present) and/or `invoice.paid` for the add-on line | item price in the configured set; subscription `active`/`trialing`; the invoice carrying the item is `paid` (or amount due 0 for a trialing subscription, per decision) | existing RPC upserts the row `active`; audit event written | `active` |
| T3 | `invoice.payment_failed` on the add-on invoice | no row | nothing; operator-visible log; UI shows "payment failed, update card" | `purchase_pending` or none |
| T4 | Pending update expires/fails | | nothing | none |
| T5 | `customer.subscription.updated` -> `past_due`/`unpaid` | G5 | RPC marks row `canceled` (today) or keeps it for a grace period (if G5 says so) | `suspended`/`canceled` |
| T6 | Subscription returns to `active` | item still present | RPC re-activates the same row | `active` |
| T7 | Owner removes add-on | role check; ownership | `subscriptionItems.del` (immediate or at period end per P2-2); then RPC/webhook projects; the route does not update the DB itself | `canceled` |
| T8 | Subscription canceled/deleted | | RPC cancels | `canceled` |
| T9 | Manual grant reaches `period_end` | expiry boundary (exact instant) | grant row `expired` by the expiry job or by the reader's boundary rule; **paid row, if any, is unaffected** | access continues iff `active` paid row |
| T10 | Refund/dispute on the add-on invoice | decision P2-7 | not automatic | unchanged unless owner decides |

Invariants: (a) the system never creates an item without an explicit studio action; (b) never charges outside a studio-initiated purchase or the normal renewal of an item the studio bought; (c) never extends a grant; (d) grant row and paid row stay separate records; (e) every status change is in `usage_addon_entitlement_events`.

### 3.3 Interaction with the manual grant
Both active before expiry: legal (migration `20270203090000`). At the grant's end instant only the grant stops being current; access continues through the paid row. If no paid row is current, access ends and data is preserved.

### 3.4 Option to evaluate (NEEDS OWNER/LEGAL INPUT): a studio-initiated "start at renewal" purchase
A studio that opts in before the deadline can have the add-on added in phase 2 of the WP-3 schedule so it begins at the July 9 boundary with no gap and no early charge. This is a studio-initiated purchase (consistent with the "no automatic purchase" rule) but needs explicit consent text and depends on the WP-3 multi-item extension. Not recommended for the first release.

---

## 4. Test-mode proof required later (PROPOSAL, UNAPPROVED; needs owner approval of the operation list)

The current allowlist `PROOF_ALLOWED_OPERATIONS` (`src/lib/billing/priceTransitionProofGuard.ts`) contains: `accounts.retrieve`, `testHelpers.testClocks.create/advance/del`, `customers.create/update`, `paymentMethods.attach`, `products.create`, `prices.create/retrieve`, `subscriptions.create/retrieve/update`, `subscriptionSchedules.create/update/retrieve/release`, `invoices.list`, `coupons.create`.

**It does not contain the operations the add-on uses.** Additions requested (each needs owner approval; the guard and its tests must change in the same reviewed PR): `subscriptionItems.create`, `subscriptionItems.del`, `invoices.retrieve`. Optional: `invoices.pay` (only to drive a retry of a failed test payment). Nothing else (no live key, no refunds, no Connect operations).

Scenarios (each records request/response through `recordProofEntry`, test clock where time matters):

| # | Scenario | Pass condition |
|---|---|---|
| A1 | Good test card, mid-cycle add (chosen payment behaviour, prorations on) | item appears only after the invoice is paid; the webhook projection writes one `active` row; invoice amount equals the expected proration |
| A2 | Declined test card | no item, no row, no pending state leak |
| A3 | Card requiring authentication | stays `purchase_pending`, no row until completed |
| A4 | Subscription in `trialing` | decide and prove when the row activates and when the first charge occurs |
| A5 | Replay of the same purchase (same idempotency key; second submit) | exactly one item, one row |
| A6 | Renewal failure on a test clock (advance a period with a failing method) | status path `past_due` -> row per G5; recovery reactivates the same row |
| A7 | Remove (immediate and, if chosen, end of period) | item gone, row `canceled` via the projection, no credit unless decided |
| A8 | Subscription with a legacy single price (protected-shaped) | add-on added; base price untouched; protection check unaffected |
| A9 | A8 plus a WP-3 schedule attached before and after the purchase | documented Stripe behaviour; planner carries both items (needs the separate extension) |
| A10 | Webhook plan resolution with the add-on listed first in `items.data` | plan and billing_plan unchanged |
| A11 | Price verification refusal (inactive, non-USD, wrong interval, wrong amount price) | purchase refused before any Stripe write |

Evidence also needs the local (non-Stripe) tests listed in section 6.

---

## 5. Pricing recommendation (PROPOSAL, UNAPPROVED)

### 5.1 Evidence

| Fact | Source |
|---|---|
| Standalone Organizer Suite plan: **$12/month Founder**, **$19/month regular**, 30-day trial, 3.5% DanceFlow fee per ticket | `src/lib/billing/plans.ts:154-166` (`amountMonthlyCents: 1200`, `regularAmountMonthlyCents: 1900`, `feeStructureNote`) |
| Add-on fee tiers when attached to a studio plan: **3.25%** Starter/Growth, **3.0%** Pro | `src/lib/events/platformFee.ts:14-16`; billing page copy |
| Studio plans: Founder **$59 / $99 / $159**; regular **$89 / $149 / $249 is provisional, not approved, inactive** | `plans.ts:55-120`; `PRICING-P1.md`; roadmap PRICING-P1 note |
| The billing page shows the add-on at the Organizer plan price ($12 while Founder pricing is active, else $19) | `billing/page.tsx:982` |
| Platform MRR assumes $12 per add-on | `platform/analytics/page.tsx:95` |
| The add-on and the Organizer plan share `isFounderPricingActive()`; annual and add-on prices "unchanged" and no approved annual amounts exist | `PRICING-P1.md:11,37`; gap report R11 |
| DanceAbel Pro: grandfathered $129/month until July 8, 2027, then the then-regular Pro price (decided separately) | `D7-RELEASE-READINESS.md` 8.1 |
| Competitor/market data | **none in the repo; not used** |

Arithmetic from those facts only: vs the standalone Organizer plan (3.5%), the Pro add-on tier saves 0.5 percentage point of ticket volume (0.25 pp on Starter/Growth). At price parity ($19 both) the add-on is never dearer than the standalone plan and strictly cheaper once the studio sells any tickets. A price above parity needs a value argument that the repo does not contain.

### 5.2 Options (monthly, USD; all NEEDS OWNER APPROVAL)

| Option | Price | Assumptions | Pros | Cons |
|---|---|---|---|---|
| **1. Fixed parity with the regular Organizer plan** | **$19/month** for everyone, including during Founder pricing | One number, quoted in the notice; independent of the global Founder flag | Mirrors the existing regular price; DanceAbel's cost is knowable today; no flag risk on July 9, 2027 | Removes any launch discount for new add-on buyers; differs from the $12 shown/assumed today |
| **2. Parity, following the Founder flag** (current code behaviour) | **$12** while Founder pricing is active, **$19** after | Reuses existing Price pairs; assumes the two ADDON Stripe prices equal $12/$19 (UNVERIFIED, P1-5) | No new numbers; matches the UI and the analytics assumption | DanceAbel's price on July 9, 2027 depends on a global switch that the owner might flip; notice would have to state a number the flag could change |
| **3. Owner-set value price** | **NEEDS OWNER INPUT** | e.g. priced against the fee advantage or as a share of the Pro price | Could capture more value from studios that sell many tickets | No evidence in the repo to derive it; risk of inconsistency with the Organizer plan |

**Recommended (PROPOSAL, UNAPPROVED): Option 1 for the DanceAbel transition and for any studio buying after the Founder window (a single regular add-on price of $19/month, monthly interval, no trial, no annual), and Option 2 only for the period while Founder pricing is active, if the owner wants to keep the launch offer.** Rationale: it is the only figure the repo documents as the regular Suite price, it keeps the notice honest (one number, fixed at notice time), and it avoids tying a contractual notice to a global feature flag. Monthly only because no annual amounts are approved.

### 5.3 Numbers and decisions that need owner input
1. The add-on monthly price (regular) and whether a Founder price exists for the add-on; confirmation that the existing ADDON Stripe Prices equal $12/$19 (read-only owner check; id, amount, interval, active).
2. Whether the add-on price is fixed per notice (Option 1) or follows the Founder flag (Option 2).
3. Billing interval (monthly recommended) and any annual price (none approved).
4. Trial: none recommended for the add-on; decide whether a trialing studio may buy.
5. Proration/first charge policy (invoice now on a prorated basis versus next renewal) and the payment-behaviour choice.
6. Past_due handling (G5) and remove timing (immediate versus period end), refund policy.
7. Earliest allowed purchase date before July 9, 2027 and the "start at renewal" option (3.4).
8. Tax treatment (nothing in the repo).
9. The then-regular Pro price (separate WP-3 decision) as it will sit beside the add-on in the notice.

---

## 6. Work-package proposal and tests (PROPOSAL)

| WP | Scope | Files (owner = single writer) |
|---|---|---|
| WP-4.0 | Owner decisions (5.3), Stripe read-only price confirmation, G5 | docs only |
| WP-4.1 | Purchase route hardening: POST only, CSRF/same-origin, add-on price verifier (pure function mirroring `stripePriceMatchesExpected`), idempotency key, payment behaviour, no DB write, protected-studio decision, refuse when a WP-3 schedule is attached unless handled | `src/app/api/billing/addons/organizer-suite/checkout/route.ts`, new `src/lib/billing/organizerSuiteAddonPricing.ts`, tests |
| WP-4.2 | Webhook projection only: confirm RPC path is the only writer; settlement guard (invoice paid / item present on active subscription); second-item plan-resolution test; set audit actor/reason; remove writer #1 and update the writer allowlist test | `src/app/api/payments/webhook/route.ts`, `src/lib/billing/__tests__/entitlementWriters.d7.test.ts`, possibly a small SQL addition (needs its own migration review) |
| WP-4.3 | Remove route per decision (period end/immediate), POST only | `.../organizer-suite/remove/route.ts` |
| WP-4.4 | UI: states (none, pending, active, failed, grant-ending-on-date), price from the single source, no hardcoded 1200 | `src/app/app/settings/billing/page.tsx`, platform analytics/accounting |
| WP-4.5 | Test-mode proof: allowlist additions (`priceTransitionProofGuard.ts` + test), runner scenarios A1-A11, evidence | `src/lib/billing/priceTransitionProofGuard.ts`, proof script/docs |
| WP-4.6 | WP-3 multi-item extension (separate workstream; dependency) | `src/lib/billing/priceTransition*.ts` |

Tests to add: price verifier (active/USD/month/amount/interval_count); GET returns 405; double POST creates one item and one row; declined/pending payment writes no row; webhook activation requires an item on an `active`/`trialing` subscription and a paid invoice; past_due and recovery; protected-studio purchase allowed and base price untouched; add-on first in `items.data`; grant plus paid row coexistence and the boundary at `2027-07-09T04:00:00Z` (03:59:59Z allowed through the grant, 04:00:00Z refused without a paid row, allowed with one); cross-studio item refusal; UI states; platform MRR counts only paid rows.

## 7. What this document does not decide
Price, interval, trial, proration, past_due, remove timing, refunds, tax, earliest purchase date, whether protected studios use the same route, and the payment-behaviour choice. None of these may be assumed by an implementer.
