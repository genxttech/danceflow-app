# CI-B: refunds never appear as desk balance due

Status: **Git only. Not merged, not applied to any hosted database, not deployed.** Branch `release/competition-cib`, based on the live R2 app build `release/competition-r2-app` (b82dba27).

## Rule

A refund settles money that was already captured; it never re-creates a debt.

    balance due = max(0, order total - captured)
    captured    = sum(event_payments.amount) over payments with status 'paid' or 'refunded'

- R2 writes `event_payments.refund_amount` (= succeeded ledger sum, via `_r2_recompute_order`) and sets the Stripe payment to
  `refunded` once fully refunded. It **never lowers `event_orders.total_amount`**, so `refund_amount` must not be read for the balance.
- Pending / failed payment rows are not captured. Pending / failed refunds never write `refund_amount`.
- One TS source: `src/lib/competition/checkinBalance.ts` (`checkinBalanceDue`), used by `recalculateSession` in the competition check-in
  `actions.ts`. SQL twin: `record_competition_checkin_payment` in `20270211090000_competition_checkin_balance_refund.sql`
  (D7 body, only the balance select changed).

## Apply / rollback

- Pin: current definition must be the D7 body (md5 of the CR-stripped `pg_get_functiondef` = `70285eaf8c11f4cb34cb487fa1d3f47a`, the PROD
  fingerprint); anything else raises and changes nothing. Post-state `f7ff073516597c474c59189df7b3e0d2`.
- Rollback: `rollback/20270211090000_competition_checkin_balance_refund_rollback.sql` (exact D7 body, hash-verified).
  Reintroduces the bug; keep the refund freeze if rolled back.
- SQL and app are independent: the old app and the new app both work with either function body (see release proposal).

## Tests

- TS: helper unit tests (6) and action tests (4) under `competition/checkin/__tests__/deskBalance.cib.test.ts`.
- SQL: `sql-tests/test_T_competition_checkin_balance.sql` (25 checks), including scenarios driven through the real R2 recompute.
