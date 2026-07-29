# Mindbody Payments, Refunds, Chargebacks, and Credits QA

## Payment history
- Import clients before payments.
- Retain Transaction ID, Sale ID, Refund ID, and Chargeback ID when available.
- Import payments as historical records only.
- Never recreate a charge, refund, or recurring transaction.
- Normalize unknown tender types to a safe historical payment method.
- Preserve paid, refunded, void, and chargeback states.

## Refunds and chargebacks
- Keep refund and chargeback rows distinct from original sales.
- Retain the source sale reference.
- Confirm negative financial rows do not become new outgoing payments.
- Review unmatched refund or chargeback references.
- Confirm reruns use source identity instead of amount and date matching.

## Account credits
- Import account credits after clients and payment history.
- Retain client account-entry or gift-card transaction IDs.
- Preserve credit and debit direction.
- Preserve entry type and description.
- Confirm ledger amounts are positive while direction controls the sign.
- Confirm Create Only skips existing source IDs.
- Confirm Create or Update updates the same source-linked ledger entry.

## Reconciliation
- Compare gross payments by date range and tender type.
- Compare refund totals and chargeback totals.
- Compare account-credit totals, debit totals, and net credit change.
- Resolve missing clients, duplicate source identities, and unmatched references.
- Confirm no imported row initiated a new Stripe or external payment action.
