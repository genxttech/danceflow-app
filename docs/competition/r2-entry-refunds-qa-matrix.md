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
| Rollback refuses while refund / exception / accounting evidence exists | PASSED ("R2 rollback refused: competition refund exceptions exist"; nothing persisted) |
| SQL suite `test_T_competition_r2_entry_refunds.sql` (sections A–G plus the review-fix checks) | **PASSED: 118 checks** (owner-authorized reruns, 2026-10-23; includes section S, scratch is never financial). Fixes to the test fixtures only, along the way: one bracket typo; heat capacity of 8 (the danced entry moved to a second Bronze heat); and RPC calls now store their result in one statement and check it in the next, because a statement cannot see the writes of a function it calls |
| Regression suites with vs without R2: 10A, 10C, 10C pricing parity, 10C.4, 10C.5, 10D, 10D.1, PAY-WH-1 settlement, PAY-WH-1A, REFUND-RECON-1, REFUND-RECON-2 | **Identical results** with and without R2. PAY-WH-1 **PASS (114)**, PAY-WH-1A **PASS (66)**, 10C pricing parity **PASS (45 scenarios)**. The others fail **at baseline** on this cloned database: anon/authenticated privilege, ownership and ACL assertions (default privileges are not restorable into the clone), plus auth-schema drift (`auth.users.deleted_at` is missing), so the 10C verified-buyer checks cannot run here. Rerun all of them on a clean migration-built database before PROD SQL |
| vitest: `competitionRefundRules` (20), `competitionRefunds.r2` (rules / Stripe params / errors / summary / webhook routing), `entryRefunds.r2` static (11) | PASSED |
| vitest: existing webhook refund suites (refundrecon1, wiring, PAY-DC-2A, PKG-REFUND-1); 64 tests | PASSED (fakes taught the two new RPC names; no assertion changed) |
| `tsc --noEmit` (whole project) | PASSED |

## A. Registration cascade (owner policy 2–4, Q1)

| # | Case | Expected | Status |
|---|---|---|---|
| A1 | Full refund: placed `scheduled` / `checked_in` entries | withdrawn; placements `scratched` | PASSED (SQL suite) |
| A2 | Entry that has danced in an unlocked heat | stays `confirmed`; placement `danced`; E-L scope for its round | PASSED (SQL suite) |
| A3 | Entry in a locked heat | untouched; one E-L scope (heat, round), parent `operational` + alert pending | PASSED (SQL suite) |
| A4 | Cancel / payment failure | withdraw + scratch | PASSED (SQL suite) |
| A5 | Re-fire of the trigger | no new scope, no second withdrawal | PASSED (SQL suite) |

## B–D. Ledger, request, observe

| # | Case | Expected | Status |
|---|---|---|---|
| B1 | Net caps with an unscoped discount | 2272 / 2273 / 2273 / 2273 / fee 909, sum = captured | PASSED (TS parity + SQL) |
| C1 | No owner/admin role; another studio's owner | `COMP_REFUND_NOT_AUTHORIZED` | PASSED (SQL suite) |
| C2 | Order of another event; item of another order | `ORDER_NOT_IN_EVENT` / `ITEM_NOT_IN_ORDER` | PASSED (SQL suite) |
| C3 | Above the line cap; fee line with withdraw; duplicates; empty; no reason | refused with a specific code | PASSED (SQL suite) |
| C4 | Replay of the request id (same lines / different lines) | same refund / `REPLAY_MISMATCH` | PASSED (SQL suite) |
| C5 | A requested refund holds its cap | second request refused | PASSED (SQL suite) |
| C6 | `authenticated` calls observe or writes the ledger | permission denied | PASSED (SQL suite) |
| C7 | RLS: owner sees its refunds; another studio sees none | 1 / 0 rows | PASSED (SQL suite) |
| D1 | Refund event from another Stripe account (PAY-DC-2A) | `account_mismatch`, nothing written | PASSED (SQL suite) |
| D2 | Amount differs from the request | `AMOUNT_MISMATCH` | PASSED (SQL suite) |
| D3 | requested → pending → succeeded | binds the Stripe id; pending is not money; succeeded applies | PASSED (SQL suite) |
| D4 | Replay of succeeded; out-of-order pending | `no_change`, no second effect or accounting entry | PASSED (SQL suite) |
| D5 | Locked / danced / certified entries with withdraw requested | `exception_open`; E-L / E-C scopes with rounds; K0 predicate blocks only those rounds | PASSED (SQL suite) |
| D6 | Full refund via the last line | order / payment / registration `refunded`; revenue entry still active at gross; Σ refund entries = 100.00 | PASSED (SQL suite) |
| D7 | Reversal succeeded → failed | totals drop; entry stays withdrawn; E-R financial-only; separate credit entry | PASSED (SQL suite) |

## E–G. Resolution, dashboard refunds, immutability, accounting regression

| # | Case | Expected | Status |
|---|---|---|---|
| E1 | Generic PAY-WH-1A resolver on a competition exception | `COMP_REFUND_EXCEPTION_GATED` | PASSED (SQL suite) |
| E2 | Scope gates (withdraw-after-unlock while confirmed, keep_entry on certified, k0_correction without K0, no note, other studio) | refused | PASSED (SQL suite) |
| E3 | result_stands (E-C); audited unlock + withdraw → withdrawn_after_unlock; keep_entry | resolved; parents auto-resolve; K0 predicate clears | PASSED (SQL suite) |
| E4 | Scopes append-only | `COMP_REFUND_SCOPE_IMMUTABLE` | PASSED (SQL suite) |
| F1 | Dashboard partial refund | unattributed exception, financial-only, no entry change | PASSED (SQL suite) |
| F2 | Attribution (wrong total / exact) | mismatch refused / entry withdrawn + exception resolved | PASSED (SQL suite) |
| F3 | Dashboard refund of the remainder | order refunded, no new exception | PASSED (SQL suite) |
| G1 | Ledger immutability (amount, delete, outcome, Stripe id) | `COMP_REFUND_LEDGER_IMMUTABLE` | PASSED (SQL suite) |
| G2 | **Non-competition** event payment: partial refund nets out of `event_ticket_revenue`; refunded → voided; no `competition_entry_refund` entry | unchanged behaviour | PASSED (SQL suite) |
| G3 | Grants: request / attribute / resolve for authenticated; observe service-role only | as stated | PASSED (SQL suite) |

## H. App and Stripe test mode (end to end), run 2026-10-23 (owner-authorized)

Environment:
- **App:** `next dev` on `localhost:3100`, from this branch.
- **Stack:** an isolated Supabase CLI stack `r2-qa` (ports 563xx, real Auth/Storage), loaded with the local DEV-schema clone, plus the R2 migration.
- **Stripe:** **test** keys only (`sk_test_` / `pk_test_` checked). `stripe listen --forward-connect-to` with its own secret; the platform secret is set to a random never-verifying value.
- **Account:** test Express account `acct_1TaTgK…`.
- **Payments:** seven orders paid with real test-mode direct charges (`pm_card_visa`). Order creation was seeded (outside R2's scope); every refund went through the refund page, the server action, Stripe test mode, the webhook and the database.
- **Checks:** after each flow, a DB snapshot verified the ledger, order, registration, payment, entries, heats, exceptions and accounting.

| # | Flow | Result | Evidence |
|---|---|---|---|
| H1 | Single-entry full refund (order 1) | **PASS** | Order, registration and payment all `refunded`; entry scratched; revenue entry **active at gross** (no longer voided); one 25.00 `competition_entry_refund` debit dated today |
| H2 | Partial refund, one of three entries (order 2) | **PASS** | Order `partially_refunded`, registration `partial`, payment refund 25.00; only e201 scratched; refund entry 25.00; revenue gross (refund 0) |
| H3 | Fee-line refund (order 3) | **PASS** | 10.00 fee only, outcome `not_applicable`; entries untouched |
| H4 | Discounted order (order 4: 2 × 25.00 − 10.00) | **PASS** | Net cap shows 20.00 per entry. 20.01 refused (`COMP_REFUND_EXCEEDS_LINE_CAP`, no Stripe call); 20.00 succeeded |
| H5 | Double-submit (order 4) | **PASS** | Two POSTs with the same request id → one ledger refund, **one** Stripe refund on the PaymentIntent |
| H6 | Stripe failure (order 7: stored owner ≠ charge account) | **PASS** | "Stripe refused the refund. Nothing was refunded."; ledger `failed`, no Stripe id; cap 2500 free again; order still `paid`; entry untouched |
| H7 | Dashboard partial refund, then attribution (order 5) | **PASS** | Test refund created in Stripe → webhook → `stripe_dashboard` refund, financial-only `competition_refund_unattributed` exception (0 scopes), no entry change. Attribution on the page scratched e501 and resolved the exception |
| H8 | Dashboard full refund of the remainder (order 5) | **PASS** | Order and registration `refunded`; the cascade scratched the open entry; no new exception; two dated refund entries (10.00 + 40.00) |
| H9 | Locked and danced heat (order 6: e601 locked, e602 danced) | **PASS** | With "Request scratch" ticked: refund succeeded, both entries stay `confirmed`, placements unchanged, `exception_open`; E-L parent with 2 competitive scopes (rounds named) |
| H10 | Certified heat (order 6: e603) | **PASS** | Entry, heat and placement unchanged; E-C scope; resolved on the page as "result stands", and the parent auto-resolved |
| H11 | Wrong-event tampering | **PASS** | Order 2's page under the other event's URL → **404**. A forged hidden `eventId` (verified present at submit) was refused by the RPC (`COMP_REFUND_ORDER_NOT_IN_EVENT`); no refund, no Stripe call. UX note: the error redirect lands on the forged URL (not-found page) instead of showing the banner |
| H12 | Webhook replay (`stripe events resend`: `refund.updated` + `charge.refunded`) | **PASS** | Both 200; order state hash unchanged; refund accounting entries unchanged (8) |
| H13 | D3: platform application fee never refunded (order 2, fee 1.50) | **PASS** | Test charge `amount_refunded=2600`; application fee `amount_refunded=0` |
| H14 | Stripe network error during create (unknown outcome) | BLOCKED | Cannot be induced safely against Stripe test mode; covered by unit tests (classification → cap held) and the page's "Waiting for Stripe" retry (typechecked) |
| H15 | Mobile-width layout of the refund page | NOT RUN | — |

**Defect found and fixed during the run:** held entries (locked, danced or certified) had their scratch checkbox
*disabled*, so a refund on them could never raise E-L/E-C, leaving no official decision (against owner policy 7).
They now offer **"Request scratch (official decision required)"**, unchecked by default. Requesting it raises the
exception and never scratches automatically (H9/H10 ran with the fix; unit test updated).

**Test-data side effect (test mode only):** the first tamper attempt ran before React hydration finished, so React
restored the real `eventId` and a legitimate **1.00 test-mode refund** went through on order 2 (e202, correct event).
It was not a bypass: the redo with the forged id verified at submit was refused (H11).

## I. Regression on a migration-built database: BLOCKED (root cause recorded)

I built a fresh database from the 2026-07-15 schema-only base dump plus this branch's migrations in iso-qa replay
order (container `r2mb-db`, local only). I added one thing: real Supabase Auth's `auth.users.deleted_at` column.
That lets LAUNCH-SEC-1C-A, GC-3.5-2 and REFUND-RECON-1/2 replay, but the chain is still blocked, for two reasons:
- **LAUNCH-SEC-1C-0 pins the raw `md5(prosrc)` of the CRLF body** of `user_has_client_portal_access`: PROD received
  `20260831…` from a Windows CRLF checkout (`c0b5901e…` = the CRLF hash of the repo's LF body, `5192dabd…`).
  Replaying with CRLF fixes that pin but breaks others (10A's postflight expects LF bodies), and a per-file LF/CRLF
  retry cannot help, because the dependency was created by an *earlier* file. So 1C-0 → 1C-B → 10C → 10C.4/10C.5/10D/10D.1
  (and R2, which needs 10C) cannot be reproduced from the repo alone. This matches the iso-qa tool's
  `known-unreplayable.txt`.
- The replayed DB also lacks `event_payments.event_id` (known DEV/PROD drift), which crashes the PAY-WH-1/1A suites
  there, and REFUND-RECON-1/2 fail on an empty `payment_status` enum input.

**Where the regression evidence comes from instead:** the DEV-schema clone (`r2-refunds-db`, section "Evidence summary").
There, all suites give identical results with and without R2, and PAY-WH-1 (114), PAY-WH-1A (66) and pricing parity (45)
pass. Fixing the migration-built baseline belongs to the iso-qa tooling owner (follow-up).

## S. Scratch is never financial (owner, 2026-10-23)

| # | Check | Status |
|---|---|---|
| S1 | `change_competition_entry_lifecycle` scratch (even with fee handling `refund`): no refund row, allocation, cap hold or refund entry; order/payment stay paid; full cap still available | PASSED (SQL suite S, 118 checks) |
| S2 | Heat-entry check-in / scratch status changes: nothing financial | PASSED |
| S3 | Registration cascade on cancel: scratches the entry, nothing financial | PASSED |
| S4 | Static: no function outside the two R2 writers inserts into the refund ledger | PASSED |
| S5 | UI says "Scratch" ("Also scratch this entry", "Request scratch (official decision required)", "Entry scratched after an audited heat unlock") | PASSED (seen on the page during H1–H10) |

## J. CI-B / desk interaction (question from the coordinator)

- **Event check-in (`check-in/actions.ts`, also in PR #295):** a `partial` registration **is** checkable; only
  `pending` / `unpaid` / `failed` / `refunded` are refused.
- **Competition desk (`competition/checkin/actions.ts` and PAY-WH-1A `record_competition_checkin_payment`, both
  already on main):** **defect with R2.** The balance is computed as `order total − Σ(amount − refund_amount)` over
  paid rows, so after an R2 partial refund the refunded amount shows as **balance due**, and the desk RPC would
  **accept a payment for it** (over-collection). Correct rule: owed = total − refunded, paid = Σ amount − refunded,
  so balance = `total − Σ amount` (refunds cancel out). These files belong to PAY-WH-1A / CI-B, not R2, so this is
  reported for the owner/coordinator. **It must be fixed before CI-D is released.**

## Out of scope / follow-ups
Disputes and chargebacks; the K0 / F3 publish precondition (PR #291); the C1 event-closeout check; re-instating an
entry after a reversal; organizer-role SQL fixtures.

## Review fixes (2026-10-23)
| # | Check | Status |
|---|---|---|
| R1 | P1-1: locally failed request, later Stripe success, is recorded (SQL D/P1-1) | PASSED (SQL) |
| R2 | P1-2: retry reuses request id + idempotency key; refused after 23 h | Typecheck PASSED; behaviour NOT RUN (needs app + Stripe test mode) |
| R3 | P1-3: event P&L counts competition refunds and reversals | PASSED (unit) |
| R4 | P2-5: a new refund after resolution reopens; a replay adds nothing (SQL G/P2-5) | PASSED (SQL) |
| R5 | Broad regression: 71 vitest files / 1060 tests (payments, competition, events, accounting, Wave, webhook) + project `tsc` | PASSED |
