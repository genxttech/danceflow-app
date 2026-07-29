# ARIA Runtime Coverage Completion — Slice 6

Slice 6 completes the day-to-day operational coverage matrix and makes pack preferences an explicit runtime gate.

## Runtime pack enforcement

ARIA now filters action candidates against `aria_automation_pack_preferences` before creating or updating action records.

This provides a second runtime boundary in addition to per-rule policies.

Turning an operational pack off means:

- New candidate actions from that pack are not persisted.
- Existing actions and audit history remain intact.
- Re-enabling the pack allows future qualifying signals to create work again.
- Delivery permission remains separately controlled by `automation_rules.mode`.

## Newly implemented coverage

### Front Desk
- Cancellation follow-up when a recent cancellation leaves no future booking.

### Documents
- Required pending documents after their due date.

### Billing and Payments
- Past paid-service appointments still showing unpaid, pending, or partial payment status.
- This is a reconciliation signal only. ARIA does not mark external payments paid.

### Client Relationships
- New leads with no recorded activity after one day.

### Sales and Retention
- Overdue lead follow-up activities.
- Recently active clients now marked inactive without a future booking.

### Scheduling
- Upcoming teaching appointments missing an instructor.
- Group classes at 80%+ capacity or using a waitlist.

Group-class capacity uses the existing event/group-class capacity and registration model.

### Events
- Public events inside 14 days with fewer than five active registrations.

### Staff and Payroll
- Overdue CRM follow-up activities are surfaced as staff work that needs ownership.

### Retail and Inventory
- Paid commerce orders still unfulfilled after one day.

### Studio Health
- Active clients with an email address but no linked `client_account_links` relationship.

Student app adoption uses `client_account_links`, not the retired compatibility `portal_user_id` field.

## Safety

All newly completed rules remain internal, suggestion-only, or draft-for-review.

No rule added in Slice 6 is allowed to send externally on its own.

ARIA does not automatically:

- rebook or cancel appointments;
- assign instructors;
- change class capacity or waitlists;
- mark payments paid;
- waive or revise documents;
- activate inactive clients;
- send marketing campaigns;
- fulfill or refund commerce orders;
- create or link dancer accounts.

## Matrix status

After Slice 6, every rule in `operational-automation-matrix.ts` is marked `implemented`.

The next work should focus on quality, defaults, thresholds, production behavior, and end-to-end QA rather than adding more rule categories.

## Migration

New migration:

`20260729000400_aria_runtime_coverage_completion_v1.sql`

Run after:

`20260729000300_aria_expanded_operational_rule_keys_v1.sql`

and before deploying Slice 6 application files.
