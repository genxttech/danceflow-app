# Billing QA tools

QA for DanceFlow's own studio subscription billing (`/api/billing/checkout`, the billing portal, the platform
subscription webhooks). The existing harnesses cover Connect-scoped studio payments only (CI-A event checkout, the
floor-rental payment harness); none covered subscription pricing, which is why the PRICING-P1 checks were owner-run.

This page covers **BILLING-QA-1**: the shared PASS / FAIL / BLOCKED report format and the Stripe **test-mode** Price
verifier. Later slices (test-mode subscription checkout and webhook spec, webhook route tests, a read-only deployed
price-config check, and an owner-run no-payment smoke kit) use the same report format.

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
`src/lib/billing/plans.ts`, so it checks exactly what checkout and the webhook will do.

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
