# PRICING-P1 — Production release runbook

Status: plan only. Nothing here has been executed. Companion to `PRICING-P1.md`.

## Facts established (2026-10-24)

- PRICING-P1 is merged to `main` at `d535720d` (PR 302). Webhook plan-resolution fix is draft PR 319.
- Production is Vercel project `danceflow-app-qfem` (serves idanceflow.com). The live deployment is
  `dpl_87xgSBVM…` built from `release/web-2a-website` (`8fd075f5`), which is **not** an ancestor of `main`;
  `main` is 85 commits ahead of it, including unreleased dark work (TW-4F SMS billing etc.).
  **Never promote a `main` build for this release.** Release from a branch cut from the live commit.
  `d535720d` (and the #319 commit) cherry-pick onto `8fd075f5` with no conflicts.
- `STRIPE_PRICE_STUDIO_*_FOUNDER` / `_STANDARD` on qfem are single entries scoped "Production and Preview".
  Their values (`price_1TdK…`) exist only in the DEV Stripe **sandbox** (`acct_1TKgLCEYYNmPuFIX`).
  The Production `STRIPE_SECRET_KEY` is a locked secret; whether production currently uses the sandbox or a
  live account is **unconfirmed** and is Step 0.
- qfem Preview shares the PROD Supabase project (`hvsujy…`); Preview has no Stripe secret key. Do not test on qfem previews.
- Old code (live) selects Price IDs with no amount check; new code refuses unless the Stripe Price is active, USD,
  monthly, and exactly $59/$99/$159.

## Step 0 — Owner confirms the production Stripe account (blocks everything)

In the Stripe dashboard for the account whose secret key is in qfem Production:
1. Is it live mode with the DanceFlow Products (Studio Starter/Growth/Pro - Founder), or the sandbox?
2. If production uses the sandbox, there is no live charging yet: the "live" steps below become "sandbox" steps
   and the Price IDs already created in the sandbox (see PRICING-P1.md status) can be reused. Decide this first.

## Step 1 — Owner creates three Prices (Stripe dashboard, production account)

On the **existing** Founder Products (Studio Starter - Founder, Studio Growth - Founder, Studio Pro - Founder):

| Plan | Amount | Currency | Billing | Notes |
|---|---|---|---|---|
| Starter | $59.00 | USD | Recurring, monthly (every 1 month) | new Price; never edit old ones |
| Growth | $99.00 | USD | Recurring, monthly | |
| Pro | $159.00 | USD | Recurring, monthly | |

No trial on the Price (trial comes from checkout `trial_period_days`). Tax behavior: match the existing Founder Prices.
Leave the existing Prices active (existing subscribers and rollback). Send the three `price_…` IDs.

## Step 2 — Read-only verification (Claude)

With a read-only restricted key or dashboard screenshots: each ID is active, USD, month/1, correct amount, attached to
the intended Product, and the old Price on that Product is unchanged. Also record: subscriptions on the old Prices
(count by status) — they are untouched by this release.

## Step 3 — Release build (Git, no hosted change)

1. Branch `release/pricing-p1` from `8fd075f5`; cherry-pick `d535720d` and the #319 merge/commit.
2. Run: `vitest run src/lib/billing src/app/api/billing src/app/api/payments/webhook`, `tsc --noEmit`
   (`NODE_OPTIONS=--max-old-space-size=8192`), eslint on changed files. Tests already pass on the cherry-picked tree
   (see status below).
3. Push the branch; Vercel builds a preview/staged deployment. Do not promote.

## Step 4 — Env scoping (owner-authorized hosted change)

Order matters; env changes only affect NEW deployments, so the live deployment is unaffected until Step 5.
1. For each `STRIPE_PRICE_STUDIO_{STARTER,GROWTH,PRO}_FOUNDER`: edit the shared entry to **Preview only** (value unchanged), then
   add a **Production-only** entry with the new Price ID. (Do the Production value last, per variable.)
2. Do not touch `_STANDARD`, `REGULAR_PRICING_ACTIVATED` or `REGULAR_PRICING_APPROVAL_REF` (leave unset).
3. Record before/after IDs in the release notes. Rollback values = the old `price_1TdK…` IDs.

## Step 5 — Deploy and smoke test

1. Build the release branch with Production env (a new build, so it picks up Step 4). Do not promote yet.
2. On the staged deployment URL (or after promotion, per owner): open `/get-started/studio` — expect Founder $59/$99/$159, no "regularly" text.
3. Log in as an owner on a **new** (non-subscribed) test workspace, start Starter/Growth/Pro checkout — expect a redirect to
   Stripe Checkout showing the new amount. Stop at the Stripe page; make no payment. Expect no `price_mismatch`.
4. An existing subscribed workspace: checkout button goes to the billing portal; subscription unchanged.
5. Promote only on owner authorization, after step 2–4 pass.

## Rollback (code and config together)

1. Promote the previous deployment (`dpl_87xgSBVM…`) back (Vercel instant rollback).
2. Restore Production `STRIPE_PRICE_STUDIO_*_FOUNDER` to the prior IDs. Old code does not check amounts, so the env
   must be restored in the same window or checkout will charge whatever the env Price says.
3. Do not archive or edit any Price. New Prices stay for a retry.
4. If a subscription was created on a new Price during the window, it remains valid; no data repair is needed
   (plan resolves via env Price in the #319 build; the old build resolves via `metadata.planCode`, which is correct for new checkouts).

## Webhook note (PR 319)

`subscription_plans` Price IDs match neither the old nor new env IDs, so plan resolution always fell to
`metadata.planCode`, stale after a Billing Portal plan change. #319 inserts env-Price resolution before the metadata
fallback. The sandbox portal configuration has subscription updates disabled, so this is latent; ship #319 with this release
and do not enable portal plan switching until verified in test mode.

## Not in this release

Entitlement enforcement (instructors, locations, Payroll Prep), legacy-subscriber MRR estimates, final Founder duration
policy, regular pricing activation, annual and Organizer pricing.

## Release-candidate verification (local, 2026-10-24)

Cherry-picking `d535720d` then the #319 commit onto `8fd075f5` (local only, not pushed): the first applies cleanly; the
second conflicts in the import block of `src/app/api/payments/webhook/route.ts` because the live base has no SMS-credit
import (resolve by keeping only the plan-resolution import). Result: billing, checkout and webhook suites 24 files /
249 tests passed, `tsc --noEmit` clean. Pushing a release branch triggers a Vercel preview build on qfem, so it was not pushed.
