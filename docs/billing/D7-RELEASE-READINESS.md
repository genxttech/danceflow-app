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

## 8. O9 owner pricing decision (2026-10-30) and what it requires

**Status: decision recorded; not implemented; not verified against Stripe. Nothing here authorizes a Stripe, registry, entitlement, schedule or data change.**

### 8.1 The decision

- DanceAbel Ballroom Studio's $129/month Legacy Pro price is protected for **12 paid months after its 2026-07-09 trial end**, ending **2027-07-09**.
- After that the subscription moves to the **then-applicable regular Pro rate, with advance notice**. It is **not** a permanent concession.
- Existing **Organizer Suite access stays at no additional charge for the same period**. What happens to it afterward is an **open owner decision**: the system must neither assume it ends nor assume it continues.
- DanceAbel is **one of the 25 Founder positions**. The cap allocation is not reopened.
- Nothing about the subscription changes until the transition is separately authorized.

This supersedes the earlier working assumption in the gap report that this subscriber is "permanently excluded" from the 12-month rule: the owner has now set a dated end for price protection. The gap report's D13 text (permanent exclusion) should be reconciled in a separate docs update.

### 8.2 Price protection and feature protection are two protections

| | Price protection | Feature protection (Organizer Suite) |
|---|---|---|
| What is protected | The $129/month rate | No-charge Organizer Suite access |
| Ends | 2027-07-09 (to be confirmed from billing periods) | Same date for the protected period; **post-period treatment undecided** |
| After the end | Moves to the then-regular Pro rate after advance notice | **Open owner decision**; default must be "keep and flag for owner review", never an automatic revoke |
| Where it lives today | Nowhere with an end date: the registry marks a studio/subscription protected indefinitely; the legacy-price env var is a standing backstop | `usage_addon_entitlements` (`organizer_suite`); rows have `status`, `period_start`, `period_end`, `source` |
| Authority | Registry row (once applied and inserted) plus Stripe state | Entitlement row; Stripe item if provisioned there |

Records, code and notices must carry **separate** end dates and separate post-period rules for each. A single shared "protected until" value is a defect.

### 8.3 Verified facts about the existing code (read-only, `origin/main` 75c4b28b)

1. The registry (`protected_subscriptions`) has a kind, immutable identity and terms fields, `terms_reference`, and a one-time release. **It has no end date, no notice record and no feature dimension.** Its protection is by existence, so a time-limited protection would otherwise last until someone releases the row.
2. Checkout refuses a protected studio or any legacy-priced subscription. **It does not move the subscription to another price.** No code anywhere performs a price transition for an existing subscriber.
3. Organizer Suite access (`src/lib/billing/access.ts`) is granted when `usage_addon_entitlements` has `feature_key = organizer_suite`, `status = 'active'` and `source` in (`stripe_subscription_item`, `manual_grant`). **The check ignores `period_end`.** A manual grant with an end date does not expire by itself, and nothing sweeps expired rows.
4. The Stripe webhook (`syncOrganizerSuiteAddonEntitlements`) sets Suite entitlements from the subscription's items and marks stale `stripe_subscription_item` rows `canceled` when the subscription is **not `active` or `trialing`**. A `past_due` state would therefore cancel Stripe-sourced Suite access. A `manual_grant` row is not touched by that sweep. How DanceAbel's Suite access is provisioned today is **not established** (checklist section 1 item 9, and section 4).
5. The webhook upserts Stripe-item Suite entitlements with conflict target `studio_id,feature_key`, which could overwrite a manual grant for the same studio and feature if both exist (to be confirmed against the live unique index; not verified).
6. The Terms (section 5) allow prospective price changes "after providing notice required by applicable law or the applicable order". The notice period itself is not defined anywhere in the repo.

### 8.4 Verification required before any transition is specified

1. Stripe: exact trial end, first paid invoice, every paid period in order (paused, failed, voided or credited periods), the billing-cycle anchor, any schedule or discount, any other items (`O9-EVIDENCE-CHECKLIST.md`, section 1).
2. Whether 12 paid periods actually end on 2027-07-09, or on another date. **The end date is derived from verified periods, not hard-coded.**
3. How Suite access is provisioned (Stripe item, coupon, manual grant).
4. Any original agreement or message (checklist section 2). If none exists, report "not established".

### 8.5 Advance-notice workflow and safeguards (design only; not built; thresholds need owner and legal approval)

Required properties for any future transition:

1. **No premature change.** No price change, schedule phase or entitlement change occurs before the verified period end. A scheduled change takes effect at a period boundary (no mid-period change, no unscheduled proration).
2. **Notice precedes the schedule.** A notice record (date, channel, delivered-to, the exact new rate and effective date, what happens to the Suite) must exist before any transition can be scheduled. No record, no schedule.
3. **The new rate is disclosed.** "Then-applicable regular Pro rate" is resolved and written in the notice at notice time. The rate charged must equal the rate disclosed.
4. **Notice timing is a parameter, not a guess.** The minimum notice period (and any reminders) needs owner and legal confirmation of what applicable law and the Terms require. Placeholders for review: first notice at least 60 days before, reminders at 30 and 7 days.
5. **Owner approval step.** The transition is created only after an explicit owner approval of the verified date, the notice evidence and the rate. It is never automatic.
6. **Dry run and read-back.** The intended Stripe change is computed and shown before it is made; afterward the resulting schedule is read back and compared. A failure leaves the subscription unchanged.
7. **Suite is separate.** The transition does not touch the Suite entitlement. At the Suite's own end date the system flags the studio for an owner decision and keeps access until the owner decides; it never revokes automatically.
8. **Registry row.** When price protection ends, the registry row is released through the audited one-time release (reason recorded), or the registry gains a dated end; otherwise the guard keeps treating the studio as protected.
9. **Cancel and reactivate rights.** The subscriber's rights during and after the period follow verified terms, or are reported "not established" and handled by the owner.
10. **Audit and alerting.** Notice sent, transition scheduled, transition applied and any failure are logged and alert the owner. The subscriber's customer, price, discounts and schedule are never edited outside this workflow.

### 8.6 Gaps requiring separate authorization

| # | Gap | Needs |
|---|---|---|
| G1 | Registry has no price-protection end date, notice state or feature dimension (8.3.1) | A design decision and a new migration (additive columns or a companion table), validated in the isolated chain, DEV then PROD; a decision on whether to add it before the first PROD apply of `20270201090000` |
| G2 | No price-transition mechanism exists (8.3.2) | Owner authorization for a design and implementation slice; Stripe test-mode proof of a subscription schedule that changes price at a period boundary; no live change |
| G3 | Suite entitlement ignores `period_end` and nothing sweeps expiry (8.3.3) | A decision on whether feature protection needs an enforced end at all (post-period treatment is open); if so, a code and data slice. Until then no end date should be relied on |
| G4 | Webhook cancels Stripe-sourced Suite access when the subscription is not active/trialing, and may overwrite a manual grant (8.3.4, 8.3.5) | Confirm how the access is provisioned; an owner decision on whether a protected studio's Suite access must survive `past_due`; a code slice if so |
| G5 | Notice period, channel and wording are undefined (8.3.6, 8.5.4) | Owner and legal confirmation; a notice template and a delivery-evidence record |
| G6 | The post-period Suite treatment is undecided | Owner decision; until then the default is retain and flag |
| G7 | The "regular Pro rate" at transition time is not fixed | Owner decision at notice time, recorded in the notice |
| G8 | The gap report's D13 "permanent exclusion" text conflicts with this dated decision | A docs update to the gap report (#343) with owner approval |
| G9 | Original terms and billing periods are unverified | Owner-run Stripe and records checks (checklist); optional production row reads need their own approval |

## 9. Refresh findings (2026-10-30, read-only)

- **Repo state:** `origin/main` was `75c4b28b`; production is still `release/pricing-p1` `4bc938c6` (taken from the runbook; the live deployment was not read). The D7 stack is independent of BILLING-QA-3 (#335) and the other `main` commits since `4bc938c6`; the minimal release composition is `4bc938c6` plus the three D7 commits. BILLING-QA-3 is a separate release (its own plan, PR #353); whichever ships second must be rebased onto the first.
- **Dry run on the production base (local only):** the three commits cherry-pick with no conflicts (17 files, identical to `main`); 480 billing and payments tests, `tsc` and eslint pass.
- **Correction to the earlier chain validation:** the earlier "full chain" used `main` migrations on an image that already contained 16 TW-4F migrations production lacks. The correct validation base is the `release/pricing-p1` migration set (`df-isoqa/base:20261119092100`: 200 applied, 22 known-unreplayable skipped) plus `20270201090000`. On that base the 40-check registry script gives 40 PASS, 0 FAIL.
- **Read-only production catalog probe (catalog only, no row data):** the registry table and both functions are absent; `public.studios(id uuid)`, `studio_billing_customers`, `studio_subscriptions` and the `studios` billing columns exist; TW-4 is at `20261119092100` (6 `studio_sms_*` tables, 11 `tw4*` functions, nothing newer); there is no migration-history table. Production has 339 public tables and 522 functions versus 329 and 443 in the local image. The production-only objects come from the 22 migrations the harness cannot replay on its July dump base (Competition 10C/10D, LAUNCH-SEC, payroll 9A to 9C, GC-3.5.2, refund reconciliation). Five old payroll and client-lookup functions and one table (`payment_harness_runs`, defined by no release-branch migration) exist only in the image. **Production is not proven identical to the release-branch migration set.** The registry migration depends only on `studios(id)`, which matches, so the test result is valid for the migration's own behavior but is not a full schema rehearsal.
- **New exposure findings (code review):** the paused/incomplete page gap is more serious than "advisory" (such a studio sees "Start Trial" and no portal button, so it cannot finish payment); checkout logs the raw error object; `GET /api/billing/checkout` creates a session from a cross-site link. Concurrent checkout and repeat trial remain open (specified fixes: open-session check, session `expires_at`, idempotency keys, a duplicate-subscription alert; omit the trial when a listed subscription already had one).
