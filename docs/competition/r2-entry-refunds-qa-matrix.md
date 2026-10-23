# R2 — CI-D competition entry refunds: QA matrix

Developer-owned functional QA (Claude). Status values: **PASSED** (run, evidence recorded), **PENDING-DECISION**
(blocked on owner decision D1–D8 in [`r2-entry-refunds.md`](r2-entry-refunds.md) §4; not built), **BLOCKED**
(built but could not be run; never reported as passed). Owner involvement is business acceptance only.

Environment: isolated local Postgres container (`r2-refunds-db`, `public` schema cloned read-only from the local
e2e-qa stack). Stripe **test mode** only. Nothing applied to hosted DEV/PROD; no real refunds.

## A. Registration cascade gap (Section 1 of `20270103090000`) — implemented

| # | Case | Expected | Status | Evidence |
|---|---|---|---|---|
| A1 | Full refund of a registration with placed entries | entries `withdrawn`; `scheduled` and `checked_in` placements `scratched` | PASSED | SQL suite |
| A2 | Same, entry already `danced` | entry withdrawn; `danced` placement kept | PASSED | SQL suite |
| A3 | Unplaced entry | withdrawn, nothing else | PASSED | SQL suite |
| A4 | Registration cancelled | entry withdrawn + placement scratched | PASSED | SQL suite |
| A5 | Payment failed | entry withdrawn + placement scratched | PASSED | SQL suite |
| A6 | Entry in a **locked** heat on a fully refunded registration | entry stays `confirmed`, placement stays `scheduled` (unchanged 10A guard; see design §4.1) | PASSED | SQL suite |
| A7 | Same registration, other entry in an unlocked heat | withdrawn + scratched | PASSED | SQL suite |
| A8 | Partial refund (`payment_status = 'partial'`) | no entry or placement change | PASSED | SQL suite |
| A9 | Another registration's entry in the same heat | untouched | PASSED | SQL suite |
| A10 | Trigger re-fires on an already refunded registration | no-op | PASSED | SQL suite |
| A11 | Withdrawal audit row | `change_type = withdraw`, `fee_handling = refund` | PASSED | SQL suite |
| A12 | Suite against the old 10A body | fails exactly on A1/A4/A5/A7 and the md5 check (proves detection) | PASSED | rollback → suite FAIL → re-apply → PASS |
| A13 | Forward migration twice / rollback twice | second run refuses (md5 pins); rollback restores md5 `fabd4052…` | PASSED | manual run |
| A14 | Existing 10A / 10C / 10D / 10D.1 suites | identical results with and without R2 | PASSED (no delta) | diff of failure lists = identical; see note |
| A15 | Card flow: dashboard full refund of a placed competition order (Stripe test) | entries withdrawn, placements scratched on the schedule UI | BLOCKED | needs local app + Stripe test webhook forwarding; run with the R2 app slice |

Note A14: in the cloned environment those four suites already fail on privilege/RLS assertions (ACL drift in
the e2e-qa clone: default-privilege statements cannot be restored). The failure lists are byte-identical with
and without R2, so R2 introduces no regression. They should be rerun on a clean migration-built database
before release.

## B. Refund ledger, RPCs, staff flow, webhook — not built

| # | Case | Decision | Status |
|---|---|---|---|
| B1 | Refund one entry of a three-entry order | D1 | PENDING-DECISION |
| B2 | Refund > entry cap refused | D1 | PENDING-DECISION |
| B3 | Discounted order: entry cap = net share (largest remainder) | D1 | PENDING-DECISION |
| B4 | Fee line refunded only when selected | D2 | PENDING-DECISION |
| B5 | Order-level cap across items | D1/D2 | PENDING-DECISION |
| B6 | Double-submit / concurrent staff refunds | — | PENDING-DECISION (blocked on ledger) |
| B7 | Idempotent replay of a request id | — | PENDING-DECISION (blocked on ledger) |
| B8 | Wrong-event / wrong-order item (URL tampering) | — | PENDING-DECISION (blocked on ledger) |
| B9 | Organizer staff cannot refund; owner/admin can | D5 | PENDING-DECISION |
| B10 | Stripe refund failure releases the cap | — | PENDING-DECISION (blocked on ledger) |
| B11 | Stripe refund reversal (succeeded → failed) | — | PENDING-DECISION (blocked on ledger) |
| B12 | Refund without withdraw / withdraw without refund | D4 | PENDING-DECISION |
| B13 | Entry in locked/certified heat: refund yes, withdrawal refused | D7 | PENDING-DECISION |
| B14 | Order `partially_refunded` → `refunded`; registration `partial` → `refunded` | D8 | PENDING-DECISION |
| B15 | Accounting net after partial / full refund | D8 | PENDING-DECISION |
| B16 | Application fee refund parameter on the Stripe call | D3 | PENDING-DECISION |
| B17 | Dashboard partial refund → unattributed + staff exception | D6 | PENDING-DECISION |
| B18 | Dashboard full refund with an entry in a locked heat | D6/D7 + §4.1 | PENDING-DECISION |
| B19 | Webhook replay of the same refund event | — | PENDING-DECISION (blocked on ledger) |
| B20 | Non-competition event refunds unchanged (`order_backed_registration_payment_locked` still enforced) | — | PENDING-DECISION (blocked on staff flow) |

## C. Locked / certified heat handling (§4.1) — specified, not built

Each regression item T2–T20 in design §4.1 **T** is one QA row here once implemented. Status today:
**PENDING-APPROVAL** (owner approval of §4.1, C1, Q1, Q2). T1 is A1–A3 above (PASSED). T15 also depends on K0
F2 (`20270104090000`).
