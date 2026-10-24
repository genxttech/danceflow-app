# CI-B: refunds never appear as desk balance due

Status: **Git only (draft PR, stacked on #295). Not merged, not applied to any hosted database, no deploy.**

## Rule

A refund settles money that was already captured; it never re-creates a debt.

    balance due = max(0, order total - captured)
    captured    = sum(event_payments.amount) over payments with status 'paid' or 'refunded'

- R2 (#292) writes `event_payments.refund_amount` (succeeded refunds only) and `event_orders.payment_status`
  (`partially_refunded` / `refunded`); it **never lowers `event_orders.total_amount`**. So the order total stays the
  price and `refund_amount` must not be read for the balance.
- A fully refunded payment has status `refunded`; it still counts as captured, so the balance is 0, not the total.
- Pending / failed payment rows are not captured. Pending / failed refunds never write `refund_amount`.
- Single source: `src/lib/competition/checkinBalance.ts` (`checkinBalanceDue`), used by
  `recalculateSession` in the competition check-in `actions.ts`. SQL twin:
  `record_competition_checkin_payment` in `20270111090000_competition_checkin_balance_refund.sql`.
- One extra guard in the SQL function: a desk payment that settles the remaining balance of a
  `partially_refunded` order keeps that order state (and the registration's `partial`) instead of overwriting it
  with `paid`; R2's `_r2_recompute_order` owns those states.

## QA matrix

| # | Check | Result |
|---|---|---|
| 1 | Helper unit tests (6): partial refund, full refund, genuine balance +/- refund, multiple rows, pending/failed rows, cents | PASS |
| 2 | Action tests with fakeSupabase (5, incl. refunded order -> needs_review): partial refund -> balance 0 / `complete`; full refund; genuine balance 100 stays `balance_due`; pending row not captured | PASS |
| 3 | Existing CI-B race tests (#295) | PASS |
| 4 | SQL suite `test_T_competition_checkin_balance.sql` (13 checks) on cib-bal-db with R2 | PASS |
| 5 | PAY-WH-1A suite before and after the migration (66 checks) | PASS / PASS |
| 6 | Rollback restores the exact prior body (md5 387aacac...) and re-apply is idempotent | PASS |
| 7 | Independent money-logic review | P1 fixed (refunded/failed order is never payment-complete or ready; test added); P2s noted in PR |
| 8 | Hosted DEV/PROD apply, deploy, live Stripe | NOT RUN (not authorized) |
| 9 | Clean migration-built database (iso-qa) | BLOCKED (baseline not replayable, see R2 QA matrix section I); evidence is from a DEV-schema clone |

## Apply / rollback order

- Apply: R2 `20270103090000` (and PAY-WH-1A `20261116094000`), then `20270111090000`; SQL before the app.
- Rollback: app first, then `rollback/20270111090000_competition_checkin_balance_refund_rollback.sql`
  (restores the PAY-WH-1A body; reintroduces the bug).
- Preflight pins `md5(prosrc)` of the current body for LF and CRLF forms (the 10D CRLF gotcha).
