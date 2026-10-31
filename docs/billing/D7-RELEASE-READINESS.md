# D7 billing stack: production-release readiness report

**Status: readiness analysis only. Nothing in this document is authorized.** No migration, environment change, deployment, promotion, Stripe change, registry insert or live smoke test is approved by it. Each step below needs its own explicit owner approval at the time.

Prepared 2026-10-30. Source of truth for policy and decisions: `docs/billing/FOUNDER-PRICING-POLICY-GAP-REPORT.md` (PR #343, docs only). Release mechanics follow `docs/billing/PRICING-P1-RELEASE-RUNBOOK.md`.

## 1. What is merged, and what is live

| Item | State |
|---|---|
| #345 D7-1/D7-2 (portal 303, errors, honest plan-change CTA) | merged to `main` as `60027786` |
| #346 D7-3a (managed / paused / incomplete fail-closed checkout) | merged to `main` as `bef70ee4` |
| #351 D7-4 (protected-subscription registry migration + checkout guard) | merged to `main` as `512fd7d2` |
| **Production** | **runs `release/pricing-p1` (`4bc938c6`), which contains none of the above.** `main` has not been promoted and must not be: it carries unrelated work (Twilio TW-4F, Competition OS, BILLING-QA tooling) |
| Registry migration `20270201090000` | **not applied to any hosted database** (validated only in disposable local databases) |
| Registry record for the grandfathered $129 Pro | **does not exist** |
| Grandfathered-subscription protection | **NOT ACTIVE anywhere** |

## 2. Release approach (to be approved separately)

The D7 stack is billing-only: the three squash commits cherry-pick **cleanly** onto `release/pricing-p1` (verified locally on 2026-10-30, nothing pushed): on that tree 193 billing tests passed, `tsc` was clean, eslint reported 0 errors, and only billing files and the new migration changed (17 files).

Recommended: a new isolated release branch off `release/pricing-p1` containing exactly those three commits (and nothing from `main`), built as a staged, not-promoted production deployment, then promoted only after SQL, verification and approvals below. Do **not** push a branch merely to start a build without approval. Branch preview environments share the PROD Supabase project, so previews must not be exercised for authenticated flows.

## 3. Production prerequisites (all OPEN)

Every item is open, needs the named approval, and must be recorded when done.

| # | Prerequisite | Why | Approval / evidence needed |
|---|---|---|---|
| P1 | **O9: verify the original $129 Pro contract terms** (cancellation, reactivation, price and trial rights). **Owner decision recorded 2026-10-30 (section 8):** $129 protected for 12 paid months after the 2026-07-09 trial end (to 2027-07-09), then the then-applicable regular Pro rate with advance notice; not permanent. Original terms and billing-period boundaries are still to be verified | The registry blocks new Checkout for a protected studio and routes to support; what support may then offer is defined by the terms. The decision states the intended terms, but the original terms and actual billing periods are not yet verified | Owner-run read-only Stripe evidence (`docs/billing/O9-EVIDENCE-CHECKLIST.md`); record the document reference (this becomes `terms_reference`); where original terms cannot be established, report "not established" and record the dated owner decision as the operative term |
| P2 | **Identify the correct studio and Stripe subscription** for the grandfathered subscriber (studio id, `sub_` id, customer id, price `price_1TdDHwEY0sTayNiSIe1nD3Lg`) | The registry is keyed by studio and subscription id, never by price alone | Read-only Stripe Dashboard/DB check by the owner or an authorized read; no mutation of the subscription |
| P3 | **Apply the registry migration, environment by environment** (DEV, then PROD) | The table does not exist hosted; until it does, only the legacy-price backstop can protect | Separate approval per environment; **SQL before app**; re-run the isolated chain validation immediately before (the last run ended at `20261231090000`; `20261231100000_twilio_pilot_spend_hardening.sql` merged afterward); pre/post-flight and fingerprints per the runbook; rollback file `rollback/20270201090000_billing_protected_subscriptions_rollback.sql` refuses while rows exist |
| P4 | **Insert the correct registry record** (`grandfathered_founder_legacy`, `terms_reference` from P1) | The registry row is the authority; rows are permanent evidence (no delete, no truncate; release is audited) | Separate approval; one audited insert after P1-P3; read back; never infer the studio from the price |
| P5 | **Configure and verify `STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY`** in the applicable environment (Production; Preview only where intended) | It is the backstop signal (any subscription status on any known customer carrying that price blocks a new Checkout). Unset means the backstop is off and a warning logs on every checkout. It must NOT equal a current Founder/standard Price (the code drops such ids rather than block every customer) | Separate approval for the env change; locked values cannot be read back, so verify by name-only listing, by the BILLING-QA price-config report if it covers the variable, and by an owner-run no-payment check that does not create a subscription |
| P6 | **Stripe Check P: live billing-portal configuration** | If Switch plan is on with Founder or Regular Prices listed, or Manage downgrades is on, a portal change bypasses DanceFlow (the checkout guard does not cover the portal) | Owner-run read-only Dashboard check (instructions in the gap report, section 16.11); any change (M1) needs its own approval; target state per O10: plan switching and promotion codes off |
| P7 | **Stripe Check C: coupons and promotion codes** | `allow_promotion_codes` is still on in checkout; an unrestricted code could discount a Founder price | Owner-run read-only check; archive of a specific code (M2) and the checkout change (M3) are separate approvals |
| P8 | **Stripe Check S: Founder-priced subscriptions by Price** | D17 monitoring baseline; the 25-studio cap is not enforced in code | Owner-run read-only counts |
| P9 | **Live portal-click reproduction** | The 307-on-form-POST defect is code-verified and reproduced locally but is not confirmed as the production cause | Owner-run Network-tab check and Stripe request log (gap report section 16.13.3); this also decides whether the portal button is fixed by this release or needs a configuration change |
| P10 | **Release controls for the concurrent-checkout and repeat-trial exposures** (section 5) | Not closed by the code | Approved control plan in place before promotion |
| P11 | Real-browser check of the mailto and 303 hand-off on the staged deployment | Only rendered markup and unit tests exist | Authenticated, owner-run, no-payment check on the staged deployment URL |
| P12 | Release branch, staged build, promotion, rollback target | Production is not `main` | Separate approvals; rollback target is the current production deployment of `release/pricing-p1` |

## 4. Sequence (when each step is separately approved)

1. P1, P2, P6-P9 (read-only, owner-run) -> record results.
2. P3 on DEV; verify; then P4 on DEV only if a DEV subscriber exists, otherwise skip; verify the guard with test data.
3. Build the isolated release branch; staged deployment, **not promoted**.
4. P3 on PROD (SQL before app), pre/post-flight; then P4 (registry record) and P5 (env) with read-back.
5. Promote the staged deployment; P11 checks; observe.
6. Release the monitoring controls in section 5.

**Rollback:** application first (restore the previous production deployment), then SQL only if needed. The checkout code tolerates a missing registry table, so the app can be rolled back without touching the database. The SQL rollback refuses while registry rows exist: release or keep rows deliberately, never delete.

## 5. Documented release controls for the unclosed exposures

| Exposure | Why code does not close it | Interim control until the Founder ledger / allocation design ships |
|---|---|---|
| **Concurrent checkout** (two Checkout Sessions opened before either completes can both complete: two subscriptions, two trials) | No lock, no open-session check, no idempotency key | Owner-run daily check during the Founder campaign for customers with more than one non-terminal subscription (Stripe Dashboard); support handles any duplicate by refund or cancel with explicit owner authorization (no automatic cancel); the future fix is an advisory lock plus an open-session check keyed by studio |
| **Repeat trial** (a canceled, non-protected resubscriber gets a fresh 30-day trial) | A studio with only terminal subscriptions is treated as new; stopping this needs a per-studio ledger of consumed trials | Daily Stripe check for customers with a second trial; support-only reactivation messaging; governed by D5(c) and the Founder ledger slice |
| Protected studio under a **new workspace** (new studio id) | The guard is per studio | Support-assisted onboarding for the grandfathered subscriber; owner awareness |
| Portal cancel or switch of a protected subscription | The guard covers Checkout, not the portal | P6 portal configuration; webhook alert on cancel or reprice of a registered subscription is a future slice |

## 6. No-go criteria

Do not promote if: P1-P5 are not all complete and read back (or the owner explicitly accepts running with the backstop only); the chain re-validation fails; P6 shows plan switching on with Founder or Regular Prices listed and no approved mitigation; the staged deployment's P11 check fails; or any required CI/preview on the release branch is not green.

## 7. Known advisories carried forward

A stale non-primary Stripe customer id could make a normal studio's checkout fail closed (follow-up: treat a missing-resource error on non-primary ids as no subscriptions); the "backstop is off" warning is noisy until P5 is done; the missing-table tolerance should be removed after the table exists in PROD; right after the migration a stale PostgREST schema cache can briefly look like a missing table; the billing page is advisory (local status only).

## 8. O9 owner policy for DanceAbel Ballroom Studio (2026-10-30) and what it requires

**Status: owner-confirmed policy, recorded. Not implemented. Not verified against Stripe. Nothing here authorizes a Stripe, registry, entitlement, schedule, data, notification or deployment change.**

### 8.0 How to read this section

| Label | Meaning |
|---|---|
| **OWNER-CONFIRMED** | Stated by the owner in chat on 2026-10-30. It is policy to implement. It is not evidence about what Stripe or any agreement contains. |
| **CODE-VERIFIED** | Read from `origin/main` `75c4b28b` on 2026-10-30 (read-only). |
| **PROBE-VERIFIED** | Read-only production catalog probe on 2026-10-30 (object existence and counts only). |
| **UNVERIFIED** | Not yet checked against Stripe, the hosted databases or any agreement. Listed in the evidence checklist. |

Nothing in sections 8.1 and 8.2 has been matched to a Stripe record yet.

### 8.1 The policy (OWNER-CONFIRMED)

**Pro pricing**
- $129/month for the first 12 paid months beginning July 9, 2026.
- Grandfathered pricing ends **July 9, 2027**.
- The subscription then transitions to the then-applicable regular Pro rate, **with advance notice**. It is not a permanent concession.

**Organizer Suite**
- Included at no additional charge during the grandfathered period.
- The complimentary entitlement **expires July 9, 2027**.
- From July 9, 2027 Organizer Suite requires a **separately purchased paid add-on**.
- If the add-on is not purchased, Suite access **must end** when the complimentary entitlement expires.
- Historical Organizer Suite data is **preserved**. It is never deleted when access expires.
- The system must **not** automatically purchase the add-on, charge the studio, or silently extend complimentary access.

**Founder allocation**
- DanceAbel keeps its existing Founder position (1 of the 25). The cap allocation is not reopened.

**Now**
- Nothing is changed on the existing Stripe subscription or on any entitlement.

This supersedes two earlier statements: the gap report's working assumption that this subscriber is "permanently excluded" from the 12-month rule, and the earlier readiness draft's "Suite post-period treatment is an open owner decision". Both are now decided. The gap report (#343) text should be reconciled in a separate docs update (G8).

### 8.2 Two protections, independently identifiable

The pricing grandfather and the complimentary Suite entitlement **share an expiration date but are separate protections**. Each needs its own record, its own end date, its own audit trail and its own transition. A shared "protected until" value is a defect.

| | Price grandfather | Complimentary Organizer Suite entitlement |
|---|---|---|
| What it is | $129/month Pro rate | No-charge Suite access |
| Ends | July 9, 2027 (confirm against verified billing periods) | July 9, 2027 (exact instant not yet defined: see G10) |
| At the end | Moves to the then-regular Pro rate after advance notice | Access ends unless a separately purchased paid add-on is active |
| If the customer does nothing | The new rate applies after notice | Access ends. Never auto-purchased, auto-charged or silently extended |
| Data | Not applicable | Historical data preserved; only access ends |
| Where it can live | `protected_subscriptions` registry (dated end needs a design: G1) | `usage_addon_entitlements`, source `manual_grant`, with `period_start`, `period_end`, `notes` (expiry enforcement needs a design: G3) |
| Must not be | Merged into the entitlement record | Merged into the pricing record, or into a paid add-on row |

### 8.3 Existing code and schema (CODE-VERIFIED, `origin/main` 75c4b28b)

1. The registry (`protected_subscriptions`) records a kind, immutable identity and terms fields, a `terms_reference` and a one-time audited release. **It has no end date, no notice record and no feature dimension.** Protection is by existence, so it would last until the row is released.
2. Checkout refuses a protected studio and any legacy-priced subscription. **No code moves an existing subscription to another price.** There is no price-transition mechanism.
3. Suite access (`src/lib/billing/access.ts`) is granted when `usage_addon_entitlements` has `feature_key = organizer_suite`, `status = 'active'` and `source` in (`stripe_subscription_item`, `manual_grant`). **The check ignores `period_end`, and nothing sets expired rows to `expired`.** An active grant row never lapses on its own: **by default the system silently extends complimentary access forever**, which is exactly what the policy forbids.
4. `usage_addon_entitlements.status` allows `active`, `canceled` and `expired`, and the table has `period_start`, `period_end`, `source` and `notes`, so an expired state and a dated grant can be represented without a schema change. There is **no audit or event table** for entitlement changes.
5. The Suite add-on checkout (`/api/billing/addons/organizer-suite/checkout`) requires an active or trialing studio subscription, looks only for an existing active row with `source = stripe_subscription_item`, so a `manual_grant` row does **not** short-circuit a paid purchase. It then adds a Stripe subscription item with no proration and upserts the entitlement on `stripe_subscription_item_id`. A paid add-on row would therefore coexist with the grant row.
6. The Stripe webhook (`syncOrganizerSuiteAddonEntitlements`) writes Stripe-item Suite entitlements and marks stale `stripe_subscription_item` rows `canceled` when the subscription is **not `active` or `trialing`** (a `past_due` studio loses Stripe-sourced Suite access). A `manual_grant` row is not touched by that sweep.
7. The webhook upserts with conflict target `studio_id,feature_key`. **The repository's migrations define no unique index on that pair** (only on `stripe_subscription_item_id`). Either the hosted databases have an index the repo does not, or that upsert errors; and if such an index exists, a paid add-on would overwrite the grant row, destroying the separate record. **UNVERIFIED** against the hosted catalogs (G4).
8. The Terms (section 5) allow prospective price changes "after providing notice required by applicable law or the applicable order". No notice period is defined in the repo.
9. How DanceAbel's Suite access is provisioned today (Stripe item, coupon, manual grant) is **UNVERIFIED**.

### 8.4 Verification required before any transition is specified (UNVERIFIED items)

1. Stripe: exact trial end, first paid invoice, every paid period in order (paused, failed, voided or credited periods), billing-cycle anchor, schedules, discounts and other items (`O9-EVIDENCE-CHECKLIST.md`, section 1).
2. Whether 12 paid months actually end on July 9, 2027, or on another date. **The effective date is derived from verified periods, not hard-coded.** Where Stripe's boundaries differ from the owner-stated dates, the difference is reported to the owner, not resolved by assumption.
3. How the Suite access is provisioned today, and whether any end date is already recorded.
4. Whether the hosted catalogs have a unique index on `usage_addon_entitlements (studio_id, feature_key)`.
5. Any original agreement or message (checklist section 2). If none exists, "original terms not established"; the dated owner policy is then the operative term and is recorded as such, not as a recovered contract.

### 8.5 Required properties of the transitions (design only; not built)

**A. Price transition**

1. No price change, schedule phase or Stripe edit before the verified period end. A scheduled change takes effect at a billing-period boundary, with no unscheduled proration.
2. A notice record must exist before any transition can be scheduled. No record, no schedule.
3. The rate charged equals the rate disclosed in the notice. "Then-applicable regular Pro rate" is resolved and written into the notice when it is sent.
4. The transition is created only after an explicit owner approval of the verified date, the notice evidence and the rate. It is never automatic.
5. A dry run shows the intended Stripe change before it is made; a read-back compares the result afterward. A failure leaves the subscription unchanged.
6. When price protection ends, the registry row is released through the audited one-time release (reason recorded), or the registry gains a dated end. Otherwise the guard keeps treating the studio as protected.

**B. Complimentary Suite entitlement expiry**

1. **Separate record.** The grant is its own `manual_grant` row with `period_start`, `period_end` and `notes` identifying it as the DanceAbel complimentary grant. It is never merged into the pricing record or into a paid add-on row.
2. **Enforced end.** Access must be denied once the grant has ended even if no job has run: the access check evaluates `period_end` (and the status), not status alone. An expiry job then records the transition.
3. **Safe under retries.** The expiry transition is a conditional update that only affects a row that is still `active` and past its `period_end`, writes one audit record keyed by (entitlement id, transition), and is a no-op the second time. Running it twice, concurrently or after a crash gives the same final state.
4. **Auditable.** Each grant, notice, expiry and any owner-approved exception writes an immutable audit entry (who or what, when, before and after, notice reference). No audit table exists today (CODE-VERIFIED); this needs a design (G3).
5. **Paid add-on respected.** If a paid add-on item is active at expiry, the studio keeps access through that row and only the complimentary grant moves to `expired`. If it is not, access ends. The system never creates the purchase, never charges, and never extends the grant. An extension, if the owner ever wants one, is a deliberate owner action that writes a new, audited grant.
6. **Data preserved.** Expiry changes access state only. No Suite data is deleted, anonymized or detached. What the studio can still see or export once access ends (read-only history versus nothing) is an open owner decision (G11).
7. **`past_due` does not erase the grant.** The webhook sweep acts only on Stripe-sourced rows; whether a protected studio's access should also survive a payment problem is an owner decision (G5).
8. **Exact instant.** The policy gives a date. The enforcement instant (time zone, start or end of the day, relation to the July 9 billing boundary) must be defined once and used by both the access check and the notice text (G10).

**C. Advance-notice and customer-communication workflow** (nothing is sent now; no notification is authorized)

1. One combined notice schedule covers both changes, with each change described separately: the new Pro rate and its date, and the Suite ending unless the paid add-on is purchased, its price, and how to buy it.
2. Notice content: the effective date, the exact rate or price in force from that date, what the studio keeps (data), what ends (Suite access), what to do (purchase the add-on) and whom to contact. It states plainly that nothing is purchased or charged automatically.
3. Timing is a parameter. The minimum notice period under applicable law and the Terms needs owner and legal confirmation. Placeholders for review: a first notice at least 60 days before July 9, 2027, reminders at 30 and 7 days, and a notice that access has ended on the day. A purchase of the add-on suppresses the remaining Suite reminders.
4. Channel: email to the owner of record plus an in-app notice on the billing page. Delivery evidence (sent time, recipient, message id, bounce) is stored per notice.
5. Safeguards: no entitlement or price change may be scheduled unless the matching notice record exists with its delivery evidence; the notice text is generated from the same dates and rates the transition will use; every notice and its suppression is logged; the owner approves the wording and the send.
6. A bounce, a missing record or a changed date stops the transition and alerts the owner. Nothing proceeds on a guess.

### 8.6 Implementation gaps and policy decisions requiring separate authorization

| # | Gap or decision | What would be needed |
|---|---|---|
| G1 | Registry has no price-protection end date, notice state or feature dimension (8.3.1) | A design decision and a new migration (additive columns or a companion table), validated in the isolated chain, DEV then PROD; a decision on whether to add it before the first PROD apply of `20270201090000` |
| G2 | No price-transition mechanism exists (8.3.2) | Owner authorization for a design and implementation slice; Stripe test-mode proof of a subscription schedule that changes price at a period boundary; no live change |
| G3 | No enforced expiry, no expiry job and no entitlement audit (8.3.3, 8.3.4); default behavior is silent extension | A code and data slice: access check honors `period_end`, idempotent expiry job, audit record, tests for retries and concurrency |
| G4 | Unique index on `(studio_id, feature_key)` unverified; if it exists a paid add-on would overwrite the grant row (8.3.7) | A read-only hosted catalog check (needs authorization); then a decision on the entitlement key design so grant and paid rows can coexist |
| G5 | Webhook cancels Stripe-sourced Suite access when the subscription is not active or trialing (8.3.6) | An owner decision on whether the protected studio's access survives `past_due`; a code slice if so |
| G6 | Notice period, channel and wording are undefined (8.3.8, 8.5.C) | Owner and legal confirmation; a template and a delivery-evidence record. Sending any notice needs separate authorization |
| G7 | The "regular Pro rate" and the paid Suite add-on price at the time of notice are not fixed | Owner decision at notice time, recorded in the notice |
| G8 | The gap report's D13 "permanent exclusion" text conflicts with the dated policy | A docs update to PR #343 with owner approval |
| G9 | Original terms, billing periods and Suite provisioning are unverified | Owner-run Stripe and records checks (checklist); optional hosted row reads need their own approval |
| G10 | The exact enforcement instant for July 9, 2027 | **Closed for DanceAbel (owner, 2026-10-31): 2027-07-09T04:00:00Z** = local midnight in America/New_York; see section 10.2 |
| G11 | What the studio may see or export after access ends is undefined (data is preserved) | Owner decision; a code slice if read-only history is wanted |
| G12 | The paid add-on purchase path must be verified as the only way access continues after expiry | Test-mode verification of the add-on checkout for a protected studio; no live charge |

## 9. Refresh findings (2026-10-30, read-only)

- **Repo state:** `origin/main` was `75c4b28b`; production is still `release/pricing-p1` `4bc938c6` (taken from the runbook; the live deployment was not read). The D7 stack is independent of BILLING-QA-3 (#335) and the other `main` commits since `4bc938c6`; the minimal release composition is `4bc938c6` plus the three D7 commits. BILLING-QA-3 is a separate release (its own plan, PR #353); whichever ships second must be rebased onto the first.
- **Dry run on the production base (local only):** the three commits cherry-pick with no conflicts (17 files, identical to `main`); 480 billing and payments tests, `tsc` and eslint pass.
- **Correction to the earlier chain validation:** the earlier "full chain" used `main` migrations on an image that already contained 16 TW-4F migrations production lacks. The correct validation base is the `release/pricing-p1` migration set (`df-isoqa/base:20261119092100`: 200 applied, 22 known-unreplayable skipped) plus `20270201090000`. On that base the 40-check registry script gives 40 PASS, 0 FAIL.
- **Read-only production catalog probe (catalog only, no row data):** the registry table and both functions are absent; `public.studios(id uuid)`, `studio_billing_customers`, `studio_subscriptions` and the `studios` billing columns exist; TW-4 is at `20261119092100` (6 `studio_sms_*` tables, 11 `tw4*` functions, nothing newer); there is no migration-history table. Production has 339 public tables and 522 functions versus 329 and 443 in the local image. The production-only objects come from the 22 migrations the harness cannot replay on its July dump base (Competition 10C/10D, LAUNCH-SEC, payroll 9A to 9C, GC-3.5.2, refund reconciliation). Five old payroll and client-lookup functions and one table (`payment_harness_runs`, defined by no release-branch migration) exist only in the image. **Production is not proven identical to the release-branch migration set.** The registry migration depends only on `studios(id)`, which matches, so the test result is valid for the migration's own behavior but is not a full schema rehearsal.
- **New exposure findings (code review):** the paused/incomplete page gap is more serious than "advisory" (such a studio sees "Start Trial" and no portal button, so it cannot finish payment); checkout logs the raw error object; `GET /api/billing/checkout` creates a session from a cross-site link. Concurrent checkout and repeat trial remain open (specified fixes: open-session check, session `expires_at`, idempotency keys, a duplicate-subscription alert; omit the trial when a listed subscription already had one).

## 10. Verified PROD findings for DanceAbel and delivery status (2026-10-31)

**Status: read-only PROD verification accepted as PASS by the owner. These are verified facts from read-only queries against PROD `hvsujyfbftfffxpfmlpb` (identity and plan link), not changes. Nothing was written to PROD, Stripe or any entitlement.**

### 10.1 Verified (read-only, PROD)

| Item | Result |
|---|---|
| Identity | `RESOLVED` through Stripe customer `cus_Ufmzcd50OuZzmh`: `studios.stripe_customer_id` and `studio_billing_customers.stripe_customer_id` agree on one studio. The name "DanceAbel Ballroom Studio" is corroboration only, never the key. |
| Studio | `dd6c35ce-0765-4247-afc2-9738817e991c`, `pro`, `active`, timezone `America/New_York`, created 2026-06-09. |
| Studio subscription row | 1 row, status `active`, `billing_interval` month. |
| Plan link | `subscription_plan_id` = `b64c268b-5c3f-41ff-9e3b-d7e9e8219cba`; the linked plan row exists: code `pro`, name "Pro". Studio billing plan/status: `pro` / `active`. **PASS.** |
| Manual Organizer Suite grant | Entitlement `095f8801-7d18-4c73-8d0e-141bd93dcbca` (source `manual_grant`, `active`, no `period_start`/`period_end`, no Stripe item, created 2026-07-09 23:41:43Z) belongs to this studio. The other PROD manual grant (`b515dc91-5d28-4c19-90d8-4cd589ad57fe`) belongs to a different, unidentified studio. |
| Effect on event checkouts | The fee check reads the plan through this link, so while the grant is current DanceAbel receives the Pro add-on tier (3%). Private-lesson entitlement enforcement in PR #363 does **not** introduce a DanceAbel plan-link regression. |

### 10.2 Owner-approved policy points recorded here

- Complimentary Organizer Suite access remains valid **through July 8, 2027**.
- **Approved expiry instant: July 9, 2027, 04:00 UTC.** This is local midnight of 2027-07-09 in `America/New_York` (EDT), i.e. exactly what the implemented boundary rule produces for this studio with `period_end = 2027-07-09`. This closes G10 for DanceAbel. The rule remains timezone-based; a change to the studio's timezone would move the instant.
- Continued access after the expiry instant requires a separately purchased paid add-on. No automatic purchase, charge or extension.

### 10.3 Reconciliation items kept separate and OPEN (not evidence of a missing plan link)

1. **One-character mismatch in the Stripe subscription id.** The id previously reported by the owner has a lowercase `l` (U+006C) at position 22 of 28; PROD stores a capital `I` (U+0049) in `studios.stripe_subscription_id` and the `studio_subscriptions` row. The existing evidence does not establish which is authoritative (the owner-supplied id is typed chat text; PROD's value is not proven machine-written). Settling it needs a read-only Stripe retrieval of both candidates or an owner copy from the Dashboard. No PROD record is to be modified to resolve it without separate authorization.
2. **Missing `stripe_price_id` and period dates in the studio subscription row.** The row has an empty `stripe_price_id`, `trial_ends_at`, `current_period_start` and `current_period_end`. PROD therefore does not record the $129 legacy price on this subscription. This does not affect plan resolution or the Suite check; it is a record-completeness item for the pricing-protection registry work (G1, G9).

Neither item is treated as evidence that the Pro plan link is missing; the plan link was verified directly (10.1).

### 10.4 Delivery status (draft PRs, unmerged, nothing applied or scheduled)

| PR | Head | CI (GitHub) |
|---|---|---|
| #362 database (migrations `20270203090000`, `20270203100000`, rollbacks, SQL tests, e2e fixture fix) | `c032d44f852e77a563d9da19d51efa3a78511953` | typecheck/build/lint/tests pass; both Vercel previews pass |
| #363 application (shared reader honoring `period_end`, six readers, platform pages, private-lesson enforcement, dark expiry job) | `57104c78233a1b1ea5ddd792a330faffa95bced0` | typecheck/build/lint/tests pass; both Vercel previews pass |

Regression coverage for the private-lesson route (13 tests, 5 fail against the old route): ordinary events unaffected; current grant allowed with the Pro fee; lapsed grant or none refused before the slot is held; lapsed grant plus a paid add-on allowed; organizer set on only the event or only the slot; Organizer plan keeps its fee; the 2027-07-09 boundary (allowed at 03:59:59Z, refused at 04:00:00Z); an already-booked slot keeps the existing answer. Bookings already paid or in flight are never re-checked.
