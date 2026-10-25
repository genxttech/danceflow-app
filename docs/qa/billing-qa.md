# Billing QA tools

QA for DanceFlow's own studio subscription billing (`/api/billing/checkout`, the billing portal, the platform
subscription webhooks). The existing harnesses cover Connect-scoped studio payments only (CI-A event checkout, the
floor-rental payment harness); none covered subscription pricing, which is why the PRICING-P1 checks were owner-run.

This page covers **BILLING-QA-1** (the shared PASS / FAIL / BLOCKED report format and the Stripe **test-mode** Price
verifier) and **BILLING-QA-4** (the read-only deployed price-config endpoint, below). The test-mode subscription
lifecycle spec and webhook route tests are BILLING-QA-2/-3 (PRs #334/#335); once merged they are described in
`docs/qa/local-e2e-environment.md` §3a. The owner-run no-payment production smoke and its read-back verifier
(BILLING-QA-5) are in `docs/qa/billing-owner-smoke-kit.md`.

## Report format (`src/lib/billing-qa/report.ts`)

| Status | Meaning |
|---|---|
| `PASS` | The property was checked and holds. |
| `FAIL` | It was checked and does not hold. Carries a reason code. |
| `BLOCKED` | It could not be checked (missing configuration, Stripe unreachable, no permission). Carries a reason code. **Never counted as a pass.** |

- Overall: `FAIL` if any check failed; otherwise `BLOCKED` if any check was blocked **or no check ran**; `PASS` only
  when every check passed.
- Each check has a stable `id`, a `title`, optional `detail`, and `evidence` (Price IDs, amounts, flags only).
- A report never contains a key or secret: building one that does throws.
- JSON shape: `{ tool, mode, startedAt, completedAt, config, overall, counts, checks[] }`.

Exit codes: `0` PASS, `1` FAIL, `4` BLOCKED (same meaning as `scripts/qa/iso-qa.mjs` exit 4), `2` usage error or
safety refusal.

## Price verifier (`scripts/qa/billing-price-verify.ts`)

Read-only: the only Stripe call is `prices.retrieve`. It uses the app's own selection and matching functions
(`selectStudioMonthlyPrice`, `stripePriceMatchesExpected`, `resolvePlanCodeFromEnvPriceId`) and the amounts in
`src/lib/billing/plans.ts`, so it checks exactly what monthly studio checkout will charge and how the webhook maps the
configured env Price IDs. Not checked: Price IDs stored in the database (`subscription_plans.stripe_price_id_*`), which
the webhook consults first, and yearly checkout. A Founder (or Regular) Price ID that is unset while that offer is
inactive is not reported, because checkout never uses it.

| Check | PASS when |
|---|---|
| `founder.<plan>` | the configured Founder Price is active, USD, monthly and exactly the Founder amount ($59 / $99 / $159) |
| `regular.<plan>` | the configured STANDARD Price is exactly the provisional regular amount ($89 / $149 / $249). Checked whenever it is set, so Regular Prices can be validated before activation; `--require-regular` reports a missing one as BLOCKED |
| `legacy.<plan>.N` | each grandfathered Price exists and is a monthly USD Price (archived is allowed; the amount is reported) |
| `mapping.<ENV>` | the Price ID resolves to exactly its own plan in subscription plan resolution |
| `checkout.<plan>` | a new subscriber's checkout, with the current flags, would charge the right Price at the right amount (FAIL if checkout would refuse) |

Common reason codes: `price_mismatch`, `price_not_found` (often a live Price ID given to a test key),
`checkout_refuses_price_id_missing`, `checkout_refuses_regular_pricing_not_activated`, `price_maps_to_no_single_plan`,
`price_id_not_configured`, `stripe_auth_failed`, `stripe_permission_denied`, `stripe_unavailable`.

### Safety

- Key from `BILLING_QA_STRIPE_TEST_KEY` only, never `STRIPE_SECRET_KEY`. `sk_test_` / `rk_test_` only; a live key is
  refused before any request. A restricted key with only **Prices: Read** is enough.
- Every Price read back must be `livemode: false`; a live object aborts the run (exit 2).
- No writes to Stripe, no database access, no app server needed.
- Live-mode read-only verification of production Prices is **not** part of this slice. It needs its own guard and an
  owner-provided read-only key, and stays behind owner approval.

### Run

```bash
cp .env.billing-qa.example .env.billing-qa.local   # fill in the test key and TEST-mode Price IDs
npm run qa:billing-prices -- --env-file .env.billing-qa.local
npm run qa:billing-prices -- --env-file .env.billing-qa.local --require-regular --out billing-prices.json
```

Example output:

```
billing-qa price verifier (test mode) — PASS
PASS 9  FAIL 0  BLOCKED 0

STATUS   ID                                         REASON  DETAIL
PASS     founder.starter                                    Founder Starter Price is $59.00/month
PASS     mapping.STRIPE_PRICE_STUDIO_STARTER_FOUNDER        STRIPE_PRICE_STUDIO_STARTER_FOUNDER resolves to the starter plan
PASS     checkout.starter                                   charges $59.00/month (founder)
...
```

Out of scope: Organizer pricing and yearly checkout (unchanged by PRICING-P1).

## Deployed price config (`GET /api/platform/billing/price-config`, BILLING-QA-4)

Answers, for the deployment that serves the request, what PRICING-P1 could only learn from the owner: which studio
Price IDs and pricing flags it runs with, whether a Founder variable is blank, which offer checkout would use, whether
the IDs map to their plans in the webhook, whether the Stripe keys are live or test, and whether both webhook secrets
are set and different. Report mode `config` (`src/lib/billing-qa/priceConfigReport.ts`).

- **Read-only:** no Stripe call and no write. The report builder reads only the deployment's environment; the route
  reads only the caller's own profile and MFA status.
- **Not proven here:** Price *amounts*. A PASS from this report never means an amount was verified
  (`config.stripeAmountsChecked` is `false`). Pair the reported IDs with the BILLING-QA-1 verifier (test mode) or the
  BILLING-QA-5 read-back; checkout itself still refuses a wrong amount.
- **Nothing secret:** well-formed Price IDs (anything else is shown as `malformed`, never its value), flags, key
  *modes* (`live` / `test` / `unset` / `unrecognized`) and secret *presence* only; the two webhook secrets are compared,
  never returned. The report builder refuses output containing a key, and the route then answers
  `500 report_refused` without details.
- **Dark:** `404` unless `BILLING_QA_PRICE_CONFIG_ENDPOINT=enabled` in that environment, checked before any auth
  lookup. Enabling it in Production is an env change plus a redeploy, so it needs owner approval.
- **Access:** platform admins only (everyone else, signed in or not, gets the same plain `404 Not found` as when dark;
  this is not the framework's HTML 404, so the route's existence is not hidden), with a verified TOTP factor and an
  AAL2 session, the same bar as `/platform` (`requirePlatformMfa`); `403 platform_mfa_required` otherwise. Responses
  are `no-store`.

| Check | PASS when |
|---|---|
| `stripe.keys` | secret and publishable keys are set and in the same mode (the mode is reported) |
| `stripe.webhook_secrets` | platform and Connect secrets are both set and different |
| `founder.<plan>` / `regular.<plan>` | the Price ID is set and well-formed; required when that offer is what checkout uses, otherwise checked only if set |
| `legacy.<plan>.N` | each grandfathered Price ID is well-formed |
| `mapping.<ENV>` | the Price ID resolves to exactly its own plan in subscription plan resolution |
| `checkout.<plan>` | checkout would use a Price for a new subscriber (reports which, the offer and the expected amount) |

Use: sign in to `/platform` as a platform admin (with TOTP) in a browser, then open
`/api/platform/billing/price-config` in the same browser. The JSON uses the shared report shape.
