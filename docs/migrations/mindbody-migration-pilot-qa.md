# Mindbody Migration Pilot QA

Use this checklist before activating the first Mindbody-migrated studio.

## 1. Source exports and dry runs

- Export every source area that exists for the studio.
- Run clients, staff, packages, contracts, schedule, attendance, payments, and credits through Dry Run before live execution.
- Confirm duplicate source identities are resolved.
- Confirm no blocking row is ignored without an explicit decision.

## 2. Clients and relationships

- Compare client totals with Mindbody.
- Review shared emails and phones before merging.
- Confirm guardian, dependent, payer, household, and related-client links.
- Resolve all ambiguous relationship rows.
- Confirm no client is linked to itself.

## 3. Staff and permissions

- Compare teaching staff totals.
- Confirm Mindbody staff roles did not grant DanceFlow administrative access.
- Review Manager, Front Desk, Owner, and similar source labels manually.

## 4. Packages and client services

- Compare pricing-option and client-service counts.
- Compare Visits Total and Visits Remaining.
- Confirm unlimited services remain unlimited.
- Confirm expired services are inactive.
- Confirm historical attendance did not consume current balances again.

## 5. Contracts and memberships

- Compare contract-template and client-contract counts.
- Compare active, frozen, paused, past-due, and cancelled states.
- Compare current period start and end dates.
- Compare amount due, amount paid, and payment status.
- Confirm Auto Renew remains disabled after import.
- Confirm future billing setup is intentional and owner-approved.

## 6. Schedule and attendance

- Compare private appointments, classes, enrollments, and workshops.
- Review instructor, client, room, and time conflicts.
- Compare attended, no-show, late-cancel, and cancelled outcomes.
- Review waitlist exceptions separately.
- Confirm attendance import did not deduct package or membership balances again.

## 7. Payments, refunds, chargebacks, and credits

- Compare historical payment totals by date range and tender.
- Compare refunds and chargebacks.
- Review unmatched sale references.
- Compare account-credit ledger credits, debits, and net balance.
- Confirm no imported row created a new charge, refund, or recurring payment.

## 8. Activation gate

The studio is pilot-ready only when:

- All required stages are completed and reconciled.
- No failed rows remain.
- Relationship and waitlist exceptions are resolved or explicitly accepted.
- Package visits and membership periods match the source.
- Financial totals reconcile.
- Future recurring billing is configured intentionally.
- The studio owner signs off on sample clients, balances, schedule, and financial history.
- A rollback/export snapshot is retained before activation.
