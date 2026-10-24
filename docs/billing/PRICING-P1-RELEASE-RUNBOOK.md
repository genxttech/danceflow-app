# PRICING-P1 — Production release runbook (authoritative)

Status: plan only (revised 2026-10-24 with owner instructions). Nothing here has been executed. Companion to
`PRICING-P1.md`. Nothing is pushed as a release branch, deployed, or changed in Stripe, Vercel or any database.

## Strategy (owner-approved)

- Release **only** from a branch cut from the deployed commit `release/web-2a-website` = `8fd075f5`
  (live deployment `dpl_87xgSBVM…`). **Never deploy or promote `main`**: it is 85 commits ahead with unreleased
  TW-4F and Competition OS work, and `8fd075f5` is not an ancestor of `main`.
- The release branch contains exactly the PRICING-P1 commit (#302, `d535720d`) and the webhook plan-resolution commits
  from #319 (kept as a separate PR until independently reviewed and the owner authorizes a merge). Local candidate
  (not pushed): 14 files, all under `src/lib/billing`, `src/app/api/billing`, `src/app/api/payments/webhook`, the billing
  settings page, `get-started/studio` and `docs/billing`.
- **Do not push the release candidate merely to start a Vercel build** without separate owner approval: qfem Preview shares
  the production Supabase project (`hvsujy…`) and has no Stripe secret key.

## Stripe Price strategy (owner's plan)

| Plan | Action in the Stripe Dashboard | Price ID |
|---|---|---|
| Starter Founder | Edit the existing, unused Price to **$59 USD / month** | unchanged |
| Growth Founder | Edit the existing, unused Price to **$99 USD / month** | unchanged |
| Pro Founder | **Create one new Price** $159 USD / month on the existing Pro Founder Product | **new** |
| Pro Founder (original) | Do not touch; the existing subscriber stays grandfathered | unchanged (becomes legacy) |

Stripe's public API cannot change a Price amount; the Dashboard may allow editing an unused Price. **If the Dashboard
refuses the edit, changes the Price ID, or the Price turns out to have been used, stop and report the actual result — do
not assume reuse.** Only then create replacement Prices (same Product, same settings). "Used" means any subscription,
invoice or completed checkout against it in that account and mode.

Note (DEV sandbox only): my own local test on 2026-10-24 created and deleted two trial subscriptions on the sandbox Growth
Founder Price (`price_1TdKDz…`, canceled, no charge). That does not affect the live account, but that sandbox Price is
"used" there.

## Step 0 — Identify the Stripe account production uses (owner; no secrets shared)

Goal: prove which Stripe account and mode the deployed app (www.idanceflow.com) uses. Never paste a secret key (`sk_`,
`rk_`) or a webhook signing secret (`whsec_`) into chat.

A. **Publishable-key fingerprint (non-secret).** A Stripe publishable key embeds its account ID:
   `pk_live_51<SUFFIX>…` belongs to `acct_1<SUFFIX>`. (The DEV sandbox `acct_1TKgLCEYYNmPuFIX` has keys beginning
   `pk_test_51TKgLCEYYNmPuFIX…`.)
   1. Vercel → `danceflow-app-qfem` → Settings → Environment Variables → search `PUBLISHABLE` → the **Production** entry →
      eye icon. Send me only the first ~30 characters (for example `pk_live_51AbCdEfGhIjKlMnO`). Publishable keys are public
      by design; do not send anything beginning `sk_` or `rk_`.
   2. Stripe Dashboard → account menu / Settings → Business → Account details → copy the **Account ID** (`acct_…`; not secret).
   3. They must match and the key must start `pk_live_`. If Production shows `pk_test_…` or the account is the sandbox
      (`acct_1TKgLCEYYNmPuFIX`), production is on the sandbox: stop and report; the live steps change meaning.
B. **Webhook endpoint (cross-check).** Stripe Dashboard with **Live mode** on → Developers → Webhooks: confirm an endpoint for
   `https://www.idanceflow.com/api/payments/webhook` exists in that account, is enabled and shows recent successful
   deliveries. Do not reveal its signing secret. Toggle Live mode off and confirm the endpoint is not in test mode.
C. **Existing subscriber.** In the same live account, Customers → Subscriptions: the active Pro Founder subscription is here.
   Record only: Price ID, amount, status, next renewal date, and whether the subscription's **Metadata** contains
   `planCode = pro`.

Send me: Account ID, whether Live mode is on, the publishable-key prefix, and the webhook endpoint status.

## Step 1 — Prices (owner, Stripe Dashboard, Live mode)

1. Product catalog → each Founder Product → the Price → Edit amount (Starter $59, Growth $99). After saving, confirm the
   Price ID is unchanged. If it prompts for a replacement or the ID changes: **stop and report.**
2. Pro Founder Product → Add price: recurring, USD, **$159.00**, billing period **monthly**, no trial, tax behavior same as
   the existing Pro Founder Price. Do not archive the original Pro Price.
3. Send me the Starter, Growth and new Pro Price IDs and the original Pro Price ID.

### Verification checklist (owner sends only Price IDs and non-secret evidence)

Each of Starter, Growth, Pro must satisfy:

| Check | Starter | Growth | Pro |
|---|---|---|---|
| Attached to the existing Founder Product (name and ID unchanged) | ☐ | ☐ | ☐ |
| Amount | $59.00 | $99.00 | $159.00 |
| Currency USD | ☐ | ☐ | ☐ |
| Recurring, every 1 month | ☐ | ☐ | ☐ |
| Live mode (no "Test data" banner) | ☐ | ☐ | ☐ |
| Price ID matches the env plan below | ☐ unchanged | ☐ unchanged | ☐ new |
| Price active | ☐ | ☐ | ☐ |

Plus: the original Pro Price is still active and still $129; the existing Pro subscription is unchanged (same Price ID,
amount, status, renewal date, `planCode=pro` metadata); no other subscription, customer, coupon or invoice changed.

## Step 2 — Environment plan (needs separate owner authorization)

Env changes only affect NEW deployments; the live deployment is unaffected until a new build is promoted.
`STRIPE_PRICE_STUDIO_*_FOUNDER` are single entries scoped "Production and Preview" holding sandbox IDs.

| Variable | Production value | Preview |
|---|---|---|
| `STRIPE_PRICE_STUDIO_STARTER_FOUNDER` | existing Starter Price ID (same ID, now $59) | keep sandbox value |
| `STRIPE_PRICE_STUDIO_GROWTH_FOUNDER` | existing Growth Price ID (same ID, now $99) | keep sandbox value |
| `STRIPE_PRICE_STUDIO_PRO_FOUNDER` | **new** $159 Pro Price ID | keep sandbox value |
| `STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY` | original Pro Price ID (grandfathered, $129) | unset |

Per variable: change the shared entry to **Preview only** with its current value, then add a Production-only entry with the
value above. Leave `_STANDARD`, `REGULAR_PRICING_ACTIVATED` and `REGULAR_PRICING_APPROVAL_REF` unset. Record before/after values.

## Webhook plan resolution (PR #319 — separate, pending independent review)

Order in `upsertStudioSubscription`: (1) `subscription_plans` Price ID, (2) checkout env Price IDs (`…_FOUNDER`, `…_STANDARD`,
`…_FOUNDER_LEGACY`, organizer), (3) `metadata.planCode`. The `subscription_plans` Price IDs match neither the old nor the new
env IDs, so (1) never matched env-Price subscriptions. Coverage (unit tests on the pure helper plus a source-order test):

- New $59/$99/$159 subscriptions resolve by the env Founder Price, regardless of metadata.
- A Billing Portal change to another env Price resolves to the new plan; stale metadata is ignored.
- Grandfathered Pro on the original $129 Price resolves through `STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY` if set, otherwise
  through `metadata.planCode`. **Gate:** set the LEGACY variable (preferred) and confirm the subscription's metadata (Step 0C).
- A Price in none of the sources and with no metadata still throws `Could not resolve subscription plan` (existing behavior; it
  is retried and surfaced rather than recording a wrong plan).
- The sandbox billing-portal configuration has subscription updates disabled. Read the live portal configuration before
  assuming that, and do not enable plan switching until tested in test mode.

## Release sequence (each hosted step needs separate owner authorization)

1. Step 0 evidence accepted (live account, matches production).
2. Step 1 done; verification checklist passed.
3. #319 independently reviewed; owner authorizes its merge (#302 is already merged).
4. Owner authorizes pushing `release/pricing-p1` (cut from `8fd075f5`, only the commits above). The push triggers a Vercel
   build; no Preview URL will be visited or used for testing.
5. Owner authorizes the Production env changes (Step 2).
6. Build a Production deployment from the release branch (staged, not promoted). Smoke test on the staged URL, no payment:
   `/get-started/studio` shows $59/$99/$159 and no "regularly" text; a new non-subscribed owner's Starter/Growth/Pro
   checkout reaches Stripe Checkout at the new amount; an existing subscribed workspace goes to the billing portal and its
   subscription is unchanged; no `price_mismatch`.
7. Owner authorizes promotion. After promotion repeat the no-payment smoke test and watch webhook deliveries.

## Rollback (code and config together)

1. Promote the previous deployment (`dpl_87xgSBVM…`, `8fd075f5`) back.
2. Restore Production `STRIPE_PRICE_STUDIO_PRO_FOUNDER` to the original Pro Price ID and remove `…_PRO_FOUNDER_LEGACY`.
3. Starter and Growth Prices keep their edited amounts ($59/$99) in Stripe. The old code does not verify amounts, so after a
   code rollback the old pages show $49/$79 while checkout charges $59/$99. Do not re-edit or archive a Price that has a
   subscription. Preferred: roll back only if the defect is in code, keep the approved Stripe amounts, and fix forward quickly.
4. Existing subscriptions are never touched in either direction.

## Remaining gates (all open)

- [ ] Step 0 account evidence from the owner
- [ ] Dashboard confirms Starter and Growth edits keep their Price IDs (else stop)
- [ ] Step 1 verification checklist passed
- [ ] Existing Pro subscription metadata checked and LEGACY env value decided
- [ ] #319 independent review complete and owner merge authorization
- [ ] Live Stripe portal configuration read (plan switching on/off)
- [ ] Owner authorizes: release branch push, Production env change, staged build, promotion

## Not in this release

Entitlement enforcement (instructors, locations, Payroll Prep), legacy-subscriber MRR estimates, final Founder duration
policy, regular pricing activation, annual and Organizer pricing.
