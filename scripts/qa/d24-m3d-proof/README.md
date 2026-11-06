# D24 M3-D Stripe TEST proof script (PROOF-ONLY, ON HOLD, NOT AUTHORIZED TO RUN LIVE)

Implements the script described in `docs/billing/D24-M3D-STRIPE-TEST-PROOF-PLAN.md`. **Nothing here has been run against Stripe**, and the owner has put the provider proof on hold:
no live run, no credentials. This directory contains no key, no account id and no network call at import time. It is never imported from `src/`.

```
npx tsx scripts/qa/d24-m3d-proof/run.ts --dry-run      # fake client, no network, prints the planned call list. Needs nothing.
npx tsx scripts/qa/d24-m3d-proof/run.ts --preflight    # local checks only (no Stripe call); prints MANUAL items the owner must confirm
npx tsx scripts/qa/d24-m3d-proof/run.ts --print-hash   # manifest SHA-256 and file count the owner pins
npx tsx scripts/qa/d24-m3d-proof/run.ts --allow-list   # what is permitted
npx tsx scripts/qa/d24-m3d-proof/run.ts --live         # REAL Stripe TEST calls; refuses unless every owner value and the preflight are clean
```

## Safety design

1. **Allow-list wrapper (`allowlist.ts`, `guarded.ts`)**: default deny. Every request is matched against an exact rule (method, path shape, `Stripe-Version`,
   `Stripe-Account` binding, query keys, form keys and value limits) **before** the transport is called. `finalize`, `send`, `pay`, `void`, `mark_uncollectible` and every
   unrelated operation have no rule, so they are refused with no network I/O even if the key permits them. A refused request aborts the run (it would be a bug in the script).
2. **Stripe API version pinned**: `config.ts` holds `STRIPE_API_VERSION` (the default API version of the `stripe` SDK the app ships). It must be the `Stripe-Version` header of **every**
   request (a missing or different version is refused before any rule), and every response that reports another version aborts the run with no further call. The pin is part of the
   manifest hash. The account's own default version is not readable from the API: the operator records it from the dashboard (the evidence pack carries a reminder).
3. **Hard cap 40 calls** (`HARD_CALL_CAP`), counted synchronously **including retries and failed attempts** (parallel callers cannot overshoot). Scenario calls stop at 32; the last 8
   are reserved for cleanup. A requested larger budget, NaN or negative value is clamped. The request is copied and frozen before validation.
4. **Identity gate (`identity.ts`)**: `rk_test_` key only; `GET /v1/account` must equal the pinned sandbox id **and** `GET /v1/accounts/<id>` the pinned connected id (type `express`)
   **before any other request can be sent** (the guard refuses every non-identity request until the gate has passed). Every later request must carry `Stripe-Account` equal to the pinned
   connected id (missing, empty, the platform id or another `acct_` is refused before network I/O; the identity reads must carry none). Any `livemode:true` anywhere in a response aborts;
   a hosted-database variable or any live key in the environment refuses the run.
5. **Only objects this run created**: `DELETE /v1/invoices/{id}` needs an id the guard observed with `status=draft`; `DELETE /v1/customers/{id}` needs a customer the run created; `add_lines` needs a draft the
   run created. A non-draft invoice aborts the run and cleanup then stops and reports. Objects the run creates must positively report `livemode:false`.
6. **Abort discipline**: the first abort wins and an abort that forbids further calls (livemode, identity, version, blocked request) is never downgraded by a later one; a call waiting out the pacing
   delay is re-checked against the abort **before** it reaches the network; the three parallel creates are all awaited before cleanup can start. A POST that ends in a gateway error, an unparseable
   body or a 2xx without an id is recorded as unverifiable. The identity reads must report a `Stripe-Version`. Note: Stripe's Account object has no `livemode` field, so the protection against live mode is
   the `rk_test_` key shape, the pinned ids and the `livemode:false` requirement on every created object, not a livemode flag on the account reads.
7. **Environment refused**: a hosted-database URL, any live key, `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, proxy variables (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NODE_USE_ENV_PROXY`) and
   `NODE_TLS_REJECT_UNAUTHORIZED=0` refuse a live run and fail the preflight (they can redirect, observe or patch the traffic that carries the key). The manifest hash covers this directory only, not tsx or
   `node_modules`: run it from a clean checkout with a clean install.
8. **Owner-supplied values only**: live mode needs `D24_PROOF_STRIPE_KEY`, `D24_PROOF_EXPECT_PLATFORM_ACCT`, `D24_PROOF_EXPECT_CONNECTED_ACCT`, `D24_PROOF_PINNED_SHA256` (must equal this
   checkout's `--print-hash`) and `D24_PROOF_AUTHORIZATION` (the exact approval sentence). The key is read from the environment only: never from a file, never from argv (positional
   arguments and unknown options are refused).

## The isolated environment the proof expects (what must exist) and the local preflight

| Must exist | Who checks | How |
|---|---|---|
| A **new** Stripe sandbox named `DanceFlow D24-M3 TEST` (not D7, C6, DanceFlow Dev or production) | owner (MANUAL) | the name is never trusted; only the pinned platform id is, and `GET /v1/account` must return it |
| Exactly **one connected test account**, type `express`, created with Stripe's test onboarding data | owner (MANUAL) + script | `GET /v1/accounts/<pinned id>` must return that id and `express` |
| A restricted key `rk_test_…` made for this proof only: Invoices=Write, Customers=Write, connected-account Read, everything else None; no webhook endpoints | owner (MANUAL) | key shape is checked locally; the two expected-403 reads (Transfers, Webhook Endpoints) are checked at run time |
| The fixture client has **no email** | script | the allow-list refuses any `email` parameter (preflight evaluates this) |
| Local disposable Postgres with **no published ports** (this revision uses no database) | script | `docker ps --filter label=df-d24-qa=1`: any labelled container with a published port or a network other than `none` is a FAIL; docker unreachable is MANUAL, never "ok" |
| Owner values, script hash pin, approval sentence, clean environment, evidence directory outside the repository | script | `--preflight` and the start of `--live` (any FAIL refuses the run) |

`--preflight` never calls Stripe. MANUAL lines are things only the owner can confirm; they are printed, never reported as passed.

## Evidence handling and redaction (no keys exposed)

* By default everything is printed to stdout and nothing is written. With `D24_PROOF_EVIDENCE_DIR=<absolute path OUTSIDE this repository>` the run writes two files there:
  `evidence-<runId>.json` (run metadata, script manifest hash, API version pinned and reported, calls used/blocked, scenario checks, V1-V7 verdicts, cleanup report, abort, the owner's
  after-run reminder) and `transcript-<runId>.txt` (everything the run printed). Files are created with mode 0600; a directory inside the repository or a relative path refuses the run.
* Never written or printed: the API key, the `Authorization` header (the script never logs headers), `whsec_` secrets, bearer tokens, emails, full idempotency keys (masked to 12
  characters), response bodies beyond `id/object/livemode/status/total/deleted` and error `type/code`. Every printed line and every file passes through the same sanitiser: secrets removed
  and account ids **masked** (`acct_1Co…78`; short ids keep two characters). Cleanup targets are customer/invoice ids, not account ids, so nothing needs the full account id on screen. Tests feed
  hostile payloads through the writer and the printer.
* The evidence directory is checked on **real paths**: links/junctions are resolved, and any directory inside this checkout or inside ANY git checkout/worktree (an ancestor holding a git
  entry) is refused.
* Success needs everything: the run prints `OUTCOME: OK` and exits 0 only if nothing aborted, every scenario check passed **and** cleanup verified an empty account (not skipped, not interrupted, nothing
  unverifiable). Otherwise `OUTCOME: FAILED`, exit 1, and the evidence carries the same outcome.
* After the run the owner: expires the restricted key (immediately), clears the shell variable and its history entry, verifies the connected account's Invoices and Customers lists are
  empty in the dashboard, and keeps the evidence directory private.

## Cleanup and manual reconciliation of unverifiable provider objects

Cleanup (also after an abort and on Ctrl-C): delete every draft the run saw, list each customer's invoices to verify none remain, delete the customers. If a non-draft invoice exists it
**stops and reports** (never "fixes" it). After a `livemode:true`, identity, version-mismatch or blocked-request abort it makes **no further call** and prints the ids for manual cleanup.

**Lost responses.** If a create (`POST`) request's response is lost (timeout, socket error), the object may exist at Stripe although the run never saw its id. The run records it as
*unverifiable* (path + masked idempotency key), cleanup does **not** report `verifiedEmpty`, and the report says `unverifiable: n create response(s) were lost`. The operator then:
1. Opens the connected test account in the sandbox dashboard and filters **Customers** and **Invoices** to the run's time window.
2. Finds proof objects by `metadata.d24_intent_id` (every proof customer and invoice carries `d24proof-intent-<runId>-<ref>`) and by the synthetic names `D24-M3 proof client N` /
   description `D24-M3 proof invoice`. A customer is the parent: list its invoices.
3. **Deletes** draft invoices and then the proof customers that carry the run's metadata (the only objects the proof may ever create). **Reports, never deletes,** any invoice that is not a
   draft, anything without the run's metadata, and anything in another account; stops and tells the coordinator.
4. Records each object id found/deleted next to the unverifiable entries in the evidence notes. Only when every unverifiable entry is accounted for, and both lists are empty in the dashboard,
   may the run be described as cleaned up. The script itself never claims "empty" while anything is unverifiable.

## Scope of this revision (honest limits)

* Stripe-side scenarios S0-S10 and cleanup (S11) are implemented. The M3-B orchestrator + local Postgres ledger binding (intent state, registry row, audit events, the operator attach) is **not**
  wired here, so V4 and V7 report `PASS (Stripe side only)` at best and the ledger half is **NOT TESTED**.
* S8's documented-retention figure and the dashboard Events review (S9) are recorded by the operator by hand.
* The fake client proves only that the script's control flow and guards work. It proves nothing about real Stripe behaviour; that is what a separately authorized live run would be for.
* Ctrl-C stops the scenarios, ends the S8 wait early, and still runs cleanup.

The manifest hash covers every file in this directory (line endings normalised), including the tests and this README, and therefore the version pin and the allow-list.
