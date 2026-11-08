# BILLING-QA-3 — production release plan for the subscription webhook change

Status: **PLAN ONLY. Nothing in this document has been executed or authorized.** Prepared 2026-10-29 for owner review.
Merging PR #334 / #335 to `main` does **not** change production: `main` is never deployed (see the PRICING-P1 runbook,
"Strategy"). This plan describes the *separate* release that would carry the #335 webhook change to production.

## 1. What would be released

The application part of PR #335 (BILLING-QA-3) — three files, no migration, no environment change, no Stripe change:

| File | Change |
|---|---|
| `src/app/api/payments/webhook/route.ts` | The platform subscription webhook path (details below) |
| `src/lib/payments/__tests__/ownershipFakes.ts` | Test fake gains PostgREST `or()` (test-only) |
| `src/app/api/payments/webhook/__tests__/studioSubscriptionPlan.billingqa3.test.ts` | 43 POST-level tests (test-only) |

Behaviour changes in production if released (platform-scoped `customer.subscription.*` events, plus one note on connected-account
events in item 5):

1. **Order-safe state.** The subscription is re-read from Stripe and *that* is applied, so a delayed, retried or reordered
   event cannot overwrite a newer plan or status. A Stripe outage during the read fails the delivery (500, ledger `failed`);
   Stripe retries it. Costs one extra Stripe API read per subscription event.
2. **`studios.billing_plan` follows the plan** (Starter/Growth/Pro only; never for studios with `billing_override_enabled`;
   only while the subscription is trialing/active/past_due; cancellation keeps the last plan). The public embed, Discover and
   calendar pages read this column, which today keeps the signup-time plan after a Billing Portal change.
3. **A different, no-longer-live subscription of the same studio cannot overwrite the studio's live one** (logged
   `subscription_event_superseded`), and this is decided before plan resolution, so a late event for an old subscription whose
   Price no longer resolves is skipped instead of retried for days.
4. **Unlabelled platform subscriptions** (no DanceFlow metadata, e.g. created in the Stripe Dashboard): acknowledged with no
   write if the customer is unknown (was a 500 retried forever); **fail loudly (500, `subscription_event_unlabelled_known_customer`)
   if the customer is already billed by DanceFlow** (mapped in `studio_billing_customers` or on a studio row). *Operational
   consequence:* a Dashboard-created subscription for an existing studio customer will show failed deliveries until its
   metadata is fixed.
5. **`trial_ends_at` is synced** from the subscription's `trial_end`, and the billing period is read from the subscription or
   its items (Stripe API 2025-03-31+), identically for every entry point (subscription events, checkout completion, invoices).
   The period is lifted inside the two writers, so it also applies to connected-account (legacy studio membership) subscription
   events: a payload that carries the period only on its items now writes real dates instead of NULL (a strict improvement, but
   a behaviour change outside "platform only" — mention it in the release notes).

Not changed: checkout, portal, Price selection, Founder/Regular gating, entitlements, any other webhook handler.

## 2. Why it cannot ship from `main`

Production serves the separate release branch `release/pricing-p1` (`4bc938c6` = `8fd075f5` + PRICING-P1 #302 + #319), which is
95 commits behind and 10 ahead of `main` (as of `main` `a4c5718c`) and not an ancestor of it. The webhook route differs from `main`'s by a few lines
(main has the TW-4F SMS-credit handler; the live build does not). **Never deploy or promote `main`.**

## 3. Evidence gathered (all local/test-mode; nothing hosted)

| Evidence | Result |
|---|---|
| Review-fixed code, vitest route tests on `main`-based branch | 43 tests pass; 767 payments/billing tests pass, 118 skipped (local-stack suites needing a dedicated database — not counted) |
| **Dry run on `release/pricing-p1`** (throwaway worktree, nothing pushed): the 3-file change applied with `git apply --3way` | Applies cleanly (offsets only), no conflict markers; **43 test files / 586 tests pass, none skipped; `tsc` clean** |
| Real Stripe **test mode** lifecycle (local app + local QA database, platform webhooks via `stripe listen`) | **12/12**: Founder $59/$99/$159 checkout, payment, signed webhooks, portal redirect, Growth→Pro→Starter, grandfathered Price, Dashboard-style subscription, failed payment → past_due → recovery, authentic delayed events, cancellation, incomplete subscription, final state, billing period present on the row. 88/88 own deliveries `200` |
| Independent reviews (Opus) | Review of the change and of the fix delta: **approve with non-blocking**, no blockers; findings fixed or tracked below |
| CI on the #335 head | See the PR; Playwright is skipped in CI (no E2E secrets), so the lifecycle evidence above is local |

Not verified anywhere: behaviour against the **production** Stripe account/webhook endpoint (version, volume), the production
database's data, and real two-live-subscription situations. A no-payment smoke test **cannot** exercise this change
(no payment → no subscription events).

## 4. Preconditions (all must be true before step 1)

1. #334 and #335 merged to `main` by the owner (separate approvals), so the release is cut from reviewed, merged code.
2. Re-verify the live state read-only: `vercel inspect www.idanceflow.com` should still resolve to
   `dpl_HEvyvNbHzAiMBGT3yPVzeiGJk6Sj` (`release/pricing-p1` `4bc938c6`). If production serves anything else, stop and re-plan.
3. Owner checks in the Stripe Dashboard (Live mode, no secrets shared): the webhook endpoint
   `https://www.idanceflow.com/api/payments/webhook` is Enabled with recent `200` deliveries (baseline), and note its
   **API version** (the code now tolerates either period shape, but the baseline is useful evidence).
4. Decide the two product questions the change makes visible:
   - Accept that Dashboard-created subscriptions for existing studio customers will fail loudly until labelled (item 4 above).
   - Accept that already-stale `studios.billing_plan` values are corrected only when that studio's next subscription event
     arrives (no backfill is included; a one-off backfill would be a hosted database write needing its own authorization).
5. Re-run the dry run (section 5, step 0) on the merged commits; the numbers in section 3 must hold.

## 5. Sequence (each hosted step needs its own owner authorization)

0. **Dry run (no authorization needed; local only).** Throwaway worktree of `origin/release/pricing-p1`; apply
   `git diff <main before #335 merge> <main after> -- <the 3 files>`; expect a clean apply, vitest on
   `src/app/api src/lib/payments src/lib/billing` green, `tsc` clean; delete the worktree.
1. **Cut the release branch** `release/pricing-p1-webhook` from `release/pricing-p1` (`4bc938c6`) with **one commit** containing
   that patch. *Authorization needed to push.* Do not use `main`; do not cherry-pick anything else.
2. **Build staged, not promoted** exactly as the PRICING-P1 release did: clean `git archive` of the branch into a scratch
   directory (no `.env`, `node_modules`, `.vercel`), cached Vercel CLI `vercel deploy --prod --skip-domain` with
   `--scope dance-flow`, never `--yes`. *Authorization needed.* **No environment change is required**: the change reads only
   variables already set (the Production-only `STRIPE_PRICE_STUDIO_*` entries and webhook/Stripe secrets from the PRICING-P1
   env split). Confirm `www.idanceflow.com` still serves the previous deployment afterwards.
3. **Staged checks (read-only):** build is Ready; unsigned `POST /api/payments/webhook` on the staged URL returns `400`
   (signature branch reached); public pages and `/get-started/studio` unchanged ($59/$99/$159, no Regular). Checkout/portal
   behaviour is unchanged by this release, so the no-payment owner smoke from the PRICING-P1 runbook is *optional*; if the
   owner wants it, use the BILLING-QA-5 kit (`docs/qa/billing-owner-smoke-kit.md`) — it has its own prerequisites (see
   section 8).
4. **Promotion gate.** Owner reviews: dry-run evidence, review verdicts, rollback section below. *Authorization needed.*
   `vercel promote <new dpl>` (same mechanics as `docs/billing/PRICING-P1-RELEASE-RUNBOOK.md`); verify
   `vercel inspect www.idanceflow.com` resolves to the new deployment.
5. **Observation window (at least 30 minutes, longer across a billing day):**
   - Stripe Live → Developers → Webhooks → endpoint → deliveries: `customer.subscription.*` and `invoice.*` stay `200`.
   - No unexpected `500` bursts. Expected, benign: none. Expected, explainable: `subscription_event_unlabelled_known_customer`
     for a Dashboard-created subscription of an existing customer (fix the metadata).
   - The grandfathered Pro subscription still shows $129 and its original Price ID.
   - Optional read-only database check *(owner-approved hosted read; select only)* — studios whose `billing_plan` still
     differs from their subscription's plan (expected to shrink as events arrive; comped studios excluded):

     ```sql
     select s.id, s.billing_plan, p.code as subscription_plan, ss.status
     from studios s
     join studio_subscriptions ss on ss.studio_id = s.id
     join subscription_plans p on p.id = ss.subscription_plan_id
     where s.billing_plan::text <> p.code and coalesce(s.billing_override_enabled, false) = false;
     ```
6. **Close out** in the PRICING-P1 runbook's deployment history: new deployment id, source commit, rollback id, observation result.

## 6. Abort criteria and rollback

Roll back if, in the observation window: subscription/invoice deliveries return repeated `500`s that are not the explainable
unlabelled-customer case; a studio's plan/status is visibly wrong; or entitlement is lost or granted incorrectly.

1. `vercel promote dpl_HEvyvNbHzAiMBGT3yPVzeiGJk6Sj` (the PRICING-P1 build; it stays Ready) — one step.
2. **No environment and no database rollback is needed**: this release adds no env variable and no migration. Rows written
   while the new code ran remain valid for the old code (same tables and columns; `billing_plan` and `trial_ends_at` simply stop
   being synced).
3. Failed deliveries are retried by Stripe against the restored build; replays are idempotent (delivery claim ledger).
4. Older fallback if ever needed: `dpl_87xgSBVM2MqXi9KeyJHFeH9rdsoh` (`8fd075f5`, pre-PRICING-P1) — **not** recommended: the old
   code does not verify Price amounts (see the PRICING-P1 rollback section).

## 7. Known residuals (shipped as-is; tracked, not blocking)

- Two simultaneously live subscriptions for one studio can still overwrite each other in turn (needs the Dashboard or a
  recreated customer; checkout blocks it). Follow-up: keep whichever is live and newer.
- Comped (`billing_override_enabled`) studios still have `subscription_status` / `stripe_subscription_id` / `trial_ends_at`
  overwritten; only `billing_plan` is protected. Pre-existing; public pages gate on `subscription_status`.
- `items.data[0]` is assumed to be the plan item for plan resolution and now also for the period lift.
- Connected-account (legacy membership) subscription events are not re-read (their period is lifted when the payload carries
  it on items, see 1.5); the invoice-paid legacy-membership path reads its own, un-lifted period and can write NULL dates as a
  first write until the next subscription event overwrites them.
- A small race between concurrent deliveries of *different* events for the same subscription remains (needs a stored
  watermark, i.e. a migration — a separate, separately authorized change).
- Yearly checkout is ungated (the DB yearly Price IDs must be confirmed empty — owner/DB read), and which plans the live
  Billing Portal lets customers switch to is a Dashboard setting not in code (owner check).

## 8. Related tracked work

- Issue #348 — BILLING-QA-4 price-config endpoint follow-ups (N1–N3, F1–F3). The endpoint stays dark; enabling it in
  Production is an env change plus a redeploy and needs its own approval.
- Issue #352 — BILLING-QA-5 read-back follow-ups, **including F1: the restricted `rk_test_` dry run is a prerequisite for the
  first live smoke** (currently BLOCKED on an owner-created key; steps are recorded on the issue). It is *not* a prerequisite for
  this webhook release, whose behaviour a no-payment smoke cannot exercise.

## 9. Authorization boundaries

This plan authorizes nothing. Each of the following needs its own explicit owner approval: merging #334 and #335; pushing
`release/pricing-p1-webhook`; the staged Production build; promotion; any hosted database read or write (including the optional
SQL above); any live Stripe operation; any smoke test; enabling the BILLING-QA-4 endpoint; Regular pricing activation.
