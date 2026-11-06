# D24 M3-D — Stripe TEST-mode proof PLAN (hosted-invoice draft creation)

Status: **PLAN ONLY. Document-only. Nothing in this file has been executed or authorized: no Stripe call (test or live), no sandbox, account, key, customer, invoice, webhook endpoint or database object has been created.** Every step is a *proposal* that needs the owner's explicit written approval of the exact request in section 13. Approving this document is not approving the proof.

## 1. What the proof is for (and is not for)

The offline acceptance harness (`D24-M3D-ACCEPTANCE.md`) proves the M3 design against real Postgres with a **fake** Stripe whose idempotency semantics are *modelled*. A model can be wrong. The proof answers only the questions that real Stripe alone can answer, in TEST mode, in a throwaway sandbox, with the fewest possible calls:

| # | Question | Why a fake cannot answer it |
|---|---|---|
| V1 | Does `POST /v1/invoices` (`collection_method=send_invoice`, `auto_advance=false`) under `Stripe-Account: <connected test account>` with the platform's restricted TEST key create a **draft** whose response carries the `id`, `livemode=false`, `status=draft`, `customer`, `currency` the orchestrator validates? | response shape, API version |
| V2 | **Duplicate create**: does the same `Idempotency-Key` + same parameters return the **same** invoice (and `Idempotent-Replayed: true`), and the same key with different parameters fail with an idempotency error (which the orchestrator sends to `needs_review`)? | the orchestrator's duplicate and recovery guarantees rest on this |
| V3 | Does `POST /v1/invoices/{id}/add_lines` give `total == sum(lines)` and keep the invoice a draft? And does `ensureCustomer` (`POST /v1/customers` with an idempotency key) return the same customer on replay? | the orchestrator verifies the total and reuses the customer |
| V4 | **Crash after Stripe success**: when the invoice exists but `provider_created` was never persisted (intent `pending`), does a replay of the original key converge to that one invoice? | the core M3-A/M3-B recovery claim |
| V5 | Does creating a draft (and adding lines) send nothing to anyone and trigger no payment attempt? | "draft creation is inert" |
| V6 | Does the key's permission set suffice for exactly the calls the orchestrator needs and **fail** (403) for others? | least-privilege claim |
| V7 | **needs_review**: can an operator resolve an unresolved creation from Stripe evidence (one read) without any replay of the create call? | the reconciliation path |

Explicitly **out of scope** (stays unproven, so each is an activation hold): finalizing, sending or collecting an invoice; real webhook delivery end to end (section 8 is optional and separately approved); LIVE mode of any kind; **idempotency-key expiry/pruning** (the safe-retry window, default 12 h and at most 23 h, rests on Stripe's documented ≥ 24 h retention; this proof does not try to wait for, force or observe pruning); refunds / credit notes against real Stripe; anything touching D7, C6 or production data.

## 2. Dedicated sandbox and identity (before any Stripe call)

* **A NEW Stripe sandbox (test-mode account) created only for this proof**, named `DanceFlow D24-M3 TEST`. It is **not** the D7 price-transition sandbox, **not** the C6 invoice-testing sandbox, **not** DanceFlow Dev / preview / production. Nothing from those accounts (keys, customers, products, prices, webhook endpoints) is reused or even listed.
* **One connected account inside it**, type `express` (what the studio onboarding route creates), created in the sandbox dashboard with Stripe's test onboarding data (no real identity or bank data). Its id is `EXPECT_CONNECTED_ACCT`; the sandbox's own id is `EXPECT_PLATFORM_ACCT`. Both ids are supplied by the owner in the authorization (they are identifiers, not secrets).
* **Identity verification, performed by the proof script before every run and re-asserted on every request; abort on any mismatch:**
  1. the key string matches `^rk_test_[A-Za-z0-9]+$` (restricted, test). `sk_*` (too broad), `*_live_*`, `pk_*` or anything else aborts before any network access;
  2. `GET /v1/account` (key alone) must return `id == EXPECT_PLATFORM_ACCT`;
  3. `GET /v1/accounts/EXPECT_CONNECTED_ACCT` must return that id, `type = express`, and must not say `livemode: true`; because some API versions omit `livemode` on account objects, the binding evidence is the `rk_test_` prefix **plus** every invoice/customer response carrying `livemode:false`; one `livemode:true` anywhere aborts;
  4. every later request carries `Stripe-Account: EXPECT_CONNECTED_ACCT` (the two reads above excepted); the wrapper refuses any other account id, any method/path outside the allow-list (section 3) and any parameter outside the orchestrator's documented set;
  5. the local database is the disposable container started by `scripts/qa/d24-stack.sh` (label `df-d24-qa=1`, `--network none`); no hosted database URL may be present in the environment, else abort;
  6. the sandbox *name* is never trusted as identity — only the pinned ids are.
* The proof key exists only in this sandbox, is created for this proof, is held in the owner's password manager, is pasted by the owner into one shell environment variable (never in chat, a file or Git), and is expired in cleanup.
* Only the host's Node process talks to `api.stripe.com`; the database container stays offline.

## 3. Exact operations and the key permissions each needs (least privilege)

The orchestrator's injected Stripe client has exactly three operations (`ensureCustomer`, `createDraftInvoice`, `addInvoiceLines`); the proof adds only read/cleanup/identity calls. Nothing finalizes, sends, pays, voids or collects.

| Operation | Endpoint | Used by | Key permission |
|---|---|---|---|
| identity (platform) | `GET /v1/account` | identity gate | none beyond a valid key |
| identity (connected) | `GET /v1/accounts/{EXPECT_CONNECTED_ACCT}` | identity gate | Connect: account **Read** (label varies by dashboard; confirmed at key creation) |
| create customer | `POST /v1/customers` (idempotency key, synthetic name, metadata `{d24_intent_id, d24_client_ref}`; the orchestrator adds `email` only when the client profile has one, so the proof fixture client **must have no email**) | `ensureCustomer` | Customers **Write** |
| create draft | `POST /v1/invoices` (`customer, collection_method=send_invoice, days_until_due, currency, auto_advance=false, description?, metadata{d24_intent_id}`) | `createDraftInvoice` | Invoices **Write** |
| add lines | `POST /v1/invoices/{id}/add_lines` (idempotency key `<key>:lines`) | `addInvoiceLines` | Invoices **Write** |
| read back | `GET /v1/invoices/{id}`, `GET /v1/invoices?customer={cus}&limit=100` | evidence, V7 | Invoices (Write includes read) |
| cleanup | `DELETE /v1/invoices/{id}` (drafts only), `DELETE /v1/customers/{id}` | cleanup | Invoices **Write**, Customers **Write** |
| expected-403 negatives | `GET /v1/transfers?limit=1`, `GET /v1/webhook_endpoints`, both sent **with** `Stripe-Account: EXPECT_CONNECTED_ACCT` (the same shape as every other call) | V6 | **None** on Transfers and Webhook Endpoints |

Everything else is **None**, explicitly: Charges/Refunds, PaymentIntents, Payment Methods, Payouts, Balance, Subscriptions, Products/Prices (ad-hoc line descriptions and amounts only), Webhook Endpoints, Customer Portal, any Connect account *write*, API-key/developer settings. Because Invoices Write technically allows finalize/send over the API, the **allow-list wrapper in the proof client is the barrier** for those; it rejects them before any network I/O. (Invoice Items stays **None**: lines go through `add_lines`.)

## 4. Test data requirements

* **Test connected account ↔ test studio:** the script inserts, into the **local** container only, one studio `D24-M3 proof studio` with `stripe_connected_account_id = EXPECT_CONNECTED_ACCT` and `stripe_connect_charges_enabled = true`, a client record (synthetic name, no email) and one invoice-bearing business object owned by it (the harness's QA fixture type, or M3-C's `studio_client_invoice` once its call-site wiring exists). A second local studio with no account and a third bound to a fake id exist only to prove refusal; they never reach Stripe. The hosted `studios` table is never touched.
* **Customers:** created by the orchestrator through `ensureCustomer` from the client record (synthetic, no email, so Stripe has nothing to email even if an invoice were ever finalized by mistake). Expected: 1 customer per client, reused on replay.
* **Invoices:** drafts only, USD, 1–2 lines, totals ≤ $200, `days_until_due` 14–30.
* **Bounds:** at most 4 invoices and 2 customers are created in total.

## 5. Scenarios to prove (and what each would show)

| # | Scenario | Real calls | Pass criteria |
|---|---|---|---|
| S0 | Identity gate (section 2) | 2 | ids match, no `livemode:true` |
| S1 | **Draft creation** via the real orchestrator (customer + invoice + lines) | 3 | `registered`; `status=draft`, `send_invoice`, `auto_advance=false`, `total == sum(lines)`; registry/ledger bind the object |
| S2 | **Duplicate create**: same request key again | 0–1 (ledger short-circuits; one `GET invoices?customer=` = 1 invoice) | same invoice id; Stripe still shows 1 invoice for the customer |
| S3 | **Idempotency at Stripe**: replay `POST /v1/invoices` with S1's key + identical params; then once with a changed `description` | 2 | first: same `in_…` and `Idempotent-Replayed: true`; second: idempotency error |
| S4 | **Concurrent retries**: 3 parallel orchestrator calls, same key, new object | ≤ 6 | exactly one invoice; one intent; one registry row |
| S5 | **Crash after success**: the proof client drops the response after the real create returns, then the process exits; a fresh process replays | 3 + 1 list | one invoice in Stripe; intent `registered`; replay create returned the original id (V4) |
| S6 | **Unknown outcome**: client raises a connection error after a real create (response discarded) | 2 + 1 list | ledger `outcome_unknown`, retry does not call Stripe, the DB recovery claim replays once and converges |
| S7 | **needs_review**: age an intent past the window in the **local** ledger (no Stripe call), then reconcile like an operator: one `GET /v1/invoices?customer=…` to find the draft by `metadata.d24_intent_id`, attach via the platform-admin AAL2 function | 1 | exactly one matching invoice; intent resolved with an audited `operator_attached`; **no** `POST /v1/invoices` issued in this step |
| S8 | **Idempotency retention, bounded**: replay S1's key once ~5 min later and record `Idempotent-Replayed: true`; read Stripe's *documented* retention from the current API reference at run time and record the quoted figure + URL; the configured safe-retry window must be strictly inside it. **No attempt to wait for, force or observe pruning.** | 1 | same id; documented retention recorded; window < retention |
| S9 | **Inertness** (V5): retrieve each invoice; dashboard Events list (read-only) shows only `invoice.created`/`invoice.updated`/`customer.created` | ≤ 4 reads | no `invoice.sent|finalized|paid`, no payment/email events |
| S10 | **Permission negatives** (V6): the two forbidden reads | 2 | both 403 |
| S11 | Cleanup (section 9) | ≤ 8 | zero drafts / customers remain |

**Call budget: 40.** Planned ≈ 32 including S0 and S11. Sequential except S4; 250 ms between calls; hard stop on a 5xx streak of 3 or any 429.

The same scenarios run first against the fake (`d24-acceptance.sh --m3a … --m3b …`, and a `--dry-run` of the proof script with the fake client that prints the planned call list); a red offline run at the same SHAs aborts the plan.

## 6. Allow-list (enforced by the proof wrapper, before any network I/O)

```
GET    /v1/account                                   (no Stripe-Account header)
GET    /v1/accounts/{EXPECT_CONNECTED_ACCT}
POST   /v1/customers                                 DELETE /v1/customers/{id}
POST   /v1/invoices                                  DELETE /v1/invoices/{id}      (drafts only)
POST   /v1/invoices/{id}/add_lines
GET    /v1/invoices/{id}    GET /v1/invoices?customer={cus}&limit=100
GET    /v1/transfers?limit=1    GET /v1/webhook_endpoints      (the two expected-403 negatives only; with the Stripe-Account header)
```
Rejected without a request: finalize, send, pay, void, mark_uncollectible, and every payment / refund / transfer / payout / credit-note / subscription / product / price / account / webhook / API-key call; any `POST` parameter outside the orchestrator's set.

## 7. Where the code lives (preconditions)

1. M3-A (PR 394), M3-B (PR 393) and, for the real business object, M3-C (PR 395) at final reviewed heads, offline-green at those SHAs.
2. The proof script and wrapper are a **separately reviewed** proof-only change under `scripts/qa/d24-m3d-proof/`; the Stripe SDK client is constructed only there, never from `src/`. M3-B's contract test (no Stripe client in `src/`) stays green. A production client factory stays deliberately absent.
3. The owner has created the sandbox, the connected account and the restricted key per sections 2–3 and supplied the two ids.

## 8. Webhooks

Default: **none.** The key cannot create endpoints, so a draft emits nothing to anyone. Optional, **separate approval**: Stripe CLI `stripe listen --forward-to http://localhost:<port>/api/payments/webhook` on the owner's machine (CLI test-mode login) against a local dev server using the local container, `D24_HOSTED_INVOICE_EVENTS=on`, the CLI's `whsec_…` as the Connect secret for that process only, ≤ 30 minutes; it would show the real `invoice.created`/`updated` events reach the D24 route and are acknowledged without facts. Paid-before-registration ordering stays covered by the offline signed fixtures (a draft cannot be paid). **Offline-only is the recommended default.**

## 9. Evidence, redaction, cleanup

**Evidence (redacted, in the owner's chosen folder, never committed with secrets):** offline report for the exact SHAs; script transcript with UTC time, method, path, `Stripe-Account`, idempotency key, HTTP status, Stripe `request-id`, and only `id/livemode/status/total` from responses; identity-gate output; per scenario: Stripe invoice ids, invoice count per customer, the intent row, the registry row and the audit event sequence from the local container; dashboard screenshots (Invoices list, Events list, key permission page before expiry, empty lists and expired key after cleanup); a verdict per V1–V7: PASS / FAIL / NOT TESTED.

**Redaction rules:** never record the key, the `Authorization` header, a `whsec_`, any email or personal name (none should exist); mask `Idempotency-Key` to its first 12 chars in shared copies; keep full ids (they are not secrets) but drop response bodies beyond the listed fields.

**Cleanup (mandatory, also on abort):** (1) `DELETE` every draft created; if any non-draft invoice exists, **stop** and report, do not "fix" it; (2) delete the proof customers; (3) verify zero objects with the listing calls and the dashboard; (4) the owner expires the restricted key (immediate), clears the shell variable and history entry; (5) the sandbox and connected account may stay (cost-free) with no active key, never reused without a new plan; (6) `bash scripts/qa/d24-stack.sh down`, remove temp reports; (7) record the cleanup result.

## 10. Abort criteria (stop immediately, run cleanup, report)

Any identity mismatch; any `livemode:true`; a key that is not `rk_test_`; a non-`draft` status or any `invoice.sent|finalized|paid|payment_*` / email event; call budget exceeded or any call outside the allow-list (a bug); two consecutive unexpected 4xx, a 5xx streak ≥ 3, any 429; more than one invoice where the design promises one (a finding, not something to repair silently); the offline harness not green at the same SHAs or the SHAs moving mid-run; a hosted database URL, a non-labelled container or a non-sandbox account id appearing in the environment; the owner asks to stop.

## 11. Holds that remain after a successful proof

D24 stays OFF. A passing proof does not authorize: applying M3-A/M3-C SQL to any hosted database, deploying M3-B/M3-C, constructing a production Stripe client, LIVE mode, finalize/send/collect, enabling webhooks in any hosted environment, or the M3-C UI/port wiring. Each needs its own approval.

## 12. Open items for the owner

* O-1 The dashboard's label for the connected-account read permission varies; confirmed at key creation, and the authorization lists the final ticked boxes.
* O-2 Resolved by M3-B's design: the orchestrator creates the customer itself (`ensureCustomer`), so the key **needs Customers Write**; the customer is synthetic and deleted in cleanup.
* O-3 Whether to approve the optional Stripe CLI step (section 8). Recommended: not for the base proof.

## 13. Authorization request (exact wording to send the owner)

> **D24 M3-D — Stripe TEST-mode proof: authorization request.**
> I request permission to run **one** bounded proof against a **brand-new Stripe sandbox you create for this purpose** ("DanceFlow D24-M3 TEST"; it is NOT the D7 price-transition sandbox, NOT the C6 invoice-testing sandbox, NOT DanceFlow Dev, NOT production).
> **You provide (not in chat):** a restricted key `rk_test_…` created with exactly: Invoices = Write; Customers = Write; connected-account Read; everything else None (explicitly no Payments, Refunds, Transfers, Payouts, Webhook Endpoints, Subscriptions, Invoice Items or account writes). You paste it into one local shell variable yourself. In chat you send only two identifiers: the sandbox account id `acct_…` and the connected test account id `acct_…`.
> **I will:** run the reviewed proof-only script at PR SHAs `<M3-A sha>` / `<M3-B sha>` / `<M3-C sha>` against a disposable local Postgres container (no hosted database), making at most **40 Stripe TEST-mode API calls** limited to: two identity reads; creating synthetic test customers (no email) and draft invoices (`collection_method=send_invoice`, `auto_advance=false`) with lines; replaying the same idempotency key (duplicate, crash-after-success, lost-response and one 5-minute replay); reading invoices back; two expected-403 permission checks; and deleting the drafts and customers afterwards. Every call is checked against an allow-list before it is sent.
> **I will not:** finalize, send, pay, void, refund or collect anything; create webhook endpoints or run the Stripe CLI (separate approval); make any live-mode call; test or wait for idempotency-key expiry; touch any hosted database, deploy, env var, merge or production system.
> **Abort rules:** any identity mismatch, any `livemode:true`, any non-draft invoice or send/finalize/paid/email event, any call outside the allow-list, budget exceeded.
> **After:** I clean up (drafts + customers deleted), you expire the key, and I give you the redacted evidence pack with a PASS / FAIL / NOT TESTED verdict for V1–V7.
> Reply "**Approved: D24 M3-D Stripe TEST proof as written**" (optionally with edits). Anything not listed above remains unauthorized.
