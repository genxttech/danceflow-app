# WellnessLiving Migration Pilot QA

Use this checklist before activating the first migrated studio.

## 1. Source exports and dry runs

- Export clients, staff, packages, memberships, appointments, attendance, payments, and account credits that exist for the source studio.
- Run each file through Dry Run before live execution.
- Confirm all blocking rows are corrected or explicitly excluded.
- Confirm no duplicate source identities remain.

## 2. Identity reconciliation

- Confirm client totals against the source export.
- Review normalized email and phone matches.
- Resolve household, parent, guardian, and related-client exceptions.
- Confirm instructors are present without automatically granting administrative roles.

## 3. Package reconciliation

- Compare package counts by pricing option.
- Compare each client package's Visits Remaining.
- Confirm unlimited benefits remain unlimited.
- Confirm historical attendance did not deduct package balances again.
- Confirm expired packages are inactive.

## 4. Membership reconciliation

- Compare membership-plan counts.
- Compare client membership status and current period boundaries.
- Compare amount due, amount paid, and payment status.
- Confirm paid, partial, and past-due periods remain distinct.
- Confirm imported memberships have Auto Renew disabled.
- Intentionally configure future DanceFlow billing only after studio approval.

## 5. Schedule and attendance

- Compare future appointment counts and date ranges.
- Review instructor, client, and room conflicts.
- Confirm imported attendance status matches the source.
- Confirm attendance import changed appointment state without consuming balances again.

## 6. Payments and credits

- Compare payment totals by date range and payment method.
- Review refunds, voids, and unmatched appointment references.
- Compare account-credit ledger credits, debits, and net balance.
- Confirm source transaction IDs prevent duplicate reruns.

## 7. Activation gate

The pilot is ready only when:

- All required stages show Reconciled.
- No failed rows remain.
- Relationship exceptions have been resolved or accepted.
- Package and membership balances match source totals.
- Future recurring billing has been intentionally configured.
- Studio owner signs off on sample clients, schedules, balances, and financial totals.
- A rollback/export snapshot is retained before activation.
