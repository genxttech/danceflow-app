# D24 M3-D Stripe TEST proof script (PROOF-ONLY, NOT AUTHORIZED TO RUN LIVE)

Implements the script described in `docs/billing/D24-M3D-STRIPE-TEST-PROOF-PLAN.md`. **Nothing here has been run against Stripe.** This
directory contains no key, no account id and no network call at import time. It is never imported from `src/`.

```
npx tsx scripts/qa/d24-m3d-proof/run.ts --dry-run      # fake client, no network, prints the planned call list. Needs nothing.
npx tsx scripts/qa/d24-m3d-proof/run.ts --print-hash   # the script SHA-256 the owner pins
npx tsx scripts/qa/d24-m3d-proof/run.ts --allow-list   # what is permitted
npx tsx scripts/qa/d24-m3d-proof/run.ts --live         # REAL Stripe TEST calls; refuses unless all five variables below are valid
```

## Safety design

1. **Allow-list wrapper (`allowlist.ts`, `guarded.ts`)**: default deny. Every request is matched against an exact rule (method, path shape,
   `Stripe-Account` binding, query keys, form keys and value limits) **before** the transport is called. `finalize`, `send`, `pay`, `void`,
   `mark_uncollectible` and every unrelated operation have no rule, so they are refused with no network I/O even if the key permits them.
   A refused request aborts the run (it would be a bug in the script).
2. **Hard cap 40 calls** (`HARD_CALL_CAP`), counted synchronously (parallel callers cannot overshoot). Scenario calls stop at 32; the last 8 are
   reserved for cleanup. A requested larger budget is clamped to 40.
3. **Identity gate (`identity.ts`)**: key must match `^rk_test_[A-Za-z0-9]+$`; `GET /v1/account` must equal the pinned sandbox id;
   `GET /v1/accounts/<connected>` must equal the pinned connected id and be `express`; any `livemode:true` anywhere aborts; a hosted database
   URL or any live key in the environment refuses the run.
4. **Draft-only**: `DELETE /v1/invoices/{id}` is permitted only for an id the guard has observed with `status=draft`. A non-draft invoice aborts the run, and
   cleanup then stops and reports instead of "fixing" it.
5. **Redaction (`redact.ts`)**: keys, `whsec_`, bearer tokens and emails are removed from everything printed; idempotency keys are masked to 12 characters; only
   `id/object/livemode/status/total` (and error type/code) of a response ever reach the transcript.
6. **Owner-supplied values only**: live mode needs `D24_PROOF_STRIPE_KEY`, `D24_PROOF_EXPECT_PLATFORM_ACCT`, `D24_PROOF_EXPECT_CONNECTED_ACCT`,
   `D24_PROOF_PINNED_SHA256` (must equal this checkout's `--print-hash`) and `D24_PROOF_AUTHORIZATION` (the exact approval sentence). The key is read from the
   environment only: never from a file, never from argv (positional arguments and unknown options are refused).
7. **Cleanup (`cleanup.ts`)**: deletes the drafts, verifies the customers' invoice lists are empty, deletes the customers. After a `livemode:true`, identity or
   blocked-request abort it makes **no further call** and prints the ids for manual cleanup. The owner then expires the key.

## Scope of this revision (honest limits)

* Stripe-side scenarios S0-S10 and cleanup (S11) are implemented. The M3-B orchestrator + local Postgres ledger binding (intent state, registry row, audit events,
  the operator attach) is **not** wired here, so V4 and V7 report `PASS (Stripe side only)` at best and the ledger half is **NOT TESTED**.
* Not implemented (known, from the independent review; none is exploitable by this offline revision): no `Stripe-Version` pin (V1 is partly about API version, so record the
  account default at run time); no check of the local-container label / `--network none` or of "SHAs moved mid-run" (the script uses no database; the hosted-database check
  is an environment-variable list); an object whose create **response was lost** cannot be cleaned up automatically (the run reports `unverifiable` and never claims "empty");
  after a blocked-request / `livemode:true` / identity abort cleanup makes no call (documented deviation from plan section 9, chosen because a further call would be unsafe).
* Ctrl-C stops the scenarios, ends the S8 wait early, and still runs cleanup.
* S8's documented-retention figure and the dashboard Events review (S9) are recorded by the operator by hand.
* The fake client proves only that the script's control flow and guards work. It proves nothing about real Stripe behaviour; that is what a separately authorized live run is for.

The manifest hash covers every file in this directory (line endings normalised), including the tests and this README.
