# Founder Pricing Policy Gap Report

Status: **audit and plan only** (2026-10-25). Nothing here is implemented, merged, deployed, applied to a database or created in Stripe.
Scope: read-only inspection of `origin/main` (`1e66c8e9`) and the deployed branch `origin/release/pricing-p1` (`4bc938c6`, production `dpl_HEvyvNbHzAiMBGT3yPVzeiGJk6Sj`), the repository's migrations and docs, public pages, and the open BILLING-QA PRs. No hosted database or Stripe account was read.

**Evidence basis.** Three independent read-only code audits (allocation and lifecycle; annual, portal, webhook and tests; marketing copy and early-access mechanisms) were run against committed refs. Findings the author re-checked personally are marked **[verified]**; the rest are the auditors' reports with file paths (line numbers are approximate where marked `~`). Historical documentation is not treated as proof of production behavior. Classification: **PASS / FAIL / BLOCKED / NOT IMPLEMENTED** (BLOCKED = cannot be determined without evidence we are not allowed or able to read; the missing evidence is named).

Refs: `@M` = `origin/main`, `@P` = deployed `release/pricing-p1`. The billing core (checkout route, `studioCheckoutPricing.ts`, `subscriptionPlanResolution.ts`, `plans.ts`, portal route, get-started and pricing pages) is identical on both; the webhook differs only by the SMS-credit pre-dispatch on main.

---

## 1. Historical policy versus the approved policy

| Topic | Historical (as released and documented) | Approved 2026-10-25 | Gap |
|---|---|---|---|
| Founder prices | $49/$79/$129 originally; PRICING-P1 released $59/$99/$159 (new subscriptions) | $59/$99/$159 | none for amounts |
| Founder cap | Copy once said "first 25 studios"; BR-4B removed the count. `FOUNDER_STUDIO_SPOTS = 25` exists but is never referenced **[verified]** (`plans.ts:51`) | 25 total including 1 existing Founder; 24 for new studios | **no enforcement, no record** |
| Duration | Copy: "12 months after your free trial" (`plans.ts:65/92/126`, `get-started/studio/page.tsx:~77,~222`, live site); PRICING-P1.md records "term, eligibility and post-12-month behavior undefined in code" | 12 **paid** months after the 30-day trial, then Regular with advance notice and monthly/annual choice; no lifetime discount | copy ambiguous; no stored start/end; no transition |
| Regular price | $89/$149/$249 stored as `provisionalRegularAmountMonthlyCents`; deliberately **hidden** until `REGULAR_PRICING_ACTIVATED` + approval ref; activating it also requires ending Founder pricing | Regular price disclosed **before checkout** while Founder is active | existing gate cannot show both; needs decoupling (display vs activation) |
| Annual | Backend path exists, no UI, no approved amounts, no gate | Monthly + annual for all eligible studios; amounts need financial approval; no stacking on Founder | unguarded path, no amounts |
| Marketing line | none | "Experience the Full Value of DanceFlow. At a Founder-Exclusive Price." | not present anywhere |
| Early access | none | optional, studio-scoped, revocable | no mechanism |

## 2. Existing code and database enforcement

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 2.1 | Maximum 25 Founder studios enforced | **NOT IMPLEMENTED** | No counter, table, RPC, constraint or check at signup, checkout or webhook. Every `founder` hit in `src` and migrations is a switch, a label or copy. The Founder price is served to every studio's monthly checkout while the env switch is on. |
| 2.2 | A persisted per-studio Founder record (start date, trial end, first paid period, promo end, original plan, eligibility evidence, position) | **NOT IMPLEMENTED** | No such columns/tables exist. Checkout writes `offerType` only into Stripe session/subscription **metadata** (`checkout/route.ts:600-635`); the webhook never reads it; `studio_subscriptions` stores no Price ID, offer type or trial end (`webhook/route.ts:995-1007`). Founder and Regular resolve to the **same plan code**, so the application cannot tell them apart. |
| 2.3 | Fail-closed monthly Founder Price resolution and amount check | **PASS** | `studioCheckoutPricing.ts`; `founderPriceGuard.pricingp1.test.ts` (8 tests); #302/#319 on both refs. |
| 2.4 | Regular pricing cannot activate silently | **PASS** | requires `REGULAR_PRICING_ACTIVATED==="true"` and a non-empty approval ref (`regularPricing.ts`); neither variable exists in project or shared env (checked 2026-10-24). |
| 2.5 | Existing subscribers are not repriced by checkout | **PASS** | managed statuses are redirected to the billing portal before any price lookup (`checkout/route.ts:~219-234, 511-542`). |
| 2.6 | No SaaS code path changes a subscription's base price | **PASS** | No `subscriptions.update`, schedule or price-change API on SaaS plan subscriptions; only add-on item create/delete with `proration_behavior:"none"` (`addons/*`). The `subscriptions.update` calls in `memberships/actions.ts` are client memberships. |
| 2.7 | Tenant authorization on checkout and portal | **PASS** | owner gate, customer from service-role mapping (`checkoutAuthority.launchsec2a`, `portalCustomer.paydc4a`, `saasBillingIdentityLock.paydc4a`). `studio_subscriptions` writes are service-role only after `20260918070000_entitlement_authority_hardening.sql`. |
| 2.8 | Webhook event dedupe (replay, concurrent duplicates) | **PASS** | leased `claim_payment_provider_event` (`20261116090000_paywh1_webhook_event_claims.sql`); `eventClaims.paywh1.test.ts`. |
| 2.9 | Subscription events safe out of order | **FAIL** @M/@P | Subscription events upsert from `event.data.object` with no `created`/version check; an older event can overwrite newer state (`webhook:~3567-3590`). Invoice handlers re-fetch live state. **#335 addresses this** (draft). |
| 2.10 | Trial end is recorded | **FAIL [verified]** | `syncStudioBillingSnapshot` takes an optional `trialEndsAt` that defaults to `null` and writes `studios.trial_ends_at` on every call; its only caller (`webhook:1049`) omits it, so **every subscription event sets `studios.trial_ends_at = NULL`**. `studio_subscriptions` has no trial column the webhook writes. **#335 syncs it** (draft). |
| 2.11 | First paid invoice / trialing-to-active transition detected | **NOT IMPLEMENTED** | `invoice.paid` and `invoice.payment_failed` write `studio_invoices` (no `billing_reason`); nothing identifies the first paid invoice; `invoice.payment_succeeded` is not handled. |
| 2.12 | Trial abuse: a returning or canceled studio gets another trial | **FAIL** | every new checkout sets `trial_period_days` with no prior-trial check (`checkout/route.ts:~630`). A canceled studio that returns gets the Founder price **and** a fresh 30-day trial. |
| 2.13 | Promotion codes cannot stack on Founder pricing | **FAIL [verified]** | `allow_promotion_codes: true` on every studio session (`checkout/route.ts:626`). Whether any live codes exist is **BLOCKED** (Stripe read). |
| 2.14 | Abandoned Checkout Sessions release anything | **NOT IMPLEMENTED** | `checkout.session.expired` is handled only for event commerce, not studio subscriptions. There is nothing to release because nothing is reserved. |
| 2.15 | `studio_subscriptions` is race-safe (one row per studio) | **BLOCKED** | The base `CREATE TABLE` predates migration history; no unique constraint on `studio_id` is visible. Needs `pg_indexes` (DEV/PROD) or the original script. The webhook does select-then-insert/update. |
| 2.16 | `studios.billing_plan` follows subscription changes | **FAIL** | The webhook never writes it; public embed and Discover read it. **#335 writes it** (draft). |
| 2.17 | Internal/test/comp/ambassador studios cannot consume a Founder position | **FAIL / NOT IMPLEMENTED** | `studios.billing_override_*` (reason free text: `ambassador/founder/internal_test/manual_review`) grants a plan; set by ambassador claim RPC or manual SQL (no admin UI writes it; `platform/billing/page.tsx` only displays). A comp or test studio that later checks out would receive the Founder price like anyone else. The existing "founder" override reason is a comp label unrelated to the Stripe Founder price. |
| 2.18 | Audit history for billing/Founder state changes | **PARTIAL** | No generic billing audit table. `platform_admin_actions` exists (one confirmed use). Domain audit tables exist as patterns (`studio_sms_onboarding_audit`, `studio_sms_*_switch_log`, `instructor_audit_events`). |

Existing patterns that a Founder allocation can reuse (descriptions only): ENT-1 `usage_reservations` (reserved/finalized/released states, partial unique idempotency index, `pg_advisory_xact_lock` + `SELECT … FOR UPDATE`, `SECURITY DEFINER`, service-role-only grants; `20261013090000_ent1_usage_allowance_reservations.sql`) and `payment_provider_events` leased claims.

## 3. Verified production behavior versus unverified assumptions

**Verified (2026-10-24/25, read-only):**
- Production serves `dpl_HEvyvNbHzAiMBGT3yPVzeiGJk6Sj` on both domains; the live studio pricing page shows Founder $59.00/$99.00/$159.00 and the sentence "Founder pricing lasts for 12 months after your 30-day free trial"; **no Regular price appears** on the studio page (the organizer page does show a "regularly" price).
- Production env: the Founder Price variables are Production-only entries holding the four supplied IDs (read back 2026-10-24); no `REGULAR_PRICING_*` variable exists.
- The webhook endpoint answers unsigned requests with 400 (secret configured).

**Not verified (each needs the named evidence):**

| Assumption | Evidence needed | Who/how |
|---|---|---|
| How many studios already hold Founder pricing (the true remaining capacity) | Stripe subscription query by the three new Founder Prices and the old Founder Prices (any status), plus open Checkout Sessions | owner Dashboard or restricted read key |
| Identity of the grandfathered $129 studio and its subscription state, customer, metadata (`source`, `studioId`), discounts, schedules | Stripe subscription lookup by `price_1TdDHwEY0sTayNiSIe1nD3Lg` | owner |
| That the grandfathered studio's row resolves to Pro at runtime | DB row check (`subscription_plans` price columns were nulled in `20260916013645`, so resolution depends on the env legacy entry or metadata) | approved read-only DB select |
| Live billing-portal configuration (plan switching, cancel, pause, which Prices listed) | Stripe portal configuration | owner Dashboard |
| Active live promotion codes/coupons | Stripe | owner |
| PROD yearly Price IDs/amounts and whether any annual subscriptions exist | `subscription_plans.stripe_price_id_yearly` + Stripe | approved DB read + Stripe |
| `studio_subscriptions` schema/uniqueness | `information_schema`/`pg_indexes` | approved DB read |
| Whether `trial_ends_at` is relied on anywhere that the NULL overwrite already breaks | dashboard reads `subscription?.trial_ends_at ?? workspace?.trial_ends_at` (`app/page.tsx:~1167`) | behavior check on a trialing studio |

**Capacity today (item 5 below) is therefore UNKNOWN, not "24".** Between the PRICING-P1 promotion (2026-10-24 evening EDT) and now, nothing in the application would have stopped additional studios from taking the Founder price.

## 4. Protection of the existing grandfathered subscriber

| # | Check | Status | Notes |
|---|---|---|---|
| 4.1 | Checkout cannot move it to $159 | **PASS** | managed subscribers go to the portal; no price lookup. |
| 4.2 | No application path reprices it | **PASS** | no `subscriptions.update` on SaaS subscriptions; add-on routes only add items. |
| 4.3 | Webhook maps its Price to Pro | **PASS (code) / BLOCKED (runtime)** | resolves via `STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY` (set in Production per read-back) or a database match; if the env were unset and the DB row lacks the Price, resolution falls to metadata or throws. |
| 4.4 | The application can identify it as "Founder position 1" | **FAIL / NOT IMPLEMENTED** | Identifiable only by Stripe Price ID; the repository never compares against that ID. The runbook is the only committed reference. A mutable label or env value is not a reliable identity. |
| 4.5 | Protected from the new 12-month schedule and from Regular | **NOT IMPLEMENTED** | no schedule or transition exists yet, so nothing can move it today; once one is built, protection must be explicit (see §10 recommendation). |
| 4.6 | Stripe-side protection (portal switching) | **BLOCKED** | portal configuration unread. If plan switching is enabled and lists other Prices, the studio could self-switch. |
| 4.7 | Return after cancellation | **FAIL** | a canceled $129 studio returning is a new checkout at the current Founder or Regular price plus a new trial; the $129 term is lost. Needs an owner decision (§6 D5). |

**Recommended protection:** a `grandfathered` Founder entitlement row for this studio (position 1) keyed by `studio_id`, seeded once by an approved operation after the owner verifies the studio and its Stripe subscription; database triggers forbid any change to its price fields, promotional fields or status except through a platform-admin RPC that requires a reason and writes the audit log; the transition job refuses `kind='grandfathered'` rows unconditionally.

## 5. Remaining Founder capacity and how it is calculated

Definition (to be implemented in the database, not in code or copy):

```
capacity            = 25
occupied            = grandfathered + committed + trial_hold + reserved(unexpired)
available_to_new    = capacity - occupied          -- never negative; refusal when 0
released/expired/voided rows are not counted
```

Today: grandfathered = 1 (owner statement, unverified in Stripe); committed/trial_hold/reserved = **UNKNOWN**; so `available_to_new` is **UNKNOWN**. The "24" claim in marketing must come from this computation (a live read of the ledger), never from a constant. Seeding the ledger with already-existing Founder-priced subscriptions (if any) is a separate, approved, reconciled operation against Stripe.

## 6. Eligibility and allocation: decisions that need your approval

These are **recommendations, not approved rules.** Each lists the recommended default and the alternative.

| ID | Decision | Recommended default | Alternative / risk |
|---|---|---|---|
| D1 | When is a position **committed**? | At the **first successful paid invoice** (amount paid > 0 after the trial). | Commit at checkout completion: simpler, but trial-cancelers consume positions permanently. |
| D2 | What holds a position between checkout and first paid invoice? | A **trial hold**: created when the subscription starts (trialing, payment method on file), expiring at `trial_end` + a short grace (recommend 3 days) unless the first paid invoice arrives. | Hold only during checkout: risks overselling the cap if many trials later convert. |
| D3 | Temporary **reservation** at checkout | Reserve **before** creating the Checkout Session; set the Stripe session `expires_at` (minimum 30 minutes) and expire the reservation with it; release on `checkout.session.expired` and by a sweeper. Recommend 60 minutes. | Longer windows lock positions for abandoners. |
| D4 | Can a position be recycled? | Released/expired **before** the first paid invoice: yes. **Committed**: no, except an administrative **void** by a platform admin with a required reason (fraud, duplicate, internal/test) that is audited. | Never recycle (stricter) or recycle on cancellation (lets studios churn the cap). |
| D5 | Founder cancels and returns | Within the original 12-paid-month window: resume the **remaining** Founder months, **no new trial**. After it: Regular price. A studio that canceled in trial (no paid invoice) is treated as new (position released; trial policy below). | Treat every return as new, or forfeit Founder pricing on cancellation. |
| D6 | Trial abuse | One free trial per studio (and per Stripe customer); no new trial on return after any paid invoice. | Needs a persisted trial-used marker (none exists today). |
| D7 | Plan change during the Founder period | Founder pricing follows the studio across Starter/Growth/Pro at the Founder Price of the chosen plan; the promo end date does **not** move; a switch to a Regular Price is not offered during the window (portal lists Founder Prices only or plan switching is disabled). | Allow upgrades only, or end the promotion on any change. |
| D8 | Failed payment | Past-due keeps the position; if Stripe ultimately cancels before any paid invoice → release; after paid invoices → remains committed, and the paid-month counter only counts successful invoices. | Define a dunning grace (recommend Stripe's configured retry schedule). |
| D9 | Eligibility and duplicate/fraud rules | One Founder entitlement per studio; per Stripe customer; per verified owner user; evidence stored with the entitlement (email-verified owner, studio name, optional business identifier). Anything beyond (EIN, domain matching) is your policy call. | Heavier verification slows signup. |
| D10 | Internal, test, comp and ambassador studios | Explicitly **excluded** from allocation (a platform-set flag checked inside the reservation function); test studios use Stripe test mode and never touch the live ledger. | Name or reason heuristics are not reliable. |
| D11 | What happens at position 26 while Regular is inactive? | **Blocker you must decide:** with the cap enforced and Regular pricing inactive, studio #26 cannot buy at all. Options: (a) activate Regular (separate approval) before the cap fills; (b) a waitlist page; (c) hold the cap open until Regular is approved. | Without this, enforcement creates a dead end. |
| D12 | Regular amounts final for disclosure? | Confirm $89/$149/$249 may be shown now. They are "provisional" in the code and docs; the new policy says they are the transition prices. | Displaying a provisional price is a public commitment. |
| D13 | Definition of "12 paid months" | **Twelve successfully paid monthly invoices at a Founder Price** (an idempotent per-invoice counter), not a calendar window; the trial and unpaid/paused months do not count; a derived expected end date is shown for notices. | Calendar end = first paid period + 12 months (simpler, but pauses and failures need special rules). |
| D14 | Transition mechanism | Application-driven: entitlement record + notice schedule + a job that moves the subscription item to the Regular Price at the 13th billing period, **failing safe** (no change, alert, `transition_blocked` event) if Regular approval/config is absent. Stripe Subscription Schedules are the alternative; they conflict with portal-managed plan switching and need a test-mode proof before choosing. | A decision for the design slice, backed by a Stripe test-mode experiment. |
| D15 | Renewal notice cadence and channel | Recommend 60, 30 and 7 days before the Founder window ends, plus an in-app banner, via the existing transactional email pipeline; copy needs your approval. | Terms §5 only promises prospective changes "after notice" with no period. |
| D16 | Promotion codes | Disable `allow_promotion_codes` for Founder sessions (or restrict to specific coupon IDs). | Codes can stack onto Founder pricing today. |
| D17 | Interim control until enforcement exists | The cap is unenforced **right now**. Choose: (a) monitor Stripe weekly and accept the risk; (b) a short, approved **stop-sell** (setting `FOUNDER_PRICING_ACTIVE=false` makes studio checkout refuse, since Regular is inactive) until the ledger ships. Not done; requires your approval. | (b) halts all new studio signups. |
| D18 | Annual billing | See §7 (amounts, eligibility, trial, promo codes, Founder exclusion). | |
| D19 | Legal | Terms/checkout consent wording for the 12 paid months, Regular renewal price, notices and annual. | Terms §5 and checkout disclosure are currently generic. |
| D20 | Grandfathered studio seeding | Approve the one-time operation that seeds position 1 after you confirm the studio and its Stripe subscription. | Requires a hosted DB write (not authorized now). |

## 7. Annual billing: status and gaps

| # | Item | Status | Evidence |
|---|---|---|---|
| 7.1 | Annual checkout path | **FAIL (reachable, not fail-closed)** | `billingInterval=year` takes `subscription_plans.stripe_price_id_yearly` straight from the database (`checkout/route.ts:67-72` **[verified]**), with no env Price IDs, no Founder/Regular gate, no `expectedAmountCents`, so the PRICING-P1 amount check is skipped (`:~556-576`); `stripePriceMatchesExpected` requires `interval==="month"`. |
| 7.2 | Reachable from the UI | **PASS (not reachable)** / **FAIL (reachable by URL)** | The billing page hard-codes `month` (`settings/billing/page.tsx:~1077`) and get-started omits it, but `GET /api/billing/checkout?...&billingInterval=year` is accepted, so any studio owner can hand-craft an annual checkout. |
| 7.3 | Trial and promotion codes on annual | **FAIL** | annual sessions still get `trial_period_days` and `allow_promotion_codes: true`. |
| 7.4 | Annual amounts defined | **NOT IMPLEMENTED** | `plans.ts` has no annual field; PRICING-P1.md: "no approved annual amounts". |
| 7.5 | Yearly Price IDs | **BLOCKED** | none committed. `20260916013645` records old PROD `price_yearly` values 499/799/1299/null, suggesting legacy yearly Prices may still be referenced by `subscription_plans`; whether they exist or are active is unverified. |
| 7.6 | Webhook interval/plan for an annual Price | **FAIL** | `year` only if the item Price equals the database yearly ID; an annual Price not in `subscription_plans` has no env mapping, falls back to `metadata.planCode` and is recorded as `month`, or throws and retries. |
| 7.7 | Existing annual subscribers protected | **BLOCKED** | unknown whether any exist; no code reprices them. |
| 7.8 | Tests | **PARTIAL** | one test pins the current unguarded behavior (`founderPriceGuard.pricingp1.test.ts:181`); authorization tests use `year` only for role checks. |

Policy-conformant annual design (for approval): annual available to all eligible studios behind an explicit annual gate with approved amounts and an approval reference; env Price IDs per plan; an amount + `interval=year` check; no promotion-code stacking; **no repeat trial** for returning studios; a Founder studio is not offered annual during its Founder window (no stacked discount) but may choose Regular monthly or annual at expiry; existing annual subscriptions untouched. **A small immediate hardening is independent of pricing approval:** refuse new `billingInterval=year` studio checkouts until the gate exists (see slice S0).

## 8. Founder duration and renewal enforcement

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 8.1 | Founder start date recorded | **NOT IMPLEMENTED** | no record. |
| 8.2 | Trial completion tracked | **FAIL** | `trial_ends_at` is nulled on every event (see 2.10); no trial columns on `studio_subscriptions`. |
| 8.3 | First paid billing period identified | **NOT IMPLEMENTED** | see 2.11. |
| 8.4 | 12-month promotional expiration recorded | **NOT IMPLEMENTED** | copy only. |
| 8.5 | Plan change preserves the promotional expiration | **NOT IMPLEMENTED** | no expiration exists; portal changes are only observed by webhook plan resolution. |
| 8.6 | Pause, billing-failure and cancellation handling consistent | **PARTIAL** | status mapping: trialing, active, past_due (includes unpaid), cancelled (canceled or incomplete_expired), otherwise inactive (paused → inactive). No promotional semantics. |
| 8.7 | Scheduled transition to Regular | **NOT IMPLEMENTED** | none; crons are notifications, daily digest, ARIA, docs, event cart, SMS purge. |
| 8.8 | Renewal notice process | **NOT IMPLEMENTED** | no trial-ending, upcoming-invoice or Founder-ending notice code in email, notifications, webhook or billing routes. |
| 8.9 | Portal exposes unintended plan switching | **BLOCKED** | code creates the session with `customer` and `return_url` only (default configuration applies, `portal/route.ts:77-80`); Stripe-side configuration unread. |
| 8.10 | Production can safely enforce these rules while Regular is inactive | **BLOCKED on design** | Enforcement of the cap and the ledger can ship and operate with Regular inactive; **the transition cannot** execute without Regular approval and must fail safe (record `transition_blocked`, alert, leave the subscription unchanged, never silently reprice). |

**Recommended per-studio Founder entitlement record** (not implemented; for the design slice). Table `studio_founder_entitlements`: `studio_id` (unique), `kind` (`founder_new`/`founder_grandfathered`), `position` (1–25, unique where active), `status` (`reserved`/`trial_hold`/`committed`/`released`/`expired`/`voided`), `original_plan_code`, `stripe_customer_id`, `stripe_checkout_session_id`, `stripe_subscription_id`, `current_price_id`, `reserved_at`, `reservation_expires_at`, `trial_end`, `first_paid_invoice_id`, `promo_start`, `paid_invoice_count`, `expected_promo_end`, `notice_state` (jsonb: sent timestamps), `transition_state` (`pending`/`blocked`/`done`/`n_a`), `eligibility_evidence` (jsonb), `created_at/updated_at`. Plus append-only `studio_founder_entitlement_events` (event type, actor, Stripe event id, before/after digest, reason). RLS: staff may read their own studio's row; writes service-role only, matching `studio_subscriptions` hardening. Creation, conversion, commit, release, void and seeding are `SECURITY DEFINER`, service-role-only RPCs; capacity enforced under `pg_advisory_xact_lock` as in ENT-1. Stripe remains the billing source of truth; this table is the **application-level** source of truth for eligibility, position and promotional state (Stripe alone does not hold them).

## 9. Controlled Founder early access

Findings (on `@M`): studio plan entitlements (`BillingFeature`, `access.ts`) are static per plan; `studios.billing_override_*` grants a **plan** with expiry and free-text reason; `usage_addon_entitlements` is per-studio add-ons; global env flags (competition registration, Wave posting, AI) have no per-studio scope, audit or expiry; `studio_sms_pilot_exceptions` is the closest per-studio allowlist pattern (RLS, guard triggers, one-active unique index). **No feature-flag table, `studio_features` table or beta list exists.**

| Capability | Status |
|---|---|
| General availability (plan features / env flag) | **PASS** |
| Plan-entitlement enforcement | **PARTIAL** (works for `BillingFeature`; instructor/location limits and the Payroll Prep gate are **NOT IMPLEMENTED**, PRICING-P1 follow-up) |
| Internal-only | **FAIL** (env flags are global; override gives a plan, not a feature) |
| Selected private-beta studios | **NOT IMPLEMENTED** |
| Founder previews | **NOT IMPLEMENTED** |
| Opt-in by the studio | **NOT IMPLEMENTED** |
| Revocation and expiration | **PARTIAL** (override expiry only; env flags need a redeploy) |
| Owner/platform administration | **PARTIAL** (no admin UI writes overrides; env flags via Vercel) |
| Audit history | **PARTIAL/FAIL** |
| Tenant isolation | **PASS** for existing studio tables |

Recommendation: **one small append-only table** `studio_feature_access` (`studio_id`, `feature_key`, `access_level` internal/beta/founder_preview/general, `granted_by`, `reason`, `opt_in_at` nullable, `expires_at`, `revoked_at`), modeled on `studio_sms_pilot_exceptions`, read inside `studioIdHasFeature` (and refused when the feature requires a higher plan or is a fee-bearing/financial/provider feature: those keys are denylisted from Founder preview by construction), administered from `/platform/studios/[id]` and logging to an audit table. Plan entitlement still applies first; early access never grants a higher tier's paid functionality. No broad feature-flag platform is warranted.

## 10. Security and financial-integrity risks (ranked)

| # | Risk | Severity | Status / mitigation |
|---|---|---|---|
| R1 | Cap exceeded: no enforcement of 25; Founder price is sold without limit while the switch is on | High (commercial) | open; interim control D17; fix slices S1–S3. |
| R2 | Unguarded annual checkout reachable by URL: DB-sourced Price, no amount check, trial, promo codes; possible legacy yearly Prices | High (financial) | open; S0 refuses it. |
| R3 | `trial_ends_at` wiped to NULL by every subscription event | Medium | open; fixed by #335 (draft). |
| R4 | Out-of-order subscription events overwrite newer state | Medium | open; fixed by #335 (draft). |
| R5 | Trial restarts for returning studios; Founder price + fresh trial on return | Medium | open; D5/D6. |
| R6 | Promotion codes stack on Founder pricing | Medium | open; D16; live codes unknown. |
| R7 | Grandfathered studio identified only by a Stripe Price ID; portal could let it self-switch | Medium | open; §4 protection + portal check. |
| R8 | `studio_subscriptions` may lack uniqueness on `studio_id` | Medium | BLOCKED (schema read). |
| R9 | Internal/test/comp studios can take a Founder position | Medium | open; D10. |
| R10 | Regular disclosure conflict: policy requires it before checkout; code hides it and couples display to activation | Medium (consumer-disclosure) | open; slice S6. |
| R11 | Copy overstates or is ambiguous ("12 months after your free trial" vs "12 paid months"); no count, no renewal notice promise | Medium | open; S6. |
| R12 | Unowned platform subscriptions fail with 500 and Stripe retries forever | Low/Medium | open; fixed by #335 (draft). |
| R13 | Studio checkout expiry never releases anything (nothing is reserved yet) | n/a today | becomes a requirement of S2. |
| R14 | Environment drift: `main` differs from production (85+ commits); the BILLING-QA drafts target `main` | Process | reconcile before any promotion of `main`; release branch approach used for PRICING-P1. |

## 11. Automated test coverage and missing scenarios

Existing (on `@M`): `founderPriceGuard.pricingp1` (8), `pricingP1`, `subscriptionPlanResolution.pricingp1`, `founderPricing`, `checkoutAuthority.launchsec2a`, `portalCustomer.paydc4a`, `saasBillingIdentityLock.paydc4a`, `eventClaims.paywh1`, `webhookScope.paydc2b`. **No route-level tests of the subscription webhook exist on `main`.**

BILLING-QA work already in flight (do not duplicate): 
- **#332 (merged):** Stripe test-mode studio Price verifier and PASS/FAIL/BLOCKED report (`npm run qa:billing-prices`; `src/lib/billing-qa/*`). Monthly only; no DB Price IDs or yearly.
- **#334 (draft, base `main`):** Playwright spec B1–B6 in Stripe test mode with a local QA Supabase and `stripe listen` forwarding; needs a test key, the Founder Prices and optionally the legacy Price; no annual, no `price_mismatch`, no concurrency.
- **#335 (draft, stacked on #334):** webhook fix (re-fetch current subscription, `billing_plan` sync, trial sync, unowned acknowledgement) with ~28 POST-level tests and E2E B5 and B7–B12 (failed payment, recovery, delayed events, cancellation, incomplete). No annual, no stale-plan backfill.
- **#336 (draft, base `main`):** dark platform-admin read-only deployed price-config report (AAL2). No Stripe/DB calls.
- **#340 (draft, stacked on #336):** owner-run no-payment smoke kit and session read-back (restricted live key only; monthly only).
- Conflicts: #335 vs open #292 (CI-D refunds) on webhook `route.ts` and `ownershipFakes.ts`; #336 and #340 both edit `priceVerifier.ts`, `report.ts`, `docs/qa/billing-qa.md`.

Reusable infrastructure (reuse, do not rebuild): `e2e/helpers/studioSubscriptionFixture.ts`, `e2e/helpers/stripeTestModeFixture.ts`, `src/lib/e2e/config.ts`, `src/lib/payment-harness/*`, `docs/qa/local-e2e-environment.md` §3a, `src/lib/payments/__tests__/ownershipFakes.ts` (POST-level webhook fakes), the local-stack Postgres pattern (`localStack.*.test.ts`, `localStackLock.ts`), and the `src/lib/billing-qa/report.ts` report format.

**Gap map** against the requested scenarios:

| Scenario | Today | Covered by an open BILLING-QA PR | Needed |
|---|---|---|---|
| Positions 1 through 25 | missing | no | S1 SQL tests (local-stack PG) |
| Position 26 refused Founder | missing | no | S1, S2 |
| Two simultaneous claims for the last position | missing | no (only event-claim concurrency) | S1: two connections racing `reserve` |
| Abandoned Checkout Sessions | missing | #340 only checks smoke sessions stay unpaid | S2 (`checkout.session.expired` + TTL sweeper) |
| Trialing and failed-payment subscriptions | status mapping only | #335 (unit + E2E B8, B11) | S3 ledger transitions |
| Existing grandfathered protection | partial (plan resolution, price guard) | #334 B6, #335, #340 | S1 triggers/RPC refusal, S4 transition refuses |
| Founder plan changes | n/a | #334 B4, #335 (portal change by Price; Founder-to-Founder only) | S3 (promo end preserved; Regular switch refused) |
| Founder cancellation and return | missing (return) | #335 B10 covers cancellation only | S3 |
| Exact 12-month boundaries | missing | no | S4 (13th-invoice boundary, paid-invoice counter idempotency) |
| Renewal notices | missing | no | S4 |
| Regular pricing inactive at expiration | partial (checkout refusal) | no | S4 (`transition_blocked`) |
| Price mismatch and missing Price IDs | monthly covered | #332, #336 (config) | S5 (yearly, DB IDs) |
| Annual billing eligibility | missing; one test pins unguarded behavior | no | S5, S0 |
| Cross-tenant authorization | covered for checkout/portal | #334 B2, #335 tenant isolation | S1 RLS tests; admin RPCs |
| Replayed and out-of-order webhooks | dedupe PASS; ordering FAIL | #335 | S3 on top of #335 |

## 12. Proposed bounded Git-only slices (none authorized)

Principles: Git-only, dark by default, no hosted DB/Stripe action inside a slice; each hosted step (migration apply, seeding, env, deployment) is a separate approval per the established gates. Release from branches off the deployed base when needed (production is not `main`).

| Slice | Content | Depends on | Notes |
|---|---|---|---|
| **S0 Annual hardening (small)** | Refuse new studio `billingInterval=year` checkouts (and promo/trial on annual) until an annual gate exists; update the pinned test. | none | independent of pricing decisions; protects against R2. Needs no new approval beyond development authorization. |
| **S1 Founder ledger (DB, dark)** | tables `studio_founder_entitlements`, `…_events`; RPCs `reserve`, `convert_to_trial_hold`, `commit_on_first_paid`, `release`, `expire_sweep`, `void`, `seed_grandfathered`; advisory-lock capacity; RLS; guard triggers; **local-stack PG tests** (1–25, 26 refused, concurrent last position, idempotency, grandfather immutability, tenant isolation). Migration timestamp from the repository's reserved block. | decisions D1–D4, D8–D10, D13 | unused by the app; no hosted application. |
| **S2 Checkout integration (dark/flag)** | reserve before session creation; Stripe session `expires_at`; `checkout.session.expired` handler for studios; TTL sweeper cron; fail-closed when the program is full (behavior per D11); disable promo codes on Founder; prior-trial check (D6). | S1, D3, D6, D11, D16 | built on #334 fixtures. |
| **S3 Webhook lifecycle** | trialing → trial hold; first paid invoice → commit and counter; cancel/failed → release; plan-change preserves promo; replay/out-of-order safe. | S1, **#334/#335 merged or rebased**, D5, D7, D8 | conflicts with #292 on webhook `route.ts` to be sequenced by the owner. |
| **S4 Duration, notice, transition** | notice schedule + templates (copy approval), transition job that fails safe without Regular approval, grandfathered exclusion, portal/Stripe configuration check, 12-boundary tests. | S3, D12, D14, D15 | no live transition without separate approval. |
| **S5 Annual (gated)** | env yearly Price IDs, amount/`interval` check, eligibility (Founder window excluded), no promo stacking, annual disclosure; tests. | approved annual amounts and discount (financial), S0 | needs Stripe test-mode Prices. |
| **S6 Copy and checkout disclosure** | decouple Regular **display** from **activation**; approved headline; "12 paid months"; live "N of 25" from the ledger; Regular price and renewal terms before checkout; annual and notice copy; claims-guard tests; Terms/checkout consent text. | S2/S3 (live count), D12, D19, copy approval | public website change = separate authorization. |
| **S7 Early access** | `studio_feature_access` table, `studioIdHasFeature` integration, platform-admin UI, audit; denylist for financial/fee-bearing features. | none technical | optional; separate priority decision. |
| **S8 Reconciliation/ops** | verify ledger vs Stripe (count by Price), seed grandfathered and any existing Founder positions, dashboard for remaining capacity. | S1, owner Stripe evidence, D20 | hosted DB write: separate approval. |

Recommended order: **S0** now-ish (small, independent) → decisions D1–D17 → **S1** → **S2 + S3** (after the owner resolves #334/#335) → **S8 seed** → **S4** → **S6** → **S5** (when annual is approved) → **S7**.

## Standing non-claims

This report does not state that production enforces any Founder-cap, duration, renewal, annual or early-access rule: it does not. Existing documentation that implies "limited", "first 25" or "12 months" describes intent or copy, not behavior.
