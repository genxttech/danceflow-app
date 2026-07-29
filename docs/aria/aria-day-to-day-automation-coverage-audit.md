# ARIA Day-to-Day Automation Coverage Audit

## Purpose

ARIA is intended to function as an out-of-the-box operational team member for a dance studio, not merely as a list of configurable rules.

This audit establishes one source of truth for routine work across front desk, client relationships, scheduling, sales, retention, marketing, billing, documents, events, staff, payroll, retail, inventory, and studio health.

## Current implemented foundation

The existing ARIA catalog and automation runtime already provide a working base for:

- Aging booking-request review
- Low package-balance outreach
- Package-expiration outreach
- Active-client rebooking
- Intro or first-lesson conversion follow-up
- Past-due membership outreach
- Canceling-membership outreach
- Payment-exception review
- Unpaid event-registration review
- Missing event-cost review
- Event-loss review
- Event attendance-quality review

The existing runtime also supports:

- Suggestion, draft, and auto-send delivery modes
- Automation actions and action lifecycle events
- Email templates and outbound delivery records
- Auto-approval policies
- Outcome verification
- Operational digest preparation

## Primary coverage gaps

### Front desk

ARIA still needs complete default handling for:

- Unconfirmed appointments
- Cancellation follow-up
- Routine rescheduling assistance
- Booking-request acknowledgements
- Front-desk service exceptions

### Client relationships

ARIA still needs:

- New-lead acknowledgements
- No-show service recovery
- Client complaint or dissatisfaction escalation
- Birthday and milestone recognition
- App and portal activation follow-up

### Scheduling

ARIA still needs:

- Instructor, client, room, and location conflict detection
- Instructor substitution recommendations
- Class capacity and waitlist movement
- Unassigned appointment review
- Under-enrolled class review

### Sales and retention

ARIA still needs:

- Multi-step lead follow-up
- Inactive-client reactivation
- Unused package or membership benefit outreach
- Trial-to-purchase conversion
- Retention-risk grouping beyond cancellation status

### Marketing

Marketing coverage is largely missing from the operational automation catalog. ARIA needs:

- Campaign opportunity suggestions
- Event promotion-gap detection
- Audience recommendations
- Enrollment-gap campaign briefs
- Seasonal campaign preparation
- Results follow-up and campaign learning

Marketing content should remain draft or suggestion based unless the underlying campaign explicitly permits auto-send.

### Billing and payments

ARIA still needs:

- Missing external-payment reconciliation
- Failed renewal follow-up
- Outstanding account-balance review
- Duplicate or conflicting payment detection
- Refund and chargeback workflow escalation

ARIA must never charge, retry, refund, waive, or change access automatically unless a future workflow is explicitly designed and authorized for that exact reversible action.

### Documents and events

ARIA still needs:

- Expiring-document review
- Superseded-document exceptions
- Event registration follow-up
- Event capacity and waitlist follow-through
- Post-event attendee follow-up

### Staff, payroll, retail, and studio health

These areas are mostly uncovered:

- Payroll missing-data review
- Instructor time-entry and rate exceptions
- Staff task reminders
- Low-stock suggestions
- Paid-order fulfillment exceptions
- Digital entitlement failures
- Student-app adoption
- Duplicate and incomplete data
- Post-migration reconciliation exceptions

## Safety model

The matrix preserves these non-negotiable rules:

1. Decision approval and delivery permission are separate.
2. Auto-approval does not change suggestion-only or draft-only delivery.
3. External communication requires the underlying automation rule to permit sending.
4. High-risk financial, legal, scheduling, access, and record-merging actions require staff review.
5. Safe automatic actions must be deterministic, auditable, and outcome-verifiable.
6. Studios should configure exceptions and preferences rather than build every workflow manually.

## Design implications

The Automation Center should not display this matrix as a dense rule table.

The studio-facing experience should present:

- One clear ARIA status
- Recommended operational packs already active
- Plain-language outcomes
- A small number of choices: Handle automatically, Prepare for review, Notify only, or Off
- One cohesive control for what ARIA decides and what ARIA may send
- Advanced timing, thresholds, channels, and exceptions behind progressive disclosure
- Exceptions and recent activity in contextual right-side panels

The technical matrix remains the implementation and QA source of truth. The owner sees only the decisions needed to operate the studio confidently.

## Slice 1 result

This slice creates the full operational matrix and identifies which workflows are implemented versus still planned. It does not yet enable new automation behavior.

Later slices will:

1. Convert the matrix into default operational packs.
2. Extend triggers and runtime actions.
3. Build the simplified Automation Center.
4. Complete production digest delivery, retry handling, and end-to-end QA.
