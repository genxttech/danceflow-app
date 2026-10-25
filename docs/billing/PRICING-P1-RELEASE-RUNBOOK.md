# PRICING-P1 — Production release runbook (authoritative)

Status: plan only (revised 2026-10-24 with owner instructions). Nothing here has been executed. Companion to
`PRICING-P1.md`. Nothing is pushed as a release branch, deployed, or changed in Stripe, Vercel or any database.

## Strategy (owner-approved)

- Release **only** from a branch cut from the deployed commit `release/web-2a-website` = `8fd075f5`
  (live deployment `dpl_87xgSBVM…`). **Never deploy or promote `main`**: it is 85 commits ahead with unreleased
  TW-4F and Competition OS work, and `8fd075f5` is not an ancestor of `main`.
- The release branch contains exactly two commits: the PRICING-P1 commit (#302, `d535720d`) and the webhook plan-resolution
  squash commit (#319, `d5786295`, merged 2026-10-24 after independent review). The #319 cherry-pick conflicts only in the
  webhook import block (the live base has no SMS-credit import): keep just the plan-resolution import. Local candidate
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

## Two price tiers: do not confuse them

| Tier | Starter | Growth | Pro | Status |
|---|---|---|---|---|
| **Founder** | $59 | $99 | $159 | **Approved for the upcoming release.** Shown and charged by the release build. |
| **Regular** (provisional) | $89 | $149 | $249 | **Prepared in Stripe only. Inactive in DanceFlow. Not approved for customers.** |

Regular pricing stays OFF in DanceFlow. In this release: `REGULAR_PRICING_ACTIVATED` is not set, `REGULAR_PRICING_APPROVAL_REF`
is not set, no `…_STANDARD` Price ID is added or changed in any environment, no regular price is shown on any page, and
checkout behavior is unchanged. Editing a Regular Price in Stripe is a Stripe-only change with no effect on DanceFlow while
those gates hold.

### Regular Prices: edits COMPLETE (owner, Stripe Dashboard, Live mode, 2026-10-24)

The owner reports having already edited all three existing Regular Prices in the production account, with Stripe preserving
the existing Price IDs, and that none had been purchased or used by any subscription:

| Plan | Regular Price now | Price ID |
|---|---|---|
| Starter | $89 USD / month | unchanged |
| Growth | $149 USD / month | unchanged |
| Pro | $249 USD / month | unchanged |

These edits are final: the runbook does not defer, recreate or reverse them. I did not make or see these edits (no live access);
they are recorded from the owner's report. They remain **inactive in DanceFlow** and **not approved for customers**.

Evidence still wanted for the record (owner sends Price IDs and non-secret notes; I paste them here):

| Check | Regular Starter | Regular Growth | Regular Pro |
|---|---|---|---|
| On the existing Regular Product (not a Founder Product) | ☐ | ☐ | ☐ |
| Amount | $89.00 | $149.00 | $249.00 |
| USD, recurring every 1 month, Live mode, Active | ☐ | ☐ | ☐ |
| Price ID unchanged from before the edit | ☐ | ☐ | ☐ |
| Subscriptions / payments still 0 | ☐ | ☐ | ☐ |

The amounts equal `provisionalRegularAmountMonthlyCents` in `plans.ts` (8900 / 14900 / 24900), which the release build's checkout
compares against the Stripe Price before any session is created.

### Exposure assessment: can the currently deployed app reach the updated Regular Prices? (read-only, 2026-10-24)

Scope: the deployed build is `8fd075f5`. The only code that creates a studio-plan subscription checkout is
`src/app/api/billing/checkout/route.ts`; the AI-credit-pack and Organizer Suite add-on routes use their own Prices.
There is no amount check in the deployed route.

Paths from that route to a Regular Price (monthly):
1. Founder pricing off (`FOUNDER_PRICING_ACTIVE` or `NEXT_PUBLIC_FOUNDER_PRICING_ACTIVE` = `false`) → `STRIPE_PRICE_STUDIO_<PLAN>_STANDARD`.
   **Not currently the case:** the live `/get-started/studio` renders Founder pricing, which uses the same determination.
2. Founder flags on, but `STRIPE_PRICE_STUDIO_<PLAN>_FOUNDER` missing or blank for that plan → `…_STANDARD`.
   **Unverified for Starter and Growth** (locked values; owner reported Pro Founder was used for a purchase). **This is the actual
   residual exposure:** if a Founder variable were blank, that plan's new checkout would now charge the edited Regular amount
   ($89 / $149 / $249) under old copy showing $49 / $79 / $129.
3. Both Founder and Standard variables missing → `subscription_plans.stripe_price_id_monthly` (database). Reachable only after 2.
   Whether any production database Price ID equals a Regular Price ID is **unverified** (requires a read of production
   `subscription_plans`, not authorized).
4. Yearly (`billingInterval=year`) always uses `stripe_price_id_yearly` from the database, never a monthly Regular Price,
   unless the database misconfigures a yearly slot with a monthly Price ID (same unverified database read as 3).
5. A subscribed workspace goes to the Stripe billing portal, not a price. **Outside the code:** if the live Stripe portal
   configuration allows subscription updates and lists the Regular Prices, existing subscribers could switch to them there.
   The sandbox portal has updates disabled; the live configuration has not been read.
Other Stripe surfaces (Payment Links, Pricing Tables, hosted checkout links) that reference the Regular Prices would also bypass the app.

Determination: **no confirmed exposure; two unverified conditions** (a blank Founder variable for a plan; live portal/other surfaces).
Required mitigation without any Production change (owner, read-only evidence; no settings change):
- Stripe Live → Developers → Logs / `checkout.session.created`: confirm the deployed app creates Starter, Growth and Pro
  Checkout Sessions with the **Founder** Price IDs (or run one no-payment checkout per plan; each session expires unpaid).
- Stripe Live → Settings → Billing → Customer portal: confirm subscription updates / plan switching is off, or that it lists no Regular Price.
- Stripe Live → Payment Links and Pricing tables: confirm none references a Regular Price.
- Move quickly to the release build: it refuses any non-Founder studio checkout without the activation gates and verifies amounts.

Regular pricing stays inactive in the release: `REGULAR_PRICING_ACTIVATED` and `REGULAR_PRICING_APPROVAL_REF` unset, no `…_STANDARD` env
change, no regular price on any page, checkout behavior unchanged. Later activation (not authorized) needs an owner approval
reference, the `…_STANDARD` env Price IDs set to the Regular Price IDs, `FOUNDER_PRICING_ACTIVE=false` to end Founder pricing, and a
new release with its own smoke test.

## Deployed Founder-selection check (2026-10-24, read-only)

What the currently deployed build (`8fd075f5`) does: with Founder pricing active it uses `STRIPE_PRICE_STUDIO_<PLAN>_FOUNDER` if that variable
is non-empty (after trim) and **does not verify the Price amount**. It falls back to `..._STANDARD` (then the database Price)
only when Founder pricing is off or that Founder variable is missing/blank. A Founder variable that holds a wrong or
other-account Price ID does **not** fall back: Stripe rejects it and checkout shows `checkout_failed`.

Verified: the public page `https://www.idanceflow.com/get-started/studio` currently renders Founder pricing ($49 / $79 / $129 with
"Founder price · regularly $59 / $99 / $159"). That page uses the same Founder determination as checkout
(`FOUNDER_PRICING_ACTIVE` and `NEXT_PUBLIC_FOUNDER_PRICING_ACTIVE` both not "false"), so both flags are effectively on in the deployed build.
Seen in Vercel (names and scope only): both flag entries and all three `STRIPE_PRICE_STUDIO_*_FOUNDER` entries exist, scoped
Production and Preview.

Not verifiable by me: that each of the three Founder entries is non-blank and holds the live Founder Price ID (values are locked;
Production values did not reveal in the browser pane). Evidence that closes it: Stripe Dashboard (Live) → Developers → Logs (or the
`checkout.session.created` events) showing the deployed app creating Checkout Sessions with `line_items[0][price]` equal to each
current Founder Price ID. The owner-reported Pro purchase already shows the Pro Founder variable worked at that time. For
Starter and Growth, one owner-run no-payment checkout attempt per plan on a non-subscribed workspace produces that log line
(the session expires unpaid) and the Stripe page shows "Studio Starter - Founder" $49 / "Studio Growth - Founder" $79 before the edit.

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

### Step 0 evidence received (2026-10-24, owner, Stripe Dashboard)

- Production Stripe account: `acct_1TKgL3EY0sTayNiS` (live).
- Live publishable key prefix `pk_live_51TKgL3EY0sTayNiS…` (full key intentionally not recorded). Its embedded account
  identifier matches the Dashboard Account ID.
- Webhook endpoint: `https://www.idanceflow.com/api/payments/webhook`.
- Different from the DEV sandbox `acct_1TKgLCEYYNmPuFIX` (account IDs differ; the sandbox is not production).

### Deployed-application verification (what is and is not proven)

Proven by me (read-only, 2026-10-24):
- `POST https://www.idanceflow.com/api/payments/webhook` with no Stripe signature returns HTTP 400 `Invalid webhook request.`
  (`GET` returns 405). In the route that is the `missing_signature` branch, which is reached only when at least one webhook
  secret is configured (an unconfigured deployment returns 503). So the destination is reachable and a signing secret is set.

Not provable without the Dashboard (the Production publishable key and secret key are not readable from Vercel — the
Production value does not reveal in the UI — and the app does not expose the publishable key in client code):
- that the deployed `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` belong to `acct_1TKgL3EY0sTayNiS`.

Owner checks (no secrets leave the Dashboard) that close this gap:
1. Live mode → Developers → Webhooks → the `https://www.idanceflow.com/api/payments/webhook` endpoint → status **Enabled**;
   its **Event deliveries** list shows recent live events with HTTP **200**. A 200 means the deployed signing secret verified
   an event signed by this account, so the deployed secret belongs to this endpoint/account. Note the date of the latest 200.
2. Live mode → Developers → API keys → the secret key row used by the app: **Last used** shows a recent time (do not reveal the
   key). If several keys exist, the one the app uses is the one whose last-used time moves when a checkout/portal action runs.
3. Live mode → Developers → Logs (or Workbench → Logs): recent `POST /v1/checkout/sessions` or `GET /v1/subscriptions`
   requests from the app, showing the live key's last characters.
Send me the endpoint status, latest delivery date and HTTP code, and whether API key last-used is recent.

## Step 1 — Prices (owner, Stripe Dashboard, Live mode)

Before touching anything: confirm the **Live mode** toggle is on (no "Test data" banner) and the account is
`acct_1TKgL3EY0sTayNiS`. Open the Price detail page for each of the three current Founder Prices and write down, before
editing: Price ID, Product name and ID, amount, currency, interval, and the number of subscriptions/payments (the Price page
shows "Subscriptions" and "Payments"). Starter and Growth must show **0** subscriptions and 0 payments. If either is nonzero,
**stop and report.**

**A. Starter Founder → $59/month (keep Price ID)**
1. Product catalog → open the product *Studio Starter - Founder* → under Pricing click the existing monthly Price.
2. Click the **⋯ / Edit price** control on the Price detail page. If there is no edit control for the amount, or Stripe says
   the Price can no longer be edited, **stop and report that exact message.** Do not create a replacement.
3. Set amount to **59.00**, currency **USD**, billing period **Monthly**. Leave every other field as it is. Save.
4. Re-open the Price. Confirm the Price ID in the page header/URL is **identical** to the one you wrote down, amount $59.00.
   If the ID changed or a new Price was created, **stop and report.**

**B. Growth Founder → $99/month (keep Price ID)** — same four steps on *Studio Growth - Founder*, amount **99.00**.

**C. Pro Founder → NEW $159/month Price (do not edit the existing one)**
1. Product catalog → *Studio Pro - Founder* → **Add another price**.
2. Pricing model **Standard**, **Recurring**, amount **159.00**, currency **USD**, billing period **Monthly**. No free trial on
   the Price (the app sets the trial on checkout). Set tax behavior to match the existing Pro Founder Price. Optional internal
   nickname, for example `Pro Founder $159 monthly (PRICING-P1)`.
3. Add price. Copy the new **Price ID** (`price_…`).
4. Do **not** archive, edit or set as default-replace the existing $129 Pro Price. Confirm it is still Active with the
   existing subscription attached.

**D. Report back** only: the three Price IDs (Starter unchanged, Growth unchanged, Pro new), the original Pro Price ID,
and the pre-edit counts and post-edit screenshots/notes with no secrets.

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
`STRIPE_PRICE_STUDIO_*_FOUNDER` are single, locked (sensitive) entries scoped "Production and Preview", added May 31. Their values cannot be read back in
Vercel; earlier notes that they hold sandbox IDs were an unsupported inference (taken from a local `.env.local`) and are retracted.

| Variable | Production value | Preview |
|---|---|---|
| `STRIPE_PRICE_STUDIO_STARTER_FOUNDER` | existing Starter Price ID (same ID, now $59) | keep current value |
| `STRIPE_PRICE_STUDIO_GROWTH_FOUNDER` | existing Growth Price ID (same ID, now $99) | keep current value |
| `STRIPE_PRICE_STUDIO_PRO_FOUNDER` | **new** $159 Pro Price ID | keep current value |
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

### #319 independent review (2026-10-24)

A code-only reviewer found no blockers and two should-fix items, both fixed on the #319 branch and re-verified on the
release candidate (24 files / 256 tests, `tsc` clean, 14 files, still local):
- Plan Price was read from `items.data[0]` only; an add-on item (AI credit pack, Organizer Suite) first would hide the plan Price.
  Now every item is checked.
- A Price configured for two plans silently picked the first. Now an ambiguous Price (or items naming different plans) returns
  no plan, logs, and falls back to metadata.
Noted, not changed: studio plan rows must be `active`; legacy lists exist only for Studio Founder Prices; the webhook does not
update `studios.billing_plan`, which the public embed/discover pages still read after a portal plan change (follow-up);
Stripe's Billing Portal cannot change plans on subscriptions with more than one product, so studios with add-ons switch plans
by other means.

## Release sequence (each hosted step needs separate owner authorization)

1. Step 0 evidence accepted (live account, matches production).
2. Step 1 done; verification checklist passed.
3. Done: #302 merged (`d535720d`) and #319 merged (`d5786295`) to `main`. `main` itself is never deployed.
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

- [x] Step 0 account identity: `acct_1TKgL3EY0sTayNiS` live, publishable-key prefix matches (owner evidence)
- [ ] Deployed app confirmed on that account: webhook delivery 200s and API key last-used (owner checks 1–3 above)
- [ ] Dashboard confirms Starter and Growth edits keep their Price IDs (else stop)
- [ ] Step 1 Founder verification checklist passed
- [x] Regular Price edits done by owner (IDs preserved, unused); record evidence table above
- [ ] Residual exposure evidence: Founder Price IDs used by deployed checkout (Logs / no-payment attempts), live portal config, Payment Links/Pricing tables
- [ ] Existing Pro subscription metadata checked and LEGACY env value decided
- [x] #319 independently reviewed and merged to `main` (`d5786295`); release candidate re-verified with the exact reviewed code (256 tests, `tsc` clean, local)
- [ ] Live Stripe portal configuration read (plan switching on/off)
- [ ] Owner authorizes: release branch push, Production env change, staged build, promotion

## Follow-up (explicit, not in this release): `studios.billing_plan` synchronization

Finding: the subscription webhook updates `studio_subscriptions` but never `studios.billing_plan`. Most screens read the
subscription's plan first; the public embed events route (`src/app/api/embed/studios/[studioSlug]/events/route.ts`) and
`src/app/discover/studios/page.tsx` read `studios.billing_plan` directly, so after a Billing Portal plan change they still
see the signup-time plan. Required before any fix ships:
- **Plan-consistency tests:** after a plan change event (Growth→Pro, grandfathered Pro, add-on item first, ambiguous Price),
  `studio_subscriptions.subscription_plan_id` and `studios.billing_plan` agree; a canceled or ended subscription follows the
  existing downgrade rules; replayed and out-of-order events converge to the latest subscription state.
- **Tenant-isolation tests:** an event for studio A (including via the `stripe_customer_id` fallback when metadata has no studio)
  cannot change `billing_plan` or any plan state for studio B; two studios sharing a Price ID are independent; an
  unknown customer changes nothing.
- Decide whether to remove the denormalized column reads instead of syncing; either way public pages must not show a plan the
  studio no longer has. Needs an owner decision and, if a column write or backfill is chosen, separate database authorization.

## Not in this release

Entitlement enforcement (instructors, locations, Payroll Prep), legacy-subscriber MRR estimates, final Founder duration
policy, regular pricing activation, annual and Organizer pricing.
