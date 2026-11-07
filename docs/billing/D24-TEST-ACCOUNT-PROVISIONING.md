# D24 TEST connected-account provisioning (workstream C, part 1)

Status: **design + offline tooling only (plan + dry-run). Nothing here has called Stripe, and `--live` is permanently disabled in this PR (exits 3, reads nothing, sends nothing).** Live provisioning is re-enabled only later, through the test-runner's owner-signed envelope, ledger and credential store, in a separate reviewed change.
Scope: a production-equivalent Express connected account in the dedicated D24 Stripe TEST sandbox, for the M3-D proof (`scripts/qa/d24-m3d-proof`, main `b1a91b58`).
Code: `scripts/qa/d24-test-provision/` (new; the proof folder is untouched and still hashed).

Evidence legend: **[code]** read from this repository; **[sdk]** read from the installed `stripe@22.0.1` typings; **[docs]** read from docs.stripe.com while writing this (no API call); **[unverified]** inferred or not stated by the docs, to be observed by the first supervised run, never assumed.

## 1. Exact production onboarding configuration

| Item | Value | Source |
|---|---|---|
| Create call | `stripe.accounts.create({ type: "express", capabilities: { card_payments: { requested: true }, transfers: { requested: true } }, metadata: { studioId } })` | [code] `src/app/api/stripe/connect/onboarding/route.ts:69-77` |
| Not sent | `country`, `business_type`, `email`, `business_profile`, `controller`, `settings`, `tos_acceptance`, prefill data | [code] |
| Follow-ups | `accounts.update(id, { capabilities: card_payments+transfers requested })`; then `accountLinks.create({ account, refresh_url: <app>/app/settings/billing, return_url: <app>/api/stripe/connect/return, type: "account_onboarding" })` and a redirect to `accountLink.url` | [code] route.ts:92-103 |
| Who may call | `studio_owner` / `studio_admin` / platform admin; id stored server-side (service role) only while the column is NULL | [code] |
| SDK | `stripe` `^22.0.1` (installed 22.0.1); `new Stripe(STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 30000 })`, **no `apiVersion` option**, so the SDK default applies | [code] `src/lib/payments/stripe.ts` |
| API version | `2026-03-25.dahlia` = `ApiVersion` in `node_modules/stripe/cjs/apiVersion.js`; equal to the proof's `STRIPE_API_VERSION` (a test in the new folder fails if the three ever diverge) | [sdk][code] |
| Country | not passed, so Stripe uses the platform account's country | [docs: country is optional] |

Consequence: the account the proof needs is "whatever `accounts.create` with exactly those parameters returns", not a hand-built controller combination. The earlier test account was created with controller parameters that left `losses.payments` and `fees.payer` at non-`application` values, so the proof's identity gate (correctly) refused it.

## 2. What the create returns under 2026-03-25.dahlia, and whether it is usable

### 2.1 Returned shape
* The `type` parameter is documented as **deprecated in favour of `controller`**; the docs' sample response for a controller-created Express-dashboard account shows `type: "none"` with `controller = { type: "application", is_controller: true, requirement_collection: "stripe", stripe_dashboard: { type: "express" }, losses: { payments: "application" }, fees: { payer: "application" } }`, `capabilities: {}`, `charges_enabled: false`. [docs]
* The SDK typing allows `controller.fees.payer` ∈ `account | application | application_custom | application_express`. [sdk]
* For `type: "express"` the docs fetched here do **not** state the returned `account.type` or the exact controller values. The expectation (`type: "express"` legacy, or `none` + Express-equivalent controller; `stripe_dashboard.type = express`, `requirement_collection = stripe`, `losses.payments = application`, `fees.payer = application` or `application_express`) is **[unverified]** until observed. The provisioning script records the raw observed enums (`observedController`) and the proof's identity gate (`checkConnectedAccount`, **unchanged and reused**) decides. It accepts exactly: legacy `express`, or `none` with the exact Express-equivalent controller. Nothing is loosened; an unexpected combination makes provisioning abort and is a finding for the owner, not something to tune around.

### 2.2 Usable without a human?
* A freshly created account has `capabilities` requested but **inactive**, `charges_enabled=false`, and `requirements.currently_due` populated (business profile, external account, representative, ToS...). [docs sample]
* Test data can satisfy verification through the API (DOB `1901-01-01`, `address_full_match`, SSN `000000000`, phone `0000000000`, `business_profile.url=https://accessible.stripe.com`, test bank `110000000`/`000999999991`, SMS code `000-000`). The docs' own example supplies those on `accounts.create`. [docs `connect/testing`] That is **not** the production create shape; using it would need either extra parameters on the create or a second write (`accounts.update`). Both are deliberately **not implemented**: it would make the fixture differ from production in the one place we are trying to match, and it adds a write. If needed it is a separate owner-approved step.
* Account Links / hosted Express onboarding in test mode: the pages fetched do not describe skipping or auto-completing it. A human walking through hosted onboarding with test data is the documented-safe way to activate capabilities. [unverified for any automation]
* Sandboxes "might not enforce some capabilities... an account can perform capability-dependent actions even when the capability's status isn't active". [docs] Do not use sandbox behaviour as evidence about production capability activation.
* **What the proof actually needs:** a customer and a draft `send_invoice` invoice created on the connected account through `Stripe-Account`, read back, then deleted. It never finalizes, sends or charges. Whether Stripe permits that on an account with inactive capabilities is **[unverified]**; the first supervised run answers it (a 4xx aborts safely at the first scenario call; the proof already treats unexpected 4xx streaks as an abort). Fallback if refused: the owner completes hosted onboarding once, in the TEST dashboard, with the documented test data.

**Recommendation:** provision with the production-shaped create only, run the proof's identity gate, and let the proof's S-series show whether draft invoices work. Do not add prefill.

## 3. Keys and permissions

HTTP method maps to RAK permission (GET=read, POST/DELETE=write; write implies read). [docs `keys/restricted-api-keys`] The Dashboard's exact labels for Connect resources are not given in the pages read; the owner reads them off the key-creation screen and records them in the envelope (open item O-1 in the proof plan is the same issue).

| Key | Calls | Permissions (least privilege) |
|---|---|---|
| **Provisioning key** (new, separate) | `GET /v1/account`, `POST /v1/accounts`, `GET /v1/accounts/{id}` | Accounts **Write** (covers the read of the new account and of `/v1/account` if the dashboard groups them; if `GET /v1/account` returns 403, add the single read permission the 403 body names and re-run under a new envelope). Everything else **None**. No Customers, Invoices, Balance, Transfers, Account Links, webhooks. |
| Proof key (existing design) | identity reads, customers/invoices on the connected account, 2 expected-403 reads | Invoices **Write**, Customers **Write**, connected-account **Read**; everything else None (proof README / plan 3). It must **not** carry Accounts Write: the proof allow-list has no `POST /v1/accounts`, and a key that can create accounts is wider than the proof needs. |

**Separate, short-lived provisioning key: yes.** It is used for three requests, once. Docs describe keys being rolled or expired with an optional delay of up to 7 days; no create-time expiry is documented, so "short-lived" means the owner **expires it immediately after the run** (as the proof already requires for its key) and verifies the key's request log shows exactly the three expected requests. [docs] The provisioning key never enters the proof environment.

## 4. The provisioning script (default deny)

`npx tsx scripts/qa/d24-test-provision/run.ts --plan | --dry-run` (`--live` is accepted as a flag only to be refused)

* `--plan` prints the three requests; `--dry-run` runs the whole flow against an in-memory fake (no network, no key). Both need nothing.
* Allow-list (`allowProblem`, checked before the transport): `GET /v1/account` (platform identity), one `POST /v1/accounts` with exactly the production body plus three fixture-marker metadata keys, and `GET /v1/accounts/<the id this run just created>`. Everything else (DELETE, update, account links, login links, any other path, `Stripe-Account`, query strings, a second create, a create before the platform is verified, a missing/changed `Stripe-Version`) is refused with no network I/O. Hard cap 3 requests, **no retry** (a lost create is reported "may have happened, do NOT retry", the owner checks the TEST dashboard for `d24_envelope_ref`).
* Transport: **none real.** `provision.ts` and `run.ts` import no network transport (a test greps both sources). The flow runs only against the in-memory fake. The design for a future live transport is the proof's `createNodeTransport` (node:https, `agent:false`, `Connection: close`, one host `api.stripe.com`, no redirects), to be wired in by the test-runner, not here.
* Platform identity pinned (`D24_PROVISION_EXPECT_PLATFORM_ACCT`); a different platform aborts **before** the create. `livemode:true` or a different API version in any response aborts.
* Idempotency key `d24prov-<24 hex>` is random per run; only its SHA-256 is stored.
* Marker metadata on the account: `d24_proof_fixture=true`, `d24_fixture_role=express_prod_equivalent`, `d24_envelope_ref=<ref>`.
* Both the create response and an independent readback are judged by the proof's unchanged `checkConnectedAccount`, and the readback metadata must carry the markers.
* Evidence (design for the later live path, not implemented here): a dedicated directory outside git validated by the proof's `evidenceDirProblem`, exclusive-create, mode 0600, holding the new account id, request ids and observed enums, never the key or the idempotency key.

## 5. Why it cannot be run live

`--live` exits 3 unconditionally, before any environment variable is read and before any transport is touched. The code path that built a real transport and could send `POST /v1/accounts` was **removed** (it was previously guarded only by a public-format regex and a fixed phrase, with the pinned platform id taken from the same environment as the key, so any `rk_test_` key would have made a real create). Tests prove: with every old variable set and a transport injected, `--live` exits 3, makes zero transport calls and reads zero environment variables; and the CLI sources contain no `createNodeTransport`, `node:https`, `node:fs` or env-index access. The pure request builder, the allow-list and the fake-transport tests are kept as the design record. **Do not run provisioning live from this tool.** Re-enabling it is a later change that must use the test-runner's owner-signed envelope, ledger and credential store.

## 6. The old account: NEGATIVE fixture

* Role: `negative_mismatched_controller`. It is kept so the identity gate has a real counter-example, never as the proof target. Its Stripe-side label cannot be set without a write; the label therefore lives in the evidence record: the owner (or engineering, with an approved envelope) records `{ accountId (masked in git), role, why: "losses.payments / fees.payer not application", observedAt }` in the evidence folder's `fixtures.json`. Do not put its full id in git.
* Use: the proof run (or the identity-gate unit test) points `D24_PROOF_EXPECT_CONNECTED_ACCT` at it once, expecting abort `identity_mismatch` after exactly 2 reads (platform + connected), with no write. Offline coverage already exists: `provision.test.ts` feeds the old-account shape (`losses.payments=stripe`, `fees.payer=account`, and each variant singly) to `checkConnectedAccount` and to the whole provisioning flow and requires rejection.
* It must never appear in a positive-run environment variable again; deleting it in the TEST dashboard is an owner choice after the new account passes.

## 7. How the new account is verified by the proof's gate

Unchanged: the proof's S0 reads `GET /v1/account` (pinned platform) and `GET /v1/accounts/<new id>` and runs `checkConnectedAccount`. Pass requires legacy `express`, or `none` with the six exact controller values above. `observedController` in the provisioning evidence is only an owner-readable echo; a mismatch there already aborts provisioning, and the proof will independently reject it again. The new id replaces `D24_PROOF_EXPECT_CONNECTED_ACCT`; the proof manifest hash is unaffected (no proof file changed).

## 8. Owner-only actions

1. Create (or confirm) the dedicated D24 TEST sandbox platform; supply its `acct_` id for pinning.
2. Create the separate provisioning RAK (Accounts Write only) only when the later, test-runner-based live path exists; the owner issues the signed envelope there (the earlier envelope-reference/phrase scheme in this tool is retired).
3. After the run: expire the provisioning key at once; check its request log shows exactly 3 requests; (optional) complete hosted onboarding with test data if the proof shows draft invoices need active capabilities.
4. Record the negative-fixture label; decide whether to delete the old account.
