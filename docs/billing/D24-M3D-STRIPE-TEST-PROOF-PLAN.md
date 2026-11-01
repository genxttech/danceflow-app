# D24 M3-D — Stripe TEST-mode proof PLAN (hosted-invoice draft creation)

Status: **PLAN ONLY. Document-only. Nothing in this file has been executed, nothing is authorized, no Stripe call (test or live) has been made, no key, sandbox, account, customer, webhook endpoint or database object has been created.** Every step below is a *proposal* that needs the owner's explicit written approval of the exact authorization request in section 14. Approval of this document is not approval of the proof.

## 1. What the proof is for (and is not for)

The offline acceptance harness (`scripts/qa/d24-acceptance.sh`, see `D24-M3D-ACCEPTANCE.md`) proves the M3 design against real Postgres with a **fake** Stripe whose idempotency semantics are *modelled*. A model can be wrong. The proof answers the few questions only real Stripe can answer, in TEST mode, in a throwaway sandbox, with the smallest possible number of calls:

| # | Question | Why a fake cannot answer it |
|---|---|---|
| Q1 | Does `POST /v1/invoices` with `collection_method=send_invoice`, `auto_advance=false` create a **draft** under a *connected* account (`Stripe-Account: acct_…`) using the platform's restricted TEST key, and does the response carry the `id`, `livemode=false`, `status=draft`, `customer`, `currency` the orchestrator validates? | response shape / API version |
| Q2 | Does a second `POST /v1/invoices` with the **same `Idempotency-Key` and same parameters** return the **same invoice** (no second invoice exists in the account)? Does the same key with different parameters fail with an idempotency error (the orchestrator classifies it permanent)? | the orchestrator's duplicate and recovery guarantees rest on this |
| Q3 | Does adding lines (`POST /v1/invoices/{id}/add_lines`, idempotency key `<key>:lines`) produce `total == sum(lines)` and keep the invoice a draft? | the orchestrator verifies `total` before marking |
| Q4 | **Crash recovery**: after the invoice was created but before `provider_created` was persisted, does a replay of the same derived key converge to the one invoice? | the core M3-B/M3-A claim |
| Q5 | Does creating/adding lines to a draft emit **no customer email** and no payment attempt (nothing is finalized, sent or paid)? | "draft creation is inert" |
| Q6 | Does the key's permission set suffice for exactly the calls the orchestrator needs and **fail** (403) for anything outside it? | least-privilege claim |

Explicitly **out of scope** (stays unproven by this plan, and therefore a hold on any activation): finalizing, sending or collecting an invoice, real webhooks end to end (section 9 covers only an optional, separately approved forwarding step), LIVE mode of any kind, idempotency-key expiry (~24 h; asserted by design with a 20 h cut-off in M3-B, not tested here), refunds / credit notes against real Stripe, anything touching D7 / C6 / production data.

## 2. Hard isolation: a NEW sandbox and a NEW connected account

* **New Stripe sandbox (test-mode account) created only for this proof**, named `DanceFlow D24 M3 proof` (name chosen so it cannot be confused with anything else). It is **not** the D7 price-transition sandbox. It is **not** the C6 invoice-testing sandbox. It is **not** the account that backs `DanceFlow Dev`, preview or production deployments. No object, key, customer, product, price or webhook endpoint from those accounts is reused or even listed.
* **One connected account inside that sandbox**, type `express` (same type DanceFlow's onboarding route creates for studios, `src/app/api/stripe/connect/onboarding/route.ts`), created from the sandbox dashboard with Stripe's test data; capabilities `card_payments` and `transfers` requested as the app does. Test-mode onboarding needs no real identity or bank data (Stripe test values only).
* **No shared secrets with anything else.** The proof key exists only in this sandbox, is created for this proof, is held in the owner's password manager, is pasted by the owner into a single shell session environment variable (never in chat, never in a file, never in Git), and is expired in cleanup (section 11).
* The proof runs on the owner's machine against a **disposable local Postgres container** (the same `scripts/qa/d24-stack.sh` stack; `--network none`, no published ports). **No hosted database (DEV or PROD) is touched.** Only the Node process on the host talks to `api.stripe.com`; the container stays offline.

## 3. Identity gate (runs before *every* Stripe call, abort on any mismatch)

The proof script (to be written under a separately approved PR, `scripts/qa/d24-m3d-proof/`, proof-only, never imported by the app) refuses to proceed unless **all** hold, and re-checks the first two on every call through a thin wrapper:

1. The key string matches `^rk_test_[A-Za-z0-9]+$` (a restricted **test** key). `sk_test_…` is also refused (broader than needed); anything `…_live_…`, `pk_…`, or unrecognized aborts immediately, before any network access.
2. The owner supplies two expected ids in the authorization (section 14): `EXPECT_PLATFORM_ACCT=acct_…` (the new sandbox) and `EXPECT_CONNECTED_ACCT=acct_…` (the connected test account). The script first calls `GET /v1/account` with the key alone and requires `id == EXPECT_PLATFORM_ACCT`; then `GET /v1/accounts/<EXPECT_CONNECTED_ACCT>` and requires the id to match, `type=express`, and **`livemode` is not true** (`livemode` field absent from account objects in some API versions → the test-key prefix plus every invoice response's `livemode=false` are the binding evidence; the script requires both and aborts if any response ever says `livemode:true`).
3. Every outgoing request carries `Stripe-Account: EXPECT_CONNECTED_ACCT` (except the two identity reads); a wrapper rejects any other account id, any HTTP method/path outside the **allow-list** in section 8, and any parameter outside the orchestrator's documented set (`customer, collection_method, days_until_due, currency, auto_advance, description, metadata`; `lines[].description/amount`).
4. A global **call budget** (section 8) is enforced in the wrapper; the (n+1)-th call aborts.
5. `process.env.D24_PROOF_ENV` must equal the literal `stripe-test-sandbox-d24-m3` and the local Postgres container must carry the `df-d24-qa=1` label (`stackLayers()` already enforces the label), so the script cannot be pointed at a hosted database by accident.

On abort: print which check failed (never the key), make no further call, run the read-only listing in section 11 to show what exists, and stop for the owner.

## 4. Restricted API key — exact permissions (least privilege)

Created by the owner in the new sandbox dashboard (Developers → API keys → *Create restricted key*), name `d24-m3-proof-<date>`. The key belongs to the **platform** sandbox account and acts on the connected account through `Stripe-Account` (direct-on-connected-account pattern the orchestrator uses: `stripeAccount: <acct>` on each call).

| Resource | Permission | Needed for |
|---|---|---|
| Invoices | **Write** (includes read) | create draft (`POST /v1/invoices`), add lines (`POST /v1/invoices/{id}/add_lines`), retrieve/list for evidence, **delete draft** in cleanup (`DELETE /v1/invoices/{id}`) |
| Invoice Items | **Write** | only if the proof client uses `invoiceitems` instead of `add_lines`; **leave None if `add_lines` is used** — the final tick is confirmed in the authorization |
| Customers | **Write** | one-time creation of the proof customer in the connected account (P0) and its deletion in cleanup. If the owner creates the customer in the dashboard instead, downgrade to **Read** |
| Connect → account read (the dashboard's name for reading connected accounts; confirm the label when creating the key) | **Read** | the identity gate's `GET /v1/accounts/<id>` |
| Everything else | **None** | in particular **None** for: Charges and Refunds, PaymentIntents, Payment Methods, Transfers, Payouts, Balance, Subscriptions, Products/Prices (the proof uses ad-hoc line descriptions and amounts), Webhook Endpoints, Customer Portal, any Connect account *write*, API-key/Developer settings |

Expected negative checks (Q6) — each must return a 403 permission error and each counts against the budget: one `POST /v1/refunds`-class call is **not** made (it would need a payment; instead the check is `GET /v1/transfers?limit=1` (Transfers: None) and `GET /v1/webhook_endpoints` (Webhook Endpoints: None)). No attempt is made to finalize, send, pay or void anything to "prove it fails".

The key is **never** given Write on Webhook Endpoints, Payments or Connect accounts, so even a bug in the proof script cannot move money, email a customer (a draft never emails) or add an endpoint.

## 5. How the connected test account is linked to a test studio

Local only; the hosted `studios` table is not touched.

1. `scripts/qa/d24-stack.sh up --m3a <PR394 head> --m3b <PR393 head>` (and `--m3c` when it exists) starts the disposable container with the exact SHAs recorded in the evidence.
2. The script inserts into the **local** container: one studio `D24 M3 proof studio` with `stripe_connected_account_id = EXPECT_CONNECTED_ACCT`, `stripe_connect_charges_enabled = true`; one QA business object owned by it; registers the QA ownership function with `d24_register_business_object_type` (identical to the harness fixture).
3. A second local studio with **no** connected account and a third bound to a *different, fake* id exist only to prove refusal; they never reach Stripe.
4. The proof customer: created once in the connected account (P0), `cus_…` id recorded and used as the orchestrator resolver's `stripeCustomerId`. Customer fields are synthetic (`D24 proof customer`, no email → Stripe cannot email anything even if an invoice were ever finalized by mistake).
5. Nothing is written to the app's real tables; the linkage exists only for the lifetime of the container.

## 6. Procedure (each step lists its Stripe calls; the budget in section 8 is the sum)

| Step | Action | Stripe calls | Pass criteria |
|---|---|---|---|
| P-1 | Dry run with `--dry-run`: full script, **fake client only**, prints the planned call list | 0 | list ⊆ allow-list; counts ≤ budget |
| P0 | Identity gate (section 3); create proof customer in the connected account | 3 (`GET /account`, `GET /accounts/<id>`, `POST /customers`) | ids match; `livemode` false everywhere |
| P1 | **Draft creation** through the real orchestrator (`createHostedInvoice`) with the real proof client | 2 (create, add_lines) | result `registered`; `status=draft`, `collection_method=send_invoice`, `auto_advance=false`, `total == sum(lines)`; intent `registered`; registry row `studio/acct/type/object` |
| P2 | **Duplicate**: same request key again | 0 (ledger short-circuits a registered intent) | same invoice id; Stripe invoice count for the customer still 1 (one `GET /invoices?customer=` = 1 call) |
| P3 | **Idempotency at Stripe**: replay `POST /v1/invoices` directly with P1's key and identical params; then with a changed `description` | 2 | first returns the same `in_…`; second is an idempotency error (Q2) |
| P4 | **Concurrent retries**: 3 parallel `createHostedInvoice` for a *new* object, same key | 2 (+ the same-key calls that reach Stripe, ≤ 3 more) | exactly one invoice for that object; one intent; one registry row |
| P5 | **Crash after Stripe, before `provider_created`**: new object; the proof client throws *after* the real create returns (fault injection in the script, not in the app); the script then *exits the process*; a fresh process replays the same request | 2 (create, add_lines) + 1 replay create (same key) + 1 list | one invoice in Stripe; intent ends `registered`; replay's create returned the original id (Q4) |
| P6 | **Crash before Stripe**: new object; ledger `begin` then process exit before any call; replay | 2 | one invoice |
| P7 | **Inertness** (Q5): retrieve each created invoice; check `status=draft`, `amount_paid=0`, no `finalized_at`/`sent` markers, `hosted_invoice_url` absent for drafts; check the sandbox's *Events* list (dashboard, read-only) shows `invoice.created` / `invoice.updated` only and **no** `invoice.sent`, `invoice.finalized`, `invoice.paid`, email-related events | ≤ 3 reads | no finalization/payment/send evidence |
| P8 | **Permission negatives** (Q6): two forbidden reads (`transfers`, `webhook_endpoints`) | 2 | both 403 |
| P8b | **Idempotency-retention observation (bounded, no pruning test).** Within the same run, replay P1's key once ~5 minutes after creation and record the response header `Idempotent-Replayed: true` and that the invoice id is unchanged. Read Stripe's *documented* retention for idempotency keys from the current API reference at execution time and record the quoted figure and URL in the evidence; the safe-retry window configured in M3 (default 12 h) must be strictly inside it. **No attempt is made to wait for, force or observe pruning** (that would need a >24 h wait and a deliberate duplicate; out of scope and unauthorized). The result bounds only what was seen: a replay within minutes is idempotent | 1 | `Idempotent-Replayed: true`, same id; documented retention recorded; window < retention |
| P8c | **needs_review reconciliation path** (only once the M3 heads that add `needs_review` and the authorized reconciliation function are final and offline-green): leave one intent in `needs_review` using the local ledger (no Stripe call), then reconcile it the way an operator would: one `GET /v1/invoices?customer=…` to find the draft by `metadata.d24_intent_id`, then record the outcome through the reconciliation function (platform-admin aal2, audited). Confirms the operator can resolve an unresolved creation from Stripe evidence without any replay of the create call | 1 | exactly one matching invoice found; intent resolved with an audit event; **no** `POST /v1/invoices` issued in this step |
| P9 | Cleanup (section 11) | ≤ 8 | zero drafts / customer remain |

The proof also asserts, per invoice, local-database invariants identical to the offline harness (no payment / credit note / transition rows exist; audit events `created,provider_created,registered`).

## 7. Local database stage (no Stripe)

Before P0 the same scenarios run once locally against the orchestrator with the **fake** client (`d24-acceptance.sh --m3a … --m3b …`) — the proof only starts from a green offline run at the same SHAs. A red or BLOCKED-for-an-in-scope-reason offline result aborts the plan.

## 8. Allow-list and call budget

Allowed (wrapper enforces method + path pattern + `Stripe-Account`):

```
GET    /v1/account                                (identity, no Stripe-Account header)
GET    /v1/accounts/{EXPECT_CONNECTED_ACCT}       (identity)
POST   /v1/customers                              (P0, once)             DELETE /v1/customers/{id}   (cleanup)
POST   /v1/invoices                               (create draft)         DELETE /v1/invoices/{id}    (cleanup, drafts only)
POST   /v1/invoices/{id}/add_lines                (lines)
GET    /v1/invoices/{id}  and  GET /v1/invoices?customer={cus}&limit=100
GET    /v1/transfers?limit=1  and  GET /v1/webhook_endpoints   (the two expected-403 negatives only)
```

Everything else is rejected by the wrapper before any network I/O: finalize, send, pay, void, mark_uncollectible, any payment/refund/transfer/payout/credit-note/subscription/product/price/account/webhook/api-key call, any `POST` with an unknown parameter.

**Total budget: 40 calls** (planned ≈ 26 including P8b and P8c; the rest is headroom for one retry of each step). Rate: sequential except P4's 3 concurrent calls; a 250 ms pause between calls. Hard stop at the first 5xx streak of 3 or any 429.

## 9. Webhooks

Default: **none.** The sandbox gets no webhook endpoint (the key cannot create one). Draft creation emits events only to configured endpoints, so no live delivery occurs and the local webhook route is never exposed.

Optional, **separate approval** (not part of the base authorization): Stripe CLI `stripe listen --forward-to http://localhost:<port>/api/payments/webhook` against the sandbox, run on the owner's machine with the CLI's own test-mode login, forwarding to a local dev server that uses the **local** container (`D24_HOSTED_INVOICE_EVENTS=on`), with the CLI's `whsec_…` set as `STRIPE_CONNECT_WEBHOOK_SECRET` for that process only. Purpose: observe the real `invoice.created`/`invoice.updated` events for a draft hit the D24 route and be acknowledged without creating facts, and confirm the registration-then-event ordering. Because no payment can occur on a draft (no finalize/send/pay is permitted), the paid-before-registration cases stay covered by the offline signed fixtures — **offline-only is the recommended default.** The CLI step needs its own owner approval naming the CLI, the forward URL and the duration (≤ 30 minutes).

## 10. Evidence to capture (redacted, saved under the owner's chosen folder, never committed with secrets)

1. Offline harness report for the exact SHAs (PASS/FAIL/BLOCKED counts, layers, SHAs).
2. Script transcript with every request line: UTC time, method, path, `Stripe-Account` value, idempotency key, HTTP status, Stripe `request-id`, response `id`/`livemode`/`status`. **Never** the key, authorization header, customer names/emails (none exist), or full response bodies beyond the fields listed.
3. Identity gate output (platform id, connected id, key prefix `rk_test_` only, `livemode` observations).
4. For P1–P6: the Stripe invoice ids, the Stripe invoice count per customer after each step, the intent row (status, attempt_count, ids), registry row, audit event sequence from the local container.
5. Dashboard screenshots (sandbox): Invoices list (all drafts, no finalized), Events list (only `invoice.created`/`invoice.updated`, no `invoice.sent|finalized|paid`), API key permission page (before cleanup), and after cleanup: Invoices empty, key expired.
6. Cleanup proof: final listing calls showing zero invoices for the customer, customer deleted, key status "expired".
7. A short written verdict per question Q1–Q6: PASS / FAIL / NOT TESTED, with the evidence reference.

## 11. Cleanup (mandatory, also on abort)

1. Delete every draft invoice created (`DELETE /v1/invoices/{id}`; drafts are deletable, finalized ones would not be — none should exist). If any non-draft invoice is found, **stop**, do not "fix" it, report to the owner.
2. Delete the proof customer.
3. Verify with `GET /v1/invoices?customer=` (customer deleted → expect not found) and the dashboard Invoices list: zero objects from this proof.
4. Owner expires the restricted key in the dashboard (immediate), clears the shell variable and shell history entry; no key material was ever written to disk.
5. The connected test account and the sandbox may stay (cost-free) or be deleted by the owner; they are never reused for another purpose without a new plan. If kept, the sandbox has no active key.
6. `bash scripts/qa/d24-stack.sh down` removes the container and its anonymous volume; remove temp reports.
7. Record the cleanup result in the evidence folder.

## 12. Abort criteria (stop immediately, run cleanup, report)

* Any identity-gate mismatch, any `livemode:true` anywhere, a key that is not `rk_test_`.
* Any response, event or object that is not `draft` / unexpected `status`, any `invoice.sent|finalized|paid|payment_*` event, any email-related event.
* Call budget exceeded, a call outside the allow-list attempted (a bug), two consecutive unexpected 4xx, any 5xx streak ≥ 3, any 429.
* More than one invoice for one customer/object where the design promises one (a finding, not something to repair silently).
* The offline harness not green at the same SHAs, or the SHAs changed mid-run.
* A hosted-database connection string, a non-labelled container, or a non-sandbox account id appears in the environment.
* The owner asks to stop.

## 13. Preconditions (all must be true before asking for authorization)

1. M3-A (PR 394), M3-B (PR 393) at final reviewed heads; offline harness green at those SHAs (M3-C optional for this proof because the proof uses the QA fixture business object).
2. The proof script and its wrapper exist in a **separately reviewed, merged-or-approved** proof-only change (`scripts/qa/d24-m3d-proof/`); it constructs the Stripe client only inside that folder, never from `src/`. The M3-B contract test that forbids a Stripe client in `src/` stays green.
3. A real `HostedInvoiceStripeClient` implementation exists *only* in the proof folder (two methods, allow-listed). A production client factory remains deliberately absent (activation hold in M3-B).
4. Owner has created the new sandbox, connected account and restricted key per sections 2 and 4, and supplied the two account ids.

## 14. Authorization request (exact wording to send the owner)

> **D24 M3-D — Stripe TEST-mode proof: authorization request.**
> I request permission to run **one** bounded proof against a **brand-new Stripe sandbox that you create for this purpose** (named "DanceFlow D24 M3 proof"; it is NOT the D7 price-transition sandbox, NOT the C6 invoice-testing sandbox, NOT DanceFlow Dev, NOT production).
> **You provide (not in chat):** the restricted key `rk_test_…` created with exactly: Invoices = Write; Customers = Write (or Read if you create the proof customer yourself); Invoice Items = None unless I tell you otherwise; connected-account Read; everything else None (explicitly: no Payments, Refunds, Transfers, Payouts, Webhook Endpoints, Subscriptions, account writes). You paste it into one local shell variable yourself. In chat you send only the two ids: platform sandbox `acct_…` and connected test account `acct_…`.
> **I will:** run the proof script from the reviewed proof-only change at the PR SHAs `<M3-A sha>` / `<M3-B sha>` against a disposable local Postgres container (no hosted database), making at most **40 Stripe TEST-mode API calls** to `api.stripe.com` limited to: identity reads, creating one test customer, creating and adding lines to draft invoices (`collection_method=send_invoice`, `auto_advance=false`), reading them back, two expected-403 permission checks, and deleting the drafts and customer afterwards. I will **not** finalize, send, pay, void, refund or collect anything; I will **not** create webhook endpoints or run the Stripe CLI (that needs a separate approval); I will make **no** live-mode call; I will make **no** hosted database change, deploy, env var change, merge or push to production.
> **Abort rules:** any identity mismatch, any `livemode:true`, any non-draft invoice or send/finalize/paid event, any call outside the allow-list, budget exceeded.
> **After:** I clean up (drafts + customer deleted), you expire the key, and I give you the redacted evidence pack and a PASS/FAIL/NOT-TESTED verdict for Q1–Q6.
> Reply "**Approved: D24 M3-D Stripe TEST proof as written**" (optionally with edits) to authorize. Anything not listed above remains unauthorized.

## 15. Holds that remain after a successful proof

D24 stays OFF. A passing proof does not authorize: applying M3-A SQL to any hosted database, deploying M3-B, constructing a production Stripe client, LIVE mode, finalize/send/collect, webhook enablement in any hosted environment, or the M3-C UI. Each needs its own approval.

## 16. Open items for the owner

* O-1 Which dashboard label for the connected-account read permission (name varies by dashboard version) — confirmed when the key is created; the authorization lists the final tick boxes.
* O-2 Whether a customer is created by the proof (needs Customers Write) or by you in the dashboard (Read is enough). Recommended: you create it, so the key never needs Customers Write.
* O-3 Whether to approve the optional Stripe CLI forwarding step (section 9). Recommended: not for the base proof.
