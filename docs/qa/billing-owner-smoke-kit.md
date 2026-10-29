# Owner-run no-payment checkout smoke (BILLING-QA-5)

A repeatable check, for a pricing release, that the **deployed** app opens Stripe Checkout on the right Price at the
right amount for every plan, without anyone paying. The owner does every live step; the read-back verifier then proves
from Stripe what the owner saw, and reports PASS / FAIL / BLOCKED in the shared report format
(`docs/qa/billing-qa.md`).

Everything that can run without live Stripe runs in test mode instead: Price amounts (BILLING-QA-1), the deployed
configuration (BILLING-QA-4) and, once PRs #334/#335 (BILLING-QA-2/-3) merge, checkout, payment, webhooks, plan changes,
failed payments, cancellation and grandfathered Prices. Until then those are covered only by their PRs. This kit covers
only what needs production.

## Who does what

| Step | Who | Why |
|---|---|---|
| Approve the smoke for this release | Owner | It creates live Stripe objects (below) |
| Create the restricted read-only key | Owner | Live credentials stay with the owner |
| Open each Checkout Session and stop before paying | Owner | Live Checkout, production login |
| Run the read-back verifier | Owner (on their machine) | It needs the live read-only key |
| Interpret the report, fill in the release record | Owner, with the assistant if wanted | The report holds no secrets and can be shared |

The assistant never handles the live key, signs in to production, or creates live objects.

## What a smoke creates (side effects)

| Object | Created by | Lasts |
|---|---|---|
| One live **Checkout Session per plan** | the app's `/api/billing/checkout` | Unpaid; Stripe expires it after 24 hours. Nothing to clean up |
| A live **Stripe Customer** for the smoke workspace (first attempt only, reused afterwards) | the app | Permanent; harmless, no payment method |
| `studio_billing_customers` row and `studios.stripe_customer_id` for the smoke workspace | the app (production database) | Permanent; the normal record of a customer |
| Live **webhook events**: `customer.created` (first smoke only) and, about 24 hours later, one `checkout.session.expired` per Session | Stripe → the production webhook | Processed and recorded in the webhook ledger; the handlers ignore studio-subscription Sessions (they act only on competition and event-cart Sessions), so nothing else is written |
| In step 3 only: a live **Billing Portal session** for the existing subscriber | the app | Short-lived. The portal **can change or cancel that real subscription**: change nothing in it |
| No charge, no subscription, no invoice | | Unless a Session is completed. Studio plans have a free trial, so **completing a Session creates a live trialing subscription even with no charge today**. Never enter card details, and never use Stripe Link / a saved one-click card on the Checkout page |

The checkout route allows 8 attempts per 10 minutes per network address; a smoke uses 3 or 4. If a retry answers
"too many requests", wait 10 minutes.

## Before the first smoke (once)

1. **A designated no-payment workspace.** A studio workspace the owner controls, never subscribed, used only for
   smokes (for example "DanceFlow QA Studio"), with its own studio-owner login that has accepted the business terms.
   Note its Stripe customer id after the first smoke (Dashboard → Customers, search the workspace name) for
   `--smoke-customer`.
2. **A restricted read-only key.** Stripe Dashboard (live mode) → Developers → API keys → *Create restricted key*,
   name "DanceFlow QA read-back". Permissions: **Checkout Sessions: Read**, **Subscriptions: Read**, **Prices: Read**,
   **Products: Read**; everything else **None**. The verifier refuses a live secret key (`sk_live_`).
3. Put it in a local, git-ignored file (copy `.env.billing-readback.example` to `.env.billing-readback.local`). Never
   paste it into chat, a ticket or a document. Roll or delete it when the release window ends.

## Smoke steps (per release)

0. **Approval and start time.** Record the owner's go for this smoke and the UTC start time.
1. **Deployed config (optional, recommended).** If BILLING-QA-4 is enabled in Production (setting
   `BILLING_QA_PRICE_CONFIG_ENDPOINT=enabled` there takes an env change plus a redeploy and promotion, each with its own
   owner approval), sign in to `/platform` as a platform admin with TOTP, open `/api/platform/billing/price-config` and
   save the JSON as `price-config.json`. The read-back fails (`price_config_report_not_pass`) if that report did not
   PASS. Otherwise use the Price IDs from the release record with `--expect`.
2. **New-subscriber checkout, per plan.** Sign in as the smoke workspace's owner, open Settings → Billing, and choose
   Starter. On Stripe's page, check the plan name, the price ($59.00 per month for Founder Starter) and the trial
   wording. Copy the address bar: the part from `cs_live_` up to (not including) `#` is the Session id. Close the tab
   **without entering card details or using Link**. Repeat for Growth ($99.00) and Pro ($159.00).
3. **Existing subscriber (optional, separate owner approval).** Only with a subscribed workspace **the owner
   controls**, never a customer's: a platform admin can act in any studio, and this step opens a live portal session
   on that workspace's real subscription. As its owner, choose a plan in Settings → Billing. It should open the Stripe
   Billing Portal (`billing.stripe.com`), not Checkout. Change nothing; close it. Note that workspace's Stripe customer
   id for `--portal-customer` (the read-back first checks that this customer really has a live subscription).
4. **Grandfathered subscriber (optional).** Note the grandfathered subscription id (Dashboard → Subscriptions) for
   `--grandfathered`.
5. **Read back.**

   ```bash
   npm run qa:billing-readback -- --env-file .env.billing-readback.local --price-config price-config.json --since 2026-11-01T15:00:00Z --session cs_live_STARTER --session cs_live_GROWTH --session cs_live_PRO --smoke-customer cus_SMOKE --portal-customer cus_SUBSCRIBER --grandfathered sub_GRANDFATHERED --out smoke-report.json
   ```

   `--since` is the UTC start time recorded in step 0. With it, every Session must have been created at or after that
   time (`session.<plan>.fresh`), so a leftover Session from an earlier smoke cannot pass; without it there is no such
   check and the window starts 10 minutes before the earliest Session. Always pass it. Values in `--env-file` win over
   variables already exported in the shell, and a mistyped argument is never printed in full (at most 8 characters). Without `price-config.json`, pass
   `--expect starter=price_... --expect growth=price_... --expect pro=price_...` and, for the grandfathered check, one
   `--legacy-price price_...` per grandfathered Price.
6. **Record** the results in the template below and attach `smoke-report.json` (it contains no secrets).

## What the read-back proves

| Check | PASS when |
|---|---|
| `session.<plan>.unpaid` | the Session was not completed and created no subscription |
| `session.<plan>.session` | a DanceFlow studio subscription Session (live, `mode=subscription`, `source=studio_subscription`, a known `planCode`, a `studioId`, the expected `offerType`, and the smoke customer when given) |
| `session.<plan>.price` | exactly one monthly USD line item on the configured Price ID at the plan's amount. BLOCKED (`expected_price_id_unknown`) when only the amount could be checked |
| `session.<plan>.fresh` | (with `--since`) the Session was created at or after the recorded start time; FAIL `session_before_smoke_start` otherwise |
| `smoke.coverage` | every plan has a Session (BLOCKED otherwise, never PASS) |
| `smoke.no_subscription` | the smoke workspace got no subscription since the start |
| `portal.no_checkout_session` | the customer has a live subscription and its checkout created no Checkout Session (it went to the portal). BLOCKED (`portal_customer_not_subscriber`) when the customer has no live subscription |
| `grandfathered.price` | the grandfathered subscription is active/trialing and still on one of the configured legacy Prices |
| `config.report` | (with `--price-config`) the deployment's price-config report itself passed |

Not provable from Stripe and therefore **owner-attested**: what Stripe's hosted page displayed, and that the portal
opened. Subscription webhook processing is not exercised (no payment, so no subscription event; only
`customer.created` and the later `checkout.session.expired`); it is covered in test mode by BILLING-QA-2/-3 once
merged, and watched in Stripe's webhook deliveries after release.

## Stop conditions

- `session_completed` or `smoke_subscription_created`: a live subscription may exist. Stop, find it in the Stripe
  Dashboard and cancel it if unintended, then record what happened.
- `session_price_mismatch` or `session_not_danceflow_subscription`: the deployment charges something other than the
  release intends. Do not promote; if already live, follow the release runbook's rollback.
- BLOCKED rows (`stripe_permission_denied`, `plan_not_smoked`, `expected_price_id_unknown`, ...): the property is
  unverified, not passed. Fix the input and re-run the read-back; the Sessions stay readable after they expire.

## Results template

Release: ______  Deployment: ______  Smoke approved by: ______  Start (UTC): ______  Report: `smoke-report.json`

| # | Property | Verified by | Status | Evidence |
|---|---|---|---|---|
| 1 | Starter Checkout shows $59.00/month (Founder) | Owner (hosted page) | | |
| 2 | Growth Checkout shows $99.00/month (Founder) | Owner (hosted page) | | |
| 3 | Pro Checkout shows $159.00/month (Founder) | Owner (hosted page) | | |
| 4 | Each Session is on the configured Price and amount | Read-back `session.*.price`, `session.*.session` | | |
| 5 | No Session was paid; no subscription created | Read-back `session.*.unpaid`, `smoke.no_subscription` | | |
| 6 | Existing subscriber goes to the Billing Portal | Owner (portal opened) + read-back `portal.no_checkout_session` | | |
| 7 | Grandfathered subscriber still on the legacy Price | Read-back `grandfathered.price` | | |
| 8 | Every plan covered | Read-back `smoke.coverage` | | |

Statuses: PASS, FAIL or BLOCKED. A row that was not run is BLOCKED with the reason, never PASS. Owner-attested rows
say so in "Verified by".
