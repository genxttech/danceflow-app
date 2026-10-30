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
| P1 | **O9: verify the original $129 Pro contract terms** (cancellation, reactivation, price and trial rights) | The registry blocks new Checkout for a protected studio and routes to support; what support may then offer is defined by the original terms, which are unresolved | Owner supplies or authorizes review of the original terms; record the document reference (this becomes `terms_reference`) |
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
