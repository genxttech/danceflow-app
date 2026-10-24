# C1 closeout reads (W5) -- QA matrix

Read only: nothing closes, locks, settles or posts money. Migration slot 20270107 (C1 closeout writes) is untouched.
Local only (container `c1read-db`: schema cloned from the local SC1 QA database = main + SC1 20270108, then R2 20270103
applied on top; reverse of the nominal 0103-then-0108 order, but R2 pins only functions SC1 does not change).
No hosted DEV/PROD, no Stripe, no deploy.

| # | Check | Status |
|---|---|---|
| 1 | vitest `closeout.c1` + `closeout.sqlsnapshot.c1` (26 tests: partial refund, fee refund, dashboard refund, reversal, discounted order, pending, CSV formula safety, checklist verdicts, two-tenant isolation) | PASS |
| 2 | SQL suite `sql/test_c1_closeout_reads.sql` on c1read-db (17 checks, incl. RLS: owner A / owner B / front desk / anon) | PASS |
| 3 | TypeScript model fed the rows captured from Postgres under RLS matches the plain-SQL figures | PASS |
| 4 | `tsc --noEmit` (whole project, 10 GB heap), eslint on new files | PASS |
| 5 | Independent reviewer (money + isolation): 0 P0; P1/P2 fixed (see commit log) | PASS |
| 6 | Page and CSV route rendered in a browser against a database | NOT RUN (no app stack against the local DB) |
| 7 | Desk balance checklist verdict | BLOCKED: waits for W2 `checkinBalance.ts` (shown NOT AVAILABLE YET) |
| 8 | Rounds published / results certified | NOT AVAILABLE YET (F2/F3) |

Observation (pre-existing, not changed): studio staff without manager rights can read `accounting_entries` and
`event_payments` of their studio through RLS; refund ledger, allocations and exceptions are manager-only.
