# Founder Pricing Policy Gap Report

Status: **audit and plan only** (2026-10-25; D11, R11, D17, D13, D1–D3, O1–O7 and D5/D7/D16 owner direction recorded 2026-10-25, see §6A, §13, §14, §15 and §16). Nothing here is implemented, merged, deployed, applied to a database or created in Stripe.
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
occupied            = grandfathered + committed + trial_hold + reserved(reservation_expires_at > now)
                      + needs_reconciliation (alive Founder-priced subscription, counted conservatively)
available_to_new    = max(0, capacity - occupied)  -- never negative; refusal when 0; alert if occupied > capacity
released/expired/voided rows are not counted
```

Today: grandfathered = 1 (owner statement, unverified in Stripe); committed/trial_hold/reserved = **UNKNOWN**; so `available_to_new` is **UNKNOWN**. The "24" claim in marketing must come from this computation (a live read of the ledger), never from a constant. Seeding the ledger with already-existing Founder-priced subscriptions (if any) is a separate, approved, reconciled operation against Stripe.

## 6. Eligibility and allocation: decisions that need your approval

These are **recommendations, not approved rules.** Each lists the recommended default and the alternative.

| ID | Decision | Recommended default | Alternative / risk |
|---|---|---|---|
| D1 | When is a position **committed**? | **DECIDED 2026-10-25: option A.** Permanently committed at the studio's **first qualifying paid subscription period** after the trial (§16.3). Before that the studio holds a **provisional Founder allocation**; if its subscription terminates with no qualifying payment, the position returns to the pool. | (superseded options B and C) |
| D2 | What holds a position between checkout and first paid invoice? | **DECIDED 2026-10-25: option A, subscription-lifecycle hold.** A provisional position stays occupied for as long as the associated Founder-priced subscription could legitimately become paid, including Stripe's configured retry/recovery period; **no release merely because a fixed number of days has passed** while a recoverable Founder subscription is alive. First qualifying paid period → committed; **verified** terminal state with no qualifying paid period → released. **The maximum hold is not defined until the actual Stripe retry schedule and terminal action are read (§16.7).** | (superseded: fixed expiry with or without cancellation) |
| D3 | Temporary **reservation** at checkout | **DECIDED 2026-10-25: 60-minute reservations**, with the Stripe Checkout Session expiry aligned to the reservation (Stripe supports `expires_at` from 30 minutes to 24 hours; default 24 hours), a small bounded completion grace, expired reservations excluded from capacity regardless of cleanup timing, one active reservation per studio owner with the existing rate limiter, concurrency-safe and idempotent allocation (§16.5), and the late-completion safeguards (§16.6). | (superseded: 30 minutes, 24 hours) |
| D4 | Can a position be recycled? | Released/expired **before** the first paid invoice: yes. **Committed**: no, except an administrative **void** by a platform admin with a required reason (fraud, duplicate, internal/test) that is audited. | Never recycle (stricter) or recycle on cancellation (lets studios churn the cap). |
| D5 | Founder cancels and returns | **DECIDED 2026-10-25: A with safeguards** (§6A item 16). | (superseded: forfeit, restart) |
| D6 | Trial abuse | One free trial per studio (and per Stripe customer); no new trial on return after any paid invoice. | Needs a persisted trial-used marker (none exists today). |
| D7 | Plan change during the Founder period | **DECIDED 2026-10-25: A with safeguards** (DanceFlow-controlled, server-authorized workflow; §6A item 16). | (superseded: portal switching, no changes, upgrades only) |
| D8 | Failed payment | Past-due keeps the position; if Stripe ultimately cancels before any paid invoice → release; after paid invoices → remains committed, and the paid-month counter only counts successful invoices. | Define a dunning grace (recommend Stripe's configured retry schedule). |
| D9 | Eligibility and duplicate/fraud rules | One Founder entitlement per studio; per Stripe customer; per verified owner user; evidence stored with the entitlement (email-verified owner, studio name, optional business identifier). Anything beyond (EIN, domain matching) is your policy call. | Heavier verification slows signup. |
| D10 | Internal, test, comp and ambassador studios | Explicitly **excluded** from allocation (a platform-set flag checked inside the reservation function); test studios use Stripe test mode and never touch the live ledger. | Name or reason heuristics are not reliable. |
| D11 | What happens at position 26 while Regular is inactive? | **Blocker you must decide:** with the cap enforced and Regular pricing inactive, studio #26 cannot buy at all. Options: (a) activate Regular (separate approval) before the cap fills; (b) a waitlist page; (c) hold the cap open until Regular is approved. | Without this, enforcement creates a dead end. |
| D12 | Regular amounts final for disclosure? | Confirm $89/$149/$249 may be shown now. They are "provisional" in the code and docs; the new policy says they are the transition prices. | Displaying a provisional price is a public commitment. |
| D13 | Definition of "12 paid months" | **DECIDED 2026-10-25: option H.** Twelve qualifying paid monthly periods at a Founder Price after the trial, within an **18-calendar-month maximum window** from the first paid period; counts distinct paid service periods, never raw invoices. Rules in §16.3; the grandfathered studio is permanently excluded. | (superseded: raw per-invoice counter and calendar-only window) |
| D14 | Transition mechanism | Application-driven: entitlement record + notice schedule + a job that moves the subscription item to the Regular Price at the 13th billing period, **failing safe** (no change, alert, `transition_blocked` event) if Regular approval/config is absent. Stripe Subscription Schedules are the alternative; they conflict with portal-managed plan switching and need a test-mode proof before choosing. | A decision for the design slice, backed by a Stripe test-mode experiment. |
| D15 | Renewal notice cadence and channel | Recommend 60, 30 and 7 days before the Founder window ends, plus an in-app banner, via the existing transactional email pipeline; copy needs your approval. | Terms §5 only promises prospective changes "after notice" with no period. |
| D16 | Promotion codes | **Approved policy direction (pending Stripe evidence):** no unrestricted promotion-code entry on studio checkout; allowlisted coupons applied server-side only; preserve grandfathered or contractual discounts (§6A item 16, §16.11). | Leaving the box on is rejected. |
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
| 14 | **D1 = A, D2 = A, D3 = 60 minutes.** (D1) Permanent commitment at the first qualifying paid period; a provisional allocation before it that returns to the pool if the subscription terminates with no qualifying payment. (D2) The provisional position stays occupied while the Founder-priced subscription could legitimately become paid, including Stripe's retry/recovery period; no fixed-day release of a recoverable subscription; **no maximum hold defined until the Stripe retry schedule and terminal action are read.** (D3) 60-minute reservations aligned with the Checkout Session expiry (subject to Stripe's supported behavior), a small bounded completion grace, expired reservations excluded from capacity regardless of cleanup timing, one active reservation per studio owner plus the existing rate limiter, concurrency-safe and idempotent across retries, webhook replays, multiple tabs and simultaneous checkouts. **Late-completion safeguards:** if a session completes after its reservation is no longer valid — (1) verify the authoritative ledger state and the actual Stripe Session, subscription, invoice and payment state; (2) never allocate a 26th position; (3) never automatically cancel a subscription merely because webhook delivery was delayed; (4) if genuinely trialing and unpaid, use a controlled recovery or cancellation path with appropriate customer messaging; (5) if payment occurred or state is ambiguous, preserve evidence, prevent an unauthorized price transition and escalate for reconciliation; (6) offer approved Regular pricing only through a clear customer-facing confirmation, never by silently switching plans or prices. | **DECIDED**; state machine and safeguards specified in §16.5–§16.6; Stripe evidence **BLOCKED** (§16.7) | Resolves D1–D3; replaces the earlier "cancel the trialing subscription" suggestion for late completion; adds requirements R16–R22 (§13). |
| 15 | **O1–O7 owner direction.** **O2 approved:** a five-minute bounded checkout reconciliation grace; it never authorizes exceeding the 25-position cap, and the authoritative Stripe state and the ledger must agree before eligibility is confirmed. **O3 approved with safeguards:** when a Checkout Session completes after its valid reservation is lost, use a controlled exception workflow; **do not automatically cancel the subscription, pause collection, or silently change its price**; verify whether payment occurred, preserve evidence, and prevent unauthorized Founder entitlement. **O4 approved as a policy direction:** if payment has occurred while Founder capacity is exhausted, escalate for individual owner review with a documented remedy (a refund, or an explicitly accepted Regular offer where appropriate); never silently reprice, retain an improper charge or allocate position 26. **O5 approved:** reservation uniqueness is enforced with **verified studio identity and verified owner identity**, with protection against duplicates through additional accounts, tabs, retries and webhook replays; one email address is not assumed to be one studio. **O7 approved:** actionable exception alerts to the platform administrator and `support@idanceflow.com`; target owner review within **one business day**; no sensitive payment details in notifications; audit trail kept. **O1 deferred:** read-only evidence of the actual Stripe failed-payment retry policy, hard-decline handling and terminal subscription action is needed before any maximum provisional-hold rule is recommended. **O6 deferred:** the business requirement is an explicit customer-confirmed move from Founder to approved Regular pricing that preserves trial eligibility and avoids duplicate subscriptions; the exact Stripe subscription mutation must be proven in isolated test mode before approval. | **O2, O3, O4, O5, O7 DECIDED; O1, O6 DEFERRED** | Revises §16.6 (L2, L3), §16.8 and requirements R18, R19, R21; adds R23–R27 (§13). **O3 supersedes my earlier suggestion of a protective pause of collection: it is not permitted.** |
| 16 | **D5 = A with safeguards (DECIDED 2026-10-25).** (a) Cancellation **before the first qualifying paid period** releases the provisional Founder position **only after Stripe confirms the subscription is terminal and no payment recovery remains possible**. (b) A returning studio that **never committed** a position gets a **fresh Founder eligibility decision**. (c) **No studio receives a second introductory free trial.** (d) A **committed** Founder returning within its original promotional window may **resume its unused qualifying paid periods**, subject to the original 18-month backstop. (e) Returning after promotional eligibility has expired means **Regular pricing, with advance price disclosure and explicit customer confirmation**. (f) The **grandfathered $129 Pro** studio remains protected; its cancellation and reactivation rights require review of its original terms and **the new rules are not applied to it retroactively**. **D7 = A with safeguards (DECIDED 2026-10-25).** Founder-to-Founder plan changes use a **DanceFlow-controlled, server-authorized workflow**. A plan change must **not** create a second Founder allocation, reset the promotional clock, create a second trial, or count prorated invoices as additional paid periods. **Regular subscribers must never gain Founder eligibility by selecting a Founder Price in the Stripe billing portal.** A voluntary Founder-to-Regular transition remains possible but requires explicit disclosure and confirmation (the Stripe mutation is O6, deferred). The **live Stripe billing-portal configuration must be verified before the implementation is finalized.** **D16 = approved POLICY DIRECTION, pending the Stripe evidence (2026-10-25).** The intended policy is to **remove unrestricted promotion-code entry from studio checkout**; only explicitly approved, **allowlisted coupons** are applied **server-side**; no unauthorized coupon stacking onto Founder pricing and no unintended free months; **documented grandfathered or existing contractual discounts are preserved**. **Before any behavior changes**, active Stripe coupons, promotion codes and the existing subscribers who rely on them are audited (§16.11). | **D5 DECIDED; D7 DECIDED; D16 DIRECTION APPROVED (evidence pending)** | Adds requirements R28–R33 (§13); live exposure assessment and mitigations in §16.12 (**conditional: nothing verified yet**); owner-run read-only checks in §16.11. |

**Decision table status after 2026-10-25:** D1, D2, D3 **DECIDED** (item 14); O2, O3, O4, O5, O7 **DECIDED**, O1 and O6 **DEFERRED** (item 15); **D5 and D7 DECIDED**, **D16 direction approved pending Stripe evidence** (item 16); D11, D12, D13, D17 and R11 **DECIDED**. D6 **PARTIAL** (one-trial rule now settled by D5(c); anti-abuse mechanics open); D4 **PARTIAL**; D18 **PARTIAL**. **Still open:** D8–D10, D14, D15, D19, D20; O1 and O6 stay deferred. The three owner-run read-only checks you prioritized (billing portal, coupons and promotion codes, Founder subscription counts) are specified in §16.11; **no live exposure is verified yet** (§16.12). Until the ledger exists the cap stays unenforced and no scarcity or count claim may be published (item 10).

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

**Recommended per-studio Founder entitlement record** (not implemented; for the design slice). Table `studio_founder_entitlements`: `studio_id` (unique), `kind` (`founder_new`/`founder_grandfathered`), `position` (1–25, unique where active), `status` (`reserved`/`trial_hold`/`committed`/`released`/`expired`/`voided`/`needs_reconciliation`; transitions in §16.5), `original_plan_code`, `stripe_customer_id`, `stripe_checkout_session_id`, `stripe_subscription_id`, `current_price_id`, `reserved_at`, `reservation_expires_at`, `trial_end`, `first_paid_invoice_id`, `first_paid_period_start`, `qualifying_period_count` (**distinct paid periods, never raw invoices**; derived from a per-period table keyed by subscription and period start), `expected_promo_end`, `backstop_end`, `notice_state` (jsonb: sent timestamps), `transition_state` (`pending`/`blocked`/`done`/`n_a`), `eligibility_evidence` (jsonb), `created_at/updated_at`. Plus append-only `studio_founder_entitlement_events` (event type, actor, Stripe event id, before/after digest, reason). RLS: staff may read their own studio's row; writes service-role only, matching `studio_subscriptions` hardening. Creation, conversion, commit, release, void and seeding are `SECURITY DEFINER`, service-role-only RPCs; capacity enforced under `pg_advisory_xact_lock` as in ENT-1. Stripe remains the billing source of truth; this table is the **application-level** source of truth for eligibility, position and promotional state (Stripe alone does not hold them).

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
| R16 | **Allocation state machine** exactly as §16.5 (reserved, trial_hold, committed, released, expired, voided, needs_reconciliation), with guarded, monotonic, idempotent transitions and an append-only event for every transition. | D1–D3 |
| R17 | **Stripe is authoritative.** Every transition other than creating a reservation first retrieves the live Stripe Checkout Session, subscription, latest invoice and payment state; event payloads alone are never trusted (Stripe does not guarantee event order and says not to use `created` to order events). | D2, D3, late completion |
| R18 | **Reservation and session alignment.** The reservation is created before the Checkout Session; the Session `expires_at` is set explicitly to 60 minutes after creation (Stripe's supported range is 30 minutes to 24 hours); the reservation lasts the session lifetime plus a **small bounded completion grace** (**five minutes: approved as a bounded reconciliation grace; it never permits exceeding the 25-position cap, and Stripe and the ledger must agree before eligibility is confirmed**); expired reservations are **excluded from capacity by timestamp**, independent of any cleanup job; the expiry reconciler retrieves the Session from Stripe **inside the grace** and converts a completed one instead of releasing it. The recovery option for expired Sessions (`after_expiration`) stays unused. | D3 |
| R19 | **Concurrency, idempotency and identity.** Allocation runs in one database transaction under an advisory lock for the Founder program. Uniqueness is enforced on **verified studio identity** and **verified owner identity** (not on an email address; one email is not assumed to be one studio, and one owner may legitimately own more than one studio), so a second account, a second tab, a retry or a webhook replay cannot create a second reservation for the same studio or owner; stale rows are expired inside the lock before a new one is inserted; the idempotency key is verified owner, verified studio, plan and client request id; a repeat request returns the **same** reservation and reuses the still-open Checkout Session; simultaneous checkouts serialize at the lock; every webhook transition is keyed by Stripe object ids and event ids and is a no-op when replayed or when the from-state does not match. The existing rate limiter stays on checkout. The precise identity signals are a design decision (O5). | D3, O5 |
| R20 | **Lifecycle hold.** A provisional position is released only on a **verified terminal** subscription state with no qualifying paid period (re-fetched from Stripe, not inferred from days elapsed); no timer releases a recoverable Founder subscription. The maximum hold and the terminal rule for non-cancel Stripe settings are defined only after the Stripe evidence in §16.7 (owner decision O1). | D2 |
| R21 | **Late-completion safeguards (as revised by O3/O4).** Implemented as the matrix in §16.6: verify Stripe first, never allocate a 26th position, **never automatically cancel, pause collection or change the price** for a late completion, preserve evidence, create an **exception case** for owner review, and offer Regular only through an explicit customer confirmation whose Stripe mutation has been proven in isolated test mode (O6, deferred). | D3 safeguards, O3, O4 |
| R22 | **Exceptions are visible.** A platform-admin view of `needs_reconciliation` and late-completion cases, owner alerts (O7), and a daily check that the number of alive Founder-priced Stripe subscriptions (excluding the grandfathered one and Organizer) equals the ledger's occupied count. | D2, D3, D17 |
| R23 | **Exception workflow with an audited resolution path.** Unresolved Founder eligibility (late completion with capacity full, payment on a lapsed reservation, ambiguity, duplicate subscription) is recorded as an **exception case** that **counts as unavailable capacity** until resolved, so it can never produce position 26. Every case must end in a **recorded resolution** (outcome, reason, actor, time, evidence references); aging cases escalate automatically (target owner review within one business day; additional reminders before the trial end), and no case can be closed without an outcome, so exceptions cannot remain permanently stranded. A resolution that admits a studio as a Founder is allowed **only** when a position is genuinely available. | O3, O4, owner additional requirements |
| R24 | **Identity-based reservation uniqueness** per R19, with protection against duplicate reservations created through additional accounts, multiple tabs, retries or webhook replays; identity rules (what makes a studio or an owner "verified") are part of the design slice and need owner approval. | O5 |
| R25 | **Exception alerts.** Each exception case alerts the platform administrator and `support@idanceflow.com` with an actionable message (case id, studio id, state, what is needed, a link to the admin view) and **no sensitive payment details** (no card data, no full amounts beyond what the case needs, no secrets); every alert and its delivery is audited; target owner review within one business day. | O7 |
| R26 | **Tests (all in the existing BILLING-QA test-mode and local-database harness).** Delayed webhooks (including a completion arriving after reservation expiry and after the grace), simultaneous checkouts for the last position, **payment recovery** (a failed first invoice recovered on a Stripe retry), multi-tab sessions, duplicate owners and duplicate studios, replayed events, the grandfathered $129 studio's protections, and the exception workflow end to end including its resolution path. | owner additional requirements |
| R27 | **Two retry mechanisms stay distinct in code, documentation and tests.** **Webhook delivery retries** (Stripe re-sending an event to our endpoint; live mode up to three days) govern late-completion risk. **Failed invoice payment retries** (Stripe Billing re-attempting a customer's card per the account's retry policy) govern how long a Founder subscription can still become paid. They are different settings and different risks; neither is used as evidence about the other. | owner additional requirements |
| R28 | **Cancel and return (D5).** Release of a provisional position happens only after Stripe confirms the subscription is **terminal and that no payment recovery remains possible** (never on a timer); a returning studio that never committed gets a fresh eligibility decision; **no second introductory trial for any studio** (a persisted trial-used marker per studio and per Stripe customer); a committed studio returning inside its window resumes its unused qualifying periods under the original backstop; after eligibility expires the return is **Regular with advance price disclosure and explicit customer confirmation**; the grandfathered $129 studio is **not** subject to these rules and its cancellation/reactivation is handled through a manual, owner-reviewed path against its original terms. | D5 |
| R29 | **Server-authorized plan changes (D7).** Founder-to-Founder tier changes run only through a DanceFlow workflow that re-verifies the ledger entitlement; a change creates **no second allocation, no promotional-clock reset, no second trial and no extra qualifying period** (prorated invoices never count, §16.3); upgrades and downgrades follow the proration and timing rules chosen in the design slice; a change is recorded as an audited ledger event with the Price ids before and after. | D7 |
| R30 | **Regular subscribers can never become Founder through the portal (D7).** The Stripe billing portal must not offer a customer-selected switch to any Founder Price (portal configuration is account-wide, so the safe state is plan switching off or Founder Prices not listed); webhook plan resolution continues to recognize Prices but a Founder Price on a studio with no ledger entitlement raises an exception case (R23), not a silent acceptance. | D7 |
| R31 | **Voluntary Founder-to-Regular transition.** Possible, but only after explicit disclosure of the Regular price and terms and an explicit customer confirmation; the exact Stripe subscription mutation is **O6 (deferred, isolated test-mode proof first)**; it preserves trial eligibility rules (no new trial), creates **no duplicate subscription**, and is audited. | D7, O6 |
| R32 | **Live portal verification before finalizing (D7).** The active billing-portal configuration (§16.11 check P) is read and recorded before the plan-change implementation is finalized; the implementation assumes nothing about it. | D7 |
| R33 | **Promotion policy (D16, pending evidence).** After the coupon audit (§16.11 check C) and with owner approval of the resulting behavior change: studio checkout no longer shows an open promotion-code box; only allowlisted coupon ids are applied server-side; Founder sessions cannot stack discounts; documented grandfathered or contractual discounts are preserved; the qualifying-period counter treats a $0 plan line as non-qualifying (§16.3). Until then **no code or Stripe change is made**. | D16 |
| R34 | **Portal hand-off is a 303 with visible errors (D7 audit, 2026-10-25).** Every redirect from the portal route is 303; failures are logged server-side without secrets and map to specific user-facing messages; the button is shown only when the route can open a session for the same customer source; a test asserts status and method. Applies independent of the final architecture. | D7 |
| R35 | **Change Plan never implies a change it did not make.** For a managed subscriber the control states what it does until the DanceFlow plan-change service exists; the displayed price is the studio's actual price, not the global-flag price. | D7 |
| R36 | **Protected subscriptions are identified by record, not by price.** A server-side registry marks the grandfathered $129 Pro (and any documented contractual exception); Change Plan, cancel and return for those studios are blocked or warned and never fall through to a new Checkout at the current Founder price or a new trial; no new policy is applied retroactively. | D5(f), D7 |
| R37 | **No second subscription.** A studio with a `paused`, `incomplete` or otherwise non-terminal Stripe subscription is never sent to a new Checkout; plan-change and Checkout requests are idempotent and serialized per studio. | D7 |
| R38 | **Portal configuration is pinned.** The portal route passes an explicit configuration id so the account default cannot silently become a plan-switching configuration; switching plans, promotion codes and cancellation settings follow the owner decisions (O10). | D7, D16 |

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
| D1 | When a position is **committed** | **DECIDED: A** (first qualifying paid period; provisional allocation before it) | positions are consumed only by studios that actually paid | trial-cancelers cost nobody a position |
| D2 | What holds a position between checkout and first payment | **DECIDED: A** (subscription-lifecycle hold; maximum hold undefined until the Stripe evidence in §16.7) | never more than 25 Founder-priced subscriptions alive | the price promised at checkout holds through normal retries |
| D3 | Checkout reservation lifetime | **DECIDED: 60 minutes**, session expiry aligned, bounded grace, one active reservation per owner | abandoned checkouts return the position within about an hour; capacity ignores expired rows | enough time to finish; an expired session can be restarted |
| D4 (remainder) | Voiding a **committed** position | platform admin only, with a required reason (fraud, duplicate, internal/test), audited | positions are never recycled by churn | none |
| D8 | Failed payment | keep the position through Stripe's retry schedule; if the subscription is canceled **before any paid invoice**, release; after paid periods, the position stays committed and the counter counts only paid periods | no free-riding on failed payments; no loss of committed positions on a late payment | normal dunning emails; no surprise price change |
| D9 | Eligibility and duplicate rules | one Founder entitlement per studio, per Stripe customer and per verified owner user; evidence stored; any heavier verification (EIN, domain matching) is your call | stops duplicate studios taking several positions | minimal friction; extra checks only on suspicion |
| D10 | Internal, test, comp, ambassador studios | explicitly excluded by a platform-set flag checked inside the reservation function | cannot consume a position even if they later check out | none |

**Group 2: entitlement rules during the Founder period**

| ID | Decision | Recommendation | Subscription integrity | Customer experience |
|---|---|---|---|---|
| D13 | Definition of "12 paid months" | **DECIDED: H** (§6A item 13, §16.3) | counter keyed by billing period; backstop bounds the window | wording matches the approved policy and discloses both limits |
| D5 | Cancel and return | **DECIDED: A with safeguards** (§6A item 16) | release only after Stripe confirms a terminal state; no second trial; committed Founders resume unused periods inside the 18-month backstop | fair to returning studios; Regular after expiry with disclosure and confirmation |
| D7 | Plan change during the window | **DECIDED: A with safeguards** | Founder Prices are reachable only through a ledger-checked server workflow; no second allocation, clock reset, trial or extra period | tier changes stay possible inside DanceFlow |
| D16 | Promotion codes | **Direction approved; evidence pending** | no stacking, no unintended free months | deliberate, allowlisted promotions only |

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

> **DECIDED 2026-10-25:** D1 = A, D2 = A, D3 = 60 minutes (see §6A item 14). The analysis below is kept as the decision record; the binding specification is §16.5–§16.8.

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
3. **Late completion after the reservation was lost:** if checkout completes after the reservation expired and the position has since been taken, **cancel the trialing subscription (no money has moved), tell the studio, and offer Regular** (once Regular is available). **(Superseded 2026-10-25 by the owner's late-completion safeguards, §6A item 14 and §16.6: verify Stripe first, never cancel merely because delivery was late, use a controlled recovery path, preserve evidence if payment occurred or the state is ambiguous, and offer Regular only through an explicit confirmation.)** The alternative, honoring the Founder price anyway, would break "never more than 25" and is rejected.
4. **Studio returns after an hour:** a fresh eligibility decision is made; if the cap is now full they see the polite refusal (owner decision 6) or the Regular offer once available.

**What I need from you:** (1) D1: A, B or C. (2) D2: A or B (C is rejected). (3) D3: 30, 60 or 24 hours, and the three sub-decisions. (4) Evidence for D2-A: your Stripe failed-payment retry settings. **How they interact with D13:** the trial hold never counts toward the 12 paid periods or the 18-month backstop; both start at the first qualifying paid period.

### 16.5 Allocation state machine (specification for the design slice; not implemented)

| State | Counted toward the 25? | Entered by | Left by |
|---|---|---|---|
| **available** (implicit, no row) | no | | a reservation (T1) |
| **reserved** | yes, while `reservation_expires_at > now` | T1: eligibility decision at checkout creation, in the locked allocation transaction | T2 (completed), T3 (expired), L-paths in §16.6 |
| **trial_hold** (the provisional Founder allocation) | yes | T2: verified completed Checkout Session with a Founder-priced subscription that is trialing, or revived per L1 | T5 (committed) or T6 (released) |
| **committed** | yes | T5: first qualifying paid period verified (§16.3) | only an audited admin **void** (T8) |
| **released** | no | T6: verified terminal subscription state with no qualifying paid period | none (a later attempt is a new reservation) |
| **expired** | no | T3: reservation lapsed with no completed session | none |
| **voided** | no | T8: platform-admin action with a required reason | none |
| **needs_reconciliation** | yes (conservative) | T9: payment occurred or state is ambiguous (§16.6 L3, L6) | an owner/admin resolution recorded in the audit log |
| **grandfathered** (a kind, not a state) | yes, permanently | seeded once after verification | never changes except by audited admin RPC |

Transitions (each is guarded by its from-state, idempotent, and writes an append-only event with the Stripe ids it verified):

| Id | From → To | Trigger and guard |
|---|---|---|
| T1 | available → reserved | studio owner starts a Founder checkout: studio is eligible (D9/D10), no active allocation exists, no other active reservation for this owner, `available_to_new > 0`; creates the reservation and the Checkout Session (60 minutes) together; a repeat request returns the same reservation |
| T2 | reserved → trial_hold | `checkout.session.completed` (or the expiry reconciler) **and** Stripe confirms the Session is complete and the subscription is trialing with the Founder Price and the reservation's metadata |
| T3 | reserved → expired | the reconciler, inside the grace, confirms from Stripe that the Session is **expired/not completed**; or the grace passes (capacity already ignored it at `reservation_expires_at`) |
| T4 | trial_hold stays | subscription status trialing, incomplete, past due or paused-for-failure while Stripe can still collect; **no elapsed-days rule releases it** (D2) |
| T5 | trial_hold → committed | a renewal-cycle invoice for the first billing period after the trial is **paid** with a Founder plan line greater than zero (re-fetched from Stripe); starts the 12-period count and the 18-month clock (§16.3) |
| T6 | trial_hold → released | Stripe shows a **terminal** state for the subscription (canceled, or the configured terminal action) and **no** qualifying paid period exists |
| T7 | committed (after cancel/return) | stays committed; resume rules per D5 |
| T8 | committed → voided | platform admin only, with a required reason (fraud, duplicate, internal/test); audited |
| T9 | any → needs_reconciliation | ambiguity or payment on a lapsed reservation (§16.6); occupies capacity conservatively; owner alert |

Capacity at any time: **occupied = grandfathered + committed + trial_hold + unexpired reserved + needs_reconciliation**; **available = max(0, 25 − occupied)**.

### 16.6 Late checkout completion: decision matrix

Applies when Stripe reports a Checkout Session as completed but the reservation is no longer valid in the ledger (for example the webhook was delayed: Stripe retries failed live deliveries for up to three days, so delays of hours are possible). Rules common to every row: **first** retrieve the Session, subscription, latest invoice and payment from Stripe; **never** allocate a 26th position; **never** cancel a subscription merely because delivery was late; **never** change a price silently.

| # | Verified situation | Action |
|---|---|---|
| L0 | completed inside a valid reservation | normal conversion (T2) |
| L1 | completed; the reservation lapsed but **capacity is still available** | revive atomically under the lock: re-reserve for the same studio, convert to trial_hold, log `late_completion_revived` (idempotent) |
| L2 | completed; the reservation lapsed; **capacity is full**; Stripe shows a genuinely **trialing** subscription with **no paid invoice and no successful payment** | **controlled exception workflow (O3).** Open an exception case that **counts as unavailable capacity**; **do not** cancel the subscription, **do not** pause collection, **do not** change its price; verify the facts again, preserve the evidence, grant **no Founder entitlement**, and alert the platform administrator and `support@idanceflow.com` (R25). The owner reviews within one business day. Resolution options, each with a recorded reason: the studio is admitted as a Founder **only** if a position is genuinely available; or the studio **accepts an explicit Regular offer** (the Stripe mutation is **O6, deferred**: it must be proven in isolated test mode first and requires explicit customer confirmation); or the owner and studio agree to end the subscription. The case ages with escalating reminders before the trial ends so it cannot be stranded. **Residual risk, stated plainly:** because no automatic action is permitted, an unresolved case that reaches the end of the trial can be billed at the Founder price; that becomes L3 and is handled by O4 (refund or an explicitly accepted Regular offer), never by retaining an improper charge. |
| L3 | completed; **payment has occurred**, or the Stripe state is **ambiguous** (API error, mismatched ids, a Founder-priced subscription with no ledger row) | **preserve evidence** (store the verified object snapshots and ids), open an exception case counted as unavailable capacity, **do not touch the subscription automatically**, never allocate position 26, prevent any unauthorized price transition, and escalate for **individual owner review** (O4). The documented remedy is chosen by the owner for that case: a refund, or an **explicitly accepted Regular offer** where appropriate; **never** silently reprice and **never** retain an improper charge. Alerts per R25. |
| L4 | the Session is **expired** in Stripe | ignore any completion claim; release per T3 |
| L5 | duplicate or replayed completion event | idempotent no-op |
| L6 | a second subscription for a studio that already holds an allocation (for example two tabs) | needs_reconciliation; the app prevents it by reusing one Session per reservation and by routing studios with a managed subscription to the portal (existing behavior) |

Reducing late completions: the expiry reconciler polls Stripe inside the grace window, so most delayed webhooks are resolved by the poll before capacity is released; Stripe's Checkout Session cannot complete after its `expires_at`, so a completion that is real was made inside the 60 minutes.

### 16.7 Stripe facts and settings

**Verified from Stripe's public documentation (2026-10-25):**
- Checkout Session `expires_at`: "anywhere from 30 minutes to 24 hours after Checkout Session creation"; default 24 hours. A 60-minute reservation is supported.
- Webhook delivery: live mode retries for up to **three days** with exponential backoff; sandbox retries three times over a few hours; Stripe does **not** guarantee event order and says not to use `created` to order or de-duplicate events (track event ids; retrieve objects via the API).
- Failed-payment retries: configured at Billing → Revenue recovery → Retries; Smart Retries (recommended default 8 tries within 2 weeks; options 1 week, 2 weeks, 3 weeks, 1 month or 2 months) or a custom schedule of up to three retries; when recovery fails the subscription can be set to **cancel**, **mark unpaid**, **leave past due** or **pause**; hard-decline codes (for example authentication required, stolen or lost card) are not retried until a new payment method exists.

**Two different retry mechanisms (do not conflate them; R27):** *webhook delivery retries* are Stripe re-sending an event to DanceFlow's endpoint (live mode: up to three days); *failed invoice payment retries* are Stripe Billing re-attempting a customer's card under the account's retry policy. The first explains how late a completion can be noticed; the second decides how long a Founder subscription can still become paid.

**Unresolved (need a read of the DanceFlow live account; none guessed, none changed):**

| # | Setting | Why it matters | How to read it (owner, read-only) |
|---|---|---|---|
| U1 | Retry policy in force (Smart Retries or custom; number of tries; maximum window) | sets the longest a recoverable Founder subscription can legitimately stay unpaid, hence the maximum hold | Dashboard → Billing → Revenue recovery → Retries |
| U2 | Action when recovery fails (cancel, mark unpaid, leave past due, pause) | only **cancel** gives a clean terminal state; the others leave a subscription alive, so a position could be held indefinitely unless the owner defines an app-level terminal rule (O1) | same page |
| U3 | Treatment of hard declines | a hard decline cannot recover without a new payment method, yet the subscription may sit past due for the whole window; affects how long a position is held for a card that cannot pay | same page; Stripe docs list the codes |
| U4 | Customer emails for failed payments and card updates | recovery depends on the customer being told and able to update the card | Dashboard → Settings → Billing → Subscriptions and emails |
| U5 | Billing portal configuration (still unread): cancel timing, pause, payment-method updates, plan switching | recovery path and the Founder-to-Regular self-switch risk | Dashboard → Settings → Billing → Customer portal |
| U6 | Whether subscriptions pause on payment failure | adds a `paused` state to the hold rules | Retries page |
| U7 | Webhook delivery history for the live endpoint (failed/pending deliveries) | shows how often late completions can really occur | Workbench → Webhooks → endpoint → Event deliveries |
| U8 | Stripe test-mode proof of expiry and completion at the 60-minute boundary and of the reconciler poll | confirms the grace and race behavior | design-slice test, not an account setting |

### 16.8 Additional owner decisions required

| # | Decision | Recommendation |
|---|---|---|
| O1 | Maximum hold and the terminal rule when Stripe's final action is not "cancel" (unpaid, past due, paused) or after a hard decline | **DEFERRED (owner 2026-10-25).** No maximum-hold rule is recommended until the actual retry policy, hard-decline handling and terminal subscription action are read from the live account (§16.9 checks 1–3). |
| O2 | Completion grace length and whether the expiry reconciler polls Stripe | **APPROVED:** five minutes; never a licence to exceed 25; Stripe state and ledger must agree before eligibility is confirmed. |
| O3 | Late-completion recovery policy (L2) | **APPROVED with safeguards:** controlled exception workflow; no automatic cancel, no pause of collection, no silent price change; verify payment, preserve evidence, prevent unauthorized Founder entitlement; the exception counts as unavailable capacity and must reach an audited resolution (R23). |
| O4 | Remedy when payment occurred or state is ambiguous and capacity is full (L3) | **APPROVED as a policy direction:** individual owner review with a documented remedy (refund, or an explicitly accepted Regular offer where appropriate); never silently reprice, retain an improper charge or allocate position 26. |
| O5 | Reservation uniqueness | **APPROVED:** verified studio identity and verified owner identity, protected against duplicates through additional accounts, tabs, retries and replays; no assumption that one email equals one studio. The exact identity signals are for the design slice (R19, R24). |
| O6 | How Regular is offered to a trialing Founder-priced subscription | **DEFERRED:** the business requirement is an explicit customer-confirmed move from Founder to approved Regular pricing that preserves trial eligibility and avoids duplicate subscriptions; the exact Stripe subscription mutation (for example changing the item on the existing subscription) must be **proven in isolated test mode** before approval. |
| O7 | Exception alerts | **APPROVED:** actionable alerts to the platform administrator and `support@idanceflow.com`; target owner review within one business day; no sensitive payment details; audit trail (R25). |

Still open from earlier: D5, D7–D10, D14–D16, D19, D20.

### 16.9 Owner-run read-only Stripe Dashboard checks still required (consolidated)

Nothing below changes any setting; record only non-secret facts or screenshots (no keys, no card data, no customer emails). Live mode, account `acct_1TKgL3EY0sTayNiS`.

| # | Check | Where | Record | Feeds |
|---|---|---|---|---|
| 1 | **Failed invoice payment retry policy** (Smart Retries or custom; number of tries; maximum window) | Billing → Revenue recovery → Retries | the policy and window | O1 |
| 2 | **Terminal action when recovery fails** (cancel, mark unpaid, leave past due, pause) | same page | the chosen action | O1 |
| 3 | **Hard-decline handling** (cards that cannot be retried until a new payment method exists) and any "pause on payment failure" setting | same page; Stripe's hard-decline list | how it is configured | O1 |
| 4 | Failed-payment and card-update **customer emails** | Settings → Billing → Subscriptions and emails | which emails are on | recovery path, O1 |
| 5 | **Billing portal configuration**: plan switching and which Prices are listed (Founder Prices must not be listed), cancel timing (immediate or end of period), pause, payment-method updates | Settings → Billing → Customer portal | the configuration | D5, D7, O6 |
| 6 | **Webhook delivery history** for `https://www.idanceflow.com/api/payments/webhook` (failed or pending deliveries and their age) | Workbench → Webhooks → endpoint → Event deliveries | counts of failed/pending, oldest age | late-completion likelihood (R27 is about this mechanism, not payment retries) |
| 7 | **Active promotion codes and coupons**, redemptions, restrictions, and any subscription with a discount attached | Product catalog → Coupons / Promotion codes; Subscriptions filtered by discount | list with redemption counts | D16 |
| 8 | **Founder subscriptions by Price** (new Starter, Growth, Pro Prices; grandfathered $129; the old Growth Founder Price; any older Founder Price), all statuses, de-duplicated by `studioId` metadata | Subscriptions → filter by Price | the §15.3 table | D17 monitoring, reconciliation, seeding |
| 9 | **Identity of the grandfathered studio** and its subscription metadata (source, studioId), discounts and schedules | Subscriptions → price `price_1TdDHwEY0sTayNiSIe1nD3Lg` | subscription id and metadata keys | grandfathered protection, D5 |
| 10 | **Open Checkout Sessions** in the last 24 hours on Founder Prices | Developers → Events (created minus completed/expired) | counts | D17 Tally B |
| 11 | **Regular Price verification** (IDs unchanged, $89/$149/$249, USD, monthly, live, zero subscriptions) | Product catalog | the PRICING-P1 runbook checklist | Regular activation |
| 12 | **Payment Links / Pricing Tables** that reference any Regular or Founder Price | Payment Links; Product catalog → each Price → used by | confirmation of none | exposure review |

Not a Dashboard read (design-slice work, needs separate authorization): the isolated **test-mode** proof of the Founder-to-Regular subscription mutation (O6) and of the 60-minute session boundary and reconciler poll (U8). No Stripe write of any kind is authorized by this report.

### 16.10 D5, D7 and D16 presented for decision

> **DECIDED 2026-10-25:** D5 = A with safeguards and D7 = A with safeguards; **D16 = policy direction approved, pending the Stripe evidence** (see §6A item 16). The analysis below is the decision record; the binding specification is R28–R33 (§13) and §16.11–§16.12.

Context from decided policy: positions are provisional until the first qualifying paid period (D1) and then committed; the benefit is twelve qualifying paid periods within an 18-month window from the first paid period (D13); the grandfathered $129 studio is permanently excluded from expiry; capacity is enforced by the ledger, not by Stripe; the Stripe billing portal configuration is **account-wide** (it cannot treat Founder studios differently from others) and is **still unread** (§16.9 check 5).

**D5: a Founder studio cancels and later returns**

| Scenario | Recommended treatment | Subscription integrity | Customer experience |
|---|---|---|---|
| Cancels during the trial (no paid period), returns later | provisional allocation was released (D1); a return is a **new eligibility decision**: Founder only if a position is available; **no second free trial** for the same studio | positions are never held by a studio that never paid; trial cannot be restarted | a studio that changes its mind pays nothing extra but does not get two trials |
| Cancels after at least one qualifying paid period, returns **within the window** (before 12 qualifying periods and before the backstop) | **resume the remaining qualifying periods at the Founder Price of the chosen tier, same backstop date, no new trial** (as in §16.3, now for confirmation) | the counter is per studio and period-keyed, so no double counting; the backstop never moves | fair to a studio with a gap; the discount cannot be restarted |
| Returns after 12 qualifying periods or after the backstop | **Regular** price, no new trial | no second Founder year | clear and predictable |
| Subscription ended by Stripe after failed payments, then returns | same as the paid-period rules above (the studio is treated by what it paid) | consistent with D8 | no special penalty beyond lost months |
| The **grandfathered $129 studio** cancels and returns | **not decided here**: its entitlement is protected, but its established terms are not recorded in this repository; a return needs a **manual, owner-reviewed** path before any price is applied | no automatic repricing in either direction | the studio is contacted rather than surprised |

Alternatives: **B forfeit** (cancelling after commitment ends Founder pricing for good; the committed position then sits unused because committed positions are never recycled, D4) and **C restart** (a return is a brand-new Founder year and trial; rejected: it lets churn restart the discount and the trial). Recommendation: **A** as above. **Needs from you:** confirm A; confirm "no second trial" for a studio that cancelled in its trial; and tell me what the grandfathered studio's established terms say about cancelling and returning.

**D7: a plan change during the Founder window**

| Option | How it works | Subscription integrity | Customer experience |
|---|---|---|---|
| **A (recommended): Founder-to-Founder changes through a DanceFlow-controlled flow** | the studio chooses the new tier in the app; the server checks the ledger entitlement and moves the subscription to the **Founder Price of that tier**; the qualifying-period counter and the backstop **do not change**; upgrades can apply at once (the extra is billed as proration, which never counts as a period) and downgrades at the period end; **no path to a Regular Price during the window**; the portal is set to **no plan switching** | Founder Prices can only be reached through the ledger-checked flow; the cap cannot be bypassed | studios can still grow or shrink within their Founder year; the change happens in DanceFlow, not in a separate Stripe page |
| B: leave plan switching in the Stripe portal | the portal lists the Prices a studio may switch between | **unsafe: the portal is account-wide, so listing Founder Prices would let any subscriber, including a Regular studio, move itself onto a Founder Price outside the ledger, and listing Regular Prices would let a Founder switch away silently.** Not recommended unless the portal lists no Founder Price | simplest, but breaks the cap |
| C: no plan changes during the window | cancel and return instead | simplest integrity | hostile to a growing studio |
| D: upgrades only during the window | downgrades wait for expiry | protects revenue | partly restrictive |

Current exposure to check now: today every subscribed studio is sent to the Stripe billing portal for plan management, and the portal configuration has never been read. **If the portal lists the Founder Prices, a non-Founder subscriber could already move itself onto one.** That is why §16.9 check 5 matters before anything else here. Also, a Founder studio's own tier change must keep the counter and backstop, and a Dashboard edit by the owner outside the app is caught by reconciliation, not prevented. **Needs from you:** A, B, C or D; for A, whether downgrades are allowed during the window and whether an immediate upgrade prorates; and the portal read (check 5).

**D16: promotion codes**

| Option | Detail | Subscription integrity | Customer experience |
|---|---|---|---|
| **A (recommended): disable the open promotion-code box on studio subscription sessions for now** | today `allow_promotion_codes` is on for every studio session; turn it off, and apply any approved promotion **server-side** through an allowlisted coupon id only | no stacking on Founder pricing, no $0 months in the counter (§16.3), no revenue leakage from forgotten codes | a studio loses a code box it may never have used; every promotion becomes deliberate |
| B: codes allowed on Regular sessions only | never on a Founder session | Founder price stays clean | useful if partner or referral codes are planned; needs a written promotions policy |
| C: leave it on | **rejected**: codes can stack onto a Founder price, create $0 periods that the counter must then special-case, and persist as forever coupons | | |

Open facts: whether any live promotion codes or coupons exist, who holds them, and whether any subscription already has a discount attached (§16.9 check 7). Comp and ambassador access is handled by the platform billing override, not by Stripe codes, so it is not affected. Manual discounts applied by the owner in the Dashboard bypass the app: the counter treats a $0 plan line as non-qualifying, and the reconciliation flags it. **Needs from you:** A or B; the list of active codes and who uses them; and whether any marketing campaign advertises a code.

**Suggested order:** the portal read (check 5) and the promotion-code list (check 7) first, because they decide whether D7 and D16 have a live exposure today; then D5, D7 and D16 themselves.

### 16.11 Owner-run, read-only Stripe Dashboard instructions (the three priority checks)

Use **Live mode** in the DanceFlow account (`acct_1TKgL3EY0sTayNiS`). **Change nothing**: do not toggle, save, archive, delete or apply anything. Record only non-secret facts; screenshots must not show customer names, emails or card data. Navigation below follows Stripe's public documentation; if the Dashboard layout differs, tell me what you see rather than guessing.

**Check P: the active billing-portal configuration (is any Founder Price selectable by a customer?)**
1. Dashboard → **Settings** → **Billing** → **Customer portal** (the page behind `dashboard.stripe.com/settings/billing/portal`).
2. Note whether **more than one configuration** exists and which is the **default**. (DanceFlow's code does not pass a configuration id when it opens the portal, so the **default** configuration is the one customers get.)
3. Under **Subscriptions**, record each setting as shown: **Switch plan** (On/Off; Stripe's default is Off); if On, **the exact list of products and prices offered** (look specifically for: Studio Starter - Founder, Studio Growth - Founder, Studio Pro - Founder, the grandfathered Pro product/Price, the Regular products, Organizer products); **Update quantities**; **Prorate subscription updates**; **Manage downgrades** (when On, Stripe creates a subscription schedule and only allows downgrades between prices of the **same product**); **Use promotion codes**.
4. Under cancellation, record **Cancel subscription** (On/Off), the cancellation timing option as the page shows it, **Cancellation reason**, and **Retention coupons** (On/Off, which coupon).
5. Under customer information, record whether **Payment methods** can be updated (this must stay available because a customer fixing a failed card is how recovery works).
6. **Interpretation:** Founder Price listed with Switch plan On = exposure P1; Regular Price listed = P2; Use promotion codes On = P3 (§16.12).

**Check C: active coupons and promotion codes, and whom they affect**
1. Dashboard → **Products** → **Coupons** (Stripe: "Open the Products page, click Coupons").
2. For **every** coupon record: name and id; type and amount (percent or amount off); **Duration** (once, repeating with months, or **forever**); **Apply to specific products** (which products, or none = all); **redemption limit** and **times redeemed**; expiry (redeem-by).
3. Open each coupon and record its **promotion codes**: the code, active or archived, and the restrictions shown: first-time-orders-only, limited to one customer, minimum order value, expiry, maximum redemptions, and redemptions so far. (Promotion codes inherit the product restrictions of their coupon.)
4. Record whether any code is a customer-facing code someone has published (campaign, partner, ambassador) and who holds it.
5. To find **subscriptions that already carry a discount**, open each **Founder subscription** from check S and note its **Discount** section; a coupon that was applied directly (by you or by Stripe's portal) will not show as a redeemed code.
6. **Notes:** a coupon can only be **deleted**, not deactivated, and deleting does not remove discounts already applied but is **irreversible**; a promotion code can be **archived** (the reversible control). **Do not delete or archive anything during this check.** A coupon's product restriction cannot be edited after creation (only its name), so changing applicability means creating a new coupon.

**Check S: Founder subscriptions by Price (including trials and the grandfathered subscriber)**
1. Dashboard → **Billing** → **Subscriptions**, **All** statuses, narrowed one Price at a time with the list filters (if the list does not offer a Price or Product filter, use **Export** and filter the price column; **do not share the export**, it contains emails; send me only ids and counts).
2. Prices to count: Starter `price_1TdDHBEY0sTayNiS0G2Ed9oI`, Growth `price_1UUG7uEY0sTayNiSh0d9cCL8`, Pro `price_1UUG4UEY0sTayNiSClLL4J0R`, **grandfathered** `price_1TdDHwEY0sTayNiSIe1nD3Lg`, plus the **old Growth Founder Price** (please supply its id) and any earlier Founder Price.
3. For each subscription record: subscription id, customer id, **status** (trialing, active, past due, unpaid, incomplete, paused, canceled), created, trial end, current period end, the `studioId` / `source` / `offerType` metadata (subscription page → Metadata), and whether a discount is attached.
4. **Count by studio, not by subscription** (§15.2): Tally A (occupied) = distinct studios with a non-canceled subscription on a Founder Price including trialing and the grandfathered one; Tally B adds incomplete, open sessions and canceled-after-paid. Flag duplicates (one studio, two subscriptions), subscriptions with **no** metadata, and any Founder Price on an Organizer subscription.
5. Send me the table and the two tallies. **18 occupied** is the escalation threshold, not an authorization to stop selling (§6A item 12).

**Verified from Stripe's public documentation (2026-10-25):** the portal's **Switch plan**, **Use promotion codes** and **Manage downgrades** options and their defaults; coupons are created under Products → Coupons with the settings listed above; promotion codes are created inside a coupon and can be restricted; coupons cannot be deactivated, only deleted; a promotion code can be archived. The documentation did not confirm whether the **Subscriptions list** offers a Price filter, hence the Export fallback.

### 16.12 Live exposure assessment and recommended mitigations (conditional: nothing is verified yet)

**What the code establishes today** (read-only, both refs): the portal session is opened with the customer and a return URL only, so the **default portal configuration** applies; checkout sends every studio that already has a managed subscription to that portal; and every studio subscription Checkout Session has `allow_promotion_codes: true`. Whether the portal lists Founder Prices and whether live coupons exist is **unknown**, so **no exposure is classified as verified**. Severity below is what each finding **would be if you confirm it**, today and after the ledger or Regular pricing exists.

| Id | Possible finding | Severity today | Severity once the ledger or Regular pricing is live | Narrow mitigation (separate approval) |
|---|---|---|---|---|
| P1 | Portal: **Switch plan On and a Founder Price listed** | **Medium**: no ledger exists yet and every studio is Founder-priced, but any subscriber (including the grandfathered $129 studio, which is protected) can move itself between Founder tiers outside any record | **Critical**: any Regular studio could move itself onto a Founder Price, bypassing the cap | **M1** |
| P2 | Portal: Switch plan On and a **Regular Price** listed | **Low** (Regular is not active) | **Medium**: a Founder studio could leave early without the disclosure and confirmation you require (D7) | **M1** |
| P3 | Portal: **Use promotion codes On** | depends on C1 | same | **M1**, then C1 mitigation |
| P4 | Portal **Manage downgrades On** | **Low-Medium**: Stripe attaches a subscription schedule to the subscription, which complicates the planned period counting and plan-resolution logic | same | review in the design slice; **M1** if confirmed |
| P5 | Portal **Payment methods Off** | **Medium**: customers cannot fix a failed card, which defeats the D2 recovery path | **High** | re-enable (owner decision; not a change this report makes) |
| C1 | A live promotion code that is **unrestricted**: all products, **forever** or long repeating duration, high or no redemption limit, still active | **High**: it can reduce or zero a Founder price at checkout today, producing free months and discount stacking | **High** | **M2** (archive that promotion code) then **M3** |
| C2 | Promotion codes that are restricted (specific products excluding Founder products, expired, redemption-capped, customer-limited) | **Low** | **Low** | none; note for the audit |
| C3 | **Existing subscribers relying on a discount** (grandfathered or contractual) | not an exposure: a **dependency** to preserve (D16) | same | none; M2/M3 must not remove existing discounts |
| S1 | Founder-priced studios (Tally A) **18 or more** | **escalation** per D17, no automatic action | same | owner decision |
| S2 | Tally A **above 25** (cap already exceeded) | **High (commercial)**: cannot be undone; needs an owner decision on remedy | same | owner decision; **M4** only to stop further overshoot |
| S3 | Founder-priced subscriptions with **no studio metadata**, duplicate studios, or Founder Prices on Organizer subscriptions | **Medium**: counts and the ledger seed would be wrong | same | reconciliation (§15.6) |

**Recommended narrowly scoped mitigations, each needing its own owner approval, none authorized now:**
- **M1: portal.** Turn **Switch plan** off in the active portal configuration (or remove the Founder products from its list). Keep **Cancel subscription** and **Payment methods** as they are. Reversible by toggling back. Effect: tier changes wait for the DanceFlow workflow (D7); studios ask support in the meantime. Confirm after the change by re-reading the page (Check P).
- **M2: coupon exposure.** If C1 is confirmed, **archive the specific promotion code** (reversible; do **not** delete the coupon: deletion is irreversible and the discounts already applied stay anyway). Existing discounted subscriptions are unaffected.
- **M3: application change (a development slice).** Remove the open promotion-code box from studio subscription checkout (`allow_promotion_codes` off) and apply only allowlisted coupon ids server-side (R33). It needs a release from an isolated branch off the production base and its own approval; M2 is the interim control.
- **M4: stop-sell (already outside this decision).** Not recommended or requested; D17 keeps it as a separate authorization.

**Order of use:** read P, C, S first; if P1 is confirmed, M1 is the first mitigation (it removes the one finding that becomes Critical later); if C1 is confirmed, M2; M3 follows as the permanent fix.

### 16.13 D7 audit: Settings → Billing & Payouts → Change Plan and Open Billing Portal (read-only, 2026-10-25)

> **Scope and method.** Read-only code audit of `origin/main` and `origin/release/pricing-p1` (`4bc938c6`, the deployed production branch). No code, Stripe, database, environment, deployment or subscription change was made, and the grandfathered subscription was not touched. Every statement is labelled **VERIFIED (code)**, **INFERRED** (follows from code plus documented Stripe/Next.js behavior, not observed at runtime) or **UNVERIFIED (live configuration or runtime)**. The owner reported that **Open Billing Portal is currently nonfunctional**; that report is treated as an observation about production, and Change Plan is assessed separately.

#### 16.13.1 Main versus production

**VERIFIED (code):** the three files at the center of this audit are **byte-identical** on both refs (same git blob ids): `src/app/app/settings/billing/page.tsx`, `src/app/api/billing/checkout/route.ts`, `src/app/api/billing/portal/route.ts`. A diff of the remaining billing code between the refs shows differences only in the SMS-credit and SMS-limit routes (new on main), a seven-line SMS import in the webhook route, and a refactor of the flag helpers (`isFounderPricingActiveIn`, `isRegularPricingActivated(env)`) that does not change behavior. **Everything below therefore holds for production as deployed** (`release/pricing-p1`), not only for main. No finding in this section depends on main being deployed.

#### 16.13.2 Verified Change Plan workflow map

| Step | Where | Behavior | Status |
|---|---|---|---|
| 1 | `settings/billing/page.tsx` `PlanCard` (about lines 983–1095) | The card button label is **"Current Plan"** (disabled) when `currentPlan.code === plan.code`, **"Change Plan"** when the studio has a managed subscription (`active`, `trialing`, `past_due`, `unpaid`), otherwise "Start {plan} Trial". It is a plain HTML `<form action="/api/billing/checkout" method="post">` with hidden `planCode`, `path`, `entry`, and a **hardcoded** `billingInterval=month`. No JavaScript handler, no confirmation step, no price or proration disclosure beyond the displayed monthly price. | **Implemented, functional as a navigation, but it is not a plan change** |
| 2 | Displayed price | `resolveDisplayedMonthlyPriceCents(plan)` returns the Founder `amountMonthlyCents` while `isFounderPricingActive()` (default **true**; false only if `NEXT_PUBLIC_FOUNDER_PRICING_ACTIVE` or `FOUNDER_PRICING_ACTIVE` is the string `"false"`), otherwise `regularAmountMonthlyCents`. It reads the static `plans.ts`, never Stripe, and never the studio's own subscription. | Functional; **a display, not an entitlement** |
| 3 | `api/billing/checkout/route.ts` `handleCheckout` (POST and GET both accepted) | Validates `planCode` against `plans.ts`; requires a signed-in user; requires current legal acceptance; resolves the **current studio server-side** (`getCurrentStudioContext`); requires `canManageWorkspaceSubscription` (studio owner, organizer owner, or platform admin); reads the studio, the active `subscription_plans` row and `studio_billing_customers` with the service role; rejects an audience mismatch. | Implemented, functional |
| 4 | Same route, price resolution (`resolveCheckoutPriceId`) | Monthly studio plans use `selectStudioMonthlyPrice` (fail closed, no fallback among Founder, standard and database Price ids). **This runs before the managed-subscriber branch, but its result is used only to build the success message** for a managed subscriber. | Functional |
| 5 | Same route, managed branch (about lines 512–541) | `getManagedStripeSubscription` lists the customer's subscriptions (`status: all`, limit 20) and takes the first with status `active`, `trialing`, `past_due` or `unpaid`; a studio-row fallback (`stripe_subscription_id` plus managed status) also counts. If managed, the route **creates a Stripe Billing Portal Session** (customer and `return_url` only, **no configuration id, no flow data, no target price**) and 303-redirects to it. **The selected plan is not passed to Stripe and not recorded anywhere.** | **Partial: a redirect to the generic portal; the clicked plan is discarded** |
| 6 | Same route, new-subscription branch (about lines 543–648) | Reached only when there is **no managed subscription** (including `canceled`, `incomplete`, `incomplete_expired`, `paused`). Requires a Price id; verifies the Stripe Price amount for monthly studio plans; creates a **Checkout Session in `subscription` mode** with `payment_method_collection: always`, **`allow_promotion_codes: true`** and **`trial_period_days` = the plan trial (30) on every session**; 303-redirects to Stripe. | Functional; this is the **only** place DanceFlow code starts a SaaS plan subscription |
| 7 | Anywhere in `src` | **No `stripe.subscriptions.update`, no subscription-item swap, no subscription schedule and no `proration_behavior` exists for SaaS plan subscriptions.** The `subscriptions.update` calls in `app/memberships/actions.ts` are student memberships on connected accounts and are unrelated. The add-on routes only create or delete subscription items for Organizer Suite and AI credit packs. | **A DanceFlow-controlled plan change does not exist.** |
| 8 | Webhook `api/payments/webhook/route.ts` | A plan changed in the Stripe portal is observed only through `customer.subscription.updated`; the plan is re-resolved from the Price id (`resolvePlanCodeFromEnvPriceIds`) before `metadata.planCode`. `studios.billing_plan` is never written (known gap, BILLING-QA #335). `syncStudioBillingSnapshot` nulls `trial_ends_at`. | Functional for recognition; no eligibility check |

**Classification of Change Plan:** *implemented, functional as a form, but partial.* For a managed subscriber it **never performs a plan change itself**. It opens the generic Stripe Billing Portal. Whether a live plan change can complete therefore depends **entirely** on the live portal configuration (Check P, §16.11), which is **UNVERIFIED**. For a studio with no managed subscription it starts a new Checkout (new trial, possibly a new Founder allocation), which is a purchase, not a change.

**Direct API call.** A caller cannot choose a different studio (the studio comes from the session) and cannot reach another customer's portal (**VERIFIED**: PAY-DC-4A tests pin the portal customer to the server-written `studio_billing_customers` row). A direct POST of any valid `planCode` (including a Founder plan) is not blocked by anything on the "available plans" screen, because that screen is not an authorization layer; but for a managed subscriber it only yields a portal redirect, and for an unmanaged studio it yields the same Checkout the UI would. **VERIFIED:** the UI "available plans" list (`visiblePlans`, filtered by audience only) is cosmetic.

#### 16.13.3 Open Billing Portal: separate root-cause analysis

**Handler chain (VERIFIED).** The button is `<form action="/api/billing/portal" method="post"><button type="submit">Open Billing Portal</button></form>`, rendered twice in `page.tsx` (hero card about line 1658 and the subscription card about line 2010), **only when** `hasManagedSubscription && studio.stripe_customer_id` (the `studios` column). There is no client JavaScript and no `disabled` attribute. The only other code path that opens a portal is the managed branch of the checkout route (above). Both create a session with the same minimal arguments. Neither is intentionally disabled and no feature flag guards the button.

**Candidate causes, ranked by evidence:**

| # | Candidate | Evidence | Classification |
|---|---|---|---|
| A | **Wrong redirect status for a form POST.** `portal/route.ts` ends with `NextResponse.redirect(portalSession.url)` (and its two error redirects) with **no status argument**. `NextResponse.redirect` defaults to **307**, which instructs the browser to **repeat the POST (method and body) to the new URL**. Stripe's portal session URL is a page that expects a GET. The checkout route, by contrast, passes `{ status: 303 }` on every redirect (`billingRedirect`, the portal redirect, the Checkout redirect), which converts the follow-up to GET. `portal/route.ts` is the **only** billing route that omits it. The unit test (`portalCustomer.paydc4a.test.ts`) asserts the customer id and never the status or method, so it cannot catch this. | **Code-verified defect and the leading, probable cause. Runtime effect UNVERIFIED** (not reproduced; the owner-run reproduction below separates it). Not labelled confirmed. |
| B | **Browser-visible failure is silent or generic.** The route's catch-all redirects to `?error=billing_portal_failed`, and a missing customer redirects to `?error=billing_customer_missing`. **Neither code is in the page's `getErrorMessage` map**, so both render the generic "Something went wrong while loading billing." Because those error redirects are also 307 POSTs to a page route, the user may see an error page or a reload with no explanation. | Code-verified: the two codes are absent from the message map. Nothing is logged by the route (`catch {}` discards the error) so server logs cannot distinguish causes. | **Confirmed defect (observability), independent of A** |
| C | **Stripe rejects `billingPortal.sessions.create`** because no default portal configuration is saved in the Live account (Stripe returns an error telling the account to configure the portal) or the API key lacks the permission. The route would take the `catch` and redirect to `billing_portal_failed`. | Not verifiable from code. The Live portal state is Check P. | **UNVERIFIED (live configuration)**; evidence is the Stripe Dashboard and the Stripe request log (a `POST /v1/billing_portal/sessions` with an error response) |
| D | **Identity mismatch between button and route.** The button needs `studios.stripe_customer_id`; the route reads `studio_billing_customers.stripe_customer_id`. A studio with the first and not the second renders a button that always ends in `billing_customer_missing`. | Code-verified difference; data effect UNVERIFIED per studio | **Possible for individual studios; not a global cause** |
| E | **Authorization.** The route redirects non-owners to `/app` silently. The button is shown to anyone who can see the page. A non-owner would see a button that appears to do nothing. | Code-verified (`canManageWorkspaceSubscription`) | **Possible only for non-owner roles; does not explain an owner failure** |
| F | **Environment.** `getStripe()` needs the Stripe secret key; `NEXT_PUBLIC_APP_URL` is used only for `return_url`. Missing keys would also break checkout, which the owner reports is not the case for the PRICING-P1 smoke tests. | Not testable here | **Unlikely; UNVERIFIED** |
| G | **Routing or an unfinished page.** The route exists on both refs, is exported as `POST`, is rate limited (10 per 10 minutes per IP, in-memory) and has a test. | Code-verified | **Ruled out as a code-routing cause** (rate limiting could cause a 429 body on repeated clicks and would not be explained by the error map either) |

**Honest status:** A is the only candidate that both exists in code on production and would make a *working* Stripe session appear broken for every owner. It is a defect worth fixing regardless. It is **not confirmed as the production cause** until the owner-run reproduction below, because C is independent and could coexist. No cause is claimed confirmed.

**Owner-run, read-only reproduction (nothing is changed; it uses a studio you own, and does not complete a Stripe change):**
1. Open the billing page, open the browser developer tools Network tab, click **Open Billing Portal**.
2. Record for the `portal` request: the status code (307, 303, 4xx, 5xx), the `Location` header host only (not the full URL), and whether the *next* request to `billing.stripe.com` shows method **POST** and its status (a POST to Stripe's page, or a 405 or 404 from Stripe, would confirm A).
3. In the Stripe Dashboard (Live mode) → Developers → Logs, filter `POST /v1/billing_portal/sessions` around the click time; note whether it returned 200 or an error message (an error here confirms C; a 200 with a following failed page load supports A).
4. Report only status codes and the Stripe error text, no URLs containing tokens.

#### 16.13.4 Entitlement and tenant-authorization assessment

| Question | Finding | Status |
|---|---|---|
| Studio identity is server-derived | Studio comes from `getCurrentStudioContext()` (session), never from the form | **VERIFIED** |
| Role required | Studio owner, organizer owner, or platform admin on both the checkout and portal routes (LAUNCH-SEC-2A) | **VERIFIED**; the *button* is not role-gated, only the route |
| Portal customer ownership | Customer comes from `studio_billing_customers` via the service role (PAY-DC-4A); the checkout route uses the same row then `studios.stripe_customer_id`; a customer id is never taken from request input | **VERIFIED** |
| Subscription ownership | A studio's managed subscription is discovered by listing **its own customer's** subscriptions; there is no path to another customer's subscription | **VERIFIED** |
| Cross-tenant plan change by direct API | Not possible via these routes (studio and customer fixed server-side) | **VERIFIED** |
| Rate limiting | Checkout and portal are limited per IP, in memory (per serverless instance, so a soft control) | **VERIFIED** (weak) |
| Entitlement to a tier | Nothing in `settings/billing` or the routes checks Founder ledger eligibility, which does not exist | **VERIFIED: not enforced** |
| Platform admin acting for a studio | The admin acts on the studio in their current context | **VERIFIED**; audit trail of who changed the plan is not recorded |
| Concurrency | No idempotency key and no lock on checkout or portal creation; a double click on an unmanaged studio can create two Checkout Sessions, and a studio whose subscription is `paused`, `incomplete` or `canceled` is treated as **unmanaged**, so Change Plan can start a **second** subscription | **VERIFIED (code)**; duplicate-subscription outcome INFERRED |

#### 16.13.5 Founder versus Regular price-selection risks

1. **Regular subscriber selecting a Founder Price.** *Through DanceFlow routes:* **not possible for a managed subscriber**, because the route never passes the chosen plan to Stripe. *Through Checkout (unmanaged):* the price comes from `selectStudioMonthlyPrice` using the global flag, so while `FOUNDER_PRICING_ACTIVE` is not `"false"`, **every new checkout is Founder-priced regardless of studio eligibility** (confirmed earlier, §2). *Through the portal:* **UNVERIFIED**; possible only if the live portal has **Switch plan On** with a Founder Price listed (P1).
2. **Global flag effect on existing subscribers.** `isFounderPricingActive()` affects the *displayed* price and the price on *new* checkouts, not existing subscriptions. Flipping the flag would change what the Change Plan screen advertises while the subscriber's real price is unchanged: **a display mismatch risk for existing subscribers**, not a charge. The displayed price never reflects what the studio actually pays (Founder, grandfathered $129, or discounted).
3. **Displayed versus charged.** For new checkouts the Stripe Price amount is verified against the expected amount (monthly studio only). The yearly path takes the DB price id with **no amount check**, but the UI hardcodes `month`; a direct POST with `billingInterval=year` reaches it (**VERIFIED**; effect depends on whether yearly prices are populated, see §7).
4. **Trial.** Every new Checkout carries a 30-day trial; a canceled, paused or incomplete studio is "unmanaged" and gets a **new trial** through Change Plan or Start Trial. This contradicts the D5(c) rule (no second trial) until the ledger exists (**VERIFIED (code)**).
5. **Proration and anchors.** Not controlled by DanceFlow at all. Any proration is whatever the live portal does if Switch plan is On (**UNVERIFIED**); the webhook neither detects nor classifies prorated invoices, which is relevant to the D13 rule that prorations are not paid periods (R29).
6. **Status/trial display.** `syncStudioBillingSnapshot` nulls `trial_ends_at` after sync; a plan change in the portal during a trial has no DanceFlow handling (**UNVERIFIED** for portal behavior).

#### 16.13.6 Grandfathered $129 Pro protection

- **Identification (VERIFIED):** the grandfathered Price `price_1TdDHwEY0sTayNiSIe1nD3Lg` is held in `STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY` (Production only) and exists in `main` only in the runbook. **No application code references the legacy Price.** `resolvePlanCodeFromEnvPriceIds` recognizes it as Pro for plan resolution, but nothing else treats it differently: no flag on the studio, no ledger row, no UI cue.
- **Change Plan exposure.** If that studio clicks Change Plan: it is managed, so it goes to the portal. Outcome is determined by the portal configuration (**UNVERIFIED**): with Switch plan On and a listed Price it could move to another Price and **permanently lose $129**; with Switch plan Off it can only cancel, update payment, or view invoices.
- **Cancel then return.** Cancel is possible through the portal if enabled. After cancellation the studio is *unmanaged*, so the next Change Plan or Start Trial click goes to a **new Checkout at the current Founder Pro price ($159 per the PRICING-P1 table) with a new 30-day trial**: the $129 terms are **lost silently** and a second trial is granted. This is a **VERIFIED code path**; whether the studio actually did cancel is a separate fact.
- **The original contract's cancellation and reactivation terms are not assumed.** The audit recommends the owner locate and state them before any enforcement (§16.8 O-items, new O9).
- **Safeguards recommended (design, not implemented):** a server-side registry of protected subscriptions (identified by studio and subscription id, never by price alone); Change Plan disabled and replaced by a "contact support" path for those studios; an explicit warning and confirmation screen before any cancel or return for a protected studio; the new 12-month policy is never applied to them (§4, D5(f)). **No mutation of the subscription is proposed here.**

#### 16.13.7 Verified code behavior versus unverified live configuration

| Item | Status |
|---|---|
| Change Plan sends managed subscribers to the generic portal and discards the selected plan | **VERIFIED (code, both refs)** |
| No DanceFlow-controlled subscription update exists | **VERIFIED (code, both refs)** |
| Portal route returns a default (307) redirect; every other billing route uses 303 | **VERIFIED (code)** |
| 307 on a form POST breaks the Stripe hand-off | **INFERRED** (documented browser/HTTP semantics); production effect **UNVERIFIED** |
| Portal error codes missing from the page's message map | **VERIFIED (code)** |
| Tenant and customer binding of both routes | **VERIFIED (code and tests)** |
| Portal Switch plan, Manage downgrades, Use promotion codes, payment-method update, cancellation settings | **UNVERIFIED (Check P)** |
| A saved Live default portal configuration exists | **UNVERIFIED** |
| Coupons and promotion codes that can reduce a Founder price | **UNVERIFIED (Check C)** |
| Count of Founder-priced subscriptions | **UNVERIFIED (Check S)** |
| Whether the grandfathered studio has taken any action | **UNVERIFIED; not inspected** |
| Proration, billing anchor and trial behavior of a portal-driven change | **UNVERIFIED** (needs a test-mode proof, O6-style) |

Configuration-dependent findings are not vulnerabilities until Checks P and C return. Nothing in this table is a claim that production is currently exploited.

#### 16.13.8 Recommended billing-management architecture

| Option | Description | Assessment |
|---|---|---|
| **A (recommended)** | **Repair the portal for payment methods, invoices and billing details, while DanceFlow owns plan selection.** The portal is configured (account-wide, one saved configuration) with **Switch plan Off** (or no Founder products listed), **Use promotion codes Off**, **Payment methods On**, **Invoice history On**, and cancellation set per the O-decisions. A DanceFlow server action performs approved plan changes. | Matches D7 and the owner's stated preference; reuses the existing portal route, `canManageWorkspaceSubscription`, the webhook and `plans.ts`. |
| B | Remove the portal button and handle all billing in DanceFlow. | Rejected: DanceFlow would have to build payment-method updates, invoices and card retry recovery, which D2/O2 need working; high cost, no benefit. |
| C | Use Stripe Customer Portal **deep-link flows** (`flow_data`, for example `subscription_update_confirm` pinned to one target Price, or `payment_method_update`) created per request from the DanceFlow server. | A good hybrid *for the confirm step*, because the server chooses the target Price and Stripe shows the proration preview. **Constraint:** a flow requires the portal configuration to allow the corresponding feature, so a pinned update flow needs Switch plan enabled in the configuration; account-wide that re-opens the P1 exposure. **Unless a second configuration can be used for plan updates only** (the API accepts a `configuration` id), C is not safe. Recommended only after an isolated test-mode proof (O6). |

**Recommended design (Option A, not implemented):**
1. **Portal route:** keep, with 303, with logged and specific error handling, passing an explicit configuration id from an environment variable so that the plan-switching configuration is never the default.
2. **Plan change = DanceFlow server action** (`/api/billing/plan-change`, owner role, studio from session): load the studio's subscription from Stripe (not from the request), verify the studio's ledger entitlement (R19–R25 once built) and that the target Price is permitted for that studio's class (Founder, Regular, protected, Organizer), compute and show the price, proration preview (Stripe upcoming invoice) and disclosure, require an explicit confirmation token, then call `subscriptions.update` (single-item swap, `proration_behavior` chosen by the design slice, `trial_end` preserved, no new subscription, idempotency key from studio and request id), then write an audit row (before and after Price ids, actor, request id). Founder-to-Founder keeps the allocation; Founder-to-Regular needs the O6-proven mutation and a stronger confirmation (R31).
3. **Change Plan button:** points to the new server action for managed subscribers; unmanaged flows keep Checkout through the existing reservation design (§16.5).
4. **Webhook:** unchanged for recognition; adds an exception row (R23) for a Founder Price on a studio with no entitlement.

#### 16.13.9 Narrowly scoped remediation slices (independent, none authorized)

| Slice | Content | Depends on | Hosted step | Tests |
|---|---|---|---|---|
| **D7-1 (portal fix)** | `portal/route.ts`: 303 on all three redirects; log the caught error server-side without secrets; add `billing_portal_failed` and `billing_customer_missing` messages to the page map; align button visibility with the route's customer source; optional `configuration` id from env | Owner reproduction (§16.13.3) to confirm A before the PR is described as a fix | None (code only); release from the isolated release branch, own approval | Unit: status is 303 for success, missing customer and failure; error codes rendered; non-owner sees no button |
| **D7-2 (disclosure and guard)** | Replace "Change Plan" for managed subscribers with an honest label and explanation until D7-3 exists; show the studio's actual current plan and price (not the global-flag price); never claim a change was made | None | None | Snapshot of the labels; display uses the subscription's Price, not the flag |
| **D7-3 (plan-change service)** | The §16.13.8 server action and audit table | Ledger (S-series), O6 proof, Check P | SQL (audit table) before app | See §16.13.11 |
| **D7-4 (protected subscription registry)** | Grandfathered $129 identification and Change Plan/cancel/return safeguards | Owner statement of the original terms (O9) | SQL | Protected-studio tests |
| **D7-5 (portal configuration)** | The M1 portal setting and a pinned configuration id | Check P | Stripe setting change, own approval, rollback by restoring the prior setting | Owner-run read-back |
| **D7-6 (webhook hardening)** | Founder Price without entitlement raises an exception; `billing_plan` written; prorated invoices classified | #335 | none | See #335 and §16.13.11 |

Each slice is independently releasable and independently revertible; D7-1 and D7-2 need no Stripe or database change.

#### 16.13.10 BILLING-QA dependencies

| PR | Relevance to D7 | Interaction |
|---|---|---|
| **#334** (draft; Stripe test-mode E2E spec) | Provides the harness to prove portal/Checkout behavior in test mode (the O6 and Switch-plan proofs) | D7-3 and the portal proof run on it; do not merge D7 work ahead of it |
| **#335** (draft; webhook ordering, `billing_plan` and trial sync, unowned subscriptions; stacked on #334) | Edits `webhook/route.ts` and `ownershipFakes.ts`, which D7-6 and #292 also touch | D7-6 rebases onto #335; coordinate with #292 |
| **#336** (draft; dark platform-admin price-config report) | The report that shows which Prices exist and are mapped; supports Check S counts | Read-only; D7-5 verification can reuse it |
| **#340** (draft; owner-run no-payment smoke kit, stacked on #336) | Extends read-back to the live key; useful for a portal-configuration read-back | Edits `priceVerifier.ts`, `report.ts`, `docs/qa/billing-qa.md` together with #336 |

All four stay untouched by this documentation update; #332 is merged.

#### 16.13.11 Tests to require

Founder-to-Founder upgrade and downgrade (same allocation, no second trial, paid-period count unchanged); a Regular subscriber requesting a Founder Price (rejected, audited); a protected grandfathered subscriber attempting a change, a cancel and a return (blocked or warned, terms preserved); trial preservation (no new trial, `trial_end` carried); Stripe proration behavior in test mode (amounts, credit, anchor) and that prorated invoices are not counted as paid periods; concurrent plan-change requests (idempotent, one subscription update); tenant isolation and direct-API authorization (other studio, non-owner, no session); portal success (303, GET follow-up), missing customer, Stripe failure, and visible error messages; price disclosure and an explicit confirmation requirement; and a `paused` or `incomplete` studio not receiving a second subscription.

#### 16.13.12 Updated D7 requirements and owner decisions

R29–R33 stand. The audit adds **R34–R38** (§13). Remaining owner items: **O8** (approve D7-1 and D7-2 as the first, no-Stripe, no-database code slice, after the owner-run reproduction); **O9** (state the original cancellation and reactivation terms of the grandfathered $129 contract, or authorize a read-only look at its documents); **O10** (portal configuration: choose between Option A with the portal's Switch plan Off and Option C with a second pinned configuration, after Check P and an isolated proof); **O11** (until D7-3 exists, whether plan changes are handled by support on request). Checks P, C and S results are still outstanding and gate D7-5.

## Standing non-claims

This report does not state that production enforces any Founder-cap, duration, renewal, annual or early-access rule: it does not. Existing documentation that implies "limited", "first 25" or "12 months" describes intent or copy, not behavior.
