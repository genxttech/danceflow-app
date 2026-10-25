# Founder Pricing Policy Gap Report

Status: **audit and plan only** (2026-10-25; D11, R11, D17 and D13 owner decisions recorded 2026-10-25, see §6A, §13, §14, §15 and §16). Nothing here is implemented, merged, deployed, applied to a database or created in Stripe.
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
| D1 | When is a position **committed**? | At the **first qualifying paid period** (the first paid renewal-cycle invoice after the trial; see §16.3). Presented for decision in §16.4. | Commit at checkout completion: simpler, but trial-cancelers consume positions permanently. |
| D2 | What holds a position between checkout and first paid invoice? | **Revised 2026-10-25 (integrity review; presented in §16.4):** a **trial hold that follows the Stripe subscription** that already carries the Founder Price: it persists until the first paid period (then it is committed) or until the subscription ends terminally before any paid period (then it is released). No fixed timeout while Stripe may still collect. *(The earlier draft, "expiring at trial end + 3 days", could release a position while a Founder-priced subscription was still retrying a failed first invoice, producing a 26th Founder subscriber.)* | A fixed expiry that **cancels** the unpaid Founder subscription is consistent but harsh; a fixed expiry that does not cancel is rejected (overshoot). |
| D3 | Temporary **reservation** at checkout | Reserve **before** creating the Checkout Session; session `expires_at` set explicitly (Stripe minimum 30 minutes); reservation expires **5 minutes after the session**; capacity checks ignore expired rows so correctness never depends on the webhook or sweeper timing; release also on `checkout.session.expired` and by a sweeper. Recommend **60 minutes**. Presented for decision in §16.4. | Longer windows lock positions for abandoners. |
| D4 | Can a position be recycled? | Released/expired **before** the first paid invoice: yes. **Committed**: no, except an administrative **void** by a platform admin with a required reason (fraud, duplicate, internal/test) that is audited. | Never recycle (stricter) or recycle on cancellation (lets studios churn the cap). |
| D5 | Founder cancels and returns | Within the original 12-paid-month window: resume the **remaining** Founder months, **no new trial**. After it: Regular price. A studio that canceled in trial (no paid invoice) is treated as new (position released; trial policy below). | Treat every return as new, or forfeit Founder pricing on cancellation. |
| D6 | Trial abuse | One free trial per studio (and per Stripe customer); no new trial on return after any paid invoice. | Needs a persisted trial-used marker (none exists today). |
| D7 | Plan change during the Founder period | Founder pricing follows the studio across Starter/Growth/Pro at the Founder Price of the chosen plan; the promo end date does **not** move; a switch to a Regular Price is not offered during the window (portal lists Founder Prices only or plan switching is disabled). | Allow upgrades only, or end the promotion on any change. |
| D8 | Failed payment | Past-due keeps the position; if Stripe ultimately cancels before any paid invoice → release; after paid invoices → remains committed, and the paid-month counter only counts successful invoices. | Define a dunning grace (recommend Stripe's configured retry schedule). |
| D9 | Eligibility and duplicate/fraud rules | One Founder entitlement per studio; per Stripe customer; per verified owner user; evidence stored with the entitlement (email-verified owner, studio name, optional business identifier). Anything beyond (EIN, domain matching) is your policy call. | Heavier verification slows signup. |
| D10 | Internal, test, comp and ambassador studios | Explicitly **excluded** from allocation (a platform-set flag checked inside the reservation function); test studios use Stripe test mode and never touch the live ledger. | Name or reason heuristics are not reliable. |
| D11 | What happens at position 26 while Regular is inactive? | **Blocker you must decide:** with the cap enforced and Regular pricing inactive, studio #26 cannot buy at all. Options: (a) activate Regular (separate approval) before the cap fills; (b) a waitlist page; (c) hold the cap open until Regular is approved. | Without this, enforcement creates a dead end. |
| D12 | Regular amounts final for disclosure? | Confirm $89/$149/$249 may be shown now. They are "provisional" in the code and docs; the new policy says they are the transition prices. | Displaying a provisional price is a public commitment. |
| D13 | Definition of "12 paid months" | **DECIDED 2026-10-25: option H.** Twelve qualifying paid monthly periods at a Founder Price after the trial, within an **18-calendar-month maximum window** from the first paid period; counts distinct paid service periods, never raw invoices. Rules in §16.3; the grandfathered studio is permanently excluded. | (superseded: raw per-invoice counter and calendar-only window) |
| D14 | Transition mechanism | Application-driven: entitlement record + notice schedule + a job that moves the subscription item to the Regular Price at the 13th billing period, **failing safe** (no change, alert, `transition_blocked` event) if Regular approval/config is absent. Stripe Subscription Schedules are the alternative; they conflict with portal-managed plan switching and need a test-mode proof before choosing. | A decision for the design slice, backed by a Stripe test-mode experiment. |
| D15 | Renewal notice cadence and channel | Recommend 60, 30 and 7 days before the Founder window ends, plus an in-app banner, via the existing transactional email pipeline; copy needs your approval. | Terms §5 only promises prospective changes "after notice" with no period. |
| D16 | Promotion codes | Disable `allow_promotion_codes` for Founder sessions (or restrict to specific coupon IDs). | Codes can stack onto Founder pricing today. |
| D17 | Interim control until enforcement exists | The cap is unenforced **right now**. Choose: (a) monitor Stripe weekly and accept the risk; (b) a short, approved **stop-sell** (setting `FOUNDER_PRICING_ACTIVE=false` makes studio checkout refuse, since Regular is inactive) until the ledger ships. Not done; requires your approval. | (b) halts all new studio signups. |
| D18 | Annual billing | See §7 (amounts, eligibility, trial, promo codes, Founder exclusion). | |
| D19 | Legal | Terms/checkout consent wording for the 12 paid months, Regular renewal price, notices and annual. | Terms §5 and checkout disclosure are currently generic. |
| D20 | Grandfathered studio seeding | Approve the one-time operation that seeds position 1 after you confirm the studio and its Stripe subscription. | Requires a hosted DB write (not authorized now). |

### 6A. Owner decisions recorded 2026-10-25 (D11 and related)

These are the owner's business decisions. **They do not authorize any code implementation, PR merge, production deployment, hosted database change, Stripe Price change or activation of Regular pricing.**

| # | Decision (owner) | Status | Effect on this report |
|---|---|---|---|
| 1 | The Regular monthly prices are **final for the initial Regular offering**: Starter $89, Growth $149, Pro $249. This is business approval of the rates only, not authorization to activate Regular in Production or to change Stripe. | **DECIDED** | Resolves D12. The "provisional" status of the Regular amounts ends as a business matter; activation still needs its own approval and the activation gates (§13 R1). |
| 2 | Founder pricing stays limited to **25 total qualifying studios** including the grandfathered Founder; the allocation ledger makes an **individual eligibility decision for each studio**. | **DECIDED** | Every studio's checkout attempt produces a recorded decision (founder reserved, regular offered, refused-full, refused-ineligible) with a reason code (§13 R2). |
| 3 | Studio #26 and later is offered **Regular pricing automatically** once the verified eligibility system and the approved Regular checkout exist. | **DECIDED** | Defines the end state; see sequencing in §14 (not before both exist). A switch must never be silent (§13 R5). |
| 4 | All eligible new studios, **including Regular subscribers, keep the standard 30-day free trial**, subject to anti-abuse controls. | **DECIDED** (trial retained); anti-abuse design **OPEN** | Narrows D6: trial applies to Regular too; the one-trial-per-studio/customer/owner controls and the persisted trial-used marker are still to be designed (§13 R6). |
| 5 | **Regular monthly may launch before annual.** Annual prices and discounts need separate approval. | **DECIDED** | Removes annual from the critical path of D11; slice S5 remains separate (§7). S0 (refuse unguarded annual checkout) stays recommended. |
| 6 | If the cap is reached before Regular checkout is safely available: a polite **"Founder positions are currently filled"** message with a contact path; **no Founder overflow and no broken checkout**. | **DECIDED** | The refusal path ships **with** the enforcement slice, never after it (§13 R4). Existing contact path: `mailto:support@idanceflow.com` (footer, Terms; claims-guard tested). Showing the message on a public page is a website change needing separate authorization. |
| 7 | **Released, uncommitted Founder positions may return to the pool.** Studios already enrolled at Regular are **not** automatically converted to Founder when a position frees up. | **DECIDED** | Resolves the "freed position" question and part of D4: only reserved/trial-hold positions released before the first paid invoice return; committed positions follow D4 (void by admin only). No Regular-to-Founder migration job (§13 R7). |
| 8 | Founder and Regular **coexist through studio-specific eligibility, not a single global switch.** | **DECIDED** | Replaces the global Founder/Regular selection in checkout and the global price display (§13 R3, §14). |
| 9 | The grandfathered **$129 Pro** subscription stays protected and **occupies one of the 25 positions.** | **DECIDED** | Matches §4; position 1 is a `grandfathered` ledger row (§13 R8). |
| 10 | **No live remaining-position count is published** until the allocation ledger and the **existing-subscription reconciliation are verified.** | **DECIDED** | Public count is behind its own default-off gate that requires recorded reconciliation evidence (§13 R9). The live copy makes no count claim today. |
| 11 | **R11 confirmed:** Organizer Suite subscriptions do **not** count toward the 25 Studio Founder positions. The cap applies only to qualifying Starter, Growth and Pro studio subscriptions. Organizer promotional eligibility is **tracked separately**, and existing Organizer subscriptions are **not changed** by this decision. | **DECIDED** | Closes the open point in §13 R11. Any future Organizer promotional allocation needs its own ledger/policy; nothing in this report touches Organizer pricing. |
| 12 | **D17 direction:** read-only monitoring and reconciliation. (a) Reconcile existing Founder subscriptions, including trialing and grandfathered ones, using **authorized read-only access**; (b) monitor occupied and potentially reserved positions **daily while the Founder advertising campaign is active**; (c) **18 occupied positions is an escalation threshold, not authorization for an automatic stop-sell**; (d) no numerical remaining-position claim until the evidence is reconciled; (e) **no archiving of Stripe Prices, no disabling of Founder pricing, no change to live checkout** without separate authorization. | **DECIDED** (direction); procedure in §15; access **BLOCKED** (no authorized read-only access exists yet) | Replaces the stop-sell options in D17 with monitoring only. The stop-sell levers (archiving Prices, the env flag) remain available **only** by a separate owner authorization. |
| 13 | **D13 = option H.** Twelve qualifying paid monthly subscription periods at the Founder price, beginning after the initial free trial; an **18-calendar-month maximum promotional window** measured from the first paid period; **count distinct paid service periods, not raw invoice events** (prorations, retries, credits, add-ons and plan changes must not create duplicate qualifying months); define the effect of partial periods, payment recovery, pauses and cancellation/reactivation; the **grandfathered $129 Pro subscription is permanently excluded** from the expiration mechanism; advance notice of the Regular price and transition date at **60, 30 and 7 days (subject to final D15 approval)**; if the approved Regular price or transition configuration is unavailable, **fail safely, notify the owner, and neither silently reprice nor cancel**; customer-facing terms must disclose **both** the twelve-paid-month benefit **and** the 18-month maximum. | **DECIDED** (direction); qualifying-period rules defined in §16.3 for owner confirmation together with D5/D8/D16; notice cadence subject to D15 | Resolves D13; adds requirements R13–R15 (§13); updates the entitlement record fields (§8). |

**Decision table status after 2026-10-25:** D11 **DECIDED** (items 3, 6, 8 above). D12 **DECIDED**. **D13 DECIDED as option H** (item 13). **D17 DECIDED** as a read-only monitoring and reconciliation direction (item 12; §15). R11 **DECIDED** (item 11). D6 **PARTIAL** (trial retained for all; anti-abuse open). D4 **PARTIAL**. D18 **PARTIAL**. **Presented for decision now: D1, D2 (recommendation revised), D3** (§16.4). **Still open after those:** D5, D7–D10, D14–D16, D19, D20 (grouped with recommendations in §16.2). Until the ledger exists the cap stays unenforced and no scarcity or count claim may be published (item 10).

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

**Recommended per-studio Founder entitlement record** (not implemented; for the design slice). Table `studio_founder_entitlements`: `studio_id` (unique), `kind` (`founder_new`/`founder_grandfathered`), `position` (1–25, unique where active), `status` (`reserved`/`trial_hold`/`committed`/`released`/`expired`/`voided`), `original_plan_code`, `stripe_customer_id`, `stripe_checkout_session_id`, `stripe_subscription_id`, `current_price_id`, `reserved_at`, `reservation_expires_at`, `trial_end`, `first_paid_invoice_id`, `first_paid_period_start`, `qualifying_period_count` (**distinct paid periods, never raw invoices**; derived from a per-period table keyed by subscription and period start), `expected_promo_end`, `backstop_end`, `notice_state` (jsonb: sent timestamps), `transition_state` (`pending`/`blocked`/`done`/`n_a`), `eligibility_evidence` (jsonb), `created_at/updated_at`. Plus append-only `studio_founder_entitlement_events` (event type, actor, Stripe event id, before/after digest, reason). RLS: staff may read their own studio's row; writes service-role only, matching `studio_subscriptions` hardening. Creation, conversion, commit, release, void and seeding are `SECURITY DEFINER`, service-role-only RPCs; capacity enforced under `pg_advisory_xact_lock` as in ENT-1. Stripe remains the billing source of truth; this table is the **application-level** source of truth for eligibility, position and promotional state (Stripe alone does not hold them).

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

> **Update 2026-10-25:** the D11 decisions refine the slices: S2 must include the safe refusal and confirmation states (R4/R5) and the trial controls (R6); S3 includes pool return (R7); S6 may not publish a count until R9; S8 precedes turning enforcement on. See §13 and §14.4 for the updated, dependency-ordered sequence.


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

## 13. Implementation requirements for the approved D11 policy

> Requirement IDs R1–R12 in this section are distinct from the risk IDs R1–R14 in §10.

Requirements derived from §6A. None is implemented. "Dark" means shipped disabled behind a default-off gate.

| ID | Requirement | Why (decision) |
|---|---|---|
| R1 | **Regular activation stays a separate gate.** `REGULAR_PRICING_ACTIVATED` plus a non-empty `REGULAR_PRICING_APPROVAL_REF` remain required to **sell** Regular; the new behavior must stop coupling activation to the end of Founder (today activating Regular also requires `FOUNDER_PRICING_ACTIVE=false`, PRICING-P1.md). Rate approval (decision 1) is not the approval reference. | 1, 8 |
| R2 | **Per-studio, auditable eligibility decision.** On every studio checkout attempt the ledger returns one of: `founder_reserved`, `regular_offered`, `refused_founder_full`, `refused_ineligible` (+ reason code), recorded append-only with studio, plan, idempotency key, Stripe session id and the flags in force. | 2 |
| R3 | **No global switch decides a studio's price.** Selection becomes: ledger reservation succeeds → Founder Price; else if Regular is activated → Regular Price (after the confirmation in R5); else refuse with R4. `FOUNDER_PRICING_ACTIVE` is kept only as a global **kill switch** (off = no new Founder reservations). | 8, 3 |
| R4 | **Safe refusal.** When the cap is full and Regular checkout is not enabled, checkout returns a customer-safe "Founder positions are currently filled" state with the contact path and **creates no Stripe session**; it never surfaces `missing_price_id`/`price_mismatch` for this case, and never lets Founder overflow. | 6 |
| R5 | **No silent price swap.** A studio that clicked "Start Starter Trial" at the Founder price and is routed to Regular sees the Regular price and renewal terms on a confirmation step **before** Stripe, and must confirm; the amount shown equals the amount on the Checkout Session. | 3 (and the policy requirement that the renewal price is disclosed before checkout) |
| R6 | **Trial and anti-abuse.** The 30-day trial applies to Founder and Regular alike; a persisted trial-used marker per studio and per Stripe customer (and a per-owner-user rule) prevents repeat trials; no new trial on return after any paid invoice. Detailed signals (for example the card fingerprint from Stripe) are a design choice for slice S2 with owner approval. | 4 |
| R7 | **Pool return rules.** A position released before the first paid invoice returns to the pool and may be reserved by the next eligible studio. A studio already on Regular is **never** auto-converted to Founder; no job or admin default converts. Whether a refused or waiting studio is told when a position frees is a communications choice, not required. | 7 |
| R8 | **Grandfathered row.** One `grandfathered` ledger row (position 1) for the $129 studio, seeded once by an approved operation after Stripe verification; immutable except via an audited platform-admin RPC; excluded from the 12-month schedule and from automatic Regular transition. | 9 |
| R9 | **Count publication gate.** A separate default-off `FOUNDER_COUNT_PUBLIC` gate; it may only be enabled when the ledger records a completed, reviewed **reconciliation** of existing Founder-priced subscriptions against Stripe (run id, time, discrepancies resolved). Until then no page shows, and no message implies, a remaining count or scarcity. | 10 |
| R10 | **Kill switch and rollout flag.** A dark `FOUNDER_ALLOCATION_ENFORCED` flag (default off) so enforcement can ship dark, be exercised in test mode, and be turned on per environment; with it off the current behavior is unchanged. | 2, 6 |
| R11 | **Studio plans only (CONFIRMED by the owner 2026-10-25).** The 25-cap and ledger apply only to qualifying Starter, Growth and Pro studio subscriptions. Organizer plan and Organizer Suite add-on pricing share `isFounderPricingActive()` today (`get-started/organizer/page.tsx`, `addons/organizer-suite/checkout/route.ts`) and **do not count toward the 25**; Organizer promotional eligibility is tracked separately (separate policy and, if needed, a separate ledger); existing Organizer subscriptions are not changed. The studio ledger must therefore key on **studio plan Price ids only** and never read Organizer Prices. | 2, owner R11 |
| R12 | **Per-studio display.** Public pricing pages show Founder price with the Regular price disclosed (while positions last or per policy copy); the studio's own billing and completion pages show the price the studio is actually entitled to from the ledger, not a global display function. | 8, 5 |
| R13 | **Customer-facing terms disclose both limits** (D13). Before the payment method is collected and in the Terms: Founder pricing applies to the first **twelve qualifying paid monthly periods** after the 30-day trial and ends **no later than eighteen months after the first paid period**; pauses, failed payments and cancellations do not extend the 18-month limit; the Regular price ($89/$149/$249) applies afterward; notices are sent at 60, 30 and 7 days (subject to D15). Counsel review (D19); the public copy change needs separate authorization; the claims guards and roadmap change together. | 13 |
| R14 | **Qualifying-period counter.** The Founder counter equals the number of **distinct** qualifying periods for the studio (keyed by subscription id and period start), computed idempotently so replayed, retried or out-of-order events cannot double count; rules per §16.3; the 18-month backstop is evaluated at Stripe period boundaries. | 13 |
| R15 | **Fail-safe transition with owner alert.** If Regular activation, its approval reference, the studio's Regular Price id or the transition configuration is unavailable, record `transition_blocked`, notify the owner (platform alert and email), leave the subscription **unchanged** (never reprice, never cancel), retry daily, audit every attempt; customer notices never state a price change that has not happened. The grandfathered row is excluded unconditionally. | 13 |

## 14. Exact code and release dependencies

### 14.1 Code touchpoints (all paths on `origin/main` and the deployed branch unless noted)

| Area | File and symbol | Change required |
|---|---|---|
| Offer selection | `src/app/api/billing/checkout/route.ts` `resolveCheckoutPriceId` (~60-125), call at ~455 | Synchronous, flag-driven selection becomes an **async, ledger-driven** decision (R2/R3); the legacy non-studio branch (organizer, annual) stays isolated. |
| Pure selector | `src/lib/billing/studioCheckoutPricing.ts` `selectStudioMonthlyPrice` (params `founderActive/regularActivated`) | Takes the ledger outcome instead of global flags; returns Founder or Regular Price id + expected amount; no fallback between them. **Also used by** `src/lib/billing-qa/priceVerifier.ts:188` (BILLING-QA #332 on main) which verifies one price per plan from global flags: it must verify **both** Founder and Regular Prices. |
| Regular gate | `src/lib/billing/regularPricing.ts` `isRegularPricingActivated`, `resolveRegularMonthlyCents` | Keep as the activation gate (R1); split "may disclose Regular" from "may sell Regular". `plans.ts` `provisionalRegularAmountMonthlyCents` (8900/14900/24900) is promoted to the final Regular amount with comments and tests updated (decision 1); display is no longer gated on activation. |
| Founder flag | `src/lib/billing/founderPricing.ts` `isFounderPricingActive` / `isFounderPricingActiveIn`, `resolveDisplayedMonthlyPriceCents`, `resolveReferenceRegularPriceCents`, `resolveTransparentPricingNote` | Global display functions stop being the source of truth for a studio's price; keep the flag as a kill switch. Callers: `get-started/studio/page.tsx` (~45, 201-211), `get-started/complete/page.tsx:189`, `app/settings/billing/page.tsx` (~1051, 1067, 1110), `for-studios/for-instructors/for-organizers/page.tsx`, `app/page.tsx:134` (home copy builder). |
| New-studio entry | `src/app/get-started/actions.ts` `startPaidPathAction` (~505-616) and the redirect to `/api/billing/checkout` (~86) | Carries the refusal/confirmation states (R4/R5) back to a safe page; no new global state. |
| Refusal and confirmation copy | `get-started/studio/page.tsx`, `settings/billing/page.tsx` error map (~389: `missing_price_id`, `price_mismatch`) | New states `founder_full` and `regular_offer_confirm`. **Public copy change: separate authorization.** Claims guards must be updated with the roadmap: `src/lib/public/__tests__/homeCopy.br4a.test.ts`, `launchQa.br4d.test.ts` (footer `mailto:support@idanceflow.com`); copy builders `src/lib/public/homeCopy.ts` (`buildTrialLine` ~257-273), `audienceCopy.ts`; Terms §5 (`src/app/terms/page.tsx` ~116-126). |
| Session creation | checkout route ~600-635 (metadata, `trial_period_days`, `allow_promotion_codes: true` at 626) | Add reservation id and decision to metadata; set Stripe session `expires_at` (minimum 30 minutes); stop promotion-code stacking on Founder sessions; prior-trial check (R6). |
| Webhook lifecycle | `src/app/api/payments/webhook/route.ts`: `upsertStudioSubscription` (~874-1060), `syncStudioBillingSnapshot` (~718-749), event switch (~3339-3610: `checkout.session.completed`, `checkout.session.expired`, `customer.subscription.*`, `invoice.paid`, `invoice.payment_failed`) | Reservation conversion (trial hold), first-paid-invoice commit, release on expiry/cancel/failure, studio `checkout.session.expired` handling (currently event-commerce only), record offer type and Price id; Regular subscribers must resolve through the `..._STANDARD` env map. |
| Plan resolution | `src/lib/billing/subscriptionPlanResolution.ts` | Already maps `_FOUNDER`, `_STANDARD` and `_FOUNDER_LEGACY` to a plan code; the Regular Price ids must be present in `STRIPE_PRICE_STUDIO_*_STANDARD`. Founder vs Regular must then be distinguished by the **ledger/offer type**, not the plan code. |
| DB (new) | new migrations: `studio_founder_entitlements`, `studio_founder_entitlement_events` (+ offer-decision events), RPCs reserve / convert / commit / release / expire-sweep / void / seed-grandfathered, trial-used marker, reconciliation record; RLS and guard triggers | See §8 and R2/R8/R9. Pattern: ENT-1 `20261013090000_ent1_usage_allowance_reservations.sql` (advisory lock, idempotent reserve/settle, service-role-only grants). |
| Platform admin | `src/app/platform/billing/page.tsx` (displays overrides only), `platform_admin_actions` | Read-only ledger/capacity view and an audited void/seed action (admin-gated, AAL2 per the existing platform-admin pattern). |
| Cron | `vercel.json` crons | New reservation-expiry sweeper and (later) notice job; notice copy needs approval. |
| Tests | local-stack PG (`src/lib/billing/__tests__/localStack.*.test.ts`, `localStackLock.ts`), `src/lib/payments/__tests__/ownershipFakes.ts`, `e2e/helpers/studioSubscriptionFixture.ts` and `stripeTestModeFixture.ts`, `src/lib/billing-qa/report.ts` | Reuse; do not create a competing framework. Update the pinned yearly test (`founderPriceGuard.pricingp1.test.ts:181`) with S0. |

### 14.2 Open PRs and ordering dependencies

| Dependency | Detail |
|---|---|
| **#334 then #335** (BILLING-QA-2/3, drafts) | The lifecycle slice needs #335's webhook fixes (re-fetch current subscription for ordering, `trial_ends_at` sync, `billing_plan` sync, unowned-subscription acknowledgement) and #334's Stripe-test-mode fixtures. Owner decides whether to merge or rebase them first. |
| **#292 (CI-D refunds) vs #335** | Both edit `payments/webhook/route.ts` and `ownershipFakes.ts`; sequence them to avoid conflicts. #337 and #342 list billing files only because their stacked Competition bases predate PRICING-P1 (diff artifacts, no real edit). |
| **#336 then #340** (BILLING-QA-4/5, drafts) | Both edit `priceVerifier.ts`, `report.ts`, `docs/qa/billing-qa.md`; the price-config report and the session read-back must be updated for coexisting Founder and Regular Prices. |
| **#332 (merged)** | `priceVerifier.ts` follows the global-flag selector; update with the selector change. |
| **Production is not `main`** | Production runs `release/pricing-p1` (`4bc938c6`), not an ancestor of `main`. Any release of this work is again an isolated branch off the deployed base with cherry-picks (the webhook import-block conflict recurs), never a `main` promotion. |
| **Migration timestamps** | Latest on `main` is the TW-4F series (`2026123009xxxx`); `20261231090000` and `20261231100000` are reserved (TW-4F tracker) and Competition has its own block (`2027010x` and slots 0110/0111/0112). Founder migrations need a **newly reserved block** recorded in the shared registry before authoring (proposal: `202702xx090000`; confirm with the TW-4F and Competition coordinators). |
| **SQL before app** | Per the established rule, a Founder migration is applied to PROD (separate approval, fresh scratch workdir, preflight) **before** the application that calls it; the app ships dark. |
| **DB test resources** | Local-stack PG runs and `npm install` follow the owner's resource rules: at most two isolated DB runs at once, check free disk (pause below 15 GB), and ask the Competition coordinator session for a slot first. |

### 14.3 Release dependencies (each hosted step needs its own authorization)

| Dependency | Needed before | Evidence/approval |
|---|---|---|
| Development authorization for each slice | any implementation | owner |
| Stripe read of existing Founder-priced subscriptions (all three new Prices, old Founder Prices, the $129 Price) and open Checkout Sessions | reconciliation, seeding, any count | owner Dashboard or restricted read key |
| Identification of the $129 studio and its subscription metadata (source, studioId) | seeding position 1 | owner; then a hosted DB write (approval) |
| Regular Prices verified (IDs preserved, $89/$149/$249, USD, monthly, live) | Regular activation | owner checklist evidence still pending in the PRICING-P1 runbook |
| `STRIPE_PRICE_STUDIO_{STARTER,GROWTH,PRO}_STANDARD` Production values equal to the Regular Price ids (currently a shared Production+Preview locked entry, unverified) | Regular checkout | Production-only env entries via the split procedure used for the Founder variables; env changes reach new builds only |
| `REGULAR_PRICING_APPROVAL_REF` value and the decision to set `REGULAR_PRICING_ACTIVATED` | Regular checkout | owner (separate from rate approval) |
| New gates `FOUNDER_ALLOCATION_ENFORCED` and `FOUNDER_COUNT_PUBLIC` (default off) | rollout | owner; Production env change |
| Stripe portal configuration: which Prices are listed, plan switching, cancel/pause; promotion codes in live mode | any change that depends on portal behavior | owner Dashboard (unread) |
| Stripe Checkout Session `expires_at` behavior with archived/inactive Prices and open sessions | reservation TTL design | Stripe test-mode proof in the design slice |
| Website/copy authorization (refusal message, Regular disclosure, "12 paid months", approved headline, later the count) and Terms/checkout consent wording | any public change | owner + legal; claims-guard and roadmap updated together |
| Reconciliation verified | publishing any remaining-position count (decision 10) | recorded in the ledger |
| Staged build + smoke test + promotion from an isolated release branch | production | owner, per the PRICING-P1 pattern |

### 14.4 Dependency-ordered sequence (updated for the 2026-10-25 decisions)

1. **S0** (optional, independent): refuse new studio annual checkouts until a gate exists.
2. **Owner decisions** still open (D1–D3, D5, D7–D10, D13–D17, D19, D20) and the R11 confirmation.
3. **S1** ledger, RPCs, audit and offer-decision events, dark, tested on local-stack PG (1–25, 26 refused, concurrent last position, idempotency, grandfather immutability, tenant isolation).
4. **S2 + S3** checkout reservation, safe refusal with the contact path (R4), confirmation step (R5), trial/anti-abuse (R6), webhook lifecycle and pool return (R7); built dark behind `FOUNDER_ALLOCATION_ENFORCED` on top of #334/#335; tests on the existing Stripe test-mode and local-DB harness.
5. **Release of the dark build and the migration** (SQL first, then application) from an isolated branch.
6. **S8**: Stripe reconciliation and one-time seeding of position 1 (and any other existing Founder positions), recorded as verified reconciliation.
7. **Turn enforcement on** (flag) in the same change window as the polite refusal path. If Regular is approved and its Prices/env are verified, enable Regular for position 26+ (R3/R5) in a separate, explicitly approved step; otherwise position 26+ sees the refusal message.
8. **S6** copy and disclosure changes (website authorization), **without a count** until R9 is satisfied; then the count gate may be enabled.
9. **S4** duration, notices and the fail-safe transition; **S5** annual (after separate approval); **S7** early access.

## 15. D17: read-only monitoring and reconciliation procedure

Authority: owner direction of 2026-10-25 (§6A item 12). **Read-only. No archive of Stripe Prices, no change to `FOUNDER_PRICING_ACTIVE`, no change to live checkout, no database write, no publication of a count.** Crossing the threshold escalates to the owner; it does not trigger any automatic action.

### 15.1 Access status

| Item | Status |
|---|---|
| Authorized read-only access to the DanceFlow live Stripe account for the assistant | **BLOCKED / not available.** The assistant has no DanceFlow live credential (the only live key on the workstation belongs to a different business and is never used). Counts therefore **cannot be produced by the assistant today** and none are stated in this report. |
| Owner-run Dashboard reads (no secrets leave the Dashboard) | **Available now.** Steps below. |
| Restricted read-only key (owner-created, **never pasted in chat or committed**) | **Optional, needs a development authorization** for a read-only reconciliation script (the existing BILLING-QA tooling accepts restricted `rk_live_` keys from a local untracked file; permissions needed: Subscriptions, Prices, Customers (without email export), Checkout Sessions and Events, all Read). Not built or authorized. |
| Read-only application database access (studio rows, subscription rows) | **Not authorized**; would need explicit approval and a scratch workdir. |

### 15.2 Definitions used until the ledger exists

A **position holder** is one **studio** (not one subscription), identified by the `studioId` written into checkout session and subscription metadata, deduplicated across subscriptions and customers. Organizer Prices are excluded (§13 R11). Internal/test/comp studios are excluded by an owner-maintained list.

| Tally | Includes | Used for |
|---|---|---|
| **A: occupied** | distinct studios with a subscription **not canceled** (statuses trialing, active, past_due, unpaid, paused) on a Founder Price: the three new Founder Prices, any older Founder Price still in use, and the grandfathered $129 Price. **Includes trialing and the grandfathered studio.** | the **18-position escalation threshold** |
| **B: potentially reserved** (reported next to A, no threshold is set for it by the owner) | A, **plus** studios whose Founder subscription is `incomplete`, **plus** studios with an **open, unexpired Checkout Session** on a Founder Price (created within the session lifetime), **plus** (for information) studios that canceled after at least one paid invoice on a Founder Price | to see how close the cap could be if pending checkouts convert; not an allocation |

Founder Price ids to read: Starter `price_1TdDHBEY0sTayNiS0G2Ed9oI`, Growth `price_1UUG7uEY0sTayNiSh0d9cCL8`, Pro `price_1UUG4UEY0sTayNiSClLL4J0R`, grandfathered `price_1TdDHwEY0sTayNiSIe1nD3Lg`; plus the **old Growth Founder Price** (the object replaced by the new Growth Price; owner to supply its id) and any other earlier Founder Price (owner to confirm there are none). The Starter ID is the same object as before the $59 edit, so earlier Starter subscribers (if any) appear under it.

### 15.3 Owner-run read-only steps (Stripe Dashboard, Live mode)

1. **Subscriptions by Price.** Subscriptions → filter by **Price** → one Founder Price at a time → include **all statuses**. For each row record: subscription id, customer id, status, created, trial end, current period end, and the `studioId` / `source` / `offerType` metadata (subscription page → Metadata). Do not export or share customer emails.
2. **Deduplicate by studio** (metadata `studioId`); flag any subscription with **no** metadata (created outside checkout) and any studio with more than one Founder subscription.
3. **Open Checkout Sessions.** Developers → Events → filter `checkout.session.created` for the last 24 hours, minus those with a matching `checkout.session.completed` or `checkout.session.expired`; keep sessions whose line item is a Founder Price. (A restricted read key could list sessions with status `open` directly.)
4. **Exclusions.** Remove Organizer subscriptions and the owner-listed internal/test studios; keep the grandfathered studio (it counts).
5. **Record** the result in the log below and send the owner the table (IDs only, no secrets or emails).

### 15.4 Daily log (while the Founder advertising campaign is active)

| Date (ET) | Tally A (occupied) | of which trialing / active / past due | Tally B (A + pending) | Open sessions | New since last check | Anomalies (no metadata, duplicate studio, test studio) | Checked by |
|---|---|---|---|---|---|---|---|
| _(pending)_ | _no value exists until authorized read-only access produces one_ | | | | | | |

Cadence: daily while the campaign is active, weekly otherwise. The log lives where the owner chooses (not in Git unless the owner asks; it contains counts, no personal data).

### 15.5 Threshold and escalation

- **18 occupied (Tally A ≥ 18):** same-day escalation to the owner with the table and Tally B. **This is not authorization to stop selling.** The owner then chooses among: continue monitoring; pause or adjust the advertising campaign (outside Stripe); accelerate the ledger slices; or separately authorize a stop-sell lever (archiving the three new Founder Prices in the Dashboard, which the current checkout treats as a customer-safe refusal; or the env flag, which needs a new build and misleads pages).
- **Below 18:** no action; keep logging.
- **Any anomaly** (a subscription without `studioId`, a duplicate studio, a Founder Price on a non-studio subscription, a Founder-priced subscription for an internal/test studio): report it the same day.
- **Nothing is published**: no page, email or advertisement states a remaining-position number until the reconciliation (15.6) is complete and verified and the ledger gates in §13 R9 are satisfied. The live pages make no count claim today.

### 15.6 One-time reconciliation of existing Founder subscriptions

Purpose: establish the true starting occupancy, find stragglers, and produce the evidence needed to seed the ledger (slice S8) later. Output table (one row per studio): studio id, plan, Founder Price id, subscription id, status, trial end, first paid invoice date (or none), source (checkout metadata or manual), notes. Includes **trialing** and **grandfathered** subscriptions. Exceptions list: no metadata, duplicate studios, test/internal studios, Founder-priced Organizer subscriptions (excluded), subscriptions whose studio cannot be resolved. The reconciliation is **read-only**; any correction (seeding, voiding) is a later, separately authorized operation.

## 16. Remaining Founder decisions, by group, and the duration definition

### 16.1 Duration: twelve paid invoices versus twelve calendar months after trial completion

This comes **before** any expiration enforcement because it fixes what the enforcement counts. Definitions:
- **P: twelve paid periods.** The window ends after the 12th successfully **paid** monthly billing period at a Founder Price. The counter increments once per `(subscription, period_start)` for a renewal-cycle invoice that carries the Founder plan line and is paid with a non-zero amount; refunded or lost-dispute payments un-count; proration, add-on and one-off invoices never count.
- **C: twelve calendar months after trial completion.** The window is trial end through trial end + 12 months, independent of payments, ending at the Stripe billing-period boundary at or after that date.
- **H (recommended): P with a calendar backstop.** Founder pricing ends at the earlier of the 12th paid period or **18 calendar months after the first paid period**.

In the normal case (every month paid on time, no pause, no cancellation) **P, C and H give the identical boundary**: the 13th invoice, one year after the first paid period, is the first at Regular. They differ only when service is interrupted or the invoice stream is unusual:

| Dimension | P (12 paid periods) | C (12 calendar months) | Note |
|---|---|---|---|
| Late payment recovered within Stripe's retries | counts when paid; boundary unchanged if counted by period, not by payment date | unchanged | both fine if P keys on the billing period |
| Missed month, then canceled | the unpaid month does not count | the month is consumed | P matches "paid months"; C erodes the window |
| Pause or skipped months | window extends in calendar time (customer keeps Founder pricing longer) | window passes during the pause | **P can be stretched indefinitely without a backstop** |
| Cancel and return inside the window | remaining paid periods resume | remaining calendar time (possibly none) | ties to D5 |
| Plan change, proration, add-ons | **risk**: must classify invoices (only renewal-cycle invoices carrying the Founder plan line count) or a proration invoice double-counts | unaffected | the main integrity risk of P |
| $0 invoices (credits, 100% coupons), refunds, disputes | need explicit rules (recommend: $0 period does not count; reversed payment un-counts) | unaffected | |
| Date arithmetic | none (period sequence) | end-of-month, leap-year and time-zone cases; mitigate by anchoring to Stripe period boundaries | C is more error-prone if computed from dates |
| Stripe-native support | none ("after N paid invoices" does not exist); application-driven | a Subscription Schedule phase of 12 billing cycles is close to C; portal and schedule interplay unverified | |
| Transition trigger | **event-driven**: on the 12th counted payment, move the item to the Regular Price with no proration so the 13th invoice is Regular | scheduled job or schedule near the end of period 12 | P has no clock dependency; C needs a reliable timer |
| Customer messaging | "your first 12 monthly payments" (the approved wording); calendar date can move after a pause or failure | a fixed end date can be shown at signup | notices must be recomputed under P |
| Abuse and cap integrity | needs the backstop (H) because committed positions are never recycled | bounded by construction | |
| Fit with the approved policy text ("12 **paid** months") | literal | approximate; differs when interrupted | C would need a copy change to "12 months" |
| Test burden | more scenarios (invoice classification, replay, out-of-order) but deterministic with period keys | fewer, plus boundary-date cases | |

**Recommendation: H.** It is faithful to the approved "12 paid months", needs no date arithmetic for the count, keeps the Founder window fair when payments fail, and removes the one real downside of P (an unbounded window) with a documented 18-month backstop. If you prefer maximum predictability over literal "paid months", C is the simpler alternative at the cost of changing the public wording and penalising customers for interruptions.

> **OWNER DECISION 2026-10-25: option H approved** (see §6A item 13). The enforcement paragraph below is the proposal refined by §16.3 and R13–R15.

**Expiration enforcement proposed on H (for the design slice; not implemented):** the entitlement stores `first_paid_period_start`, `paid_period_count` and `backstop_end`. When the counter reaches 12 (or the backstop date passes), a transition moves the subscription item to the studio's Regular Price with **no proration** and the billing anchor unchanged, so only the next invoice changes. **It fails safe:** if Regular activation, its approval reference or the Regular Price configuration is absent, it records `transition_blocked`, alerts the owner and **leaves the subscription unchanged** (never cancels, never silently reprices, never charges an unapproved amount), then retries daily. The grandfathered row is excluded unconditionally. Notices at 60, 30 and 7 days before the projected end are recomputed whenever the projection moves.

### 16.2 Remaining decisions, grouped, with recommendations

**Group 1: position lifecycle and allocation integrity**

| ID | Decision | Recommendation | Subscription integrity | Customer experience |
|---|---|---|---|---|
| D1 | When a position is **committed** | at the **first successful paid invoice** | cancelers in the trial never consume a position permanently; the cap counts real paying studios | studios that cancel in trial lose nothing |
| D2 | What holds a position between checkout and first payment | **revised:** a trial hold that **follows the Stripe subscription** until the first paid period or a terminal end (§16.4) | the cap cannot be exceeded by a Founder-priced subscription that Stripe can still collect | the price promised at checkout is guaranteed through the trial and normal payment retries |
| D3 | Checkout reservation lifetime | reserve before creating the session; session `expires_at` and reservation expire together, **60 minutes** (Stripe minimum 30) | abandoned checkouts return the position quickly, released by webhook and sweeper | a studio that returns after an hour re-checks eligibility |
| D4 (remainder) | Voiding a **committed** position | platform admin only, with a required reason (fraud, duplicate, internal/test), audited | positions are never recycled by churn | none |
| D8 | Failed payment | keep the position through Stripe's retry schedule; if the subscription is canceled **before any paid invoice**, release; after paid periods, the position stays committed and the counter counts only paid periods | no free-riding on failed payments; no loss of committed positions on a late payment | normal dunning emails; no surprise price change |
| D9 | Eligibility and duplicate rules | one Founder entitlement per studio, per Stripe customer and per verified owner user; evidence stored; any heavier verification (EIN, domain matching) is your call | stops duplicate studios taking several positions | minimal friction; extra checks only on suspicion |
| D10 | Internal, test, comp, ambassador studios | explicitly excluded by a platform-set flag checked inside the reservation function | cannot consume a position even if they later check out | none |

**Group 2: entitlement rules during the Founder period**

| ID | Decision | Recommendation | Subscription integrity | Customer experience |
|---|---|---|---|---|
| D13 | Definition of "12 paid months" | **DECIDED: H** (§6A item 13, §16.3) | counter keyed by billing period; backstop bounds the window | wording matches the approved policy and discloses both limits |
| D5 | Cancel and return | inside the window: resume the remaining paid periods at the Founder Price with **no new trial**; outside it: Regular | prevents trial abuse and gaming the cap by cancelling | fair to a studio that pauses or has a gap |
| D7 | Plan change during the window | the Founder Price of the new tier applies; the counter and backstop do **not** reset; a switch to a Regular Price is not offered during the window. **Implication:** the Stripe portal configuration is account-wide, so if it lists Regular Prices a Founder studio could self-switch; plan changes for Founder studios should run through a DanceFlow-controlled flow with the portal listing no plan changes | the ledger stays consistent with the live Price | upgrades and downgrades keep the promotional treatment |
| D16 | Promotion codes | disable `allow_promotion_codes` on studio subscription sessions (or allowlist specific coupons); no stacking on Founder | prevents discount stacking and $0-month ambiguity in the counter | a visible, intentional promotions policy instead of an open code box |

**Group 3: transition and communications**

| ID | Decision | Recommendation | Subscription integrity | Customer experience |
|---|---|---|---|---|
| D14 | Transition mechanism | application-driven, event-triggered, fail-safe (§16.1); Stripe schedules stay an alternative only if a test-mode proof shows portal compatibility | no unapproved repricing; a missing Regular approval leaves the Founder price in place and alerts you | no surprise charge; if Regular cannot be applied the studio simply keeps the lower price until fixed |
| D15 | Notice cadence and channel | 60, 30 and 7 days before the projected end, by transactional email plus an in-app banner; the last notice states the Regular price and the monthly choice (annual only once approved) | notices are recomputed when the projection moves; every send is logged | plenty of time to decide; the price is never a surprise |
| D19 | Legal wording | counsel review of Terms and checkout consent: 12 paid months, Regular price, notice period, how to cancel, trial terms, shown **before** the payment method is collected | the consent text matches what the system enforces | clear terms at the moment of commitment |

**Group 4: operations and data**

| ID | Decision | Recommendation | Subscription integrity | Customer experience |
|---|---|---|---|---|
| D20 | Seeding the grandfathered position and any other existing Founder positions | only **after** the §15.6 reconciliation is verified, as a one-time audited operation approved separately (hosted database write) | the ledger starts from verified truth | none |
| New | Who runs the daily monitoring and where the log lives (§15) | owner or a delegate until the read-only script (if authorized) exists | counts come from authorized reads only | none |
| D18 | Annual | stays a separate financial approval; not on the Founder critical path | an unguarded annual path stays refused (S0) until approved | no annual option appears until it is safe |

Decisions I would settle first, in order: **D13 (H)**, then **D1/D2/D3** (they define the ledger states), then **D5/D7/D16**, then the communications group (D14/D15/D19). D8–D10 and D20 can follow with the ledger design.

### 16.3 D13 specification: what counts as a qualifying period

Defined for owner confirmation (together with D5, D8 and D16). "Period" means one monthly Stripe billing period of a subscription, identified by `(stripe_subscription_id, period_start)`. The counter is the number of **distinct qualifying periods** for the studio, across subscriptions; it is recomputed idempotently, never incremented per event.

| Topic | Rule | Why |
|---|---|---|
| What qualifies | a period qualifies when its **renewal-cycle invoice** carries the studio's **Founder plan line** at a Founder Price, has status **paid**, and the plan line's amount after discounts is **greater than zero**. Customer-balance application does not disqualify. Proration items, add-on items, one-off invoices and invoices created by a subscription update never qualify by themselves. | counts service months, not invoice events |
| First qualifying period and the clock | the first qualifying period is the first paid renewal-cycle invoice **after the trial**; its `period_start` is `first_paid_period_start` and starts the 18-month backstop. The trial never counts and never starts the clock. | matches "beginning after the initial free trial" |
| Partial periods | periods are counted whole or not at all. A mid-period plan change keeps the same period (it counts once, under that period's renewal invoice); later periods are billed at the Founder Price of the new tier. A **non-standard period** (billing-anchor change, trial extension, proration to a new anchor, a period shorter than a normal month) **does not qualify automatically** and is flagged for an audited platform-admin decision with a reason. Founder subscriptions should not have their anchor altered. | prevents duplicate or fractional months |
| Cancel at period end | the paid, active period counts; later periods do not exist | |
| Immediate cancellation with a full refund, or a lost dispute | the refunded or reversed period **un-counts** (recomputed); a partial refund does not | a reversed payment is not a paid month |
| Payment recovery (retries) | an invoice paid during Stripe's retry window qualifies **for its own period**, whenever it is paid; it creates no extra period. Several periods paid late and out of order are counted by period, so the result is order-independent. An invoice that ends **void or uncollectible** never qualifies. | idempotent under replay and delay |
| Credits, discounts, $0 invoices | a period whose Founder plan line nets to $0 (full discount, comp) **does not qualify**; promotion codes are disabled on Founder sessions (D16) so this arises only from an audited admin comp, which is recorded and does not count unless the admin marks it qualifying with a reason | no free months counted as paid |
| Add-ons | add-on items on the same subscription never create or change a qualifying period | |
| Pause (collection paused) | periods with no paid renewal invoice do not qualify; the **18-month backstop keeps running**; counting resumes when paid periods resume; notice projections are recomputed | pauses cannot extend the window past 18 months |
| Cancellation before any qualifying period | the position is released (D1/D2); there is no Founder entitlement; a later return is a new eligibility decision | uncommitted positions return to the pool (owner decision 7) |
| Cancellation after at least one qualifying period, then reactivation | the entitlement belongs to the **studio**, not the subscription. Reactivation inside the window (before the backstop and with fewer than 12 qualifying periods) **resumes the remaining qualifying periods at the Founder Price with no new trial** and the **same backstop date**; after either limit, Regular applies. *(Pending D5.)* | stops trial restarts and window resets |
| When the window ends | at the **earlier** of (a) the end of the 12th qualifying period or (b) the **last billing-period boundary on or before** first_paid_period_start + 18 calendar months (end-of-month clamped). The transition takes effect at that boundary, never mid-period, so the Terms' "no later than eighteen months" is always true. | |
| Grandfathered $129 studio | **permanently excluded**: no counter, no backstop, no notices, no transition; a database guard rejects setting those fields on a `grandfathered` row, and the transition job skips it unconditionally | owner decision 9 and D13 |
| Fail-safe | if the transition cannot be applied (R15), the subscription stays unchanged at the Founder Price, the owner is alerted, and nothing is cancelled or silently repriced | D13 |
| Notices | at 60, 30 and 7 days before the projected transition date (D15 pending); recomputed whenever the projection moves; each threshold sent at most once per projected date, with a correction notice if the date later moves materially | the customer never learns the date late |
| Admin override | any manual qualification or exclusion is an audited platform-admin action with a required reason | accountability |

### 16.4 D1, D2 and D3 presented for business decision

**What these three decide.** Position states are: **available** (not in the ledger), **reserved** (an open Checkout Session), **trial hold** (a Stripe subscription exists but nothing is paid yet), **committed** (the first qualifying paid period) and **released/expired** (not counted). Capacity counts reserved (unexpired) + trial hold + committed + the grandfathered row, so D1–D3 decide **who gets released and when**, not the size of the cap.

**D1: when is a position committed (no longer returnable to the pool)?**

| Option | How it works | Subscription integrity | Customer experience |
|---|---|---|---|
| **A (recommended): first qualifying paid period** | a studio that cancels or fails before the first paid invoice returns its position; once the first period is paid the position is committed | positions are consumed only by studios that actually paid; the 18-month clock and the commit start at the same event | trial-cancelers cost nobody a position |
| B: checkout completion (trial start) | the position is consumed when the trial starts | trial churn permanently shrinks the pool | simplest to explain, but a studio that cancels in the trial still "used" a position |
| C: trial end (first invoice created) | consumed when the first invoice is created, paid or not | a failed first payment still consumes a position | harsh on card failures |

Note: owner decision 7 (uncommitted positions may return) already points to A; B would make nearly every position committed from day one.

**D2: what holds a position between checkout completion and the first paid period? (recommendation revised)**

My earlier draft said the hold should expire at trial end + 3 days. On review that is **unsafe**: the Founder-priced subscription already exists in Stripe. If its first invoice fails and pays on a Stripe retry on day 5 or day 12, a fixed timeout would already have released the position, so the next studio could take it and there would be **26 Founder subscribers**. A position must follow the life of the subscription.

| Option | How it works | Subscription integrity | Customer experience |
|---|---|---|---|
| **A (recommended): the hold follows the subscription** | held while the subscription is trialing, incomplete or past due within Stripe's retry window; committed at the first paid period; released only when the subscription ends **terminally before any paid period** (canceled, unpaid, incomplete-expired) | never more than 25 Founder-priced subscriptions alive; the maximum hold equals the trial (30 days) plus Stripe's retry window (a Stripe setting I have **not** read) | a card that fails once is not punished; the price promised at checkout holds through normal retries |
| B: fixed expiry that also **cancels** the unpaid Founder subscription | hold ends at trial end + N days; if still unpaid the app cancels the subscription (no money has been taken) | consistent, still never over 25 | harsh: a short card problem ends the subscription and the position |
| C: fixed expiry that releases without cancelling (the earlier draft) | hold ends at trial end + 3 days; the subscription lives on | **rejected: can exceed 25** | |

Evidence needed for A: Stripe Dashboard → Settings → Billing → Subscriptions and emails → **Manage failed payments** (retry count/schedule and the final action: cancel or mark unpaid). That fixes the maximum hold.

**D3: reservation at checkout**

| Option | Detail | Integrity | Customer experience |
|---|---|---|---|
| 30 minutes (Stripe minimum) | fastest return of abandoned positions | tightest cap use | a studio doing 3-D Secure or slow card entry may time out |
| **60 minutes (recommended)** | session `expires_at` set explicitly to 60 minutes; the reservation lasts 5 minutes longer so a completion event in flight is not orphaned | abandoned checkouts return the position within about an hour | enough time to finish; an expired session can be restarted |
| 24 hours (Stripe default) | positions held all day by abandoners | a few open sessions can block studios near the cap | most forgiving, worst for the cap |

D3 sub-decisions I recommend (please confirm or change):
1. **Correctness does not depend on timers or webhooks:** capacity checks ignore reservations whose expiry has passed; the `checkout.session.expired` handler and a sweeper only tidy up.
2. **Per-owner limit and rate limit:** one active reservation per owner user (reused idempotently by studio and plan) and the existing rate limiter on checkout, so one account cannot hold several positions.
3. **Late completion after the reservation was lost:** if checkout completes after the reservation expired and the position has since been taken, **cancel the trialing subscription (no money has moved), tell the studio, and offer Regular** (once Regular is available). The alternative, honoring the Founder price anyway, would break "never more than 25" and is rejected.
4. **Studio returns after an hour:** a fresh eligibility decision is made; if the cap is now full they see the polite refusal (owner decision 6) or the Regular offer once available.

**What I need from you:** (1) D1: A, B or C. (2) D2: A or B (C is rejected). (3) D3: 30, 60 or 24 hours, and the three sub-decisions. (4) Evidence for D2-A: your Stripe failed-payment retry settings. **How they interact with D13:** the trial hold never counts toward the 12 paid periods or the 18-month backstop; both start at the first qualifying paid period.

## Standing non-claims

This report does not state that production enforces any Founder-cap, duration, renewal, annual or early-access rule: it does not. Existing documentation that implies "limited", "first 25" or "12 months" describes intent or copy, not behavior.
