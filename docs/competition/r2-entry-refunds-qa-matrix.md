# R2 — CI-D competition entry refunds: QA matrix

Developer-owned functional QA (Claude). Status: **PASSED** = run, evidence recorded. **BLOCKED** = built, but could not be
run in this session (never reported as passed). **NOT RUN** = needs an environment this session did not have. Owner
involvement is business acceptance only.

Environment: isolated local Postgres container `r2-refunds-db` (its `public` schema is a read-only clone of the
local e2e-qa DB). Stripe **test mode** only; no Stripe call was made in this session. Nothing was applied to hosted
DEV/PROD, and no real refunds were made.

## Evidence summary (2026-10-23)

| Check | Result |
|---|---|
| Migration `20270103090000` applied on the local container | PASSED |
| Rollback: restores the four prior function bodies (md5 `fabd4052` / `7dc2d16f` / `5bb0940b` / `d0b30516`), drops R2 objects; then forward re-applies | PASSED |
| Forward refuses a second run; rollback refuses a second run | PASSED |
| Rollback refuses while refund / exception / accounting evidence exists | BLOCKED (rerun needed) |
| SQL suite `test_T_competition_r2_entry_refunds.sql` (sections A–G, ~95 checks) | **BLOCKED**: the first full run failed on a fixture syntax error (an extra `)` in the plan JSON), which cascaded into dependent checks. After the fix, the session's auto-mode permission classifier refused further runs against the local container, so the fixed suite has **not** been run |
| vitest: `competitionRefundRules` (20), `competitionRefunds.r2` (rules / Stripe params / errors / summary / webhook routing), `entryRefunds.r2` static (11) | PASSED |
| vitest: existing webhook refund suites (refundrecon1, wiring, PAY-DC-2A, PKG-REFUND-1); 64 tests | PASSED (fakes taught the two new RPC names; no assertion changed) |
| `tsc --noEmit` (whole project) | PASSED |
| 10A / 10C / 10D / 10D.1 suites with the final migration | BLOCKED (were identical with and without the earlier R2 Section 1; rerun needed) |

## A. Registration cascade (owner policy 2–4, Q1)

| # | Case | Expected | Status |
|---|---|---|---|
| A1 | Full refund: placed `scheduled` / `checked_in` entries | withdrawn; placements `scratched` | BLOCKED (passed on the Section-1-only build) |
| A2 | Entry that has danced in an unlocked heat | stays `confirmed`; placement `danced`; E-L scope for its round | BLOCKED |
| A3 | Entry in a locked heat | untouched; one E-L scope (heat, round), parent `operational` + alert pending | BLOCKED |
| A4 | Cancel / payment failure | withdraw + scratch | BLOCKED (passed on Section 1) |
| A5 | Re-fire of the trigger | no new scope, no second withdrawal | BLOCKED |

## B–D. Ledger, request, observe

| # | Case | Expected | Status |
|---|---|---|---|
| B1 | Net caps with an unscoped discount | 2272 / 2273 / 2273 / 2273 / fee 909, sum = captured | PASSED in TS (parity case); SQL BLOCKED |
| C1 | No owner/admin role; another studio's owner | `COMP_REFUND_NOT_AUTHORIZED` | BLOCKED |
| C2 | Order of another event; item of another order | `ORDER_NOT_IN_EVENT` / `ITEM_NOT_IN_ORDER` | BLOCKED |
| C3 | Above the line cap; fee line with withdraw; duplicates; empty; no reason | refused with a specific code | BLOCKED |
| C4 | Replay of the request id (same lines / different lines) | same refund / `REPLAY_MISMATCH` | BLOCKED |
| C5 | A requested refund holds its cap | second request refused | BLOCKED |
| C6 | `authenticated` calls observe or writes the ledger | permission denied | BLOCKED |
| C7 | RLS: owner sees its refunds; another studio sees none | 1 / 0 rows | BLOCKED |
| D1 | Refund event from another Stripe account (PAY-DC-2A) | `account_mismatch`, nothing written | BLOCKED |
| D2 | Amount differs from the request | `AMOUNT_MISMATCH` | BLOCKED |
| D3 | requested → pending → succeeded | binds the Stripe id; pending is not money; succeeded applies | BLOCKED |
| D4 | Replay of succeeded; out-of-order pending | `no_change`, no second effect or accounting entry | BLOCKED |
| D5 | Locked / danced / certified entries with withdraw requested | `exception_open`; E-L / E-C scopes with rounds; K0 predicate blocks only those rounds | BLOCKED |
| D6 | Full refund via the last line | order / payment / registration `refunded`; revenue entry still active at gross; Σ refund entries = 100.00 | BLOCKED |
| D7 | Reversal succeeded → failed | totals drop; entry stays withdrawn; E-R financial-only; separate credit entry | BLOCKED |

## E–G. Resolution, dashboard refunds, immutability, accounting regression

| # | Case | Expected | Status |
|---|---|---|---|
| E1 | Generic PAY-WH-1A resolver on a competition exception | `COMP_REFUND_EXCEPTION_GATED` | BLOCKED |
| E2 | Scope gates (withdraw-after-unlock while confirmed, keep_entry on certified, k0_correction without K0, no note, other studio) | refused | BLOCKED |
| E3 | result_stands (E-C); audited unlock + withdraw → withdrawn_after_unlock; keep_entry | resolved; parents auto-resolve; K0 predicate clears | BLOCKED |
| E4 | Scopes append-only | `COMP_REFUND_SCOPE_IMMUTABLE` | BLOCKED |
| F1 | Dashboard partial refund | unattributed exception, financial-only, no entry change | BLOCKED |
| F2 | Attribution (wrong total / exact) | mismatch refused / entry withdrawn + exception resolved | BLOCKED |
| F3 | Dashboard refund of the remainder | order refunded, no new exception | BLOCKED |
| G1 | Ledger immutability (amount, delete, outcome, Stripe id) | `COMP_REFUND_LEDGER_IMMUTABLE` | BLOCKED |
| G2 | **Non-competition** event payment: partial refund nets out of `event_ticket_revenue`; refunded → voided; no `competition_entry_refund` entry | unchanged behaviour | BLOCKED |
| G3 | Grants: request / attribute / resolve for authenticated; observe service-role only | as stated | BLOCKED (static test PASSED) |

## H. App and Stripe test mode (end to end)

| # | Case | Status |
|---|---|---|
| H1 | Staff refunds one entry of a three-entry order on the refund page (Stripe test mode) | NOT RUN (needs the local app + Stripe test keys + `stripe listen` webhook forwarding) |
| H2 | Double-submit of the refund form | NOT RUN (covered by request-id replay + Stripe idempotency key; unit-tested params) |
| H3 | Stripe network error during create | NOT RUN (unit-tested classification: the cap stays held) |
| H4 | Dashboard refund in Stripe test mode → webhook → unattributed → attribute on the page | NOT RUN |
| H5 | Mobile-width layout of the refund page | NOT RUN |

## Out of scope / follow-ups
Disputes and chargebacks; the K0 / F3 publish precondition (PR #291); the C1 event-closeout check; re-instating an
entry after a reversal; organizer-role SQL fixtures.

## Review fixes (2026-10-23)
| # | Check | Status |
|---|---|---|
| R1 | P1-1: locally failed request, later Stripe success, is recorded (SQL D/P1-1) | BLOCKED (SQL rerun needed) |
| R2 | P1-2: retry reuses request id + idempotency key; refused after 23 h | Typecheck PASSED; behaviour NOT RUN (needs app + Stripe test mode) |
| R3 | P1-3: event P&L counts competition refunds and reversals | PASSED (unit) |
| R4 | P2-5: a new refund after resolution reopens; a replay adds nothing (SQL G/P2-5) | BLOCKED (SQL rerun needed) |
| R5 | Broad regression: 71 vitest files / 1060 tests (payments, competition, events, accounting, Wave, webhook) + project `tsc` | PASSED |
