# Mindbody Source Audit and Canonical Mapping

## Objective

Create a source-specific Mindbody migration path that preserves operational and financial meaning rather than treating every export as a generic spreadsheet.

Exact export names and column headers can vary by report and account configuration. The importer therefore uses canonical destination fields, recognized aliases, and manual mapping fallback instead of assuming one fixed export layout.

## Canonical stage order

1. Clients
2. Instructors
3. Packages and client services
4. Contracts and memberships
5. Appointments, classes, enrollments, and workshops
6. Attendance and visits
7. Sales, payments, refunds, and chargebacks
8. Account credits

## Source identity

Use durable Mindbody IDs whenever available for clients, staff, pricing options, client services, contracts, bookings, visits, sales, refunds, and ledger entries.

Email, phone, names, dates, and amounts are fallback evidence only. They must not silently merge records when source identity is available or when multiple candidates exist.

## Clients and relationships

Preserve explicit guardian, payer, household, and related-client relationships. Do not infer a relationship from shared contact information alone.

Duplicate email and phone matches require review when they could refer to multiple dancers or family members.

## Staff

Import teaching staff as instructors. Do not grant owner, administrator, payroll, or financial permissions based solely on a Mindbody staff record.

## Packages and services

Preserve:

- Pricing-option identity
- Client-service identity
- Total visits
- Visits remaining
- Unlimited state
- Purchase and expiration dates
- Service usage type

Current remaining visits are authoritative. Historical attendance must not consume them again.

## Contracts and memberships

Preserve:

- Contract-template identity
- Client-contract identity
- Status
- Current billing period
- Amount due
- Amount paid
- Payment status
- Frozen or paused state

Do not import stored cards, tokens, AutoPay mandates, or recurring billing credentials. Future DanceFlow billing must be set up intentionally with studio approval.

## Schedule

Keep private appointments, group classes, enrollments, and workshops distinguishable during mapping and reconciliation.

Future bookings should retain package or membership linkage when the source identifies an entitlement. Unresolved references become exceptions rather than being silently converted to free appointments.

## Attendance

Historical visits update appointment or roster attendance only. They must not rerun package or membership usage deduction.

## Financial history

Sales, tenders, refunds, voids, and chargebacks remain historical records. Import execution must never recreate a payment or charge.

Account credits use the client account ledger and reconcile credits minus debits against the source balance.

## Initial phase risks

- One export may contain multiple booking concepts.
- Family members may share contact information.
- Contract status and billing status may disagree.
- Pricing-option names may be reused over time.
- Refund rows may reference sales in a separate export.
- Visits may already be represented in current remaining balances.
- Stored payment methods cannot be migrated as usable payment credentials.
