# ARIA Expanded Runtime Coverage — Slice 5

Slice 5 turns seven additional planned operational areas into live ARIA candidate generation.

## New live signals

### Front Desk
`aria_appointment_confirmation_gap`

Creates review work when an appointment is inside 24 hours and still has a pending, requested, or unconfirmed status.

This slice does not automatically send the reminder.

### Client Relationships
`aria_no_show_service_recovery`

Creates a service-recovery review task for a no-show recorded during the prior two days.

ARIA does not assess fees, modify balances, or determine studio policy.

### Scheduling
`aria_schedule_conflict`

Looks ahead 14 days and detects overlapping appointments sharing an instructor or room.

ARIA creates an urgent internal task. It never moves or cancels the schedule automatically.

### Marketing
`aria_marketing_opportunity`

Surfaces campaign drafts that have remained unused for 14 days so staff can decide whether to finish, revise, or archive them.

Nothing is sent automatically.

### Staff and Payroll
`aria_payroll_missing_data`

Checks payroll-active instructors for missing worker classification or compensation setup.

Payroll configuration and payment changes remain staff-only.

### Retail and Inventory
`aria_inventory_low_stock`

Creates a reorder suggestion when active inventory is at or below its configured reorder threshold.

ARIA does not create purchase orders or spend studio funds.

### Studio Health
`aria_data_quality_exception`

Creates reconciliation work for failed imports, imports completed with warnings, or imports containing failed rows.

ARIA does not merge, delete, or rewrite ambiguous migrated records.

## Existing document coverage

Unsigned document detection remains implemented through the current document automation and `aria_unsigned_document` mapping. This slice does not create a second duplicate detector.

## Safety

All seven new runtime rules are review/internal rules.

No new external-delivery rule was added.

Therefore:

- ARIA action approval still cannot grant send permission.
- These new rules cannot enter the ARIA email execution allowlist.
- Scheduling, payroll, inventory purchasing, and data repair remain staff-controlled.
- Action dedupe continues to use rule + related table + related record.
- Existing audit and action lifecycle behavior remains in place.

## Migration

New migration:

`20260729000300_aria_expanded_operational_rule_keys_v1.sql`

Run after:

`20260729000200_aria_operational_pack_preferences_v1.sql`

and before deploying Slice 5 code.
