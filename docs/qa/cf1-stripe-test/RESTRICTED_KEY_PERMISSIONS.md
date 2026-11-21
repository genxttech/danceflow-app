# Restricted TEST key (`rk_test_`) for the Competition canary: permissions and limits (2026-11-19)

Owner request: use a dedicated restricted TEST key for the canary, without reusing, rotating or revoking the existing D24 credential. Nothing here creates a key or calls Stripe. Sources: Stripe "Restricted API keys" and "API permissions reference" (docs.stripe.com/keys/restricted-api-keys, docs.stripe.com/keys/permissions-reference), read 2026-11-19.

## 1. What the guard does with each endpoint, and the permission Stripe documents for it
| Canary | Request | Stripe permission (API name) | Level | Applies to |
|---|---|---|---|---|
| all | `GET /v1/balance` (livemode check) | `balance_read` | Read | own account |
| all | `GET /v1/accounts/{pinned connected id}` (state recorded; platform ownership proven) | `connected_account_read` (marked "Direct": fine, this call has no `Stripe-Account` header) | Read | own account |
| A | `POST /v1/checkout/sessions`, `POST /v1/checkout/sessions/{id}/expire`, `GET /v1/checkout/sessions/{id}` | `checkout_session_write` (write includes read) | Write | **connected accounts** (these carry `Stripe-Account`) |
| C | `POST /v1/payment_intents` (create + confirm with `pm_card_visa` + application fee) | `payment_intent_write` | Write | **connected accounts** |
| C, B | `GET /v1/payment_intents/{id}` with `expand[]=latest_charge` | `payment_intent_read` (included in write) and `charge_read` for the expanded charge | Read | **connected accounts** |
| B | `POST /v1/payment_methods` (a `tok_visa` card) | `payment_method_write` | Write | **connected accounts** |
| B | `GET /v1/payment_pages/{cs}` and `POST /v1/payment_pages/{cs}/confirm` | **none documented** | none | connected accounts |
Stripe states that permissions marked "(Direct)" cannot authorize Connect call patterns (requests with `Stripe-Account`), and that when you use Connect the key editor lets you choose the level for access to connected accounts separately. The API permission names above are authoritative; the Dashboard may label them slightly differently (Balance; Connected accounts; Checkout Sessions; PaymentIntents; PaymentMethods; Charges and Refunds).

## 2. Exactly what to select in the Stripe sandbox
Create ONE new restricted key in the DanceFlow D24-M3 Test Sandbox ("Create restricted key", name it e.g. `cf1-canary-rk`, expiry 24 hours if the editor offers it). Start from zero permissions, then:
- Own account: **Balance: Read**; **Connected accounts: Read**.
- Access to connected accounts (the Connect column): **Checkout Sessions: Write**; **PaymentIntents: Write**; **PaymentMethods: Write**; **Charges and Refunds: Read**.
- Everything else: **None**. No webhook endpoints, no Events, no Customers, no Payouts, no Account write, no Refunds write.
Enter the resulting `rk_test_...` value only as the environment secret `CF1_STRIPE_TEST_SECRET_KEY` (the secret name is unchanged on purpose; the guard accepts `sk_test_` and `rk_test_` and nothing else). The existing D24 key is never used, rotated or revoked by this.

## 3. Compatibility verdict (stated plainly)
- **Canary A (create and expire a Checkout Session with an application fee): supported.** All of its requests have documented permissions.
- **Canary C (new, documented endpoints only: a direct $1 PaymentIntent confirmed with a TEST card and the same application fee): supported.** It answers the capability question ("can this connected account take a card payment and carry the fee?") with a restricted key.
- **Canary B (pay the Checkout Session through the payment page): NOT supported by any documented permission.** `/v1/payment_pages/...` is an undocumented endpoint (the hosted page and the CLI use it); it does not appear anywhere in Stripe's permissions reference, which says every documented endpoint maps to at least one permission. It may work or it may return a permission error; the only way to know is the first run. This is not weakened or skipped: B stays in the canary. If B fails with a permission error, the report says so as its own failure kind (exit code 3), states whether canary C had passed (account proven, key limited), quotes Stripe's exact error (which names the permission Stripe would need), and stops. It never falls back to another key. Each such discovery costs one approval click.
- **Consequence for the FULL suite:** `payCheckoutSession` in the existing Q1 spec uses the same payment-page confirm. If B is refused for a restricted key, the full suite cannot run on a restricted key. The safest alternatives then are, in order: (1) the owner decides that the Checkout confirm step is verified another way (for example Stripe CLI `stripe trigger` equivalents, which also need a full key), or accepts a standard key in a dedicated sandbox; (2) a new standard TEST key from a different sandbox (needs its own connected account and onboarding, so its own authorization); (3) reuse of the D24 key in a separate environment, which the owner has ruled out. None is chosen here.
- Not needed for the canary but needed later for the full suite with ANY key: Events: Read (connected accounts) for the relay, Charges and Refunds: Write (connected accounts) for refunds the app creates, Checkout Sessions and PaymentIntents as above, and the payment-page confirm.

## 4. What changed in the guard (PR to `release/website-embeds`)
- Accepted keys: `sk_test_...` and `rk_test_...` only; a live key, a publishable key or a malformed value stops before any Stripe call (tested).
- Identity: a standard key must read its own account and equal the pinned platform (unchanged, tested). A restricted key does not read `GET /v1/account` (no documented least-privilege permission for it); it proves its platform by retrieving the PINNED connected account, which only the owning platform's key can do. The choice is made by key type, deterministically, never by catching a failure. The report states which proof was used.
- New failure kind `permission` (Stripe `StripePermissionError`, HTTP 403, or the "does not have the required permissions" wording), checked BEFORE capability so a "restricted key" message is never mistaken for an account problem. Exit code 3. All error fields remain masked.
- New canary C and the PARTIAL message described above. Regression tests cover: restricted key passes without reading `/v1/account`; standard key still pinned; live/publishable/malformed keys refused; permission vs capability classification (both directions); the PARTIAL path; capability error at C stops before B; the exit-code mapping; masking of an `rk_test_` fragment inside a permission error.
