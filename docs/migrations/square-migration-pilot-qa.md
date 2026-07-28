# Square Migration Pilot QA

## Required migration order

1. `20260728000100_square_commerce_mapping_foundation_v1.sql`
2. `20260728000200_square_migration_pilot_reconciliation_v1.sql`

## Pilot sequence

1. Run a Square catalog dry run.
2. Run catalog create-or-update.
3. Repeat the same catalog file and confirm no duplicate source records.
4. Run one Square location inventory dry run.
5. Run inventory create-or-update.
6. Repeat inventory and confirm zero-delta rows are skipped.
7. Run historical commerce dry run.
8. Run historical commerce create-or-update.
9. Confirm all imported orders remain `accounting_sync_mode = deferred`.
10. Repeat historical commerce and confirm orders/payments are updated rather than duplicated.
11. Run digital entitlement dry run when applicable.
12. Confirm unlinked clients and unpublished content are blocked.
13. Run entitlement create-or-update.
14. Repeat the entitlement file and confirm active access is not duplicated.

## Reconciliation checks

- Catalog product count matches the accepted Square source set.
- Variant count matches accepted Square variations.
- SKU and barcode conflicts remain surfaced as exceptions.
- Inventory source units equal final DanceFlow units for the selected location.
- Historical order gross, tax, discounts, refunds, and totals match the source.
- Square payments are linked to the correct imported orders.
- No deferred Square order created active accounting entries.
- Digital entitlements resolve to the correct client, user, order, line item, and content.
- All required stages show reconciled in the Square pilot-readiness panel.

## Sign-off

Do not mark the migration project complete while failed rows, needs-review batches,
unresolved customer matches, unresolved catalog mappings, or accounting-sync exceptions remain.
