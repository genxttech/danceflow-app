# ARIA Default Operational Packs

## Goal

A new studio should not configure dozens of independent rules before ARIA can help.

ARIA should arrive ready to work with recommended defaults. The owner reviews a small number of meaningful preferences while the detailed rule behavior remains managed by the operational packs.

## Studio-facing choices

Each automation should use one of four plain-language choices:

- **Handle automatically**
- **Prepare for my review**
- **Notify me only**
- **Turn off**

These choices represent both the operational outcome and the delivery behavior in one cohesive workflow.

The underlying system must still keep decision approval and delivery permission separate. The interface should not force the owner to manage those controls on separate pages.

## Default packs

### Front Desk

Default: enabled.

ARIA prepares or sends routine booking, confirmation, and cancellation follow-up while escalating conflicts and sensitive situations.

Recommended owner preference:

> Send safe reminders automatically.

### Client Relationships

Default: enabled.

ARIA handles first-lesson follow-up, appropriate no-show recovery, lead acknowledgements, and relationship care.

Standard low-risk follow-up may run automatically. Complaints, disputes, and sensitive client history require review.

### Scheduling

Default: enabled.

ARIA detects conflicts, instructor coverage gaps, waitlist opportunities, and capacity issues.

Scheduling changes remain internal recommendations until staff approves the reassignment, cancellation, or roster change.

### Sales and Retention

Default: enabled.

ARIA supports:

- Rebooking active dancers
- Low package balances
- Package expiration
- Membership cancellation risk
- Lead follow-up
- Inactive-client reactivation

Safe and routine reminders may run automatically. Personalized campaigns and retention situations requiring judgment remain review-based.

### Marketing

Default: enabled.

ARIA identifies real opportunities and prepares campaign drafts.

Nothing is sent automatically by default. The recommended setting is:

> Prepare campaigns for review.

### Billing and Payments

Default: enabled.

ARIA may send routine approved reminders, but must not automatically:

- Charge
- Retry
- Refund
- Waive
- Alter entitlement state
- Change client access

Financial exceptions remain internal review items.

### Documents

Default: enabled.

ARIA sends routine signing reminders and surfaces expiration, supersession, or invalid-link issues for staff review.

### Events

Default: enabled.

ARIA monitors unpaid registrations, attendance quality, missing costs, and profitability exceptions.

Financial and operational event decisions remain internal.

### Staff and Payroll

Default: enabled.

ARIA finds missing payroll data, overdue staff tasks, and operational coverage gaps.

Payroll decisions remain restricted to authorized staff.

### Retail and Inventory

Default: enabled.

ARIA prepares low-stock and fulfillment recommendations. Purchase orders, refunds, and manual fulfillment remain staff-approved.

### Studio Health

Default: enabled.

ARIA finds data-quality problems, app-adoption gaps, migration exceptions, and operational inconsistencies.

Only deterministic and reversible repairs may be automatic.

## Setup philosophy

A new studio should see:

> ARIA is ready to help. Review three preferences.

The initial setup should ask only:

1. Whether safe front-desk reminders may send automatically.
2. Whether marketing should prepare drafts or suggestions only.
3. Whether routine payment reminders may send automatically or require review.

Everything else should use recommended defaults.

## Advanced controls

Advanced controls remain available inside each pack for:

- Timing
- Thresholds
- Communication channels
- Quiet hours
- Exceptions
- Risk-specific approval rules

These controls should not appear during normal setup unless the owner expands them.

## Safety rules

The packs do not weaken ARIA safety.

- Suggestion-only remains suggestion-only.
- Draft-for-review remains review-based.
- Auto-approval never changes delivery mode.
- External communication requires the rule to permit sending.
- High-risk financial, legal, schedule-changing, access, and merge actions require staff review.
- Every action must remain auditable.

## Slice 2 result

This slice converts the operational matrix into structured default packs.

It does not yet insert studio records, activate new runtime behavior, or redesign the Automation Center. Those are handled in later slices after the data model and current ARIA files are audited.
