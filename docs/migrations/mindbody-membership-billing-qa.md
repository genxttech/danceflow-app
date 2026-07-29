# Mindbody Contracts, Memberships, and Billing QA

## Dry run
- Import Mindbody clients before contracts.
- Retain Contract Template ID, Client Contract ID, and Billing Period ID.
- Review unsupported billing intervals and invalid dates.
- Review duplicate contract or period source identities.
- Confirm amount paid does not exceed amount due unless explicitly waived.

## Contract state
- Preserve active, paused, frozen, cancelled, expired, pending, past-due, and unpaid states.
- Confirm frozen contracts remain distinguishable from paused contracts.
- Preserve start date and current period boundaries.
- Confirm cancelled and expired records carry an end date.

## Billing state
- Preserve amount due, amount paid, and payment status independently from contract status.
- Distinguish paid, partial, due, past-due, waived, and void periods.
- Confirm current-period records update safely on rerun.

## AutoPay safety
- Never import stored cards, tokens, mandates, or usable AutoPay credentials.
- Imported memberships must keep Auto Renew disabled.
- Flag source AutoPay as Future Billing Setup Required.
- Future DanceFlow billing must be configured intentionally with studio approval.

## Benefits and entitlements
- Confirm included private lessons and group classes map to plan benefits.
- Historical attendance must not consume imported entitlement balances again.
- Confirm Create Only skips existing source-linked contracts.
- Confirm Create or Update updates the same plan, contract, and billing period.

## Reconciliation
- Compare contract-template counts.
- Compare active, frozen, past-due, and cancelled contract counts.
- Compare current-period amount due and amount paid totals.
- Resolve all blocked rows before schedule and payment migration.
