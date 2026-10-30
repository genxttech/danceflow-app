# DanceFlow local E2E / QA environment

How developer QA runs real browser and real Stripe **test-mode** checks without touching DEV or PROD data. Written
after CI-A (early-bird pricing integrity), whose QA uncovered the gaps below.

Hard rules: no production credentials, no live Stripe keys, no real customer data, no changes to DEV/PROD
configuration without owner approval. A workflow that cannot be executed is reported **BLOCKED**, never PASSED.

## 1. Isolated QA database (local Supabase)

- A separate local Supabase project (Supabase CLI, Docker), e.g. `danceflow-e2e-qa` on `127.0.0.1:55321`, loaded with
  the DEV `public` schema **schema-only**. It uses Supabase's local demo keys; no DEV/PROD key is involved.
- A schema-only load has **no reference data and no storage buckets**. Apply the reference seed once per stack (it is
  idempotent). It has two independent guards and aborts, changing nothing, unless both pass: the session must declare
  the local QA stack (`danceflow.qa_stack=local`), and the database must contain only synthetic accounts on reserved
  test domains (`e2e.test`, `example.*`) and at most 50 studios. DEV and PROD hold real accounts, so the seed refuses
  there even if the marker is set; a QA stack that contains a real-email account is refused too (by design):

  ```bash
  docker exec -i -e PGOPTIONS="-c danceflow.qa_stack=local" supabase_db_danceflow-e2e-qa     psql -U postgres -v ON_ERROR_STOP=1 -1 < e2e/setup/qa-reference-data.sql
  ```

  It provides:
  - `accounting_categories`, extracted verbatim and in order from every migration that seeds that table
    (20260715 insert + its entry_type/normal_balance backfill, 20260720 retail, 20260722 commerce, 20261109
    competition); regenerate the file when a migration adds categories. Without them the `event_payments`
    accounting trigger raises `Unknown accounting category: event_ticket_revenue` and real payment settlement rolls
    back its payment rows.
  - storage bucket `document-files`: private, **15 MB** limit, as configured in DEV/PROD (the bucket is not created by
    any repo migration). `registration-failure-document-setup.spec.ts` depends on the limit.
- The specs create run-scoped fixtures (random ids/slugs/accounts) and delete them in `afterAll`
  (`E2E_KEEP_FIXTURES=true` keeps them for debugging).

## 2. App under test

Run the app locally (`next dev -p 3100`) with:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | the local QA stack |
| `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SITE_URL`, `APP_URL` | `http://localhost:3100` |
| `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Stripe **test** keys (`sk_test_` / `pk_test_`) only |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | the `stripe listen` signing secret (section 3) |
| `STRIPE_WEBHOOK_SECRET` | a **different** value (see section 3) |

Pass keys through the process environment for the run; do not write them into tracked files or print them. Email/SMS
provider keys are deliberately not set, so no message leaves the machine.

## 3. Stripe webhooks: platform and Connect secrets must differ

The webhook route (PAY-DC-2B, `src/lib/payments/webhookVerification.ts`) decides an event's scope from **which secret
verified it**: platform events never carry `event.account`; Connect events always do. If both variables hold the
same secret, every Connect event verifies as "platform" and is rejected with `400 webhook_scope_mismatch` -- that is
the protection working, not an app defect.

`stripe listen` signs everything it forwards with one per-account secret, so locally:

```bash
stripe listen --forward-connect-to http://localhost:3100/api/payments/webhook   # event checkouts are Connect-scoped
```

- `STRIPE_CONNECT_WEBHOOK_SECRET` = that listen secret (`stripe listen --print-secret`).
- `STRIPE_WEBHOOK_SECRET` = a random value that can never verify (do not leave it equal to the Connect secret).
- Platform-scoped flows (SaaS billing) need their own run with the roles swapped; one listen secret cannot serve both
  scopes at once.
- `stripe listen` changes nothing in the Stripe dashboard. The DEV Stripe **test** platform currently has no webhook
  endpoints, so test events reach only the local listener.

## 3a. Platform-scoped run: studio subscriptions (BILLING-QA-2)

`e2e/tests/studio-subscription-stripe-test-mode.spec.ts` covers DanceFlow's own subscription billing
(`/api/billing/checkout`, the Billing Portal redirect and the platform `checkout.session.completed` /
`customer.subscription.*` webhooks). Its events are platform-scoped, so the secrets are swapped:

```bash
stripe listen --api-key <sk_test_...> --forward-to http://localhost:3100/api/payments/webhook
```

- `STRIPE_WEBHOOK_SECRET` = that listen secret; `STRIPE_CONNECT_WEBHOOK_SECRET` = a different value that never verifies.
- App **and** spec get the same `STRIPE_PRICE_STUDIO_{STARTER,GROWTH,PRO}_FOUNDER` (TEST Prices of the current
  amounts; check them first with the BILLING-QA-1 price verifier) and the same pricing flags. The spec computes what checkout
  should charge with the app's own `selectStudioMonthlyPrice`, so a run with Regular pricing activated (and Founder off)
  checks the Regular Prices instead.
- Optional `STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY` (app and spec): a TEST Price standing in for the grandfathered Pro
  Price; without it the grandfathered case (B6) is skipped, which is reported as skipped, never as passed.
- The sandbox needs a saved **test-mode** Billing Portal configuration, otherwise the existing-subscriber cases fail at
  the portal redirect.
- `E2E_STRIPE_TEST_SECRET_KEY` must be the app's test key (same account). No connected account is needed.

```bash
E2E_BASE_URL=http://localhost:3100 E2E_SUPABASE_URL=http://127.0.0.1:55321 E2E_SUPABASE_SERVICE_ROLE_KEY=<local QA key> \
E2E_STRIPE_TEST_SECRET_KEY=<sk_test_...> STRIPE_PRICE_STUDIO_STARTER_FOUNDER=... STRIPE_PRICE_STUDIO_GROWTH_FOUNDER=... \
STRIPE_PRICE_STUDIO_PRO_FOUNDER=... STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY=... \
npx playwright test e2e/tests/studio-subscription-stripe-test-mode.spec.ts --project chromium
```

What it proves: each plan's checkout opens a test Session on exactly the expected Price and amount; paying it records
the plan for exactly that studio via signed webhooks; an existing subscriber is sent to the Billing Portal with no new
Session and no re-pricing; a plan change follows the Price (not stale `planCode` metadata) and a replayed event changes
nothing; a grandfathered subscription on a legacy Price resolves by Price alone and is never re-priced. Case B5 is an
expected failure (`test.fail`) documenting the known gap that `studios.billing_plan` is not synced; it starts failing
loudly once that is fixed, so the marker must then be removed. Test customers (and their subscriptions) are deleted
afterwards. Not covered here: a server whose Price is the wrong amount (`price_mismatch`) -- that needs a different
app configuration and is covered by unit tests and the BILLING-QA-1 price verifier.

## 4. Stripe test account

- DEV's Stripe **test** platform with an existing Express **test** connected account that has charges enabled (event
  checkouts are direct charges on the studio's connected account). Pass its id as `E2E_STRIPE_TEST_CONNECTED_ACCOUNT`.
- Test payments accumulate on that test account (no real money). The QA suite does not refund them.
- Web checkout: the browser is redirected to the real hosted Checkout page, but the page is **not** driven by
  automation -- it runs Stripe bot detection (hCaptcha), which must never be bypassed. The session is paid the way
  Stripe's own CLI completes test sessions (`stripe trigger checkout.session.completed`): a `tok_visa` PaymentMethod
  confirmed via `POST /v1/payment_pages/{session}/confirm` with the test key. Stripe then emits the authentic, signed
  `checkout.session.completed` / `payment_intent.succeeded` events. Typing the card into the hosted page remains
  unautomated (residual: hosted-page UI only).
- Native (PaymentSheet): the app's PaymentIntent is confirmed with Stripe's test method `pm_card_visa`. This covers the
  native **API and payment**; it is **not** a mobile UI test (section 6).
- Replay: `POST /v1/events/{id}/retry` with `for_stripecli=true&account=<acct>` (what `stripe events resend` sends)
  makes Stripe re-deliver an authentic event.

Run:

```bash
E2E_BASE_URL=http://localhost:3100 E2E_SUPABASE_URL=http://127.0.0.1:55321 E2E_SUPABASE_SERVICE_ROLE_KEY=<local QA key> \
E2E_STRIPE_TEST_SECRET_KEY=<sk_test_...> E2E_STRIPE_TEST_CONNECTED_ACCOUNT=<acct_...> \
npx playwright test e2e/tests/ticket-early-bird-stripe-test-mode.spec.ts --project chromium
```

The Stripe spec skips itself (it constructs no Stripe client) without a test key (`sk_test_` or restricted `rk_test_`)
and a test connected account, and refuses live keys, non-local databases and non-local app URLs. Fixtures are
generated with ids up front; a failed creation cleans up what it wrote, and cleanup (including signature rows and
signed files under `studios/<run studio>/`) checks every delete and fails loudly if anything is left.

## 5. Dedicated Playwright CI environment (not yet configured)

CI's `Playwright E2E` job is skipped because `E2E_SUPABASE_URL` / `E2E_SUPABASE_SERVICE_ROLE_KEY` are not set (it
fails closed rather than guess a target). To run it in CI, with owner approval:

1. A dedicated non-production Supabase project (not DEV, not PROD), migrated from the repo and seeded with
   `e2e/setup/qa-reference-data.sql`.
2. Repo secrets for that project only.
3. For Stripe test-mode specs: a Stripe test key scoped to the QA test platform (ideally a restricted `rk_test_` key),
   a dedicated test connected account, the Stripe CLI in the runner for `stripe listen`, and an explicit allow-list
   of the CI QA host in the spec's local-only guard.

## 6. Mobile (Expo) UI

The native purchase screen (`mobile/student/app/events/[id]/register.tsx` and the PaymentSheet in
`app/events/orders/[orderId].tsx`) needs a native runtime: `@stripe/stripe-react-native` has no web target and the app
has no `react-native-web`. Mobile UI QA requires an Android emulator/device (Android SDK) or iOS simulator (macOS) with
an Expo development build pointed at a non-production backend, plus a UI driver (e.g. Maestro). Until that exists,
mobile UI coverage is **BLOCKED**; the native API, pricing parity (byte-identical shared rule) and the app sending the
shown price are covered by unit/guard tests and the native API run.

## 7. Temporary vs durable

| Item | Status |
|---|---|
| Reference seed + bucket limit | Durable: `e2e/setup/qa-reference-data.sql` |
| Stripe test-mode spec + fixture | Durable: `e2e/tests/ticket-early-bird-stripe-test-mode.spec.ts`, `e2e/helpers/stripeTestModeFixture.ts` |
| Local launcher that injects test keys and starts `stripe listen` | Local only (developer scratch); described above |
| Run-scoped fixtures | Created and deleted per run |
| Playwright CI environment, mobile UI runtime | Not available -- tracked engineering tasks |

## 8. Behaviour recorded by the Stripe spec (existing product behaviour, unchanged)

**Lead / contact capture after event purchases** (`src/app/api/payments/webhook/route.ts`,
`safeCaptureStudioEventRegistrationLead`, `safeCaptureOrganizerEventRegistrationContact`):

- Runs only inside the **paid** settlement handlers (event registration `checkout.session.completed`, event cart
  `checkout.session.completed` with `payment_status = paid`, and event cart `payment_intent.succeeded`), after the
  Stripe-reference binding check. Not called by competition registration settlement.
- Studio-hosted event (no `organizer_id`): finds a `clients` row for the studio by buyer email or creates one with
  `status = 'lead'`, `referral_source = 'Event Registration'`, links the registration, and adds a notification.
- Organizer listing: no studio client; upserts an `organizer_contacts` row by email and an
  `organizer_contact_registrations` row per registration (unique on `registration_id`).
- Verified by the spec: refused (price changed, web and native), pending (unpaid session), declined-card and sibling
  unpaid orders create **nothing**; a paid purchase creates exactly one lead/contact; Stripe re-delivery creates no
  duplicates.
- Policy note: this applies to ordinary event tickets. Whether ordinary ticket buyers should become studio leads is an
  owner policy decision; the prohibition on automatic lead/client creation for competition participants and spectator
  ticket purchases is unaffected (competition settlement does not call these functions).

**Webhook ordering for web cart payments** (existing behaviour): Stripe can deliver `payment_intent.succeeded` before
`checkout.session.completed`. The PaymentIntent is only bound to the order by the session event, so that first
delivery is answered `500 event_payment_reference_mismatch` and recorded `failed` in the webhook ledger. The order is
settled by `checkout.session.completed`. In production Stripe retries the failed delivery automatically with backoff
(`stripe listen` does not retry, so locally the spec re-delivers it via Stripe's event retry); that later delivery
succeeds and re-applies the paid state -- same amount, no duplicate payment rows, tickets or contacts, but `paid_at` is
rewritten. **This is tracked as a priority payment-integrity defect** (every web cart payment produces a 500, a
failed-ledger row and Stripe retries, which mask real failures and can trigger Stripe endpoint-failure alerts); the fix
is a separate payments work item, not this QA change.
